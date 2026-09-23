import type { PointSelection } from "../../../shared/point-selection.js";

/** 独立隔离世界里的点选层。用户点击的是遮罩，不是网页原控件。 */
(() => {
  const ns = (window.__sideagent ??= {});

  if (ns.point) return;

  let active: { id: string; finish: (result: PointSelection) => void } | undefined;

  function targetOf(element: Element): string {
    const parts: string[] = [];
    let node: Element | null = element;

    while (node && node !== document.documentElement) {
      if (node.id) {
        const id = `#${CSS.escape(node.id)}`;

        if (document.querySelectorAll(id).length === 1) {
          parts.unshift(id);
          break;
        }
      }

      const parent: Element | null = node.parentElement;
      const tagName = node.localName;
      const siblings = parent ? [...parent.children].filter(child => child.localName === tagName) : [node];
      parts.unshift(`${CSS.escape(node.localName)}:nth-of-type(${siblings.indexOf(node) + 1})`);
      node = parent;
    }

    const selector = parts.join(" > ");

    if (!selector || !element.isConnected || document.querySelectorAll(selector).length !== 1 || document.querySelector(selector) !== element) {
      throw new Error("目标已变化，请重新指一下。");
    }

    return `loc=css:${selector}`;
  }

  const readableText = (element: Element) => (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
  const nameOf = (element: Element) => (element.getAttribute("aria-label") || element.getAttribute("title") || element.getAttribute("alt") || readableText(element) || element.localName).slice(0, 160);

  function start(id: string, message: string, timeoutMs: number): Promise<PointSelection> {
    if (active) throw new Error("此页面已有点选请求，请先完成或取消它。");

    const host = document.createElement("div");
    host.setAttribute("data-sideagent-point", "");
    host.setAttribute("popover", "manual");
    host.tabIndex = -1;
    host.style.cssText = "all:initial!important;position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;overflow:hidden!important;z-index:2147483647!important;pointer-events:auto!important;outline:none!important";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host{cursor:crosshair}*{box-sizing:border-box}
      .hint{position:fixed;top:16px;left:50%;transform:translateX(-50%);max-width:min(620px,92vw);padding:12px 18px;border:1px solid #d6dce4;border-radius:12px;background:#fff;color:#1f2937;box-shadow:0 4px 24px #0002;font:14px/1.5 system-ui,sans-serif;text-align:center;pointer-events:none}
      .help{display:block;color:#667085;font-size:12px;margin-top:4px}
      .outline{display:none;position:fixed;border:2px solid #4778a8;background:#4778a815;border-radius:6px;pointer-events:none}
      .name{position:absolute;top:100%;left:0;margin-top:5px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;padding:3px 7px;border-radius:4px;background:#244764;color:#fff;font:12px/1.5 system-ui,sans-serif}
    `;
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.setAttribute("role", "status");
    const instruction = document.createElement("span");
    instruction.textContent = message.trim().slice(0, 300) || "请点一下你指的元素";
    const help = document.createElement("span");
    help.className = "help";
    help.textContent = "只选择，不触发网页操作 · 按 Esc 取消";
    hint.append(instruction, help);
    const outline = document.createElement("div");
    outline.className = "outline";
    const name = document.createElement("span");
    name.className = "name";
    outline.append(name);
    root.append(style, outline, hint);
    const previousFocus = document.activeElement;
    document.documentElement.append(host);

    try {
      host.showPopover();
      host.focus({ preventScroll: true });
    } catch (error) {
      host.remove();
      throw error;
    }

    return new Promise<PointSelection>(resolve => {
      const listeners = new AbortController();
      let finished = false;

      const finish = (result: PointSelection) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        listeners.abort();
        host.remove();
        active = undefined;

        if (result.status !== "cancelled" || result.reason !== "page_changed") {
          if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
        }

        resolve(result);
      };

      const timer = setTimeout(() => finish({ status: "timed_out" }), timeoutMs);
      active = { id, finish };
      const options = { capture: true, passive: false, signal: listeners.signal };

      const swallow = (event: Event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
      };

      const hitAt = (event: MouseEvent): Element | null => {
        if (event.composedPath().includes(hint)) return null;
        const hit = document.elementsFromPoint(event.clientX, event.clientY).find(el => el !== host && !host.contains(el));

        if (!hit || hit === document.body || hit === document.documentElement) return null;

        if (hit.matches("iframe, object, embed") || hit.shadowRoot || hit.localName.includes("-")) {
          help.textContent = "暂不支持框架或自定义组件内部点选 · 按 Esc 取消";

          return null;
        }

        return hit.closest("button,a[href],input,select,textarea,[role=button],[role=link],[role=checkbox],[role=menuitem]") ?? hit;
      };

      host.addEventListener("pointermove", event => {
        swallow(event);
        const element = hitAt(event);
        outline.style.display = element ? "block" : "none";

        if (!element) return;
        const r = element.getBoundingClientRect();
        Object.assign(outline.style, { left: `${r.x - 3}px`, top: `${r.y - 3}px`, width: `${r.width + 6}px`, height: `${r.height + 6}px` });
        name.textContent = nameOf(element);
      }, options);

      for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "dblclick", "auxclick", "contextmenu"]) {
        host.addEventListener(type, swallow, options);
      }

      host.addEventListener("click", event => {
        swallow(event);

        if (!event.isTrusted || event.button !== 0) return;
        const element = hitAt(event);

        if (!element) return;

        try {
          const target = targetOf(element);
          const r = element.getBoundingClientRect();
          finish({ status: "selected", element: { target, tagName: element.localName, name: nameOf(element), text: readableText(element), rect: { x: r.x, y: r.y, width: r.width, height: r.height } } });
        } catch {
          help.textContent = "目标已变化，请重新指一下 · 按 Esc 取消";
        }
      }, options);
      window.addEventListener("keydown", event => {
        if (!event.isTrusted) return;

        if (event.key === "Escape") {
          swallow(event);
          finish({ status: "cancelled", reason: "user" });
        } else if (!event.ctrlKey && !event.metaKey) swallow(event);
      }, options);
      window.addEventListener("pagehide", () => finish({ status: "cancelled", reason: "page_changed" }), { once: true, signal: listeners.signal });
    });
  }

  ns.point = {
    start,
    cancel(id) { if (active?.id === id) active.finish({ status: "cancelled", reason: "task_cancelled" }); },
  };
})();
