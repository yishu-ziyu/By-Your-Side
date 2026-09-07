import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_KEY = /^(?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|set-cookie)$/i;
const SENSITIVE_TARGET = /password|passwd|pwd|secret|token|api[_-]?key|密码|口令/i;
const MAX_TEXT = 64_000;

function cleanText(text: string): string {
  return text
    .replace(/data:image\/[^;,\s]+;base64,[A-Za-z0-9+/=]+/g, "[image omitted]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:password|passwd|pwd|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|authorization|cookie|密码|口令)["']?\s*[:=：]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, "[redacted]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@");
}

/** Best-effort diagnostic redaction; arbitrary unlabelled secrets cannot be classified reliably. */
export function sanitizeTrace(value: unknown): unknown {
  const budget = { chars: 96_000, nodes: 1024 };
  function visit(value: unknown, depth = 0, redactInput = false): unknown {
    if (--budget.nodes < 0 || budget.chars <= 0) return "[truncated: shared budget]";
    if (depth > 12) return "[truncated: depth limit]";
    if (typeof value === "string") {
      const count = Math.min(value.length, MAX_TEXT, budget.chars);
      budget.chars -= count;
      const text = cleanText(value.slice(0, count));
      return count < value.length ? { text, truncated: true, originalChars: value.length } : text;
    }
    if (value instanceof Error) return visit({ name: value.name, message: value.message }, depth + 1);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      let count = 0;
      while (count < value.length && count < 256 && budget.nodes > 0 && budget.chars > 0) {
        items.push(visit(value[count++], depth + 1));
      }
      if (count < value.length) items.push({ truncated: true, omittedItems: value.length - count });
      return items;
    }
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    if (object.type === "image" || object.dataBase64 !== undefined || object.imageBase64 !== undefined) {
      const data = object.dataBase64 ?? object.imageBase64 ?? object.data;
      // 图片只留长度；截图元数据按白名单保留（A1 模型可核对与日志证据），字符串走 visit 脱敏。
      const meta: Record<string, unknown> = {};
      for (const key of ["width", "height", "pixelWidth", "pixelHeight", "cssWidth", "cssHeight", "devicePixelRatio", "tabId", "url", "title", "source", "capturedAt"]) {
        const v = object[key];
        if (typeof v === "number" && Number.isFinite(v)) meta[key] = v;
        else if (typeof v === "string" && v) meta[key] = visit(v, depth + 1);
      }
      return { type: "image", mimeType: visit(object.mimeType ?? object.mediaType, depth + 1), base64Chars: typeof data === "string" ? data.length : undefined, omitted: true, ...meta };
    }
    const target = object.target ?? object.selector;
    const sensitive = typeof target === "string" && SENSITIVE_TARGET.test(target.slice(0, 1024));
    const inputTool = /^(fill|type_text|browser_run)$/.test(String(object.toolName ?? object.name ?? ""));
    const result: Record<string, unknown> = Object.create(null);
    let count = 0;
    for (const key in object) {
      if (!Object.hasOwn(object, key)) continue;
      if (count++ >= 256 || budget.nodes <= 0 || budget.chars <= 0) {
        result.traceTruncation = { truncated: true, reason: "shared budget or object entry limit" };
        break;
      }
      const safeKey = cleanText(key.slice(0, Math.min(256, budget.chars)));
      budget.chars -= safeKey.length;
      result[safeKey] = SECRET_KEY.test(key) || key === "signature" ||
        ((sensitive || redactInput) && /^(text|value|code)$/.test(key))
        ? "[redacted]" : visit(object[key], depth + 1, inputTool && /^(args|arguments|params)$/.test(key));
      if (safeKey.length < key.length) result.traceTruncation = { truncated: true, reason: "key length limit" };
    }
    return result;
  }
  return visit(value);
}

export class RunTrace {
  readonly sessionId = randomUUID();
  readonly path: string;
  private runId: string | null = null;
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

  constructor(private readonly directory = join(homedir(), ".sideagent", "traces"), private readonly maxBytes = 8 * 1024 * 1024) {
    this.path = join(directory, `${Date.now()}-${this.sessionId}.jsonl`);
  }

  begin(text: string, context: unknown, model: unknown): void {
    this.runId = randomUUID();
    this.turn = 0;
    this.started = Date.now();
    this.tools.clear();
    this.record("run_start", { text, context, model });
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
    if (this.closed) return;
    if (this.queued >= 128) { this.dropped++; return; }
    try {
      let line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: this.runId, turn: this.turn,
        type, data: sanitizeTrace(data), ...(this.dropped ? { droppedEvents: this.dropped } : {}) }) + "\n";
      this.dropped = 0;
      if (Buffer.byteLength(line) > 256 * 1024) {
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: this.runId, turn: this.turn,
          type, toolCallId: data.toolCallId, truncated: true, originalBytes: Buffer.byteLength(line), reason: "record size limit" }) + "\n";
      }
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes) {
        this.closed = true;
        line = JSON.stringify({ time: new Date().toISOString(), sessionId: this.sessionId, runId: this.runId,
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
