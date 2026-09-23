import { axTextEvidence } from '../ax-text-evidence.js';
import type { PageTextEvidence } from '../../../../shared/page-text-evidence.js';
import type {TranslationDisplayState} from '../../../../shared/page-translation.js';
import {withObservedDocumentIdentity} from "../observation-document.js";
import {browserObservations,collectDecisionControls,readDecisionTree,decisionDialogs,selectObservationView} from '../browser-observation.js';
import type {BrowserObservation,BrowserControl} from '../../../../shared/browser-decision.js';
import {listTabs} from './tabs.js';
import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveReadableTab } from "../state.js";
import { oneLine } from "../util.js";
import { axTreeToText, type AxNodeLite } from "../axtree.js";
import { clearAxSnapshot, recordAxSnapshot } from "../axstate.js";
import { withTimeout } from "../timeout.js";

/**
 * snapshot 工具：scope=full_page（默认）走 CDP Accessibility 全量无障碍树；
 * scope=viewport 走已有 DOM 视口快照（真做视口过滤，明确声明降级）。
 * 任何一次返回 DOM 快照后都清掉该页 AX 登记：DOM ref 与 backendDOMNodeId
 * 同处数字空间，不清会导致后续 @N 经 isAxRef 误走 CDP。
 */
export async function snapshot(
  params: { tabId?: number; scope?: "full_page" | "viewport"; decision?:boolean; cursor?: string; viewScopeId?: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ text: string; tabId: number; documentId?:string; textEvidence?:PageTextEvidence; url?:string; translation?:TranslationDisplayState|null; observation?:BrowserObservation }> {
  const tab = await resolveReadableTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");

  if(params.decision&&params.scope==='viewport')throw new Error('DECISION_UNSUPPORTED: 决策观察需要完整控件树，不能退回 viewport DOM 身份。');

  const captured=await withObservedDocumentIdentity(tab.id, sessionId, async () => {
    const result=await snapshotTab(tab.id!,params.scope,params.decision);
    const current=await chrome.tabs.get(tab.id!);

    // SPA URL changes do not necessarily replace the document. Do not label the
    // new content with the address observed before the read began.
    if(current.id!==tab.id||current.url!==tab.url)throw new Error('读取期间页面地址已变化，请重新读取当前页面。');
    const translation=await Promise.resolve().then(()=>chrome.scripting.executeScript({target:{tabId:tab.id!},world:'ISOLATED',func:readTranslationDisplay})).then(r=>r[0]?.result??null).catch(()=>null);

    return {...result,tabId:tab.id!,...(translation?{translation}:{}),...(typeof current.url==='string'?{url:current.url}:{})};
  });

  const {controls,truncated,controlsTruncated,dialogs,collectionComplete,collectionLimitReached,...value}=captured.value;
  const identified={...value,...(captured.documentId?{documentId:captured.documentId}:{})};

  if(!params.decision)return identified;

  if(!captured.documentId||!value.url||!controls)throw new Error('DECISION_UNSUPPORTED: 缺少文档身份或结构化控件。');
  const viewport=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:readDecisionViewport});

  if(viewport[0]?.documentId!==captured.documentId)throw new Error('DECISION_STALE: 页面在观察期间变化。');
  const tabs=(await listTabs(sessionId)).tabs.filter(t=>!t.url.startsWith(chrome.runtime.getURL('')));
  const continuing = !!(params.cursor || params.viewScopeId);
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

  const view = selectObservationView({
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
  });

  // Register every collected AX identity for execution — not only text-rendered refs.
  recordAxSnapshot(tab.id, collectedControls.map(c => Number(c.ref.slice(1))).filter(n => Number.isSafeInteger(n)));

  const observation=browserObservations.issue(sessionId,{
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
    ...(view.collectionLimitReached?{collectionLimitReached:true}:{}),
    generation:view.generation,
    ...(view.viewScopeId?{viewScopeId:view.viewScopeId,viewScopeLabel:view.viewScopeLabel}:{}),
    viewComplete:view.viewComplete,
    visibleCount:view.visibleCount,
    hasMore:view.hasMore,
    ...(view.nextCursor?{nextCursor:view.nextCursor}:{}),
    ...(view.scopes?{scopes:view.scopes,scopesTruncated:view.scopesTruncated,scopesHasMore:view.scopesHasMore,...(view.scopesNextCursor?{scopesNextCursor:view.scopesNextCursor}:{})}:{}),
    dialogs: continuing ? (active!.page.dialogs ?? []) : (dialogs??[]),
    source:'accessibility',
    viewport:viewport[0]?.result,
    visibleText:viewport[0]?.result?.text,
    tabs:view.tabs,
    tabsTruncated:view.tabsTruncated,
    tabsHasMore:view.tabsHasMore,
    ...(view.tabsNextCursor?{tabsNextCursor:view.tabsNextCursor}:{}),
  },{collectedControls,collectedTabs,generation:view.generation});

  return {...identified,observation};
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
  const { text, backendIds, truncated } = axTreeToText(nodes);
  const textEvidence=axTextEvidence(nodes);

  if(!decision){
    recordAxSnapshot(tabId, backendIds);

    return {text,textEvidence,controls:[],truncated,controlsTruncated:false,dialogs:[],collectionComplete:true,collectionLimitReached:false};
  }

  // Decision controls come from the AX tree itself — never from text-budget keptRefs.
  const collected = collectDecisionControls(nodes);
  recordAxSnapshot(tabId, collected.controls.map(c => Number(c.ref.slice(1))).filter(n => Number.isSafeInteger(n)));

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

/** Serialized read-only observation; never trust page-written text as a completion flag. */
export function readTranslationDisplay():TranslationDisplayState|null {
  type Block={element:HTMLElement;output?:HTMLElement;segments:Array<{node:Text;original:string;translation?:string}>};

  const state=(globalThis as typeof globalThis & {__bysTranslation?:{token:string;url:string;mode:'bilingual'|'translated';fontFamily:'original'|'songti';blocks:Map<HTMLElement,Block>}}).__bysTranslation;
  const url=new URL(location.href);url.hash='';

  if(!state||state.url!==url.href)return null;
  const blocks=[...state.blocks.values()].filter(b=>b.segments.every(s=>s.translation!==undefined));

  const displayValid=blocks.length>0&&blocks.every(b=>{
    if(!b.element.isConnected||!b.segments.every(s=>s.node.isConnected&&s.node.data===(state.mode==='translated'?s.translation:s.original)))return false;
    const target=state.mode==='bilingual'?b.output:b.element;

    if(!target?.isConnected)return false;

    if(state.mode==='bilingual'&&target.textContent!==b.segments.map(s=>s.translation).join(''))return false;

    return state.fontFamily!=='songti'||/Songti SC|STSong|SimSun/.test(getComputedStyle(target).fontFamily);
  });

  return {document:state.token,mode:state.mode,fontFamily:state.fontFamily,translated:blocks.length,displayValid};
}
