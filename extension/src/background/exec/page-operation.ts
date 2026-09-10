import { USER_BLOCKED_ERROR } from "../../../../shared/control.js";
import type { ToolExecutionFact } from "../../../../shared/protocol.js";
import { isAxRef } from "../axstate.js";
import { sendCommand } from "../debugger.js";
import { getTabResource, resolveWorkingTab } from "../state.js";
import { parseExecutionKey } from "../tab-bindings.js";
import { pageOperationQueue } from "../page-operation-queue.js";

type Params = { tabId?: number; target: string; expectedValue: string; value: string };
export type PageOperationResult = {
  tabId: number;
  target: string;
  previousValue: string;
  value: string;
  verified: true;
  operator: string;
  changed: boolean;
  readBack: string;
};

export class PageOperationError extends Error {
  constructor(public readonly details: {
    operator: string;
    target: string;
    changed: boolean;
    readBack: string | null;
    reason: string;
  }) {
    super(`page_operation 失败：operator=${details.operator} target=${details.target} changed=${details.changed} readBack=${JSON.stringify(details.readBack)} reason=${details.reason}`);
    this.name = "PageOperationError";
  }
}

/** 执行事实只由结构化 changed 决定：未改页 = 动作前拒绝可重试，改过或不明 = 未知。 */
export function pageOperationExecutionFact(error: unknown): ToolExecutionFact {
  return error instanceof PageOperationError && !error.details.changed ? "not_executed" : "unknown";
}

type FieldState = { value: string; rect: { x: number; y: number; width: number; height: number } };
type MutationOutcome = { previousValue: string; readBack: string };
class MutationFailure extends Error {
  constructor(message: string, readonly changed: boolean, readonly readBack: string | null) { super(message); }
}

async function callOnBackendNode<T>(tabId: number, backendNodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<T> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("节点无法解析（页面可能已变化）");
  const result = await sendCommand<{ result?: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text?: string } }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "页面内执行失败");
  if (!result.result || !("value" in result.result)) throw new Error("页面内执行没有返回结构化结果");
  return result.result.value as T;
}

function parseRef(target: string): number | null {
  if (!/^@[1-9]\d*$/.test(target)) return null;
  return Number(target.slice(1));
}

async function inspectAxField(tabId: number, ref: number): Promise<FieldState> {
  return callOnBackendNode<FieldState>(tabId, ref, `function() {
    const el = this;
    if (!el.isConnected) throw new Error("目标已失效，请重新 snapshot");
    const tag = el.tagName && el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") throw new Error("page_operation 只支持 input/textarea 字段");
    if (el.disabled || el.readOnly) throw new Error("字段已禁用或只读");
    if (tag === "input" && !["text","search","email","tel","url","password","number"].includes((el.type || "text").toLowerCase())) throw new Error("page_operation 不支持该 input 类型");
    el.scrollIntoView({block:"center", inline:"center"});
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) throw new Error("元素不可见");
    return {value:String(el.value ?? ""), rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  }`);
}

async function mutateAxField(tabId: number, ref: number, expected: string, value: string): Promise<MutationOutcome> {
  const result = await callOnBackendNode<{ ok: true; data: MutationOutcome } | { ok: false; error: string; changed: boolean; readBack: string | null }>(tabId, ref, `function(expected, value) {
    const el = this;
    let changed = false;
    try {
      if (!el.isConnected) throw new Error("目标已失效，请重新 snapshot");
      const tag = el.tagName && el.tagName.toLowerCase();
      if (tag !== "input" && tag !== "textarea") throw new Error("page_operation 只支持 input/textarea 字段");
      if (el.disabled || el.readOnly) throw new Error("字段已禁用或只读");
      if (tag === "input" && !["text","search","email","tel","url","password","number"].includes((el.type || "text").toLowerCase())) throw new Error("page_operation 不支持该 input 类型");
      const previousValue = String(el.value ?? "");
      if (previousValue !== expected) throw new Error("原值冲突：expected=" + JSON.stringify(expected) + " actual=" + JSON.stringify(previousValue));
      el.scrollIntoView({block:"center", inline:"center"}); el.focus();
      const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      changed = previousValue !== value;
      el.dispatchEvent(new Event("input", {bubbles:true})); el.dispatchEvent(new Event("change", {bubbles:true}));
      if (!el.isConnected) return {ok:false,error:"输入事件后字段已被替换，无法按原 ref 读回；请重新 snapshot",changed,readBack:null};
      return {ok:true,data:{previousValue, readBack:String(el.value ?? "")}};
    } catch (error) {
      return {ok:false,error:error instanceof Error ? error.message : String(error),changed,readBack:el && "value" in el ? String(el.value ?? "") : null};
    }
  }`, [expected, value]);
  if (!result.ok) throw new MutationFailure(result.error, result.changed, result.readBack);
  return result.data;
}

async function callCssField<T>(tabId: number, target: string, mode: "inspect" | "mutate", expected = "", value = ""): Promise<T> {
  const results = await chrome.scripting.executeScript({
    target: { tabId }, world: "MAIN",
    func: (rawTarget: string, action: string, expectedValue: string, nextValue: string) => {
      let changed = false;
      try {
        const selector = rawTarget.startsWith("loc=css:") ? rawTarget.slice(8) : rawTarget;
        if (rawTarget.startsWith("loc=") && !rawTarget.startsWith("loc=css:")) throw new Error("page_operation 只支持 CSS locator 或当前 snapshot ref");
        const locate = () => {
          const matches = document.querySelectorAll(selector);
          if (matches.length !== 1) throw new Error(matches.length === 0 ? "未找到目标字段" : `目标匹配 ${matches.length} 个字段，请使用唯一定位`);
          const field = matches[0] as HTMLInputElement | HTMLTextAreaElement;
          const tag = field.tagName.toLowerCase();
          if (tag !== "input" && tag !== "textarea") throw new Error("page_operation 只支持 input/textarea 字段");
          if (field.disabled || field.readOnly) throw new Error("字段已禁用或只读");
          if (tag === "input" && !["text", "search", "email", "tel", "url", "password", "number"].includes((field.type || "text").toLowerCase())) throw new Error("page_operation 不支持该 input 类型");
          return field;
        };
        const el = locate();
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        if (!r.width && !r.height) throw new Error("元素不可见");
        const previousValue = String(el.value ?? "");
        if (action === "inspect") return { ok: true, data: { value: previousValue, rect: { x: r.x, y: r.y, width: r.width, height: r.height } } };
        if (previousValue !== expectedValue) throw new Error(`原值冲突：expected=${JSON.stringify(expectedValue)} actual=${JSON.stringify(previousValue)}`);
        el.focus();
        const tag = el.tagName.toLowerCase();
        const proto = tag === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc?.set) desc.set.call(el, nextValue); else el.value = nextValue;
        changed = previousValue !== nextValue;
        el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true }));
        const current = locate();
        return { ok: true, data: { previousValue, readBack: String(current.value ?? "") } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error), changed, readBack: null };
      }
    },
    args: [target, mode, expected, value],
  });
  const first = results[0] as (chrome.scripting.InjectionResult & { error?: unknown }) | undefined;
  if (!first) throw new Error("页面脚本未返回结果");
  if (first.error) throw new Error(`页面脚本执行失败：${String(first.error)}`);
  const result = first.result as { ok?: boolean; data?: T; error?: string; changed?: boolean; readBack?: string | null } | undefined;
  if (!result || typeof result.ok !== "boolean") throw new Error("页面脚本未返回结构化结果");
  if (!result.ok) throw new MutationFailure(result.error ?? "页面字段操作失败", result.changed === true, result.readBack ?? null);
  return result.data as T;
}

async function moveCursor(tabId: number, field: FieldState, operator: string): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content-cursor.js"], world: "ISOLATED" });
    const x = Math.round(field.rect.x + field.rect.width / 2);
    const y = Math.round(field.rect.y + field.rect.height / 2);
    const results = await chrome.scripting.executeScript({
      target: { tabId }, world: "ISOLATED",
      func: (px: number, py: number, id: string) => window.__sideagent?.cursor?.for(id)?.move(px, py) ?? 0,
      args: [x, y, operator],
    });
    const ms = Number(results[0]?.result ?? 0);
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  } catch { /* cursor is evidence/UI only; DOM contract remains authoritative */ }
}

export async function pageOperation(
  params: Params,
  key: string,
  options: { canWrite?: () => boolean } = {},
): Promise<PageOperationResult> {
  const operator = parseExecutionKey(key).sessionId;
  let changed = false;
  let readBack: string | null = null;
  try {
    const tab = await resolveWorkingTab(params.tabId, key);
    if (tab.id == null) throw new Error("工作标签页无效");
    const tabId = tab.id;
    const resource = await getTabResource(tabId);
    if (resource?.mode !== "shared" || !resource.collaborators.includes(key)) throw new Error("page_operation 只允许已登记的共享页协作者使用");

    return await pageOperationQueue.run(tabId, async () => {
      if (options.canWrite && !options.canWrite()) throw new Error(USER_BLOCKED_ERROR);
      const currentResource = await getTabResource(tabId);
      if (currentResource?.mode !== "shared" || !currentResource.collaborators.includes(key)) {
        throw new Error("当前成员已不再是该共享页的协作者");
      }
      const ref = parseRef(params.target);
      const useAx = ref !== null && isAxRef(tabId, ref);
      const inspected = useAx ? await inspectAxField(tabId, ref!) : await callCssField<FieldState>(tabId, params.target, "inspect");
      if (inspected.value !== params.expectedValue) throw new Error(`原值冲突：expected=${JSON.stringify(params.expectedValue)} actual=${JSON.stringify(inspected.value)}`);
      await moveCursor(tabId, inspected, operator);
      if (options.canWrite && !options.canWrite()) throw new Error(USER_BLOCKED_ERROR);
      const resourceBeforeWrite = await getTabResource(tabId);
      if (resourceBeforeWrite?.mode !== "shared" || !resourceBeforeWrite.collaborators.includes(key)) {
        throw new Error("当前成员已不再是该共享页的协作者");
      }
      const outcome = useAx
        ? await mutateAxField(tabId, ref!, params.expectedValue, params.value)
        : await callCssField<{ previousValue: string; readBack: string }>(tabId, params.target, "mutate", params.expectedValue, params.value);
      changed = outcome.previousValue !== outcome.readBack;
      readBack = outcome.readBack;
      if (readBack !== params.value) throw new Error(`读回不一致：expected=${JSON.stringify(params.value)} actual=${JSON.stringify(readBack)}`);
      return { tabId, target: params.target, previousValue: outcome.previousValue, value: params.value, verified: true as const, operator, changed, readBack };
    }, options.canWrite);
  } catch (error) {
    if (error instanceof PageOperationError) throw error;
    if (error instanceof MutationFailure) { changed = error.changed; readBack = error.readBack; }
    throw new PageOperationError({ operator, target: params.target, changed, readBack, reason: error instanceof Error ? error.message : String(error) });
  }
}

export { takeoverTab, handbackTab } from "../page-operation-queue.js";
