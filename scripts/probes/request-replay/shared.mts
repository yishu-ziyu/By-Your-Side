// Helpers shared by capture.mts and replay.mts: header redaction, image handling, SSE parsing, percentiles.
import { createHash } from "node:crypto";

/** Headers that carry credentials or identity; never written to disk or stdout. */
const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|chatgpt-account-id|x-api-key|api-key|openai-organization)$|token/i;

export function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !SECRET_HEADER.test(name)));
}

const DATA_URL = /^data:([^;,]+);base64,/;

/** Deep copy with every base64 data URL replaced by a hash + length marker; returns how many were replaced. */
export function redactImages<T>(value: T): { value: T; images: number } {
  let images = 0;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      const m = DATA_URL.exec(v);

      if (!m || v.length < 200) return v;
      images += 1;

      return `[base64 ${m[1]} sha256=${createHash("sha256").update(v).digest("hex").slice(0, 16)} chars=${v.length}]`;
    }

    if (Array.isArray(v)) return v.map(walk);

    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));

    return v;
  };

  return { value: walk(value) as T, images };
}

export type Body = Record<string, unknown> & { input?: unknown[]; tools?: Array<{ name?: string }>; instructions?: string; reasoning?: { effort?: string } };

/** Number of input_image parts anywhere in the request input (message content or tool outputs). */
export function imageCount(body: Body): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      if ((v as { type?: unknown }).type === "input_image") n += 1;
      Object.values(v).forEach(walk);
    }
  };

  walk(body.input);

  return n;
}

export const sha8 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 8);
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

export function purposeGuess(body: Body): string {
  const tools = body.tools?.length ?? 0;

  if (tools >= 8) return `main? (${tools} tools)`;

  if (tools === 0) return "side? (no tools)";

  return `side? (${body.tools!.map(t => t.name).join(",")})`;
}

/** Incremental SSE parser: feed decoded text, get back `type` of each complete `data:` event. */
export function sseParser() {
  let buffer = "";

  return (chunk: string): Array<{ type: string; data: Record<string, unknown> | null }> => {
    buffer += chunk;
    const events: Array<{ type: string; data: Record<string, unknown> | null }> = [];
    let cut: number;

    while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, "");
      const dataText = block.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).trimStart()).join("\n");
      const eventName = block.split(/\r?\n/).find(l => l.startsWith("event:"))?.slice(6).trim();

      if (!dataText) { if (eventName) events.push({ type: eventName, data: null }); continue; }

      if (dataText === "[DONE]") { events.push({ type: "[DONE]", data: null }); continue; }

      try {
        const data = JSON.parse(dataText) as Record<string, unknown>;
        events.push({ type: String(data.type ?? eventName ?? "unknown"), data });
      } catch { events.push({ type: eventName ?? "unparsed", data: null }); }
    }

    return events;
  };
}

/** Model output (not reasoning) starting to stream: text or tool-call arguments. */
export const isOutputDelta = (type: string) => type === "response.output_text.delta" || type === "response.function_call_arguments.delta";

export function usageOf(data: Record<string, unknown> | null) {
  const u = (data?.response as { usage?: Record<string, unknown> } | undefined)?.usage;

  if (!u) return null;
  const details = (k: string) => (u[k] as Record<string, number> | undefined) ?? {};

  return {
    input: Number(u.input_tokens ?? 0), cached: details("input_tokens_details").cached_tokens ?? 0,
    output: Number(u.output_tokens ?? 0), reasoning: details("output_tokens_details").reasoning_tokens ?? 0,
  };
}

export function pct(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);

  return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
}

export function markdownTable(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "(no rows)\n";
  const cols = Object.keys(rows[0]);
  const cell = (v: unknown) => (v === null || v === undefined ? "" : String(v)).replace(/\|/g, "\\|");

  return [`| ${cols.join(" | ")} |`, `| ${cols.map(() => "---").join(" | ")} |`, ...rows.map(r => `| ${cols.map(c => cell(r[c])).join(" | ")} |`)].join("\n") + "\n";
}

export const arg = (name: string): string | undefined => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
