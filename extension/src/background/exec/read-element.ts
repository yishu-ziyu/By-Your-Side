import {withObservedDocument, recordObservedDocument} from "../observation-document.js";
import {elementMatches, validateElementRead, type ElementProperty, type ElementValue} from "../../../../shared/element-state.js";
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { isAxRef, snapshotRefKind } from "../axstate.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, resolveReadableTab } from "../state.js";

const MAX_ELEMENT_CHARS = 1_000_000;

export type ReadElementResult = ToolContract["read_element"]["data"];
type ElementData = Omit<ReadElementResult, 'tabId' | 'target' | 'check'>;
type ReadReply = { ok: true; data: ElementData } | { ok: false; error: string };

/** Serialized unchanged into either CDP or executeScript; no closure or page-supplied code. */
function readInPage(kind: "ref" | "css", ref: number | null, selector: string | null, properties: ElementProperty[], supplied?: Element): ReadReply {
  try {
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
    const el = element as unknown as HTMLElement & HTMLInputElement & HTMLMediaElement & HTMLOptionElement;
    const tagName = element.nodeType === 3 ? '#text' : String(element.tagName || '').toLowerCase();
    const textContent = String(element.textContent ?? '');
    const hasValue = ['input', 'textarea', 'select', 'option'].includes(tagName);
    const values: Partial<Record<ElementProperty, ElementValue>> = {};
    for (const property of properties) {
      let value: ElementValue | undefined;
      if (property === 'textContent') value = textContent;
      else if (property === 'value' && hasValue) value = String(el.value ?? '');
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
    return {ok:true,data:{tagName,textContent,...(hasValue ? {value:String(el.value ?? '')} : {}),...(properties.length ? {properties:values} : {})}};
  } catch (error) { return {ok:false,error:error instanceof Error ? error.message : String(error)}; }
}

function parseTarget(target: string): { kind: "ref"; ref: number; normalized: string } | { kind: "css"; selector: string; normalized: string } {
  if (/^@[1-9]\d*$/.test(target)) return { kind: "ref", ref: Number(target.slice(1)), normalized: target };
  if (target.startsWith("@")) throw new Error(`无效或过期的 ref: ${target}；请重新 snapshot`);
  if (target.startsWith("loc=") && !target.startsWith("loc=css:")) throw new Error("read_element 只支持当前 @ref、loc=css: 或原生 CSS");
  const selector = target.startsWith("loc=css:") ? target.slice("loc=css:".length) : target;
  if (!selector) throw new Error("CSS 目标不能为空");
  return { kind: "css", selector, normalized: `loc=css:${selector}` };
}

function assertComplete(data: ElementData): ElementData {
  if (!data || typeof data.tagName !== "string" || typeof data.textContent !== "string") throw new Error("页面未返回完整元素数据");
  if (data.textContent.length > MAX_ELEMENT_CHARS) throw new Error(`元素文本超过安全上限 ${MAX_ELEMENT_CHARS} 字符，未返回部分内容`);
  if (data.value !== undefined && typeof data.value !== "string") throw new Error("页面字段没有返回完整字符串 value");
  if (data.value !== undefined && data.value.length > MAX_ELEMENT_CHARS) throw new Error(`字段值超过安全上限 ${MAX_ELEMENT_CHARS} 字符，未返回部分内容`);
  return data;
}

async function readAxRef(tabId: number, ref: number, properties: ElementProperty[]): Promise<ElementData> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: ref });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`ref @${ref} 已过期；请重新 snapshot`);
  const response = await sendCommand<{
    result?: { value?: ReadReply };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { return (${readInPage.toString()})("ref", ${ref}, null, ${JSON.stringify(properties)}, this); }`,
    returnByValue: true,
  }).finally(() => sendCommand(tabId, 'Runtime.releaseObject', {objectId}).catch(() => {}));
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "读取 ref 失败");
  const reply = response.result?.value;
  if (!reply || typeof reply.ok !== "boolean") throw new Error("读取 ref 未返回结构化结果");
  if (!reply.ok) throw new Error(reply.error);
  return assertComplete(reply.data);
}

async function readDom(tabId: number, target: ReturnType<typeof parseTarget>, member: string, properties: ElementProperty[]): Promise<ElementData> {
  const isolatedRef = target.kind === "ref";
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: isolatedRef ? "ISOLATED" : "MAIN",
    func: readInPage,
    args: [target.kind, target.kind === "ref" ? target.ref : null, target.kind === "css" ? target.selector : null, properties],
  });
  const first = results[0] as (chrome.scripting.InjectionResult<ReadReply> & { error?: unknown }) | undefined;
  if (!first) throw new Error("页面读取没有返回结果");
  if (first.error) throw new Error(`页面读取失败: ${String(first.error)}`);
  const reply = first.result;
  if (!reply || typeof reply.ok !== "boolean") throw new Error("页面读取未返回结构化结果");
  if (!reply.ok) throw new Error(reply.error);
  const data = assertComplete(reply.data);
  if (first.documentId) recordObservedDocument(tabId, member, first.documentId);
  return data;
}

export async function readElement(
  params: ToolContract["read_element"]["params"],
  executionKey: string = LEAD_SESSION_ID,
): Promise<ReadElementResult> {
  const properties = validateElementRead(params);
  const tabId = params.tabId ?? await getWorkingTabId(executionKey);
  if (tabId == null) throw new Error("当前执行成员没有工作标签页；请提供需要读取的 tabId");
  const tab = await resolveReadableTab(tabId, executionKey);
  if (tab.id == null) throw new Error(`标签页 ${tabId} 已关闭`);
  const target = parseTarget(params.target);
  const read = async (): Promise<ElementData> => {
    if (target.kind === 'ref') {
      if (isAxRef(tabId, target.ref)) return readAxRef(tabId, target.ref, properties);
      if (snapshotRefKind(tabId) !== 'dom') throw new Error(`ref @${target.ref} 已过期或不属于当前 snapshot；请重新 snapshot 或使用唯一 CSS`);
    }
    return readDom(tabId, target, executionKey, properties);
  };
  if (!params.expect) {
    const data = target.kind === 'ref' && isAxRef(tabId, target.ref) ? await withObservedDocument(tabId, executionKey, read) : await read();
    return {tabId,target:target.normalized,...data};
  }
  const expected = params.expect;
  const started = Date.now();
  return withObservedDocument(tabId, executionKey, async () => {
    while (true) {
      const data = await read();
      const actual = data.properties?.[expected.property];
      if (actual === undefined) throw new Error(`页面未返回 ${expected.property} 属性，未验证成功。`);
      if (elementMatches(actual, expected)) return {tabId,target:target.normalized,...data,check:{matched:true as const,property:expected.property,elapsedMs:Date.now()-started}};
      const remaining = (params.timeoutMs ?? 0) - (Date.now() - started);
      if (remaining <= 0) throw new Error(`条件未满足：${target.normalized} 的 ${expected.property} 当前为 ${JSON.stringify(actual).slice(0,200)}，期望 ${JSON.stringify(expected).slice(0,250)}；页面未被修改，未验证成功。`);
      await new Promise(resolve => setTimeout(resolve, Math.min(100, remaining)));
    }
  });
}
