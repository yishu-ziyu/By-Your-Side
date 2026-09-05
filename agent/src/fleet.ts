/**
 * 并行工人：Lead 拥有图，工人各绑一个 Pi session + 标签页 + 光标 id。
 * spawn 非阻塞；工人之间经 Mailbox 传工件。工人无 spawn 工具。
 */
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

export class Fleet {
  readonly mailbox = new Mailbox();
  private readonly workers = new Map<string, BrowserAgentSession>();
  private lead: BrowserAgentSession | null = null;
  private readonly rpc: ToolRpc;
  private readonly sink: FleetSink;
  private readonly modelPattern?: string;
  private readonly team = new TeamControl();
  private readonly lastContinue = new Map<string, { tabId: number; url: string; snapshot: string }>();

  constructor(opts: { rpc: ToolRpc; sink: FleetSink; modelPattern?: string }) {
    this.rpc = opts.rpc;
    this.sink = opts.sink;
    this.modelPattern = opts.modelPattern;
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
    for (const [id, session] of this.workers) {
      session.abort();
      session.dispose();
      this.workers.delete(id);
    }
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
          const reason = session ? "恢复失败，原会话仍归你。" : "恢复失败：原会话已不存在，仍归你。";
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

  async spawn(opts: { id?: string; goal: string; url?: string; peers?: string[] }): Promise<{ id: string; tabId?: number }> {
    assertCanSpawn(this.workers.size);
    const goal = opts.goal.trim();
    if (!goal) throw new Error("spawn_worker 需要 goal");
    if (!this.lead?.runtime) throw new Error("Lead 会话不可用，无法请人");

    const id = sanitizeWorkerId(opts.id, this.workers.keys());
    const peers = (opts.peers ?? []).map((p) => p.trim()).filter(Boolean);

    let tabId: number | undefined;
    try {
      const opened = (await this.rpc.call(
        "open_tab",
        { url: opts.url },
        undefined,
        id,
      )) as { tabId: number };
      tabId = opened.tabId;
    } catch (err) {
      throw new Error(`为 ${displayNameFor(id)} 打开标签页失败：${err instanceof Error ? err.message : String(err)}`);
    }

    const session = await this.createWorkerSession({ id, peers, tabId });
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
    id: string;
    peers: string[];
    tabId?: number;
  }): Promise<BrowserAgentSession> {
    if (!this.lead?.runtime) throw new Error("Lead 会话不可用，无法请人");
    const { id, peers, tabId } = opts;
    let started = false;
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
        systemPrompt: workerSystemPrompt({ id, peers, tabId }),
        appendPrompt: () => [],
        customTools: [...createBrowserTools(this.rpc, id), ...createFleetTools(this, id)],
      },
    );
    if (!session.available) {
      throw new Error(`${displayNameFor(id)} 会话创建失败`);
    }
    this.workers.set(id, session);
    return session;
  }

  stop(id: string): boolean {
    const session = this.workers.get(id);
    if (!session) return false;
    session.abort();
    session.dispose();
    this.workers.delete(id);
    return true;
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
      "REQUIRED first action when the user asks for work on two independent sites/apps in one message. Starts a parallel browser worker on its own tab. Non-blocking: returns the worker id immediately. Max 2 live workers. Give a complete goal, optional start url, and peer ids so they can post/await artifacts. Do not browse both sites yourself.",
    parameters: Type.Object({
      goal: Type.String({ description: "Complete instructions for the worker; it has no other memory" }),
      id: Type.Optional(Type.String({ description: "Short id, e.g. wiki or feishu" })),
      url: Type.Optional(Type.String({ description: "Optional URL to open as the worker's tab" })),
      peers: Type.Optional(Type.Array(Type.String(), { description: "Other worker ids in this job" })),
    }),
    execute: async (_id, params) => {
      const result = await fleet.spawn({
        id: typeof params.id === "string" ? params.id : undefined,
        goal: String(params.goal),
        url: typeof params.url === "string" ? params.url : undefined,
        peers: Array.isArray(params.peers) ? params.peers.map(String) : undefined,
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
      const ok = fleet.stop(id);
      return textResult(ok ? `Stopped worker ${id}.` : `No live worker named ${id}.`, { stopped: ok });
    },
  });

  return [spawnTool, listTool, stopTool, postTool, awaitTool];
}
