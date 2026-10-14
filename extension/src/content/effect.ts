/**
 * 动作效果证据采集（content script，ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.effect = { begin, diff, end }。
 *
 * 采集点在页面侧，因为只有这里能廉价地读 DOM；判定逻辑在 shared/effect.ts（纯函数）。
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
import { overlayHostSelector } from "../shared/overlay.js";

(function () {
  const ns = (window.__sideagent ??= {});

  if (ns.effect) return;

  /** base 为 null：只记变化、不判效果的会话（填写、选择之后用，见 watch）。 */
  const sessions = new Map<string, { base: EffectBaseline | null; el: Element | null; at: number; watch: Watch }>();

  /**
   * 动作期间页面上变过的地方：加进来的元素、改了显示属性的元素（structural），只改了字的元素（text）。last 是最后一次变化的时刻。
   * at 是会话开始的时刻：开始前就在一直跳字的地方（时钟、倒计时）不算这次的变化。
   */
  interface Watch { observer: MutationObserver; added: Set<Element>; structural: Set<Element>; text: Set<Element>; take: (records: MutationRecord[]) => void; at: number; last: number }

  /** 最多交回几处变化；更多就说“整块重画了”。 */
  const MAX_ROOTS = 12;
  /** 一处变化里元素超过这么多：只改了属性、字的就不算（给 body 换个 class 不等于整页都是新的）；整块新加进来的算重画。 */
  const BIG_ROOT = 1500;
  /** 会让元素出现、消失的属性。 */
  const SHOWING_ATTRS = ["hidden", "style", "class", "open", "aria-hidden", "aria-expanded", "aria-modal"];
  /** 动作前这么久里跳过两次字的地方，算一直在跳。 */
  const NOISE_WINDOW_MS = 3000;

  /** 只改了字的那个元素；改了元素结构的返回 null。 */
  const textTarget = (record: MutationRecord): Element | null => {
    if (record.type === "characterData") return record.target.parentElement;
    if (record.type !== "childList") return null;
    const nodes = [...record.addedNodes, ...record.removedNodes];

    return nodes.length && nodes.every(node => node.nodeType === 3) && record.target.nodeType === 1 ? record.target as Element : null;
  };

  // 一直开着、只记“哪里在跳字”：时钟、倒计时这类跳动不能算成动作带来的变化。
  // 每个元素只留最近 NOISE_WINDOW_MS 加一次动作那么久里的时刻：跳得快的时钟，最近几次都落在动作期间，只留三次就看不出它动作前也在跳。
  const textTimes = new WeakMap<Element, number[]>();
  new MutationObserver(records => {
    const now = Date.now();

    for (const record of records) {
      const el = textTarget(record);

      if (el) textTimes.set(el, [...(textTimes.get(el) ?? []).filter(t => t > now - NOISE_WINDOW_MS - SESSION_TTL_MS), now].slice(-64));
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });

  /** 会话开始前 NOISE_WINDOW_MS 里跳过两次字。 */
  const ticking = (el: Element, at: number) => (textTimes.get(el) ?? []).filter(t => t < at && t >= at - NOISE_WINDOW_MS).length >= 2;

  function watchChanges(): Watch {
    const watch: Watch = { observer: null as unknown as MutationObserver, added: new Set(), structural: new Set(), text: new Set(), take: () => {}, at: Date.now(), last: 0 };

    watch.take = (records: MutationRecord[]) => {
      for (const record of records) {
        const text = textTarget(record);

        // 动作前就在一直跳字的地方（时钟、倒计时）：既不算变化，也不算“页面还没安静”。
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
    // 动作出错、没人来收时也别一直挂着：过期就停，不再攥着页面上删掉的节点。
    setTimeout(() => watch.observer.disconnect(), SESSION_TTL_MS);

    return watch;
  }

  /** querySelector 能找回这个元素的定位串：#id，或沿祖先的 tag:nth-of-type(n) 路径（同 snapshot.ts）。 */
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

  /** 输入框、编辑器里面变了，算这个框本身变了：框里的字是值，不是新出现的内容（敏感栏也靠框本身来认）。没写 role 的编辑器无障碍树里是 generic，所以按 isContentEditable 认。 */
  function fieldOf(el: Element): { el: Element; field: boolean } {
    let field = el.closest("input,textarea,select") ?? el;
    let editable = field !== el || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);

    for (let cur: Element | null = field; cur; cur = cur.parentElement) if ((cur as HTMLElement).isContentEditable) { field = cur; editable = true; }

    return { el: field, field: editable };
  }

  /**
   * 变过的地方，只留最外层、还在页面上、看得见、不是助手自己浮层的几处。
   * 先丢掉只改了属性、字的大元素（弹窗打开时网站常给 body 加 modal-open），再去重；不然它会把里面真正新出现的东西都盖住。
   * 只改了字、动作前就在一直跳的地方（时钟、倒计时）不算。同一个父元素下加进来好几个（建议列表的一项项）合成父元素一处。
   * field：这一处是输入框或编辑器，里面的字不报。
   */
  function changedRoots(watch: Watch): Array<{ sel: string; field?: true }> | "many" {
    watch.take(watch.observer.takeRecords());
    const overlay = overlayHostSelector();
    const shown = (el: Element) => el.isConnected && !el.closest(overlay) && (typeof el.checkVisibility !== "function" || el.checkVisibility({ checkVisibilityCSS: true }));
    const big = (el: Element) => el.getElementsByTagName("*").length > BIG_ROOT;
    const candidates = new Set<Element>();
    const fields = new Set<Element>();
    // 只改了属性的大容器（body、#app 换 class 让预先画好的弹窗显出来）：里面哪里新显出来看不出，别的地方又没变时，就说一大块变了。
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
    };

    if (isMedia) {
      state.paused = String(media.paused);
      state.ended = String(media.ended);
    }

    state.cls = String((el as HTMLElement).className ?? "").slice(0, 200);

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
        // 页面自己在这 60ms 里就动过 DOM：后面的全局数字不可信，只认强证据。
        volatile: Math.abs(second.els - first.els) >= EFFECT_VOLATILE_DELTA,
      };

      prune();
      sessions.set(input.token, { base, el, at: Date.now(), watch: watchChanges() });

      return { ok: true };
    },

    /** 只记动作期间哪里变了，不取基线：大页面读一次全页文字就要几十毫秒，填写之后用不着。 */
    watch(token: string): { ok: true } {
      prune();
      sessions.set(token, { base: null, el: null, at: Date.now(), watch: watchChanges() });

      return { ok: true };
    },

    diff(token: string): EffectReport | null {
      const session = sessions.get(token);

      if (!session?.base) return null;
      session.at = Date.now();

      // 目标引用保留原对象：被替换/移除本身就是强证据，重新查找会把它抹掉。
      return diffEffect(session.base, stats(session.el, cheap()));
    },

    roots(token: string): Array<{ sel: string; field?: true }> | "many" | null {
      const session = sessions.get(token);

      return session ? changedRoots(session.watch) : null;
    },

    /** 会话里最后一次变化离现在多久；还没变过返回 null。 */
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
