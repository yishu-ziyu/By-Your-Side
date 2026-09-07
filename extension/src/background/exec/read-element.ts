import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { isAxRef, snapshotRefKind } from "../axstate.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId, resolveWorkingTab } from "../state.js";

const MAX_ELEMENT_CHARS = 1_000_000;

export type ReadElementResult = {
  tabId: number;
  target: string;
  tagName: string;
  textContent: string;
  value?: string;
};

type ElementData = { tagName: string; textContent: string; value?: string };
type ReadReply = { ok: true; data: ElementData } | { ok: false; error: string };

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

async function readAxRef(tabId: number, ref: number): Promise<ElementData> {
  const resolved = await sendCommand<{ object?: { objectId?: string } }>(tabId, "DOM.resolveNode", { backendNodeId: ref });
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error(`ref @${ref} 已过期；请重新 snapshot`);
  const response = await sendCommand<{
    result?: { value?: ReadReply };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  }>(tabId, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() {
      try {
        const el = this;
        if (!el || !el.isConnected) throw new Error("ref 已过期；请重新 snapshot");
        const tagName = String(el.tagName || "").toLowerCase();
        const textContent = String(el.textContent ?? "");
        const hasValue = ["input", "textarea", "select", "option"].includes(tagName);
        return {ok:true,data:{tagName,textContent,...(hasValue?{value:String(el.value ?? "")}:{})}};
      } catch (error) { return {ok:false,error:error instanceof Error ? error.message : String(error)}; }
    }`,
    returnByValue: true,
  });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "读取 ref 失败");
  const reply = response.result?.value;
  if (!reply || typeof reply.ok !== "boolean") throw new Error("读取 ref 未返回结构化结果");
  if (!reply.ok) throw new Error(reply.error);
  return assertComplete(reply.data);
}

async function readDom(tabId: number, target: ReturnType<typeof parseTarget>): Promise<ElementData> {
  const isolatedRef = target.kind === "ref";
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: isolatedRef ? "ISOLATED" : "MAIN",
    func: (kind: "ref" | "css", ref: number | null, selector: string | null): ReadReply => {
      try {
        let element: Element | undefined;
        if (kind === "ref") {
          element = window.__sideagent?.refs?.get(ref ?? -1);
          if (!element || !element.isConnected) throw new Error(`ref @${ref} 已过期；请重新 snapshot`);
        } else {
          let matches: NodeListOf<Element>;
          try { matches = document.querySelectorAll(selector ?? ""); }
          catch { throw new Error(`无效的 CSS 选择器: ${selector}`); }
          if (matches.length === 0) throw new Error(`未找到目标元素: ${selector}`);
          if (matches.length > 1) throw new Error(`CSS 选择器匹配 ${matches.length} 个元素: ${selector}`);
          element = matches[0];
        }
        if (!element) throw new Error("未找到目标元素");
        const tagName = String(element.tagName || "").toLowerCase();
        const textContent = String(element.textContent ?? "");
        const valued = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLOptionElement;
        const hasValue = ["input", "textarea", "select", "option"].includes(tagName);
        return { ok: true, data: { tagName, textContent, ...(hasValue ? { value: String(valued.value ?? "") } : {}) } };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [target.kind, target.kind === "ref" ? target.ref : null, target.kind === "css" ? target.selector : null],
  });
  const first = results[0] as (chrome.scripting.InjectionResult<ReadReply> & { error?: unknown }) | undefined;
  if (!first) throw new Error("页面读取没有返回结果");
  if (first.error) throw new Error(`页面读取失败: ${String(first.error)}`);
  const reply = first.result;
  if (!reply || typeof reply.ok !== "boolean") throw new Error("页面读取未返回结构化结果");
  if (!reply.ok) throw new Error(reply.error);
  return assertComplete(reply.data);
}

export async function readElement(
  params: { tabId?: number; target: string },
  executionKey: string = LEAD_SESSION_ID,
): Promise<ReadElementResult> {
  const tabId = params.tabId ?? await getWorkingTabId(executionKey);
  if (tabId == null) throw new Error("当前执行成员没有工作标签页；请显式提供本会话拥有的 tabId");
  const tab = await resolveWorkingTab(tabId, executionKey);
  if (tab.id == null) throw new Error(`标签页 ${tabId} 已关闭`);
  const target = parseTarget(params.target);
  let data: ElementData;
  if (target.kind === "ref") {
    if (isAxRef(tabId, target.ref)) data = await readAxRef(tabId, target.ref);
    else if (snapshotRefKind(tabId) === "dom") data = await readDom(tabId, target);
    else throw new Error(`ref @${target.ref} 已过期或不属于当前 snapshot；请重新 snapshot 或使用唯一 CSS`);
  } else data = await readDom(tabId, target);
  return { tabId, target: target.normalized, ...data };
}
