/**
 * 从 DOM 取语义锚点：录制（示范）和观察（被动）共用同一套取法。
 * 单独成文件是为了不让两处慢慢长出两套"什么算名字"的规则。
 */
import { anchorFor, isSensitiveField, type AnchorSource, type DemoAnchor } from "../../../shared/demo-record.js";

/** 我们自己的浮层不算用户操作。 */
export const OVERLAY_SELECTOR = "[data-sideagent-overlay]";

export function insideOverlay(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(OVERLAY_SELECTOR) != null;
}

function labelText(el: Element): string | undefined {
  const labelled = el as unknown as { labels?: ArrayLike<{ textContent?: string | null }> };
  const first = labelled.labels?.[0]?.textContent;
  if (typeof first === "string" && first.trim()) return first;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const parts = by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? "").join(" ");
    if (parts.trim()) return parts;
  }
  return undefined;
}

/** 最近的有文字的祖先：点击常落在裸 div 上，名字只可能在祖先那里。 */
export function ancestorTextOf(el: Element): string | null {
  let cur: Element | null = el.parentElement;
  for (let depth = 0; depth < 4 && cur; depth += 1) {
    const text = (cur.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) return text.length <= 120 ? text : text.slice(0, 120);
    cur = cur.parentElement;
  }
  return null;
}

export function descendantAlt(el: Element): string | null {
  const img = el.querySelector?.("img[alt], svg[aria-label]");
  return img?.getAttribute("alt") ?? img?.getAttribute("aria-label") ?? null;
}

function hasName(el: Element): boolean {
  return Boolean(
    el.getAttribute("aria-label")?.trim()
    || el.getAttribute("title")?.trim()
    || el.getAttribute("placeholder")?.trim()
    || (el.textContent ?? "").replace(/\s+/g, " ").trim(),
  );
}

/**
 * 点到哪儿算"这一步的对象"：先按语义标记往上找（button/a/role），
 * 找不到就找一个有名字的祖先——真机上视频卡这种裸 div 就是这样。
 */
export function meaningful(el: Element | null): Element | null {
  let cur: Element | null = el;
  let named: Element | null = null;
  for (let depth = 0; cur && depth < 6; depth += 1) {
    const tag = cur.tagName.toLowerCase();
    if (tag === "button" || tag === "a" || tag === "input" || tag === "textarea" || tag === "select" || tag === "label" || tag === "summary") return cur;
    const role = cur.getAttribute("role");
    if (role && /button|link|tab|menuitem|option|checkbox|radio|switch|combobox|textbox|searchbox/.test(role)) return cur;
    if (!named && hasName(cur)) named = cur;
    cur = cur.parentElement;
  }
  return named ?? el;
}

export function sourceOf(el: Element): AnchorSource {
  return {
    tag: el.tagName.toLowerCase(),
    role: el.getAttribute("role"),
    type: el.getAttribute("type"),
    name: el.getAttribute("name"),
    id: el.id || null,
    placeholder: el.getAttribute("placeholder"),
    ariaLabel: el.getAttribute("aria-label"),
    label: labelText(el),
    text: el.tagName === "INPUT" || el.tagName === "SELECT" ? null : el.textContent,
    title: el.getAttribute("title"),
    alt: descendantAlt(el),
    ancestorText: ancestorTextOf(el),
    autocomplete: el.getAttribute("autocomplete"),
  };
}

/** 一次点击 → 锚点 + 是否敏感。取不到有意义的对象时返回 null。 */
export function anchorOfTarget(target: EventTarget | null): { anchor: DemoAnchor; sensitive: boolean } | null {
  if (!(target instanceof Element)) return null;
  const el = meaningful(target);
  if (!el) return null;
  const source = sourceOf(el);
  return { anchor: anchorFor(source), sensitive: isSensitiveField(source) };
}
