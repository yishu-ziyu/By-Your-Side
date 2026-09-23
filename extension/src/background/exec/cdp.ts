/**
 * `cdp` 工具：通用 CDP escape hatch（power tool）。
 * 边界：
 *  - 只绑当前工作标签页：不认领新页、不接受其他 tabId、不碰别人的 target/session；
 *  - method 走共享策略（默认拒绝；仅明确只读观察子集可执行），格式强校验；
 *  - DOM.setFileInputFiles 等在 sendCommand 之前拒绝并指向 upload_file；
 *  - 控制闸门由 effect-policy（requiresControlGate 恒 true）与 WRITE_TOOLS 承担，
 *    本层不做 read/write 分类系统；abort/epoch 由 executeToolCall 的身份检查承担；
 *  - 结果有界截断，错误走 oneLine；超时按「可能已送达」语义如实上报（不标 not_executed）。
 */
import {
  CDP_DENY_PREFIXES,
  CDP_SAFE_READONLY_METHODS,
  decideCdpCommandParams,
  decideCdpMethod,
} from "../../../../shared/cdp-method-policy.js";
import { LEAD_SESSION_ID, type ToolContract } from "../../../../shared/protocol.js";
import { assertObservedDocument } from "../observation-document.js";
import { sendCommand } from "../debugger.js";
import { getWorkingTabId } from "../state.js";
import { oneLine } from "../util.js";
import { notExecuted } from "./input.js";

export { CDP_DENY_PREFIXES, CDP_SAFE_READONLY_METHODS };

const MAX_RESULT_CHARS = 200_000;

/** 纯函数，可单测：非法格式与越权方法在触碰浏览器之前就拒绝（not_executed）。 */
export function assertCdpMethodAllowed(method: unknown): asserts method is string {
  const decision = decideCdpMethod(method);

  if (!decision.allowed) {
    throw notExecuted(new Error(decision.message));
  }
}

function assertCdpParamsAllowed(params: Record<string, unknown> | undefined): void {
  const decision = decideCdpCommandParams(params);

  if (!decision.allowed) {
    throw notExecuted(new Error(decision.message));
  }
}

export async function cdp(
  params: ToolContract["cdp"]["params"],
  sessionId: string = LEAD_SESSION_ID,
): Promise<ToolContract["cdp"]["data"]> {
  const workingId = await getWorkingTabId(sessionId);

  if (workingId == null) {
    throw notExecuted(new Error("当前没有工作标签页；cdp 只能操作已认领的工作标签页"));
  }

  if (params.tabId !== undefined && params.tabId !== workingId) {
    throw notExecuted(new Error(`cdp 只能操作当前工作标签页（${workingId}），拒绝指定其他 tabId`));
  }

  assertCdpMethodAllowed(params.method);
  assertCdpParamsAllowed(params.params);
  const tab = await chrome.tabs.get(workingId).catch(() => null);

  if (!tab) throw notExecuted(new Error("工作标签页已关闭，cdp 未执行"));
  await assertObservedDocument(workingId, sessionId);

  const timeoutMs = params.timeoutMs ?? 10_000;

  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw notExecuted(new Error("cdp.timeoutMs 必须在 1–30000 之间，未执行"));
  }

  const command = sendCommand(workingId, params.method, params.params ?? {});
  // 竞速失败方晚到的拒绝不算未处理 rejection；底层命令可能仍在完成，结果不回填。
  command.catch(() => { /* 已由竞速超时路径上报 */ });
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const result = await Promise.race([
      command,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`CDP ${params.method} 超过 ${timeoutMs}ms 未返回；命令可能仍在执行，请 snapshot 核验页面状态`)), timeoutMs);
      }),
    ]);

    const json = JSON.stringify(result ?? null);

    if (json.length <= MAX_RESULT_CHARS) return { result, truncated: false };

    return { result: `${json.slice(0, MAX_RESULT_CHARS)}… [truncated]`, truncated: true };
  } catch (error) {
    // 已触碰浏览器的失败不能标 not_executed：如实报一行错误，由账本按 unknown 处理。
    if (error && typeof error === "object" && "executionFact" in error) throw error;
    throw new Error(oneLine(error));
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
