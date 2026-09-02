/**
 * DOM 操作 content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.dom = { resolve, rectOf, click, fill, scrollBy, scrollToBottom }。
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
      if (!el || !el.isConnected) throw new Error(`ref ${target} 已失效，请重新 snapshot`);
      return el;
    }
    const sel = target.startsWith("loc=css:") ? target.slice("loc=css:".length) : target;
    let el: Element | null = null;
    try {
      el = document.querySelector(sel);
    } catch {
      throw new Error(`无效的选择器: ${sel}`);
    }
    if (!el) throw new Error(`未找到元素: ${sel}`);
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
      el.dispatchEvent(new MouseEvent("mouseup", common));
      el.dispatchEvent(new MouseEvent("click", common));
      // 兜底触发默认行为（如 <a> 跳转）
      (el as HTMLElement).click();
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
