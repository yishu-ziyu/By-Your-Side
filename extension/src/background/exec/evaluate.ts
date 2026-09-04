import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";

interface CdpEvalResult {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/** js 工具只走 CDP Runtime.evaluate，避免 MAIN world eval 被页面 CSP 拦截。 */
export async function evaluateJs(
  params: { code: string },
  sessionId: string = LEAD_SESSION_ID,
): Promise<{ value: unknown }> {
  const tab = await resolveWorkingTab(undefined, sessionId);
  if (tab.id == null) throw new Error("工作标签页无效");
  const res = await sendCommand<CdpEvalResult>(tab.id, "Runtime.evaluate", {
    expression: params.code,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常"));
  }
  return { value: res.result?.value };
}
