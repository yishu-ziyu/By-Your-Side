import type { AgentUiEvent } from "../../shared/protocol.js";
import { toolAction } from "../../shared/user-facing.js";
import { asksUser, GOAL_CHECK_BOOKKEEPING_TOOLS } from "./goal-check.js";
import { parseCsvRecords } from "./csv-total.js";

/** 确定性回执核对；不调用模型，也不拦交付。 */
export interface RunStep { tool: string; ok: boolean; params: Record<string, unknown> }

function callKey(step: RunStep): string {
  return JSON.stringify([step.tool, step.params], (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    }
    return value;
  });
}

export class RunStepLog {
  private runId: string | null = null;
  private items: RunStep[] = [];
  private programParents = new Set<string>();
  private failedProgramParents = new Set<string>();
  private truncated = false;

  resetFor(runId: string | null): void {
    if (this.runId === runId) return;
    this.runId = runId; this.items = []; this.programParents.clear(); this.failedProgramParents.clear(); this.truncated = false;
  }

  /** 被拦下的重复、用户没让发送（不发、停、离开、超时）都没有执行，不算失败的一步。 */
  note(runId: string | null, tool: string, isError: boolean, repeatRefused: boolean, sendDeclined: boolean, params: Record<string, unknown>, parentId?: string): void {
    if (repeatRefused || sendDeclined || GOAL_CHECK_BOOKKEEPING_TOOLS.has(tool)) return;
    this.resetFor(runId);
    if (parentId) { this.programParents.add(parentId); if (isError) this.failedProgramParents.add(parentId); }
    this.items.push({ tool, ok: !isError, params });
    if (this.items.length > 399) { this.truncated = true; this.items.shift(); }
  }

  forgetProgram(parentId: string): void { this.programParents.delete(parentId); this.failedProgramParents.delete(parentId); }
  hasProgramFailure(parentId: string): boolean { return this.failedProgramParents.has(parentId); }
  hasProgramSteps(parentId: string): boolean { return this.programParents.has(parentId); }
  of(runId: string | null): RunStep[] {
    if (this.runId !== runId) return [];
    // 丢弃的记录不能证明失败已披露；保守地让本条核对不通过。
    return this.truncated ? [{ tool: "截断的步骤记录", ok: false, params: {} }, ...this.items] : this.items;
  }
}

export interface RefereeInput {
  steps: RunStep[];
  reply: string;
  fileCount: number;
  files: Array<{ filename: string; content?: string }>;
  newFileCount: number;
  goal: string[];
}
export type RunCheckEvent = Extract<AgentUiEvent, { kind: "run_check" }>;
const SENTENCE_SPLIT = /[。！？!?\n；;]/;
const FAILURE = /失败|没能|未能|没成功|出错|报错|打不开|没打开|连不上|无法|超时|不可用|\bfailed\b|cannot|unable to|timed out|blocked/i;
const SAVE_VERB = /保存|存成|存为|存下|save/i;
const SAVE_NEGATED = /(不用|别|不要|无需|不必)\s?(保存|存成|存为|存下|save)/i;
const SAVE_CONTENT = /存成|存为|文件|表格|数据|字幕|内容|下来|成\s?(csv|md|json|txt)/i;

/** 只认可同动作同参数的成功重试，或同一句明确指出该动作及目标失败。含糊的承认不豁免其他失败。 */
function failuresAccountedFor(steps: RunStep[], reply: string): boolean {
  const sentences = reply.split(SENTENCE_SPLIT);
  return steps.every((step, index) => {
    if (step.ok || steps.slice(index + 1).some(later => later.ok && callKey(later) === callKey(step))) return true;
    const targets = ["url", "target", "selector", "filename"].flatMap(key => typeof step.params[key] === "string" ? [step.params[key] as string] : []);
    return sentences.some(sentence => FAILURE.test(sentence)
      && (sentence.includes(step.tool) || sentence.includes(toolAction(step.tool)))
      && targets.every(target => sentence.includes(target)));
  });
}

const SMALL_COUNTS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function numericCount(text: string): number | null {
  return /^\d+$/.test(text) ? Number(text) : SMALL_COUNTS[text] ?? null;
}

/** 记录数只在结构确定时计算；CSV 不用物理换行，JSON 不用排版行数。 */
function recordsIn(file: { filename: string; content?: string }, unit: string, sentence: string): number | null {
  if (file.content === undefined) return null;
  const text = file.content;
  const lines = text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (unit === "行") return lines.length;
  if (/\.csv$/i.test(file.filename)) {
    const rows = parseCsvRecords(text);
    if (!rows || !rows.length || rows.some(row => row.length !== rows[0]!.length)) return null;
    const excludeHeader = /不含表头|去掉表头|除去表头/.test(sentence);
    return Math.max(0, rows.length - (excludeHeader ? 1 : 0));
  }
  if (/\.json$/i.test(file.filename)) {
    try { const value: unknown = JSON.parse(text); return Array.isArray(value) ? value.length : null; }
    catch { return null; }
  }
  if (/\.txt$/i.test(file.filename) && lines.every(line => line.trim() && !/-->/.test(line))) return lines.length;
  return null;
}

/**
 * 核对文件个数与明确归属的行／条数；多个未点名文件不猜对象。
 * stated：回复里说了能对照的数（文件个数、文件条数、改动处数）；没说时这条核对不适用。
 */
function countCheck(reply: string, fileCount: number, files: RefereeInput["files"]): { stated: boolean; note: string | null } {
  let stated = false;

  for (const sentence of reply.split(SENTENCE_SPLIT)) {
    if (/保存|生成|存下|导出/.test(sentence)) {
      const match = /(\d+|[一二三四五六七八九十两百千万]+)\s*[个份]文件/.exec(sentence);
      const claimed = match ? numericCount(match[1]!) : null;
      if (match) stated = true;
      if (match && claimed === null) return { stated, note: "回复中的文件个数暂无可核对记录" };
      if (claimed !== null && claimed !== fileCount) return { stated, note: `回复说 ${claimed} 个文件，本任务记录了 ${fileCount} 个文件` };
    }
    const named = files.filter(file => sentence.includes(file.filename));
    if (named.length || /文件|字幕|保存|存成|存为/.test(sentence)) {
      const candidates = named.length ? named : files;
      for (const match of sentence.matchAll(/(\d+|[一二三四五六七八九十两百千万]+)\s*([条行])/g)) {
        if (/第\s*$/.test(sentence.slice(0, match.index))) continue;
        stated = true;
        if (candidates.length !== 1) return { stated, note: "回复中的文件条数暂无可核对记录" };
        const claimed = numericCount(match[1]!), file = candidates[0]!;
        const actual = recordsIn(file, match[2]!, sentence);
        if (claimed === null || actual === null) return { stated, note: "回复中的文件条数暂无可核对记录" };
        if (claimed !== actual) return { stated, note: `回复说 ${claimed} ${match[2]}，文件 ${file.filename} 有 ${actual} ${match[2]}` };
      }
    }
    // 成功工具调用数不等于实际改动处数；没有权威记录时不可冒充核对通过。
    if (/\d+\s*处(?:改动|修改)|(?:改动|修改)(?:了)?\s*\d+\s*处/.test(sentence)) return { stated: true, note: "回复中的改动处数暂无可核对记录" };
  }
  return { stated, note: null };
}

/**
 * 只数这一轮适用的核对（docs/evals/20261009-claim-after-check.md R4）：有一步失败才核对「失败说了没有」，
 * 回复说了数才核对数，用户要求保存才核对保存。一项都不适用时返回 null，侧栏不显示核对行。
 */
export function refereeRun(input: RefereeInput): RunCheckEvent | null {
  const notes: string[] = [];
  let total = 0;
  if (input.steps.some(step => !step.ok)) {
    total += 1;
    if (!failuresAccountedFor(input.steps, input.reply)) notes.push("有一步失败没说");
  }
  const count = countCheck(input.reply, input.fileCount, input.files);
  if (count.stated) total += 1;
  if (count.note) notes.push(count.note);
  const saveRequested = input.goal.some(text => text.split(SENTENCE_SPLIT).some(sentence => SAVE_VERB.test(sentence) && !SAVE_NEGATED.test(sentence) && SAVE_CONTENT.test(sentence)));
  if (saveRequested && !asksUser(input.reply)) {
    total += 1;
    if (input.newFileCount !== 1) notes.push(`要求保存，但新增了 ${input.newFileCount} 个文件`);
  }
  return total ? { kind: "run_check", passed: total - notes.length, total, notes } : null;
}
