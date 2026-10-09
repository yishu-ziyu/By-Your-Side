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
import { axTreeToText, RANGE_INPUT_ROLES, type AxNodeLite } from "../axtree.js";
import type { InputRangeReadout } from "../../../../shared/page-readout.js";
import { readInputRange } from "../../shared/range-input.js";
import { addAxRefs, clearAxSnapshot, recordAxSnapshot } from "../axstate.js";
import { withTimeout } from "../timeout.js";
import { assertNoPendingDialog } from "../page-events.js";
import { SENSITIVE_FIELD_NAME } from "../../../../shared/trace-sanitize.js";

/** 交给调用方的 snapshot 正文：页面内容与身份，不含采集预算字段。 */
interface SnapshotBody {
  text: string;
  tabId: number;
  documentId?: string;
  textEvidence?: PageTextEvidence;
  url?: string;
  translation?: TranslationDisplayState | null;
  /** 本扩展画在页面上的标注；没有标注时不带。 */
  marks?: HostDrawnMark[];
}

/** 一次读取拿到的值：snapshot 正文 + 采集预算字段；url/translation 只在读到时才带上。 */
interface SnapshotRead extends SnapshotBody {
  controls?: BrowserControl[];
  truncated?: boolean;
  controlsTruncated?: boolean;
  dialogs?: string[];
  collectionComplete?: boolean;
  collectionLimitReached?: boolean;
}

/**
 * snapshot 工具：scope=full_page（默认）走 CDP Accessibility 全量无障碍树；
 * scope=viewport 走已有 DOM 视口快照（真做视口过滤，明确声明降级）。
 * 任何一次返回 DOM 快照后都清掉该页 AX 登记：DOM ref 与 backendDOMNodeId
 * 同处数字空间，不清会导致后续 @N 经 isAxRef 误走 CDP。
 */
export async function snapshot(
  params: { tabId?: number; scope?: "full_page" | "viewport"; decision?:boolean; cursor?: string; viewScopeId?: string; fresh?: boolean },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ text: string; tabId: number; documentId?:string; textEvidence?:PageTextEvidence; url?:string; title?:string; translation?:TranslationDisplayState|null; marks?:HostDrawnMark[]; observation?:BrowserObservation }> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  assertNoPendingDialog(tab.id);

  if(params.decision&&params.scope==='viewport')throw new Error('DECISION_UNSUPPORTED: 决策观察需要完整控件树，不能退回 viewport DOM 身份。');

  const captured=await withObservedDocumentIdentity(tab.id, sessionId, async () => {
    const result=await snapshotTab(tab.id!,params.scope,params.decision);
    const current=await chrome.tabs.get(tab.id!);

    // SPA URL changes do not necessarily replace the document. Do not label the
    // new content with the address observed before the read began.
    if(current.id!==tab.id||current.url!==tab.url)throw new Error('读取期间页面地址已变化，请重新读取当前页面。');
    // 不等页面空闲：页面还在加载时默认注入会卡到加载完（少数派冷启动实测 6.4 秒），开工前读页因此超时。
    const translation=await Promise.resolve().then(()=>chrome.scripting.executeScript({target:{tabId:tab.id!},injectImmediately:true,world:'ISOLATED',func:readTranslationDisplay})).then(r=>r[0]?.result??null).catch(()=>null);

    const marks=await Promise.resolve().then(()=>chrome.scripting.executeScript({target:{tabId:tab.id!},injectImmediately:true,world:'ISOLATED',func:readMarksDisplay})).then(r=>r[0]?.result??[]).catch(()=>[]);

    const snapshotValue: SnapshotRead = {...result,tabId:tab.id!};

    if(translation) snapshotValue.translation=translation;

    if(marks.length) snapshotValue.marks=marks;

    if(typeof current.url==='string') snapshotValue.url=current.url;

    return snapshotValue;
  });

  const {controls,truncated,controlsTruncated,dialogs,collectionComplete,collectionLimitReached,...value}=captured.value;
  const identified: SnapshotBody = {...value};

  if(captured.documentId) identified.documentId=captured.documentId;

  if(!params.decision)return identified;

  if(!captured.documentId||!value.url||!controls)throw new Error('DECISION_UNSUPPORTED: 缺少文档身份或结构化控件。');
  const viewport=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:readDecisionViewport});

  if(viewport[0]?.documentId!==captured.documentId)throw new Error('DECISION_STALE: 页面在观察期间变化。');
  const tabs=(await listTabs(sessionId)).tabs.filter(t=>!t.url.startsWith(chrome.runtime.getURL('')));

  if (params.fresh && params.cursor) throw new Error('DECISION_CURSOR: 新采集不能带续读游标。');
  // fresh + viewScopeId: collect again, then show that partition if it still exists.
  const continuing = !params.fresh && !!(params.cursor || params.viewScopeId);
  const active = continuing ? browserObservations.readActive(sessionId, tab.id) : undefined;

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
    // The acted-on partition can disappear (navigation, closed menu); the fresh page's default view is still true.
    if (!params.fresh || !params.viewScopeId) throw e;
    view = selectObservationView({ ...viewInput, viewScopeId: undefined });
  }

  // Register every collected AX identity for execution — not only text-rendered refs.
  // Merge: the text refs of this capture were registered by axSnapshot and stay executable (e.g. mark on a text node).
  addAxRefs(tab.id, collectedControls.map(c => Number(c.ref.slice(1))).filter(n => Number.isSafeInteger(n)));

  const page: Omit<BrowserObservation, "id" | "observedAt"> = {
    tabId:tab.id,
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

  // 回答出处要写页面标题，不只写域名。
  if(tab.title) result.title=tab.title;

  return result;
}

/** 对指定标签做 snapshot，不改工作标签认领。交还时读用户当前页用。 */
export async function snapshotTab(
  tabId: number,
  scope: "full_page" | "viewport" = "full_page",
  decision=false,
): Promise<{ text: string; tabId: number; textEvidence?:PageTextEvidence; controls?:BrowserControl[];truncated?:boolean;controlsTruncated?:boolean;dialogs?:string[];collectionComplete?:boolean;collectionLimitReached?:boolean }> {
  if (scope === "viewport") {
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);

    return {
      text: `[说明：scope=viewport 当前为简化 DOM 视口快照降级（仅覆盖当前视口，非全量 AX 树；视口内 iframe 仅占位未展开，不覆盖其内容）；以下 ref 为本次 DOM 快照编号，仅 domops 路径有效，旧 AX ref 已失效、请勿混用。如需全页 AX 树请用 scope=full_page]\n${dom.text}`,
      tabId,
    };
  }

  try {
    const ax = await axSnapshot(tabId,decision);

    return decision?{...ax,tabId}:{text:ax.text,textEvidence:ax.textEvidence,tabId};
  } catch (e) {
    if(decision)throw new Error(`DECISION_UNSUPPORTED: 无法取得可靠控件树：${oneLine(e)}`);
    const dom = await domSnapshot(tabId, scope);
    clearAxSnapshot(tabId);

    return {
      text: `[回退：CDP 无障碍树快照不可用（${oneLine(e)}），以下为简化 DOM 快照；旧 AX ref 已失效，请用本次 ref]\n${dom.text}`,
      tabId,
    };
  }
}

async function axSnapshot(tabId: number,decision=false): Promise<{ text: string;textEvidence:PageTextEvidence;controls:BrowserControl[];truncated:boolean;controlsTruncated:boolean;dialogs:string[];collectionComplete:boolean;collectionLimitReached:boolean }> {
  const result = decision?{nodes:await readDecisionTree(tabId)}:await withTimeout(
    sendCommand<{ nodes?: AxNodeLite[] }>(tabId, "Accessibility.getFullAXTree"),
    8_000,
    "Accessibility.getFullAXTree 8 秒内没有返回",
  );

  const nodes = result.nodes ?? [];

  if (nodes.length === 0) throw new Error("Accessibility.getFullAXTree 返回空树");
  const secret = await readSecretFields(tabId, nodes);
  const { text, backendIds, truncated } = axTreeToText(nodes, undefined, await readInputRanges(tabId, nodes), secret);
  const textEvidence=axTextEvidence(withoutSecretText(nodes, secret));

  if(!decision){
    recordAxSnapshot(tabId, backendIds);

    return {text,textEvidence,controls:[],truncated,controlsTruncated:false,dialogs:[],collectionComplete:true,collectionLimitReached:false};
  }

  // Decision controls come from the AX tree itself — never from text-budget keptRefs.
  // Text refs shown to the model are executable too (mark/read a text node), so register both.
  const collected = collectDecisionControls(nodes);
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

/** 一次快照最多补读的范围输入框；页面再多也只多花有限几次 CDP 往返。 */
const MAX_RANGE_INPUTS = 40;

/**
 * AX 树不带原生时间/日期框的 min/max/step（数字框也不带 step）：对这几类角色按 backendDOMNodeId
 * 补读 DOM 属性、当前值与浏览器的有效性判定。读不到时返回空表，快照照常输出，只是没有范围。
 */
async function readInputRanges(tabId: number, nodes: readonly AxNodeLite[]): Promise<Map<number, InputRangeReadout>> {
  const ranges = new Map<number, InputRangeReadout>();
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  // 时间/日期框内部的「时/分」「年/月/日」子框也是 spinbutton，它们不是 input，不占名额。
  const insideDateTime = (n: AxNodeLite) => ["InputTime", "Date", "DateTime"].includes(byId.get(n.parentId ?? "")?.role?.value ?? "");

  const ids = nodes
    .flatMap(n => !n.ignored && n.backendDOMNodeId !== undefined && RANGE_INPUT_ROLES.has(n.role?.value ?? "") && !insideDateTime(n) ? [n.backendDOMNodeId] : [])
    .slice(0, MAX_RANGE_INPUTS);

  if (!ids.length) return ranges;
  const objectGroup = `bys-range-inputs-${crypto.randomUUID()}`;

  try {
    await withTimeout((async () => {
      const executionContextId=await isolatedReadContext(tabId);
      const resolved: Array<{ id: number; objectId: string }> = [];

      for (const id of ids) {
        const node = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: id, objectGroup,executionContextId }).catch(() => undefined);

        if (node?.object?.objectId) resolved.push({ id, objectId: node.object.objectId });
      }

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
    // 只是少了范围信息，不让整次快照失败。
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }

  return ranges;
}

/** 可能装着用户输入的角色：只有它们去页面里查是不是密码、卡号、验证码这类栏。 */
const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

/**
 * AX 树照抄输入框里的值（卡号、安全码、PIN 等），快照又会原样交给模型。这里按 backendDOMNodeId
 * 到页面里查哪些栏是敏感栏，规则同 exec/input.ts 的 readFieldInPage。查不到的栏按敏感处理：宁可少给模型一个值。
 */
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
    // 判定失败时所有输入栏都按敏感处理，快照照常输出，只是不带这些值。
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
  }

  return secret;
}

/** 在页面里执行，保持自包含。规则与 exec/input.ts 的 readFieldInPage 相同，包括给密码栏打「曾经是 password」的标记。 */
function isSecretFieldInPage(el: Element, sensitiveName: string): boolean {
  // SAFETY: 只读 input/textarea 的通用属性；tagName 与 isContentEditable 决定是否可编辑。
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

/** 去掉敏感栏下面的节点（输入框里的文字就是值），给页面原文证据用。 */
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

/** 旧实现：注入 content-snapshot.js（幂等）后调用 window.__sideagent.snapshot(scope)。 */
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

/** Compact visible prose accompanies, but never replaces, native AX control identities. */
export function readDecisionViewport():{x:number;y:number;width:number;height:number;text:string}{
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

/** 标注层在内容脚本的隔离环境里；页面写的文字不能冒充这里的读数。 */
export function readMarksDisplay():HostDrawnMark[] {
  return window.__sideagent?.marksState?.() ?? [];
}

/** Serialized read-only observation; never trust page-written text as a completion flag. */
export function readTranslationDisplay():TranslationDisplayState|null {
  type Block={element:HTMLElement;output?:HTMLElement;outputs?:HTMLElement[];segments:Array<{node:Text;original:string;translation?:string}>};

  const state=(globalThis as typeof globalThis & {__bysTranslation?:{token:string;url:string;mode:'bilingual'|'translated';fontFamily:'original'|'songti';blocks:Map<HTMLElement,Block>}}).__bysTranslation;
  const url=new URL(location.href);url.hash='';

  if(!state||state.url!==url.href)return null;
  const blocks=[...state.blocks.values()].filter(b=>b.segments.every(s=>s.translation!==undefined));

  const displayValid=blocks.length>0&&blocks.every(b=>{
    if(!b.element.isConnected||!b.segments.every(s=>s.node.isConnected&&b.element.contains(s.node)&&s.node.data===s.original))return false;
    const targets=b.outputs??(b.output?[b.output]:[]);

    if(!targets.length||targets.map(target=>target.textContent).join('')!==b.segments.map(s=>s.translation).join(''))return false;

    if(b.outputs&&(state.mode!=='translated'||targets.length!==b.segments.length))return false;

    return targets.every((target,i)=>{
      if(!target.isConnected||!b.element.contains(target))return false;

      if(b.outputs&&(!target.parentElement?.contains(b.segments[i]!.node)||target.textContent!==b.segments[i]!.translation))return false;
      const style=getComputedStyle(target);

      if(state.mode==='translated'&&(target.dataset.bysVellum!=='true'||style.position!=='absolute'))return false;

      if(style.display==='none'||style.visibility==='hidden'||target.getClientRects().length===0)return false;

      return state.fontFamily!=='songti'||/Songti SC|STSong|SimSun/.test(style.fontFamily);
    });
  });

  return {document:state.token,mode:state.mode,fontFamily:state.fontFamily,translated:blocks.length,displayValid};
}
