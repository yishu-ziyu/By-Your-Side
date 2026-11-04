import { utf8ByteLength } from "./bytes.js";
import { sanitizeTraceForStore } from "./trace-sanitize.js";

const TRACE_SESSIONS_KEPT = 20;

export const TRACE_MAX_AGE_DAYS = 30;

export function expiredSessions(older: readonly string[], now = Date.now()): string[] {
  const sorted = [...older].sort();
  const cutoff = now - TRACE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;

  return sorted.slice(0, Math.max(0, sorted.length - (TRACE_SESSIONS_KEPT - 1))).filter((name) => {
    const started = Number(/^(\d+)-/.exec(name)?.[1]);

    return !Number.isFinite(started) || started < cutoff;
  });
}

const LINE_MAX_BYTES = 256 * 1024;
const GOAL_CHECK_LINE_MAX_BYTES = 2 * 1024 * 1024;

const QUEUE_MAX = 128;

export interface TraceSink {
  prepare(): Promise<void>;
  append(line: string): Promise<void>;
  savePrompt?(hash: string, text: string): Promise<void>;
}

export type TraceCorrelation = { runId: string | null; goalRevision: string | null; turn: number };

export class TraceRecorder {
  readonly sessionId = crypto.randomUUID();
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

  setRun(runId: string | null): void {
    this.runId = runId;
  }

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

  event(event: { type: string; [key: string]: unknown }): void {
    const now = Date.now();

    if (event.type === "message_update") {
      if (!this.firstResponse) {
        this.firstResponse = true;
        this.record("first_response", { elapsedMs: now - this.turnStarted });
      }

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

    if (event.type === "agent_end") {
      delete data.messages;
      data.elapsedMs = this.started ? now - this.started : undefined;
    }

    if (event.type === "turn_end") {
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
      }).catch(() => {  }).finally(() => { this.queued--; });
    } catch {  }
  }

  flush(): Promise<void> { return this.queue; }
}
