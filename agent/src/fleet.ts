import type {PageContext} from '../../shared/protocol.js';
/**
 * 并行工人：Lead 拥有图，工人各绑一个 Pi session + 标签页 + 光标 id。
 * spawn 非阻塞；工人之间经 Mailbox 传工件。工人无 spawn 工具。
 */
import { randomUUID } from "node:crypto";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  LEAD_SESSION_ID,
  isLeadSession,
  type AgentRunState,
  type AgentUiEvent,
  type AcceptanceContinuityEvidence,
  type TeamView,
} from "../../shared/protocol.js";
import {
  TeamControl,
  holdFrozenGroup,
  snapshotActiveGroup,
  type ActiveMemberInput,
  type MemberHandbackPage,
} from "../../shared/control.js";
import { displayNameFor } from "../../shared/cast.js";
import { Mailbox, DEFAULT_AWAIT_MS } from "./mailbox.js";
import { workerSystemPrompt } from "./prompt.js";
import type { ToolRpc } from "./rpc.js";
import { BrowserAgentSession } from "./session.js";
import { createBrowserTools } from "./tools.js";
import { registerAcceptanceModel } from "./acceptance-model.js";

export const MAX_WORKERS = 2;

export function sanitizeWorkerId(raw: string | undefined, taken: Iterable<string>): string {
  const takenSet = new Set(taken);
  let base = (raw ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  if (!base || base === LEAD_SESSION_ID) base = "worker";
  let id = base;
  let n = 2;
  while (takenSet.has(id) || id === LEAD_SESSION_ID) {
    id = `${base}-${n}`;
    n += 1;
  }
  return id;
}

export function assertCanSpawn(liveCount: number, max = MAX_WORKERS): void {
  if (liveCount >= max) {
    throw new Error(`最多同时请 ${max} 个人；先等他们结束，或 stop_worker。`);
  }
}

function textResult(text: string, details: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

export interface FleetSink {
  emit(event: AgentUiEvent, sessionId?: string): void;
  setStatus(state: AgentRunState, sessionId?: string): void;
}

/** Worker 工具的执行约束：与 Lead 共用同一会话进度，但只拦未决写入，不代替 Lead 登记结果。 */
export function workerExecution(getSession: () => BrowserAgentSession | undefined) {
  return {
    epoch: () => getSession()?.executionEpoch() ?? 0,
    canWrite: () => getSession()?.canWriteCurrentInput() ?? false,
    assertCall: (name: string, params: Record<string, unknown>) => getSession()?.assertWorkerWriteAllowed(name, params),
    onStep: (step: import('./browser-program.js').ProgramStep) => getSession()?.observeProgramStep(step),
  };
}

export class Fleet {
  readonly mailbox = new Mailbox();
  private readonly workers = new Map<string, BrowserAgentSession>();
  private lead: BrowserAgentSession | null = null;
  private readonly releases = new Map<string, Promise<unknown>>();
  private readonly spawning = new Set<string>();
  private generation = 0;
  private coordinateTab?: (owner: string, members: string[]) => Promise<void>;
  setTabCoordinator(coordinate: (owner: string, members: string[]) => Promise<void>): void { this.coordinateTab = coordinate; }
  private readonly rpc: ToolRpc;
  private readonly sink: FleetSink;
  private readonly modelPattern?: string;
  private readonly team = new TeamControl();
  private readonly lastContinue = new Map<string, { tabId: number; url: string; snapshot: string }>();
  private conversationSnapshot: (() => import("../../shared/voice.js").TaskProgressSnapshot | null) | null = null;
  /** 成员数变化时通知宿主重新挂载协作工具；不是用户可见事件。 */
  onMembersChange?: (count: number) => void;

  constructor(opts: { rpc: ToolRpc; sink: FleetSink; modelPattern?: string }) {
    this.rpc = opts.rpc;
    this.sink = opts.sink;
    this.modelPattern = opts.modelPattern;
  }

  private announceMembers(): void {
    try { this.onMembersChange?.(this.workers.size); } catch { /* 挂载失败不阻塞任务 */ }
  }

  /** 与 Lead 共享同一会话进度；worker 写操作据此看到同一未决写入。 */
  bindConversationContext(snapshot: () => import("../../shared/voice.js").TaskProgressSnapshot | null): void {
    this.conversationSnapshot = snapshot;
    for (const session of this.workers.values()) session.bindConversationContext(snapshot);
  }

  attachLead(session: BrowserAgentSession): void {
    this.lead = session;
  }

  get size(): number {
    return this.workers.size;
  }

  has(id: string): boolean {
    return this.workers.has(id);
  }

  get(id: string): BrowserAgentSession | undefined {
    return isLeadSession(id) ? (this.lead ?? undefined) : this.workers.get(id);
  }

  list(): { id: string; streaming: boolean }[] {
    return [...this.workers.entries()].map(([id, s]) => ({ id, streaming: s.isStreaming() }));
  }

  /** 新用户任务开始前：中止工人、清空邮箱。 */
  reset(): void {
    this.abortAll();
    this.mailbox.clear();
  }

  abortAll(): void {
    this.generation += 1;
    for (const id of this.workers.keys()) this.stop(id);
  }

  teamView(): TeamView | null {
    return this.team.view();
  }

  isGroupHeld(): boolean {
    const phase = this.team.view()?.phase;
    return phase === "user" || phase === "draining" || phase === "restoring" || phase === "partial";
  }

  snapshotActive(): ActiveMemberInput[] {
    const waitingMsg = new Set(this.mailbox.waitingSessionIds());
    const waitingTool = new Set(this.rpc.pendingSessionIds());
    return snapshotActiveGroup({
      lead: {
        sessionId: LEAD_SESSION_ID,
        streaming: this.lead?.isStreaming() ?? false,
        held: this.lead?.isHeld() ?? false,
        waitingTool: waitingTool.has(LEAD_SESSION_ID),
        waitingMessage: waitingMsg.has(LEAD_SESSION_ID),
      },
      workers: [...this.workers.entries()].map(([id, session]) => ({
        sessionId: id,
        streaming: session.isStreaming(),
        held: session.isHeld(),
        waitingTool: waitingTool.has(id),
        waitingMessage: waitingMsg.has(id),
      })),
    });
  }

  holdActiveGroup(
    frozen?: ActiveMemberInput[],
    group?: { groupId?: string; generation?: number },
  ): TeamView {
    const members = frozen && frozen.length > 0 ? frozen : this.snapshotActive();
    const missing = members.find((member) => !this.get(member.sessionId));
    if (missing) {
      throw new Error(`接管组成员 ${missing.sessionId} 的原会话不存在`);
    }
    return holdFrozenGroup({
      team: this.team,
      frozen: members,
      group,
      holdMember: (id, abortStream) => {
        this.get(id)!.holdForUser({ abortStream });
      },
    });
  }

  continuedSnapshot(sessionId: string): { tabId: number; url: string; snapshot: string } | undefined {
    return this.lastContinue.get(sessionId);
  }

  async continueMembers(
    pages: MemberHandbackPage[],
    meta?: { groupId?: string; generation?: number },
    onTeamUpdate?: (team: TeamView) => void,
  ): Promise<{ ok: boolean; team: TeamView }> {
    const current = this.team.view();
    if (!current || current.phase === "aborted") {
      return { ok: false, team: current ?? this.team.abort() };
    }
    if (current.phase === "user") this.team.beginRestore();
    if (!this.team.applyHandback(pages, meta)) {
      return { ok: false, team: this.team.view()! };
    }
    onTeamUpdate?.(this.team.view()!);
    const expected = this.team.view()!;
    const results = await Promise.all(
      pages.map(async (page) => {
        if (!page.ok) return false;
        const session = this.get(page.sessionId);
        let ok = false;
        try {
          ok = session ? await session.continueAfterHandback(page.context, page.snapshot) : false;
        } catch {
          ok = false;
        }
        if (!ok) {
          const reason = session
            ? (session.handbackFailureReason ?? "恢复失败，原会话仍归你。")
            : "恢复失败：原会话已不存在，仍归你。";
          const next = this.team.markRestoreFailed(page.sessionId, reason, expected);
          onTeamUpdate?.(next);
          return false;
        }
        const next = this.team.markRestored(page.sessionId, expected);
        if (next.members.find((member) => member.sessionId === page.sessionId)?.phase !== "restored") {
          onTeamUpdate?.(next);
          return false;
        }
        this.lastContinue.set(page.sessionId, {
          tabId: page.context.tabId,
          url: page.context.url,
          snapshot: page.snapshot,
        });
        onTeamUpdate?.(next);
        return true;
      }),
    );
    const team = this.team.view()!;
    const paused = team.members.some(
      (m) => m.phase === "paused_tab_closed" || m.phase === "paused_snapshot_failed",
    );
    return { ok: results.some(Boolean) || paused, team };
  }

  abortTeam(): TeamView {
    this.mailbox.clear();
    this.abortAll();
    this.lastContinue.clear();
    return this.team.abort();
  }

  dispose(): void {
    this.reset();
  }

  async spawn(opts: { id?: string; goal: string; url?: string; peers?: string[]; sharedTabId?: number }): Promise<{ id: string; tabId?: number }> {
    assertCanSpawn(this.workers.size + this.spawning.size);
    const goal = opts.goal.trim();
    if (!goal) throw new Error("spawn_worker 需要 goal");
    if (!this.lead?.runtime) throw new Error("Lead 会话不可用，无法请人");

    const id = `${sanitizeWorkerId(opts.id, [...this.workers.keys(), ...this.spawning])}-${randomUUID().slice(0, 8)}`;
    this.spawning.add(id);
    const generation = this.generation;
    const peers = (opts.peers ?? []).map((p) => p.trim()).filter(Boolean);

    let tabId: number | undefined;
    try {
      if (opts.sharedTabId !== undefined) {
        await this.rpc.call("share_tab", { tabId: opts.sharedTabId, collaborators: [LEAD_SESSION_ID, id] });
        tabId = opts.sharedTabId;
      } else {
      const opened = (await this.rpc.call(
        "open_tab",
        { url: opts.url },
        undefined,
        id,
      )) as { tabId: number };
      tabId = opened.tabId;
      }
    } catch (err) {
      this.spawning.delete(id);
      this.releaseWorker(id);
      throw new Error(`为 ${displayNameFor(id)} 打开标签页失败：${err instanceof Error ? err.message : String(err)}`);
    }

    let session: BrowserAgentSession;
    try {
      if (generation !== this.generation) throw new Error("Worker start cancelled");
      session = await this.createWorkerSession({ id, peers, tabId,shared:opts.sharedTabId!==undefined });
      if (generation !== this.generation) { this.stop(id); throw new Error("Worker start cancelled"); }
    } finally {
      this.spawning.delete(id);
      if (!this.workers.has(id)) this.releaseWorker(id);
    }
    console.error(`[sideagent] spawn worker=${id} tab=${tabId ?? "?"} peers=${peers.join(",") || "-"}`);
    session.sendUserMessage(goal);
    return { id, tabId };
  }

  /** 本地验收装配：复用生产 worker 注册路径，但不发模型任务。 */
  async prepareAcceptanceWorker(opts: {
    id: string;
    tabId: number;
    leadTask: { taskId: string; expectedSnapshotMarker: string };
    workerTask: { taskId: string; expectedSnapshotMarker: string };
    live?:{leadGoal:string;workerGoal:string;leadContext?:PageContext;workerContext?:PageContext};
  }): Promise<AcceptanceContinuityEvidence[]> {
    const { id, tabId } = opts;
    if (!this.workers.has(id)) {
      assertCanSpawn(this.workers.size);
      if (sanitizeWorkerId(id, []) !== id) throw new Error(`验收 worker id 无效：${id}`);
      await this.createWorkerSession({ id, peers: [], tabId });
    }
    const lead = this.lead;
    const worker = this.workers.get(id);
    if (!lead || !worker) throw new Error("验收会话装配不完整");
    if (!lead.runtime) throw new Error("Lead runtime 不可用，无法注册本地验收模型");
    if(opts.live){
      lead.startTask(opts.live.leadGoal,opts.live.leadContext);worker.startTask(opts.live.workerGoal,opts.live.workerContext);
      return []; // Real configured provider, no acceptance-model substitution.
    }
    const acceptanceModel = registerAcceptanceModel(lead.runtime);
    await Promise.all([lead.setModel(acceptanceModel), worker.setModel(acceptanceModel)]);
    const evidence: AcceptanceContinuityEvidence[] = [
      { sessionId: LEAD_SESSION_ID, ...(await lead.beginAcceptanceTask(opts.leadTask.taskId, opts.leadTask.expectedSnapshotMarker)) },
      { sessionId: id, ...(await worker.beginAcceptanceTask(opts.workerTask.taskId, opts.workerTask.expectedSnapshotMarker)) },
    ];
    console.error(`[sideagent] acceptance worker=${id} tab=${tabId}`);
    return evidence;
  }

  acceptanceContinuityEvidence(): AcceptanceContinuityEvidence[] {
    const out: AcceptanceContinuityEvidence[] = [];
    const lead = this.lead?.acceptanceContinuityEvidence();
    if (lead) out.push({ sessionId: LEAD_SESSION_ID, ...lead });
    for (const [sessionId, session] of this.workers) {
      const evidence = session.acceptanceContinuityEvidence();
      if (evidence) out.push({ sessionId, ...evidence });
    }
    return out;
  }

  async waitForAcceptanceContinuity(timeoutMs = 15_000): Promise<AcceptanceContinuityEvidence[]> {
    const traced: Array<[string, BrowserAgentSession]> = [];
    if (this.lead?.acceptanceContinuityEvidence()) traced.push([LEAD_SESSION_ID, this.lead]);
    for (const [sessionId, session] of this.workers) {
      if (session.acceptanceContinuityEvidence()) traced.push([sessionId, session]);
    }
    if (traced.length === 0) return [];
    return Promise.all(
      traced.map(async ([sessionId, session]) => {
        const evidence = await session.waitForAcceptanceResume(timeoutMs);
        if (!evidence) throw new Error(`验收会话 ${sessionId} 没有续跑证据`);
        return { sessionId, ...evidence };
      }),
    );
  }

  private async createWorkerSession(opts: {
    shared?:boolean;
    id: string;
    peers: string[];
    tabId?: number;
  }): Promise<BrowserAgentSession> {
    if (!this.lead?.runtime) throw new Error("Lead 会话不可用，无法请人");
    const { id, peers, tabId } = opts;
    let started = false;
    let workerSession: BrowserAgentSession | undefined;
    const session = await BrowserAgentSession.create(
      this.rpc,
      {
        emit: (event) => this.sink.emit(event, id),
        setStatus: (state) => {
          this.sink.setStatus(state, id);
          if (state === "running") started = true;
          if (state === "idle" && started) {
            queueMicrotask(() => {
              if (this.workers.get(id)?.isHeld()) return;
              this.stop(id);
            });
          }
        },
      },
      {
        modelRuntime: this.lead.runtime,
        modelPattern: this.lead.modelName() ?? this.modelPattern,
        systemPrompt: workerSystemPrompt({ id, peers, tabId,shared:opts.shared }),
        appendPrompt: () => [],
        memberId: id,
        customTools: [
          ...createBrowserTools(this.rpc, id, undefined, name => workerSession?.isToolActive(name) ?? false, workerExecution(() => workerSession)),
          ...createFleetTools(this, id),
        ],
      },
    );
    if (!session.available) {
      throw new Error(`${displayNameFor(id)} 会话创建失败`);
    }
    workerSession = session;
    if (this.conversationSnapshot) session.bindConversationContext(this.conversationSnapshot);
    this.workers.set(id, session);
    this.announceMembers();
    return session;
  }

  stop(id: string): boolean {
    const session = this.workers.get(id);
    if (!session) return false;
    session.abort();
    session.dispose();
    this.workers.delete(id);
    this.announceMembers();
    this.sink.setStatus("idle", id);
    this.releaseWorker(id);
    return true;
  }

  private releaseWorker(id: string): Promise<unknown> {
    const pending = this.releases.get(id);
    if (pending) return pending;
    const release = this.rpc.call("worker_tabs", { action: "release", workerId: id });
    this.releases.set(id, release);
    void release.then(() => { this.releases.delete(id); }, (error) => {
      this.releases.delete(id);
      this.sink.emit({ kind: "notice", message: `worker 已停止，页面移交尚未完成：${error instanceof Error ? error.message : String(error)}。可再次 take_tab 重试。` });
    });
    return release;
  }

  /** 先确认同会话归属，再停止相关成员；扩展确认旧调用排空后才允许父 Agent 继续。 */
  async takeTab(tabId?: number): Promise<{ tabId: number; stopped: string[] }> {
    const info = await this.rpc.call("worker_tabs", { action: "inspect", ...(tabId != null ? { tabId } : {}) }) as { tabId: number; workers: string[]; owned?: boolean; conversationId?: string | null; foreign?: boolean; members?: string[] };
    if (info.foreign) {
      if (!this.coordinateTab) throw new Error("页面协调器尚未就绪，请重连后再试");
      await this.coordinateTab(info.conversationId!, info.members ?? info.workers);
    } else {
      for (const id of info.workers) this.stop(id);
      await Promise.all(info.workers.map(id => this.releaseWorker(id)));
    }
    if (info.owned !== false || info.conversationId !== undefined) await this.rpc.call("worker_tabs", {
      action: "claim", tabId: info.tabId,
      ...(info.conversationId !== undefined ? { expectedConversationId: info.conversationId } : {}),
    });
    return { tabId: info.tabId, stopped: info.workers };
  }

  async stopAndRelease(id: string): Promise<boolean> {
    const stopped = this.stop(id);
    await this.releaseWorker(id);
    return stopped;
  }

}

export function createFleetTools(fleet: Fleet, selfId: string): ToolDefinition[] {
  const postTool = defineTool({
    name: "post",
    label: "Post artifact",
    description:
      "Send a transferable artifact (markdown, text, url, or JSON string) to another worker or to main. Does not merge live page state.",
    parameters: Type.Object({
      to: Type.String({ description: "Recipient worker id, or 'main'" }),
      kind: Type.String({ description: "Artifact kind, e.g. notes, done, need_confirm" }),
      body: Type.String({ description: "Artifact payload" }),
    }),
    execute: async (_id, params) => {
      const art = fleet.mailbox.post({
        from: selfId,
        to: String(params.to),
        kind: String(params.kind),
        body: String(params.body ?? ""),
      });
      return textResult(`Posted kind=${art.kind} to ${art.to} (${art.body.length} chars).`, art);
    },
  });

  const awaitTool = defineTool({
    name: "await_message",
    label: "Await artifact",
    description:
      "Block until a matching artifact arrives in the mailbox (to=you, kind, optional from), or until timeout.",
    parameters: Type.Object({
      kind: Type.String({ description: "Artifact kind to wait for" }),
      from: Type.Optional(Type.String({ description: "Only accept this sender id" })),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 180)" })),
    }),
    execute: async (_id, params, signal) => {
      const timeoutMs =
        typeof params.timeout === "number" && params.timeout > 0
          ? Math.min(params.timeout, 300) * 1000
          : DEFAULT_AWAIT_MS;
      const art = await fleet.mailbox.awaitMessage({
        self: selfId,
        from: typeof params.from === "string" ? params.from : undefined,
        kind: String(params.kind),
        timeoutMs,
        signal: signal as AbortSignal | undefined,
      });
      return textResult(`Received kind=${art.kind} from ${art.from}:\n${art.body}`, art);
    },
  });

  if (!isLeadSession(selfId)) return [postTool, awaitTool];

  const spawnTool = defineTool({
    name: "spawn_worker",
    label: "Spawn worker",
    description:
      "Start an independent part when parallel preparation reduces waiting. Explain the reason and responsibilities to the user before spawning. Use sharedTabId to collaborate on the SAME unsaved page; shared writes must use page_operation. Otherwise opens a separate tab. Non-blocking, max 2 live workers. Do not split short or sequential tasks.",
    parameters: Type.Object({
      goal: Type.String({ description: "Complete instructions for the worker; it has no other memory" }),
      id: Type.Optional(Type.String({ description: "Short id, e.g. wiki or feishu" })),
      url: Type.Optional(Type.String({ description: "Optional URL to open as the worker's tab" })),
      peers: Type.Optional(Type.Array(Type.String(), { description: "Other worker ids in this job" })),
      sharedTabId: Type.Optional(Type.Number({ description: "Existing tab in this conversation to share without cloning its unsaved state" })),
    }),
    execute: async (_id, params) => {
      const result = await fleet.spawn({
        id: typeof params.id === "string" ? params.id : undefined,
        goal: String(params.goal),
        url: typeof params.url === "string" ? params.url : undefined,
        peers: Array.isArray(params.peers) ? params.peers.map(String) : undefined,
        sharedTabId: typeof params.sharedTabId === "number" ? params.sharedTabId : undefined,
      });
      return textResult(
        `Spawned worker ${result.id}${result.tabId != null ? ` on tab ${result.tabId}` : ""}. It is running in parallel.`,
        result,
      );
    },
  });

  const listTool = defineTool({
    name: "list_workers",
    label: "List workers",
    description: "List live parallel workers and whether each is still running.",
    parameters: Type.Object({}),
    execute: async () => {
      const rows = fleet.list();
      if (rows.length === 0) return textResult("No live workers.", { workers: rows });
      const text = rows.map((r) => `${r.id}: ${r.streaming ? "running" : "idle"}`).join("\n");
      return textResult(text, { workers: rows });
    },
  });

  const stopTool = defineTool({
    name: "stop_worker",
    label: "Stop worker",
    description: "Abort and release a live worker.",
    parameters: Type.Object({
      id: Type.String({ description: "Worker id from spawn_worker / list_workers" }),
    }),
    execute: async (_id, params) => {
      const id = String(params.id);
      const ok = await fleet.stopAndRelease(id);
      return textResult(ok ? `Stopped worker ${id}.` : `No live worker named ${id}.`, { stopped: ok });
    },
  });

  const takeTool = defineTool({
    name: "take_tab",
    label: "接管 worker 页面",
    description: "Take control of any browser tab. Coordinates with its current conversation, stops only the members using this tab and waits for pending operations before handing it over. User control remains protected. For reading alone use snapshot or read_element with tabId; no takeover is needed.",
    parameters: Type.Object({ tabId: Type.Number() }),
    execute: async (_id, params) => {
      const result = await fleet.takeTab(params.tabId);
      return textResult(`页面 ${result.tabId} 已交回父 Agent。`, result);
    },
  });
  return [spawnTool, listTool, stopTool, takeTool, postTool, awaitTool];
}
