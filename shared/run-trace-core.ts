/**
 * 诊断记录（run trace）的行格式与限额：扩展内 agent 写 IndexedDB，本机 node 脚本写文件，行内容完全相同。
 * 每个会话一份记录，一行一个事件；只观察，不参与任何控制决定。
 */
import { utf8ByteLength } from "./bytes.js";
import { sanitizeTraceForStore } from "./trace-sanitize.js";

/** 至少保留最近多少个会话的记录；更早的会话在 TRACE_MAX_AGE_DAYS 天内也保留，复盘要看得到一晚上的全部使用。 */
const TRACE_SESSIONS_KEPT = 20;

export const TRACE_MAX_AGE_DAYS = 30;

/** 新会话开始前要删的旧会话：既不在最近 TRACE_SESSIONS_KEPT - 1 个里，也已超过保留天数。名字以开始毫秒开头，按名字排序即按时间排序。 */
export function expiredSessions(older: readonly string[], now = Date.now()): string[] {
  const sorted = [...older].sort();
  const cutoff = now - TRACE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  return sorted.slice(0, Math.max(0, sorted.length - (TRACE_SESSIONS_KEPT - 1))).filter((name) => {
    const started = Number(/^(\d+)-/.exec(name)?.[1]);

    return !Number.isFinite(started) || started < cutoff;
  });
}

/** 单行上限；超过只留摘要。 */
const LINE_MAX_BYTES = 256 * 1024;
const GOAL_CHECK_LINE_MAX_BYTES = 2 * 1024 * 1024;

/** 写入排队上限；排满后丢事件并在下一行记数，诊断永远不拖慢任务。 */
const QUEUE_MAX = 128;

/** 一个会话的存储端：第一次写入前 prepare 一次（建目录、按保留数删旧会话），之后逐行追加。 */
export interface TraceSink {
  prepare(): Promise<void>;
  append(line: string): Promise<void>;
  savePrompt?(hash: string, text: string): Promise<void>;
}

export type TraceCorrelation = { runId: string | null; goalRevision: string | null; turn: number };

export class TraceRecorder {
  readonly sessionId = crypto.randomUUID();
  /** 会话记录名：`<开始毫秒>-<sessionId>`，本机即文件名（不含 .jsonl）。 */
  readonly sessionName = `${Date.now()}-${this.sessionId}`;
  private readonly sink: TraceSink;
  private runId: string | null = null;
  private goalRevision: string | null = null;
  private turn = 0;
  private started = 0;
  private turnStarted = 0;
  private firstResponse = false;
  private firstText = false;
  private tools = new Map<string, number>();
  private prompts = new Set<string>();
  private queue = Promise.resolve();
  private prepared = false;
  private bytes = 0;
  private queued = 0;
  private closed = false;
  private dropped = 0;

  constructor(createSink: (sessionName: string) => TraceSink, private readonly maxBytes = 8 * 1024 * 1024) {
    this.sink = createSink(this.sessionName);
  }

  begin(text: string, context: unknown, model: unknown, correlation?: { runId?: string | null; goalRevision?: string | null }): void {
    this.runId = correlation?.runId ?? crypto.randomUUID();
    this.goalRevision = correlation?.goalRevision ?? null;
    this.turn = 0;
    this.started = Date.now();
    this.firstResponse = false;
    this.firstText = false;
    this.tools.clear();
    this.record("run_start", { text, context, model });
  }

  correlate(correlation: { runId?: string | null; goalRevision?: string | null }): void {
    if (correlation.runId) this.runId = correlation.runId;

    if (correlation.goalRevision) this.goalRevision = correlation.goalRevision;
  }

  /** 侧栏一个会话里会切换对话：没有运行的对话要清掉上一次的 runId，不能沿用。 */
  setRun(runId: string | null): void {
    this.runId = runId;
  }

  /** Process-local monotonic duration recorded in the existing trace stream. */
  stage(name: string, data: Record<string, unknown> = {}): { end: (outcome: string, details?: Record<string, unknown>) => void } {
    const stageId = crypto.randomUUID();
    const startedAt = performance.now();

    const correlation = {
      runId: this.runId,
      goalRevision: this.goalRevision,
      turn: this.turn,
    };

    let ended = false;
    this.write("stage_start", { stageId, name, ...data }, correlation);

    return {
      end: (outcome, details = {}) => {
        if (ended) return;
        ended = true;
        this.write("stage_end", {
          stageId,
          name,
          outcome,
          durationMs: Math.max(0, performance.now() - startedAt),
          ...data,
          ...details,
        }, correlation);
      },
    };
  }

  /** SDK events are observed only: no control decisions and no token-by-token logging. */
  event(event: { type: string; [key: string]: unknown }): void {
    const now = Date.now();

    if (event.type === "message_update") {
      if (!this.firstResponse) {
        this.firstResponse = true;
        this.record("first_response", { elapsedMs: now - this.turnStarted });
      }

      // 首个正文字：first_response 含思考，用户看到的是正文。
      // SAFETY: pi-ai 的 message_update 带 assistantMessageEvent；没有时下面的判断落空。
      if (!this.firstText && (event.assistantMessageEvent as { type?: string } | undefined)?.type === "text_delta") {
        this.firstText = true;
        this.record("first_text", { elapsedMs: now - this.turnStarted });
      }

      return;
    }

    if (event.type === "tool_execution_update") {
      // SAFETY: 组合工具的进度事件把 programStep 放在 partialResult.details 下；缺省时下面的判断落空。
      const partial = event.partialResult as { details?: { programStep?: unknown } } | undefined;

      if ((event.toolName === "browser_run" || event.toolName === "learned_operation") && partial?.details?.programStep) {
        this.record("program_step", { parentToolCallId: event.toolCallId, step: partial.details.programStep });
      }

      return;
    }

    if (event.type === "turn_start") {
      this.turn++;
      this.turnStarted = now;
      this.firstResponse = false;
      this.firstText = false;
    }

    if (event.type === "tool_execution_start") this.tools.set(String(event.toolCallId), now);
    const data: Record<string, unknown> = { ...event };
    delete data.type;

    // agent_end repeats the entire run; turn_end repeats already-recorded tool results.
    if (event.type === "agent_end") {
      delete data.messages;
      data.elapsedMs = this.started ? now - this.started : undefined;
    }

    if (event.type === "turn_end") {
      // 只留用量：缓存命中（cacheRead）要看得出提示词前缀有没有被打碎。
      // SAFETY: turn_end 的 message 是 pi-ai 的 AssistantMessage；没有 usage 时记 undefined。
      const usage = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } } | undefined)?.usage;
      data.usage = usage && { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite };
      delete data.message;
      delete data.toolResults;
      data.elapsedMs = now - this.turnStarted;
    }

    if (event.type === "tool_execution_end") {
      const start = this.tools.get(String(event.toolCallId));
      data.elapsedMs = start === undefined ? undefined : now - start;
      this.tools.delete(String(event.toolCallId));
    }

    this.record(event.type, data);
  }

  prompt(hash: string, text: string): void {
    const save = this.sink.savePrompt;
    if (!save || this.prompts.has(hash) || !/^[a-f0-9]{64}$/.test(hash)) return;
    this.prompts.add(hash);
    this.queued++;
    this.queue = this.queue.then(async () => {
      if (!this.prepared) {
        await this.sink.prepare();
        this.prepared = true;
      }
      await save.call(this.sink, hash, text);
    }).catch(() => { this.prompts.delete(hash); }).finally(() => { this.queued--; });
  }

  traceCorrelation(): TraceCorrelation {
    return { runId: this.runId, goalRevision: this.goalRevision, turn: this.turn };
  }

  recordAt(correlation: TraceCorrelation, type: string, data: Record<string, unknown> = {}): void {
    this.write(type, data, correlation);
  }

  record(type: string, data: Record<string, unknown> = {}): void {
    this.write(type, data, this.traceCorrelation());
  }

  private write(type: string, data: Record<string, unknown>, correlation: TraceCorrelation): void {
    if (this.closed) return;

    if (this.queued >= QUEUE_MAX) {
      this.dropped++;

      return;
    }

    try {
      const droppedPiece = this.dropped ? { droppedEvents: this.dropped } : {};
      const trace = { time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision, turn: correlation.turn, type, data: sanitizeTraceForStore(data), ...droppedPiece };
      let line = JSON.stringify(trace) + "\n";

      this.dropped = 0;

      // 核对包含完整输入和复核读数；合法中文内容需要比普通事件更大的单行额度。
      if (utf8ByteLength(line) > (type === "goal_check" ? GOAL_CHECK_LINE_MAX_BYTES : LINE_MAX_BYTES)) {
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision, turn: correlation.turn,
          type, toolCallId: data.toolCallId, truncated: true, originalBytes: utf8ByteLength(line), reason: "record size limit" }) + "\n";
      }

      if (this.bytes + utf8ByteLength(line) > this.maxBytes) {
        this.closed = true;
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision,
          type: "trace_limit", truncated: true, reason: "session byte limit; subsequent events omitted" }) + "\n";
      }

      this.bytes += utf8ByteLength(line);
      this.queued++;
      this.queue = this.queue.then(async () => {
        if (!this.prepared) {
          await this.sink.prepare();
          this.prepared = true;
        }

        await this.sink.append(line);
      }).catch(() => { /* Diagnostics must never interrupt the task. */ }).finally(() => { this.queued--; });
    } catch { /* Circular or unexpected provider payload: ignore diagnostics only. */ }
  }

  flush(): Promise<void> { return this.queue; }
}
