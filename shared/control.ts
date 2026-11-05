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
import { requiresControlGate, WRITE_TOOL_SET } from "./effect-policy.js";

type ControlOwner = "agent" | "user";

export const USER_BLOCKED_ERROR = "页面现在归你，操作未执行";

export const FOREIGN_TAB_ERROR = "该页正在由其他会话使用";
export const HELD_BY_OTHER_TASK_ERROR = "这一页已交给用户，另一个任务正暂停等用户交还，操作未执行";

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

export function shouldRestoreUserControlBanner(opts: {
  owner: ControlOwner;
  changeInfo: { status?: string; url?: string };
}): boolean {
  return opts.owner === "user" && opts.changeInfo.status === "complete";
}

type ControlSnapshot = {
  owner: ControlOwner;
  generation: number;
  lastStatus: AgentRunState;
  team?: TeamView;
  sessions?: Record<string, ControlOwner>;
  completed?: string[];
};

function parseControlSnapshot(raw: unknown): ControlSnapshot | null {
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

  const completedRaw = (o as { completed?: unknown }).completed;

  const completed = Array.isArray(completedRaw)
    ? completedRaw.filter((k): k is string => typeof k === "string" && k.length >= 1 && k.length <= 160).slice(-CONTROL_COMPLETED_MAX)
    : undefined;

  const snap: ControlSnapshot = {
    owner: o.owner,
    generation: o.generation,
    lastStatus: o.lastStatus,
  };

  if (team) snap.team = team;

  if (sessions && Object.keys(sessions).length > 0) snap.sessions = sessions;

  if (completed && completed.length > 0) snap.completed = completed;

  return snap;
}

export function snapshotControl(
  gate: ControlGate,
  lastStatus: AgentRunState,
  team?: TeamView | null,
): ControlSnapshot {
  const sessions = gate.sessionOwners();
  const completed = gate.completedIds();

  const snap: ControlSnapshot = {
    owner: gate.control,
    generation: gate.gen,
    lastStatus,
  };

  if (team) snap.team = team;

  if (Object.keys(sessions).length > 0) snap.sessions = sessions;

  if (completed.length > 0) snap.completed = completed;

  return snap;
}

export function applyControlSnapshot(
  gate: ControlGate,
  raw: unknown,
  team?: TeamControl,
): { restoredUser: boolean; lastStatus: AgentRunState } {
  const snap = parseControlSnapshot(raw);

  if (!snap) return { restoredUser: false, lastStatus: "idle" };
  gate.hydrate(snap.owner, snap.generation, snap.sessions, snap.completed);

  if (team && snap.team) team.hydrate(snap.team);

  if (snap.owner === "user") return { restoredUser: true, lastStatus: "user" };

  return { restoredUser: false, lastStatus: snap.lastStatus === "running" ? "running" : "idle" };
}

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

export function shouldFinishRunOnDisconnect(userHasPage: boolean): boolean {
  return !userHasPage;
}

export function handbackContinueText(context: PageContext, snapshot: string,originalGoal?:string): string {
  const title = (context.title || "(untitled)").replace(/\s+/g, " ");

  return [
    "[HANDOFF BOUNDARY]",
    "[The CURRENT page and snapshot are authoritative. Stay on this tab: do not navigate, reload, close, or reopen this page or site. Reading or using another tab or site is allowed only when the original goal or a user instruction requires it (for example fetching a code from the user's mailbox); then return to this tab to continue. These stay-on-page instructions apply only to this restored original task and expire when that original task ends.]",
    "[Continue the original task only from the supplied snapshot. Do not repeat completed steps; treat every completed step as complete and do not redo it. If the original task is already complete, acknowledge that and stop.]",
    "[The user may have edited fields or content on this page while it was theirs. Those visible values are the user's current decisions: do not overwrite them to satisfy an earlier instruction, keep them, and report any conflict instead of resolving it silently.]",
    ...(originalGoal?["[Original user goal; apply subsequent amendments as constraints]",originalGoal]:[]),
    "[Applying an amendment does not by itself finish the original goal. If authorized work remains, perform its next step now; do not end with a promise to continue in another reply. Continue bounded tool calls until the requested result or explicit stop condition is reached. Never redo completed steps.]",
    `[User's current page: tab ${context.tabId} "${title}" — ${context.url}]`,
    "[Current snapshot]",
    snapshot,
  ].join("\n");
}

function sessionKey(sessionId?: string | null): string {
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId!;
}

const CONTROL_COMPLETED_MAX = 256;

type CompletedOutcome =
  | { status: "resolved"; name: ToolName; value: unknown }
  | { status: "rejected"; name: ToolName; error: unknown }
  | { status: "replayed"; name: ToolName | null };

export class ControlGate {
  private owner: ControlOwner = "agent";
  private generation = 0;
  private draining = false;
  private inflight = new Map<string, { settled: Promise<unknown>; sessionId: string; name: ToolName }>();
  private completed = new Map<string, CompletedOutcome>();
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

  completedIds(): string[] {
    return [...this.completed.keys()].slice(-CONTROL_COMPLETED_MAX);
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

  canLand(name: ToolName, sessionId?: string | null, params?: Record<string, unknown>): boolean {
    if (!WRITE_TOOL_SET.has(name) && !requiresControlGate(name, params)) return true;

    if (this.draining) return false;

    if (sessionId != null && this.sessionBlocked.has(sessionKey(sessionId))) {
      return this.sessionBlocked.get(sessionKey(sessionId)) === false;
    }

    return this.owner !== "user";
  }

  async run<T>(id: string, name: ToolName, fn: () => Promise<T>, sessionId?: string | null, params?: Record<string, unknown>): Promise<T> {
    if (!WRITE_TOOL_SET.has(name) && !requiresControlGate(name, params)) {
      if (!this.canLand(name, sessionId, params)) throw new Error(USER_BLOCKED_ERROR);

      return fn();
    }

    const key = `${sessionKey(sessionId)}::${id}`;
    const done = this.completed.get(key);

    if (done) return this.replayCompleted<T>(done, name);
    const active = this.inflight.get(key);

    if (active) {
      await active.settled.catch(() => {});
      const settled = this.completed.get(key);

      if (settled) return this.replayCompleted<T>(settled, name);
    }

    if (!this.canLand(name, sessionId, params)) {
      throw new Error(USER_BLOCKED_ERROR);
    }

    let release: () => void = () => {};

    const sentinel = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.inflight.set(key, { settled: sentinel, sessionId: sessionKey(sessionId), name });

    if (!this.canLand(name, sessionId, params)) {
      this.inflight.delete(key);
      release();
      throw new Error(USER_BLOCKED_ERROR);
    }

    try {
      const value = await fn();
      this.rememberCompleted(key, { status: "resolved", name, value });

      return value;
    } catch (error) {
      this.rememberCompleted(key, { status: "rejected", name, error });
      throw error;
    } finally {
      this.inflight.delete(key);
      release();
    }
  }

  private replayCompleted<T>(done: CompletedOutcome, name: ToolName): T {
    if (done.name !== null && done.name !== name) {
      throw new Error("操作编号已用于其他操作，本次未执行。");
    }

    if (done.status === "resolved") return done.value as T;

    if (done.status === "rejected") throw done.error;
    const error = new Error("该操作已在之前的扩展进程中执行过，本次未重复执行；以原来的结果为准。");
    (error as Error & { executionFact?: string }).executionFact = "unknown";
    throw error;
  }

  private rememberCompleted(key: string, outcome: CompletedOutcome): void {
    this.completed.delete(key);
    this.completed.set(key, outcome);

    while (this.completed.size > CONTROL_COMPLETED_MAX) {
      const oldest = this.completed.keys().next().value;

      if (oldest === undefined) break;
      this.completed.delete(oldest);
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

  async drainSessions(sessionIds: Iterable<string>, limitMs: number): Promise<boolean> {
    const ids = new Set([...sessionIds].map(sessionKey));
    const pending = [...this.inflight.values()].filter((entry) => ids.has(entry.sessionId) && entry.name !== "wait_event").map((entry) => entry.settled);

    if (!pending.length) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), limitMs); });

    try {
      return await Promise.race([Promise.allSettled(pending).then(() => true as const), limit]);
    } finally {
      clearTimeout(timer);
    }
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

  hydrate(owner: ControlOwner, generation: number, sessions?: Record<string, ControlOwner>, completed?: string[]): void {
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

    if (completed) {
      this.completed.clear();

      for (const key of completed.slice(-CONTROL_COMPLETED_MAX)) this.completed.set(key, { status: "replayed", name: null });
    }
  }
}

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

const TEAM_TAB_CLOSED = "绑定页已关闭，未续跑";

const TEAM_SNAPSHOT_FAILED = "页面还在，但没读到新状态，未续跑";

const TEAM_ALL_RESTORED = "全队已恢复";

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

function cloneTeam(view: TeamView): TeamView {
  return {
    ...view,
    members: view.members.map((m) => ({ ...m })),
  };
}

function nextGroupId(): string {
  return `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
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
    return { status: "正在暂停全队", sub: `${n} 个`, action: "请稍候", actionEnabled: false };
  }

  if (team.phase === "user") {
    return { status: "现在归你", sub: `${n} 个已暂停`, action: "继续", actionEnabled: true };
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

  return { status: "助手在工作", sub: `${n}`, action: "接管", actionEnabled: true };
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
