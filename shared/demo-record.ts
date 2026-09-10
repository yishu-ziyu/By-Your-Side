/**
 * 示范录制的纯逻辑：把用户自己的页面动作变成步骤记录。
 *
 * 三条铁律（对应验收标准 1–3）：
 *   1. 只记「这是页面里的什么」（语义锚点），不记坐标、不记 DOM 路径——那些会失效。
 *   2. 敏感字段只记「填了东西」，绝不记内容；密码框、卡号、验证码一律不记。
 *   3. 录的是动作事实，不是解释。人话描述由 describeStep 生成，供面板展示。
 *
 * 本文件不碰 chrome API 与 DOM，便于单测。
 */

export type DemoStepKind = "click" | "type" | "press" | "submit";

/** 语义锚点：只说这是页面里的什么对象。 */
export interface DemoAnchor {
  tag: string;
  role?: string;
  /** 可访问名：可见文字 / aria-label / placeholder / 关联 label 的文本 */
  name?: string;
  inputType?: string;
}

export interface DemoStep {
  /** 相对开始录制的毫秒数 */
  at: number;
  kind: DemoStepKind;
  /** press/submit 没有明确对象时可以没有锚点 */
  anchor?: DemoAnchor;
  /** type 步骤的输入内容；敏感字段不记录 */
  value?: string;
  /** 敏感字段：知道填了，不知道填了什么 */
  redacted?: true;
  /** press 步骤的键名，如 Enter / Tab */
  key?: string;
  /** 发生时的页面（只留 origin + pathname，查询串不记） */
  page?: string;
  /** 连续同类动作合并的计数（输入一个词会触发很多次 input） */
  repeats?: number;
}

export interface DemoLimits {
  maxSteps: number;
  maxBytes: number;
  /** 相邻 type 合并窗口；超过就算新的一步 */
  mergeWindowMs: number;
}

export const DEFAULT_DEMO_LIMITS: DemoLimits = { maxSteps: 200, maxBytes: 64_000, mergeWindowMs: 2_000 };

const SENSITIVE_ATTR = /pass(word|wd)?|secret|token|otp|code|captcha|card|cvv|cvc|iban|ssn|idcard|身份证|验证码|密码/i;

export interface AnchorSource {
  tag?: string | null;
  role?: string | null;
  type?: string | null;
  name?: string | null;
  id?: string | null;
  placeholder?: string | null;
  ariaLabel?: string | null;
  label?: string | null;
  text?: string | null;
  /** title 属性 */
  title?: string | null;
  /** 后代图片的 alt（卡片类点击只有图有名字） */
  alt?: string | null;
  /** 最近的、有文字的祖先（真机教训：B 站视频卡是裸 div，名字在祖先上） */
  ancestorText?: string | null;
  /** autocomplete 属性；cc-* / one-time-code 一律敏感 */
  autocomplete?: string | null;
}

const MAX_NAME = 60;

function clean(text: string | null | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return undefined;
  return t.length > MAX_NAME ? `${t.slice(0, MAX_NAME - 1)}…` : t;
}

/** 可访问名的近似取法：显式 aria-label > 关联 label > placeholder > 可见文字。 */
export function anchorFor(src: AnchorSource): DemoAnchor {
  const tag = (src.tag ?? "unknown").toLowerCase();
  const type = tag === "input" ? (src.type ?? "text").toLowerCase() : undefined;
  const anchor: DemoAnchor = { tag };
  const role = src.role ? src.role.toLowerCase() : undefined;
  if (role) anchor.role = role;
  // 取名字的顺序：显式标签 → 占位 → title → 图片 alt → 祖先文字 → 自身文字 → name 属性。
  // 真机上点击经常落在裸 div 上，名字只可能在祖先或后代图片里。
  const name = clean(src.ariaLabel) ?? clean(src.label) ?? clean(src.placeholder) ?? clean(src.title)
    ?? clean(src.alt) ?? clean(src.ancestorText) ?? clean(src.text) ?? clean(src.name);
  if (name) anchor.name = name;
  if (type && type !== "text") anchor.inputType = type;
  return anchor;
}

/** 密码框、卡号、验证码、token 一类：内容绝不落盘。 */
export function isSensitiveField(src: AnchorSource): boolean {
  const type = (src.type ?? "").toLowerCase();
  if (type === "password") return true;
  const autocomplete = (src.autocomplete ?? "").toLowerCase();
  if (autocomplete.startsWith("cc-") || autocomplete === "one-time-code" || autocomplete === "current-password" || autocomplete === "new-password") return true;
  return [src.name, src.id, src.placeholder, src.ariaLabel, src.label].some(v => typeof v === "string" && SENSITIVE_ATTR.test(v));
}

/** 页面地址只留 origin + pathname；查询串与 hash 可能带 token，不记。 */
export function scrubUrl(raw: string | null | undefined): string | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  const m = /^(https?:\/\/[^/?#]+)([^?#]*)/.exec(raw);
  if (!m) return undefined;
  const suffix = raw.includes("?") || raw.includes("#") ? "?…" : "";
  return `${m[1]}${m[2]}${suffix}`;
}

export function sameAnchor(a?: DemoAnchor, b?: DemoAnchor): boolean {
  if (!a || !b) return !a && !b;
  return a.tag === b.tag && a.role === b.role && a.name === b.name && a.inputType === b.inputType;
}

/** 相邻同类动作合并：连续 input → 一步；同一对象 400ms 内连点 → 一步。 */
const CLICK_MERGE_MS = 400;

export interface PushResult {
  steps: DemoStep[];
  /** 触顶后新动作被丢弃，录制必须如实告诉用户"记不下了" */
  truncated: boolean;
}

export function pushStep(steps: DemoStep[], step: DemoStep, limits: DemoLimits = DEFAULT_DEMO_LIMITS): PushResult {
  const next = steps.slice();
  const last = next[next.length - 1];
  if (last && last.kind === step.kind && sameAnchor(last.anchor, step.anchor)) {
    if (step.kind === "type" && step.at - last.at <= limits.mergeWindowMs) {
      const merged: DemoStep = { ...last, value: step.value ?? last.value, redacted: step.redacted ?? last.redacted, repeats: (last.repeats ?? 1) + 1 };
      if (step.value === undefined && step.redacted) delete merged.value;
      next[next.length - 1] = merged;
      return { steps: next, truncated: false };
    }
    if (step.kind === "click" && step.at - last.at <= CLICK_MERGE_MS) {
      next[next.length - 1] = { ...last, repeats: (last.repeats ?? 1) + 1 };
      return { steps: next, truncated: false };
    }
    if (step.kind === "press" && last.key === step.key && step.at - last.at <= CLICK_MERGE_MS) {
      next[next.length - 1] = { ...last, repeats: (last.repeats ?? 1) + 1 };
      return { steps: next, truncated: false };
    }
  }
  next.push(step);
  if (next.length > limits.maxSteps) return { steps: next.slice(0, limits.maxSteps), truncated: true };
  if (byteLength(next) > limits.maxBytes) {
    const trimmed = next.slice();
    while (trimmed.length > 1 && byteLength(trimmed) > limits.maxBytes) trimmed.pop();
    return { steps: trimmed, truncated: true };
  }
  return { steps: next, truncated: false };
}

/** 按 UTF-8 字节计预算：chrome.storage 的配额也是按字节，别用字符数骗自己。 */
export function byteLength(steps: DemoStep[]): number {
  return new TextEncoder().encode(JSON.stringify(steps)).length;
}

function target(anchor: DemoAnchor | undefined): string {
  if (!anchor) return "页面";
  const name = anchor.name ? `「${anchor.name}」` : "";
  if (anchor.tag === "input" || anchor.tag === "textarea") {
    const kind = anchor.inputType === "search" ? "搜索框" : "输入框";
    return `${kind}${name}`;
  }
  if (anchor.tag === "a") return `链接${name}`;
  if (anchor.tag === "button") return `按钮${name}`;
  if (anchor.role === "tab") return `标签页${name}`;
  if (anchor.role === "menuitem") return `菜单项${name}`;
  return `${anchor.role ?? anchor.tag}${name}`;
}

const KEY_LABEL: Record<string, string> = { Enter: "回车", Tab: "Tab", Escape: "Esc", " ": "空格" };

/** 面板里给人看的一行；不出现坐标、选择器与字段值。 */
export function describeStep(step: DemoStep): string {
  const times = (step.repeats ?? 1) > 1 ? ` ×${step.repeats}` : "";
  switch (step.kind) {
    case "click":
      return `点击${target(step.anchor)}${times}`;
    case "type":
      return step.redacted
        ? `在${target(step.anchor)}里输入（内容已隐藏）${times}`
        : `在${target(step.anchor)}里输入「${step.value ?? ""}」${times}`;
    case "press":
      return `按 ${KEY_LABEL[step.key ?? ""] ?? step.key ?? ""}${times}`;
    case "submit":
      return `提交表单${times}`;
  }
}

export function describeSteps(steps: DemoStep[]): string[] {
  return steps.map(describeStep);
}

/** 录制期间的实时计数，面板与日志共用一句人话。 */
export function recordingHint(steps: DemoStep[], truncated: boolean): string {
  const head = `示范中：已记下 ${steps.length} 步`;
  return truncated ? `${head}（已达上限，后面的动作不再记录）` : head;
}
