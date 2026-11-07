import { SENSITIVE_FIELD_NAME } from "../../../shared/trace-sanitize.js";
import { FILL_UNDO_SUBMIT, type FillUndoNote, type FillUndoView } from "../relay.js";
import { callDom, callOnBackendNode, ensureDomOps } from "./exec/page-call.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { parseExecutionKey } from "./tab-bindings.js";

type UndoKind = "text" | "select" | "check" | "radio" | "rich" | "other";

type UndoState = { value?: string; indexes?: number[]; checked?: boolean; pick?: string };

type UndoProbe = { token: string | null; name: string; kind: UndoKind; sensitive: boolean; state: UndoState | null };

type UndoOutcome = "restored" | "user_changed" | "gone" | "failed";

type UndoWhere = { backendNodeId: number } | { target: string } | { point: [number, number] } | { focused: true };

interface Entry { token: string; name: string; kind: "text" | "select" | "check" | "radio"; sensitive: boolean; before: UndoState; after: UndoState }

interface Closed { token: string; name: string; reason: "submitted" | "page_changed"; tabId: number; documentId: string }

interface TabLedger { documentId: string; entries: Map<string, Entry> }

interface Ledger { tabs: Map<number, TabLedger>; closed: Closed[]; notes: Set<FillUndoNote>; untracked: Set<string>; result?: FillUndoView; restoring?: boolean }

const ledgers = new Map<string, Ledger>();
const watchers = new Map<string, (view: FillUndoView | null) => void>();
const runs = new Map<string, string>();

function undoInPage(this: unknown, op: "probe" | "read" | "restore", arg: {
  where?: { target?: string; point?: [number, number]; focused?: true };
  tokens?: string[]; sensitiveName?: string;
  entry?: { token: string; kind: UndoKind; sensitive: boolean; before: UndoState; after: UndoState };
}): unknown {
  const ATTR = "data-sideagent-undo";
  const self = this && typeof this === "object" && (this as Node).nodeType === 1 ? this as Element : null;
  const fresh = [...(arg.tokens ?? [])];
  const tokenOf = (node: Element) => { const token = node.getAttribute(ATTR) || fresh.shift() || `${Date.now()}-${Math.random()}`; node.setAttribute(ATTR, token); return token; };

  const findToken = (token: string): Element | null => {
    const roots: Array<Document | ShadowRoot> = [document];

    for (let i = 0; i < roots.length && i < 200; i++) {
      const hit = roots[i]!.querySelector(`[${ATTR}="${token}"]`);

      if (hit) return hit;

      for (const node of roots[i]!.querySelectorAll("*")) {
        if (node.shadowRoot) roots.push(node.shadowRoot);

        if (node.tagName === "IFRAME") {
          try { const doc = (node as HTMLIFrameElement).contentDocument; if (doc) roots.push(doc); } catch {  }
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

  const groupOf = (radio: HTMLInputElement): HTMLInputElement[] => {
    if (!radio.name) return [radio];
    const scope: ArrayLike<Element> = radio.form ? radio.form.elements : (radio.getRootNode() as Document | ShadowRoot).querySelectorAll("input[type=radio]");

    return Array.from(scope).filter((node): node is HTMLInputElement => node.tagName === "INPUT" && (node as HTMLInputElement).type === "radio"
      && (node as HTMLInputElement).name === radio.name && (node as HTMLInputElement).form === radio.form);
  };

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
      if (entry.before.pick) (findToken(entry.before.pick) as HTMLElement | null)?.click();
      else { const picked = groupOf(el as HTMLInputElement).find((node) => node.checked); if (picked) { setNative(picked, "checked", false); fire(picked); } }
    }

    return same(stateOf(el, entry.kind, entry.sensitive), entry.before) ? "restored" : "failed";
  }

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
  const group = kind === "radio" ? field.closest("fieldset")?.querySelector("legend")?.textContent || field.closest("[role=radiogroup]")?.getAttribute("aria-label") : null;
  const label = "labels" in field && field.labels?.[0];
  const fieldName = (group
    || field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || (label && (label.textContent ?? "").replace(label.contains(field) ? field.textContent ?? "" : "", "")) || field.getAttribute("placeholder") || field.getAttribute("title") || field.getAttribute("name") || "")
    .replace(/\s+/g, " ").trim().slice(0, 40);
  const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();
  const sensitive = kind === "text" && ((field.tagName === "INPUT" && (field.type === "password" || field.hasAttribute("data-bys-was-password")))
    || /one-time-code|cc-(number|csc|exp)/i.test(String(field.getAttribute("autocomplete") ?? ""))
    || new RegExp(arg.sensitiveName ?? "$^", "i").test([field.getAttribute("name"), field.id, fieldName, field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title")].map((part) => normalize(String(part ?? ""))).join(" ")));

  const labelText = (node: Element | null): string => {
    if (!node || ("isContentEditable" in node && node.isContentEditable === true) || node.matches("input, textarea, select, [contenteditable]:not([contenteditable=false]), fieldset, section, form, [role=group], [role=region]")
      || node.querySelector("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return "";

    return (node.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
  };
  let regionName = "";

  for (let region = field.parentElement; region && !regionName; region = region.parentElement) {
    if (region.tagName === "FIELDSET") regionName = labelText(region.querySelector(":scope > legend"));
    else if (region.matches("[role=group], [role=region]")) {
      regionName = (region.getAttribute("aria-label") ?? "").replace(/\s+/g, " ").trim().slice(0, 40);

      if (!regionName) regionName = (region.getAttribute("aria-labelledby") ?? "").split(/\s+/)
        .map((id) => labelText(field.ownerDocument.getElementById(id))).filter(Boolean).join(" ").slice(0, 40);
    } else if (region.tagName === "SECTION") regionName = labelText(region.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6, :scope > [role=heading]"));
  }

  const name = regionName && fieldName && regionName !== fieldName ? `${regionName} › ${fieldName}` : fieldName;

  if (field.tagName === "INPUT" && field.type === "password") field.setAttribute("data-bys-was-password", "");

  if (kind !== "text" && kind !== "select" && kind !== "check" && kind !== "radio") return { token: null, name, kind, sensitive, state: null } satisfies UndoProbe;
  const anchor = kind === "radio" ? groupOf(field)[0] ?? field : el;
  const marked = anchor.hasAttribute(ATTR);
  const hidden = sensitive && field.value !== "";

  if (hidden && !marked) return { token: null, name, kind, sensitive, state: null } satisfies UndoProbe;

  return { token: tokenOf(anchor), name, kind, sensitive, state: hidden ? null : stateOf(el, kind, sensitive) } satisfies UndoProbe;
}

async function probeInPage(tabId: number, where: UndoWhere): Promise<UndoProbe | null> {
  const arg = { tokens: [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()], sensitiveName: SENSITIVE_FIELD_NAME.source };

  try {
    if ("backendNodeId" in where) return await callOnBackendNode<UndoProbe | null>(tabId, where.backendNodeId, `function(op, arg) { return (${undoInPage.toString()}).call(this, op, arg); }`, ["probe", arg]);

    return await callDom(tabId, undoInPage, ["probe", { ...arg, where }]) as UndoProbe | null;
  } catch (error) {
    console.warn("fill-undo", "probe", String(error));

    return null;
  }
}

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

  const untracked = [...ledger.untracked];

  if (ledger.result) return { ...ledger.result, untracked };
  const notes = [...ledger.notes];
  const open = [...ledger.tabs.values()].flatMap((tab) => [...tab.entries.values()]);

  const fields = open.map(nameOf);

  if (open.length) return { state: "ready", count: open.length, fields, notes, untracked, unavailable: ledger.closed.map(nameOf) };

  if (ledger.closed.some((closed) => closed.reason === "submitted")) return { state: "submitted", fields: ledger.closed.map(nameOf), notes, untracked };

  if (ledger.closed.length) return { state: "page_changed", fields: ledger.closed.map(nameOf), notes, untracked };

  return notes.length ? { state: "ready", count: 0, fields: [], notes, untracked } : null;
};

const emit = (conversationId: string) => watchers.get(conversationId)?.(viewOf(conversationId));

type Remembered = Entry & { tabId: number; documentId: string };

const writeHistory = new Map<string, Map<string, Remembered>>();

const historyKey = (tabId: number, documentId: string, token: string) => `${tabId}\t${documentId}\t${token}`;

function historyOf(conversationId: string): Map<string, Remembered> {
  let map = writeHistory.get(conversationId);
  if (!map) { map = new Map(); writeHistory.set(conversationId, map); }
  return map;
}

function copyEntry(entry: Entry): Entry {
  return { ...entry, before: { ...entry.before }, after: { ...entry.after } };
}

function rememberEntry(conversationId: string, tabId: number, documentId: string, entry: Entry): void {
  historyOf(conversationId).set(historyKey(tabId, documentId, entry.token), { ...copyEntry(entry), tabId, documentId });
}

function snapshotLedger(conversationId: string, ledger: Ledger): void {
  for (const [tabId, tab] of ledger.tabs) {
    for (const entry of tab.entries.values()) rememberEntry(conversationId, tabId, tab.documentId, entry);
  }
}

function conversationOf(ledger: Ledger): string | undefined {
  for (const [id, item] of ledgers) if (item === ledger) return id;
}

function forgetHistory(conversationId: string | undefined, tabId: number, tokens: readonly string[], documentId?: string): void {
  if (!conversationId) return;
  const map = writeHistory.get(conversationId);
  if (!map) return;
  for (const [key, item] of [...map]) {
    if (item.tabId !== tabId) continue;
    if (documentId && item.documentId !== documentId) continue;
    if (tokens.length && !tokens.includes(item.token)) continue;
    map.delete(key);
  }
}

function rememberedWrite(conversationId: string, tabId: number, documentId: string, token: string): Entry | undefined {
  const tab = ledgers.get(conversationId)?.tabs.get(tabId);
  if (tab && tab.documentId === documentId) {
    const known = tab.entries.get(token);
    if (known) return known;
  }
  return writeHistory.get(conversationId)?.get(historyKey(tabId, documentId, token));
}

function closeEntries(ledger: Ledger, tabId: number, reason: Closed["reason"], tokens?: readonly string[], documentId?: string): boolean {
  let changed = false;
  const tab = ledger.tabs.get(tabId);
  const dropped: string[] = [];

  if (tab && (!documentId || tab.documentId === documentId)) {
    for (const entry of [...tab.entries.values()]) {
      if (tokens && !tokens.includes(entry.token)) continue;
      tab.entries.delete(entry.token);
      ledger.closed.push({ token: entry.token, name: entry.name, reason, tabId, documentId: tab.documentId });
      dropped.push(entry.token);
      changed = true;
    }
  }

  if (dropped.length) forgetHistory(conversationOf(ledger), tabId, dropped, tab?.documentId ?? documentId);

  if (reason === "submitted" && tokens) {
    forgetHistory(conversationOf(ledger), tabId, tokens, documentId);
    for (const closed of ledger.closed) {
      if (closed.tabId === tabId && closed.reason === "page_changed" && tokens.includes(closed.token) && (!documentId || closed.documentId === documentId)) { closed.reason = "submitted"; changed = true; }
    }
  }

  return changed;
}

function forgetEntries(ledger: Ledger, tabId: number, tokens: readonly string[], documentId?: string): boolean {
  const tab = ledger.tabs.get(tabId);
  let changed = false;

  if (tab && (!documentId || tab.documentId === documentId)) {
    for (const token of tokens) changed = tab.entries.delete(token) || changed;
  }

  forgetHistory(conversationOf(ledger), tabId, tokens, documentId ?? tab?.documentId);

  const kept = ledger.closed.filter((closed) => !(closed.tabId === tabId && closed.reason === "page_changed" && tokens.includes(closed.token) && (!documentId || closed.documentId === documentId)));

  if (kept.length !== ledger.closed.length) { ledger.closed = kept; changed = true; }

  return changed;
}

const NOOP = { done: async () => {} };

export class UserChangedFieldError extends Error {
  readonly field: string;

  constructor(field: string) {
    const name = field || "未命名的栏";
    super(`「${name}」在助手上次填写后被改过，本次写入未生效。撤回不得覆盖用户后来的修改，请说明冲突。`);
    this.name = "UserChangedFieldError";
    this.field = name;
  }
}

export async function beforeWrite(sessionKey: string, tabId: number, where: UndoWhere, write = false, next?: UndoState): Promise<{ done(): Promise<void> }> {
  const { conversationId } = parseExecutionKey(sessionKey);
  const probe = await probeInPage(tabId, where);

  if (!probe || !(probe.token || (write && (probe.kind === "rich" || probe.sensitive)))) return NOOP;
  const doc = await readCurrentDocument(tabId).catch(() => null);

  if (!doc) return NOOP;

  if (write && probe.token) {
    const known = rememberedWrite(conversationId, tabId, doc.documentId, probe.token);
    if (known) {
      const live = probe.state ?? await byToken<UndoState>(tabId, "read", known);
      if (live && JSON.stringify(live) !== JSON.stringify(known.after)) {
        const restoringSnapshot = next === undefined || JSON.stringify(next) === JSON.stringify(known.before);
        if (restoringSnapshot) throw new UserChangedFieldError(known.name || probe.name);
      }
    }
  }

  return {
    async done() {
      let ledger = ledgers.get(conversationId);

      if (!ledger) { ledger = { tabs: new Map(), closed: [], notes: new Set(), untracked: new Set() }; ledgers.set(conversationId, ledger); }

      if (ledger.result) { ledger.result = undefined; ledger.closed = []; ledger.notes.clear(); ledger.untracked.clear(); }

      if (write && probe.kind === "rich") { ledger.notes.add("rich_text"); ledger.untracked.add(nameOf(probe)); }

      if (write && probe.sensitive && !probe.token) { ledger.notes.add("sensitive"); ledger.untracked.add(nameOf(probe)); }
      let tab = ledger.tabs.get(tabId);

      if (tab && tab.documentId !== doc.documentId) { closeEntries(ledger, tabId, "page_changed"); tab = undefined; }

      if (!tab) {
        tab = { documentId: doc.documentId, entries: new Map() };
        ledger.tabs.set(tabId, tab);
        void ensureDomOps(tabId).catch(() => {});
      }

      if (probe.token && (probe.kind === "text" || probe.kind === "select" || probe.kind === "check" || probe.kind === "radio")) {
        const known = tab.entries.get(probe.token);
        const draft: Entry = known ?? { token: probe.token, name: probe.name, kind: probe.kind, sensitive: probe.sensitive, before: probe.state ?? {}, after: probe.state ?? {} };
        const after = await byToken<UndoState>(tabId, "read", draft);

        if (after && known) {
          known.after = after;

          if (JSON.stringify(known.before) === JSON.stringify(after)) {
            tab.entries.delete(probe.token);
            forgetHistory(conversationId, tabId, [probe.token], doc.documentId);
          } else {
            rememberEntry(conversationId, tabId, doc.documentId, known);
          }
        } else if (after && probe.state && JSON.stringify(after) !== JSON.stringify(probe.state)) {
          const recorded = { ...draft, after };
          tab.entries.set(probe.token, recorded);
          rememberEntry(conversationId, tabId, doc.documentId, recorded);
        }
      }

      emit(conversationId);
    },
  };
}

async function checkDocuments(ledger: Ledger, onlyTab?: number): Promise<boolean> {
  let changed = false;

  for (const [tabId, tab] of [...ledger.tabs]) {
    if (onlyTab !== undefined && tabId !== onlyTab) continue;
    const doc = await readCurrentDocument(tabId).catch(() => null);

    if (doc?.documentId !== tab.documentId) { changed = closeEntries(ledger, tabId, "page_changed") || changed; ledger.tabs.delete(tabId); }
  }

  return changed;
}

export async function restoreFills(conversationId: string): Promise<void> {
  const ledger = ledgers.get(conversationId);

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

    await new Promise((resolve) => setTimeout(resolve, 200));
    const kept: string[] = [];

    for (const { tabId, entry } of restored) {
      const now = await byToken<UndoState>(tabId, "read", entry);

      if (now && JSON.stringify(now) === JSON.stringify(entry.before)) {
        kept.push(nameOf(entry));
        forgetHistory(conversationId, tabId, [entry.token], ledger.tabs.get(tabId)?.documentId);
      } else skipped.push({ field: nameOf(entry), reason: "failed" });
    }

    ledger.result = { state: "restored", restored: kept, skipped, notes: [...ledger.notes], unavailable: ledger.closed.map(nameOf) };
    ledger.tabs.clear();
    ledger.closed = [];
  } finally {
    ledger.restoring = false;
    emit(conversationId);
  }
}

export function watchFillUndo(conversationId: string, onView: (view: FillUndoView | null) => void): void {
  watchers.set(conversationId, onView);
}

export const fillUndoView = viewOf;

export function resetFillUndo(conversationId: string): void {
  const ledger = ledgers.get(conversationId);
  if (ledger) snapshotLedger(conversationId, ledger);
  if (!ledgers.delete(conversationId)) return;
  emit(conversationId);
}

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

chrome.runtime.onMessage.addListener((raw: { type?: string; tokens?: unknown; navigated?: unknown } | undefined, sender) => {
  if (sender.id !== chrome.runtime.id || raw?.type !== FILL_UNDO_SUBMIT || sender.tab?.id === undefined || !Array.isArray(raw.tokens)) return;
  const tokens = raw.tokens.filter((token): token is string => typeof token === "string");

  for (const [conversationId, ledger] of ledgers) {
    const changed = raw.navigated === true ? forgetEntries(ledger, sender.tab.id, tokens, sender.documentId) : closeEntries(ledger, sender.tab.id, "submitted", tokens, sender.documentId);

    if (changed) emit(conversationId);
  }
});

const MIN_SCRUB_CHARS = 2;
const SCRUB_PREFIX_CHARS = 12;

export function undoScrubber(sessionKey: string): (body: string) => string {
  const ledger = ledgers.get(parseExecutionKey(sessionKey).conversationId);
  const values = ledger ? [...ledger.tabs.values()].flatMap(tab => [...tab.entries.values()])
    .flatMap(entry => {
      const v = (entry.sensitive ? "" : entry.before.value ?? "").replace(/\s+/g, " ").trim();

      return v.length >= MIN_SCRUB_CHARS ? [v, JSON.stringify(v).slice(1, -1)] : [];
    })
    .sort((a, b) => b.length - a.length) : [];

  return body => {
    let out = body;

    for (const v of values) {
      if (v.length > SCRUB_PREFIX_CHARS && !out.includes(v) && out.includes(v.slice(0, SCRUB_PREFIX_CHARS))) return "text: <hidden: shows an earlier field value>";
      out = out.split(v).join("<earlier value hidden>");
    }

    return out;
  };
}
