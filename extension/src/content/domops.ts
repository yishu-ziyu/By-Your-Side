import {replaceEditableText} from "../shared/editable-text.js";
import { parseTarget, resolveArgs, resolveTargetSelector } from "../shared/target.js";

/**
 * DOM 操作 content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.dom = { resolve, rectOf, confirmForClick, hitTestAt, rememberPoint, confirmPoint, click, fill, selectOption, scrollBy, scrollToBottom }。
 * 所有操作返回可序列化结果；失败抛带一行信息的 Error。
 */
(function () {
  const ns = (window.__sideagent ??= {});

  if (ns.dom) return;
  ns.refs ??= new Map<number, Element>();

  function mustResolve(target: string): Element {
    if (target.startsWith("@")) {
      const n = Number(target.slice(1));
      const el = Number.isInteger(n) ? ns.refs?.get(n) : undefined;

      if (!el || !el.isConnected) throw new Error(`ref ${target} 已失效，操作未执行。请重新 snapshot，在当前页面确认目标并使用新的 ref；不要继续重试旧 ref。`);

      return el;
    }

    // 统一 target 解析层：loc=css: / loc=role: / loc=href: / 原生 CSS / xpath= / text=。
    const parsed = parseTarget(target);

    if (!parsed || parsed.kind === "ref") {
      throw new Error(`无效的 target: ${target}。操作未执行。请重新 snapshot，从当前结果选择 @ref、loc=css:、loc=role:、loc=href:、原生 CSS、xpath= 或 text=。`);
    }

    const args = resolveArgs(parsed);

    return resolveTargetSelector(args.kind, args.selector);
  }


  /** iframe 内 getBoundingClientRect 是 frame 视口坐标；CDP 鼠标要 top 视口坐标。 */
  function topViewportRect(el: Element): { x: number; y: number; width: number; height: number } {
    const r = el.getBoundingClientRect();
    let x = r.x;
    let y = r.y;
    let win: Window | null = el.ownerDocument.defaultView;

    while (win && win !== win.top) {
      const frame = win.frameElement as Element | null;

      if (!frame) break;
      const fr = frame.getBoundingClientRect();
      x += fr.x;
      y += fr.y;
      win = win.parent;
    }

    return { x, y, width: r.width, height: r.height };
  }

  type SelectSpec = string | { value?: string; label?: string; index?: number } | null;

  function applySelectOption(select: HTMLSelectElement, values: SelectSpec | SelectSpec[]): {
    selected: string[];
    labels: string[];
  } {
    const requested: SelectSpec[] =
      values === null ? [] : Array.isArray(values) ? values : [values];

    const clear = requested.length === 0;

    if (!select.multiple && requested.length > 1) {
      throw new Error("非 multiple 的 select 不能一次选多项。操作未执行。");
    }

    for (let i = 0; i < select.options.length; i++) select.options[i]!.selected = false;

    if (!clear) {
      for (const item of requested) {
        let match: HTMLOptionElement | undefined;

        if (item === null) continue;

        if (typeof item === "string") {
          const wanted = item.trim();
          match =
            [...select.options].find((o) => o.value === wanted || o.text.trim() === wanted) ??
            [...select.options].find((o) => o.text.includes(wanted) || (wanted && wanted.includes(o.text.trim())));
        } else if (typeof item.index === "number") {
          match = select.options[item.index];

          if (!match) throw new Error(`select 没有 index=${item.index} 的选项。操作未执行。`);
        } else if (typeof item.value === "string") {
          match = [...select.options].find((o) => o.value === item.value);
        } else if (typeof item.label === "string") {
          const wanted = item.label.trim();
          match =
            [...select.options].find((o) => o.text.trim() === wanted) ??
            [...select.options].find((o) => o.label === wanted || o.text.includes(wanted));
        }

        if (!match) throw new Error(`下拉框没有匹配选项: ${JSON.stringify(item)}。操作未执行。`);
        match.selected = true;
      }
    }

    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const selected = [...select.selectedOptions].map((o) => o.value);
    const labels = [...select.selectedOptions].map((o) => o.text.trim());

    return { selected, labels };
  }

  function scrollIntoView(el: Element): void {
    // SAFETY: Element 只保证标准 DOM 接口；scrollIntoViewIfNeeded 是 Chromium 的可选扩展方法，
    // typeof 在运行时确认存在后才调用，形状不符时回退标准 scrollIntoView。
    const anyEl = el as unknown as { scrollIntoViewIfNeeded?: (o?: Record<string, unknown>) => void };

    if (typeof anyEl.scrollIntoViewIfNeeded === "function") {
      anyEl.scrollIntoViewIfNeeded({ block: "center", inline: "center" });
    } else {
      el.scrollIntoView({ block: "center", inline: "center" });
    }
  }

  function atBottom(): boolean {
    const doc = document.documentElement;
    const total = Math.max(doc.scrollHeight, document.body?.scrollHeight ?? 0);

    return window.innerHeight + window.scrollY >= total - 2;
  }

  /** 从命中节点向上走到目标（含目标作 host 的 shadow 后代）。不把命中祖先/body 当成命中目标。 */
  function ownsUpward(el: Element, hit: Element | null): boolean {
    if (!el || !hit) return false;

    if (el === hit) return true;

    if (typeof el.contains === "function" && el.contains(hit)) return true;
    let node: Node | null = hit;
    const seen = new Set<Node>();

    while (node) {
      if (node === el) return true;

      if (seen.has(node)) break;
      seen.add(node);

      const root: Node | null =
        typeof (node as Element).getRootNode === "function" ? (node as Element).getRootNode() : null;

      const host: Element | null = root !== null && "host" in root ? ((root as ShadowRoot).host ?? null) : null;

      if (host && host !== node) {
        node = host;
        continue;
      }

      node = (node as Element).parentElement;
    }

    return false;
  }

  /**
   * 同一对象、目标合法后代，或 document.elementFromPoint 落到目标所在 shadow 的 host
   * 且该 shadowRoot.elementFromPoint 仍命中目标。不恢复任意祖先 contains。
   */
  function targetOwnsHit(el: Element, top: Element, x: number, y: number): boolean {
    if (ownsUpward(el, top)) return true;
    let node: Node | null = el;
    const seen = new Set<Node>();

    while (node) {
      if (seen.has(node)) break;
      seen.add(node);

      const root: Node | null =
        typeof (node as Element).getRootNode === "function" ? (node as Element).getRootNode() : null;

      const host: Element | null = root !== null && "host" in root ? ((root as ShadowRoot).host ?? null) : null;

      if (host && root && typeof (root as ShadowRoot).elementFromPoint === "function") {
        if (top === host) {
          const inner = (root as ShadowRoot).elementFromPoint(x, y);

          if (!inner || inner === top) return false;

          if (ownsUpward(el, inner)) return true;

          return targetOwnsHit(el, inner, x, y);
        }

        node = host;
        continue;
      }

      node = (node as Element).parentElement;
    }

    return false;
  }

  function assertHits(el: Element, x: number, y: number): void {
    // 同源 iframe：top 视口坐标命中的是 <iframe> 本身；在目标文档内换算局部坐标再核验。
    if (el.ownerDocument !== document) {
      let localX = x;
      let localY = y;
      let win: Window | null = el.ownerDocument.defaultView;

      while (win && win !== win.top) {
        const frame = win.frameElement as Element | null;

        if (!frame) break;
        const fr = frame.getBoundingClientRect();
        localX -= fr.x;
        localY -= fr.y;
        win = win.parent;
      }

      const inner = el.ownerDocument.elementFromPoint(localX, localY);

      if (!inner || !ownsUpward(el, inner)) {
        throw new Error("目标被其他元素覆盖，操作未执行。请重新 snapshot 确认当前可点击目标，不要点击原坐标处的其他对象。");
      }

      return;
    }

    const top = document.elementFromPoint(x, y);

    if (!top) {
      throw new Error("目标处没有可命中的元素，操作未执行。请重新 snapshot 确认当前目标。");
    }

    if (!targetOwnsHit(el, top, x, y)) {
      throw new Error("目标被其他元素覆盖，操作未执行。请重新 snapshot 确认当前可点击目标，不要点击原坐标处的其他对象。");
    }
  }

  function assertViewportPoint(x: number, y: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error("坐标无效，操作未执行。");
    }

    const width = window.innerWidth;
    const height = window.innerHeight;

    if (x < 0 || y < 0 || x >= width || y >= height) {
      throw new Error("坐标不在当前视口内，操作未执行。");
    }
  }

  let pointLock: Element | null = null;

  ns.dom = {
    resolve(target: string): Element | null {
      try {
        return mustResolve(target);
      } catch {
        return null;
      }
    },

    rectOf(target: string): SideAgentRect {
      const el = mustResolve(target);
      scrollIntoView(el);
      const r = topViewportRect(el);

      if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");

      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },

    confirmForClick(target: string): SideAgentRect {
      const el = mustResolve(target);
      scrollIntoView(el);
      const r = topViewportRect(el);

      if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");
      assertHits(el, r.x + r.width / 2, r.y + r.height / 2);

      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },

    /** 在即将按下的视口坐标做命中检查，不滚动。mouseMoved 之后目标可能已离开该点。 */
    hitTestAt(target: string, x: number, y: number): { hit: true } {
      const el = mustResolve(target);

      if (!el.isConnected) {
        throw new Error(`ref ${target} 已失效，操作未执行。请重新 snapshot，在当前页面确认目标并使用新的 ref；不要继续重试旧 ref。`);
      }

      assertHits(el, x, y);

      return { hit: true };
    },

    rememberPoint(x: number, y: number): { remembered: true; tag: string } {
      assertViewportPoint(x, y);
      const el = document.elementFromPoint(x, y);

      if (!el) {
        throw new Error("坐标处没有可命中的元素，操作未执行。无法确认该坐标操作。");
      }

      pointLock = el;

      return { remembered: true, tag: el.tagName };
    },

    confirmPoint(x: number, y: number): { same: true } {
      assertViewportPoint(x, y);
      const el = document.elementFromPoint(x, y);

      if (!el) {
        throw new Error("坐标处没有可命中的元素，操作未执行。无法确认该坐标操作。");
      }

      if (!pointLock || pointLock !== el || !el.isConnected) {
        throw new Error("坐标处对象已替换，操作未执行。不要点击原坐标处的其他对象。");
      }

      return { same: true };
    },

    click(target: string): { clicked: true } {
      const el = mustResolve(target);
      scrollIntoView(el);
      const r = el.getBoundingClientRect();

      const common = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: r.x + r.width / 2,
        clientY: r.y + r.height / 2,
      };

      el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mousedown", common));
      el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("mouseup", common));
      // HTMLElement.click() 派发一次 click 并保留 <a> 跳转等默认行为。
      // 不可再 dispatchEvent(click)，否则同一处理器会被触发两次。
      const html = el as HTMLElement;

      if (typeof html.click === "function") html.click();
      else el.dispatchEvent(new MouseEvent("click", common));

      return { clicked: true };
    },

    fill(target: string, value: string): { filled: true } {
      const el = mustResolve(target) as HTMLElement;
      el.focus();
      const tag = el.tagName.toLowerCase();

      if (tag === "select") {
        // 单值 fill 保留既有模糊匹配；完整多选/index/清空请用 selectOption。
        applySelectOption(el as HTMLSelectElement, value);

        return { filled: true };
      }

      if (tag === "input" || tag === "textarea") {
        // 用原生 value setter 写入，兼容 React 受控组件
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");

        if (desc?.set) desc.set.call(el, value);
        else (el as HTMLInputElement | HTMLTextAreaElement).value = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));

        return { filled: true };
      }

      if (el.isContentEditable) {
        replaceEditableText(el,value);

        return { filled: true };
      }

      throw new Error("元素不可填充（非 input/textarea/select/contenteditable）");
    },

    /** CAP-02C：按 value/label/index 选择；数组=多选；null/[]=清空。返回最终选中 value 集合。 */
    selectOption(
      target: string,
      values: SelectSpec | SelectSpec[],
    ): { selected: string[]; labels: string[] } {
      const el = mustResolve(target) as HTMLElement;

      if (el.tagName.toLowerCase() !== "select") {
        throw new Error("selectOption 仅用于原生 <select>。操作未执行。");
      }

      el.focus();

      return applySelectOption(el as HTMLSelectElement, values);
    },

    scrollBy(dy: number | null): { atBottom: boolean } {
      const delta = typeof dy === "number" && Number.isFinite(dy) ? dy : Math.round(window.innerHeight * 0.8);
      window.scrollBy(0, delta);

      return { atBottom: atBottom() };
    },

    async scrollToBottom(maxSteps = 20): Promise<{ atBottom: boolean }> {
      let steps = 0;

      while (!atBottom() && steps < maxSteps) {
        window.scrollBy(0, window.innerHeight);
        steps += 1;
        await new Promise((r) => setTimeout(r, 120));
      }

      return { atBottom: atBottom() };
    },
  };
})();
