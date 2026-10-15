import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { confirmSend, readRecipientInPage, type SendGuard } from "../send-confirm.js";

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
 * #290：发不发看后果，不看路径。脚本运行期间，在页面里拦下会把东西发出去的动作，结束后走和点「发送」同一个确认：
 * 点名字以「发送 / Send」开头的按钮（element.click、dispatchEvent）、提交带这种按钮的表单（requestSubmit、form.submit）、
 * 合成的回车（输入框里有字，或表单里有发送按钮）、脚本发起的、路径像发送接口的非 GET 网络请求（fetch、XHR、sendBeacon）。
 * 拦下的动作先不做；用户点「发送」后原样重做第一个，其余丢弃。序列化进页面，必须自包含。
 */
function armSendBlock(marker: string): void {
  type Rect = { left: number; top: number; width: number; height: number };
  type Blocked = { route: "script" | "enter" | "request"; label: string; content: string; rect: Rect | null };
  const w = window as unknown as Record<string, any>;
  if (w.__sideagentSendBlock) w.__sideagentSendBlock.disarm();
  const isSend = (t: string) => { const s = (t ?? "").trim().replace(/\s+/g, " "); return s.startsWith("发送") || /^send(\s|$)/i.test(s); };
  const btnName = (b: Element) => b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "";
  const actionable = (el: Element | null | undefined) => el?.closest?.("button,[role=button],input[type=submit],input[type=button],a") ?? null;
  const sendIn = (scope: Element | null | undefined) => scope ? [...scope.querySelectorAll("button,[role=button],input[type=submit]")].find(b => isSend(btnName(b))) ?? null : null;
  const fromScript = () => (new Error().stack ?? "").includes(marker);
  const rectOf = (el: Element | null | undefined): Rect | null => { const r = el?.getBoundingClientRect(); return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const draftNear = (el: Element | null | undefined) => {
    const scope = el?.closest("form,[role=dialog],[role=form]") ?? el?.parentElement?.parentElement ?? null;
    const f = (el && (el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) ? el : scope?.querySelector("textarea,[contenteditable=true],input[type=text]:not([name*=to i])")) as HTMLTextAreaElement | HTMLElement | null;
    const v = ((f as HTMLTextAreaElement)?.value ?? (f as HTMLElement)?.innerText ?? "").replace(/\s+/g, " ").trim();
    return v.length > 120 ? v.slice(0, 120) + "…" : v;
  };
  const blocked: Blocked[] = [];
  const held: Array<() => unknown> = [];
  const record = (b: Blocked, redo: () => unknown) => { blocked.push(b); held.push(redo); };
  const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };
  const onClick = (e: MouseEvent) => { if (e.isTrusted) return; const b = actionable(e.target as Element); if (b && isSend(btnName(b))) { stop(e); record({ route: "script", label: btnName(b).trim().slice(0, 40), content: draftNear(b), rect: rectOf(b) }, () => (b as HTMLElement).click()); } };
  const onSubmit = (e: SubmitEvent) => { if (e.isTrusted && !fromScript()) return; const form = e.target as HTMLFormElement; const sub = e.submitter && isSend(btnName(e.submitter)) ? e.submitter : !e.submitter ? sendIn(form) : null; if (sub) { stop(e); record({ route: "script", label: btnName(sub).trim().slice(0, 40), content: draftNear(sub), rect: rectOf(sub) }, () => form.requestSubmit(e.submitter as HTMLElement ?? undefined)); } };
  const onKey = (e: KeyboardEvent) => {
    if (e.isTrusted || e.key !== "Enter" || e.shiftKey) return;
    const t = e.target as HTMLElement; const multi = t?.tagName === "TEXTAREA" || t?.isContentEditable; const sb = sendIn(t?.closest?.("form"));
    if (!((multi && draftNear(t)) || sb)) return;
    stop(e);
    if (e.type !== "keydown") return;
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey } as KeyboardEventInit;
    record({ route: "enter", label: sb ? btnName(sb).trim().slice(0, 40) : "回车发送", content: draftNear(t), rect: rectOf(sb ?? t) }, () => { for (const type of ["keydown", "keypress", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, init)); });
  };
  const origSubmit = HTMLFormElement.prototype.submit;
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origBeacon = navigator.sendBeacon;
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  // 只拦像发送接口的请求（路径里有 send、message、comment、reply、post 等词）：保存、搜索、读数据的请求照常发。这是按名字猜，名字不像的发送接口拦不到。
  const sendy = (url: string) => { try { return /(send|message|msg|chat|comment|reply|post|tweet|mail|publish|share|submit|发送)/i.test(new URL(url, location.href).pathname); } catch { return false; } };
  const where = (url: string) => { try { const u = new URL(url, location.href); return u.host === location.host ? u.pathname : u.host + u.pathname; } catch { return String(url).slice(0, 60); } };
  HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { const sb = sendIn(this); if (sb && fromScript()) { record({ route: "script", label: btnName(sb).trim().slice(0, 40), content: draftNear(sb), rect: rectOf(sb) }, () => origSubmit.call(this)); return; } return origSubmit.call(this); };
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    if (method !== "GET" && method !== "HEAD" && sendy(url) && fromScript()) {
      record({ route: "request", label: `${method} ${where(url)}`.slice(0, 60), content: typeof init?.body === "string" ? init.body.replace(/\s+/g, " ").slice(0, 120) : draftNear(document.activeElement), rect: null }, () => origFetch.call(window, input, init));
      return Promise.reject(new TypeError("这个请求要等用户确认后才会发出（By Your Side 发送确认）"));
    }
    return origFetch.call(window, input, init);
  } as typeof fetch;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) { meta.set(this, { method: String(method).toUpperCase(), url: String(url) }); return (origOpen as any).call(this, method, url, ...rest); } as typeof origOpen;
  XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    if (m && m.method !== "GET" && m.method !== "HEAD" && sendy(m.url) && fromScript()) { const xhr = this; record({ route: "request", label: `${m.method} ${where(m.url)}`.slice(0, 60), content: typeof body === "string" ? body.replace(/\s+/g, " ").slice(0, 120) : draftNear(document.activeElement), rect: null }, () => origSend.call(xhr, body)); return; }
    return origSend.call(this, body);
  };
  navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null) { if (sendy(String(url)) && fromScript()) { record({ route: "request", label: `POST ${where(String(url))}`.slice(0, 60), content: typeof data === "string" ? data.slice(0, 120) : "", rect: null }, () => origBeacon.call(navigator, url, data)); return false; } return origBeacon.call(navigator, url, data); };
  window.addEventListener("click", onClick, true);
  window.addEventListener("submit", onSubmit, true);
  for (const t of ["keydown", "keypress", "keyup"]) window.addEventListener(t, onKey as EventListener, true);
  const disarm = () => {
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("submit", onSubmit, true);
    for (const t of ["keydown", "keypress", "keyup"]) window.removeEventListener(t, onKey as EventListener, true);
    HTMLFormElement.prototype.submit = origSubmit; window.fetch = origFetch; XMLHttpRequest.prototype.open = origOpen; XMLHttpRequest.prototype.send = origSend; navigator.sendBeacon = origBeacon;
    delete w.__sideagentSendBlock;
    Object.defineProperty(w, "__sideagentSendHeld", { value: held.slice(0, 1), configurable: true, enumerable: false });
    return blocked;
  };
  Object.defineProperty(w, "__sideagentSendBlock", { value: { disarm }, configurable: true, enumerable: false });
}

type BlockedSend = { route: "script" | "enter" | "request"; label: string; content: string; rect: { left: number; top: number; width: number; height: number } | null };

const DISARM = `(() => window.__sideagentSendBlock ? window.__sideagentSendBlock.disarm() : [])()`;
const REDO = `(() => { const h = window.__sideagentSendHeld; delete window.__sideagentSendHeld; if (!h?.[0]) return false; h[0](); return true; })()`;
const DROP = `(() => { delete window.__sideagentSendHeld; return true; })()`;

/** js 工具只走 CDP Runtime.evaluate，避免 MAIN world eval 被页面 CSP 拦截。 */
export async function evaluateJs(
  params: { code: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeExecute?: (() => Promise<void>) & {checkNow?: () => void},
  sendGuard?: SendGuard,
): Promise<{ value: unknown; sendConfirmed?: true; sendNote?: string }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertCompiles(tab.id, params.code);

  await beforeExecute?.();

  const tabId = tab.id;
  const marker = `sideagent-script-${crypto.randomUUID()}`;
  await sendCommand(tabId, "Runtime.evaluate", { expression: `(${armSendBlock.toString()})(${JSON.stringify(marker)})`, returnByValue: true });
  let res: CdpEvalResult;
  let blocked: BlockedSend[] = [];

  try {
    res = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", {
      expression: `${params.code}\n//# sourceURL=${marker}`,
      awaitPromise: true,
      returnByValue: true,
    },beforeExecute);
  } finally {
    const read = await sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression: DISARM, returnByValue: true }).catch(() => undefined);
    blocked = Array.isArray(read?.result?.value) ? read.result.value as BlockedSend[] : [];
  }

  let sendNote: string | undefined;

  if (blocked.length) {
    const first = blocked[0]!;
    const extra = blocked.length > 1 ? `另有 ${blocked.length - 1} 个发送动作被丢弃。` : "";

    if (!sendGuard) {
      await sendCommand(tabId, "Runtime.evaluate", { expression: DROP }).catch(() => {});
      throw new Error(`脚本里的发送动作（${first.label}）被拦下，没有发出：发送要先经用户确认。脚本其余部分可能已经运行。${extra}`);
    }
    const cx = first.rect ? first.rect.left + first.rect.width / 2 : null;
    const cy = first.rect ? first.rect.top + first.rect.height / 2 : null;

    try {
      await confirmSend(tabId, first.label, sendGuard, async () => {
        const r = await sendCommand<{ result?: { value?: string | null } }>(tabId, "Runtime.evaluate", { expression: `(${readRecipientInPage.toString()})(${cx}, ${cy})`, returnByValue: true }).catch(() => undefined);
        const recipient = r?.result?.value ?? undefined;
        return { ...(first.content ? { content: first.content } : {}), ...(recipient ? { recipient } : {}), ...(first.rect ? { rect: first.rect } : {}), route: first.route };
      });
    } catch (error) {
      await sendCommand(tabId, "Runtime.evaluate", { expression: DROP }).catch(() => {});
      throw Object.assign(error as Error, { message: `脚本里的发送动作（${first.label}）先拦下，问了用户：${(error as Error).message}脚本其余部分可能已经运行。${extra}` });
    }
    const redo = await sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression: REDO, returnByValue: true });

    if (redo.result?.value !== true) throw new Error(`用户确认了发送，但没能重做脚本里的发送动作（${first.label}），不知道发出去没有，请看网页。`);
    sendNote = `脚本里的发送动作（${first.label}）先拦下，用户确认后才发出。${extra}`;
  }

  if (res.exceptionDetails) {
    throw new Error(oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常"));
  }

  if (res.result?.type === 'function') {
    throw new Error('返回的是尚未调用的函数，函数体没有执行。请使用立即调用表达式，例如 (() => { return document.title; })()，不要只传 () => { ... }。');
  }

  return { value: res.result?.value, ...(sendNote ? { sendConfirmed: true as const, sendNote } : {}) };
}
