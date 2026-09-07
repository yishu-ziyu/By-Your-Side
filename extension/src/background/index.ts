/**
 * background service worker 入口：
 * - 持有到伴随进程的上行连接（native messaging 优先，ws 调试回退，见 uplink.ts）
 * - tool_call 由本层直接执行并回 tool_result（不经过面板，关面板任务也不断）
 * - side panel 经 chrome.runtime Port 接入，只做渲染与用户输入转发
 * 任何异常都收敛为 {ok:false, error}，绝不允许不回。
 */
import type { AgentRunState, ClientMessage, ServerMessage, TeamMemberPhase, ToolName } from "../../../shared/protocol.js";
import { LEAD_SESSION_ID, PROTOCOL_VERSION, isLeadSession, normalizeSessionId } from "../../../shared/protocol.js";
import { LEAD_COLOR, displayColor, displayNameFor } from "../../../shared/cast.js";
import {
  ControlGate,
  TeamControl,
  aggregateRunState,
  acceptIncomingTeam,
  applyControlSnapshot,
  applyMemberGates,
  mergeActiveMembersForTakeover,
  onUplinkLostDuringControl,
  prepareMemberHandback,
  reconcileTeamProgress,
  shouldRestoreUserControlBanner,
  snapshotControl,
  teamOwnerBanner,
  type TeamMemberActivity,
  toTeamMemberHandback,
  uplinkLostWhileHeld,
} from "../../../shared/control.js";
import { PANEL_PORT_NAME, type BgToPanel, type ConnState, type PanelToBg, type TransportKind } from "../relay.js";
import type { PanelHistoryServerMessage } from "../relay.js";
import { PanelHistory } from "./panel-history.js";
import { Uplink, type UplinkHandlers } from "./uplink.js";
import { closeTab, getActiveTab, listTabs, openTab, switchTab } from "./exec/tabs.js";
import { navigate } from "./exec/navigate.js";
import { snapshot, snapshotTab } from "./exec/snapshot.js";
import { isReplayRequest } from "../shared/cursor-trail.js";
import { commitTrail } from "./exec/trail.js";
import { armDestructiveClick, click, hover, clearMarks, dropPendingClicks, fill, hideCursorsForSessions, hideUserControlBanners, mark, playLastTrail, pressKey, resolveHeldClick, scroll, showTeamControlBanners, stopTrailReplay, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";
import { consumeTeachUrlChange, getMode, noteMarkDrawn, noteMarksCleared, setMode } from "./mode.js";
import { isAffirmativeReply, isCancelReply, isMarkActionId, markActionUserText } from "../shared/mark-actions.js";
import { findSessionForTab, getWorkingTabMap as allWorkingTabs, getWorkingTabId as workingTabForKey, setSessionClaimBlocked as blockKey, executionKey, parseExecutionKey, findSessionsForTab, shareTab, guardToolAccess, setVisibleConversationId, setConversationTitle } from "./state.js";
import { pageOperation, takeoverTab, handbackTab } from "./exec/page-operation.js";
import { readElement } from "./exec/read-element.js";
import { PendingControlTimeout } from "./control-pending.js";
import { ASK_MENU_ID, ASK_STORE, EXPLAIN_PROMPT, clipSelection, type PendingAsk } from "../shared/ask-selection.js";

type Handler = (params: any, sessionId: string) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  share_tab: (p, sid) => shareTab(p, sid),
  page_operation: (p, sid) => pageOperation(p, sid),
  read_element: (p, sid) => readElement(p, sid),
  list_tabs: (_p, sid) => listTabs(sid),
  get_active_tab: (_p, sid) => getActiveTab(sid),
  open_tab: (p, sid) => openTab(p, sid),
  switch_tab: (p, sid) => switchTab(p, sid),
  close_tab: (p, sid) => closeTab(p, sid),
  navigate: (p, sid) => navigate(p, sid),
  snapshot: (p, sid) => snapshot(p, sid),
  click: (p, sid) => click(p, sid),
  hover: (p, sid) => hover(p, sid),
  fill: (p, sid) => fill(p, sid),
  type_text: (p, sid) => typeText(p, sid),
  press_key: (p, sid) => pressKey(p, sid),
  scroll: (p, sid) => scroll(p, sid),
  js: (p, sid) => evaluateJs(p, sid),
  screenshot: (_p, sid) => screenshot({}, sid),
  mark: (p, sid) => mark(p, sid),
  clear_marks: (_p, sid) => clearMarks(sid),
};

let selectedConversationId = "default";
const connectedPanels = new Set<chrome.runtime.Port>();
let conversationSummaries: import("../../../shared/protocol.js").ConversationSummary[] = [];
function broadcastConversations() { for (const port of connectedPanels) { try { port.postMessage({kind:"conversations",conversations:conversationSummaries,selectedConversationId}); } catch {} } }
const controllers = new Map<string, ReturnType<typeof createConversationController>>();
let connectionSnapshot: [ConnState, TransportKind | undefined, string?] = ["connecting", undefined];
let helloSnapshot: Extract<ServerMessage, {type:"hello_ok"}> | null = null;
const transport = new Uplink({
 onServerMessage(msg) {
   if (msg.type === "hello_ok") helloSnapshot = msg;
   if (msg.type === "conversation_list") { conversationSummaries = msg.conversations; for (const conversation of msg.conversations) { void setConversationTitle(conversation.id, conversation.title); controller(conversation.id).restoreMode(conversation.mode); } }
   if (msg.type === "conversation_updated" || msg.type === "conversation_created") { conversationSummaries = [...conversationSummaries.filter(c => c.id !== msg.conversation.id), msg.conversation]; void setConversationTitle(msg.conversation.id, msg.conversation.title); controller(msg.conversation.id).restoreMode(msg.conversation.mode); }
   if (msg.type === "conversation_created") { selectedConversationId = msg.conversation.id; setVisibleConversationId(selectedConversationId); void chrome.storage.session.set({ selectedConversationId }); controller(msg.conversation.id); }
   if (msg.type === "conversation_list") for (const c of msg.conversations) controller(c.id);
   if (msg.type.startsWith("conversation_")) broadcastConversations();
   if (msg.type === "hello_ok") {
     for (const c of controllers.values()) void c.ready.then(() => c.callbacks.onServerMessage(msg));
   } else {
     const c = controller(msg.type.startsWith("conversation_") ? selectedConversationId : msg.conversationId ?? "default");
     void c.ready.then(() => c.callbacks.onServerMessage(msg));
   }
 },
 onConnState(...args) { connectionSnapshot = args; if (args[0] === "connected") transport.sendClientMessage({type:"conversation_list"}); for (const c of controllers.values()) c.callbacks.onConnState(...args); },
});
function controller(id: string) {
 let c = controllers.get(id);
 if (!c) { c = createConversationController(id); controllers.set(id,c); c.callbacks.onConnState(...connectionSnapshot); if (helloSnapshot) { const instance = c; void c.ready.then(() => instance.callbacks.onServerMessage(helloSnapshot!)); } for (const port of connectedPanels) c.attachPanel(port); }
 return c;
}
chrome.runtime.onConnect.addListener(port => {
 if (port.name !== PANEL_PORT_NAME) return;
 connectedPanels.add(port);
 for (const c of controllers.values()) c.attachPanel(port);
 port.onDisconnect.addListener(() => connectedPanels.delete(port));
 port.onMessage.addListener((msg: PanelToBg) => {
  if (msg.kind === "select_conversation") { selectedConversationId = msg.conversationId; setVisibleConversationId(selectedConversationId); controller(selectedConversationId); void chrome.storage.session.set({selectedConversationId}); broadcastConversations(); }
  if (msg.kind === "sync") { broadcastConversations(); transport.sendClientMessage({type:"conversation_list"}); }
 });
});
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
 if (!raw || typeof raw !== "object" || (raw as {type?:unknown}).type !== "handback_click") return;
 void (async () => {
  const binding = sender.tab?.id == null ? undefined : await findSessionForTab(sender.tab.id);
  if (!binding) { sendResponse({ok:false,error:"TAB_OWNERSHIP_ERROR"}); return; }
  await controller(parseExecutionKey(binding).conversationId).handback();
  sendResponse({ok:true});
 })();
 return true;
});
void Promise.all([chrome.storage.session.get(null), chrome.storage.local.get(null)]).then(([stored, local]) => {
 selectedConversationId = typeof stored.selectedConversationId === "string" ? stored.selectedConversationId : "default";
 setVisibleConversationId(selectedConversationId);
 controller("default");
 for (const key of Object.keys({...stored,...local})) if (key.startsWith("history:")) controller(key.slice(8));
 controller(selectedConversationId);
 transport.start();
});
function createConversationController(conversationId: string) {
const key = (sid: string = LEAD_SESSION_ID) => executionKey(conversationId, sid);
const getWorkingTabId = (sid: string = LEAD_SESSION_ID) => workingTabForKey(key(sid));
const setSessionClaimBlocked = (sid: string, blocked: boolean) => blockKey(key(sid), blocked);
async function getWorkingTabMap() {
 const map = await allWorkingTabs();
 return Object.fromEntries(Object.entries(map).filter(([k]) => parseExecutionKey(k).conversationId === conversationId).map(([k,v]) => [parseExecutionKey(k).sessionId,v]));
}

// ── 面板端口管理 ───────────────────────────────────────────────────

const panels = new Set<chrome.runtime.Port>();
const panelHistory = new PanelHistory();
const historyKey = `history:${conversationId}`;
const historyReady = chrome.storage.local.get(historyKey).then(async got => {
 panelHistory.restore(got[historyKey] ?? (await chrome.storage.session.get(historyKey))[historyKey]);
}).catch(() => {});
let historyFlushTimer: ReturnType<typeof setTimeout> | undefined;
function flushHistory() {
 if (historyFlushTimer) clearTimeout(historyFlushTimer);
 historyFlushTimer = undefined;
 void chrome.storage.local.set({[historyKey]:panelHistory.since()});
}
/** 选中即问：把 text_delta 回推到划词所在页。 */
let overlayAskTabId: number | undefined;

/** 缓存的连接上下文，用于面板重开后的状态同步。 */
let lastConn: { state: ConnState; transport?: TransportKind; detail?: string } = { state: "connecting" };
let lastHelloOk: { version: number; model?: string } | null = null;
let lastStatus: AgentRunState = "idle";
const statusBySession = new Map<string, AgentRunState>();
const activityBySession = new Map<string, TeamMemberActivity>();
const gate = new ControlGate();
const team = new TeamControl();
const CONTROL_STORE = `controlGate:${conversationId}`;
const CONTROL_TIMEOUT_MS = 10_000;
let controlRequestSeq = 0;
let handbackCaptureSeq = 0;
let handbackCapture: { token: number; generation: number; tabId: number } | null = null;
type PendingControl =
  | {
      action: "takeover";
      requestId: string;
      generation: number;
      groupId?: string;
      pageTabId?: number;
      fallbackStatus: AgentRunState;
      timeout: PendingControlTimeout;
    }
  | {
      action: "handback";
      requestId: string;
      tabId: number;
      timeout: PendingControlTimeout;
    };
let pendingControl: PendingControl | null = null;

function cancelTakeover(pending: Extract<PendingControl, {action:"takeover"}>) {
 if (pending.pageTabId != null) {
  for (const member of team.view()?.members ?? []) { gate.releaseSession(member.sessionId); setSessionClaimBlocked(member.sessionId, false); }
  handbackTab(pending.pageTabId);
 } else gate.cancelTakeover(pending.generation);
}

function nextControlRequestId(action: "takeover" | "handback"): string {
  controlRequestSeq += 1;
  return `${action}-${Date.now()}-${controlRequestSeq}`;
}

function cancelHandbackCapture(): void {
  handbackCaptureSeq += 1;
  handbackCapture = null;
}

function persistControl(): void {
  const snap = snapshotControl(gate, lastStatus, team.view());
  void chrome.storage.session.set({ [CONTROL_STORE]: snap }).catch(() => {
    /* 存储失败不放开闸门 */
  });
}

function teamBannerView() {
  const view = team.view();
  if (!view) return { status: "现在归你", action: "交还", actionEnabled: true };
  const owner = teamOwnerBanner(view);
  return {
    ...owner,
    members: view.members.map((m) => ({
      id: m.sessionId,
      initial: m.role === "lead" ? "L" : displayNameFor(m.sessionId).slice(0, 1).toUpperCase(),
      color: m.role === "lead" ? LEAD_COLOR : displayColor(m.sessionId),
    })),
  };
}

function emitTeam(): void {
  const view = team.view();
  if (!view || view.members.length === 0) return;
  broadcastVisibleServer({ type: "team_status", team: view });
}

function memberActivityForTakeover(phase: TeamMemberPhase, activity?: TeamMemberActivity): TeamMemberActivity {
  if (activity) return activity;
  if (phase === "waiting_message") return "waiting_message";
  if (phase === "waiting_tool") return "waiting_tool";
  return "running";
}

async function localActiveMembers() {
  const statuses = [...statusBySession.entries()] as [string, AgentRunState][];
  if (!statusBySession.has(LEAD_SESSION_ID) && lastStatus !== "idle") {
    statuses.push([LEAD_SESSION_ID, lastStatus]);
  }
  const inflightSessionIds = gate.inflightSessionIds();
  const workingTabs = await getWorkingTabMap();
  const activeIds = new Set([
    ...statuses.filter(([, state]) => state === "running" || state === "user").map(([id]) => id),
    ...inflightSessionIds,
  ]);
  const tabIds = [...activeIds]
    .map((sessionId) => workingTabs[sessionId])
    .filter((tabId): tabId is number => typeof tabId === "number");
  const tabs = (
    await Promise.all(
      [...new Set(tabIds)].map(async (tabId) => {
        try {
          const tab = await chrome.tabs.get(tabId);
          return { id: tabId, title: tab.title ?? "", url: tab.url ?? "" };
        } catch {
          return null;
        }
      }),
    )
  ).filter((tab): tab is { id: number; title: string; url: string } => tab !== null);
  return mergeActiveMembersForTakeover({
    statuses,
    activities: activityBySession,
    inflightSessionIds,
    workingTabs,
    tabs,
  });
}

async function memberTabIds(): Promise<number[]> {
  const map = await getWorkingTabMap();
  const sessions = team.view()?.members.map((m) => m.sessionId) ?? [LEAD_SESSION_ID];
  const ids: number[] = [];
  for (const sid of sessions) {
    const id = map[sid];
    if (typeof id === "number") ids.push(id);
  }
  return ids;
}

async function hydrateControl(): Promise<void> {
  try {
    const got = await chrome.storage.session.get(CONTROL_STORE);
    const applied = applyControlSnapshot(gate, got[CONTROL_STORE], team);
    lastStatus = applied.lastStatus;
    if (applied.restoredUser || teamHeld()) {
      lastStatus = "user";
      statusBySession.set(LEAD_SESSION_ID, "user");
      for (const m of team.view()?.members ?? []) {
        if (m.phase !== "restored" && m.tabId != null) void takeoverTab(m.tabId);
        statusBySession.set(m.sessionId, m.phase === "restored" ? "running" : "user");
      }
      void showUserControlGuarded();
    } else {
      // 扩展 reload 会遗留旧 isolated world 画出的 overlay host。
      // 当前控制权不归用户时，启动即在活动页注入新版脚本并清掉旧条。
      try {
        const { tab } = await getActiveTab();
        if (conversationId === "default") await hideUserControlBanners(tab?.id);
      } catch {
        /* 没有可注入的活动页时保持默认 agent */
      }
    }
  } catch {
    /* 无 session storage 时保持默认 agent */
  }
}

const controlReady = hydrateControl();

function handleConnState(state: ConnState, transport: TransportKind | undefined, detail?: string): void {
  lastConn = { state, transport, detail };
  if (state !== "connected" && teamHeld() && !gate.isUser() && !pendingControl) {
    persistControl();
    broadcast({kind:"conn",state,transport,detail});
    return;
  }
  if (state !== "connected") {
    cancelHandbackCapture();
    const pendingAction = pendingControl?.action ?? null;
    const lostPending = onUplinkLostDuringControl({
      owner: gate.control,
      draining: gate.isDraining,
      pendingAction,
    });
    if (pendingControl?.action === "takeover" && !lostPending.cancelTakeover) {
      pendingControl.timeout.pause();
    }
    if (pendingControl && lostPending.cancelTakeover) {
      const pending = clearPendingControl(pendingControl.requestId);
      if (pending?.action === "takeover") {
        cancelTakeover(pending);
        team.clear();
      }
      emitNotice(
        pending?.action === "handback"
          ? "连接中断，交还没有完成，页面仍归你。"
          : "连接中断，接管没有完成。",
        "error",
      );
    } else if (pendingControl?.action === "handback") {
      emitNotice("连接中断，交还没有完成，页面仍归你。", "error");
    }
    lastHelloOk = null;
    lastModelInfo = null;
    const lost = lostPending.abortGate
      ? uplinkLostWhileHeld(gate.control)
      : { abortGate: false, hideBanner: false, lastStatus: lostPending.lastStatus };
    if (lost.abortGate) {
      statusBySession.clear();
      activityBySession.clear();
      lastStatus = lost.lastStatus;
      gate.abort();
      persistControl();
      void memberTabIds().then(ids => Promise.all(ids.map(id => hideUserControlBanners(id))));
    } else {
      lastStatus = lost.lastStatus;
      if (gate.isUser() || gate.isDraining) statusBySession.set(LEAD_SESSION_ID, lastStatus);
      persistControl();
    }
  } else if (teamHeld() || gate.isUser() || gate.isDraining || pendingControl?.action === "takeover") {
    const view = team.view();
    const requestId = pendingControl?.action === "takeover" ? pendingControl.requestId : nextControlRequestId("takeover");
    if (pendingControl?.action === "takeover") pendingControl.timeout.arm();
    uplink.sendClientMessage({
      type: "takeover",
      requestId,
      ...(view
        ? {
            groupId: view.groupId,
            generation: view.generation,
            members: view.members.map((m) => ({
              sessionId: m.sessionId,
              role: m.role,
              activity: memberActivityForTakeover(m.phase, m.activity),
              tabId: m.tabId,
              title: m.title,
              url: m.url,
            })),
          }
        : {}),
    });
    emitLocalStatus(gate.isUser() ? "user" : lastStatus);
    void showUserControlGuarded();
  }
  broadcast({ kind: "conn", state, transport, detail });
}
/** 最近一次模型信息（hello_ok 或 set_model 后的 model_info），面板重开后回放。 */
let lastModelInfo: Extract<ServerMessage, { type: "model_info" }> | null = null;

function broadcast(msg: BgToPanel): void {
  msg = { ...msg, conversationId } as BgToPanel;
  if (msg.kind === "server") msg = { ...msg, msg: { ...msg.msg, conversationId } };
  for (const panel of panels) {
    try {
      panel.postMessage(msg);
    } catch {
      /* 面板刚好断开 */
    }
  }
}

function recordAndBroadcastHistory(item: Parameters<PanelHistory["record"]>[0]): void {
  const entry = panelHistory.record(item);
  if (item.kind === "user" || (item.kind === "server" && item.msg.type === "status" && item.msg.state === "idle")) flushHistory();
  else if (!historyFlushTimer) historyFlushTimer = setTimeout(flushHistory, 100);
  broadcast({ kind: "history", entries: [entry] });
}

function broadcastVisibleServer(msg: PanelHistoryServerMessage): void {
  msg = { ...msg, conversationId };
  recordAndBroadcastHistory({ kind: "server", msg });
}

function emitNotice(message: string, kind: "notice" | "error" = "notice"): void {
  broadcastVisibleServer({ type: "agent_event", event: { kind, message } });
}

function teamHeld(): boolean {
  const phase = team.view()?.phase;
  return (
    gate.isUser() ||
    phase === "draining" ||
    phase === "user" ||
    phase === "restoring" ||
    phase === "partial"
  );
}

async function showUserControlGuarded(tabId?: number): Promise<void> {
  if (!teamHeld()) return;
  const generation = gate.gen;
  const ids = await memberTabIds();
  if (tabId != null) ids.push(tabId);
  await showTeamControlBanners(ids, teamBannerView());
  if (!teamHeld() || gate.gen !== generation) {
    await hideUserControlBanners(tabId);
  }
}

function clearPendingControl(requestId: string): PendingControl | null {
  if (!pendingControl || pendingControl.requestId !== requestId) return null;
  const pending = pendingControl;
  pendingControl = null;
  pending.timeout.clear();
  return pending;
}

function failPendingControl(requestId: string, reason: string): void {
  const pending = clearPendingControl(requestId);
  if (!pending) return;
  if (pending.action === "takeover") {
    cancelTakeover(pending);
    team.clear();
    emitLocalStatus(pending.fallbackStatus);
  } else {
    emitLocalStatus("user");
    void showUserControlGuarded(pending.tabId);
  }
  emitNotice(reason, "error");
}

function handleControlResult(msg: Extract<ServerMessage, { type: "control_result" }>): void {
  if (!pendingControl || pendingControl.requestId !== msg.requestId || pendingControl.action !== msg.action) return;
  const pending = clearPendingControl(msg.requestId);
  if (!pending) return;
  if (!msg.ok) {
    if (pending.action === "takeover") {
      cancelTakeover(pending);
      team.clear();
      emitLocalStatus(msg.state === "running" ? "running" : "idle");
    } else {
      emitLocalStatus("user");
      void showUserControlGuarded(pending.tabId);
    }
    emitNotice(msg.reason ?? `${msg.action === "takeover" ? "接管" : "交还"}没有被 Agent 接受。`, "error");
    return;
  }
  if (pending.action === "takeover") {
    if (msg.team) {
      const acc = acceptIncomingTeam({
        incoming: msg.team,
        local: team.view(),
        pendingRequestId: pending.requestId,
        resultRequestId: msg.requestId,
      });
      if (!acc.accept) {
        emitNotice("接管确认已过期，已忽略。", "error");
        return;
      }
    }
    const memberIds = (msg.team?.members ?? team.view()?.members ?? []).map((m) => m.sessionId);
    if (msg.state !== "user" || (pending.pageTabId == null && !gate.commitTakeover(pending.generation, memberIds))) {
      cancelTakeover(pending);
      team.clear();
      emitLocalStatus(pending.fallbackStatus);
      emitNotice("接管确认与本地状态不一致，已停止切换控制权。", "error");
      return;
    }
    if (msg.team) team.hydrate(msg.team);
    else {
      for (const m of team.view()?.members ?? []) team.markDrained(m.sessionId);
      team.commitUser(team.view()?.generation ?? pending.generation);
    }
    for (const m of team.view()?.members ?? []) statusBySession.set(m.sessionId, "user");
    emitLocalStatus("user");
    emitTeam();
    void showUserControlGuarded();
    return;
  }
  if (msg.team) {
    const acc = acceptIncomingTeam({
      incoming: msg.team,
      local: team.view(),
      pendingRequestId: pending.requestId,
      resultRequestId: msg.requestId,
    });
    if (!acc.accept) {
      emitNotice("交还确认已过期，已忽略。", "error");
      emitLocalStatus("user");
      void showUserControlGuarded(pending.tabId);
      return;
    }
    team.hydrate(msg.team);
  }
  const view = team.view();
  const anyRestored = view?.members.some((m) => m.phase === "restored") ?? msg.state === "running";
  const allRestored = view?.phase === "restored";
  if (!msg.ok && !anyRestored) {
    emitLocalStatus("user");
    void showUserControlGuarded(pending.tabId);
    emitNotice(msg.reason ?? "交还没有被 Agent 接受。", "error");
    emitTeam();
    return;
  }
  if (anyRestored && view) {
    const applied = applyMemberGates(gate, view);
    for (const m of view.members) {
      statusBySession.set(m.sessionId, m.phase === "restored" ? "running" : "user");
      if (m.phase === "restored" && m.tabId != null) { handbackTab(m.tabId); setSessionClaimBlocked(m.sessionId, false); }
    }
    if (applied.globalHandback || allRestored) {
      void hideUserControlBanners(pending.tabId);
      emitLocalStatus("running");
    } else {
      emitLocalStatus("user");
      void showUserControlGuarded();
    }
    emitTeam();
    return;
  }
  emitLocalStatus("user");
  void showUserControlGuarded(pending.tabId);
  emitTeam();
}

/** 把当前模式同步给单个面板（接入与 sync 时调用）。 */
function postMode(port: chrome.runtime.Port): void {
  void getMode(conversationId).then((mode) => {
    try {
      port.postMessage({ kind: "mode", mode } satisfies BgToPanel);
    } catch {
      /* 面板刚好断开 */
    }
  });
}

// ── 上行连接 ───────────────────────────────────────────────────────

const callbacks: UplinkHandlers = {
  onServerMessage(msg) {
    if (msg.type === "hello_ok") {
      lastHelloOk = { version: msg.version, model: conversationId === "default" ? msg.model : lastModelInfo?.model };
      if (msg.models && conversationId === "default" && !lastModelInfo) lastModelInfo = { type: "model_info", model: msg.model, models: msg.models };
      // 会话模式由 runtime 的 conversation summary 恢复；握手不回写本地默认值。
    } else if (msg.type === "model_info") {
      lastModelInfo = msg;
    } else if (msg.type === "team_status") {
      const acc = acceptIncomingTeam({
        incoming: msg.team,
        local: team.view(),
        pendingRequestId: pendingControl?.requestId ?? null,
        resultRequestId: null,
      });
      if (!acc.accept) return;
      team.hydrate(msg.team);
      if (acc.restoreUser && (gate.isDraining || pendingControl?.action === "takeover") && !gate.isUser()) {
        const ids = msg.team.members.map((m) => m.sessionId);
        const gen = pendingControl?.action === "takeover" ? pendingControl.generation : gate.gen;
        if (gate.commitTakeover(gen, ids) || gate.isUser()) {
          if (pendingControl?.action === "takeover") clearPendingControl(pendingControl.requestId);
          for (const m of msg.team.members) statusBySession.set(m.sessionId, "user");
          emitLocalStatus("user");
          void showUserControlGuarded();
        }
      }
      if (msg.team.phase === "restoring" || msg.team.phase === "partial" || msg.team.phase === "restored") {
        const progress = reconcileTeamProgress(gate, msg.team);
        for (const [sessionId, memberState] of progress.statuses) statusBySession.set(sessionId, memberState);
        for (const member of msg.team.members) if (member.phase === "restored" && member.tabId != null) { handbackTab(member.tabId); setSessionClaimBlocked(member.sessionId, false); }
        lastStatus = aggregateRunState(statusBySession.values());
        persistControl();
        if (progress.hideBanners) void memberTabIds().then(ids => Promise.all(ids.map(id => hideUserControlBanners(id))));
        else void showUserControlGuarded();
        emitTeam();
      }
    } else if (msg.type === "control_result") {
      handleControlResult(msg);
      return;
    } else if (msg.type === "status") {
      if (pendingControl && (msg.sessionId == null || msg.sessionId === LEAD_SESSION_ID)) {
        return;
      }
      if (gate.isSessionBlocked(msg.sessionId ?? LEAD_SESSION_ID) && msg.state !== "user") {
        const member = team.member(msg.sessionId ?? LEAD_SESSION_ID);
        if (member && member.phase !== "restored") return;
        if (!member) return;
      }
      const sid = msg.sessionId ?? LEAD_SESSION_ID;
      statusBySession.set(sid, msg.state);
      if (msg.state === "running") activityBySession.set(sid, "running");
      else if (msg.state === "idle") activityBySession.delete(sid);
      lastStatus = aggregateRunState(statusBySession.values());
      persistControl();
      if (msg.state === "idle") commitTrail(key(sid));
    } else if (msg.type === "agent_event") {
      const sid = msg.sessionId ?? LEAD_SESSION_ID;
      if (msg.event.kind === "tool_start") {
        activityBySession.set(sid, msg.event.name === "await_message" ? "waiting_message" : "waiting_tool");
      } else if (msg.event.kind === "tool_end") {
        activityBySession.set(sid, "running");
      }
      if (overlayAskTabId != null) {
        const kind = msg.event.kind;
        if (
          kind === "text_delta" ||
          kind === "turn_end" ||
          kind === "agent_end" ||
          kind === "error" ||
          kind === "notice" ||
          kind === "tool_start"
        ) {
          void chrome.tabs.sendMessage(overlayAskTabId, { type: "ask-event", event: msg.event }).catch(() => {
            /* 页已关 */
          });
        }
      }
    }
    if (msg.type === "tool_call") {
      void executeToolCall(msg.id, msg.name, msg.params, msg.sessionId, msg.programId);
      return; // tool_call 不转发面板
    }
    if (msg.type === "status" || msg.type === "agent_event" || msg.type === "team_status") {
      broadcastVisibleServer(msg);
    } else {
      broadcast({ kind: "server", msg });
    }
  },
  onConnState(state, transport, detail) {
    void controlReady.then(() => handleConnState(state, transport, detail));
  },
};
const uplink = {
 sendClientMessage: (msg: ClientMessage) => transport.sendClientMessage({ ...msg, conversationId }),
 retry: () => transport.retry(),
};

async function executeToolCall(
  id: string,
  name: ToolName,
  params: Record<string, unknown>,
  sessionId?: string,
  programId?: string,
): Promise<void> {
  await controlReady;
  let result: Extract<ClientMessage, { type: "tool_result" }>;
  const sid = normalizeSessionId(sessionId);
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${String(name)}`);
    if (programId && gate.isSessionBlocked(sid)) throw new Error("页面现在归你，操作未执行");
    setSessionClaimBlocked(sid, gate.isSessionBlocked(sid));
    const operationGeneration = gate.gen;
    await guardToolAccess(name, key(sid), typeof params.tabId === "number" ? params.tabId : undefined);
    const data = await gate.run(id, name, () => name === "page_operation"
      ? pageOperation(params as any, key(sid), {canWrite: () => gate.gen === operationGeneration && !gate.isSessionBlocked(sid)})
      : handler(params, key(sid)), sid);
    // 教学标注追踪：mark 成功 = 有待完成步骤；clear_marks = 步骤标注已清
    if (name === "mark") noteMarkDrawn(conversationId);
    else if (name === "clear_marks") noteMarksCleared(conversationId);
    result = { type: "tool_result", id, ok: true, data };
  } catch (e) {
    result = { type: "tool_result", id, ok: false, error: oneLine(e) };
  }
  uplink.sendClientMessage(result);
}

function emitLocalStatus(state: AgentRunState): void {
  statusBySession.set(LEAD_SESSION_ID, state);
  lastStatus = aggregateRunState(statusBySession.values());
  persistControl();
  broadcastVisibleServer({ type: "status", state });
}

async function handleTakeover(requestedTabId?: number): Promise<void> {
  await controlReady;
  if (pendingControl) {
    emitNotice(`正在${pendingControl.action === "takeover" ? "接管" : "交还"}，请稍候。`);
    return;
  }
  if (gate.isUser()) {
    void showUserControlGuarded();
    emitLocalStatus("user");
    emitTeam();
    return;
  }
  const targetTabId = requestedTabId ?? await getWorkingTabId() ?? undefined;
  const allMembers = await localActiveMembers();
  let members = allMembers;
  if (targetTabId != null) {
    const collaborators = (await findSessionsForTab(targetTabId)).filter(k => parseExecutionKey(k).conversationId === conversationId).map(k => parseExecutionKey(k).sessionId);
    if (!collaborators.length) { emitNotice("TAB_OWNERSHIP_ERROR: 该页面不属于当前会话", "error"); return; }
    for (const sid of collaborators) { gate.blockSession(sid); setSessionClaimBlocked(sid, true); }
    const drained = takeoverTab(targetTabId);
    members = allMembers.filter(m => collaborators.includes(m.sessionId));
    for (const sid of collaborators) if (!members.some(m => m.sessionId === sid)) members.push({sessionId:sid,role:isLeadSession(sid)?"lead":"worker",activity:"running",tabId:targetTabId});
    await drained;
  }
  if (members.length === 0) {
    emitNotice("当前没有运行中的任务，不用接管。");
    return;
  }
  const fallbackStatus = lastStatus;
  for (const sid of new Set([LEAD_SESSION_ID, ...statusBySession.keys()])) dropPendingClicks(key(sid));
  void stopTrailReplay(key());
  team.snapshotAndFreeze(members);
  team.beginDrain();
  emitTeam();
  void showUserControlGuarded();
  const result = targetTabId != null ? {generation:gate.gen, superseded:false} : await gate.beginTakeover();
  if (result.superseded) {
    team.clear();
    return;
  }
  await hideCursorsForSessions(members.map((m) => key(m.sessionId)));
  const requestId = nextControlRequestId("takeover");
  const frozen = team.view();
  pendingControl = {
    action: "takeover",
    requestId,
    generation: result.generation,
    pageTabId: targetTabId,
    groupId: frozen?.groupId,
    fallbackStatus,
    timeout: new PendingControlTimeout(CONTROL_TIMEOUT_MS, () =>
      failPendingControl(requestId, "Agent 没有确认接管，控制权没有切换。"),
    ),
  };
  pendingControl.timeout.arm();
  if (
    !uplink.sendClientMessage({
      type: "takeover",
      requestId,
      ...(frozen
        ? {
            groupId: frozen.groupId,
            generation: frozen.generation,
            members: frozen.members.map((m) => ({
              sessionId: m.sessionId,
              role: m.role,
              activity: memberActivityForTakeover(m.phase, m.activity),
              tabId: m.tabId,
              title: m.title,
              url: m.url,
            })),
          }
        : {}),
    })
  ) {
    failPendingControl(requestId, "当前没有连接到 Agent，接管没有生效。");
  }
}

async function handleHandback(): Promise<void> {
  await controlReady;
  if (handbackCapture) {
    emitNotice("正在读取绑定页，请稍候。");
    return;
  }
  if (pendingControl) {
    emitNotice(`正在${pendingControl.action === "takeover" ? "接管" : "交还"}，请稍候。`);
    return;
  }
  if (!teamHeld() && !gate.isUser()) {
    emitNotice("现在不是你在操作页面，不用交还。");
    return;
  }
  const frozen = team.view()?.members ?? [{ sessionId: LEAD_SESSION_ID, role: "lead" as const, phase: "user" as const }];
  let activeId: number | undefined;
  try {
    const { tab } = await getActiveTab();
    activeId = tab?.id;
  } catch {
    activeId = undefined;
  }
  const token = ++handbackCaptureSeq;
  const generation = gate.gen;
  handbackCapture = { token, generation, tabId: activeId ?? 0 };
  const pages = [];
  for (const member of frozen) {
    if (handbackCapture?.token !== token) return;
    const boundId = await getWorkingTabId(member.sessionId);
    let bound: { id: number; title: string; url: string } | null = null;
    if (boundId != null) {
      try {
        const tab = await chrome.tabs.get(boundId);
        if (tab.id != null) bound = { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
      } catch {
        bound = null;
      }
    } else if (isLeadSession(member.sessionId) && frozen.length === 1 && activeId != null) {
      try {
        const tab = await chrome.tabs.get(activeId);
        if (tab.id != null) bound = { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
      } catch {
        bound = null;
      }
    }
    let snapshot: string | undefined;
    let snapshotError: string | undefined;
    if (bound) {
      try {
        snapshot = (await snapshotTab(bound.id)).text;
      } catch (e) {
        snapshotError = oneLine(e);
        emitNotice(`读不了 ${displayNameFor(member.sessionId)} 的页面：${snapshotError}。该成员仍归你。`, "error");
      }
    }
    pages.push(
      prepareMemberHandback({
        sessionId: member.sessionId,
        boundTab: bound,
        snapshot,
        snapshotError,
        capturedAt: Date.now(),
        activeTabId: activeId,
      }),
    );
  }
  if (handbackCapture?.token !== token || handbackCapture.generation !== generation || !teamHeld()) {
    return;
  }
  handbackCapture = null;
  const leadPage = pages.find((p) => isLeadSession(p.sessionId) && p.ok);
  const members = pages.map(toTeamMemberHandback);
  const requestId = nextControlRequestId("handback");
  pendingControl = {
    action: "handback",
    requestId,
    tabId: leadPage && leadPage.ok ? leadPage.context.tabId : activeId ?? 0,
    timeout: new PendingControlTimeout(CONTROL_TIMEOUT_MS, () =>
      failPendingControl(requestId, "Agent 没有确认交还，页面仍归你。"),
    ),
  };
  pendingControl.timeout.arm();
  const teamViewNow = team.view();
  const payload = {
    type: "handback" as const,
    requestId,
    members,
    ...(teamViewNow ? { groupId: teamViewNow.groupId, generation: teamViewNow.generation } : {}),
    ...(leadPage && leadPage.ok ? { context: leadPage.context, snapshot: leadPage.snapshot } : {}),
  };
  if (!uplink.sendClientMessage(payload)) {
    failPendingControl(requestId, "当前没有连接到原会话，页面仍归你。");
  }
}

function handleAbort(): void {
  cancelHandbackCapture();
  if (pendingControl) {
    const pending = clearPendingControl(pendingControl.requestId);
    if (pending?.action === "takeover") cancelTakeover(pending);
  }
  const aborted = gate.abort();
  const sessions = [...new Set([LEAD_SESSION_ID, ...statusBySession.keys(), ...(team.view()?.members.map(member => member.sessionId) ?? [])])];
  const abortedTabs = getWorkingTabMap().then(map => [...new Set(Object.values(map))]);
  team.abort();
  statusBySession.clear();
  activityBySession.clear();
  emitLocalStatus("idle");
  emitTeam();
  for (const sid of sessions) { dropPendingClicks(key(sid)); setSessionClaimBlocked(sid, false); }
  void hideCursorsForSessions(sessions.map(key));
  void memberTabIds().then(ids => Promise.all(ids.map(id => hideUserControlBanners(id))));
  void stopTrailReplay(key());
  uplink.sendClientMessage({ type: "abort" });
  void aborted.settled.then(async () => {
    if (gate.gen !== aborted.generation) return;
    for (const tabId of await abortedTabs) handbackTab(tabId);
    await hideCursorsForSessions(sessions.map(key));
    await Promise.all((await memberTabIds()).map(id => hideUserControlBanners(id)));
    await stopTrailReplay(key());
  });
}

/**
 * user_message / steer 转发前附上发送那一刻用户正在看的标签页（"这页面"类指代的锚点）。
 * 查询失败或无活动标签时原样发送，不阻塞主流程。
 */
async function attachPageContext<T extends Extract<ClientMessage, { type: "user_message" | "steer" }>>(
  msg: T,
): Promise<T> {
  try {
    const { tab } = msg.context ? {tab:{id:msg.context.tabId,title:msg.context.title,url:msg.context.url}} : await getActiveTab();
    const selectedBinding = tab?.id == null ? undefined : await findSessionForTab(tab.id);
    if (selectedBinding && parseExecutionKey(selectedBinding).conversationId !== conversationId) return {...msg, context: undefined};
    const selection = msg.context?.selection;
    const page = tab
      ? { tabId: tab.id, title: tab.title ?? "", url: tab.url ?? "" }
      : msg.context
        ? { tabId: msg.context.tabId, title: msg.context.title, url: msg.context.url }
        : null;
    if (!page) return msg;
    return {
      ...msg,
      context: selection ? { ...page, selection } : page,
    };
  } catch {
    return msg;
  }
}

function ensureAskMenu(): void {
  if (!chrome.contextMenus?.removeAll) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: ASK_MENU_ID,
      title: "问 By Your Side",
      contexts: ["selection"],
    });
  });
}

async function deliverAsk(ask: PendingAsk): Promise<void> {
  await chrome.storage.session.set({ [ASK_STORE]: ask });
  broadcast({ kind: "ask_selection", ask } satisfies BgToPanel);
}

if (conversationId === "default" && chrome.runtime?.onInstalled) chrome.runtime.onInstalled.addListener(() => ensureAskMenu());
if (conversationId === "default") ensureAskMenu();

chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (selectedConversationId !== conversationId) return;
  if (info.menuItemId !== ASK_MENU_ID || !tab?.id) return;
  const tabId = tab.id;
  const text = clipSelection(String(info.selectionText ?? ""));
  if (!text) return;
  const ask: PendingAsk = {
    text,
    tabId,
    title: tab.title ?? "",
    url: tab.url ?? "",
  };
  void chrome.tabs.sendMessage(tabId, { type: "ask-open", text }).catch(() => {
    void chrome.sidePanel.open({ tabId }).catch(() => {
      /* 面板可能已经开着 */
    });
    void deliverAsk(ask);
  });
});

if (chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener((command) => {
    if (conversationId !== "default" || command !== "ask-selection") return;
    void chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      const tab = tabs[0];
      if (!tab?.id) return;
      void chrome.tabs.sendMessage(tab.id, { type: "ask-hotkey" }).catch(() => {
        /* 无可注入页 */
      });
    });
  });
}

// 步骤完成自动感知：teach 模式 + 有待完成标注时，working tab 的 URL 变化
// （chrome.tabs.onUpdated 的 changeInfo.url，SPA pushState 也会触发）视为
// 用户可能已完成当前步骤 → 清标注 + 通知 agent。agent 未连接时 sendClientMessage 静默丢弃。
// 必须在 SW 顶层注册，SW 重启后依然生效。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  void (async () => {
    await controlReady;
    if (!(await memberTabIds()).includes(tabId)) return;
    if (shouldRestoreUserControlBanner({ owner: gate.control, changeInfo })) {
      await showUserControlGuarded(tabId);
    }
  })();
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  void (async () => {
    const bindings = (await findSessionsForTab(tabId)).filter(k => parseExecutionKey(k).conversationId === conversationId);
    if (!bindings.length) return;
    const mode = await getMode(conversationId);
    if (!consumeTeachUrlChange(mode, conversationId)) return;
    for (const binding of bindings) {
      const sid = parseExecutionKey(binding).sessionId;
      try { await clearMarks(binding); } catch { /* 页面可能已卸载 */ }
      uplink.sendClientMessage({type:"page_event",event:"url_changed",url,sessionId:sid});
    }
  })();
});

function attachPanel(port: chrome.runtime.Port) {
  if (panels.has(port)) return;
  panels.add(port);
  if (conversationId === selectedConversationId) void Promise.all([controlReady, historyReady]).then(() => syncPanel(port));

  port.onMessage.addListener((raw: unknown) => {
    const selectedAtReceipt = selectedConversationId;
    void Promise.all([controlReady, historyReady]).then(() => handlePanelMessage(raw, selectedAtReceipt));
  });
  function handlePanelMessage(raw: unknown, selectedAtReceipt: string) {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") return;
    const requested = msg.kind === "client" ? msg.msg.conversationId : "conversationId" in msg ? msg.conversationId : undefined;
    if ((requested ?? selectedAtReceipt) !== conversationId) return;
    switch (msg.kind) {
      case "client":
        // set_mode 先落本地模式状态（供标注追踪判定），再照常转发给 agent
        if (msg.msg.type === "set_mode") {
          const mode = msg.msg.mode;
          void setMode(mode, conversationId).then(() => broadcast({ kind: "mode", mode }));
        }
        // user_message / steer 先附页面上下文再上行（异步，失败时原样发送）
        if (msg.msg.type === "abort") {
          handleAbort();
          break;
        }
        if (msg.msg.type === "user_message" || msg.msg.type === "steer") {

          recordAndBroadcastHistory({
            kind: "user",
            text: msg.msg.text,
            attachments: msg.msg.attachments,
          });
          if (lastStatus === "idle" && isReplayRequest(msg.msg.text)) {
            void (async () => {
              const result = await playLastTrail(key());
              const message =
                result.steps > 0
                  ? "正在回放刚才的操作。这不会撤销已经发生的事。"
                  : result.reason === "tab-gone"
                    ? "刚才操作过的标签页已经关掉了，没法回放。"
                    : "刚才没有可以回放的操作。";
              broadcast({
                kind: "server",
                msg: { type: "agent_event", event: { kind: "notice", message } },
              });
            })();
            break;
          }
          void stopTrailReplay(key());
          if (isAffirmativeReply(msg.msg.text)) armDestructiveClick(key());
          else if (isCancelReply(msg.msg.text)) {
            // 侧栏打「取消」与点名牌「取消」同效：清 pending、松开拿住的手、收起标注
            void resolveHeldClick("cancel", key()).catch(() => {
              /* 清理失败不挡住把「取消」送进对话 */
            });
          }
          void attachPageContext(msg.msg).then((enriched) => uplink.sendClientMessage(enriched));
          break;
        }
        uplink.sendClientMessage(msg.msg);
        break;
      case "control":
        if (msg.action === "takeover") void handleTakeover(msg.tabId);
        else void handleHandback();
        break;
      case "sync": {
        void historyReady.then(() => syncPanel(port, msg.afterSeq));
        break;
      }
      case "retry":
        uplink.retry();
        break;
    }
  }

  port.onDisconnect.addListener(() => { panels.delete(port); });
}

function syncPanel(rawPort: chrome.runtime.Port, afterSeq?: number) {
 const port = { postMessage: (message: BgToPanel) => rawPort.postMessage({ ...message, conversationId, ...(message.kind === "server" ? {msg: {...message.msg, conversationId}} : {}) }) };
        port.postMessage({ kind: "conn", ...lastConn } satisfies BgToPanel);
        void chrome.storage.session.get(ASK_STORE).then((stored) => {
          const ask = stored[ASK_STORE] as PendingAsk | undefined;
          if (ask && typeof ask.text === "string") {
            port.postMessage({ kind: "ask_selection", ask } satisfies BgToPanel);
          }
        });
        postMode(port as chrome.runtime.Port);
        if (lastHelloOk) {
          port.postMessage({
            kind: "server",
            msg: { type: "hello_ok", version: lastHelloOk.version, model: lastHelloOk.model },
          } satisfies BgToPanel);
          if (lastModelInfo) {
            port.postMessage({ kind: "server", msg: lastModelInfo } satisfies BgToPanel);
          }
        }
        const entries = panelHistory.since(afterSeq ?? 0);
        if (entries.length > 0) port.postMessage({ kind: "history", entries } satisfies BgToPanel);
        port.postMessage({ kind: "server", msg: { type: "status", state: lastStatus } } satisfies BgToPanel);
        if (team.view()) {
          port.postMessage({ kind: "server", msg: { type: "team_status", team: team.view()! } } satisfies BgToPanel);
        }
}

/** 光标名牌上的确认/取消键：点删除/取消 → 与侧栏打「确认」「取消」同一条 user_message。 */
chrome.tabs.onActivated.addListener((info) => {
  void controlReady.then(async () => {
    if (!(await memberTabIds()).includes(info.tabId)) return;
    if (!gate.isUser()) return;
    void showUserControlGuarded(info.tabId);
  });
});

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  if (!raw || typeof raw !== "object") return;
  if (selectedConversationId !== conversationId) return;
  const msg = raw as { type?: unknown; action?: unknown; text?: unknown };
  if (msg.type === "ask-selection") {
    const tab = sender.tab;
    const text = typeof msg.text === "string" ? clipSelection(msg.text) : null;
    const mode = (msg as { mode?: unknown }).mode;
    if (tab?.id && text) {
      const tabId = tab.id;
      const ask: PendingAsk = {
        text,
        tabId,
        title: tab.title ?? "",
        url: tab.url ?? "",
      };
      if (mode === "continue") {
        void chrome.sidePanel.open({ tabId }).catch(() => {
          /* 面板可能已经开着 */
        });
        void deliverAsk(ask);
      } else {
        overlayAskTabId = tabId;
        const question =
          mode === "explain"
            ? EXPLAIN_PROMPT
            : typeof (msg as { question?: unknown }).question === "string" && (msg as { question: string }).question.trim()
              ? (msg as { question: string }).question.trim()
              : "这段是什么意思？";
        const outgoing = {
          type: lastStatus === "idle" ? ("user_message" as const) : ("steer" as const),
          text: question,
          context: {
            tabId,
            title: tab.title ?? "",
            url: tab.url ?? "",
            selection: { text },
          },
        };

        recordAndBroadcastHistory({ kind: "user", text: question });
        void attachPageContext(outgoing).then((enriched) => {
          if (!uplink.sendClientMessage(enriched)) {
            void chrome.tabs
              .sendMessage(tabId, {
                type: "ask-event",
                event: { kind: "error", message: "没连上 Agent。打开侧栏看连接状态。" },
              })
              .catch(() => {
                /* 页已关 */
              });
          }
        });
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "sidepanel_capture_tab") {
    void (async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = tabs[0] ?? (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        if (!tab?.id || tab.windowId == null) {
          sendResponse({ ok: false, error: "未找到当前激活的标签页" });
          return;
        }
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
        sendResponse({
          ok: true,
          dataUrl,
          title: tab.title ?? "网页截屏",
          url: tab.url ?? "",
        });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }
  if (msg.type === "handback_click") return;
  if (msg.type !== "mark_action" || !isMarkActionId(msg.action)) return;
  const action = msg.action;
  void (async () => {
    try {
      await resolveHeldClick(action, key());
    } catch {
      /* 放行失败不挡住把「确认/取消」送进对话 */
    }
    const text = markActionUserText(action);
    const outgoing = await attachPageContext({ type: "user_message", text });
    uplink.sendClientMessage(outgoing);
    sendResponse({ ok: true });
  })();
  return true;
});

return { callbacks, attachPanel, handback: handleHandback, restoreMode: (mode: import("../../../shared/protocol.js").AgentMode) => {
  void setMode(mode, conversationId).then(() => broadcast({kind:"mode",mode}));
}, ready: Promise.all([controlReady, historyReady]) };


}
