export interface StreamingTailRepair {
  keptLength: number;
  suffix: string;
  text: string;
  insideFence: boolean;
  insideMath: boolean;
}

interface LineSpan {
  start: number;
  end: number;
}

interface OpenFence {
  char: string;
  length: number;
  openLineStart: number;
}

type Opener =
  | { kind: "delim"; char: string; count: number; pos: number }
  | { kind: "bracket"; pos: number; isImage: boolean };

const MARKER_CHARS = new Set([..."#-=*+_>|`~:[]"]);

const CJK_CHAR = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

const PUNCT_CHAR = /[\p{P}\p{S}]/u;

const TRAILING_TAG_OR_REF = /(?:<(?:c(?:a(?:r(?:d)?)?)?|a(?:p(?:p)?)?|u(?:i)?|d(?:i(?:a(?:g(?:r(?:a(?:m)?)?)?)?)?)?)?|\{=[\w-]*)$/;

const isSpaceOrTab = (ch: string) => ch === " " || ch === "\t";

const isWhitespace = (ch: string | undefined) =>
  ch === undefined || ch === " " || ch === "\t" || ch === "\n" || ch === "\r";

function isBlank(src: string, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    const ch = src[i]!;

    if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }

  return true;
}

function leadingSpaces(src: string, start: number, end: number): number {
  let i = start;

  while (i < end && isSpaceOrTab(src[i]!)) i += 1;

  return i - start;
}

function runLength(src: string, ch: string, start: number, end: number): number {
  let i = start;

  while (i < end && src[i] === ch) i += 1;

  return i - start;
}

function splitLines(src: string): LineSpan[] {
  const lines: LineSpan[] = [];
  let start = 0;

  for (let i = 0; i < src.length; i += 1) {
    if (src[i] === "\n") {
      lines.push({ start, end: i });
      start = i + 1;
    }
  }

  if (start < src.length) lines.push({ start, end: src.length });

  return lines;
}

function parseFenceOpen(src: string, start: number, end: number): { char: string; length: number } | null {
  const spaces = leadingSpaces(src, start, end);

  if (spaces > 3) return null;
  const idx = start + spaces;

  if (idx >= end) return null;
  const ch = src[idx]!;

  if (ch !== "`" && ch !== "~") return null;
  const len = runLength(src, ch, idx, end);

  if (len < 3) return null;
  if (ch === "`" && src.slice(idx + len, end).includes("`")) return null;

  return { char: ch, length: len };
}

function isFenceClose(src: string, start: number, end: number, fence: OpenFence): boolean {
  const spaces = leadingSpaces(src, start, end);

  if (spaces > 3) return false;
  const idx = start + spaces;

  if (idx >= end || src[idx] !== fence.char) return false;
  const len = runLength(src, fence.char, idx, end);

  return len >= fence.length && isBlank(src, idx + len, end);
}

function isPartialFenceClose(src: string, start: number, end: number, fence: OpenFence): boolean {
  const spaces = leadingSpaces(src, start, end);

  if (spaces > 3) return false;
  const idx = start + spaces;

  if (idx >= end || src[idx] !== fence.char) return false;
  const len = runLength(src, fence.char, idx, end);

  return len >= 1 && isBlank(src, idx + len, end);
}

function countDoubleDollars(src: string, start: number, end: number): number {
  let count = 0;
  let i = start;

  while (i + 1 < end) {
    if (src[i] === "\\") i += 2;
    else if (src[i] === "$" && src[i + 1] === "$") { count += 1; i += 2; }
    else i += 1;
  }

  return count;
}

function listMarkerEnd(src: string, idx: number, end: number): number | null {
  const ch = src[idx];

  if (ch === "-" || ch === "+" || ch === "*") return idx + 1 < end && isSpaceOrTab(src[idx + 1]!) ? idx + 2 : null;
  if (!ch || ch < "0" || ch > "9") return null;
  let i = idx;

  while (i < end && src[i]! >= "0" && src[i]! <= "9" && i - idx < 9) i += 1;

  return i + 1 < end && (src[i] === "." || src[i] === ")") && isSpaceOrTab(src[i + 1]!) ? i + 2 : null;
}

function contentStart(src: string, start: number, end: number): number {
  let i = start;

  while (i < end) {
    if (isSpaceOrTab(src[i]!) || src[i] === ">") { i += 1; continue; }
    const next = listMarkerEnd(src, i, end);

    if (next !== null) { i = next; continue; }
    break;
  }

  return i;
}

function isAtxHeading(src: string, start: number, end: number): boolean {
  const spaces = leadingSpaces(src, start, end);

  if (spaces > 3) return false;
  const idx = start + spaces;
  const hashes = runLength(src, "#", idx, end);

  return hashes >= 1 && hashes <= 6 && (idx + hashes === end || isSpaceOrTab(src[idx + hashes]!));
}

function countPipes(src: string, start: number, end: number): number {
  let pipes = 0;

  for (let i = start; i < end; i += 1) {
    if (src[i] === "\\") { i += 1; continue; }
    if (src[i] === "|") pipes += 1;
  }

  return pipes;
}

function isPipeRow(src: string, start: number, end: number): boolean {
  const idx = start + leadingSpaces(src, start, end);

  return idx < end && src[idx] === "|" && countPipes(src, idx, end) >= 2;
}

function tableColumnCount(src: string, start: number, end: number): number {
  const idx = start + leadingSpaces(src, start, end);
  const pipes = countPipes(src, idx, end);
  let trimEnd = end;

  while (trimEnd > idx && (isSpaceOrTab(src[trimEnd - 1]!) || src[trimEnd - 1] === "\r")) trimEnd -= 1;

  return Math.max(1, trimEnd > idx && src[trimEnd - 1] === "|" ? pipes - 1 : pipes);
}

function isDelimiterRow(src: string, start: number, end: number): boolean {
  let sawDash = false;
  let sawPipe = false;

  for (let i = start; i < end; i += 1) {
    const ch = src[i]!;

    if (ch === "-") sawDash = true;
    else if (ch === "|") sawPipe = true;
    else if (ch !== ":" && ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }

  return sawDash || sawPipe;
}

function isCompleteDelimiterRow(src: string, start: number, end: number, expectedCols: number): boolean {
  if (!isDelimiterRow(src, start, end)) return false;
  const cells = src.slice(start, end).trim().replace(/^\|/, "").replace(/\|$/, "").split("|");

  return cells.length >= expectedCols && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function startsBlock(src: string, start: number, end: number): boolean {
  return contentStart(src, start, end) !== start + leadingSpaces(src, start, end)
    || isAtxHeading(src, start, end)
    || isPipeRow(src, start, end);
}

function isMarkerOnly(src: string, start: number, end: number): boolean {
  if (isBlank(src, start, end)) return false;
  const lead = start + leadingSpaces(src, start, end);
  let sawMarker = false;
  let i = start;

  while (i < end) {
    const ch = src[i]!;

    if (ch === " " || ch === "\t" || ch === "\r") { i += 1; continue; }
    if (MARKER_CHARS.has(ch)) { sawMarker = true; i += 1; continue; }
    if ((ch === "x" || ch === "X") && i > start && src[i - 1] === "[") { i += 1; continue; }
    if (ch >= "0" && ch <= "9") {
      let numEnd = i;

      while (numEnd < end && src[numEnd]! >= "0" && src[numEnd]! <= "9") numEnd += 1;
      if (numEnd - i > 9) return false;
      if (numEnd === end ? i !== lead : src[numEnd] !== "." && src[numEnd] !== ")") return false;
      sawMarker = true;
      i = Math.min(numEnd + 1, end);
      continue;
    }

    return false;
  }

  return sawMarker;
}

function charClass(ch: string | undefined): "ws" | "punct" | "other" {
  if (isWhitespace(ch)) return "ws";

  return PUNCT_CHAR.test(ch!) ? "punct" : "other";
}

function closeDelimiter(char: string, run: number, stack: Opener[]): boolean {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const op = stack[i]!;

    if (op.kind !== "delim" || op.char !== char) continue;
    if (op.count === run) { stack.splice(i, 1); return true; }
    if (char === "*" && op.count > run) { op.count -= run; return true; }
  }

  return false;
}

function findMatchingBackticks(src: string, run: number, from: number, end: number): number {
  let pos = from;

  while (pos < end) {
    if (src[pos] === "`") {
      const r = runLength(src, "`", pos, end);

      if (r === run) return pos;
      pos += r;
    } else pos += 1;
  }

  return -1;
}

function findInlineDollarClose(src: string, from: number, end: number): number {
  for (let k = from; k < end; k += 1) {
    if (src[k] === "\\") { k += 1; continue; }
    if (src[k] === "\n") return -1;
    if (src[k] === "$" && !isWhitespace(src[k - 1])) return k;
  }

  return -1;
}

function stepDelimiter(
  src: string,
  start: number,
  end: number,
  scopeStart: number,
  lastLineStart: number,
  stack: Opener[],
): { next: number; stop: boolean; keep?: number } {
  const ch = src[start]!;
  const run = runLength(src, ch, start, end);
  const next = start + run;
  const prevChar = start > scopeStart ? src[start - 1] : undefined;
  const before = charClass(prevChar);

  if (next >= end) {
    if (before !== "ws" && closeDelimiter(ch, run, stack)) return { next, stop: false };
    // WHY: Chinese prose places `**` or `~~` directly after ideographs without a space, so trailing delimiters after CJK must also be held back to avoid raw-marker flicker.
    const canHold = before !== "other" || (prevChar !== undefined && CJK_CHAR.test(prevChar));

    if (canHold && start >= lastLineStart) return { next, stop: true, keep: start };

    return { next, stop: false };
  }

  const after = charClass(src[next]);
  const leftFlanking = after !== "ws" && (after !== "punct" || before === "ws" || before === "punct" || ch === "*");
  const rightFlanking = before !== "ws" && (before !== "punct" || after === "ws" || after === "punct" || ch === "*");
  const canClose = ch === "_" ? rightFlanking && (!leftFlanking || after === "punct") : rightFlanking;
  const canOpen = ch === "_" ? leftFlanking && (!rightFlanking || before === "punct") : leftFlanking;

  if (canClose && closeDelimiter(ch, run, stack)) return { next, stop: false };
  if (canOpen && (ch !== "~" || run === 2)) {
    stack.push({ kind: "delim", char: ch, count: ch === "*" ? Math.min(run, 3) : Math.min(run, 2), pos: start });
  }

  return { next, stop: false };
}

function stepCloseBracket(
  src: string,
  at: number,
  end: number,
  lastLineStart: number,
  stack: Opener[],
): { next: number; stop: boolean; keep?: number; closer?: string } {
  let matched = -1;

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    if (stack[k]!.kind === "bracket") { matched = k; break; }
  }

  if (matched < 0) return { next: at + 1, stop: false };
  const bracket = stack[matched] as Extract<Opener, { kind: "bracket" }>;

  stack.splice(matched);
  if (at + 1 < end && src[at + 1] === "(") {
    const closeParen = src.indexOf(")", at + 2);

    if (closeParen >= 0 && closeParen < end) return { next: closeParen + 1, stop: false };
    if (bracket.isImage) return { next: end, stop: true, keep: bracket.pos };
    if (bracket.pos >= lastLineStart) return { next: end, stop: true, closer: ")" };
  } else if (bracket.isImage && at + 1 === end && bracket.pos >= lastLineStart) {
    return { next: end, stop: true, keep: bracket.pos };
  }

  return { next: at + 1, stop: false };
}

interface InlineStep {
  next: number;
  stop: boolean;
  keep?: number;
  closer?: string;
}

function stepBackslash(src: string, i: number, end: number): InlineStep {
  if (i + 1 >= end) return { next: end, stop: true, keep: i };
  const next = src[i + 1]!;

  if (next === "(" || next === "[") {
    const closeAt = src.indexOf(next === "(" ? "\\)" : "\\]", i + 2);

    return closeAt < 0 || closeAt >= end ? { next: end, stop: true } : { next: closeAt + 2, stop: false };
  }

  return { next: i + 2, stop: false };
}

function stepDollar(src: string, i: number, end: number): InlineStep {
  if (i + 1 < end && src[i + 1] === "$") {
    const closeAt = src.indexOf("$$", i + 2);

    return closeAt < 0 || closeAt >= end ? { next: end, stop: true } : { next: closeAt + 2, stop: false };
  }
  if (i + 1 < end && !isWhitespace(src[i + 1]) && src[i + 1] !== "$") {
    const closeAt = findInlineDollarClose(src, i + 1, end);

    return closeAt < 0 ? { next: end, stop: true } : { next: closeAt + 1, stop: false };
  }

  return { next: i + 1, stop: false };
}

function stepBacktick(src: string, i: number, end: number, lastLineStart: number): InlineStep {
  const run = runLength(src, "`", i, end);
  const closeAt = findMatchingBackticks(src, run, i + run, end);

  if (closeAt >= 0) return { next: closeAt + run, stop: false };
  if (i + run === end && i >= lastLineStart) return { next: end, stop: true, keep: i };
  if (i >= lastLineStart && !isWhitespace(src[i + run])) return { next: end, stop: true, closer: "`".repeat(run) };

  return { next: i + run, stop: false };
}

function repairInlines(
  src: string,
  scopeStart: number,
  scopeEnd: number,
  lastLineStart: number,
  isTableRow: boolean,
): { keptLength: number; suffix: string } | null {
  let end = scopeEnd;

  while (end > scopeStart && (src[end - 1] === " " || src[end - 1] === "\t" || src[end - 1] === "\r")) end -= 1;
  const stack: Opener[] = [];
  let keep = end;
  let closer = "";
  let i = scopeStart;

  while (i < end) {
    const ch = src[i]!;
    let step: InlineStep | null = null;

    if (ch === "|" && isTableRow) { stack.length = 0; i += 1; continue; }
    if (ch === "\\") step = stepBackslash(src, i, end);
    else if (ch === "$") step = stepDollar(src, i, end);
    else if (ch === "`") step = stepBacktick(src, i, end, lastLineStart);
    else if (ch === "*" || ch === "_" || ch === "~") step = stepDelimiter(src, i, end, scopeStart, lastLineStart, stack);
    else if (ch === "]") step = stepCloseBracket(src, i, end, lastLineStart, stack);
    else if (ch === "!" && i + 1 < end && src[i + 1] === "[") { stack.push({ kind: "bracket", pos: i, isImage: true }); i += 2; continue; }
    else if (ch === "[") { stack.push({ kind: "bracket", pos: i, isImage: false }); i += 1; continue; }
    else if (ch === "<" && i >= lastLineStart && /^<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s[^>]*)?$/.test(src.slice(i, end))) { keep = i; break; }
    else { i += 1; continue; }

    if (step.keep !== undefined) keep = step.keep;
    if (step.closer) closer = step.closer;
    if (step.stop) break;
    i = step.next;
  }

  let suffix = closer;

  for (let k = stack.length - 1; k >= 0; k -= 1) {
    const op = stack[k]!;

    if (op.pos < lastLineStart) continue;
    if (op.kind === "bracket") {
      if (op.isImage) { keep = Math.min(keep, op.pos); suffix = ""; }
      continue;
    }
    if (op.pos < keep) suffix += op.char.repeat(op.count);
  }

  return keep === scopeEnd && !suffix ? null : { keptLength: keep, suffix };
}

function scanDocumentStructure(source: string, lines: LineSpan[]): {
  openFence: OpenFence | null;
  insideMath: boolean;
  lastBlockStartLine: number;
} {
  let openFence: OpenFence | null = null;
  let insideMath = false;
  let lastBlockStartLine = 0;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;

    if (openFence) {
      if (isFenceClose(source, line.start, line.end, openFence)) { openFence = null; lastBlockStartLine = idx + 1; }
      continue;
    }
    if (insideMath) {
      if (countDoubleDollars(source, line.start, line.end) % 2 === 1) { insideMath = false; lastBlockStartLine = idx + 1; }
      continue;
    }
    const fence = parseFenceOpen(source, line.start, line.end);

    if (fence) { openFence = { ...fence, openLineStart: line.start }; lastBlockStartLine = idx; continue; }
    if (countDoubleDollars(source, line.start, line.end) % 2 === 1) { insideMath = true; lastBlockStartLine = idx; continue; }
    if (isBlank(source, line.start, line.end)) { lastBlockStartLine = idx + 1; continue; }
    if (idx > lastBlockStartLine && startsBlock(source, line.start, line.end)) {
      const prev = lines[idx - 1]!;

      if (!(isPipeRow(source, line.start, line.end) && isPipeRow(source, prev.start, prev.end))) lastBlockStartLine = idx;
    }
  }

  return { openFence, insideMath, lastBlockStartLine };
}

function repairOpenFence(source: string, lastLine: LineSpan, openFence: OpenFence, endsWithNewline: boolean): StreamingTailRepair {
  if (!endsWithNewline && lastLine.start === openFence.openLineStart) {
    return { keptLength: openFence.openLineStart, suffix: "", text: source.slice(0, openFence.openLineStart), insideFence: true, insideMath: false };
  }
  if (!endsWithNewline && lastLine.start > openFence.openLineStart && isPartialFenceClose(source, lastLine.start, lastLine.end, openFence)) {
    const suffix = openFence.char.repeat(openFence.length);

    return { keptLength: lastLine.start, suffix, text: source.slice(0, lastLine.start) + suffix, insideFence: true, insideMath: false };
  }
  const suffix = (endsWithNewline ? "" : "\n") + openFence.char.repeat(openFence.length);

  return { keptLength: source.length, suffix, text: source + suffix, insideFence: true, insideMath: false };
}

function repairTableTail(source: string, lines: LineSpan[], blockStart: number, endsWithNewline: boolean): StreamingTailRepair | null {
  const first = lines[blockStart]!;

  if (!source.slice(first.start, first.end).trimStart().startsWith("|")) return null;
  if (lines.length === blockStart + 1 && !endsWithNewline) {
    return { keptLength: first.start, suffix: "", text: source.slice(0, first.start), insideFence: false, insideMath: false };
  }
  if (!isPipeRow(source, first.start, first.end)) return null;
  const cols = tableColumnCount(source, first.start, first.end);
  const synth = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;

  if (lines.length === blockStart + 1 && endsWithNewline) {
    return { keptLength: source.length, suffix: synth, text: source + synth, insideFence: false, insideMath: false };
  }
  if (lines.length === blockStart + 2 && !endsWithNewline) {
    const second = lines[blockStart + 1]!;

    if (isDelimiterRow(source, second.start, second.end) && !isCompleteDelimiterRow(source, second.start, second.end, cols)) {
      return { keptLength: second.start, suffix: synth, text: source.slice(0, second.start) + synth, insideFence: false, insideMath: false };
    }
  }

  return null;
}

export function repairStreamingTail(source: string): StreamingTailRepair {
  if (!source) return { keptLength: 0, suffix: "", text: "", insideFence: false, insideMath: false };
  const lines = splitLines(source);

  if (!lines.length) return { keptLength: source.length, suffix: "", text: source, insideFence: false, insideMath: false };
  const { openFence, insideMath, lastBlockStartLine } = scanDocumentStructure(source, lines);
  const lastLine = lines[lines.length - 1]!;
  const endsWithNewline = source.endsWith("\n");

  if (insideMath) return { keptLength: source.length, suffix: "", text: source, insideFence: false, insideMath: true };
  if (openFence) return repairOpenFence(source, lastLine, openFence, endsWithNewline);

  const tagOrRef = TRAILING_TAG_OR_REF.exec(source);

  if (tagOrRef && tagOrRef[0].length > 0) {
    return { keptLength: tagOrRef.index, suffix: "", text: source.slice(0, tagOrRef.index), insideFence: false, insideMath: false };
  }

  const blockStart = Math.min(lastBlockStartLine, lines.length - 1);
  const tableFix = repairTableTail(source, lines, blockStart, endsWithNewline);

  if (tableFix) return tableFix;
  if (!endsWithNewline && isMarkerOnly(source, lastLine.start, lastLine.end)) {
    return { keptLength: lastLine.start, suffix: "", text: source.slice(0, lastLine.start), insideFence: false, insideMath: false };
  }
  if (!endsWithNewline) {
    const inline = repairInlines(source, lines[blockStart]!.start, source.length, lastLine.start, isPipeRow(source, lastLine.start, lastLine.end));

    if (inline) {
      return { keptLength: inline.keptLength, suffix: inline.suffix, text: source.slice(0, inline.keptLength) + inline.suffix, insideFence: false, insideMath: false };
    }
  }

  return { keptLength: source.length, suffix: "", text: source, insideFence: false, insideMath: false };
}
