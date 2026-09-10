/**
 * 动作效果证据采集（content script，ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.effect = { begin, diff, end }。
 *
 * 采集点在页面侧，因为只有这里能廉价地读 DOM；判定逻辑在 shared/effect.ts（纯函数，可单测）。
 * 元素身份用**操作落点**（background 传下来的视口坐标）解析：真实事件就派发给这个元素，
 * 它比任何定位串都更接近「刚才到底点了谁」。
 */
import {
  EFFECT_SCOPE_SEL,
  EFFECT_VOLATILE_DELTA,
  EFFECT_VOLATILE_WINDOW_MS,
  diffEffect,
  type EffectBaseline,
  type EffectReport,
  type EffectStats,
  type EffectTargetState,
} from "../../../shared/effect.js";

(function () {
  const ns = (window.__sideagent ??= {});
  if (ns.effect) return;

  const sessions = new Map<string, { base: EffectBaseline; el: Element | null; at: number }>();
  const SESSION_KEEP = 16;
  const SESSION_TTL_MS = 30_000;

  function describe(el: Element | null): string | null {
    if (!el || !el.isConnected) return null;
    const tag = el.tagName.toLowerCase();
    const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
    const cls = typeof el.className === "string" && el.className.trim()
      ? `.${el.className.trim().split(/\s+/)[0]}`
      : "";
    return `${tag}${id}${cls}`;
  }

  /** 密码/验证码类字段的值不进证据（与产品既有的 `value: <N 位>` 约定一致）。 */
  function isSecretField(el: Element): boolean {
    if (el instanceof HTMLInputElement && el.type === "password") return true;
    const auto = String(el.getAttribute("autocomplete") ?? "").toLowerCase();
    return auto.includes("one-time-code") || auto.startsWith("cc-");
  }

  function fieldValue(el: Element): string | undefined {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const raw = el.value ?? "";
      const masked = isSecretField(el);
      const shown = raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
      return masked ? (raw ? `<${raw.length} chars>` : raw) : shown;
    }
    if ((el as HTMLElement).isContentEditable) {
      const text = (el.textContent ?? "").trim();
      return text.length > 60 ? `${text.slice(0, 60)}…` : text;
    }
    return undefined;
  }

  function targetState(el: Element | null): EffectTargetState {
    if (!el || !el.isConnected) return { gone: true, tag: "" };
    const anyEl = el as HTMLElement & { checked?: unknown; disabled?: unknown };
    const attr = (name: string): string => el.getAttribute(name) ?? "";
    const rendered = ((el as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim();
    const media = el as HTMLMediaElement;
    const isMedia = typeof media.paused === "boolean";
    const state: EffectTargetState = {
      gone: false,
      tag: el.tagName.toLowerCase(),
      text: rendered.length > 80 ? `${rendered.slice(0, 80)}…` : rendered,
      value: fieldValue(el),
      checked: anyEl.checked === undefined ? attr("aria-checked") : String(anyEl.checked),
      selected: attr("aria-selected"),
      expanded: attr("aria-expanded"),
      disabled: anyEl.disabled === undefined ? attr("aria-disabled") : String(anyEl.disabled),
      ...(isMedia ? { paused: String(media.paused), ended: String(media.ended) } : {}),
      cls: String((el as HTMLElement).className ?? "").slice(0, 200),
    };
    return state;
  }

  /** 页面提示：ARIA live 区域里当前的可见文本。校验错误、toast 大多落在这里。 */
  function collectAlerts(): string[] {
    const out: string[] = [];
    const nodes = document.querySelectorAll('[role="alert"],[role="status"],[aria-live="polite"],[aria-live="assertive"]');
    for (const node of nodes) {
      const text = (node as HTMLElement).innerText?.replace(/\s+/g, " ").trim() ?? "";
      if (!text) continue;
      const clipped = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      if (!out.includes(clipped)) out.push(clipped);
      if (out.length >= 5) break;
    }
    return out;
  }

  // 不触发布局的廉价指标；innerText 会强制 reflow，只在必要时付这个成本。
  function cheap() {
    return {
      els: document.getElementsByTagName("*").length,
      bodyKids: document.body?.children.length ?? 0,
      active: describe(document.activeElement),
    };
  }

  const renderedLen = (node: Element | null): number => ((node as HTMLElement | null)?.innerText ?? "").length;

  function stats(el: Element | null, c: ReturnType<typeof cheap>): EffectStats {
    const box = (el && el.isConnected ? el.closest(EFFECT_SCOPE_SEL) : null) ?? document.body;
    return {
      els: c.els,
      bodyKids: c.bodyKids,
      active: c.active,
      bodyTextLen: renderedLen(document.body),
      target: targetState(el),
      targetActive: !!el && el.isConnected && document.activeElement === el,
      scopeKids: box ? box.getElementsByTagName("*").length : 0,
      scopeTextLen: renderedLen(box),
      alerts: collectAlerts(),
    };
  }

  function resolve(input: { point?: [number, number]; selector?: string }): Element | null {
    try {
      if (Array.isArray(input.point) && Number.isFinite(input.point[0]) && Number.isFinite(input.point[1])) {
        return document.elementFromPoint(input.point[0], input.point[1]);
      }
      if (input.selector) return document.querySelector(input.selector);
    } catch {
      /* 解析失败就当没有目标，效果判定退化成全局观察 */
    }
    return null;
  }

  function prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [token, session] of sessions) if (session.at < cutoff) sessions.delete(token);
    while (sessions.size > SESSION_KEEP) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }

  ns.effect = {
    async begin(input: { token: string; point?: [number, number]; selector?: string }): Promise<{ ok: true }> {
      const el = resolve(input);
      const first = cheap();
      await new Promise((resolve) => setTimeout(resolve, EFFECT_VOLATILE_WINDOW_MS));
      const second = cheap();
      const base: EffectBaseline = {
        ...stats(el, second),
        // 页面自己在这 60ms 里就动过 DOM：后面的全局数字不可信，只认强证据。
        volatile: Math.abs(second.els - first.els) >= EFFECT_VOLATILE_DELTA,
      };
      prune();
      sessions.set(input.token, { base, el, at: Date.now() });
      return { ok: true };
    },

    diff(token: string): EffectReport | null {
      const session = sessions.get(token);
      if (!session) return null;
      session.at = Date.now();
      // 目标引用保留原对象：被替换/移除本身就是强证据，重新查找会把它抹掉。
      return diffEffect(session.base, stats(session.el, cheap()));
    },

    end(token: string): { ok: true } {
      sessions.delete(token);
      return { ok: true };
    },
  };
})();
