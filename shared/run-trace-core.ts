/**
 * 诊断记录（run trace）的行格式与限额：本机伴随进程写文件，扩展内 agent 写 IndexedDB，行内容完全相同。
 * 每个会话一份记录，一行一个事件；只观察，不参与任何控制决定。
 */
import { utf8ByteLength } from "./bytes.js";
import { sanitizeTrace } from "./trace-sanitize.js";

/** 保留最近多少个会话的记录（新会话第一次写入时删掉更早的）。 */
export const TRACE_SESSIONS_KEPT = 20;

/** 单行上限；超过只留摘要。 */
const LINE_MAX_BYTES = 256 * 1024;

/** 写入排队上限；排满后丢事件并在下一行记数，诊断永远不拖慢任务。 */
const QUEUE_MAX = 128;

/** 一个会话的存储端：第一次写入前 prepare 一次（建目录、按保留数删旧会话），之后逐行追加。 */
export interface TraceSink {
  prepare(): Promise<void>;
  append(line: string): Promise<void>;
}

type Correlation = { runId: string | null; goalRevision: string | null; turn: number };

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
  private tools = new Map<string, number>();
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
    this.tools.clear();
    this.record("run_start", { text, context, model });
  }

  correlate(correlation: { runId?: string | null; goalRevision?: string | null }): void {
    if (correlation.runId) this.runId = correlation.runId;

    if (correlation.goalRevision) this.goalRevision = correlation.goalRevision;
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

      return;
    }

    if (event.type === "tool_execution_update") {
      // SAFETY: browser_run 的进度事件把 programStep 放在 partialResult.details 下；缺省时下面的判断落空。
      const partial = event.partialResult as { details?: { programStep?: unknown } } | undefined;

      if (event.toolName === "browser_run" && partial?.details?.programStep) {
        this.record("program_step", { parentToolCallId: event.toolCallId, step: partial.details.programStep });
      }

      return;
    }

    if (event.type === "turn_start") {
      this.turn++;
      this.turnStarted = now;
      this.firstResponse = false;
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

  record(type: string, data: Record<string, unknown> = {}): void {
    this.write(type, data, {
      runId: this.runId,
      goalRevision: this.goalRevision,
      turn: this.turn,
    });
  }

  private write(type: string, data: Record<string, unknown>, correlation: Correlation): void {
    if (this.closed) return;

    if (this.queued >= QUEUE_MAX) {
      this.dropped++;

      return;
    }

    try {
      const droppedPiece = this.dropped ? { droppedEvents: this.dropped } : {};
      const trace = { time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision, turn: correlation.turn, type, data: sanitizeTrace(data), ...droppedPiece };
      let line = JSON.stringify(trace) + "\n";

      this.dropped = 0;

      if (utf8ByteLength(line) > LINE_MAX_BYTES) {
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
