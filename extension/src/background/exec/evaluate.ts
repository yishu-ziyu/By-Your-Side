import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";

interface CdpEvalResult {
  result?: { type?: string; value?: unknown; description?: string };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

/**
 * 先只编译不运行：编译不过（如 `return 1`）时脚本一行都没跑，报 not_executed，不能记成「结果未知」锁住后续步骤。
 * compileScript 与 evaluate 用同一套脚本语法，需先 Runtime.enable（无头 Chrome 实测）。编译通过后运行中的任何报错
 * （包括 JSON.parse 抛的 SyntaxError）都可能已有副作用，仍由调用方按未知处理。
 */
async function assertCompiles(tabId: number, code: string): Promise<void> {
  let compiled: CdpEvalResult;

  try {
    await sendCommand(tabId, "Runtime.enable");
    compiled = await sendCommand<CdpEvalResult>(tabId, "Runtime.compileScript", { expression: code, sourceURL: "", persistScript: false });
  } catch (error) {
    // 编译阶段的通道错误：还没发出运行命令，同样未执行。
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { executionFact: "not_executed" as const });
  }

  if (compiled.exceptionDetails) {
    const reason = compiled.exceptionDetails.exception?.description ?? compiled.exceptionDetails.text ?? "JS 编译失败";
    throw Object.assign(new Error(`${oneLine(reason)}（脚本未运行，页面没有变化）`), { executionFact: "not_executed" as const });
  }
}

/**
 * 脚本里直接 element.click() / dispatchEvent / requestSubmit 不经过 click 工具，也就不经过发送前确认（#290）。
 * 脚本运行期间在页面捕获阶段拦下名字以「发送 / Send」开头的按钮的点击和提交：不派发、不提交，结束后告诉助手改用 click 工具。
 * 序列化进页面，必须自包含；判名规则同 isSendLabel。
 */
function armSendBlock(): void {
  const w = window as unknown as Record<string, unknown>;
  const key = "__sideagentSendBlock";
  const isSend = (t: string) => { const s = t.trim().replace(/\s+/g, " "); return s.startsWith("发送") || /^send(\s|$)/i.test(s); };
  const nameOf = (el: Element | null | undefined) => {
    const b = el?.closest?.("button,[role=button],input[type=submit],input[type=button],a");
    if (!b) return "";
    return b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "";
  };
  const state = { blocked: [] as string[], onClick: (e: Event) => {}, onSubmit: (e: Event) => {} };
  const stop = (e: Event, name: string) => { e.preventDefault(); e.stopImmediatePropagation(); state.blocked.push(name.trim().slice(0, 40)); };
  state.onClick = e => { const name = nameOf(e.target as Element); if (isSend(name)) stop(e, name); };
  state.onSubmit = e => { const name = nameOf((e as SubmitEvent).submitter); if (isSend(name)) stop(e, name); };
  (w[key] as typeof state | undefined) && disarm(w[key] as typeof state);
  function disarm(s: typeof state) { window.removeEventListener("click", s.onClick, true); window.removeEventListener("submit", s.onSubmit, true); }
  window.addEventListener("click", state.onClick, true);
  window.addEventListener("submit", state.onSubmit, true);
  Object.defineProperty(w, key, { value: state, configurable: true, enumerable: false });
}

const DISARM_SEND_BLOCK = `(() => { const s = window.__sideagentSendBlock; if (!s) return []; window.removeEventListener("click", s.onClick, true); window.removeEventListener("submit", s.onSubmit, true); delete window.__sideagentSendBlock; return s.blocked; })()`;

/** js 工具只走 CDP Runtime.evaluate，避免 MAIN world eval 被页面 CSP 拦截。 */
export async function evaluateJs(
  params: { code: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeExecute?: (() => Promise<void>) & {checkNow?: () => void},
): Promise<{ value: unknown }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertCompiles(tab.id, params.code);

  await beforeExecute?.();

  await sendCommand(tab.id, "Runtime.evaluate", { expression: `(${armSendBlock.toString()})()`, returnByValue: true });

  let res: CdpEvalResult;
  let blocked: string[] = [];

  try {
    res = await sendCommand<CdpEvalResult>(tab.id, "Runtime.evaluate", {
      expression: params.code,
      awaitPromise: true,
      returnByValue: true,
    },beforeExecute);
  } finally {
    const read = await sendCommand<CdpEvalResult>(tab.id, "Runtime.evaluate", { expression: DISARM_SEND_BLOCK, returnByValue: true }).catch(() => undefined);
    blocked = Array.isArray(read?.result?.value) ? read.result.value as string[] : [];
  }

  if (blocked.length) {
    throw new Error(`脚本里点「${blocked[0]}」被拦下，没有点：发送前要等用户确认，脚本不能点发送类按钮。脚本其余部分可能已经运行。请改用单独的 click 工具点这个按钮。`);
  }

  if (res.exceptionDetails) {
    throw new Error(oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常"));
  }

  if (res.result?.type === 'function') {
    throw new Error('返回的是尚未调用的函数，函数体没有执行。请使用立即调用表达式，例如 (() => { return document.title; })()，不要只传 () => { ... }。');
  }

  return { value: res.result?.value };
}
