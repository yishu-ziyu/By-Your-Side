import { SENSITIVE_FIELD_NAME } from "../../../shared/trace-sanitize.js";
import { FILL_UNDO_SUBMIT, type FillUndoNote, type FillUndoView } from "../relay.js";
import { callDom, callOnBackendNode, ensureDomOps } from "./exec/input.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { parseExecutionKey } from "./tab-bindings.js";

/**
 * 还原填写：助手这一轮在网页上填过、选过、勾过的格子，记下它动手前的样子，用户要时写回去。
 * 动手前的值只放在这个后台的内存里：不进工具回执、不进 storage、不进日志、不发给模型；面板只拿到数量、栏名和状态。
 * 一条记录关掉（提交了、页面变了、标签页关了）就丢掉值，只留栏名；整本记录活到下一轮任务开始或用户点了还原。扩展后台重启就没了，按「页面变了」答复。
 * 格子在网页上挂一个随机记号（data-sideagent-undo），还原时按记号找回同一个元素；只认账本里还开着的记号，旧轮留下的记号不算数。
 * 还原只用 executeScript 按记号找格子，不接调试器（接上会在页面顶部出「正在调试」的提示条）。
 * 编辑器（contenteditable）和原来有内容的密码这类栏这一版不还原，只在 notes 里说明。
 */

type UndoKind = "text" | "select" | "check" | "radio" | "rich" | "other";

/**
 * 一栏的样子：文字栏的值、下拉框选中的序号、勾选框是否选中、单选组里选中的那一项（它的记号，没选为空串）。
 * 敏感栏的非空值在页面里就换成摘要，不带出来。
 */
type UndoState = { value?: string; indexes?: number[]; checked?: boolean; pick?: string };

/** token：这一栏的记号；单选组是组里第一项的记号，整组算一条。 */
type UndoProbe = { token: string | null; name: string; kind: UndoKind; sensitive: boolean; state: UndoState | null };

type UndoOutcome = "restored" | "user_changed" | "gone" | "failed";

/** 页面里怎么找到这一栏：AX 引用的节点、定位串、点击落点，或者当前焦点。 */
export type UndoWhere = { backendNodeId: number } | { target: string } | { point: [number, number] } | { focused: true };

interface Entry { token: string; name: string; kind: "text" | "select" | "check" | "radio"; sensitive: boolean; before: UndoState; after: UndoState }

/** 关掉的记录：只留栏名和原因；记号留着，好让晚到的提交消息把「页面变了」改成「已提交」。 */
interface Closed { token: string; name: string; reason: "submitted" | "page_changed"; tabId: number; documentId: string }

interface TabLedger { documentId: string; entries: Map<string, Entry> }

interface Ledger { tabs: Map<number, TabLedger>; closed: Closed[]; notes: Set<FillUndoNote>; result?: FillUndoView; restoring?: boolean }

const ledgers = new Map<string, Ledger>();
const watchers = new Map<string, (view: FillUndoView | null) => void>();
const runs = new Map<string, string>();

/**
 * 页面里执行，保持自包含（经 CDP 按节点调用，或 executeScript）。this 是元素（CDP 按节点调用）；否则按 where 或记号找。
 * probe：动手前读这一栏，挂记号；read：按记号读现在的样子；restore：按记号核对后写回。
 * 敏感栏的分类同 exec/input.ts 的 readFieldInPage。
 */
function undoInPage(this: unknown, op: "probe" | "read" | "restore", arg: {
  where?: { target?: string; point?: [number, number]; focused?: true };
  tokens?: string[]; sensitiveName?: string;
  entry?: { token: string; kind: UndoKind; sensitive: boolean; before: UndoState; after: UndoState };
}): unknown {
  const ATTR = "data-sideagent-undo";
  const self = this && typeof this === "object" && (this as Node).nodeType === 1 ? this as Element : null;
  const fresh = [...(arg.tokens ?? [])];
  const tokenOf = (node: Element) => { const token = node.getAttribute(ATTR) || fresh.shift() || `${Date.now()}-${Math.random()}`; node.setAttribute(ATTR, token); return token; };

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

  /** 单选组：同一张表单（或同一个文档、shadow root）里同名的单选框，按页面顺序。 */
  const groupOf = (radio: HTMLInputElement): HTMLInputElement[] => {
    if (!radio.name) return [radio];
    const scope: ArrayLike<Element> = radio.form ? radio.form.elements : (radio.getRootNode() as Document | ShadowRoot).querySelectorAll("input[type=radio]");

    return Array.from(scope).filter((node): node is HTMLInputElement => node.tagName === "INPUT" && (node as HTMLInputElement).type === "radio"
      && (node as HTMLInputElement).name === radio.name && (node as HTMLInputElement).form === radio.form);
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

    if (kind === "check") return { checked: (el as HTMLInputElement).checked };

    if (kind === "radio") { const picked = groupOf(el as HTMLInputElement).find((node) => node.checked); return { pick: picked ? tokenOf(picked) : "" }; }

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
      // 单选组：把原来选中的那一项重新点上；原来一项都没选，就取消现在选中的那一项。
      if (entry.before.pick) (findToken(entry.before.pick) as HTMLElement | null)?.click();
      else { const picked = groupOf(el as HTMLInputElement).find((node) => node.checked); if (picked) { setNative(picked, "checked", false); fire(picked); } }
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
  const host = (el.getRootNode?.() as ShadowRoot | undefined)?.host;

  if (host?.tagName === "INPUT" && (host as HTMLInputElement).type === "time") el = host;
  else if (kindOf(el) === "other") { const control = (el.closest("label") as HTMLLabelElement | null)?.control; if (control) el = control; }

  const kind = kindOf(el);
  const field = el as HTMLInputElement;
  const by = field.getAttribute("aria-labelledby");
  // 单选组用组的名字（fieldset 的 legend、radiogroup 的 aria-label），不用点中那一项的字。
  const group = kind === "radio" ? field.closest("fieldset")?.querySelector("legend")?.textContent || field.closest("[role=radiogroup]")?.getAttribute("aria-label") : null;
  const label = "labels" in field && field.labels?.[0];
  const name = (group
    || field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || (label && (label.textContent ?? "").replace(label.contains(field) ? field.textContent ?? "" : "", "")) || field.getAttribute("placeholder") || field.getAttribute("title") || field.getAttribute("name") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  const sensitive = kind === "text" && ((field.tagName === "INPUT" && (field.type === "password" || field.hasAttribute("data-bys-was-password")))
    || /one-time-code|cc-(number|csc|exp)/i.test(String(field.getAttribute("autocomplete") ?? ""))
    || new RegExp(arg.sensitiveName ?? "$^", "i").test([field.getAttribute("name"), field.id, name, field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title")].map((part) => normalize(String(part ?? ""))).join(" ")));

  if (field.tagName === "INPUT" && field.type === "password") field.setAttribute("data-bys-was-password", "");

  if (kind !== "text" && kind !== "select" && kind !== "check" && kind !== "radio") return { token: null, name, kind, sensitive, state: null } satisfies UndoProbe;
  const anchor = kind === "radio" ? groupOf(field)[0] ?? field : el;
  const marked = anchor.hasAttribute(ATTR);
  const hidden = sensitive && field.value !== "";

  // 原来有内容的敏感栏：不挂记号、不带值出去。已经挂过记号（这一轮先前从空填过）的照常记，只是不带值。
  if (hidden && !marked) return { token: null, name, kind, sensitive, state: null } satisfies UndoProbe;

  return { token: tokenOf(anchor), name, kind, sensitive, state: hidden ? null : stateOf(el, kind, sensitive) } satisfies UndoProbe;
}

async function probeInPage(tabId: number, where: UndoWhere): Promise<UndoProbe | null> {
  const arg = { tokens: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()], sensitiveName: SENSITIVE_FIELD_NAME.source };

  try {
    // AX 引用只能按节点调用；任务在跑时调试器本来就接着。
    if ("backendNodeId" in where) return await callOnBackendNode<UndoProbe | null>(tabId, where.backendNodeId, `function(op, arg) { return (${undoInPage.toString()}).call(this, op, arg); }`, ["probe", arg]);

    return await callDom(tabId, undoInPage, ["probe", { ...arg, where }]) as UndoProbe | null;
  } catch (error) {
    // 报错文字来自 executeScript / CDP，不带格子的值。
    console.warn("fill-undo", "probe", String(error));

    return null;
  }
}

/** 按记号读或写回：只用 executeScript，不接调试器。 */
async function byToken<T>(tabId: number, op: "read" | "restore", entry: Entry): Promise<T | null> {
  try {
    return await callDom(tabId, undoInPage, [op, { entry }]) as T | null;
  } catch (error) {
    console.warn("fill-undo", op, String(error));

    return null;
  }
}

const nameOf = (entry: { name: string }) => entry.name || "未命名的栏";

const viewOf = (conversationId: string): FillUndoView | null => {
  const ledger = ledgers.get(conversationId);

  if (!ledger) return null;

  if (ledger.result) return ledger.result;
  const notes = [...ledger.notes];
  const open = [...ledger.tabs.values()].flatMap((tab) => [...tab.entries.values()]);

  if (open.length) return { state: "ready", count: open.length, fields: open.map(nameOf), notes };

  if (ledger.closed.some((closed) => closed.reason === "submitted")) return { state: "submitted", fields: ledger.closed.map(nameOf), notes };

  if (ledger.closed.length) return { state: "page_changed", fields: ledger.closed.map(nameOf), notes };

  // 只改了编辑器文字、或只碰了原来有内容的密码栏：没有能还原的，但要让面板说一句。
  return notes.length ? { state: "ready", count: 0, fields: [], notes } : null;
};

const emit = (conversationId: string) => watchers.get(conversationId)?.(viewOf(conversationId));

/** 关掉一个标签页里的记录：丢掉值，只留栏名。tokens 给了就只关这几格。 */
function closeEntries(ledger: Ledger, tabId: number, reason: Closed["reason"], tokens?: readonly string[], documentId?: string): boolean {
  let changed = false;
  const tab = ledger.tabs.get(tabId);

  if (tab && (!documentId || tab.documentId === documentId)) {
    for (const entry of [...tab.entries.values()]) {
      if (tokens && !tokens.includes(entry.token)) continue;
      tab.entries.delete(entry.token);
      ledger.closed.push({ token: entry.token, name: entry.name, reason, tabId, documentId: tab.documentId });
      changed = true;
    }
  }

  // 真表单提交会跳页：跳页的检查可能先到，晚到的提交消息把这几格的「页面变了」改成「已提交」。
  if (reason === "submitted" && tokens) {
    for (const closed of ledger.closed) {
      if (closed.tabId === tabId && closed.reason === "page_changed" && tokens.includes(closed.token) && (!documentId || closed.documentId === documentId)) { closed.reason = "submitted"; changed = true; }
    }
  }

  return changed;
}

const NOOP = { done: async () => {} };

/**
 * 写之前调用：记下这一栏动手前的样子，返回写完后要调用的 done()。
 * write：这次是填写或打字（编辑器、密码栏要在说明里提一句）；点击只记勾选框和单选框。
 * 任何失败都只是不记，不影响助手的动作。
 */
export async function beforeWrite(sessionKey: string, tabId: number, where: UndoWhere, write = false): Promise<{ done(): Promise<void> }> {
  const { conversationId } = parseExecutionKey(sessionKey);
  const probe = await probeInPage(tabId, where);

  // 点普通按钮、链接：没有要记的，不多读一次文档。
  if (!probe || !(probe.token || (write && (probe.kind === "rich" || probe.sensitive)))) return NOOP;
  const doc = await readCurrentDocument(tabId).catch(() => null);

  if (!doc) return NOOP;

  return {
    async done() {
      let ledger = ledgers.get(conversationId);

      if (!ledger) { ledger = { tabs: new Map(), closed: [], notes: new Set() }; ledgers.set(conversationId, ledger); }

      // 还原过以后助手又动了手：从这里重新记。
      if (ledger.result) { ledger.result = undefined; ledger.closed = []; ledger.notes.clear(); }

      if (write && probe.kind === "rich") ledger.notes.add("rich_text");

      if (write && probe.sensitive && !probe.token) ledger.notes.add("sensitive");
      let tab = ledger.tabs.get(tabId);

      if (tab && tab.documentId !== doc.documentId) { closeEntries(ledger, tabId, "page_changed"); tab = undefined; }

      if (!tab) {
        tab = { documentId: doc.documentId, entries: new Map() };
        ledger.tabs.set(tabId, tab);
        // 提交监听在 content-domops 里：AX 路线不注入它，这里补一次。
        void ensureDomOps(tabId).catch(() => {});
      }

      if (probe.token && (probe.kind === "text" || probe.kind === "select" || probe.kind === "check" || probe.kind === "radio")) {
        const known = tab.entries.get(probe.token);
        const draft: Entry = known ?? { token: probe.token, name: probe.name, kind: probe.kind, sensitive: probe.sensitive, before: probe.state ?? {}, after: probe.state ?? {} };
        const after = await byToken<UndoState>(tabId, "read", draft);

        if (after && known) {
          // 同一栏改了几次（单选组点了几项）：动手前的样子留第一次的；改回了原样就不算。
          known.after = after;

          if (JSON.stringify(known.before) === JSON.stringify(after)) tab.entries.delete(probe.token);
        } else if (after && probe.state && JSON.stringify(after) !== JSON.stringify(probe.state)) {
          tab.entries.set(probe.token, { ...draft, after });
        }
      }

      emit(conversationId);
    },
  };
}

/** 页面换了文档（跳走、刷新）：还开着的记录改成「页面变了」。 */
async function checkDocuments(ledger: Ledger, onlyTab?: number): Promise<boolean> {
  let changed = false;

  for (const [tabId, tab] of [...ledger.tabs]) {
    if (onlyTab !== undefined && tabId !== onlyTab) continue;
    const doc = await readCurrentDocument(tabId).catch(() => null);

    if (doc?.documentId !== tab.documentId) { changed = closeEntries(ledger, tabId, "page_changed") || changed; ledger.tabs.delete(tabId); }
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
    const open = [...ledger.tabs.entries()].flatMap(([tabId, tab]) => [...tab.entries.values()].map((entry) => ({ tabId, entry })));

    if (!open.length) return;
    const restored: typeof open = [];
    const skipped: Extract<FillUndoView, { state: "restored" }>["skipped"] = [];

    for (const item of open) {
      const outcome = await byToken<UndoOutcome>(item.tabId, "restore", item.entry) ?? "failed";

      if (outcome === "restored") restored.push(item);
      else skipped.push({ field: nameOf(item.entry), reason: outcome });
    }

    // 受控输入可能在下一次渲染时把旧状态写回来：等一下再读一次，没留住就算没还原。
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kept: string[] = [];

    for (const { tabId, entry } of restored) {
      const now = await byToken<UndoState>(tabId, "read", entry);

      if (now && JSON.stringify(now) === JSON.stringify(entry.before)) kept.push(nameOf(entry));
      else skipped.push({ field: nameOf(entry), reason: "failed" });
    }

    ledger.result = { state: "restored", restored: kept, skipped, notes: [...ledger.notes] };
    ledger.tabs.clear();
    ledger.closed = [];
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

/**
 * 每次工具调用带着任务的 runId：换了任务就是新的一轮。语音直接操作网页时不经过侧栏发消息，只能靠这个换轮。
 */
export function noteFillUndoRun(conversationId: string, runId: string | null | undefined): void {
  if (!runId) return;
  const previous = runs.get(conversationId);
  runs.set(conversationId, runId);

  if (previous && previous !== runId) resetFillUndo(conversationId);
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete" && change.url === undefined) return;

  for (const [conversationId, ledger] of ledgers) {
    if (ledger.tabs.has(tabId)) void checkDocuments(ledger, tabId).then((changed) => { if (changed) emit(conversationId); });
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [conversationId, ledger] of ledgers) {
    if (closeEntries(ledger, tabId, "page_changed")) { ledger.tabs.delete(tabId); emit(conversationId); }
  }
});

// 网页上真的提交了表单（content-domops 只转发可信的 submit 事件）：只关掉这张表单里的格子。
chrome.runtime.onMessage.addListener((raw: { type?: string; tokens?: unknown } | undefined, sender) => {
  if (sender.id !== chrome.runtime.id || raw?.type !== FILL_UNDO_SUBMIT || sender.tab?.id === undefined || !Array.isArray(raw.tokens)) return;
  const tokens = raw.tokens.filter((token): token is string => typeof token === "string");

  for (const [conversationId, ledger] of ledgers) {
    if (closeEntries(ledger, sender.tab.id, "submitted", tokens, sender.documentId)) emit(conversationId);
  }
});

/** 旧值至少这么长才去掉：一个字的旧值（人数 2）到处都有，去掉只会弄坏摘要。 */
const MIN_SCRUB_CHARS = 2;

/**
 * 交给模型的页面文字里去掉这一轮记下的旧值（动作后“新出现了什么”的摘要用）：旧值只能留在这里。
 * 敏感栏的旧值本来就只是摘要，不用管。
 */
export function withoutUndoValues(sessionKey: string, text: string): string {
  const ledger = ledgers.get(parseExecutionKey(sessionKey).conversationId);

  if (!ledger) return text;
  const values = [...ledger.tabs.values()].flatMap(tab => [...tab.entries.values()])
    .flatMap(entry => !entry.sensitive && entry.before.value && entry.before.value.trim().length >= MIN_SCRUB_CHARS ? [entry.before.value.trim()] : [])
    .sort((a, b) => b.length - a.length);

  return values.reduce((out, value) => out.split(value).join("<earlier value hidden>"), text);
}
