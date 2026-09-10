/**
 * 动作效果证据（纯逻辑，无 DOM / 无 chrome 依赖）。
 *
 * 判定只回答一个确定性问题：**页面动没动**，不猜成功失败。
 * 强证据 = 几乎不可能由页面自身产生的变化（目标自身状态、目标区块、body 顶层、页面提示）；
 * 弱证据 = 动态页面每时每刻都在产生的全局数字，只展示，不参与 changed。
 * 依据见 docs/evals/20260911-action-evidence.md。
 */

/** 目标所在区块的候选；找不到时退回 body（按钮的兄弟节点里出现表单是最常见的交互形态）。 */
export const EFFECT_SCOPE_SEL =
  'section,form,[role=dialog],[role=listbox],[role=menu],main,article,[class*="modal" i],[class*="dialog" i],[class*="popover" i],[class*="dropdown" i]';

/** 页面自身是否在动的采样间隔与阈值。 */
export const EFFECT_VOLATILE_WINDOW_MS = 60;
export const EFFECT_VOLATILE_DELTA = 3;
/** 早停轮询：有强证据立即返回，否则最多等这么久。 */
export const EFFECT_SETTLE_INTERVAL_MS = 100;
export const EFFECT_SETTLE_TIMEOUT_MS = 600;
/** 弱证据阈值：全局 DOM 节点数 / 全局正文长度。 */
export const EFFECT_WEAK_DOM_DELTA = 3;
export const EFFECT_WEAK_TEXT_DELTA = 4;
/** 目标区块文本阈值：这块地方几乎不会漂来别的噪声。 */
export const EFFECT_SCOPE_TEXT_DELTA = 2;

export interface EffectTargetState {
  gone: boolean;
  tag: string;
  /** 目标自身的可见文本（按钮改名是最常见的一类真实反应：暂停 → 播放）。 */
  text?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  disabled?: string;
  /** 媒体元素的播放状态：原生控件点击的效果只体现在这里，DOM/文本都不变。 */
  paused?: string;
  ended?: string;
  cls?: string;
}

export interface EffectStats {
  els: number;
  bodyKids: number;
  active: string | null;
  bodyTextLen: number;
  target: EffectTargetState;
  /** 当前焦点是否就在被操作元素自己身上（点击的机械后果，不算页面反应）。 */
  targetActive: boolean;
  scopeKids: number;
  scopeTextLen: number;
  alerts: string[];
}

export interface EffectBaseline extends EffectStats {
  volatile: boolean;
}

export interface EffectReport {
  changed: boolean;
  /** 强证据：可归因于这次操作的变化。 */
  evidence: string[];
  /** 弱证据：全局数字，只作参考。 */
  weak: string[];
  volatile: boolean;
  /** 本次新出现的页面提示（校验错误、toast 等）。 */
  alerts: string[];
}

export const EMPTY_EFFECT_REPORT: EffectReport = { changed: false, evidence: [], weak: [], volatile: false, alerts: [] };

const isFiniteDelta = (delta: number, threshold: number) => Number.isFinite(delta) && Math.abs(delta) >= threshold;

function signed(delta: number): string {
  return delta > 0 ? `+${delta}` : `${delta}`;
}

/** 只比较「变了没有」；变化值本身可能是密码，调用方负责先把值隐去。 */
export function diffEffect(base: EffectBaseline, now: EffectStats): EffectReport {
  const evidence: string[] = [];
  const weak: string[] = [];

  // ① 目标自身：最便宜也最强。展开下拉、勾选、受控组件回滚值都不改 DOM 节点数。
  const bt = base.target, nt = now.target;
  if (nt.gone && !bt.gone) evidence.push("target removed from the page");
  else if (!nt.gone) {
    for (const key of ["text", "expanded", "checked", "selected", "value", "disabled", "paused", "ended"] as const) {
      const before = bt[key], after = nt[key];
      if (before === undefined || before === after) continue;
      evidence.push(`${key} ${before || "(empty)"} → ${after || "(empty)"}`);
    }
    if (bt.cls !== undefined && bt.cls !== nt.cls) evidence.push("target class changed");
  }

  // ② 新增页面提示：表单流程最主要的失败模式（校验错误）常常在长页面下方。
  const fresh = now.alerts.filter((alert) => !base.alerts.includes(alert));
  if (fresh.length) evidence.push(`⚠ page notice: ${fresh.join(" / ")}`);

  // ③ body 直接子元素：弹窗、抽屉、toast 几乎都挂在这一层。
  const dBodyKids = now.bodyKids - base.bodyKids;
  if (dBodyKids !== 0) {
    evidence.push(
      dBodyKids > 0
        ? `page top level +${dBodyKids} element(s) (likely dialog/overlay/toast)`
        : `page top level ${dBodyKids} element(s) (likely a whole block replaced)`,
    );
  }

  // ④ 目标区块：局部变化几乎不可能是别处噪声漂过来的。
  const dScopeKids = now.scopeKids - base.scopeKids;
  if (dScopeKids !== 0) evidence.push(`target region DOM ${signed(dScopeKids)} node(s)`);
  else if (evidence.length === 0 || (evidence.length === 1 && evidence[0] === "target class changed")) {
    const dScopeText = now.scopeTextLen - base.scopeTextLen;
    if (isFiniteDelta(dScopeText, EFFECT_SCOPE_TEXT_DELTA)) {
      evidence.push(`target region text ${signed(dScopeText)} char(s)`);
    }
  }

  // ⑤ 弱证据：页面自己也会产生，不参与判定。
  const dEls = now.els - base.els;
  if (isFiniteDelta(dEls, EFFECT_WEAK_DOM_DELTA)) weak.push(`DOM ${signed(dEls)} node(s)`);
  const dText = now.bodyTextLen - base.bodyTextLen;
  if (dText !== 0 && isFiniteDelta(dText, EFFECT_WEAK_TEXT_DELTA)) weak.push(`body text ${signed(dText)} char(s)`);
  const focusMoved = now.active !== base.active && !now.targetActive;
  if (focusMoved) weak.push(`focus → ${now.active ?? "(none)"}`);

  return { changed: evidence.length > 0, evidence, weak, volatile: !!base.volatile, alerts: fresh };
}

/** 给模型看的回执文案：有变化给清单，没变化明说并提示不要盲目重试。 */
export function formatEffectReport(report: EffectReport | undefined): string {
  if (!report) return "";
  const detail = [...report.evidence, ...report.weak].join("; ");
  if (report.changed) return ` Page reacted: ${detail}.`;
  const tail = report.volatile
    ? " The page itself keeps changing, but nothing was attributable to this click"
    : " Nothing on the page changed in a way attributable to this click";
  const weak = report.weak.length ? ` (${report.weak.join("; ")})` : "";
  return `${tail}${weak}. Likely causes: the element is only a container and the real control is inside or beside it; the effect is asynchronous; or the page ignored this input. Do not blindly click the same target again — observe the page first.`;
}

/**
 * 早停轮询：每 intervalMs 取一次报告，出现强证据立即返回；否则到 timeoutMs 返回最后一次。
 * 一次都没拿到报告（poll 一直返回 null/抛错，例如页面已经导航）时返回 undefined——
 * 不能把「拿不到证据」说成「没有变化」。
 */
export async function settleEffectReport(
  poll: () => Promise<EffectReport | null | undefined>,
  opts: { now?: () => number; sleep?: (ms: number) => Promise<void>; timeoutMs?: number; intervalMs?: number } = {},
): Promise<EffectReport | undefined> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = opts.timeoutMs ?? EFFECT_SETTLE_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? EFFECT_SETTLE_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let last: EffectReport | undefined;
  for (;;) {
    const report = await poll();
    if (report) last = report;
    if (last?.changed) return last;
    if (now() >= deadline) return last;
    await sleep(intervalMs);
  }
}
