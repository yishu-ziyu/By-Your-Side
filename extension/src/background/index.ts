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
  WRITE_TOOL_SET,
} from "../../../shared/control.js";
import { PANEL_PORT_NAME, type BgToPanel, type ConnState, type PanelToBg, type TransportKind } from "../relay.js";
import type { PanelHistoryServerMessage } from "../relay.js";
import { HISTORY_PERSIST_BUDGET_BYTES, PanelHistory, historyKeysToDrop, historyUpdatedAt, type StoredPanelHistory } from "./panel-history.js";
import { Uplink, type UplinkHandlers } from "./uplink.js";
import { VoiceRelay } from "./voice-relay.js";
import { closeTab, getActiveTab, listTabs, openTab, switchTab } from "./exec/tabs.js";
import { navigate } from "./exec/navigate.js";
import { snapshot, snapshotTab } from "./exec/snapshot.js";
import { isReplayRequest } from "../shared/cursor-trail.js";
import { commitTrail } from "./exec/trail.js";
import { armDestructiveClick, click, hover, clearMarks, dropPendingClicks, fill, hideCursorsForSessions, hideUserControlBanners, mark, playLastTrail, pressKey, resolveHeldClick, scroll, showTeamControlBanners, stopTrailReplay, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { fetchUrl } from "./exec/fetch-url.js";
import { network } from "./exec/network.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";
import { consumeTeachUrlChange, getMode, noteMarkDrawn, noteMarksCleared, setMode } from "./mode.js";
import { isAffirmativeReply, isCancelReply, isMarkActionId, markActionUserText } from "../shared/mark-actions.js";
import { isHeldClickResult } from "../shared/held-clicks.js";
import { findSessionForTab, getWorkingTabMap as allWorkingTabs, getWorkingTabId as workingTabForKey, setSessionClaimBlocked as blockKey, executionKey, parseExecutionKey, findSessionsForTab, shareTab, guardToolAccess, setVisibleConversationId, setConversationTitle } from "./state.js";
import { pageOperation, pageOperationExecutionFact, takeoverTab, handbackTab } from "./exec/page-operation.js";
import { readElement } from "./exec/read-element.js";
import { PendingControlTimeout } from "./control-pending.js";
import { ASK_MENU_ID, ASK_STORE, EXPLAIN_PROMPT, clipSelection, type PendingAsk } from "../shared/ask-selection.js";

import { workerTabControl } from "./worker-tab-control.js";
import { conversationForRecordingTab, demoSession, dismissDemo, isRecording, receiveSteps, resumeDemoIfRecording, startDemo, stopDemo, type DemoSession } from "./demo.js";
import { dismissCandidate, injectObserver, isObserving, listCandidates, patternCount, recordRun, setObserving, stopObserver, consumeCandidate } from "./observe.js";
import {
  clearCursorStatus,
  clearAmbientCursorStatus,
  resumeCursorStatus,
  showCursorStatus,
  suppressCursorStatus,
  workingTabBehindPill,
  type CursorStatusState,
} from "./cursor-status.js";

type Handler = (params: any, sessionId: string) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  fetch: (p) => fetchUrl(p),
  network: (p, sid) => network(p, sid),
  worker_tabs: (p, sid) => workerTabControl.manage(p, sid, dropPendingClicks, async keys => {
    for (const key of keys) { const who = parseExecutionKey(key); const owner = controller(who.conversationId); await owner.ready; if (owner.isUserHeld(who.sessionId)) throw new Error("页面现在归你，操作未执行"); }
  }),
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
  observe_page: async()=>{throw new Error('观察只允许通过语音授权。');},
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
const HISTORY_PREFIX = "history:";
const MAX_STORED_HISTORY_KEYS = 8;
const HISTORY_PRUNE_DELAY_MS = 5_000;
const transport = new Uplink({
 onServerMessage(msg) {
   if (msg.type === "voice") { voiceRelay.server(msg); return; }
   if (msg.type === "hello_ok") helloSnapshot = msg;
   if (msg.type === "conversation_list") { conversationSummaries = msg.conversations; for (const conversation of msg.conversations) { void setConversationTitle(conversation.id, conversation.title); controller(conversation.id).restoreMode(conversation.mode); } }
   if (msg.type === "conversation_updated" || msg.type === "conversation_created") { conversationSummaries = [...conversationSummaries.filter(c => c.id !== msg.conversation.id), msg.conversation]; void setConversationTitle(msg.conversation.id, msg.conversation.title); controller(msg.conversation.id).restoreMode(msg.conversation.mode); }
   if (msg.type === "conversation_created") { voiceRelay.selectionChanged(msg.conversation.id); selectedConversationId = msg.conversation.id; setVisibleConversationId(selectedConversationId); void chrome.storage.session.set({ selectedConversationId }); controller(msg.conversation.id); }
   if (msg.type === "conversation_list") for (const c of msg.conversations) controller(c.id);
   if (msg.type.startsWith("conversation_")) broadcastConversations();
   if (msg.type === "hello_ok") {
     for (const c of controllers.values()) void c.ready.then(() => c.callbacks.onServerMessage(msg));
   } else {
     const c = controller(msg.type.startsWith("conversation_") ? selectedConversationId : msg.conversationId ?? "default");
     void c.ready.then(() => c.callbacks.onServerMessage(msg));
   }
 },
 onConnState(...args) { connectionSnapshot = args; if (args[0] !== "connected") voiceRelay.disconnected(); if (args[0] === "connected") transport.sendClientMessage({type:"conversation_list"}); for (const c of controllers.values()) c.callbacks.onConnState(...args); },
});
const voiceRelay = new VoiceRelay(msg => transport.sendClientMessage(msg), () => selectedConversationId,async(id,input)=>{
  const enriched=await controller(id).voiceInput(input);return enriched;
});
function controller(id: string) {
 let c = controllers.get(id);
 if (!c) { c = createConversationController(id); controllers.set(id,c); c.callbacks.onConnState(...connectionSnapshot); if (helloSnapshot) { const instance = c; void c.ready.then(() => instance.callbacks.onServerMessage(helloSnapshot!)); } for (const port of connectedPanels) c.attachPanel(port); }
 return c;
}
chrome.runtime.onConnect.addListener(port => {
 if (port.name !== PANEL_PORT_NAME) return;
 voiceRelay.attach(port);
 connectedPanels.add(port);
 for (const c of controllers.values()) c.attachPanel(port);
 port.onDisconnect.addListener(() => connectedPanels.delete(port));
 port.onMessage.addListener((msg: PanelToBg) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.kind === "select_conversation") { voiceRelay.selectionChanged(msg.conversationId); selectedConversationId = msg.conversationId; setVisibleConversationId(selectedConversationId); controller(selectedConversationId); void chrome.storage.session.set({selectedConversationId}); broadcastConversations(); }
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
/**
 * 点头上跨页胶囊：切到它正在干活的那个标签页。
 * 目标标签页跟着胶囊一起下发（msg.tabId），所以 service worker 重启过、内存状态表空了也照样能跳；
 * 兜底才回落到内存状态表。跳不过去时如实回报，让页面把胶囊收掉而不是点着没反应。
 */
chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
 if (!raw || typeof raw !== "object" || (raw as {type?:unknown}).type !== "cross_page_click") return;
 const asked = (raw as { tabId?: unknown }).tabId;
 const target = (typeof asked === "number" && Number.isInteger(asked) ? asked : null) ?? workingTabBehindPill(sender.tab?.id);
 if (target == null || target === sender.tab?.id) { sendResponse({ok:false,error:"NO_WORKING_TAB"}); return; }
 void (async () => {
   try {
     const tab = await chrome.tabs.get(target);
     if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
     await chrome.tabs.update(target, { active: true });
     sendResponse({ ok: true });
   } catch {
     sendResponse({ ok: false, error: "TAB_GONE" });
   }
 })();
 return true;
});
let historyPruneTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 服务端给每个会话都推 status，一次 idle 就会落盘一个会话键——只在启动时清理不够。
 * 多次落盘合并成一次清理，避免每写一次就读一遍全量存储。
 */
function scheduleHistoryPrune(): void {
 if (historyPruneTimer) return;
 historyPruneTimer = setTimeout(() => {
  historyPruneTimer = undefined;
  void pruneStoredHistory(MAX_STORED_HISTORY_KEYS).catch(error => { console.error("[sideagent] 历史清理失败", error); });
 }, HISTORY_PRUNE_DELAY_MS);
}

/** 只保留最近若干个会话的 history 键；旧格式（裸数组）没有 updatedAt，按最旧处理。 */
async function pruneStoredHistory(keep: number): Promise<void> {
 const all = await chrome.storage.local.get(null);
 const records = Object.keys(all)
  .filter(key => key.startsWith(HISTORY_PREFIX))
  .map(key => ({ key, updatedAt: historyUpdatedAt(all[key]) }));
 const drop = historyKeysToDrop(records, keep);
 if (drop.length) await chrome.storage.local.remove(drop);
}

// transport.start() 曾写在 .then 里且无 catch：恢复链一旦 reject，扩展就永远不连、也不再重试。
void (async () => {
 try {
  const [stored, local] = await Promise.all([chrome.storage.session.get(null), chrome.storage.local.get(null)]);
  selectedConversationId = typeof stored.selectedConversationId === "string" ? stored.selectedConversationId : "default";
  setVisibleConversationId(selectedConversationId);
  controller("default");
  for (const key of Object.keys({...stored,...local})) if (key.startsWith(HISTORY_PREFIX)) controller(key.slice(HISTORY_PREFIX.length));
  controller(selectedConversationId);
  await pruneStoredHistory(MAX_STORED_HISTORY_KEYS);
 } catch (error) {
  console.error("[sideagent] 启动恢复失败，仍继续连接", error);
 }
 transport.start();
})();
function createConversationController(conversationId: string) {
const key = (sid: string = LEAD_SESSION_ID) => executionKey(conversationId, sid);
const getWorkingTabId = (sid: string = LEAD_SESSION_ID) => workingTabForKey(key(sid));
const setSessionClaimBlocked = (sid: string, blocked: boolean) => blockKey(key(sid), blocked);

/** 状态挂到哪一页：显式 tabId → 已认领的工作页 → 用户当前看的页。 */
async function statusTabId(sid: string, explicit?: unknown): Promise<number | null> {
  if (typeof explicit === "number") return explicit;
  const claimed = await getWorkingTabId(sid);
  if (claimed != null) return claimed;
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return active?.id ?? null;
  } catch {
    return null;
  }
}

/** 读页面的工具：光标显示「正在读这个页面」。 */
const READ_TOOLS = new Set(["snapshot", "read_element", "screenshot", "observe_page", "network"]);

async function setCursorStatus(sid: string, state: CursorStatusState, explicitTabId?: unknown): Promise<void> {
  await showCursorStatus({
    key: key(sid),
    state,
    tabId: await statusTabId(sid, explicitTabId),
  });
}

/**
 * 一轮任务的事件 → 光标状态。
 * 等待：任务开始到下一次动手之间；读页面：读类工具执行期间；完成：正常收尾后自动消失；
 * 失败：一轮以错误结束时留在原地。动作类工具（点击/填写/定位/标注）自己有名牌，这里先让位。
 */
async function applyCursorStatusEvent(
  sid: string,
  event: Extract<ServerMessage, { type: "agent_event" }>["event"],
): Promise<void> {
  switch (event.kind) {
    case "agent_start":
      resumeCursorStatus(key(sid));
      await setCursorStatus(sid, "waiting");
      return;
    case "tool_start": {
      const name = event.name;
      if (READ_TOOLS.has(name)) {
        await setCursorStatus(sid, "reading", event.params?.tabId);
        return;
      }
      if (name === "click" || name === "fill" || name === "hover" || name === "mark") {
        await clearCursorStatus(key(sid));
      }
      return;
    }
    case "tool_end":
      await setCursorStatus(sid, "waiting");
      return;
    case "agent_end":
      await setCursorStatus(sid, "done");
      return;
    case "error":
      await setCursorStatus(sid, "failed");
      return;
    default:
      return;
  }
}
async function getWorkingTabMap() {
 const map = await allWorkingTabs();
 return Object.fromEntries(Object.entries(map).filter(([k]) => parseExecutionKey(k).conversationId === conversationId).map(([k,v]) => [parseExecutionKey(k).sessionId,v]));
}

// ── 面板端口管理 ───────────────────────────────────────────────────

const panels = new Set<chrome.runtime.Port>();
const panelHistory = new PanelHistory();
const historyKey = `${HISTORY_PREFIX}${conversationId}`;
const historyReady = chrome.storage.local.get(historyKey).then(async got => {
 panelHistory.restore(got[historyKey] ?? (await chrome.storage.session.get(historyKey))[historyKey]);
}).catch(() => {});
let historyFlushTimer: ReturnType<typeof setTimeout> | undefined;
/** 只有 status 的历史不值得落盘：服务端给每个会话都推状态，一次 idle 就会写一个键、随后又被清理。 */
function hasPersistableHistory(): boolean {
 return panelHistory.since().some(entry => !(entry.item.kind === "server" && entry.item.msg.type === "status"));
}
function flushHistory() {
 if (historyFlushTimer) clearTimeout(historyFlushTimer);
 historyFlushTimer = undefined;
 if (!hasPersistableHistory()) return;
 const stored: StoredPanelHistory = { updatedAt: Date.now(), entries: panelHistory.persistWindow(HISTORY_PERSIST_BUDGET_BYTES) };
 void chrome.storage.local.set({[historyKey]:stored}).catch(error => { console.error("[sideagent] 面板历史落盘失败", error); });
 scheduleHistoryPrune();
}
/** 选中即问：把 text_delta 回推到划词所在页。 */
let overlayAskTabId: number | undefined;

/** 缓存的连接上下文，用于面板重开后的状态同步。 */
let lastConn: { state: ConnState; transport?: TransportKind; detail?: string } = { state: "connecting" };
let lastHelloOk: { version: number; model?: string } | null = null;
let lastStatus: AgentRunState = "idle";
const statusBySession = new Map<string, AgentRunState>();
const executionEpochs=new Map<string,number>();
let epochRunId:string|null|undefined;
const abortedRuns=new Set<string>();
let abortDrain:Promise<void>=Promise.resolve();
let remoteControl:{request:Extract<ServerMessage,{type:'task_control'}>;timer:ReturnType<typeof setTimeout>;abortAck?:(ok:boolean)=>void}|null=null;
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
  if(state!=='connected'&&remoteControl)finishRemoteControl(false,'连接中断，页面控制结果尚无法确认。',true);
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

function recordAndBroadcastHistory(item: Parameters<PanelHistory["record"]>[0]): ReturnType<PanelHistory["record"]> {
  const entry = panelHistory.record(item);
  if (item.kind === "user" || (item.kind === "server" && item.msg.type === "status" && item.msg.state === "idle")) flushHistory();
  else if (!historyFlushTimer) historyFlushTimer = setTimeout(flushHistory, 100);
  broadcast({ kind: "history", entries: [entry] });
  return entry;
}

function broadcastVisibleServer(msg: PanelHistoryServerMessage): void {
  msg = { ...msg, conversationId };
  recordAndBroadcastHistory({ kind: "server", msg });
}

function emitNotice(message: string, kind: "notice" | "error" = "notice"): void {
  broadcastVisibleServer({ type: "agent_event", event: { kind, message } });
}

// ── 示范录制：用户亲手做一遍，系统只看不做 ──────────────────────────

function demoStatus() {
  const s = demoSession(conversationId);
  if (!s) return { recording: false as const, steps: [] as DemoSession["steps"], truncated: false };
  return { recording: !s.stopped, tabId: s.tabId, steps: s.steps, truncated: s.truncated };
}

function emitDemo(): void {
  broadcast({ kind: "demo", ...demoStatus() } satisfies BgToPanel);
}

/** 示范进行中，写类工具一律拒绝：这段时间页面归用户。 */
function demoRefusal(name: ToolName): string | undefined {
  if (!isRecording(conversationId)) return undefined;
  if (!WRITE_TOOL_SET.has(name)) return undefined;
  return "示范录制中：现在由你操作页面，Agent 未执行这次操作。";
}

/**
 * 观察开关与候选处置。默认关：打开才注入，关掉立刻停并清掉未成的片断。
 * 「以后替我跑」的兑现路径在这里：把候选的骨架交给编译（走 skill_compile 同一条路），
 * 生成技能后把候选消费掉，同一件事不再问第二遍。
 */
async function handleObserveControl(action: "on" | "off" | "list" | "dismiss" | "accept", signature?: string, hostname?: string): Promise<void> {
  if (action === "on") { await setObserving(true); emitObserve(); return; }
  if (action === "off") {
    for (const tabId of (await chrome.tabs.query({ active: true }))) if (tabId.id != null) await stopObserver(tabId.id);
    await setObserving(false);
    emitObserve();
    return;
  }
  if (action === "dismiss" && signature && hostname) { await dismissCandidate(signature, hostname); emitObserve(); return; }
  emitObserve();
}

async function emitObserve(): Promise<void> {
  const observing = await isObserving();
  const list = await listCandidates();
  // patterns 是"手上攒了多少段骨架"：刚开始观察时用户看不到候选（门槛是三次跨两天），
  // 但这个数字能让他确认真的在记，而不是以为坏了。
  broadcast({ kind: "observe", observing, candidates: list, patterns: await patternCount() } satisfies BgToPanel);
}

async function handleDemoControl(action: "start" | "stop" | "dismiss"): Promise<void> {
  if (action === "dismiss") { dismissDemo(conversationId); emitDemo(); return; }
  if (action === "start") {
    if (isRecording(conversationId)) { emitDemo(); return; }
    // 示范的是"用户此刻在看的这一页"：有任务绑定就用绑定页，没有就用当前活动页。
    const tabId = (await getWorkingTabId()) ?? (await getActiveTab()).tab?.id ?? undefined;
    if (tabId == null) { emitNotice("没有可示范的页面：先打开你要操作的网页。", "error"); return; }
    const page = await chrome.tabs.get(tabId).catch(() => null);
    if (!page || !/^https?:/i.test(page.url ?? "")) { emitNotice("这一页不能示范：请切到普通的 http/https 网页再点「看我做」。", "error"); return; }
    const title = page.title ?? "";
    const started = await startDemo(conversationId, tabId);
    if (!started.ok) { emitNotice(`示范没能开始：${started.error ?? "页面不可注入"}`, "error"); return; }
    emitNotice(`示范开始：现在你亲手做一遍，做完点「做完了」。正在记录这一页${title ? `（${title}）` : ""}。`);
    emitDemo();
    return;
  }
  const session = await stopDemo(conversationId);
  if (!session) { emitDemo(); return; }
  if (!session.steps.length) emitNotice("示范结束：这一步都没记到。若你操作的是另一个标签页或另一个窗口，换个页面再试。");
  else emitNotice(`示范结束：记下 ${session.steps.length} 步。${session.truncated ? "（中途已达上限，后面的动作没记）" : ""}`);
  emitDemo();
}

/** 观察：页面侧上行的一次 run（只有骨架）。不记输入值，敏感站点与敏感字段在页面侧已经丢掉。 */
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  if (!raw || typeof raw !== "object" || (raw as { type?: unknown }).type !== "sideagent:observed-run") return;
  const run = (raw as { run?: unknown }).run;
  if (!run || typeof run !== "object") return;
  const { hostname, anchors, at } = run as { hostname?: unknown; anchors?: unknown; at?: unknown };
  if (typeof hostname !== "string" || !Array.isArray(anchors) || typeof at !== "number") return;
  void recordRun({ hostname, anchors: anchors as never, at });
});

/** 示范录制：页面侧上行的一批步骤，只认属于本会话的那一页。 */
chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
  if (!raw || typeof raw !== "object" || (raw as { type?: unknown }).type !== "sideagent:demo-step") return;
  const tabId = sender.tab?.id;
  if (tabId == null) return;
  // 示范页未必有任务绑定，按"谁在录这个标签页"归属，不查 tab→session 绑定。
  if (conversationForRecordingTab(tabId) !== conversationId) return;
  const msg = raw as { steps?: unknown; truncated?: unknown };
  if (!Array.isArray(msg.steps)) return;
  receiveSteps(conversationId, msg.steps as Parameters<typeof receiveSteps>[1], msg.truncated === true);
  emitDemo();
});

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
    const knownRun=conversationSummaries.find(c=>c.id===conversationId)?.runId;
    if(knownRun!==epochRunId){executionEpochs.clear();epochRunId=knownRun;}
    if(!msg.runId||msg.runId===knownRun)for(const [id,epoch] of Object.entries(msg.epochs??{}))executionEpochs.set(id,Math.max(epoch,executionEpochs.get(id)??0));
    if(msg.type==='task_control'){void runRemoteControl(msg);return;}
    if(msg.type==='task_control_ack'){if(remoteControl?.request.requestId===msg.requestId)remoteControl.abortAck?.(msg.ok);return;}
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
      if(remoteControl?.request.action==='resume'){
        const current=team.view();
        if(current?.phase==='restored')finishRemoteControl(true);
        else if(current?.phase==='partial'&&!current.members.some(m=>m.phase==='restoring'))finishRemoteControl(false,'部分成员未能恢复，请查看仍然暂停的页面。',false,current.members.some(m=>m.phase==='restored'));
      }
    } else if (msg.type === "control_result") {
      handleControlResult(msg);
      if(remoteControl?.request.requestId===msg.requestId){
        const view=team.view();
        if(remoteControl.request.action==='resume'&&msg.ok&&view?.members.some(m=>m.phase==='restoring'))return;
        const pauseApplied=remoteControl.request.scope==='page'?view?.phase==='user'&&view.members.every(m=>gate.isSessionBlocked(m.sessionId)):gate.isUser()&&view?.phase==='user';
        const ok=msg.ok&&(remoteControl.request.action==='pause'?pauseApplied:view?.phase==='restored'&&!gate.isUser());
        finishRemoteControl(ok,msg.reason??(ok?undefined:'页面控制尚未完整生效。'),false,!ok&&!!view?.members.some(m=>m.phase==='restored'));
      }
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
      if (msg.state === "running") {
        resumeCursorStatus(key(sid));
        void setCursorStatus(sid, "waiting");
      } else if (msg.state === "user") {
        void suppressCursorStatus(key(sid));
      } else if (msg.state === "idle") {
        void clearAmbientCursorStatus(key(sid));
      }
    } else if (msg.type === "agent_event") {
      const sid = msg.sessionId ?? LEAD_SESSION_ID;
      if (msg.event.kind === "tool_start") {
        activityBySession.set(sid, msg.event.name === "await_message" ? "waiting_message" : "waiting_tool");
      } else if (msg.event.kind === "tool_end") {
        activityBySession.set(sid, "running");
      }
      void applyCursorStatusEvent(sid, msg.event);
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
      void executeToolCall(msg.id, msg.name, msg.params, msg.sessionId, msg.programId,msg.runId,msg.epochs?.[normalizeSessionId(msg.sessionId)]);
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
  runId?:string|null,
  epoch?:number,
): Promise<void> {
  if(name==='observe_page'){
    try{const data=await voiceRelay.observe(conversationId,params.token);uplink.sendClientMessage({type:'tool_result',id,ok:true,data});}
    catch(e){uplink.sendClientMessage({type:'tool_result',id,ok:false,error:oneLine(e)});}
    return;
  }
  await controlReady;
  let result: Extract<ClientMessage, { type: "tool_result" }>;
  let executionFact: import("../../../shared/protocol.js").ToolExecutionFact = "not_executed";
  const sid = normalizeSessionId(sessionId);
  const checkIdentity=()=>{
    const current=conversationSummaries.find(c=>c.id===conversationId)?.runId;
    if(runId&&(abortedRuns.has(runId)||current!==runId))throw new Error('原任务已停止或发生变化，操作未执行。');
    if(epoch!==undefined&&epoch<(executionEpochs.get(sid)??0))throw new Error('操作所属控制轮次已失效，操作未执行。');
  };
  const rememberFact = (error: unknown): void => {
    if (error && typeof error === "object" && "executionFact" in error) {
      const reported = (error as { executionFact?: import("../../../shared/protocol.js").ToolExecutionFact }).executionFact;
      if (reported) executionFact = reported;
    }
  };
  const attachFact = (error: unknown): void => {
    if (!error || typeof error !== "object") return;
    try { (error as { executionFact?: string }).executionFact = executionFact; } catch { /* 原始错误优先 */ }
  };
  try {
    checkIdentity();
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${String(name)}`);
    if (programId && gate.isSessionBlocked(sid)) throw new Error("页面现在归你，操作未执行");
    setSessionClaimBlocked(sid, gate.isSessionBlocked(sid));
    const operationGeneration = gate.gen;
    const execute = async () => {
      checkIdentity();
      const refusedByDemo = demoRefusal(name);
      if (refusedByDemo) throw new Error(refusedByDemo);
      if(gate.gen!==operationGeneration)throw new Error('操作所属控制轮次已失效，操作未执行。');
      await guardToolAccess(name, key(sid), typeof params.tabId === "number" ? params.tabId : undefined);
      checkIdentity();
      if(gate.gen!==operationGeneration)throw new Error('操作所属控制轮次已失效，操作未执行。');
      if (workerTabControl.isStopped(key(sid))) throw new Error("worker 已停止，操作未执行");
      return gate.run(id, name, async () => {
        if (name === "page_operation") {
          try {
            const r = await pageOperation(params as any, key(sid), {canWrite: () => gate.gen === operationGeneration && !gate.isSessionBlocked(sid) && !workerTabControl.isStopped(key(sid))});
            executionFact = "executed";
            return r;
          } catch (error) {
            // 结构化事实：page_operation 自带 changed 标志，未改页即可重试，改过一律未知。
            executionFact = pageOperationExecutionFact(error);
            attachFact(error);
            throw error;
          }
        }
        // 进入具体动作执行，后续异常可能产生副作用
        executionFact = "unknown";
        try {
          const r = await handler(params, key(sid));
          executionFact = "executed";
          return r;
        } catch (error) {
          attachFact(error);
          throw error;
        }
      }, sid);
    };
    const data = name === "worker_tabs" ? await execute() : await workerTabControl.run(key(sid), execute);
    // 教学标注追踪：mark 成功 = 有待完成步骤；clear_marks = 步骤标注已清
    if (name === "mark") noteMarkDrawn(conversationId);
    else if (name === "clear_marks") noteMarksCleared(conversationId);
    // 被拦成等用户确认的点击没有派发任何鼠标事件：回执按未执行上报，账本不能据此判完成。
    result = {
      type: "tool_result",
      id,
      ok: true,
      data,
      executionFact: isHeldClickResult(name, data) ? "not_executed" : "executed",
    };
  } catch (e) {
    rememberFact(e);
    result = { type: "tool_result", id, ok: false, error: oneLine(e), executionFact };
  }
  // 已完成写操作的身份跨 SW 重启保留，重复投递不会二次落地。
  if (WRITE_TOOL_SET.has(name)) persistControl();
  uplink.sendClientMessage(result);
}

function emitLocalStatus(state: AgentRunState): void {
  statusBySession.set(LEAD_SESSION_ID, state);
  lastStatus = aggregateRunState(statusBySession.values());
  persistControl();
  broadcastVisibleServer({ type: "status", state });
}

async function handleTakeover(requestedTabId?: number,remoteRequestId?:string,wholeTask=false): Promise<void> {
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
  const targetTabId = wholeTask ? undefined : requestedTabId ?? await getWorkingTabId() ?? undefined;
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
  const draining=targetTabId != null ? Promise.resolve({generation:gate.gen, superseded:false}) : gate.beginTakeover();
  if(wholeTask)await Promise.all([...new Set(members.flatMap(m=>m.tabId==null?[]:[m.tabId]))].map(tabId=>takeoverTab(tabId)));
  const result = await draining;
  if (result.superseded) {
    team.clear();
    return;
  }
  await hideCursorsForSessions(members.map((m) => key(m.sessionId)));
  for (const m of members) void suppressCursorStatus(key(m.sessionId));
  const requestId = remoteRequestId ?? nextControlRequestId("takeover");
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
      ...(remoteRequestId?{taskRequestId:remoteRequestId}:{}),
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

async function handleHandback(remoteRequestId?:string): Promise<void> {
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
  const requestId = remoteRequestId ?? nextControlRequestId("handback");
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
    ...(remoteRequestId?{taskRequestId:remoteRequestId}:{}),
    members,
    ...(teamViewNow ? { groupId: teamViewNow.groupId, generation: teamViewNow.generation } : {}),
    ...(leadPage && leadPage.ok ? { context: leadPage.context, snapshot: leadPage.snapshot } : {}),
  };
  if (!uplink.sendClientMessage(payload)) {
    failPendingControl(requestId, "当前没有连接到原会话，页面仍归你。");
  }
}

async function handleAbort(taskRequestId?:string): Promise<void> {
  const runId=conversationSummaries.find(c=>c.id===conversationId)?.runId;
  if(runId)abortedRuns.add(runId);
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
  for (const sid of sessions) void suppressCursorStatus(key(sid));
  void memberTabIds().then(ids => Promise.all(ids.map(id => hideUserControlBanners(id))));
  void stopTrailReplay(key());
  const completion=Promise.all([abortDrain,aborted.settled]).then(async () => {
    if (gate.gen !== aborted.generation) return;
    for (const tabId of await abortedTabs) handbackTab(tabId);
    await hideCursorsForSessions(sessions.map(key));
    await Promise.all((await memberTabIds()).map(id => hideUserControlBanners(id)));
    await stopTrailReplay(key());
  });
  abortDrain=completion.catch(()=>{});
  const sent=uplink.sendClientMessage({ type: "abort",...(taskRequestId?{taskRequestId}:{}) });
  if(taskRequestId&&!sent)throw new Error('终止请求未送达Agent。');
  await completion;
}

function finishRemoteControl(ok:boolean,reason?:string,uncertain=false,partial=false):void{
  const current=remoteControl;if(!current)return;remoteControl=null;clearTimeout(current.timer);current.abortAck?.(false);
  uplink.sendClientMessage({type:'task_control_result',requestId:current.request.requestId,action:current.request.action,runId:current.request.runId,ok,reason:reason?.slice(0,1000),uncertain,partial});
}
async function runRemoteControl(request:Extract<ServerMessage,{type:'task_control'}>):Promise<void>{
  if(remoteControl){uplink.sendClientMessage({type:'task_control_result',requestId:request.requestId,action:request.action,runId:request.runId,ok:false,reason:'另一项页面控制还在进行，请稍后重试。'});return;}
  if(conversationSummaries.find(c=>c.id===conversationId)?.runId!==request.runId){uplink.sendClientMessage({type:'task_control_result',requestId:request.requestId,action:request.action,runId:request.runId,ok:false,reason:'目标任务已变化，页面控制未执行。'});return;}
  const current={request,timer:setTimeout(()=>finishRemoteControl(false,'页面控制结果尚无法确认。',true),45000),abortAck:undefined as ((ok:boolean)=>void)|undefined};remoteControl=current;
  try{
    if(request.action==='abort'){
      const backend=new Promise<boolean>(resolve=>current.abortAck=resolve);
      await handleAbort(request.requestId);const stopped=await backend;
      if(remoteControl===current)finishRemoteControl(stopped,stopped?undefined:'Agent停止状态未能确认。',!stopped);
      return;
    }
    if(request.action==='pause')await handleTakeover(request.tabId,request.requestId,request.scope!=='page');else await handleHandback(request.requestId);
    if(remoteControl===current&&pendingControl?.requestId!==request.requestId){
      if(request.action==='pause'&&gate.isUser())finishRemoteControl(true);
      else if(request.action==='resume'&&team.view()?.members.some(m=>m.phase==='restoring'))return;
      else if(request.action==='resume'&&team.view()?.phase==='restored')finishRemoteControl(true);
      else finishRemoteControl(false,'页面控制没有启动，原有控制权保持不变。');
    }
  }catch(error){if(remoteControl===current)finishRemoteControl(false,oneLine(error),true);}
}

function requestPanelControl(action:'pause'|'resume'|'abort',tabId?:number):void{
  const runId=conversationSummaries.find(c=>c.id===conversationId)?.runId??null;
  if(action==='abort'&&runId===null&&(gate.isUser()||teamHeld())){
    void handleAbort().then(()=>emitNotice('旧任务没有恢复，已清除本地控制状态。')).catch(error=>emitNotice(oneLine(error),'error'));return;
  }
  if(!uplink.sendClientMessage({type:'task_action',request:{requestId:crypto.randomUUID(),conversationId,source:'text',action,expectedRunId:runId,scope:action==='pause'?'page':'task',...(tabId?{tabId}:{})}}))emitNotice('连接已断开，控制请求没有发送。','error');
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
chrome.tabs.onActivated.addListener(({ tabId }) => {
  // 观察只跟"用户正在看的那一页"：换页就把观察脚本带过去，换走就把上一个停掉。
  void (async () => { if (await isObserving()) await injectObserver(tabId); })();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 观察：导航完成后在新页继续；关着就什么都不做。
  if (changeInfo.status === "complete") void (async () => { if (await isObserving()) await injectObserver(tabId); })();
  // 示范跨页时要续录：内容脚本随导航消失，页面加载完成后把它喂回去接着记。
  if (changeInfo.status === "complete" && conversationForRecordingTab(tabId) === conversationId) {
    void resumeDemoIfRecording(tabId);
  }
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
    if ((raw as PanelToBg)?.kind === "client" && (raw as Extract<PanelToBg, {kind:"client"}>).msg?.type === "voice") return;
    const selectedAtReceipt = selectedConversationId;
    void Promise.all([controlReady, historyReady]).then(() => handlePanelMessage(raw, selectedAtReceipt));
  });
  function handlePanelMessage(raw: unknown, selectedAtReceipt: string) {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") return;
    const requested = msg.kind === "client" ? msg.msg?.conversationId : "conversationId" in msg ? msg.conversationId : undefined;
    if ((requested ?? selectedAtReceipt) !== conversationId) return;
    switch (msg.kind) {
      case "demo": void handleDemoControl(msg.action); break;
      case "observe": void handleObserveControl(msg.action, msg.signature, msg.hostname); break;
      case "client": {
        const wireClient = msg.msg;
        const client = wireClient?.type==='task_action' && ['start','steer'].includes(wireClient.request.action)
          ? {type:wireClient.request.action==='start'?'user_message' as const:'steer' as const,text:wireClient.request.text!,context:wireClient.request.context,attachments:wireClient.request.attachments,conversationId}
          : wireClient;
        if (!client || typeof client.type !== "string") break;
        // set_mode 先落本地模式状态（供标注追踪判定），再照常转发给 agent
        if (client.type === "set_mode") {
          const mode = client.mode;
          void setMode(mode, conversationId).then(() => broadcast({ kind: "mode", mode }));
        }
        // user_message / steer 先附页面上下文再上行（异步，失败时原样发送）
        if (client.type === "abort") {
          requestPanelControl('abort');
          break;
        }
        if (client.type === "user_message" || client.type === "steer") {

          const entry = recordAndBroadcastHistory({
            kind: "user",
            text: client.text,
            attachments: client.attachments,
          });
          if (lastStatus === "idle" && isReplayRequest(client.text)) {
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
          if (isAffirmativeReply(client.text)) armDestructiveClick(key());
          else if (isCancelReply(client.text)) {
            // 侧栏打「取消」与点名牌「取消」同效：清 pending、松开拿住的手、收起标注
            void resolveHeldClick("cancel", key()).catch(() => {
              /* 清理失败不挡住把「取消」送进对话 */
            });
          }
          void attachPageContext(client).then((enriched) => {
            // 上行传输不可用 = 确定未发给伴随进程：回执面板标记未送达，
            // original 保留原始消息（含选区上下文）供用户明确重试。
            const original:ClientMessage = wireClient.type==='task_action'
              ? {...wireClient,conversationId,request:{...wireClient.request,context:enriched.context,attachments:enriched.attachments}}
              : { ...enriched, conversationId };
            if (!uplink.sendClientMessage(original)) {
              panelHistory.markUndelivered(entry.seq, original);
              flushHistory();
              broadcast({ kind: "delivery", seq: entry.seq, ok: false, original } satisfies BgToPanel);
            }
          });
          break;
        }
        uplink.sendClientMessage(client);
        break;
      }
      case "control":
        if (msg.action === "takeover") requestPanelControl('pause',msg.tabId);
        else requestPanelControl('resume');
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
        port.postMessage({kind:"demo", ...demoStatus()} satisfies BgToPanel);
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

return { isUserHeld: (sid: string) => gate.isSessionBlocked(sid), callbacks, attachPanel, handback: () => requestPanelControl('resume'),
voiceInput:async(input:import('../../../shared/voice.js').VoiceInputContext)=>{const enriched=await attachPageContext({type:'user_message',text:'',context:input.context,attachments:input.attachments});return {context:enriched.context,attachments:enriched.attachments};},
restoreMode: (mode: import("../../../shared/protocol.js").AgentMode) => {
  void setMode(mode, conversationId).then(() => broadcast({kind:"mode",mode}));
}, ready: Promise.all([controlReady, historyReady]) };


}
