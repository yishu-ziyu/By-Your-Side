import {isolatedReadContext} from '../isolated-read-context.js';
import { axTextEvidence } from '../ax-text-evidence.js';
import type { PageTextEvidence } from '../../../../shared/page-text-evidence.js';
import type {TranslationDisplayState} from '../../../../shared/page-translation.js';
import type {HostDrawnMark} from '../../../../shared/host-marks.js';
import {withObservedDocumentIdentity} from "../observation-document.js";
import {browserObservations,collectDecisionControls,readDecisionTree,decisionDialogs,selectObservationView} from '../browser-observation.js';
import type {BrowserObservation,BrowserControl} from '../../../../shared/browser-decision.js';
import {listTabs} from './tabs.js';
import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveReadableTab } from "../state.js";
import { oneLine } from "../util.js";
import { axTreeToText, enclosingItem, itemTextOf, itemTexts, RANGE_INPUT_ROLES, repeatedItems, type AxNodeLite, type RepeatedItems } from "../axtree.js";
import type { InputRangeReadout } from "../../../../shared/page-readout.js";
import { readInputRange } from "../../shared/range-input.js";
import { addAxRefs, clearAxSnapshot, recordAxSnapshot } from "../axstate.js";
import { recordLocatedNames } from "../located-names.js";
import { forgetPage, freshLines, hasPageBaseline, knownItems, pageChangesSince, rememberPage } from "../page-changes.js";
import { withTimeout } from "../timeout.js";
import { assertNoPendingDialog } from "../page-events.js";
import { waitForInteractive } from "./page-readiness.js";
import { SENSITIVE_FIELD_NAME } from "../../../../shared/trace-sanitize.js";
import { overlayHostSelector } from "../../shared/overlay.js";
import { pdfText, tabShowsPdf } from "./pdf-text.js";

const URL_MOVED_DURING_READ = '读取期间页面地址已变化，请重新读取当前页面。';

const PAGE_MOVE_WAIT_MS = 4_000;

interface SnapshotBody {
  text: string;
  tabId: number;
  documentId?: string;
  textEvidence?: PageTextEvidence;
  url?: string;
  translation?: TranslationDisplayState | null;
  marks?: HostDrawnMark[];
}

interface SnapshotRead extends SnapshotBody {
  controls?: BrowserControl[];
  truncated?: boolean;
  controlsTruncated?: boolean;
  dialogs?: string[];
  collectionComplete?: boolean;
  collectionLimitReached?: boolean;
}

export async function snapshot(
  params: { tabId?: number; scope?: "full_page" | "viewport"; decision?:boolean; cursor?: string; viewScopeId?: string; fresh?: boolean },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ text: string; tabId: number; documentId?:string; textEvidence?:PageTextEvidence; url?:string; title?:string; translation?:TranslationDisplayState|null; marks?:HostDrawnMark[]; observation?:BrowserObservation }> {
  let tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const tabId = tab.id;
  assertNoPendingDialog(tabId);

  if(params.decision&&params.scope==='viewport')throw new Error('DECISION_UNSUPPORTED: 决策观察需要完整控件树，不能退回 viewport DOM 身份。');

  const read = (seen: chrome.tabs.Tab) => withObservedDocumentIdentity(tabId, sessionId, async () => {
    const [result, translation, marks] = await Promise.all([
      snapshotTab(tabId, params.scope, params.decision),
      Promise.resolve().then(() => chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, world: 'ISOLATED', func: readTranslationDisplay })).then(r => r[0]?.result ?? null).catch(() => null),
      Promise.resolve().then(() => chrome.scripting.executeScript({ target: { tabId }, injectImmediately: true, world: 'ISOLATED', func: readMarksDisplay })).then(r => r[0]?.result ?? []).catch(() => []),
    ]);
    const current=await chrome.tabs.get(tabId);

    if(current.id!==seen.id||current.url!==seen.url)throw new Error(URL_MOVED_DURING_READ);

    const snapshotValue: SnapshotRead = {...result,tabId};

    if(translation) snapshotValue.translation=translation;

    if(marks.length) snapshotValue.marks=marks;

    if(typeof current.url==='string') snapshotValue.url=current.url;

    return snapshotValue;
  });

  let captured: Awaited<ReturnType<typeof read>>;

  try {
    captured = await read(tab);
  } catch (error) {
    if (!(error instanceof Error) || (error.message !== URL_MOVED_DURING_READ && (error as {code?: unknown}).code !== 'STALE_DOCUMENT')) throw error;
    if ((await waitForInteractive(tabId, PAGE_MOVE_WAIT_MS)).readiness === 'timeout') throw error;
    tab = await chrome.tabs.get(tabId);
    assertNoPendingDialog(tabId);
    captured = await read(tab);
  }

  const {controls,truncated,controlsTruncated,dialogs,collectionComplete,collectionLimitReached,...value}=captured.value;
  const identified: SnapshotBody = {...value};

  if(captured.documentId) identified.documentId=captured.documentId;

  if(!params.decision)return identified;

  if(!captured.documentId||!value.url||!controls)throw new Error('DECISION_UNSUPPORTED: 缺少文档身份或结构化控件。');
  const viewport=await chrome.scripting.executeScript({target:{tabId},world:'ISOLATED',func:readDecisionViewport});

  if(viewport[0]?.documentId!==captured.documentId)throw new Error('DECISION_STALE: 页面在观察期间变化。');
  const tabs=(await listTabs(sessionId)).tabs.filter(t=>!t.url.startsWith(chrome.runtime.getURL('')));

  if (params.fresh && params.cursor) throw new Error('DECISION_CURSOR: 新采集不能带续读游标。');
  const continuing = !params.fresh && !!(params.cursor || params.viewScopeId);
  const active = continuing ? browserObservations.readActive(sessionId, tabId) : undefined;

  if (continuing) {
    if (!active) throw new Error('DECISION_CURSOR: 没有可续读的采集。');

    if (active.page.documentId !== captured.documentId || active.page.url !== value.url) {
      throw new Error('DECISION_STALE: 续读时页面身份已变化，请重新观察。');
    }
  }

  const generation = active?.generation ?? crypto.randomUUID();
  const collectedControls = active?.collected ?? controls;
  const collectedTabs = active?.collectedTabs ?? tabs;

  const viewInput = {
    collected: collectedControls,
    tabs: collectedTabs,
    collectionComplete: continuing
      ? (active!.page.collectionComplete ?? true)
      : (collectionComplete ?? !(controlsTruncated || false)),
    collectionLimitReached: continuing ? active!.page.collectionLimitReached : collectionLimitReached,
    generation,
    textTruncated: continuing ? !!(active!.page.textTruncated ?? active!.page.truncated) : !!truncated,
    cursor: params.cursor,
    viewScopeId: params.viewScopeId,
  };

  let view: ReturnType<typeof selectObservationView>;

  try {
    view = selectObservationView(viewInput);
  } catch (e) {
    if (!params.fresh || !params.viewScopeId) throw e;
    view = selectObservationView({ ...viewInput, viewScopeId: undefined });
  }

  addAxRefs(tabId, collectedControls.map(c => Number(c.ref.slice(1))).filter(n => Number.isSafeInteger(n)));

  const page: Omit<BrowserObservation, "id" | "observedAt"> = {
    tabId,
    documentId:captured.documentId,
    url:value.url,
    text: continuing ? active!.page.text : value.text,
    controls:view.controls,
    truncated:view.truncated,
    textTruncated:view.textTruncated,
    controlsTruncated:view.controlsTruncated,
    collectedCount:view.collectedCount,
    collectionComplete:view.collectionComplete,
    generation:view.generation,
    viewComplete:view.viewComplete,
    visibleCount:view.visibleCount,
    hasMore:view.hasMore,
    dialogs: continuing ? (active!.page.dialogs ?? []) : (dialogs??[]),
    source:'accessibility',
    viewport:viewport[0]?.result,
    visibleText:viewport[0]?.result?.text,
    tabs:view.tabs,
    tabsTruncated:view.tabsTruncated,
    tabsHasMore:view.tabsHasMore,
  };

  if(view.collectionLimitReached) page.collectionLimitReached=true;

  if(view.viewScopeId){
    page.viewScopeId=view.viewScopeId;
    page.viewScopeLabel=view.viewScopeLabel;
  }

  if(view.nextCursor) page.nextCursor=view.nextCursor;

  if(view.scopes){
    page.scopes=view.scopes;
    page.scopesTruncated=view.scopesTruncated;
    page.scopesHasMore=view.scopesHasMore;

    if(view.scopesNextCursor) page.scopesNextCursor=view.scopesNextCursor;
  }

  if(view.tabsNextCursor) page.tabsNextCursor=view.tabsNextCursor;

  const observation=browserObservations.issue(sessionId,page,{collectedControls,collectedTabs,generation:view.generation});
  const result: Awaited<ReturnType<typeof snapshot>> = {...identified,observation};

  if(tab.title) result.title=tab.title;

  return result;
}

export async function snapshotTab(
  tabId: number,
  scope: "full_page" | "viewport" = "full_page",
  decision=false,
): Promise<{ text: string; tabId: number; textEvidence?:PageTextEvidence; controls?:BrowserControl[];truncated?:boolean;controlsTruncated?:boolean;dialogs?:string[];collectionComplete?:boolean;collectionLimitReached?:boolean }> {
  if (scope === "viewport") {
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);
    forgetPage(tabId);

    return {
      text: `[说明：scope=viewport 当前为简化 DOM 视口快照降级（仅覆盖当前视口，非全量 AX 树；视口内 iframe 仅占位未展开，不覆盖其内容）；以下 ref 为本次 DOM 快照编号，仅 domops 路径有效，旧 AX ref 已失效、请勿混用。如需全页 AX 树请用 scope=full_page]\n${dom.text}`,
      tabId,
    };
  }

  if (!decision && await tabShowsPdf(tabId)) {
    const text = await pdfText(tabId, (await chrome.tabs.get(tabId)).url ?? "");
    clearAxSnapshot(tabId);
    forgetPage(tabId);

    return { text, tabId };
  }

  try {
    const ax = await axSnapshot(tabId,decision);

    return decision?{...ax,tabId}:{text:ax.text,textEvidence:ax.textEvidence,tabId};
  } catch (e) {
    if(decision)throw new Error(`DECISION_UNSUPPORTED: 无法取得可靠控件树：${oneLine(e)}`);
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);
    forgetPage(tabId);

    return {
      text: `[回退：CDP 无障碍树快照不可用（${oneLine(e)}），以下为简化 DOM 快照；旧 AX ref 已失效，请用本次 ref]\n${dom.text}`,
      tabId,
    };
  }
}

async function readAxPage(tabId: number, decision = false, budget?: number) {
  const zeroSizeRead = readZeroSizeNodes(tabId);
  const overlayRead = ownOverlayHosts(tabId);
  const result = decision?{nodes:await readDecisionTree(tabId)}:await withTimeout(
    sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.getFullAXTree"),
    8_000,
    "Accessibility.getFullAXTree 8 秒内没有返回",
  );

  if ((result.nodes ?? []).length === 0) throw new Error("Accessibility.getFullAXTree 返回空树");
  const nodes = withoutSubtrees(result.nodes!, await overlayRead);
  const [secret, ranges, zeroSize] = await Promise.all([
    readSecretFields(tabId, nodes),
    readInputRanges(tabId, nodes),
    zeroSizeRead,
  ]);
  const found = repeatedItems(nodes, zeroSize);

  return { nodes, secret, zeroSize, found, ...axTreeToText(nodes, budget, ranges, secret, zeroSize, itemTexts(nodes, found, zeroSize)) };
}

const MAX_CHANGED_ROOTS = 12;

export async function readPageChanges(tabId: number, roots: ReadonlyArray<{ sel: string; field?: true }>, opts: { scrub: (body: string) => string; current: () => boolean }): Promise<{ text: string; refs: number[] } | null> {
  if (!hasPageBaseline(tabId)) return null;

  if (!roots.length) return { text: "", refs: [] };
  const objectGroup = `bys-page-changes-${crypto.randomUUID()}`;
  const contextId = await isolatedReadContext(tabId);
  const nodes = new Map<string, AxNodeLite>();
  const inFields = new Set<number>();

  try {
    await Promise.all(roots.slice(0, MAX_CHANGED_ROOTS).map(async root => {
      const found = await sendCommand<{ result?: { objectId?: string } }>(tabId, "Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(root.sel)})`, contextId, objectGroup }).catch(() => undefined);

      if (!found?.result?.objectId) return;
      const described = await sendCommand<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId: found.result.objectId }).catch(() => undefined);

      if (!described) return;
      const sub = await sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.queryAXTree", { backendNodeId: described.node.backendNodeId }).catch(() => ({ nodes: [] }));

      for (const n of sub.nodes ?? []) {
        nodes.set(n.nodeId, n);

        if (root.field && n.backendDOMNodeId !== undefined) inFields.add(n.backendDOMNodeId);
      }
    }));
  } finally {
    void sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }

  const list = withoutSubtrees([...nodes.values()], await ownOverlayHosts(tabId));
  const secret = await readSecretFields(tabId, list);
  const { entries } = axTreeToText(list, undefined, await readInputRanges(tabId, list), secret);
  const lines = entries.map(line => line.ref !== undefined && inFields.has(line.ref) ? { ...line, inField: true } : line);
  const found = repeatedItems(list);
  const fresh = (freshLines(tabId, lines) ?? []).flatMap(line => line.ref === undefined ? [] : [line.ref]);
  const items = await withTimeout(readItems(tabId, fresh, list, found), ITEM_TIMEOUT_MS, "读所在那一项超时").catch(() => new Map<number, string>());

  if (!opts.current()) return null;
  const changes = pageChangesSince(tabId, lines, opts.scrub, items, found);

  if (changes) addAxRefs(tabId, changes.refs);

  return changes;
}

const MAX_ITEM_LOOKUPS = 8;
const ITEM_TIMEOUT_MS = 300;

async function readItems(tabId: number, refs: readonly number[], nodes: readonly AxNodeLite[], found: RepeatedItems): Promise<Map<number, string>> {
  const known = knownItems(tabId);
  const isItem = (id: number) => found.items.has(id) || known.items.has(id);
  const out = new Map<number, string>();
  const reads = new Map<number, Promise<AxNodeLite[] | undefined>>();
  const readItem = (item: number) => {
    let read = reads.get(item);

    if (!read) {
      read = sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.queryAXTree", { backendNodeId: item }).then(sub => sub.nodes, () => undefined);
      reads.set(item, read);
    }

    return read;
  };

  await Promise.all(refs.slice(0, MAX_ITEM_LOOKUPS).map(async ref => {
    const remembered = found.byRef.get(ref) ?? known.byRef.get(ref);
    let item = remembered?.item ?? enclosingItem(nodes, ref, isItem);
    const from = remembered?.from ?? 0;

    if (item === undefined) {
      const partial = await sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.getPartialAXTree", { backendNodeId: ref, fetchRelatives: true }).catch(() => undefined);

      item = partial?.nodes ? enclosingItem(partial.nodes, ref, isItem) : undefined;
    }

    if (item === undefined) return;
    const sub = itemTextOf(nodes, item, ref, from) === undefined ? await readItem(item) : nodes;
    const text = sub ? itemTextOf(sub, item, ref, from) : undefined;

    if (text) out.set(ref, text);
  }));

  return out;
}

async function axSnapshot(tabId: number,decision=false): Promise<{ text: string;textEvidence:PageTextEvidence;controls:BrowserControl[];truncated:boolean;controlsTruncated:boolean;dialogs:string[];collectionComplete:boolean;collectionLimitReached:boolean }> {
  const { nodes, secret, zeroSize, found, text, backendIds, truncated, shown } = await readAxPage(tabId, decision);
  const textEvidence=axTextEvidence(withoutSecretText(nodes, secret));
  rememberPage(tabId, shown, found);
  recordLocatedNames(tabId, text);

  if(!decision){
    recordAxSnapshot(tabId, backendIds);

    return {text,textEvidence,controls:[],truncated,controlsTruncated:false,dialogs:[],collectionComplete:true,collectionLimitReached:false};
  }

  const collected = collectDecisionControls(nodes);
  collected.controls = collected.controls.filter(c => zeroSize.get(Number(c.ref.slice(1))) !== false);
  recordAxSnapshot(tabId, [...backendIds, ...collected.controls.map(c => Number(c.ref.slice(1))).filter(n => Number.isSafeInteger(n))]);

  return {
    text,
    textEvidence,
    controls: collected.controls,
    truncated,
    controlsTruncated: !collected.collectionComplete,
    dialogs: decisionDialogs(nodes),
    collectionComplete: collected.collectionComplete,
    collectionLimitReached: collected.collectionLimitReached,
  };
}

async function ownOverlayHosts(tabId: number): Promise<Set<number>> {
  const objectGroup = `bys-own-overlay-${crypto.randomUUID()}`;

  try {
    const list = await sendCommand<{ result?: { objectId?: string } }>(tabId, "Runtime.evaluate", { expression: `[...document.querySelectorAll(${JSON.stringify(overlayHostSelector())})]`, objectGroup });

    if (!list.result?.objectId) return new Set();
    const { result } = await sendCommand<{ result: Array<{ name: string; value?: { objectId?: string } }> }>(tabId, "Runtime.getProperties", { objectId: list.result.objectId, ownProperties: true });
    const hosts = result.flatMap(p => /^\d+$/.test(p.name) && p.value?.objectId ? [p.value.objectId] : []);

    return new Set(await Promise.all(hosts.map(async objectId => (await sendCommand<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", { objectId })).node.backendNodeId)));
  } catch {
    return new Set();
  } finally {
    void sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }
}

function withoutSubtrees(nodes: AxNodeLite[], hosts: Set<number>): AxNodeLite[] {
  if (hosts.size === 0) return nodes;
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const drop = new Set<string>();
  const stack = nodes.filter(n => n.backendDOMNodeId !== undefined && hosts.has(n.backendDOMNodeId)).map(n => n.nodeId);

  while (stack.length) {
    const id = stack.pop()!;

    if (drop.has(id)) continue;
    drop.add(id);
    stack.push(...(byId.get(id)?.childIds ?? []));
  }

  return nodes.filter(n => !drop.has(n.nodeId));
}

async function readZeroSizeNodes(tabId: number): Promise<Map<number, boolean>> {
  const zero = new Map<number, boolean>();
  const sized = new Set<number>();

  try {
    const snap = await withTimeout(
      sendCommand<{ strings?: string[]; documents?: Array<{ nodes?: { backendNodeId?: number[]; nodeName?: number[]; attributes?: number[][] }; layout?: { nodeIndex?: number[]; bounds?: number[][] } }> }>(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: [] }),
      3_000,
      "布局盒子读取 3 秒内没有返回",
    );

    const strings = snap.strings ?? [];

    for (const doc of snap.documents ?? []) {
      const ids = doc.nodes?.backendNodeId ?? [];
      const bounds = doc.layout?.bounds ?? [];

      const keepsRef = (index: number) => {
        const tag = strings[doc.nodes?.nodeName?.[index] ?? -1];

        if (tag === "SELECT") return true;
        const attrs = doc.nodes?.attributes?.[index] ?? [];

        for (let a = 0; tag === "INPUT" && a + 1 < attrs.length; a += 2) {
          if (strings[attrs[a]!] === "type") return strings[attrs[a + 1]!]?.toLowerCase() === "file";
        }

        return false;
      };

      doc.layout?.nodeIndex?.forEach((index, i) => {
        const box = bounds[i];
        const id = ids[index];

        if (!box || id === undefined) return;

        if (box[2] === 0 || box[3] === 0) zero.set(id, keepsRef(index)); else sized.add(id);
      });
    }

    for (const id of sized) zero.delete(id);
  } catch {
    zero.clear();
  }

  return zero;
}

const MAX_RANGE_INPUTS = 40;

async function readInputRanges(tabId: number, nodes: readonly AxNodeLite[]): Promise<Map<number, InputRangeReadout>> {
  const ranges = new Map<number, InputRangeReadout>();
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const insideDateTime = (n: AxNodeLite) => ["InputTime", "Date", "DateTime"].includes(byId.get(n.parentId ?? "")?.role?.value ?? "");

  const ids = nodes
    .flatMap(n => !n.ignored && n.backendDOMNodeId !== undefined && RANGE_INPUT_ROLES.has(n.role?.value ?? "") && !insideDateTime(n) ? [n.backendDOMNodeId] : [])
    .slice(0, MAX_RANGE_INPUTS);

  if (!ids.length) return ranges;
  const objectGroup = `bys-range-inputs-${crypto.randomUUID()}`;

  try {
    await withTimeout((async () => {
      const executionContextId=await isolatedReadContext(tabId);
      const resolved = (await Promise.all(ids.map(id => sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: id, objectGroup, executionContextId })
        .then(node => node.object?.objectId ? { id, objectId: node.object.objectId } : null, () => null))))
        .filter((r): r is { id: number; objectId: string } => r !== null);

      if (!resolved.length) return;

      const response = await sendCommand<{ result?: { value?: Array<InputRangeReadout | null> } }>(tabId, "Runtime.callFunctionOn", {
        objectId: resolved[0]!.objectId,
        functionDeclaration: `function(...elements){return elements.map(${readInputRange.toString()});}`,
        arguments: resolved.map(r => ({ objectId: r.objectId })),
        returnByValue: true,
      });

      response.result?.value?.forEach((readout, i) => { if (readout) ranges.set(resolved[i]!.id, readout); });
    })(), 3_000, "范围输入框读取 3 秒内没有返回");
  } catch {
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }

  return ranges;
}

const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

async function readSecretFields(tabId: number, nodes: readonly AxNodeLite[]): Promise<Set<number>> {
  const ids = nodes.flatMap(n => !n.ignored && n.backendDOMNodeId !== undefined && FIELD_ROLES.has(n.role?.value ?? "") ? [n.backendDOMNodeId] : []);
  const secret = new Set(ids);

  if (!ids.length) return secret;
  const objectGroup = `bys-secret-fields-${crypto.randomUUID()}`;

  try {
    await withTimeout((async () => {
      const executionContextId = await isolatedReadContext(tabId);
      const resolved = (await Promise.all(ids.map(id => sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: id, objectGroup, executionContextId })
        .then(node => node.object?.objectId ? { id, objectId: node.object.objectId } : null, () => null))))
        .filter((r): r is { id: number; objectId: string } => r !== null);

      if (!resolved.length) return;

      const response = await sendCommand<{ result?: { value?: boolean[] } }>(tabId, "Runtime.callFunctionOn", {
        objectId: resolved[0]!.objectId,
        functionDeclaration: `function(sensitiveName, ...elements){return elements.map(el => (${isSecretFieldInPage.toString()})(el, sensitiveName));}`,
        arguments: [{ value: SENSITIVE_FIELD_NAME.source }, ...resolved.map(r => ({ objectId: r.objectId }))],
        returnByValue: true,
      });

      response.result?.value?.forEach((isSecret, i) => { if (isSecret === false) secret.delete(resolved[i]!.id); });
    })(), 3_000, "敏感栏判定 3 秒内没有返回");
  } catch {
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }

  return secret;
}

function isSecretFieldInPage(el: Element, sensitiveName: string): boolean {
  const field = el as HTMLElement & HTMLInputElement;
  const tag = field.tagName.toLowerCase();

  if (!(tag === "input" || tag === "textarea" || field.isContentEditable)) return false;

  if (tag === "input" && field.type === "password") field.setAttribute("data-bys-was-password", "");
  const by = field.getAttribute("aria-labelledby");
  const name = field.getAttribute("aria-label")
    || (by ? by.split(/\s+/).map((id) => field.ownerDocument.getElementById(id)?.textContent ?? "").join(" ") : "")
    || ("labels" in field && field.labels?.[0]?.textContent) || "";
  const normalize = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ").toLowerCase();

  return (tag === "input" && (field.type === "password" || field.hasAttribute("data-bys-was-password")))
    || /one-time-code|cc-(number|csc|exp)/i.test(String(field.getAttribute("autocomplete") ?? ""))
    || new RegExp(sensitiveName, "i").test([field.getAttribute("name"), field.id, name, field.getAttribute("placeholder"), field.getAttribute("aria-label"), field.getAttribute("title")].map((part) => normalize(String(part ?? ""))).join(" "));
}

function withoutSecretText(nodes: readonly AxNodeLite[], secret: ReadonlySet<number>): AxNodeLite[] {
  if (!secret.size) return [...nodes];
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const drop = new Set<string>();
  const stack = nodes.filter(n => n.backendDOMNodeId !== undefined && secret.has(n.backendDOMNodeId)).flatMap(n => n.childIds ?? []);

  while (stack.length) {
    const id = stack.pop()!;

    if (drop.has(id)) continue;
    drop.add(id);
    stack.push(...(byId.get(id)?.childIds ?? []));
  }

  return nodes.filter(n => !drop.has(n.nodeId));
}

async function domSnapshot(tabId: number, scope: "full_page" | "viewport"): Promise<{ text: string }> {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content-snapshot.js"],
    world: "ISOLATED",
  });

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    func: (s: string) => {
      const snap = window.__sideagent?.snapshot;

      if (!snap) throw new Error("snapshot 脚本未注入");

      return snap(s);
    },
    args: [scope],
  });

  const text = results[0]?.result;

  if (typeof text !== "string") throw new Error("snapshot 未返回文本");

  return { text };
}

function readDecisionViewport():{x:number;y:number;width:number;height:number;text:string}{
 const pieces:string[]=[];let size=0,count=0;
 const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);

 while(walker.nextNode()&&count++<3000&&size<6000){
  const node=walker.currentNode,parent=node.parentElement,text=node.textContent?.trim();

  if(!parent||!text||parent.closest('script,style,noscript,template,[aria-hidden="true"],[inert],[data-sideagent-overlay],[data-sideagent-ask]'))continue;

  if(parent.checkVisibility?.({checkOpacity:true,checkVisibilityCSS:true})===false)continue;
  const style=getComputedStyle(parent);

if(style.visibility==='hidden'||style.display==='none'||style.opacity==='0')continue;
  const range=document.createRange();range.selectNodeContents(node);

  if(!Array.from(range.getClientRects()).some(r=>r.width>0&&r.height>0&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth))continue;
  pieces.push(text);size+=text.length;
 }

 return {x:scrollX,y:scrollY,width:innerWidth,height:innerHeight,text:pieces.join('\n').slice(0,6000)};
}

function readMarksDisplay():HostDrawnMark[] {
  return window.__sideagent?.marksState?.() ?? [];
}

function readTranslationDisplay():TranslationDisplayState|null {
  type Block={element:HTMLElement;output?:HTMLElement;segments:Array<{node:Text;original:string;translation?:string}>};

  const state=(globalThis as typeof globalThis & {__bysTranslation?:{token:string;url:string;mode:'bilingual'|'translated';fontFamily:'original'|'songti';blocks:Map<HTMLElement,Block>}}).__bysTranslation;
  const url=new URL(location.href);url.hash='';

  if(!state||state.url!==url.href)return null;
  const blocks=[...state.blocks.values()].filter(b=>b.segments.every(s=>s.translation!==undefined));

  const displayValid=blocks.length>0&&blocks.every(b=>{
    if(!b.element.isConnected||!b.segments.every(s=>s.node.isConnected&&b.element.contains(s.node)&&s.node.data===(state.mode==='translated'?s.translation:s.original)))return false;
    const target=state.mode==='bilingual'?b.output:b.element;

    if(!target?.isConnected)return false;

    if(state.mode==='bilingual'&&target.textContent!==b.segments.map(s=>s.translation).join(''))return false;
    const style=getComputedStyle(target);

    if(style.display==='none'||style.visibility==='hidden'||target.getClientRects().length===0)return false;

    return state.fontFamily!=='songti'||/Songti SC|STSong|SimSun/.test(style.fontFamily);
  });

  return {document:state.token,mode:state.mode,fontFamily:state.fontFamily,translated:blocks.length,displayValid};
}
