import {withObservedDocumentIdentity, recordObservedDocument, assertSameDocument} from "../observation-document.js";
import {elementMatches, validateElementRead, type ElementProperty, type ElementValue} from "../../../../shared/element-state.js";
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { isAxRef, snapshotRefKind } from "../axstate.js";
import { parseTarget as sharedParseTarget, resolveArgs, resolveTargetSelector } from "../../shared/target.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, resolveReadableTab } from "../state.js";

const MAX_ELEMENT_CHARS = 1_000_000;

export type ReadElementResult = ToolContract["read_element"]["data"];

type ElementData = Omit<ReadElementResult, 'tabId' | 'target' | 'check' | 'documentId'>;

type ReadReply = { ok: true; data: ElementData } | { ok: false; error: string };

/** FIX-02：把定位/读取失败收成稳定错误码，等待 helper 禁止用中文文案分支。 */
export function typedReadElementError(error: unknown): Error {
  const text = error instanceof Error ? error.message : String(error);

  if (/^(NOT_FOUND|NOT_READY|AMBIGUOUS|PERMISSION_DENIED|IDENTITY_CHANGED|INVALID_ARGUMENT|TRANSPORT_ERROR|CANCELLED|CAPTURE_INCOMPLETE):/.test(text)) {
    return error instanceof Error ? error : new Error(text);
  }

  if (/匹配 \d+ 个/.test(text)) return new Error(`AMBIGUOUS: ${text}`);

  if (/未找到/.test(text)) return new Error(`NOT_FOUND: ${text}`);

  if (/条件未满足/.test(text)) return new Error(`NOT_READY: ${text}`);

  if (/无效的|不能为空|不支持的|READBACK_INVALID/.test(text)) return new Error(`INVALID_ARGUMENT: ${text}`);

  if (/已失效|已过期|不属于当前|DOCUMENT_CHANGED|STALE_DOCUMENT|READBACK_DOCUMENT|目标已失效/.test(text)) return new Error(`IDENTITY_CHANGED: ${text}`);

  if (/权限|DevTools|占用|PERMISSION|没有工作标签页/.test(text)) return new Error(`PERMISSION_DENIED: ${text}`);

  if (/disconnected|Extension|ECONN|transport/i.test(text)) return new Error(`TRANSPORT_ERROR: ${text}`);

  return error instanceof Error ? error : new Error(text);
}

/** Serialized unchanged into either CDP or executeScript; no closure or page-supplied code. */
function readInPage(kind: "ref" | "css", ref: number | null, selector: string | null, properties: ElementProperty[], supplied?: Element | null, readback?: {deadline:number} | null): ReadReply {
  try {
    if(readback&&Date.now()>=readback.deadline)throw new Error('READBACK_TIMEOUT');

    // An adjunct read must receive the original CDP object, never re-query a locator.
    if(readback && !supplied?.isConnected)throw new Error('READBACK_NODE_DETACHED');
    let element = supplied;

    if (!element && kind === 'ref') {
      element = window.__sideagent?.refs?.get(ref ?? -1);

      if (!element || !element.isConnected) throw new Error(`ref @${ref} 已过期；请重新 snapshot`);
    } else if (!element) {
      let matches: NodeListOf<Element>;

      try { matches = document.querySelectorAll(selector ?? ''); }
      catch { throw new Error(`无效的 CSS 选择器: ${selector}`); }

      if (!matches.length) throw new Error(`未找到目标元素: ${selector}`);

      if (matches.length > 1) throw new Error(`CSS 选择器匹配 ${matches.length} 个元素: ${selector}`);
      element = matches[0];
    }

    if (!element?.isConnected) throw new Error('目标已失效；请重新 snapshot');
    // SAFETY: 元素来自 snapshot-ref/CSS 解析（Element）；运行时按 tagName 分支收窄，
    // 联合断言仅为读取 value/textContent 等成员，所有成员访问都有 hasValue/tagName 判定守卫。
    const el = element as unknown as HTMLElement & HTMLInputElement & HTMLMediaElement & HTMLOptionElement;
    const tagName = element.nodeType === 3 ? '#text' : String(element.tagName || '').toLowerCase();
    const hasValue = ['input', 'textarea', 'select', 'option'].includes(tagName);

    // 密码/验证码字段的**值**不进模型上下文，也只报位数：这类字段读回来没有正当用途。
    const secretField = tagName === 'input' && (el.type === 'password'
      || /one-time-code|cc-(number|csc|exp)/i.test(String(el.getAttribute?.('autocomplete') ?? '')));

    if(readback) {
      if(secretField)throw new Error('READBACK_PROTECTED');

      if(!hasValue)throw new Error('READBACK_UNSUPPORTED_FIELD');
      const value=String(el.value??'');

      return {ok:true,data:{tagName,textContent:'',value,properties:{value}}};
    }

    const textContent = String(element.textContent ?? '');

    // Rich editors store Enter as block elements and Shift+Enter as <br>.
    // textContent loses both; serialize their text value without layout margins.
    const editableText = el.isContentEditable ? (() => {
      const blocks = new Set(['P','DIV','LI','H1','H2','H3','H4','H5','H6','PRE','BLOCKQUOTE']);

      const read = (node: Node): string => {
        if (node.nodeType === 3) return node.textContent ?? '';

        if (node.nodeType !== 1) return '';
        const element = node as HTMLElement;

        if (element.tagName === 'BR') return element.classList.contains('ProseMirror-trailingBreak') ? '' : '\n';
        const children = Array.from(element.childNodes);

        if (children.length === 1 && children[0]!.nodeName === 'BR' && (blocks.has(element.tagName)||element===el)) return '';
        let text = '', previousBlock = false;
        children.forEach((child, index) => {
          const block = blocks.has(child.nodeName);

          if (index > 0 && (block || previousBlock)) text += '\n';
          text += read(child);
          previousBlock = block;
        });

        return text;
      };

      return read(element);
    })() : undefined;

    const maskValue = (raw: string): string => (secretField ? (raw ? `<${raw.length} chars>` : '') : raw);
    const values: Partial<Record<ElementProperty, ElementValue>> = {};

    for (const property of properties) {
      let value: ElementValue | undefined;

      if (property === 'textContent') value = textContent;
      else if (property === 'value' && hasValue) value = maskValue(String(el.value ?? ''));
      else if (property === 'displayValue' && hasValue) {
        // 显示值：select 取当前选中项的可见文字，option 取自身文字，其余取字段值。
        // SAFETY: 上一分支已断言 tagName==='select'，运行时即 HTMLSelectElement。
        const select = tagName === 'select' ? el as unknown as HTMLSelectElement : null;
        // SAFETY: 上一分支已断言 tagName==='option'，运行时即 HTMLOptionElement。
        const option = tagName === 'option' ? el as unknown as HTMLOptionElement : null;
        const shown = option ? option.textContent : select ? (select.selectedOptions?.[0]?.textContent ?? select.options?.[select.selectedIndex]?.textContent ?? select.value) : el.value;
        value = maskValue(String(shown ?? ''));
      }
      else if (property === 'visible' && element.nodeType !== 3) {
        const style = getComputedStyle(element);
        value = element.getClientRects().length > 0 && style.visibility !== 'hidden' && style.visibility !== 'collapse' && style.display !== 'none';
      } else if (property === 'enabled' && element.nodeType !== 3) value = !el.matches(':disabled') && el.getAttribute('aria-disabled') !== 'true';
      else if (property === 'checked' && tagName === 'input' && ['checkbox', 'radio'].includes(el.type)) value = el.checked;
      else if (property === 'selected' && tagName === 'option') value = el.selected;
      else if (['checked', 'selected', 'expanded', 'pressed'].includes(property) && element.nodeType !== 3) {
        const aria = el.getAttribute?.('aria-' + property);

        if (aria === 'true' || aria === 'false') value = aria === 'true';
        else if (aria === 'mixed') value = aria;
      } else if (['paused', 'ended', 'currentTime', 'duration'].includes(property) && ['audio', 'video'].includes(tagName)) value = el[property as 'paused' | 'ended' | 'currentTime' | 'duration'];

      if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error(`当前${tagName}目标不支持或尚无有效的 ${property} 属性；请观察实际目标状态。`);
      values[property] = value;
    }

    // Extract only naming sources here. The shared anchorFor() owns naming priority and
    // clipping; this function is serialized into Chrome and cannot close over imports.
    let anchorSource: ElementData['anchorSource'];

    if (element.nodeType !== 3 && typeof el.getAttribute === 'function') {
      const clip = (value: string | null | undefined) => value == null ? null : value.slice(0, 180);
      const by = el.getAttribute('aria-labelledby');
      const label = el.labels?.[0]?.textContent || (by ? by.split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ') : null);
      const image = el.querySelector?.('img[alt], svg[aria-label]');
      let ancestor: string | null = null;

      if (!textContent.trim()) {
        let parent = el.parentElement;

        for (let depth = 0; parent && depth < 4; depth++, parent = parent.parentElement) {
          if (parent.textContent?.trim()) { ancestor = parent.textContent; break; }
        }
      }

      anchorSource = { tag: tagName, role: el.getAttribute('role'), type: el.getAttribute('type'), name: clip(el.getAttribute('name')),
        ariaLabel: clip(el.getAttribute('aria-label')), label: clip(label), placeholder: clip(el.getAttribute('placeholder')),
        title: clip(el.getAttribute('title')), alt: clip(image?.getAttribute('alt') ?? image?.getAttribute('aria-label')),
        text: hasValue ? null : clip(textContent), ancestorText: clip(ancestor), autocomplete: el.getAttribute('autocomplete') };
    }

    const scopeLabels:string[]=[];
    let scope=element.parentElement;

    for(let depth=0;scope&&depth<8&&scopeLabels.length<4;depth++,scope=scope.parentElement){
      const role=scope.getAttribute?.('role')||scope.tagName?.toLowerCase();

      if(!['form','dialog','region','group','row','article','section','fieldset'].includes(role))continue;
      const labelledBy=scope.getAttribute?.('aria-labelledby');

      const name=scope.getAttribute?.('aria-label')
        ||(labelledBy?labelledBy.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' '):'')
        ||scope.querySelector?.(':scope > legend, :scope > h1, :scope > h2, :scope > h3')?.textContent;

      if(name?.trim())scopeLabels.push(`${role}: ${name.trim().slice(0,180)}`);
    }

    return {ok:true,data:{tagName,textContent,...(editableText!==undefined?{editableText}:{}),...(scopeLabels.length?{scopeLabels}:{}),...(hasValue ? {value:maskValue(String(el.value ?? ''))} : {}),...(properties.length ? {properties:values} : {}),...(anchorSource ? {anchorSource} : {})}};
  } catch (error) { return {ok:false,error:error instanceof Error ? error.message : String(error)}; }
}

function parseTarget(target: string): {
  kind: "ref" | "css" | "xpath" | "text" | "role" | "href";
  ref?: number;
  selector?: string;
  normalized: string;
} {
  const parsed = sharedParseTarget(target);

  if (!parsed) throw new Error(`无效的 target: ${target}；支持 @ref / loc=css: / loc=role: / loc=href: / xpath= / text= / 原生 CSS`);

  if (parsed.kind === "css" && target.trim().startsWith("loc=")) throw new Error("INVALID_ARGUMENT: read_element 只支持当前 @ref、loc=css:、loc=role:、loc=href:、xpath=、text= 或原生 CSS；未知 loc= 格式未执行。");

  if (parsed.kind === "ref") return { kind: "ref", ref: parsed.n, normalized: target };
  const args = resolveArgs(parsed);

  return { kind: args.kind as "css" | "xpath" | "text" | "role" | "href", selector: args.selector, normalized: args.kind === "css" ? `loc=css:${args.selector}` : target };
}

/** xpath/text 统一 resolver 在页面里解析出元素对象，再走与 ref 相同的 callFunctionOn 读取。 */
async function readResolvedNode(
  tabId: number,
  target: { kind: "xpath" | "text" | "role" | "href" | "css"; selector: string },
  properties: ElementProperty[],
  check: () => void,
): Promise<ElementData> {
  check();
  const expression = `(${resolveTargetSelector.toString()})(${JSON.stringify(target.kind)}, ${JSON.stringify(target.selector)})`;

  const evaluated = await sendCommand<{ result?: { objectId?: string }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(
    tabId,
    "Runtime.evaluate",
    { expression, returnByValue: false },
  );

  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description ?? evaluated.exceptionDetails.text ?? "目标解析失败");
  const objectId = evaluated.result?.objectId;

  if (!objectId) throw new Error("目标不是元素");

  try {
    check();

    const response = await sendCommand<{
      result?: { value?: ReadReply };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { return (${readInPage.toString()})("css", null, null, ${JSON.stringify(properties)}, this, null); }`,
      returnByValue: true,
    });

    check();

    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "读取目标失败");
    const reply = response.result?.value;

    if (!reply || typeof reply.ok !== "boolean") throw new Error("读取目标未返回结构化结果");

    if (!reply.ok) throw new Error(reply.error);

    return assertComplete(reply.data);
  } finally {
    await sendCommand(tabId, "Runtime.releaseObject", { objectId }).catch(() => { /* 已释放 */ });
  }
}

function assertComplete(data: ElementData): ElementData {
  if (!data || typeof data.tagName !== "string" || typeof data.textContent !== "string") throw new Error("页面未返回完整元素数据");

  if (data.textContent.length > MAX_ELEMENT_CHARS) throw new Error(`元素文本超过安全上限 ${MAX_ELEMENT_CHARS} 字符，未返回部分内容`);

  if (data.editableText !== undefined && (typeof data.editableText !== 'string' || data.editableText.length > MAX_ELEMENT_CHARS)) throw new Error('富文本字段未返回完整且有界的文本');

  if (data.value !== undefined && typeof data.value !== "string") throw new Error("页面字段没有返回完整字符串 value");

  if (data.value !== undefined && data.value.length > MAX_ELEMENT_CHARS) throw new Error(`字段值超过安全上限 ${MAX_ELEMENT_CHARS} 字符，未返回部分内容`);

  return data;
}

async function readAxRef(tabId: number, ref: number, properties: ElementProperty[], readback?: {documentId:string;deadline:number}, check=()=>{}): Promise<ElementData> {
  check();
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: ref });
  const objectId = resolved.object?.objectId;

  if (!objectId) throw new Error(readback?'READBACK_NODE_UNRESOLVED':`ref @${ref} 已过期；请重新 snapshot`);

  try {
    check();

    if(readback) { await assertSameDocument(tabId,readback.documentId); check(); }

    const response = await sendCommand<{
      result?: { value?: ReadReply };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>(tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function() { return (${readInPage.toString()})("ref", ${ref}, null, ${JSON.stringify(properties)}, this, ${JSON.stringify(readback??null)}); }`,
      returnByValue: true,
    });

    check();

    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "读取 ref 失败");
    const reply = response.result?.value;

    if (!reply || typeof reply.ok !== "boolean") throw new Error("读取 ref 未返回结构化结果");

    if (!reply.ok) throw new Error(reply.error);

    return {...assertComplete(reply.data),nodeIdentity:{kind:'ax',backendNodeId:ref}};
  } finally { await sendCommand(tabId, 'Runtime.releaseObject', {objectId}).catch(() => {}); }
}

async function readDom(tabId: number, target: ReturnType<typeof parseTarget>, member: string, properties: ElementProperty[], readback?: {documentId:string;deadline:number}, check=()=>{}): Promise<{data:ElementData;documentId?:string}> {
  const isolatedRef = target.kind === "ref";
  check();

  const results = await chrome.scripting.executeScript({
    target: { tabId, ...(readback?{documentIds:[readback.documentId]}:{}) },
    ...(readback?{injectImmediately:true}:{}),
    world: isolatedRef ? "ISOLATED" : "MAIN",
    func: readInPage,
    args: [target.kind === "ref" ? "ref" : "css", target.kind === "ref" ? (target.ref ?? null) : null, target.kind === "css" ? (target.selector ?? null) : null, properties, null, readback??null],
  });

  check();
  const first = results[0] as (chrome.scripting.InjectionResult<ReadReply> & { error?: unknown }) | undefined;

  if (!first) throw new Error("页面读取没有返回结果");

  if (first.error) throw new Error(`页面读取失败: ${String(first.error)}`);
  const reply = first.result;

  if (!reply || typeof reply.ok !== "boolean") throw new Error("页面读取未返回结构化结果");

  if (!reply.ok) throw new Error(reply.error);
  const data = assertComplete(reply.data);

  if(readback&&first.documentId!==readback.documentId)throw new Error('READBACK_DOCUMENT_CHANGED');

  if (first.documentId) recordObservedDocument(tabId, member, first.documentId);

  return {data,...(first.documentId?{documentId:first.documentId}:{})};
}

export async function readElement(
  params: ToolContract["read_element"]["params"],
  executionKey: string = LEAD_SESSION_ID,
  checkCurrent:()=>void=()=>{},
): Promise<ReadElementResult> {
  try {
    return await readElementInner(params, executionKey, checkCurrent);
  } catch (error) {
    throw typedReadElementError(error);
  }
}

async function readElementInner(
  params: ToolContract["read_element"]["params"],
  executionKey: string = LEAD_SESSION_ID,
  checkCurrent:()=>void=()=>{},
): Promise<ReadElementResult> {
  const readback=params.readback;

  const check=()=>{
    if(!readback)return;
    checkCurrent();

    if(!readback.documentId||!Number.isFinite(readback.deadline)||params.expect)throw new Error('READBACK_INVALID_CONSTRAINT');

    if(Date.now()>=readback.deadline)throw new Error('READBACK_TIMEOUT');
  };

  check();
  const properties = validateElementRead(params);
  const tabId = params.tabId ?? await getWorkingTabId(executionKey);
  check();

  if (tabId == null) throw new Error("当前执行成员没有工作标签页；请提供需要读取的 tabId");
  const tab = await resolveReadableTab(tabId, executionKey);
  check();

  if (tab.id == null) throw new Error(`标签页 ${tabId} 已关闭`);
  const target = parseTarget(params.target);

  const checkDocument=async()=>{
    check();

    if(readback) {
      try { await assertSameDocument(tabId,readback.documentId); }
      catch { throw new Error('READBACK_DOCUMENT_CHANGED'); }

      check();
    }
  };

  await checkDocument();

  if(readback && (readback.nodeIdentity?.kind!=='ax' || target.kind!=='ref'
    || !Number.isSafeInteger(readback.nodeIdentity.backendNodeId) || readback.nodeIdentity.backendNodeId!==target.ref
    || !isAxRef(tabId,target.ref)))throw new Error('READBACK_NODE_IDENTITY_UNVERIFIABLE');

  const read = async (): Promise<{data:ElementData;documentId?:string}> => {
    check();

    if (target.kind === 'xpath' || target.kind === 'text' || target.kind === 'role' || target.kind === 'href') {
      const kind = target.kind;
      const selector = target.selector ?? "";
      const observed = await withObservedDocumentIdentity(tabId, executionKey, () => readResolvedNode(tabId, { kind, selector }, properties, check), check);

      return {data:observed.value,...(observed.documentId?{documentId: observed.documentId}:{})};
    }

    if (target.kind === 'css') {
      // CSS 也走统一 resolver（open shadow + 同源 frame），避免 readInPage 的浅 querySelectorAll。
      const observed = await withObservedDocumentIdentity(tabId, executionKey, () => readResolvedNode(tabId, { kind: "css", selector: target.selector ?? "" }, properties, check), check);

      return {data:observed.value,...(observed.documentId?{documentId: observed.documentId}:{})};
    }

    if (target.kind === 'ref') {
      const ref = target.ref!;

      if (isAxRef(tabId, ref)) {
        const observed=await withObservedDocumentIdentity(tabId,executionKey,()=>readAxRef(tabId,ref,properties,readback,check),check);
        check();

        return {data:observed.value,...(observed.documentId?{documentId:observed.documentId}:{})};
      }

      if(readback)throw new Error('READBACK_NODE_IDENTITY_UNVERIFIABLE');

      if (snapshotRefKind(tabId) !== 'dom') throw new Error(`ref @${ref} 已过期或不属于当前 snapshot；请重新 snapshot 或使用唯一 CSS`);
    }

    return readDom(tabId, target, executionKey, properties,readback,check);
  };

  if (!params.expect) {
    const observed = await read().catch(error=>{
      if(readback&&error?.code==='STALE_DOCUMENT')throw new Error('READBACK_DOCUMENT_CHANGED');
      throw error;
    });

    await checkDocument();

    return {tabId,target:target.normalized,...observed.data,...(observed.documentId?{documentId:observed.documentId}:{})};
  }

  const expected = params.expect;
  const started = Date.now();
  let finalDocumentId:string|undefined;

  const observed = await withObservedDocumentIdentity(tabId, executionKey, async () => {
    while (true) {
      const current = await read();
      const data=current.data;
      finalDocumentId=current.documentId;
      const actual = data.properties?.[expected.property];

      if (actual === undefined) throw new Error(`页面未返回 ${expected.property} 属性，未验证成功。`);

      if (elementMatches(actual, expected)) return {tabId,target:target.normalized,...data,check:{matched:true as const,property:expected.property,elapsedMs:Date.now()-started}};
      const remaining = (params.timeoutMs ?? 0) - (Date.now() - started);

      if (remaining <= 0) throw new Error(`NOT_READY: 条件未满足：${target.normalized} 的 ${expected.property} 当前为 ${JSON.stringify(actual).slice(0,200)}，期望 ${JSON.stringify(expected).slice(0,250)}；页面未被修改，未验证成功。`);
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
  });

  const documentId=observed.documentId??finalDocumentId;

  return {...observed.value,...(documentId?{documentId}:{})};
}
