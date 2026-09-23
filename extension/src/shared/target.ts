/**
 * 统一 target 定位串解析（element-target 操作共享这一层）：
 *   "@N"                        — snapshot 输出中的 ref
 *   "loc=css:..."               — snapshot 给出的稳定定位串（去掉前缀即 CSS；穿 open shadow）
 *   "loc=role:…[name='…']"      — 可访问名（≠ textContent）+ role；name*= 为子串
 *   "loc=href:..."              — 按链接 href 子串定位
 *   "xpath=..."                 — XPath（各文档内 evaluate，要求唯一）
 *   "text=..."                  — 文本语义定位（规范化后唯一最深匹配，优先可见）
 *   其他非空字符串               — 原始 CSS（穿 open shadow；同源 frame 有作用域）
 * 非法输入返回 null。`:has-text` 等 Playwright 伪类仍拒绝（未实现正式语义）。
 */
export type ParsedTarget =
  | { kind: "ref"; n: number }
  | { kind: "css"; sel: string }
  | { kind: "loc"; sel: string }
  | { kind: "xpath"; sel: string }
  | { kind: "text"; sel: string }
  | { kind: "role"; role: string; name: string; nameMatch: "exact" | "substring" }
  | { kind: "href"; href: string };

const LOC_CSS = "loc=css:";
const LOC_ROLE = "loc=role:";
const LOC_HREF = "loc=href:";

/** 解析 loc=role:button[name="Save"] / name*="part"（引号可单可双）。 */
function parseRoleLocator(body: string): ParsedTarget | null {
  const m = /^([A-Za-z0-9_-]+)\[name(\*=|=)(["'])([\s\S]*)\3\]$/.exec(body.trim());
  if (!m) return null;
  const role = m[1]!.toLowerCase();
  const nameMatch = m[2] === "*=" ? "substring" : "exact";
  const name = m[4]!;
  if (!role || !name) return null;
  return { kind: "role", role, name, nameMatch };
}

export function parseTarget(raw: unknown): ParsedTarget | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  if (s.startsWith("@")) {
    const rest = s.slice(1);
    if (!/^\d+$/.test(rest)) return null;
    const n = Number(rest);
    if (!Number.isSafeInteger(n) || n < 1) return null;
    return { kind: "ref", n };
  }

  if (s.startsWith(LOC_ROLE)) {
    return parseRoleLocator(s.slice(LOC_ROLE.length));
  }

  if (s.startsWith(LOC_HREF)) {
    const href = s.slice(LOC_HREF.length).trim();
    return href ? { kind: "href", href } : null;
  }

  if (s.startsWith(LOC_CSS)) {
    const sel = s.slice(LOC_CSS.length).trim();
    return sel ? { kind: "loc", sel } : null;
  }

  if (s.startsWith("xpath=")) {
    const sel = s.slice("xpath=".length).trim();
    return sel ? { kind: "xpath", sel } : null;
  }

  if (s.startsWith("text=")) {
    const sel = s.slice("text=".length).trim();
    return sel ? { kind: "text", sel } : null;
  }

  // 未知 loc= 前缀（如 loc=h3:has-text）仍当作原始字符串进 CSS 分支，
  // 由 resolve 抛出明确的「不支持 :has-text」文案；不要静默吞掉。
  return { kind: "css", sel: s };
}

/** 把 ParsedTarget 编成 resolveTargetSelector 的 (kind, selector) 对；role/href 用 JSON。 */
export function resolveArgs(parsed: Exclude<ParsedTarget, { kind: "ref" }>): { kind: string; selector: string } {
  if (parsed.kind === "role") {
    return {
      kind: "role",
      selector: JSON.stringify({ role: parsed.role, name: parsed.name, nameMatch: parsed.nameMatch }),
    };
  }
  if (parsed.kind === "href") {
    return { kind: "href", selector: parsed.href };
  }
  if (parsed.kind === "loc") {
    return { kind: "css", selector: parsed.sel };
  }
  return { kind: parsed.kind, selector: parsed.sel };
}

/**
 * 在页面里把非 ref 的 target 解析成唯一元素。
 * 自包含：本函数会被 toString 序列化进 ISOLATED world 和 CDP Runtime.evaluate，
 * 不得引用任何模块作用域；语义（唯一匹配、错误文案）由这里统一拥有，
 * domops.mustResolve 与 upload/read_element 的 CDP 路径共用。
 *
 * 同源 iframe：先 top document，零命中再搜 frame；任一作用域多命中 → 歧义失败。
 * 跨站 OOPIF 的 contentDocument 不可读，须走宿主 child session（不在本函数内）。
 */
export function resolveTargetSelector(kind: string, selector: string): Element {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  const lower = (value: string) => normalize(value).toLowerCase();

  function queryAllOpenShadow(root: Document | ShadowRoot, css: string): Element[] {
    const matches: Element[] = [];
    const queue: Array<Document | ShadowRoot> = [root];
    while (queue.length) {
      const scope = queue.pop()!;
      let found: NodeListOf<Element>;
      try {
        found = scope.querySelectorAll(css);
      } catch {
        throw new Error(
          "无效的选择器: " +
            css +
            "。操作未执行。target 支持 @N、loc=css:原生CSS、原生 CSS、loc=role:…[name=…]、loc=href:、xpath=、text=；不支持 loc=h3...、:has-text() 等 Playwright 定位语法。请先 snapshot，从当前结果选择目标后重试。",
        );
      }
      for (let i = 0; i < found.length; i++) matches.push(found[i]!);
      const all = scope.querySelectorAll("*");
      for (let i = 0; i < all.length; i++) {
        const shadow = (all[i] as Element).shadowRoot;
        if (shadow) queue.push(shadow);
      }
    }
    return matches;
  }

  function sameOriginDocuments(): Document[] {
    const docs: Document[] = [document];
    const queue: Document[] = [document];
    while (queue.length) {
      const doc = queue.shift()!;
      const frames = doc.querySelectorAll("iframe");
      for (let i = 0; i < frames.length; i++) {
        try {
          const child = (frames[i] as HTMLIFrameElement).contentDocument;
          if (child && docs.indexOf(child) < 0) {
            docs.push(child);
            queue.push(child);
          }
        } catch {
          /* 跨站 OOPIF：contentDocument 不可读 */
        }
      }
    }
    return docs;
  }

  function pickUnique(pool: Element[], label: string): Element {
    if (pool.length === 0) {
      throw new Error(
        "未找到元素: " +
          label +
          "。操作未执行。请重新 snapshot 确认当前页面中的目标" +
          (label.indexOf("role:") >= 0 ? "；ARIA 可访问名不等于显示文本" : "") +
          "。",
      );
    }
    if (pool.length > 1) {
      throw new Error(
        "选择器匹配 " +
          pool.length +
          " 个元素: " +
          label +
          "。操作未执行。请 snapshot 确认目标，使用目标 ref 或更具体的唯一定位；跨 frame/区域同名不会自动选择第一个匹配。",
      );
    }
    return pool[0]!;
  }

  /** 先 top，再同源 frame；顶层有唯一命中即返回，不扫 frame。 */
  function resolveAcrossDocuments(findIn: (doc: Document) => Element[], label: string): Element {
    const docs = sameOriginDocuments();
    const top = findIn(docs[0]!);
    if (top.length === 1) return top[0]!;
    if (top.length > 1) {
      throw new Error(
        "选择器匹配 " +
          top.length +
          " 个元素: " +
          label +
          "。操作未执行。请 snapshot 确认目标，使用目标 ref 或更具体的唯一 CSS；不会自动选择第一个匹配。",
      );
    }
    const frameHits: Element[] = [];
    for (let i = 1; i < docs.length; i++) {
      const hits = findIn(docs[i]!);
      for (let j = 0; j < hits.length; j++) frameHits.push(hits[j]!);
    }
    return pickUnique(frameHits, label);
  }

  function accessibleName(el: Element): string {
    const aria = el.getAttribute("aria-label");
    if (aria && normalize(aria)) return normalize(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? "")
        .join(" ");
      if (normalize(text)) return normalize(text);
    }
    const html = el as HTMLElement & { labels?: NodeListOf<HTMLLabelElement> };
    if (html.labels && html.labels.length) {
      const text = Array.prototype.map.call(html.labels, (lab: HTMLLabelElement) => lab.textContent ?? "").join(" ");
      if (normalize(text as string)) return normalize(text as string);
    }
    if (el.tagName === "IMG") {
      const alt = el.getAttribute("alt");
      if (alt && normalize(alt)) return normalize(alt);
    }
    if (el.tagName === "INPUT") {
      const input = el as HTMLInputElement;
      if (["button", "submit", "reset"].indexOf(input.type) >= 0 && input.value) return normalize(input.value);
    }
    const title = el.getAttribute("title");
    if (title && normalize(title)) return normalize(title);
    // 无显式 ARIA/label 时才回退 textContent（与 aria-label 不同时不得用显示文本伪装）。
    return normalize(el.textContent ?? "");
  }

  function implicitRole(el: Element): string {
    const explicit = (el.getAttribute("role") || "").trim().toLowerCase().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.tagName.toUpperCase();
    if (tag === "BUTTON" || tag === "SUMMARY") return "button";
    if (tag === "A" || tag === "AREA") return el.hasAttribute("href") ? "link" : "";
    if (tag === "INPUT") {
      const type = ((el as HTMLInputElement).type || "text").toLowerCase();
      if (type === "button" || type === "submit" || type === "reset" || type === "image") return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "search") return "searchbox";
      return "textbox";
    }
    if (tag === "SELECT") return "combobox";
    if (tag === "TEXTAREA") return "textbox";
    if (tag === "OPTION") return "option";
    if (tag === "IMG") return "img";
    if ((el as HTMLElement).isContentEditable) return "textbox";
    return "";
  }

  function isVisible(el: Element): boolean {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && s.visibility !== "collapse";
  }

  if (kind === "xpath") {
    return resolveAcrossDocuments((doc) => {
      let list: Element[] = [];
      try {
        const evaluated = doc.evaluate(selector, doc, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        list = [];
        for (let i = 0; i < evaluated.snapshotLength; i++) {
          const node = evaluated.snapshotItem(i);
          if (node && node.nodeType === 1) list.push(node as Element);
        }
      } catch (error) {
        throw new Error(
          "无效的 XPath: " + selector + "（" + String(error instanceof Error ? error.message : error) + "）。操作未执行。请检查 xpath= 表达式后重试。",
        );
      }
      return list;
    }, "xpath=" + selector);
  }

  if (kind === "text") {
    const wanted = lower(selector);
    if (!wanted) throw new Error("text= 定位不能为空。操作未执行。");
    return resolveAcrossDocuments((doc) => {
      const all = queryAllOpenShadow(doc, "*");
      const matches: Element[] = [];
      for (let i = 0; i < all.length; i++) {
        const el = all[i]!;
        const own = lower(el.textContent ?? "");
        if (own === wanted) matches.push(el);
      }
      const innermost = matches.filter((el) => !matches.some((other) => other !== el && el.contains(other)));
      const visible = innermost.filter(isVisible);
      return visible.length ? visible : innermost;
    }, "text=" + selector);
  }

  if (kind === "href") {
    const wanted = selector;
    if (!wanted) throw new Error("loc=href: 不能为空。操作未执行。");
    return resolveAcrossDocuments(
      (doc) =>
        queryAllOpenShadow(doc, "a[href], area[href]").filter((el) => {
          const href = el.getAttribute("href") ?? "";
          return href.indexOf(wanted) >= 0;
        }),
      "loc=href:" + wanted,
    );
  }

  if (kind === "role") {
    let spec: { role: string; name: string; nameMatch: "exact" | "substring" };
    try {
      spec = JSON.parse(selector) as { role: string; name: string; nameMatch: "exact" | "substring" };
    } catch {
      throw new Error("无效的 role 定位。操作未执行。期望 loc=role:<role>[name=\"…\"] 或 name*=\"…\"。");
    }
    const role = String(spec.role || "").toLowerCase();
    const nameWanted = normalize(String(spec.name || ""));
    const substring = spec.nameMatch === "substring";
    if (!role || !nameWanted) throw new Error("loc=role: 需要 role 与 name。操作未执行。");
    const label = "loc=role:" + role + "[name" + (substring ? "*=" : "=") + JSON.stringify(nameWanted) + "]";
    return resolveAcrossDocuments((doc) => {
      const candidates = queryAllOpenShadow(doc, "*").filter((el) => implicitRole(el) === role);
      const named = candidates.filter((el) => {
        const an = accessibleName(el);
        if (!an) return false;
        if (substring) return lower(an).indexOf(lower(nameWanted)) >= 0;
        return an === nameWanted;
      });
      // 可见优先；全隐藏时仍返回隐藏命中以便 attached 等待，但多可见歧义失败。
      const visible = named.filter(isVisible);
      const pool = visible.length ? visible : named;
      if (pool.length > 1) {
        throw new Error(
          "选择器匹配 " +
            pool.length +
            " 个元素: " +
            label +
            "。操作未执行。请 snapshot 确认目标，使用目标 ref 或更具体的唯一定位；重复名字不会自动选择第一个匹配。",
        );
      }
      return pool;
    }, label);
  }

  // css / loc=css:
  return resolveAcrossDocuments((doc) => queryAllOpenShadow(doc, selector), selector);
}
