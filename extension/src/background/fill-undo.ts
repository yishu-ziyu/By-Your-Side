import { SENSITIVE_FIELD_NAME } from "../../../shared/trace-sanitize.js";
import { FILL_UNDO_SUBMIT, type FillUndoNote, type FillUndoView } from "../relay.js";
import { callDom, callOnBackendNode, ensureDomOps } from "./exec/input.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { parseExecutionKey } from "./tab-bindings.js";

/**
 * 还原填写：助手这一轮在网页上填过、选过、勾过的格子，记下它动手前的样子，用户要时写回去。
 * 动手前的值只放在这个后台的内存里：不进工具回执、不进 storage、不进日志、不发给模型；面板只拿到数量、栏名和状态。
 * 记录活到下一轮任务开始、页面换了文档、或者用户点了还原；扩展后台重启就没了，这时按「页面变了」答复。
 * 格子在网页上挂一个随机记号（data-sideagent-undo），还原时按记号找回同一个元素；用户后来改过的格子（和助手写完后读回的值不一样）不动。
 * 编辑器（contenteditable）和原来有内容的密码这类栏这一版不还原，只在 notes 里说明。
 */

type UndoKind = "text" | "select" | "check" | "radio" | "rich" | "other";

/** 一栏的样子：文字栏的值、下拉框选中的序号、勾选框和单选框是否选中。敏感栏的非空值在页面里就换成摘要，不带出来。 */
type UndoState = { value?: string; indexes?: number[]; checked?: boolean };

type UndoProbe = { token: string | null; peer: string | null; name: string; kind: UndoKind; sensitive: boolean; state: UndoState | null; submits: boolean; enterSubmits: boolean };

type UndoOutcome = "restored" | "user_changed" | "gone" | "failed";

/** 页面里怎么找到这一栏：AX 引用的节点、定位串、点击落点，或者当前焦点。 */
export type UndoWhere = { backendNodeId: number } | { target: string } | { point: [number, number] } | { focused: true };

interface Entry { token: string; name: string; kind: "text" | "select" | "check" | "radio"; sensitive: boolean; before: UndoState; after: UndoState; peer: string | null; backendNodeId?: number }

interface TabLedger { documentId: string; entries: Map<string, Entry>; closed?: "submitted" | "page_changed" }

interface Ledger { tabs: Map<number, TabLedger>; notes: Set<FillUndoNote>; result?: FillUndoView; restoring?: boolean }

const ledgers = new Map<string, Ledger>();
const watchers = new Map<string, (view: FillUndoView | null) => void>();

/**
 * 页面里执行，保持自包含（经 CDP 按节点调用，或 executeScript）。this 是元素（CDP 按节点调用）；否则按 where 找。
 * probe：动手前读这一栏，挂记号；read：按记号读现在的样子；restore：按记号核对后写回。
 * 敏感栏的分类同 exec/input.ts 的 readFieldInPage。
 */
function undoInPage(this: unknown, op: "probe" | "read" | "restore", arg: {
  where?: { target?: string; point?: [number, number]; focused?: true };
  token?: string; peerToken?: string; sensitiveName?: string;
  entry?: { token: string; kind: UndoKind; sensitive: boolean; before: UndoState; after: UndoState; peer: string | null };
}): unknown {
  const ATTR = "data-sideagent-undo";
  const self = this && typeof this === "object" && (this as Node).nodeType === 1 ? this as Element : null;

  /** 按记号找：页面、打开的 shadow root、同源 iframe。 */
  const findToken = (token: string): Element | null => {
    const roots: Array<Document | ShadowRoot> = [document];

    for (let i = 0; i < roots.length && i < 200; i++) {
      const hit = roots[i]!.querySelector(`[${ATTR}="${token}"]`);

      if (hit) return hit;

      for (const node of roots[i]!.querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);

        if (node.tagName === "IFRAME") {
          try { const doc = (node as HTMLIFrameElement).contentDocument; if (doc) roots.push(doc); } catch { /* 跨域 */ }
        }
      }
    }

    return null;
  };

  const kindOf = (el: Element): UndoKind => {
    if (el.tagName === "INPUT") {
      const type = (el as HTMLInputElement).type;

      return type === "checkbox" ? "check" : type === "radio" ? "radio" : /^(file|submit|button|image|reset|hidden)$/.test(type) ? "other" : "text";
    }

    return el.tagName === "TEXTAREA" ? "text" : el.tagName === "SELECT" ? "select" : (el as HTMLElement).isContentEditable ? "rich" : "other";
  };

  /** 敏感栏的非空值只给摘要：够比较「改过没有」，带不出原文。 */
  const digest = (text: string) => {
    let h = 2166136261;

    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);

    return `#${(h >>> 0).toString(36)}`;
  };

  const stateOf = (el: Element, kind: UndoKind, sensitive: boolean): UndoState | null => {
    if (kind === "text") { const value = (el as HTMLInputElement).value; return { value: sensitive && value !== "" ? digest(value) : value }; }

    if (kind === "select") return { indexes: [...(el as HTMLSelectElement).options].flatMap((option, i) => option.selected ? [i] : []) };

    if (kind === "check" || kind === "radio") return { checked: (el as HTMLInputElement).checked };

    return null;
  };

  const same = (a: UndoState | null, b: UndoState | null) => JSON.stringify(a) === JSON.stringify(b);

  if (op === "read" || op === "restore") {
    const entry = arg.entry!;
    const el = self ?? findToken(entry.token);

    if (op === "read") return el ? stateOf(el, entry.kind, entry.sensitive) : null;

    if (!el || !el.isConnected) return "gone";

    if (!same(stateOf(el, entry.kind, entry.sensitive), entry.after)) return "user_changed";

    // 写法同助手填写：原生 setter + 冒泡的 input/change，React 这类受控输入才认。
    const fire = (node: Element) => { node.dispatchEvent(new Event("input", { bubbles: true })); node.dispatchEvent(new Event("change", { bubbles: true })); };
    const setNative = (node: Element, key: "value" | "checked", value: string | boolean) => {
      const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), key);

      if (desc?.set) desc.set.call(node, value);
      else (node as unknown as Record<string, unknown>)[key] = value;
    };

    if (entry.kind === "text") { setNative(el, "value", entry.before.value ?? ""); fire(el); }
    else if (entry.kind === "select") { [...(el as HTMLSelectElement).options].forEach((option, i) => { option.selected = !!entry.before.indexes?.includes(i); }); fire(el); }
    else if (entry.kind === "check") { if ((el as HTMLInputElement).checked !== entry.before.checked) (el as HTMLElement).click(); }
    else if (entry.kind === "radio") {
      // 单选框：把原来选中的那一项重新选上；原来一项都没选，就取消这一项。
      const peer = entry.peer ? findToken(entry.peer) as HTMLInputElement | null : null;

      if (peer) { if (!peer.checked) peer.click(); return peer.checked ? "restored" : "failed"; }

      if ((el as HTMLInputElement).checked) { setNative(el, "checked", false); fire(el); }
    }

    return same(stateOf(el, entry.kind, entry.sensitive), entry.before) ? "restored" : "failed";
  }

  // probe：找到这一栏。点击落点穿过 shadow root 和同源 iframe；点在 <label> 上算它管的那个控件。
  let el: Element | null = self;
  const where = arg.where ?? {};

  if (!el && where.point) {
    let [x, y] = where.point;
    el = document.elementFromPoint(x, y);

    for (let depth = 0; el && depth < 20; depth++) {
      const inner: Element | null = el.shadowRoot ? el.shadowRoot.elementFromPoint(x, y) : null;

      if (inner && inner !== el) { el = inner; continue; }

      if (el.tagName !== "IFRAME") break;

      try {
        const doc = (el as HTMLIFrameElement).contentDocument;
        const rect = el.getBoundingClientRect();

        if (!doc) break;
        x -= rect.left + el.clientLeft;
        y -= rect.top + el.clientTop;
        el = doc.elementFromPoint(x, y);
      } catch { break; }
    }
  } else if (!el && where.target) {
    el = (window as unknown as { __sideagent?: { dom?: { resolve(target: string): Element | null } } }).__sideagent?.dom?.resolve(where.target) ?? null;
  } else if (!el) {
    el = document.activeElement;

    for (let depth = 0; el && depth < 20; depth++) {
      let inner: Element | null | undefined = el.shadowRoot?.activeElement;

      if (!inner && el.tagName === "IFRAME") {
        try { inner = (el as HTMLIFrameElement).contentDocument?.activeElement; } catch { inner = null; }
      }

      if (!inner || inner === el) break;
      el = inner;
    }
  }

  if (!el) return null;
  const raw = el;
  const host = (el.getRootNode?.() as ShadowRoot | undefined)?.host;

  if (host?.tagName === "INPUT" && (host as HTMLInputElement).type === "time") el = host;
  else if (kindOf(el) === "other") { const control = (el.closest("label") as HTMLLabelElement | null)?.control; if (control) el = control; }

  const kind = kindOf(el);
  const field = el as HTMLInputElement;
  const by = field.getAttribute("aria-labelledby");
  const name = (field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || ("labels" in field && field.labels?.[0] && (field.labels[0].textContent ?? "").replace(field.labels[0].contains(field) ? field.textContent ?? "" : "", "")) || field.getAttribute("placeholder") || field.getAttribute("title") || field.getAttribute("name") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  const sensitive = kind === "text" && ((field.tagName === "INPUT" && (field.type === "password" || field.hasAttribute("data-bys-was-password")))
    || /one-time-code|cc-(number|csc|exp)/i.test(String(field.getAttribute("autocomplete") ?? ""))
    || new RegExp(arg.sensitiveName ?? "$^", "i").test([field.getAttribute("name"), field.id, name, field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title")].map((part) => normalize(String(part ?? ""))).join(" ")));

  if (field.tagName === "INPUT" && field.type === "password") field.setAttribute("data-bys-was-password", "");

  // 提交：点的是这张表单的提交按钮，或在它的单行栏里按回车；表单里要有助手填过的格子。
  const formHasMarks = (form: HTMLFormElement | null | undefined) => !!form && [...form.elements].some((node) => node.hasAttribute(ATTR));
  const button = raw.closest("button, input[type=submit], input[type=image]") as HTMLButtonElement | null;
  const submits = !!button && button.type === "submit" && formHasMarks(button.form);
  const enterSubmits = field.tagName === "INPUT" && kind === "text" && formHasMarks(field.form);
  const state = stateOf(el, kind, sensitive);
  // 原来有内容的敏感栏：不挂记号、不带值出去，这一版不还原。
  const keep = (kind === "text" || kind === "select" || kind === "check" || kind === "radio") && !(sensitive && field.value !== "");
  let token: string | null = null;
  let peer: string | null = null;

  if (keep) {
    token = el.getAttribute(ATTR) || arg.token!;
    el.setAttribute(ATTR, token);

    if (kind === "radio" && field.name) {
      const scope: ArrayLike<Element> = field.form ? field.form.elements : (field.getRootNode() as Document | ShadowRoot).querySelectorAll("input[type=radio]");
      const checked = Array.from(scope).find((node) => node !== field && node.tagName === "INPUT" && (node as HTMLInputElement).type === "radio"
        && (node as HTMLInputElement).name === field.name && (node as HTMLInputElement).form === field.form && (node as HTMLInputElement).checked);

      if (checked) { peer = checked.getAttribute(ATTR) || arg.peerToken!; checked.setAttribute(ATTR, peer); }
    }
  }

  return { token, peer, name, kind, sensitive, state: keep ? state : null, submits, enterSubmits } satisfies UndoProbe;
}

async function inPage<T>(tabId: number, where: UndoWhere | { token: string } | { backendNodeId: number; token: string }, op: "probe" | "read" | "restore", arg: Parameters<typeof undoInPage>[1]): Promise<T | null> {
  if ("backendNodeId" in where) {
    try {
      const result = await callOnBackendNode<T | null>(tabId, where.backendNodeId, `function(op, arg) { return (${undoInPage.toString()}).call(this, op, arg); }`, [op, arg]);

      if (result !== null && result !== undefined) return result;
    } catch (error) { console.warn("fill-undo", op, String(error)); /* 节点换了：按记号再找一次 */ }

    if (!("token" in where)) return null;
  }

  const pageWhere = "point" in where ? { point: where.point } : "target" in where ? { target: where.target } : "focused" in where ? { focused: true as const } : undefined;

  try {
    return await callDom(tabId, undoInPage, [op, pageWhere ? { ...arg, where: pageWhere } : arg]) as T | null;
  } catch (error) {
    // 报错文字来自 executeScript / CDP，不带格子的值。
    console.warn("fill-undo", op, String(error));

    return null;
  }
}

const viewOf = (conversationId: string): FillUndoView | null => {
  const ledger = ledgers.get(conversationId);

  if (!ledger) return null;

  if (ledger.result) return ledger.result;
  const notes = [...ledger.notes];
  const tabs = [...ledger.tabs.values()].filter((tab) => tab.entries.size);
  const names = (list: TabLedger[]) => list.flatMap((tab) => [...tab.entries.values()].map((entry) => entry.name || "未命名的栏"));
  const open = tabs.filter((tab) => !tab.closed);

  if (open.length) return { state: "ready", count: open.reduce((sum, tab) => sum + tab.entries.size, 0), fields: names(open), notes };

  if (tabs.some((tab) => tab.closed === "submitted")) return { state: "submitted", fields: names(tabs), notes };

  return tabs.length ? { state: "page_changed", fields: names(tabs), notes } : null;
};

const emit = (conversationId: string) => watchers.get(conversationId)?.(viewOf(conversationId));

const NOOP = { submits: false, enterSubmits: false, done: async () => {} };

/**
 * 写之前调用：记下这一栏动手前的样子，返回写完后要调用的 done(submitted)。
 * write：这次是填写或打字（编辑器、密码栏要在说明里提一句）；点击只记勾选框和单选框。
 * 任何失败都只是不记，不影响助手的动作。
 */
export async function beforeWrite(sessionKey: string, tabId: number, where: UndoWhere, write = false): Promise<{ submits: boolean; enterSubmits: boolean; done(submitted?: boolean): Promise<void> }> {
  const { conversationId } = parseExecutionKey(sessionKey);
  const probe = await inPage<UndoProbe>(tabId, where, "probe", { token: crypto.randomUUID(), peerToken: crypto.randomUUID(), sensitiveName: SENSITIVE_FIELD_NAME.source });

  // 点普通按钮、链接：没有要记的，不多读一次文档。
  if (!probe || !(probe.token || probe.submits || probe.enterSubmits || (write && (probe.kind === "rich" || probe.sensitive)))) return NOOP;
  const doc = await readCurrentDocument(tabId).catch(() => null);

  if (!doc) return NOOP;
  const nodeId = "backendNodeId" in where ? where.backendNodeId : undefined;

  return {
    submits: probe.submits,
    enterSubmits: probe.enterSubmits,
    async done(submitted = false) {
      let ledger = ledgers.get(conversationId);

      if (!ledger) { ledger = { tabs: new Map(), notes: new Set() }; ledgers.set(conversationId, ledger); }

      if (write && probe.kind === "rich") ledger.notes.add("rich_text");

      if (write && probe.sensitive && !probe.token) ledger.notes.add("sensitive");
      let tab = ledger.tabs.get(tabId);

      if (!tab || tab.documentId !== doc.documentId) {
        tab = { documentId: doc.documentId, entries: new Map() };
        ledger.tabs.set(tabId, tab);
        // 提交监听在 content-domops 里：AX 路线不注入它，这里补一次。
        void ensureDomOps(tabId).catch(() => {});
      }

      if (probe.token && probe.state && (probe.kind === "text" || probe.kind === "select" || probe.kind === "check" || probe.kind === "radio")) {
        const entry = { token: probe.token, kind: probe.kind, sensitive: probe.sensitive, before: probe.state, after: probe.state, peer: probe.peer };
        const after = await inPage<UndoState>(tabId, nodeId !== undefined ? { backendNodeId: nodeId, token: probe.token } : { token: probe.token }, "read", { entry });
        const known = tab.entries.get(probe.token);

        if (after && known) {
          // 同一栏改了几次：动手前的值留第一次的；改回了原样就不算。
          known.after = after;

          if (JSON.stringify(known.before) === JSON.stringify(after)) tab.entries.delete(probe.token);
        } else if (after && JSON.stringify(after) !== JSON.stringify(probe.state)) {
          tab.entries.set(probe.token, { ...entry, name: probe.name, after, ...(nodeId !== undefined ? { backendNodeId: nodeId } : {}) });
        }
      }

      // 真表单提交会跳页：跳页的检查可能先到，「已提交」盖过「页面变了」。
      if (submitted) tab.closed = "submitted";
      emit(conversationId);
    },
  };
}

/** 页面换了文档（跳走、刷新、关掉）：还开着的记录改成「页面变了」。 */
async function checkDocuments(ledger: Ledger, onlyTab?: number): Promise<boolean> {
  let changed = false;

  for (const [tabId, tab] of ledger.tabs) {
    if (tab.closed || (onlyTab !== undefined && tabId !== onlyTab)) continue;
    const doc = await readCurrentDocument(tabId).catch(() => null);

    if (doc?.documentId !== tab.documentId) { tab.closed = "page_changed"; changed = true; }
  }

  return changed;
}

/** 写回这一轮还开着的格子。调用方保证任务空闲。 */
export async function restoreFills(conversationId: string): Promise<void> {
  const ledger = ledgers.get(conversationId);

  // 扩展后台重启后记录没了：面板还以为能还原，告诉它页面变了。
  if (!ledger) { watchers.get(conversationId)?.({ state: "page_changed", fields: [], notes: [] }); return; }

  if (ledger.restoring || ledger.result) return emit(conversationId);
  ledger.restoring = true;

  try {
    await checkDocuments(ledger);
    const open = [...ledger.tabs.entries()].filter(([, tab]) => !tab.closed && tab.entries.size);

    if (!open.length) return;
    const restored: Array<{ tabId: number; entry: Entry }> = [];
    const skipped: Extract<FillUndoView, { state: "restored" }>["skipped"] = [];

    for (const [tabId, tab] of open) {
      for (const entry of tab.entries.values()) {
        const where = entry.backendNodeId !== undefined ? { backendNodeId: entry.backendNodeId, token: entry.token } : { token: entry.token };
        const outcome = await inPage<UndoOutcome>(tabId, where, "restore", { entry }) ?? "failed";

        if (outcome === "restored") restored.push({ tabId, entry });
        else skipped.push({ field: entry.name || "未命名的栏", reason: outcome });
      }
    }

    // 受控输入可能在下一次渲染时把旧状态写回来：等一下再读一次，没留住就算没还原。
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kept: string[] = [];

    for (const { tabId, entry } of restored) {
      const where = entry.backendNodeId !== undefined ? { backendNodeId: entry.backendNodeId, token: entry.token } : { token: entry.token };
      const now = await inPage<UndoState>(tabId, where, "read", { entry });

      if (now && JSON.stringify(now) === JSON.stringify(entry.before)) kept.push(entry.name || "未命名的栏");
      else skipped.push({ field: entry.name || "未命名的栏", reason: "failed" });
    }

    ledger.tabs.clear();
    ledger.result = { state: "restored", restored: kept, skipped, notes: [...ledger.notes] };
  } finally {
    ledger.restoring = false;
    emit(conversationId);
  }
}

/** 面板订阅一个对话的还原状态；每次变化都推。 */
export function watchFillUndo(conversationId: string, onView: (view: FillUndoView | null) => void): void {
  watchers.set(conversationId, onView);
}

export const fillUndoView = viewOf;

/** 新一轮任务开始：上一轮的记录作废。 */
export function resetFillUndo(conversationId: string): void {
  if (!ledgers.delete(conversationId)) return;
  emit(conversationId);
}

const closeTab = (tabId: number, reason: "submitted" | "page_changed", documentId?: string) => {
  for (const [conversationId, ledger] of ledgers) {
    const tab = ledger.tabs.get(tabId);

    if (!tab || (tab.closed && !(reason === "submitted" && tab.closed === "page_changed")) || (documentId && tab.documentId !== documentId)) continue;
    tab.closed = reason;
    emit(conversationId);
  }
};

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete" && change.url === undefined) return;

  for (const [conversationId, ledger] of ledgers) {
    if (ledger.tabs.get(tabId)?.closed === undefined && ledger.tabs.has(tabId)) void checkDocuments(ledger, tabId).then((changed) => { if (changed) emit(conversationId); });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => closeTab(tabId, "page_changed"));

chrome.runtime.onMessage.addListener((raw: { type?: string } | undefined, sender) => {
  if (sender.id !== chrome.runtime.id || raw?.type !== FILL_UNDO_SUBMIT || sender.tab?.id === undefined) return;
  closeTab(sender.tab.id, "submitted", sender.documentId);
});
