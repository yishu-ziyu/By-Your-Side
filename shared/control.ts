/**
 * 页面控制权：现在归 Agent 还是归用户。
 * 硬闸门在执行层（不靠模型自觉）。接管确认出现前必须排空已开始的写操作；
 * 排队或迟到的写调用一律不落地。交还不得回退到旧标签页。
 */
import {
  LEAD_SESSION_ID,
  isLeadSession,
  isTeamView,
  type AgentRunState,
  type PageContext,
  type TeamMemberHandback,
  type TeamMemberPhase,
  type TeamMemberRole,
  type TeamMemberView,
  type TeamPhase,
  type TeamView,
  type ToolName,
} from "./protocol.js";

export type ControlOwner = "agent" | "user";

/** 接管期间禁止落地的浏览器写操作。至少覆盖完成标准列出的那些。 */
export const WRITE_TOOLS = [
  "open_tab",
  "switch_tab",
  "close_tab",
  "navigate",
  "click",
  "fill",
  "type_text",
  "press_key",
  "scroll",
  "js",
  "mark",
  "clear_marks",
] as const satisfies readonly ToolName[];

export const WRITE_TOOL_SET: ReadonlySet<ToolName> = new Set(WRITE_TOOLS);

export const USER_BLOCKED_ERROR = "页面现在归你，操作未执行";

export const HANDBACK_NO_PAGE = "取不到当前页面，控制权仍归你。没有回到之前的工作标签。";

export function isWriteTool(name: string): name is ToolName {
  return WRITE_TOOL_SET.has(name as ToolName);
}

export function aggregateRunState(states: Iterable<AgentRunState>): AgentRunState {
  let sawUser = false;
  for (const s of states) {
    if (s === "running") return "running";
    if (s === "user") sawUser = true;
  }
  return sawUser ? "user" : "idle";
}

export function panelLive(
  states: Iterable<AgentRunState>,
  team?: TeamView | null,
): {
  running: boolean;
  userHasPage: boolean;
  live: boolean;
  finishRun: boolean;
  abortVisible: boolean;
  takeoverVisible: boolean;
  sendVisible: boolean;
  composer: "idle" | "running" | "user";
} {
  if (team && team.phase !== "idle") {
    if (team.phase === "aborted") {
      return {
        running: false,
        userHasPage: false,
        live: false,
        finishRun: true,
        abortVisible: false,
        takeoverVisible: false,
        sendVisible: true,
        composer: "idle",
      };
    }
    if (team.phase === "restored") {
      const running = aggregateRunState(states) === "running";
      return {
        running,
        userHasPage: false,
        live: running,
        finishRun: !running,
        abortVisible: running,
        takeoverVisible: running,
        sendVisible: !running,
        composer: running ? "running" : "idle",
      };
    }
    const restoring = team.phase === "restoring" || team.phase === "partial";
    const held = team.phase === "user" || team.phase === "draining" || restoring;
    const someRunning = team.members.some((m) => m.phase === "restored" || m.phase === "running");
    return {
      running: someRunning && team.phase !== "user" && team.phase !== "draining",
      userHasPage: held,
      live: true,
      finishRun: false,
      abortVisible: true,
      takeoverVisible: false,
      sendVisible: false,
      composer: "user",
    };
  }
  const agg = aggregateRunState(states);
  const running = agg === "running";
  const userHasPage = agg === "user";
  const live = running || userHasPage;
  return {
    running,
    userHasPage,
    live,
    finishRun: !live,
    abortVisible: live,
    takeoverVisible: running,
    sendVisible: !live,
    composer: userHasPage ? "user" : running ? "running" : "idle",
  };
}

/** 刷新/跳转后 content overlay 已 teardown。只有 load complete 且仍归用户时才重画条。 */
export function shouldRestoreUserControlBanner(opts: {
  owner: ControlOwner;
  changeInfo: { status?: string; url?: string };
}): boolean {
  return opts.owner === "user" && opts.changeInfo.status === "complete";
}

export type ControlSnapshot = {
  owner: ControlOwner;
  generation: number;
  lastStatus: AgentRunState;
  team?: TeamView;
  sessions?: Record<string, ControlOwner>;
};

export function parseControlSnapshot(raw: unknown): ControlSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as { owner?: unknown; generation?: unknown; lastStatus?: unknown; team?: unknown };
  if (o.owner !== "agent" && o.owner !== "user") return null;
  if (typeof o.generation !== "number" || !Number.isFinite(o.generation)) return null;
  if (o.lastStatus !== "idle" && o.lastStatus !== "running" && o.lastStatus !== "user") return null;
  const team = isTeamView(o.team) ? o.team : undefined;
  const sessionsRaw = (o as { sessions?: unknown }).sessions;
  let sessions: Record<string, ControlOwner> | undefined;
  if (sessionsRaw && typeof sessionsRaw === "object" && !Array.isArray(sessionsRaw)) {
    sessions = {};
    for (const [k, v] of Object.entries(sessionsRaw as Record<string, unknown>)) {
      if (v === "agent" || v === "user") sessions[k] = v;
    }
  }
  return {
    owner: o.owner,
    generation: o.generation,
    lastStatus: o.lastStatus,
    ...(team ? { team } : {}),
    ...(sessions && Object.keys(sessions).length > 0 ? { sessions } : {}),
  };
}

export function snapshotControl(
  gate: ControlGate,
  lastStatus: AgentRunState,
  team?: TeamView | null,
): ControlSnapshot {
  const sessions = gate.sessionOwners();
  return {
    owner: gate.control,
    generation: gate.gen,
    lastStatus,
    ...(team ? { team } : {}),
    ...(Object.keys(sessions).length > 0 ? { sessions } : {}),
  };
}

export function applyControlSnapshot(
  gate: ControlGate,
  raw: unknown,
  team?: TeamControl,
): { restoredUser: boolean; lastStatus: AgentRunState } {
  const snap = parseControlSnapshot(raw);
  if (!snap) return { restoredUser: false, lastStatus: "idle" };
  gate.hydrate(snap.owner, snap.generation, snap.sessions);
  if (team && snap.team) team.hydrate(snap.team);
  if (snap.owner === "user") return { restoredUser: true, lastStatus: "user" };
  return { restoredUser: false, lastStatus: snap.lastStatus === "running" ? "running" : "idle" };
}

/** uplink / SW 断线：归用户时不得 abort 闸门，也不能把状态打成 idle。 */
export function uplinkLostWhileHeld(owner: ControlOwner): {
  abortGate: boolean;
  hideBanner: boolean;
  lastStatus: AgentRunState;
} {
  if (owner === "user") {
    return { abortGate: false, hideBanner: false, lastStatus: "user" };
  }
  return { abortGate: true, hideBanner: true, lastStatus: "idle" };
}

/**
 * SW 启动后第一次 uplink 状态。hydrate 完成前不得按默认 agent 走 abortGate，
 * 否则会把存储里的 user 覆盖成 agent。
 */
export function applyFirstUplinkState(opts: {
  hydrateDone: boolean;
  owner: ControlOwner;
  connState: "connecting" | "connected" | "disconnected";
}): { applyLost: boolean; abortGate: boolean; hideBanner: boolean; lastStatus: AgentRunState } {
  if (!opts.hydrateDone) {
    return { applyLost: false, abortGate: false, hideBanner: false, lastStatus: "idle" };
  }
  if (opts.connState === "connected") {
    return {
      applyLost: false,
      abortGate: false,
      hideBanner: false,
      lastStatus: opts.owner === "user" ? "user" : "idle",
    };
  }
  const lost = uplinkLostWhileHeld(opts.owner);
  return { applyLost: true, ...lost };
}

/**
 * 正确启动顺序：先灌快照，再处理立即到来的 connecting。
 * 存储里的 user 必须还在，写操作仍被挡。
 */
export function bootWithStoredControl(
  stored: unknown,
  firstConn: "connecting" | "disconnected",
): { gate: ControlGate; lastStatus: AgentRunState; persisted: ControlSnapshot } {
  const gate = new ControlGate();
  const applied = applyControlSnapshot(gate, stored);
  const first = applyFirstUplinkState({
    hydrateDone: true,
    owner: gate.control,
    connState: firstConn,
  });
  let lastStatus: AgentRunState = applied.restoredUser ? "user" : applied.lastStatus;
  if (first.applyLost && first.abortGate) {
    gate.abort();
    lastStatus = first.lastStatus;
  }
  return { gate, lastStatus, persisted: snapshotControl(gate, lastStatus) };
}

/** Agent 客户端断开：held 时不得清 hold（扩展可能只是 SW 重启）。 */
export function clientGoneWhileHeld(held: boolean): { clearHold: boolean; abortStream: boolean } {
  if (held) return { clearHold: false, abortStream: false };
  return { clearHold: true, abortStream: true };
}

export function shouldFinishRunOnDisconnect(userHasPage: boolean): boolean {
  return !userHasPage;
}

export type HandbackPrep =
  | { ok: true; context: PageContext }
  | { ok: false; reason: string };

/** 交还只认用户此刻的活动标签。取不到就停住，绝不回退到旧工作标签。 */
export function prepareHandback(
  active: { id: number; title: string; url: string } | null,
  _previousWorkingTabId?: number | null,
): HandbackPrep {
  if (!active || typeof active.id !== "number" || !Number.isFinite(active.id)) {
    return { ok: false, reason: HANDBACK_NO_PAGE };
  }
  return {
    ok: true,
    context: {
      tabId: active.id,
      title: active.title ?? "",
      url: active.url ?? "",
    },
  };
}

export function handbackContinueText(context: PageContext, snapshot: string): string {
  const title = (context.title || "(untitled)").replace(/\s+/g, " ");
  return [
    "[HANDOFF BOUNDARY]",
    "[The CURRENT page and snapshot are authoritative. Stay on this tab. Do not switch tabs, navigate, reload, or reopen any page. Do not reopen the site.]",
    "[Continue the original task only from the supplied snapshot. Do not repeat completed steps; treat every completed step as complete and do not redo it. If the original task is already complete, acknowledge that and stop.]",
    `[User's current page: tab ${context.tabId} "${title}" — ${context.url}]`,
    "[Current snapshot]",
    snapshot,
  ].join("\n");
}

/**
 * 执行层闸门。takeover() 先挡住新的写操作，等已开始的写操作结束，再把 owner 设为 user。
 * abort() 与 takeover 不同：立刻回到 agent，不等待。
 */
function sessionKey(sessionId?: string | null): string {
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId!;
}

export class ControlGate {
  private owner: ControlOwner = "agent";
  private generation = 0;
  private draining = false;
  private inflight = new Map<string, { settled: Promise<unknown>; sessionId: string }>();
  /** true = 该 session 仍归用户，写操作与认领别页都禁止。 */
  private sessionBlocked = new Map<string, boolean>();

  get control(): ControlOwner {
    return this.owner;
  }

  get gen(): number {
    return this.generation;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  isUser(): boolean {
    return this.owner === "user";
  }

  sessionOwners(): Record<string, ControlOwner> {
    const out: Record<string, ControlOwner> = {};
    for (const [id, blocked] of this.sessionBlocked) out[id] = blocked ? "user" : "agent";
    return out;
  }

  inflightSessionIds(): string[] {
    return [...new Set([...this.inflight.values()].map((entry) => entry.sessionId))];
  }

  isSessionBlocked(sessionId?: string | null): boolean {
    if (this.draining) return true;
    if (sessionId != null && this.sessionBlocked.has(sessionKey(sessionId))) {
      return this.sessionBlocked.get(sessionKey(sessionId)) === true;
    }
    return this.owner === "user";
  }

  blockSession(sessionId: string): void {
    this.sessionBlocked.set(sessionKey(sessionId), true);
  }

  releaseSession(sessionId: string): void {
    this.sessionBlocked.set(sessionKey(sessionId), false);
  }

  canLand(name: ToolName, sessionId?: string | null): boolean {
    if (!WRITE_TOOL_SET.has(name)) return true;
    if (this.draining) return false;
    if (sessionId != null && this.sessionBlocked.has(sessionKey(sessionId))) {
      return this.sessionBlocked.get(sessionKey(sessionId)) === false;
    }
    return this.owner !== "user";
  }

  async run<T>(id: string, name: ToolName, fn: () => Promise<T>, sessionId?: string | null): Promise<T> {
    if (!this.canLand(name, sessionId)) {
      throw new Error(USER_BLOCKED_ERROR);
    }
    if (!WRITE_TOOL_SET.has(name)) {
      return fn();
    }
    let release: () => void = () => {};
    const sentinel = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.inflight.set(id, { settled: sentinel, sessionId: sessionKey(sessionId) });
    if (!this.canLand(name, sessionId)) {
      this.inflight.delete(id);
      release();
      throw new Error(USER_BLOCKED_ERROR);
    }
    try {
      return await fn();
    } finally {
      this.inflight.delete(id);
      release();
    }
  }

  async beginTakeover(): Promise<{ generation: number; superseded: boolean }> {
    if (this.owner === "user") {
      return { generation: this.generation, superseded: false };
    }
    this.draining = true;
    const gen = ++this.generation;
    await Promise.allSettled([...this.inflight.values()].map((entry) => entry.settled));
    if (this.generation !== gen) {
      return { generation: this.generation, superseded: true };
    }
    return { generation: gen, superseded: false };
  }

  commitTakeover(generation: number, sessionIds?: string[]): boolean {
    if (this.owner === "user") return this.generation === generation;
    if (!this.draining || this.generation !== generation) return false;
    this.owner = "user";
    this.draining = false;
    if (sessionIds) {
      this.sessionBlocked.clear();
      for (const id of sessionIds) this.sessionBlocked.set(sessionKey(id), true);
    }
    return true;
  }

  cancelTakeover(generation: number): boolean {
    if (!this.draining || this.generation !== generation) return false;
    this.generation += 1;
    this.owner = "agent";
    this.draining = false;
    this.sessionBlocked.clear();
    return true;
  }

  async takeover(): Promise<{ generation: number; superseded: boolean }> {
    if (this.owner === "user") {
      return { generation: this.generation, superseded: false };
    }
    const pending = await this.beginTakeover();
    if (pending.superseded) return pending;
    const committed = this.commitTakeover(pending.generation);
    return { generation: this.generation, superseded: !committed };
  }

  handback(): { generation: number } {
    this.generation += 1;
    this.owner = "agent";
    this.draining = false;
    this.sessionBlocked.clear();
    return { generation: this.generation };
  }

  abort(): { generation: number; settled: Promise<void> } {
    const settled = Promise.allSettled([...this.inflight.values()].map((entry) => entry.settled)).then(() => {});
    this.generation += 1;
    this.owner = "agent";
    this.draining = false;
    this.inflight.clear();
    this.sessionBlocked.clear();
    return { generation: this.generation, settled };
  }

  /** SW 重启后从 session storage 灌回。不等待 inflight（进程已空）。 */
  hydrate(owner: ControlOwner, generation: number, sessions?: Record<string, ControlOwner>): void {
    this.owner = owner;
    this.generation = generation;
    this.draining = false;
    this.inflight.clear();
    this.sessionBlocked.clear();
    if (sessions) {
      for (const [id, who] of Object.entries(sessions)) {
        this.sessionBlocked.set(sessionKey(id), who === "user");
      }
    }
  }
}

/** 会话侧：接管不等于中止；agent_end 在 hold 期间不得变成 idle。 */
export class SessionHold {
  private held = false;

  isHeld(): boolean {
    return this.held;
  }

  holdForUser(): AgentRunState {
    this.held = true;
    return "user";
  }

  releaseToAgent(): void {
    this.held = false;
  }

  abort(): void {
    this.held = false;
  }

  statusAfterAgentEnd(willRetry: boolean): AgentRunState | null {
    if (this.held) return "user";
    if (willRetry) return null;
    return "idle";
  }

  statusAfterAgentStart(): AgentRunState {
    return this.held ? "user" : "running";
  }
}

export const TEAM_TAB_CLOSED = "绑定页已关闭，未续跑";
export const TEAM_SNAPSHOT_FAILED = "页面还在，但没读到新状态，未续跑";
export const TEAM_ALL_RESTORED = "全队已恢复";
export const CLAIM_BLOCKED_ERROR = "绑定页已关闭，未认领其他标签";

export type TeamMemberActivity = "running" | "waiting_tool" | "waiting_message";

export interface ActiveMemberInput {
  sessionId: string;
  role: TeamMemberRole;
  activity: TeamMemberActivity;
  tabId?: number | null;
  title?: string;
  url?: string;
}

export type MemberHandbackPage =
  | { ok: true; sessionId: string; context: PageContext; snapshot: string; capturedAt: number }
  | {
      ok: false;
      sessionId: string;
      reason: string;
      closed: boolean;
      snapshotFailed?: boolean;
      context?: PageContext;
      capturedAt: number;
    };

type SessionActivity = {
  sessionId?: string;
  streaming: boolean;
  held: boolean;
  waitingTool: boolean;
  waitingMessage: boolean;
  tabId?: number | null;
  title?: string;
  url?: string;
};

function activityOf(s: SessionActivity): TeamMemberActivity | null {
  if (s.waitingMessage) return "waiting_message";
  if (s.waitingTool) return "waiting_tool";
  if (s.streaming || s.held) return "running";
  return null;
}

export function snapshotActiveGroup(opts: { lead: SessionActivity; workers: SessionActivity[] }): ActiveMemberInput[] {
  const workers: ActiveMemberInput[] = [];
  for (const w of opts.workers) {
    const activity = activityOf(w);
    if (!activity || !w.sessionId) continue;
    workers.push({
      sessionId: w.sessionId,
      role: "worker",
      activity,
      tabId: w.tabId,
      title: w.title,
      url: w.url,
    });
  }
  const leadActivity = activityOf(opts.lead) ?? (workers.length > 0 ? "running" : null);
  if (!leadActivity) return [];
  return [
    {
      sessionId: opts.lead.sessionId && !isLeadSession(opts.lead.sessionId) ? opts.lead.sessionId : LEAD_SESSION_ID,
      role: "lead",
      activity: leadActivity,
      tabId: opts.lead.tabId,
      title: opts.lead.title,
      url: opts.lead.url,
    },
    ...workers,
  ];
}

export function mergeActiveMembersForTakeover(opts: {
  statuses: Iterable<readonly [string, AgentRunState]>;
  activities?: Iterable<readonly [string, TeamMemberActivity]>;
  inflightSessionIds: Iterable<string>;
  workingTabs: Record<string, number>;
  tabs: Iterable<{ id: number; title?: string; url?: string }>;
}): ActiveMemberInput[] {
  const statuses = new Map(opts.statuses);
  const activities = new Map(
    [...(opts.activities ?? [])].map(([sessionId, activity]) => [sessionKey(sessionId), activity] as const),
  );
  const active = new Set<string>();
  for (const [sessionId, state] of statuses) {
    if (state === "running" || state === "user") active.add(sessionKey(sessionId));
  }
  for (const sessionId of opts.inflightSessionIds) active.add(sessionKey(sessionId));
  const tabs = new Map([...opts.tabs].map((tab) => [tab.id, tab]));
  const activity = (sessionId: string): SessionActivity => {
    const state = statuses.get(sessionId);
    const currentActivity = activities.get(sessionId);
    const tabId = opts.workingTabs[sessionId];
    const tab = typeof tabId === "number" ? tabs.get(tabId) : undefined;
    return {
      sessionId,
      streaming: state === "running" || active.has(sessionId),
      held: state === "user",
      waitingTool: currentActivity === "waiting_tool",
      waitingMessage: currentActivity === "waiting_message",
      tabId,
      title: tab?.title ?? "",
      url: tab?.url ?? "",
    };
  };
  const workerIds = [...active].filter((sessionId) => !isLeadSession(sessionId));
  return snapshotActiveGroup({
    lead: activity(LEAD_SESSION_ID),
    workers: workerIds.map(activity),
  });
}

export function prepareMemberHandback(opts: {
  sessionId: string;
  boundTab: { id: number; title: string; url: string } | null;
  snapshot?: string;
  snapshotError?: string;
  capturedAt?: number;
  activeTabId?: number;
}): MemberHandbackPage {
  const capturedAt = opts.capturedAt ?? Date.now();
  if (!opts.boundTab || typeof opts.boundTab.id !== "number" || !Number.isFinite(opts.boundTab.id)) {
    return { ok: false, sessionId: opts.sessionId, reason: TEAM_TAB_CLOSED, closed: true, capturedAt };
  }
  const context = {
    tabId: opts.boundTab.id,
    title: opts.boundTab.title ?? "",
    url: opts.boundTab.url ?? "",
  };
  if (opts.snapshotError) {
    return {
      ok: false,
      sessionId: opts.sessionId,
      reason: TEAM_SNAPSHOT_FAILED,
      closed: false,
      snapshotFailed: true,
      context,
      capturedAt,
    };
  }
  return {
    ok: true,
    sessionId: opts.sessionId,
    context,
    snapshot: opts.snapshot ?? "",
    capturedAt,
  };
}

export function toTeamMemberHandback(page: MemberHandbackPage): TeamMemberHandback {
  if (!page.ok) {
    if (page.snapshotFailed) {
      return {
        sessionId: page.sessionId,
        snapshotFailed: true,
        reason: page.reason,
        context: page.context,
        capturedAt: page.capturedAt,
      };
    }
    return { sessionId: page.sessionId, closed: true, reason: page.reason, capturedAt: page.capturedAt };
  }
  return {
    sessionId: page.sessionId,
    context: page.context,
    snapshot: page.snapshot,
    capturedAt: page.capturedAt,
  };
}

export function fromTeamMemberHandback(m: TeamMemberHandback): MemberHandbackPage {
  if ("closed" in m && m.closed) {
    return {
      ok: false,
      sessionId: m.sessionId,
      reason: m.reason ?? TEAM_TAB_CLOSED,
      closed: true,
      capturedAt: m.capturedAt ?? Date.now(),
    };
  }
  if ("snapshotFailed" in m && m.snapshotFailed) {
    return {
      ok: false,
      sessionId: m.sessionId,
      reason: m.reason ?? TEAM_SNAPSHOT_FAILED,
      closed: false,
      snapshotFailed: true,
      context: m.context,
      capturedAt: m.capturedAt ?? Date.now(),
    };
  }
  const open = m as Extract<TeamMemberHandback, { context: PageContext; snapshot: string }>;
  return {
    ok: true,
    sessionId: open.sessionId,
    context: open.context,
    snapshot: open.snapshot,
    capturedAt: open.capturedAt ?? Date.now(),
  };
}

export function handbackPagesIndependent(pages: MemberHandbackPage[]): boolean {
  const ok = pages.filter((p): p is Extract<MemberHandbackPage, { ok: true }> => p.ok);
  const tabIds = new Set(ok.map((p) => p.context.tabId));
  const snaps = new Set(ok.map((p) => p.snapshot));
  return ok.length > 0 && tabIds.size === ok.length && snaps.size === ok.length;
}

function cloneTeam(view: TeamView): TeamView {
  return {
    ...view,
    members: view.members.map((m) => ({ ...m })),
  };
}

function nextGroupId(): string {
  return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function teamSummaryLabel(team: TeamView): string {
  const n = team.members.length;
  const restored = team.members.filter((m) => m.phase === "restored").length;
  const paused = team.members.filter(
    (m) => m.phase === "paused_tab_closed" || m.phase === "paused_snapshot_failed" || m.phase === "user" || m.phase === "restoring",
  ).length;
  const closed = team.members.filter((m) => m.phase === "paused_tab_closed").length;
  if (team.phase === "draining") {
    const stopped = team.members.filter((m) => m.phase === "user").length;
    return `正在停住 ${stopped} / ${n}`;
  }
  if (team.phase === "user") return `${n} 个 Agent 已暂停`;
  if (team.phase === "restoring") return "正在恢复";
  if (team.phase === "partial") {
    if (closed > 0) return `${restored} 个已恢复 · ${closed} 个未续跑`;
    return `${restored} 个已恢复 · ${paused} 个仍暂停`;
  }
  if (team.phase === "restored") return TEAM_ALL_RESTORED;
  if (team.phase === "aborted") return "已中止";
  return `${n} 个 Agent`;
}

export function teamOwnerBanner(team: TeamView): {
  status: string;
  sub: string;
  action: string;
  actionEnabled: boolean;
} {
  const n = team.members.length;
  const restored = team.members.filter((m) => m.phase === "restored").length;
  const paused = n - restored;
  if (team.phase === "draining") {
    return { status: "正在停住全队", sub: `${n} 个`, action: "请稍候", actionEnabled: false };
  }
  if (team.phase === "user") {
    return { status: "现在归你", sub: `${n} 个已暂停`, action: "交还", actionEnabled: true };
  }
  if (team.phase === "restoring") {
    return { status: "正在恢复", sub: `${restored} / ${n}`, action: "请稍候", actionEnabled: false };
  }
  if (team.phase === "partial") {
    return {
      status: `${restored} 个已恢复`,
      sub: `${paused} 个仍暂停`,
      action: "查看",
      actionEnabled: false,
    };
  }
  if (team.phase === "aborted") {
    return { status: "已中止", sub: "", action: "", actionEnabled: false };
  }
  if (team.phase === "restored") {
    return { status: TEAM_ALL_RESTORED, sub: `${n} 个`, action: "", actionEnabled: false };
  }
  return { status: "Agent 在工作", sub: `${n}`, action: "接管", actionEnabled: true };
}

export function memberPhaseLabel(phase: TeamMemberPhase): string {
  switch (phase) {
    case "running":
    case "waiting_tool":
      return "运行中";
    case "waiting_message":
      return "等待消息";
    case "draining":
      return "排空中";
    case "user":
      return "已暂停";
    case "restoring":
      return "恢复中";
    case "restored":
      return "已恢复";
    case "paused_tab_closed":
      return TEAM_TAB_CLOSED;
    case "paused_snapshot_failed":
      return TEAM_SNAPSHOT_FAILED;
    case "aborted":
      return "已中止";
    default:
      return "空闲";
  }
}

export function shouldShowTeamCard(phase: TeamPhase | undefined | null): boolean {
  return phase != null && phase !== "idle";
}

export function memberBoundPageLabel(
  m: Pick<TeamMemberView, "title" | "url" | "phase"> & { sessionId?: string; role?: TeamMemberView["role"] },
): string {
  if (m.phase === "paused_tab_closed") return (m.title || m.url || "已关闭页面").trim() || "已关闭页面";
  const title = (m.title || "").trim();
  const url = (m.url || "").trim();
  return title || url || "绑定页";
}

export function applyMemberGates(gate: ControlGate, team: TeamView): { globalHandback: boolean } {
  const held = team.members.filter((m) => m.phase !== "restored" && m.phase !== "aborted");
  const restored = team.members.filter((m) => m.phase === "restored");
  if (held.length === 0) {
    gate.handback();
    return { globalHandback: true };
  }
  for (const m of restored) gate.releaseSession(m.sessionId);
  for (const m of held) gate.blockSession(m.sessionId);
  return { globalHandback: false };
}

export function reconcileTeamProgress(
  gate: ControlGate,
  team: TeamView,
): { statuses: Map<string, AgentRunState>; hideBanners: boolean } {
  const applied = applyMemberGates(gate, team);
  return {
    statuses: new Map(
      team.members.map((member) => [
        member.sessionId,
        member.phase === "restored" ? "running" : member.phase === "aborted" ? "idle" : "user",
      ]),
    ),
    hideBanners: applied.globalHandback || team.phase === "restored",
  };
}

export function onUplinkLostDuringControl(opts: {
  owner: ControlOwner;
  draining: boolean;
  pendingAction: "takeover" | "handback" | null;
}): { abortGate: boolean; cancelTakeover: boolean; hideBanner: boolean; lastStatus: AgentRunState } {
  if (opts.owner === "user" || opts.draining || opts.pendingAction === "takeover") {
    return {
      abortGate: false,
      cancelTakeover: false,
      hideBanner: false,
      lastStatus: opts.owner === "user" ? "user" : "running",
    };
  }
  if (opts.pendingAction === "handback") {
    return { abortGate: false, cancelTakeover: false, hideBanner: false, lastStatus: "user" };
  }
  return { abortGate: true, cancelTakeover: false, hideBanner: true, lastStatus: "idle" };
}

export function acceptIncomingTeam(opts: {
  incoming: TeamView;
  local: TeamView | null;
  pendingRequestId?: string | null;
  resultRequestId?: string | null;
}): { accept: boolean; restoreUser: boolean } {
  if (
    opts.resultRequestId &&
    opts.pendingRequestId &&
    opts.resultRequestId !== opts.pendingRequestId
  ) {
    return { accept: false, restoreUser: false };
  }
  if (opts.local) {
    if (opts.incoming.groupId !== opts.local.groupId) return { accept: false, restoreUser: false };
    if (opts.incoming.generation !== opts.local.generation) return { accept: false, restoreUser: false };
  }
  const restoreUser =
    opts.incoming.phase === "user" || opts.incoming.phase === "partial" || opts.incoming.phase === "draining";
  return { accept: true, restoreUser };
}

export function holdFrozenGroup(opts: {
  team: TeamControl;
  frozen: ActiveMemberInput[];
  live?: ActiveMemberInput[];
  group?: { groupId?: string; generation?: number };
  holdMember: (sessionId: string, abortStream: boolean) => void;
}): TeamView {
  const view = opts.team.snapshotAndFreeze(opts.frozen, Date.now(), opts.group);
  for (const m of view.members) {
    opts.holdMember(m.sessionId, m.phase !== "waiting_message");
  }
  opts.team.beginDrain();
  for (const m of view.members) opts.team.markDrained(m.sessionId);
  opts.team.commitUser(opts.team.view()!.generation);
  return opts.team.view()!;
}

export class TeamControl {
  private frozen: TeamView | null = null;
  private drained = new Set<string>();

  view(): TeamView | null {
    return this.frozen ? cloneTeam(this.frozen) : null;
  }

  member(sessionId: string): TeamMemberView | undefined {
    const found = this.frozen?.members.find((m) => m.sessionId === sessionId);
    return found ? { ...found } : undefined;
  }

  hydrate(view: TeamView): void {
    this.frozen = cloneTeam(view);
    this.drained = new Set(
      view.phase === "user" || view.phase === "restoring" || view.phase === "partial" || view.phase === "restored"
        ? view.members.map((m) => m.sessionId)
        : [],
    );
  }

  snapshotAndFreeze(
    members: ActiveMemberInput[],
    now = Date.now(),
    group?: { groupId?: string; generation?: number },
  ): TeamView {
    this.drained.clear();
    this.frozen = {
      groupId: group?.groupId ?? nextGroupId(),
      generation: group?.generation ?? 1,
      phase: "idle",
      capturedAt: now,
      members: members.map((m) => ({
        sessionId: m.sessionId,
        role: m.role,
        phase: m.activity,
        activity: m.activity,
        tabId: typeof m.tabId === "number" ? m.tabId : undefined,
        title: m.title,
        url: m.url,
        capturedAt: now,
      })),
    };
    return this.view()!;
  }

  tryAddMember(_member: ActiveMemberInput): boolean {
    return false;
  }

  beginDrain(): TeamView {
    if (!this.frozen || this.frozen.phase === "aborted") {
      throw new Error("no frozen team");
    }
    this.frozen.phase = "draining";
    for (const m of this.frozen.members) m.phase = "draining";
    this.drained.clear();
    return this.view()!;
  }

  markDrained(sessionId: string): TeamView {
    if (this.frozen?.members.some((m) => m.sessionId === sessionId)) this.drained.add(sessionId);
    return this.view()!;
  }

  canCommitUser(): boolean {
    if (!this.frozen || this.frozen.phase !== "draining") return false;
    return this.frozen.members.every((m) => this.drained.has(m.sessionId));
  }

  commitUser(generation: number): boolean {
    if (!this.canCommitUser() || !this.frozen || this.frozen.generation !== generation) return false;
    this.frozen.phase = "user";
    for (const m of this.frozen.members) m.phase = "user";
    return true;
  }

  beginRestore(): TeamView {
    if (!this.frozen || (this.frozen.phase !== "user" && this.frozen.phase !== "partial")) {
      throw new Error("team is not held by user");
    }
    this.frozen.phase = "restoring";
    return this.view()!;
  }

  applyHandback(
    pages: MemberHandbackPage[],
    meta?: { groupId?: string; generation?: number },
  ): boolean {
    if (!this.frozen || this.frozen.phase === "aborted") return false;
    if (meta?.groupId && meta.groupId !== this.frozen.groupId) return false;
    if (meta?.generation != null && meta.generation !== this.frozen.generation) return false;
    if (this.frozen.phase !== "restoring" && this.frozen.phase !== "partial" && this.frozen.phase !== "user") {
      return false;
    }
    if (this.frozen.phase === "user") this.frozen.phase = "restoring";
    for (const page of pages) {
      const m = this.frozen.members.find((row) => row.sessionId === page.sessionId);
      if (!m || m.phase === "restored" || m.phase === "aborted") continue;
      if (!page.ok) {
        m.phase = page.closed ? "paused_tab_closed" : "paused_snapshot_failed";
        m.reason = page.reason;
        if (page.context) {
          m.tabId = page.context.tabId;
          m.title = page.context.title;
          m.url = page.context.url;
        }
        continue;
      }
      m.phase = "restoring";
      m.tabId = page.context.tabId;
      m.title = page.context.title;
      m.url = page.context.url;
      m.capturedAt = page.capturedAt;
      m.reason = undefined;
    }
    this.recomputePhase();
    return true;
  }

  markRestored(
    sessionId: string,
    meta?: { groupId?: string; generation?: number },
  ): TeamView {
    if (meta?.groupId && meta.groupId !== this.frozen?.groupId) return this.view()!;
    if (meta?.generation != null && meta.generation !== this.frozen?.generation) return this.view()!;
    const m = this.frozen?.members.find((row) => row.sessionId === sessionId);
    if (m && (m.phase === "restoring" || m.phase === "user")) m.phase = "restored";
    this.recomputePhase();
    return this.view()!;
  }

  markRestoreFailed(
    sessionId: string,
    reason = "恢复失败，原会话仍归你。",
    meta?: { groupId?: string; generation?: number },
  ): TeamView {
    if (meta?.groupId && meta.groupId !== this.frozen?.groupId) return this.view()!;
    if (meta?.generation != null && meta.generation !== this.frozen?.generation) return this.view()!;
    const m = this.frozen?.members.find((row) => row.sessionId === sessionId);
    if (m && (m.phase === "restoring" || m.phase === "user")) {
      m.phase = "paused_snapshot_failed";
      m.reason = reason;
    }
    this.recomputePhase();
    return this.view()!;
  }

  abort(): TeamView {
    if (!this.frozen) {
      this.frozen = {
        groupId: nextGroupId(),
        generation: 1,
        phase: "aborted",
        capturedAt: Date.now(),
        members: [],
      };
    }
    this.frozen.generation += 1;
    this.frozen.phase = "aborted";
    for (const m of this.frozen.members) m.phase = "aborted";
    this.drained.clear();
    return this.view()!;
  }

  canHandback(): boolean {
    return this.frozen?.phase === "user";
  }

  clear(): void {
    this.frozen = null;
    this.drained.clear();
  }

  private recomputePhase(): void {
    if (!this.frozen || this.frozen.phase === "aborted") return;
    const members = this.frozen.members;
    const allRestored = members.every((m) => m.phase === "restored");
    const someClosed = members.some(
      (m) => m.phase === "paused_tab_closed" || m.phase === "paused_snapshot_failed",
    );
    const someRestored = members.some((m) => m.phase === "restored");
    const stillHeld = members.some(
      (m) => m.phase === "user" || m.phase === "restoring" || m.phase === "paused_snapshot_failed",
    );
    if (allRestored) this.frozen.phase = "restored";
    else if (someRestored || someClosed) this.frozen.phase = stillHeld || someClosed ? "partial" : "partial";
    else if (members.some((m) => m.phase === "restoring")) this.frozen.phase = "restoring";
  }
}
