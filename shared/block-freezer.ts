export type StreamBlockKind = "markdown" | "code" | "table" | "card";

export interface StreamBlock {
  index: number;
  kind: StreamBlockKind;
  raw: string;
  start: number;
  end: number;
  frozen: boolean;
  hasRef: boolean;
}

export interface BlockSplitResult {
  blocks: StreamBlock[];
  frozenCount: number;
  frozenEnd: number;
}

function classifyBlock(raw: string): StreamBlockKind {
  const trimmed = raw.trimStart();

  if (/^<(?:card|app|ui)[\s>]|^<diagram>/.test(trimmed)) return "card";
  if (/^ {0,3}(?:```|~~~)/.test(trimmed)) return "code";
  if (/^\|.+\|\s*\n\s*\|[\s:|-]+\|/.test(trimmed)) return "table";

  return "markdown";
}

function isFenceOpenLine(line: string): { char: string; len: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);

  if (!match) return null;
  const token = match[1]!;

  if (token[0] === "`" && line.slice(match[0].length).includes("`")) return null;

  return { char: token[0]!, len: token.length };
}

function isFenceCloseLine(line: string, fence: { char: string; len: number }): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*\r?$/.exec(line);

  return Boolean(match && match[1]![0] === fence.char && match[1]!.length >= fence.len);
}

function customBlockEnd(source: string, at: number, tag: string): number {
  const closeTag = `</${tag}>`;
  const closeAt = source.indexOf(closeTag, at);

  if (closeAt < 0) return -1;
  let end = closeAt + closeTag.length;

  if (tag === "diagram") {
    for (;;) {
      const cite = /^\s*<cite\b[^>]*?(?:\/>|>[\s\S]*?<\/cite>)/.exec(source.slice(end));

      if (cite) { end += cite[0].length; continue; }
      const rest = source.slice(end);

      if (/^\s*<(?:c(?:i(?:t(?:e)?)?)?)?$|^\s*<cite\b/.test(rest) && /\S/.test(rest)) return -1;
      break;
    }
  }

  return end;
}

export class IncrementalBlockFreezer {
  private frozenBlocks: StreamBlock[] = [];
  private frozenEnd = 0;
  private lastSource = "";

  reset(): void {
    this.frozenBlocks = [];
    this.frozenEnd = 0;
    this.lastSource = "";
  }

  update(source: string, final: boolean): BlockSplitResult {
    if (!source.startsWith(this.lastSource.slice(0, this.frozenEnd))) {
      let keep = 0;

      while (keep < this.frozenBlocks.length && source.startsWith(this.frozenBlocks[keep]!.raw, this.frozenBlocks[keep]!.start)) {
        keep += 1;
      }
      this.frozenBlocks.length = keep;
      this.frozenEnd = keep > 0 ? this.frozenBlocks[keep - 1]!.end : 0;
    }
    this.lastSource = source;

    for (const seg of this.scanNewBoundaries(source, this.frozenEnd)) {
      const raw = source.slice(seg.start, seg.end);

      if (!raw.trim()) { this.frozenEnd = seg.end; continue; }
      this.frozenBlocks.push({
        index: this.frozenBlocks.length,
        kind: classifyBlock(raw),
        raw,
        start: seg.start,
        end: seg.end,
        frozen: true,
        hasRef: raw.includes("{="),
      });
      this.frozenEnd = seg.end;
    }

    const blocks: StreamBlock[] = [...this.frozenBlocks];
    const tailRaw = source.slice(this.frozenEnd);

    if (tailRaw.trim().length > 0) {
      blocks.push({
        index: blocks.length,
        kind: classifyBlock(tailRaw),
        raw: tailRaw,
        start: this.frozenEnd,
        end: source.length,
        frozen: final,
        hasRef: tailRaw.includes("{="),
      });
    }

    if (final && tailRaw.trim().length > 0) {
      this.frozenBlocks = blocks;
      this.frozenEnd = source.length;
    }

    return { blocks, frozenCount: this.frozenBlocks.length, frozenEnd: this.frozenEnd };
  }

  private scanNewBoundaries(source: string, from: number): Array<{ start: number; end: number }> {
    const out: Array<{ start: number; end: number }> = [];
    let blockStart = from;
    let i = from;
    let fence: { char: string; len: number } | null = null;
    let inMath = false;

    while (i < source.length) {
      if (!fence && !inMath) {
        const tagMatch = /^<(card|app|ui)(?=[\s>])|^<diagram>/.exec(source.slice(i));

        if (tagMatch) {
          if (i > blockStart && source.slice(blockStart, i).trim()) { out.push({ start: blockStart, end: i }); blockStart = i; }
          const endPos = customBlockEnd(source, i + tagMatch[0].length, tagMatch[1] ?? "diagram");

          if (endPos < 0) break;
          out.push({ start: blockStart, end: endPos });
          blockStart = endPos;
          i = endPos;
          continue;
        }
      }

      const nl = source.indexOf("\n", i);

      if (nl < 0) break;
      const line = source.slice(i, nl);
      const nextPos = nl + 1;

      if (fence) {
        if (isFenceCloseLine(line, fence)) { fence = null; out.push({ start: blockStart, end: nextPos }); blockStart = nextPos; }
        i = nextPos;
        continue;
      }
      if (inMath) {
        if ((line.match(/\$\$/g) ?? []).length % 2 === 1) { inMath = false; out.push({ start: blockStart, end: nextPos }); blockStart = nextPos; }
        i = nextPos;
        continue;
      }

      const opened = isFenceOpenLine(line);

      if (opened) {
        if (i > blockStart && source.slice(blockStart, i).trim()) { out.push({ start: blockStart, end: i }); blockStart = i; }
        fence = opened;
        i = nextPos;
        continue;
      }
      if ((line.match(/\$\$/g) ?? []).length % 2 === 1) {
        if (i > blockStart && source.slice(blockStart, i).trim()) { out.push({ start: blockStart, end: i }); blockStart = i; }
        inMath = true;
        i = nextPos;
        continue;
      }
      if (line.trim() === "" && i > blockStart && source.slice(blockStart, i).trim()) {
        const afterBlank = source.slice(nextPos);

        if (afterBlank.length > 0 && !/^[ \t]+(?:\S|$)/.test(afterBlank)) {
          out.push({ start: blockStart, end: nextPos });
          blockStart = nextPos;
        }
      }
      i = nextPos;
    }

    return out;
  }
}
