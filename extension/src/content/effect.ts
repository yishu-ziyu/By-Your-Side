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
import { overlayHostSelector } from "../shared/overlay.js";

(function () {
  const ns = (window.__sideagent ??= {});

  if (ns.effect) return;

  const sessions = new Map<string, { base: EffectBaseline | null; el: Element | null; at: number; watch: Watch }>();

  interface Watch { observer: MutationObserver; added: Set<Element>; structural: Set<Element>; text: Set<Element>; take: (records: MutationRecord[]) => void; at: number; last: number }

  const MAX_ROOTS = 12;
  const BIG_ROOT = 1500;
  const SHOWING_ATTRS = ["hidden", "style", "class", "open", "aria-hidden", "aria-expanded", "aria-modal"];
  const NOISE_WINDOW_MS = 3000;

  const textTarget = (record: MutationRecord): Element | null => {
    if (record.type === "characterData") return record.target.parentElement;
    if (record.type !== "childList") return null;
    const nodes = [...record.addedNodes, ...record.removedNodes];

    return nodes.length && nodes.every(node => node.nodeType === 3) && record.target.nodeType === 1 ? record.target as Element : null;
  };

  const textTimes = new WeakMap<Element, number[]>();
  new MutationObserver(records => {
    const now = Date.now();

    for (const record of records) {
      const el = textTarget(record);

      if (el) textTimes.set(el, [...(textTimes.get(el) ?? []).filter(t => t > now - NOISE_WINDOW_MS - SESSION_TTL_MS), now].slice(-64));
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });

  const ticking = (el: Element, at: number) => (textTimes.get(el) ?? []).filter(t => t < at && t >= at - NOISE_WINDOW_MS).length >= 2;

  function watchChanges(): Watch {
    const watch: Watch = { observer: null as unknown as MutationObserver, added: new Set(), structural: new Set(), text: new Set(), take: () => {}, at: Date.now(), last: 0 };

    watch.take = (records: MutationRecord[]) => {
      for (const record of records) {
        const text = textTarget(record);

        if (text && ticking(text, watch.at)) continue;
        watch.last = Date.now();

        if (text) { watch.text.add(text); continue; }

        if (record.type === "childList") {
          for (const node of record.addedNodes) if (node.nodeType === 1) watch.added.add(node as Element);
        } else if (record.target.nodeType === 1) watch.structural.add(record.target as Element);
      }
    };
    watch.observer = new MutationObserver(watch.take);
    watch.observer.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: SHOWING_ATTRS });
    setTimeout(() => watch.observer.disconnect(), SESSION_TTL_MS);

    return watch;
  }

  function cssPath(el: Element): string {
    const parts: string[] = [];

    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if ((cur as HTMLElement).id) { parts.unshift(`#${CSS.escape((cur as HTMLElement).id)}`); break; }
      const tag = cur.tagName.toLowerCase();

      if (tag === "html" || tag === "body" || !cur.parentElement) { parts.unshift(tag); break; }
      let idx = 1;

      for (const sib of Array.from(cur.parentElement.children)) {
        if (sib === cur) break;
        if (sib.tagName === cur.tagName) idx += 1;
      }
      parts.unshift(`${tag}:nth-of-type(${idx})`);
    }

    return parts.join(" > ");
  }

  function fieldOf(el: Element): { el: Element; field: boolean } {
    let field = el.closest("input,textarea,select") ?? el;
    let editable = field !== el || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

    for (let cur: Element | null = field; cur; cur = cur.parentElement) if ((cur as HTMLElement).isContentEditable) { field = cur; editable = true; }

    return { el: field, field: editable };
  }

  function changedRoots(watch: Watch): Array<{ sel: string; field?: true }> | "many" {
    watch.take(watch.observer.takeRecords());
    const overlay = overlayHostSelector();
    const shown = (el: Element) => el.isConnected && !el.closest(overlay) && (typeof el.checkVisibility !== "function" || el.checkVisibility({ checkVisibilityCSS: true }));
    const big = (el: Element) => el.getElementsByTagName("*").length > BIG_ROOT;
    const candidates = new Set<Element>();
    const fields = new Set<Element>();
    let bigToggled = false;

    for (const el of new Set([...watch.added, ...watch.structural, ...watch.text])) {
      if (!shown(el)) continue;
      const structural = watch.added.has(el) || watch.structural.has(el);

      if (!structural && ticking(el, watch.at)) continue;

      if (big(el)) {
        if (watch.added.has(el)) return "many";
        if (watch.structural.has(el)) bigToggled = true;
        continue;
      }
      const lifted = fieldOf(el);
      candidates.add(lifted.el);

      if (lifted.field) fields.add(lifted.el);
    }

    const outermost = (set: Set<Element>) => [...set].filter(el => {
      for (let up = el.parentElement; up; up = up.parentElement) if (set.has(up)) return false;

      return true;
    });
    let top = outermost(candidates);

    if (!top.length && bigToggled) return "many";

    if (top.length > MAX_ROOTS) {
      const siblings = new Map<Element, number>();

      for (const el of top) if (el.parentElement) siblings.set(el.parentElement, (siblings.get(el.parentElement) ?? 0) + 1);
      top = outermost(new Set(top.map(el => el.parentElement && (siblings.get(el.parentElement) ?? 0) > 1 && !big(el.parentElement) ? el.parentElement : el)));
    }

    return top.length > MAX_ROOTS ? "many" : top.map(el => fields.has(el) ? { sel: cssPath(el), field: true as const } : { sel: cssPath(el) });
  }

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
    };

    if (isMedia) {
      state.paused = String(media.paused);
      state.ended = String(media.ended);
    }

    state.cls = String((el as HTMLElement).className ?? "").slice(0, 200);

    return state;
  }

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
    }

    return null;
  }

  function prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;

    for (const [token, session] of sessions) if (session.at < cutoff) { session.watch.observer.disconnect(); sessions.delete(token); }

    while (sessions.size > SESSION_KEEP) {
      const oldest = sessions.keys().next().value;

      if (oldest === undefined) break;
      sessions.get(oldest)?.watch.observer.disconnect();
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
        volatile: Math.abs(second.els - first.els) >= EFFECT_VOLATILE_DELTA,
      };

      prune();
      sessions.set(input.token, { base, el, at: Date.now(), watch: watchChanges() });

      return { ok: true };
    },

    watch(token: string): { ok: true } {
      prune();
      sessions.set(token, { base: null, el: null, at: Date.now(), watch: watchChanges() });

      return { ok: true };
    },

    diff(token: string): EffectReport | null {
      const session = sessions.get(token);

      if (!session?.base) return null;
      session.at = Date.now();

      return diffEffect(session.base, stats(session.el, cheap()));
    },

    roots(token: string): Array<{ sel: string; field?: true }> | "many" | null {
      const session = sessions.get(token);

      return session ? changedRoots(session.watch) : null;
    },

    quietMs(token: string): number | null {
      const session = sessions.get(token);

      if (!session) return null;
      session.watch.take(session.watch.observer.takeRecords());

      return session.watch.last ? Date.now() - session.watch.last : null;
    },

    end(token: string): { ok: true } {
      sessions.get(token)?.watch.observer.disconnect();
      sessions.delete(token);

      return { ok: true };
    },
  };
})();
