export type CopyTextRange = { unit: "sentence" | "paragraph"; first: number; count: number };

export function parseCopyTextRange(value: unknown): CopyTextRange | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const range = value as Record<string, unknown>;

  if (range.unit !== "sentence" && range.unit !== "paragraph") return null;
  if (typeof range.first !== "number" || !Number.isSafeInteger(range.first) || range.first === 0 || Math.abs(range.first) > 10_000) return null;
  if (typeof range.count !== "number" || !Number.isSafeInteger(range.count) || range.count < 1 || range.count > 1000) return null;

  return { unit: range.unit, first: range.first, count: range.count };
}

type TextSpan = { start: number; end: number };

function copyUnits(text: string, unit: CopyTextRange["unit"]): TextSpan[] {
  if (unit === "sentence") {
    return [...new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(text)]
      .filter(part => part.segment.trim())
      .map(part => ({ start: part.index, end: part.index + part.segment.length }));
  }

  const spans: TextSpan[] = [];
  let start = 0;

  for (const separator of text.matchAll(/\r?\n[^\S\r\n]*\r?\n(?:[^\S\r\n]*\r?\n)*/g)) {
    if (text.slice(start, separator.index).trim()) spans.push({ start, end: separator.index });
    start = separator.index + separator[0].length;
  }

  if (text.slice(start).trim()) spans.push({ start, end: text.length });

  return spans;
}

export function copyUnitCount(text: string, unit: CopyTextRange["unit"]): number {
  return copyUnits(text, unit).length;
}

export function selectCopyText(text: string, range: CopyTextRange): string {
  const parsed = parseCopyTextRange(range);

  if (!parsed) throw new Error("复制范围无效：unit 只能是 sentence 或 paragraph，first 是非零序号，count 是正整数。");
  const spans = copyUnits(text, parsed.unit);
  const start = parsed.first > 0 ? parsed.first - 1 : spans.length + parsed.first;
  const end = start + parsed.count - 1;
  const unitName = parsed.unit === "sentence" ? "句" : "段";

  if (start < 0 || start >= spans.length || end >= spans.length) {
    throw new Error(`复制范围越界：来源共有 ${spans.length} ${unitName}，无法从序号 ${parsed.first} 取 ${parsed.count} ${unitName}。请重新选择来源或指定正确的 from.range。`);
  }

  const selected = text.slice(spans[start]!.start, spans[end]!.end).trim();

  if (!selected) throw new Error("复制范围为空：请重新选择来源或指定正确的 from.range。");

  return selected;
}
