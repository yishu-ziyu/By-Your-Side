/**
 * DOM 操作 content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.dom = { resolve, rectOf, confirmForClick, hitTestAt, rememberPoint, confirmPoint, click, fill, scrollBy, scrollToBottom }。
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
    const sel = target.startsWith("loc=css:") ? target.slice("loc=css:".length) : target;
    let matches: NodeListOf<Element>;
    try {
      matches = document.querySelectorAll(sel);
    } catch {
      throw new Error(`无效的选择器: ${sel}。操作未执行。target 支持 @N、loc=css:原生CSS 或原生 CSS；不支持 loc=h3...、:has-text() 等 Playwright 定位语法。请先 snapshot，从当前结果选择目标 ref 或 loc=css: 定位串后重试。`);
    }
    if (matches.length > 1) throw new Error(`选择器匹配 ${matches.length} 个元素: ${sel}。操作未执行。请 snapshot 确认目标，使用目标 ref 或更具体的唯一 CSS；不会自动选择第一个匹配。`);
    const el = matches[0];
    if (!el) throw new Error(`未找到元素: ${sel}。操作未执行。请 snapshot 确认当前页面中的目标，使用新的 ref 或有效 CSS；隐藏入口可先 hover 已确认的容器，再 snapshot。`);
    return el;
  }

  function scrollIntoView(el: Element): void {
    const anyEl = el as unknown as { scrollIntoViewIfNeeded?: (o?: object) => void };
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
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) throw new Error("元素不可见（零尺寸）");
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    },

    confirmForClick(target: string): SideAgentRect {
      const el = mustResolve(target);
      scrollIntoView(el);
      const r = el.getBoundingClientRect();
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
        el.textContent = value;
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { filled: true };
      }
      throw new Error("元素不可填充（非 input/textarea/contenteditable）");
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
