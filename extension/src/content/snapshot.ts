/**
 * 页面快照 content script（ISOLATED world，重复注入幂等）。
 * 暴露 window.__sideagent.snapshot(scope?: "full_page" | "viewport") → 文本快照。
 * 输出形如：
 *   [ref=3] button "提交" loc=css:#submit
 *   text: 欢迎来到……
 * ref 存于 window.__sideagent.refs（每次快照重建，同一元素尽量保号）。
 */
(function () {
  const ns = (window.__sideagent ??= {});
  if (typeof ns.snapshot === "function") return;

  const MAX_OUTPUT = 12_000;
  const MAX_TEXT_LINE = 200;
  const MAX_LABEL = 60;

  const SKIP_TAGS = new Set([
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "link",
    "meta",
    "title",
    "head",
    "br",
    "hr",
  ]);

  const INTERESTING_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "textbox",
    "combobox",
    "listbox",
    "option",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab",
    "switch",
    "slider",
    "spinbutton",
    "searchbox",
    "heading",
    "img",
    "treeitem",
  ]);

  // 元素 → 上一次快照分配的 ref 号（跨快照保号用）
  const prevRefs: WeakMap<Element, number> =
    (ns as unknown as { __prevRefs?: WeakMap<Element, number> }).__prevRefs ?? new WeakMap();
  (ns as unknown as { __prevRefs: WeakMap<Element, number> }).__prevRefs = prevRefs;

  ns.refs ??= new Map<number, Element>();

  function pad(depth: number): string {
    return "  ".repeat(depth);
  }

  function clean(s: string, max: number): string {
    const t = s.replace(/\s+/g, " ").trim().replace(/"/g, "'");
    return t.length > max ? `${t.slice(0, max - 3)}...` : t;
  }

  ns.snapshot = function snapshot(scope?: string): string {
    const viewportOnly = scope === "viewport";
    const refs = new Map<number, Element>();
    ns.refs = refs;
    const usedRefs = new Set<number>();
    let refCursor = 0;
    const lines: string[] = [];
    const described = new Set<Element>();

    function assignRef(el: Element): number {
      let n = prevRefs.get(el);
      if (n === undefined || usedRefs.has(n)) {
        do {
          refCursor += 1;
        } while (usedRefs.has(refCursor));
        n = refCursor;
        prevRefs.set(el, n);
      }
      usedRefs.add(n);
      refs.set(n, el);
      return n;
    }

    function isVisible(el: Element): boolean {
      const anyEl = el as unknown as { checkVisibility?: (o?: object) => boolean };
      if (typeof anyEl.checkVisibility === "function") {
        try {
          if (!anyEl.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
        } catch {
          /* 继续用尺寸判断 */
        }
      } else {
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || st.visibility === "collapse") return false;
        if (st.opacity === "0") return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }

    function inViewport(el: Element): boolean {
      const r = el.getBoundingClientRect();
      return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
    }

    /** 生成 querySelector 可回查的稳定定位串：#id，或沿祖先的 tag:nth-of-type(n) 路径 */
    function cssLoc(el: Element): string {
      const elId = (el as HTMLElement).id;
      if (elId) return `#${CSS.escape(elId)}`;
      const parts: string[] = [];
      let cur: Element | null = el;
      while (cur) {
        const tag = cur.tagName.toLowerCase();
        if (tag === "body" || tag === "html") {
          parts.unshift(tag);
          break;
        }
        const id = (cur as HTMLElement).id;
        if (id) {
          parts.unshift(`#${CSS.escape(id)}`);
          break;
        }
        const parent: Element | null = cur.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        let idx = 1;
        for (const sib of Array.from(parent.children)) {
          if (sib === cur) break;
          if (sib.tagName === cur.tagName) idx += 1;
        }
        parts.unshift(`${tag}:nth-of-type(${idx})`);
        cur = parent;
      }
      return parts.join(" > ");
    }

    function emitLine(el: Element, text: string): string {
      const n = assignRef(el);
      described.add(el);
      return `[ref=${n}] ${text} loc=css:${cssLoc(el)}`;
    }

    /** 语义/可交互元素 → 描述行；不感兴趣的元素返回 null */
    function describe(el: Element): string | null {
      const tag = el.tagName.toLowerCase();
      const he = el as HTMLElement;
      const explicitRole = el.getAttribute("role")?.toLowerCase() ?? null;

      if (tag === "input") {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (type === "hidden") return null;
        let d = `input[type=${type}`;
        const ph = el.getAttribute("placeholder");
        if (ph) d += ` placeholder="${clean(ph, MAX_LABEL)}"`;
        else {
          const aria = el.getAttribute("aria-label") ?? el.getAttribute("name");
          if (aria) d += ` "${clean(aria, MAX_LABEL)}"`;
        }
        return emitLine(el, `${d}]`);
      }
      if (tag === "textarea") {
        let d = "textarea";
        const ph = el.getAttribute("placeholder");
        if (ph) d += ` placeholder="${clean(ph, MAX_LABEL)}"`;
        return emitLine(el, d);
      }

      let kind: string | null = null;
      let label = "";
      if (tag === "a") {
        kind = "link";
        label = clean(el.textContent ?? "", MAX_LABEL);
      } else if (tag === "button") {
        kind = "button";
        label = clean(el.textContent ?? "", MAX_LABEL);
      } else if (tag === "select") {
        kind = "select";
        const se = el as HTMLSelectElement;
        label = clean(se.selectedOptions?.[0]?.textContent ?? el.getAttribute("name") ?? "", MAX_LABEL);
      } else if (/^h[1-6]$/.test(tag)) {
        kind = "heading";
        label = clean(el.textContent ?? "", MAX_LABEL);
      } else if (tag === "img") {
        const alt = el.getAttribute("alt");
        if (!alt && explicitRole !== "img") return null;
        kind = "img";
        label = clean(alt ?? "", MAX_LABEL);
      } else if (explicitRole && INTERESTING_ROLES.has(explicitRole)) {
        kind = explicitRole;
        label = clean(el.getAttribute("aria-label") ?? el.textContent ?? "", MAX_LABEL);
      } else if (tag === "summary") {
        kind = "summary";
        label = clean(el.textContent ?? "", MAX_LABEL);
      } else if (he.isContentEditable || el.getAttribute("onclick") !== null || he.tabIndex >= 0) {
        kind = explicitRole ?? tag;
        label = clean(el.textContent ?? "", MAX_LABEL);
      } else {
        return null;
      }
      return emitLine(el, label ? `${kind} "${label}"` : kind);
    }

    function processText(node: Text, depth: number): void {
      const parent = node.parentElement;
      if (!parent) return;
      if (described.has(parent)) return; // 文本已包含在描述里
      const s = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      if (!s) return;
      if (viewportOnly && !inViewport(parent)) return;
      const line = s.length > MAX_TEXT_LINE ? `${s.slice(0, MAX_TEXT_LINE - 3)}...` : s;
      lines.push(`${pad(depth)}text: ${line}`);
    }

    function walkChildren(root: Document | Element | ShadowRoot, depth: number): void {
      for (const child of Array.from(root.childNodes)) {
        if (child.nodeType === 1) walkElement(child as Element, depth);
        else if (child.nodeType === 3) processText(child as Text, depth);
      }
    }

    function walkElement(el: Element, depth: number): void {
      const tag = el.tagName.toLowerCase();
      if (SKIP_TAGS.has(tag)) return;
      if (!isVisible(el)) return;

      if (tag === "iframe") {
        const src = clean(el.getAttribute("src") ?? "about:blank", 120);
        lines.push(`${pad(depth)}[iframe src=${src}]`);
        let doc: Document | null = null;
        try {
          doc = (el as HTMLIFrameElement).contentDocument;
        } catch {
          doc = null; // 跨域：一行带过
        }
        if (doc?.documentElement) walkChildren(doc, depth + 1); // 同源：递归并标注
        return;
      }

      if (!viewportOnly || inViewport(el)) {
        const d = describe(el);
        if (d) lines.push(pad(depth) + d);
      }

      if (el.shadowRoot) walkChildren(el.shadowRoot, depth + 1); // open shadow root 递归
      walkChildren(el, depth);
    }

    if (document.documentElement) walkElement(document.documentElement, 0);

    let out = "";
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const addition = (out ? "\n" : "") + line;
      if (out.length + addition.length > MAX_OUTPUT) {
        out += `\n... [truncated, ${lines.length - i} more elements]`;
        return out;
      }
      out += addition;
    }
    return out;
  };
})();
