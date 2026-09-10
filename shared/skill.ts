/**
 * 技能（示范编译出来的可复用条目）的结构与校验。
 *
 * 分工：
 *   - steps   —— 人话步骤，默认显示给用户，不出现坐标与 DOM 路径
 *   - check   —— 完成凭证，机器可复算（用与执行同一套语义解析）
 *   - program —— 可执行脚本（browser_run 的函数体），默认折叠，想看再点开
 *   - inputs  —— 示范时填进去的值被抽成可变输入，换材料时改这里
 */

export interface SkillAnchor {
  tag: string;
  role?: string;
  name?: string;
  inputType?: string;
}

export type SkillStepKind = "click" | "type" | "press";

export interface SkillStep {
  kind: SkillStepKind;
  anchor?: SkillAnchor;
  /** type 步骤：输入项的键名（对应 inputs），不是值本身 */
  inputKey?: string;
  key?: string;
  /** 示范时是敏感字段：值从未记录，卡片上说清楚，而不是显示一对空引号 */
  redacted?: true;
  /**
   * 弱步骤：示范里这一下没记到对象名（真机上视频卡这类裸 div）。
   * 运行期认不出来就跳过并记一笔，不因此让整个技能停摆。
   */
  weak?: true;
}

export interface SkillCheck {
  /** 结束时页面上必须还能找到这个对象，否则不算跑完 */
  marker?: SkillAnchor;
  /** 给人看的一句话 */
  text: string;
}

export interface Skill {
  id: string;
  name: string;
  intent: string;
  hostname: string;
  steps: SkillStep[];
  inputs: Record<string, string>;
  check: SkillCheck;
  program: string;
  version: number;
  createdAt: number;
  updatedAt: number;
  sourceDemoId: string;
  runCount: number;
  lastRunAt?: number;
  /** 示范里有几步没记到对象名，编译时丢掉了（卡片要如实说明） */
  droppedSteps?: number;
  /** 有几步是"弱步骤"：运行期认不出来就跳过，卡片要如实说明 */
  weakSteps?: number;
  /** 修订线索：用户说"这次不太对"时攒下来的话，下次重新示范时提醒 */
  notes?: Array<{ at: number; text: string }>;
}

/**
 * 一次运行的记录。技能"持续优化"的全部依据都来自这里：
 * 跑过几次、上次结果、上次停在哪一步。没有这一层，谈优化是空的。
 */
export interface SkillRun {
  at: number;
  ok: boolean;
  elapsedMs: number;
  steps: number;
  /** 失败时停在第几步（1 起算；拿不到就没有） */
  failedStep?: number;
  /** 失败原因一句话（页面变了 / 被接管 / 超时…） */
  error?: string;
  /** 弱步骤里认不出来、被跳过的第几步（1 起算） */
  skipped?: number[];
}

/** 卡片上的一句话事实，不解释、不美化。 */
export function skillRunSummary(runs: SkillRun[]): string {
  if (runs.length === 0) return "还没跑过";
  const last = runs[runs.length - 1]!;
  const seconds = Math.max(0.1, last.elapsedMs / 1000).toFixed(1);
  const head = last.ok ? `跑过 ${runs.length} 次 · 上次 ${seconds} 秒` : `跑过 ${runs.length} 次 · 上次失败`;
  const stalled = runs.filter(run => !run.ok && typeof run.failedStep === "number").length;
  return stalled > 0 ? `${head} · ${stalled} 次因为页面变了停下` : head;
}

/** 连续几次因"页面变了"停下就算可能过期（可调旋钮，不是教条）。 */
export const STALE_AFTER_STALLS = 3;

/**
 * 技能的健康度：只看证据。
 * 连续 STALE_AFTER_STALLS 次都因为"对象找不到"停下 → 可能过期：
 * 下次只提示、不直接跑，把选择权交回用户（重新示范 / 忽略 / 删除）。
 */
export function skillHealth(runs: SkillRun[]): { stale: boolean; stalls: number; reason?: string } {
  let stalls = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i]!;
    if (run.ok) break;
    if (typeof run.failedStep === "number") stalls += 1;
    else break; // 别的失败原因（被接管、超时）不算"页面变了"
  }
  return stalls >= STALE_AFTER_STALLS
    ? { stale: true, stalls, reason: `最近 ${stalls} 次都因为页面变了停下，可能已经过期` }
    : { stale: false, stalls };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export function validSkillId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** 技能只在同一个站点（hostname）内复用；未限定站点的不下发。 */
export function normalizeSkillHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^www\./, "");
}

/** 步骤与凭证里都不允许出现坐标或 DOM 路径：那是会失效的东西。 */
export function forbiddenInSkill(text: string): string | null {
  if (/nth-of-type|nth-child/.test(text)) return "DOM 路径";
  if (/\(\s*-?\d+\s*,\s*-?\d+\s*\)/.test(text)) return "坐标";
  // 运行时自带的那枚标记不是"写死的选择器"：它是脚本自己贴上去的，跟页面结构无关。
  const scrubbed = text
    .split('"[data-sideagent-target]"').join("()")
    .split("[data-sideagent-target]").join("")
    .split("data-sideagent-target").join("");
  // 写死的选择器才是红线：按语义解析（querySelectorAll(spec.tag)）不算
  if (/querySelector(All)?\(\s*['"][.#\[]/.test(scrubbed)) return "选择器";
  if (/#[A-Za-z_][\w-]*/.test(scrubbed)) return "id 选择器";
  return null;
}

/** 面板上的步骤文案：和示范列表用同一套说法，用户不用重新学一遍。 */
export function skillStepsText(skill: Skill): string[] {
  return skill.steps.map(step => {
    if (step.kind === "press") return `按 ${KEY_LABEL[step.key ?? ""] ?? step.key ?? ""}`;
    if (step.inputKey) {
      const value = skill.inputs[step.inputKey] ?? "";
      return step.redacted || !value
        ? `在${describeAnchor(step.anchor)}里输入（内容已隐藏）`
        : `在${describeAnchor(step.anchor)}里输入「${value}」`;
    }
    return `点击${describeAnchor(step.anchor)}`;
  });
}

const KEY_LABEL: Record<string, string> = { Enter: "回车", Tab: "Tab", Escape: "Esc", " ": "空格" };

export function describeAnchor(anchor: SkillAnchor | undefined): string {
  if (!anchor) return "页面";
  const name = anchor.name ? `「${anchor.name}」` : "";
  if (anchor.tag === "input" || anchor.tag === "textarea") return `${anchor.inputType === "search" ? "搜索框" : "输入框"}${name}`;
  if (anchor.tag === "a") return `链接${name}`;
  if (anchor.tag === "button") return `按钮${name}`;
  return `${anchor.role ?? anchor.tag}${name}`;
}
