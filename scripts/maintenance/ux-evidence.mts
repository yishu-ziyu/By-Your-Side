export type Severity = "blocks" | "slows" | "awkward";
export type Evidence =
  | { kind: "trace"; line: number; quote: string }
  | { kind: "screen"; box: [number, number, number, number]; quote: string }
  | { kind: "timing"; field: "secs" | "checkSecs" | "totalSecs"; value: number };
export type Finding = { experience: string; severity: Severity; evidence: Evidence[] };
export type Box = [number, number, number, number];
export type ScreenLine = { box: Box; text: string };
export type Seen = { traceLines: string[]; screen: ScreenLine[]; timing: Record<"secs" | "checkSecs" | "totalSecs", number> };

export const SEVERITIES: readonly Severity[] = ["blocks", "slows", "awkward"];
const flat = (text: string) => text.replace(/\s+/g, " ").trim();
const quoted = (quote: unknown, source: string) => typeof quote === "string" && flat(quote).length >= 4 && flat(source).includes(flat(quote));
const bare = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "");

export function screenSpan(quote: string, screen: ScreenLine[]): Box | null {
  const want = bare(quote);
  if (want.length < 4) return null;
  const owners: number[] = [];
  const all = screen.map((line, i) => { const t = bare(line.text); owners.push(...Array.from(t, () => i)); return t; }).join("");
  const at = all.indexOf(want);
  if (at < 0) return null;
  const lines = screen.slice(owners[at], owners[at + want.length - 1]! + 1);
  const x = Math.min(...lines.map(l => l.box[0])), y = Math.min(...lines.map(l => l.box[1]));
  return [x, y, Math.max(...lines.map(l => l.box[0] + l.box[2])) - x, Math.max(...lines.map(l => l.box[1] + l.box[3])) - y];
}

const overlaps = (a: Box, b: Box) => a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3];

export function evidenceProblem(item: unknown, seen: Seen): string | null {
  if (!item || typeof item !== "object") return "证据不是对象";
  const e = item as Record<string, unknown>;

  if (e.kind === "trace") {
    const line = typeof e.line === "number" && Number.isInteger(e.line) ? seen.traceLines[e.line - 1] : undefined;
    if (line === undefined) return `诊断记录没有第 ${String(e.line)} 行`;
    return quoted(e.quote, line) ? null : `第 ${String(e.line)} 行里没有引用的原文`;
  }

  if (e.kind === "screen") {
    const box = e.box;
    const inside = Array.isArray(box) && box.length === 4 && box.every(v => typeof v === "number" && v >= 0 && v <= 1) && box[0] + box[2] <= 1.001 && box[1] + box[3] <= 1.001 && box[2] > 0 && box[3] > 0;
    if (!inside) return "截图位置不在画面里";
    const span = typeof e.quote === "string" ? screenSpan(e.quote, seen.screen) : null;
    if (!span) return "截图上认不出引用的文字";
    return overlaps(box as Box, span) ? null : "引用的文字不在标出的位置";
  }

  if (e.kind === "timing") {
    if (e.field !== "secs" && e.field !== "checkSecs" && e.field !== "totalSecs") return "不认识的用时字段";
    return seen.timing[e.field] === e.value ? null : `用时对不上：记录是 ${seen.timing[e.field]} 秒`;
  }

  return "不认识的证据类型";
}

export function sortFindings(raw: unknown, seen: Seen): { kept: Finding[]; dropped: Array<{ finding: unknown; why: string }> } {
  const kept: Finding[] = [];
  const dropped: Array<{ finding: unknown; why: string }> = [];

  for (const finding of Array.isArray(raw) ? raw : []) {
    const f = (finding ?? {}) as Record<string, unknown>;
    const why = typeof f.experience !== "string" || !f.experience.trim() ? "没写用户遇到什么"
      : !SEVERITIES.includes(f.severity as Severity) ? "严重程度不认识"
      : !Array.isArray(f.evidence) || !f.evidence.length ? "没有证据"
      : f.evidence.map(e => evidenceProblem(e, seen)).find(Boolean) ?? null;
    if (why) dropped.push({ finding, why });
    else kept.push(finding as Finding);
  }

  return { kept, dropped };
}
