import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { dataDir } from "./config.js";

export { sanitizeTrace } from "./trace-sanitize.js";

import { sanitizeTrace } from "./trace-sanitize.js";

export class RunTrace {
  readonly sessionId = randomUUID();
  readonly path: string;
  private runId: string | null = null;
  private goalRevision: string | null = null;
  private turn = 0;
  private started = 0;
  private turnStarted = 0;
  private firstResponse = false;
  private tools = new Map<string, number>();
  private queue = Promise.resolve();
  private initialized = false;
  private bytes = 0;
  private queued = 0;
  private closed = false;
  private dropped = 0;

  constructor(private readonly directory = process.env.SIDEAGENT_TRACE_DIR || join(dataDir(), "traces"), private readonly maxBytes = 8 * 1024 * 1024) {
    this.path = join(directory, `${Date.now()}-${this.sessionId}.jsonl`);
  }

  begin(text: string, context: unknown, model: unknown, correlation?: { runId?: string | null; goalRevision?: string | null }): void {
    this.runId = correlation?.runId ?? randomUUID();
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
    const stageId = randomUUID();
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

  private write(
    type: string,
    data: Record<string, unknown>,
    correlation: { runId: string | null; goalRevision: string | null; turn: number },
  ): void {
    if (this.closed) return;

    if (this.queued >= 128) { this.dropped++;

 return; }

    try {
      const droppedPiece = this.dropped ? { droppedEvents: this.dropped } : {};
      const trace = { time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision, turn: correlation.turn, type, data: sanitizeTrace(data), ...droppedPiece };
      let line = JSON.stringify(trace) + "\n";

      this.dropped = 0;

      if (Buffer.byteLength(line) > 256 * 1024) {
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision, turn: correlation.turn,
          type, toolCallId: data.toolCallId, truncated: true, originalBytes: Buffer.byteLength(line), reason: "record size limit" }) + "\n";
      }

      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        this.closed = true;
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: correlation.runId, goalRevision: correlation.goalRevision,
          type: "trace_limit", truncated: true, reason: "session byte limit; subsequent events omitted" }) + "\n";
      }

      this.bytes += Buffer.byteLength(line);
      this.queued++;
      this.queue = this.queue.then(async () => {
        if (!this.initialized) {
          await mkdir(this.directory, { recursive: true, mode: 0o700 });
          await chmod(this.directory, 0o700);
          const files = (await readdir(this.directory)).filter((name) => /^\d+-[a-f0-9-]+\.jsonl$/.test(name)).sort();
          await Promise.all(files.slice(0, Math.max(0, files.length - 19)).map((name) => unlink(join(this.directory, name)).catch(() => {})));
          this.initialized = true;
        }

        await appendFile(this.path, line, { mode: 0o600 });
      }).catch(() => { /* Diagnostics must never interrupt the task. */ }).finally(() => { this.queued--; });
    } catch { /* Circular or unexpected provider payload: ignore diagnostics only. */ }
  }

  flush(): Promise<void> { return this.queue; }
}
