import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID, type HeldReason } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { confirmSend, readRecipientInPage, type SendGuard } from "../send-confirm.js";
import { payStopText, showPayStopOnPage } from "../pay-stop.js";
import { isPayLabel } from "../../shared/mark-actions.js";

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
 * 脚本运行期间先留住发送动作，结束后走和点击「发送」同一个确认。
 * 点名字以「发送 / Send」开头的按钮（element.click、dispatchEvent）、提交带这种按钮的表单（requestSubmit、form.submit）、
 * 合成的回车（输入框里有字，或表单里有发送按钮）、脚本发起的、路径像发送接口的非 GET 网络请求（fetch、XHR、sendBeacon）。
 * 拦下的动作先不做；用户点「发送」后原样重做第一个，其余丢弃。序列化进页面，必须自包含。
 * 付款按钮另算：脚本点它、提交带它的表单、在这种表单里合成回车，一律拦下且永不重做，付款留给用户自己点。isPay 是 isPayLabel 本身，按源码传进来。
 */
function armSendBlock(marker: string, isPay: (text: string) => boolean): void {
  type Rect = { left: number; top: number; width: number; height: number };
  type Blocked = { route: "script" | "enter" | "request" | "pay"; label: string; content: string; rect: Rect | null };
  const w = window as unknown as Record<string, any>;
  if (w.__sideagentSendBlock) w.__sideagentSendBlock.disarm();
  const isSend = (t: string) => { const s = (t ?? "").trim().replace(/\s+/g, " "); return s.startsWith("发送") || /^send(\s|$)/i.test(s); };
  const btnName = (b: Element) => b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "";
  const actionable = (el: Element | null | undefined) => el?.closest?.("button,[role=button],input[type=submit],input[type=button],a") ?? null;
  const sendIn = (scope: Element | null | undefined) => scope ? [...scope.querySelectorAll("button,[role=button],input[type=submit]")].find(b => isSend(btnName(b))) ?? null : null;
  const fromScript = () => (new Error().stack ?? "").includes(marker);
  const rectOf = (el: Element | null | undefined): Rect | null => { let r = el?.getBoundingClientRect(); if (el && r && (r.bottom < 0 || r.top > innerHeight)) { el.scrollIntoView({ block: "center" }); r = el.getBoundingClientRect(); } return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
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
  const label = (el: Element) => btnName(el).trim().replace(/\s+/g, " ");
  // 不是按钮标签的付款控件（写成 div 的「立即支付」）按它自己的短文字认；大块容器的整段文字、输入框里的字都不算按钮名。
  const editable = (el: Element) => el.matches("input,textarea,select") || (el as HTMLElement).isContentEditable;
  const payTarget = (el: Element | null | undefined) => { if (!el) return null; const b = actionable(el); if (b) return isPay(label(b)) ? b : null; if (editable(el)) return null; const own = label(el); return own.length <= 40 && isPay(own) ? el : null; };
  // 只看能提交的控件：输入框里的字（「付款失败，请帮我处理」）不是按钮名。表单外用 form 属性关联的按钮在 elements 里。
  const SUBMITS = "button,[role=button],input[type=submit],input[type=button],input[type=image]";
  const payIn = (form: HTMLFormElement | null | undefined) => form ? [...[...form.elements].filter(el => el.matches(SUBMITS)), ...form.querySelectorAll(SUBMITS)].find(b => isPay(label(b))) ?? null : null;
  // 事件到 window 时，开放 shadow DOM 里的目标被换成宿主；真正的目标在 composedPath 的第一项。
  const real = (e: Event) => { const first = e.composedPath()[0]; return (first instanceof Element ? first : (first as Node | undefined)?.parentElement ?? e.target) as Element; };
  const paid = new WeakSet<Element>();
  const PRESS = ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "touchend"];
  const holdPay = (e: Event | null, el: Element) => { if (e) stop(e); if (paid.has(el)) return; paid.add(el); blocked.push({ route: "pay", label: label(el).slice(0, 40), content: "", rect: rectOf(el) }); };
  // 有的网站在按下而不是点击时就提交：脚本合成的按下、抬起落在付款控件上也拦。
  // 付款只拦这段脚本自己触发的：页面自己的定时器合成的点击不归助手。
  const onPress = (e: Event) => { if (e.isTrusted || !fromScript()) return; const p = payTarget(real(e)); if (p) holdPay(e, p); };
  const onClick = (e: MouseEvent) => { if (e.isTrusted) return; const p = fromScript() ? payTarget(real(e)) : null; if (p) { holdPay(e, p); return; } const b = actionable(e.target as Element); if (b && isSend(btnName(b))) { stop(e); record({ route: "script", label: btnName(b).trim().slice(0, 40), content: draftNear(b), rect: rectOf(b) }, () => (b as HTMLElement).click()); } };
  const onSubmit = (e: SubmitEvent) => { if (e.isTrusted && !fromScript()) return; const form = e.target as HTMLFormElement; const pay = e.submitter ? payTarget(e.submitter) : payIn(form); if (pay) { holdPay(e, pay); return; } const sub = e.submitter && isSend(btnName(e.submitter)) ? e.submitter : !e.submitter ? sendIn(form) : null; if (sub) { stop(e); record({ route: "script", label: btnName(sub).trim().slice(0, 40), content: draftNear(sub), rect: rectOf(sub) }, () => form.requestSubmit(e.submitter as HTMLElement ?? undefined)); } };
  // 回车落在按钮上看按钮名；落在输入框里看它所在表单的提交按钮，不看框里写的字；多行框和编辑器里回车只是换行。
  const enterPays = (t: Element | null) => { if (!t) return null; const b = actionable(t); if (b) return isPay(label(b)) ? b : null; if (t.tagName === "TEXTAREA" || (t as HTMLElement).isContentEditable) return null; return payIn((t as HTMLInputElement).form ?? t.closest("form")); };
  const onKey = (e: KeyboardEvent) => {
    if (e.isTrusted || e.key !== "Enter" || e.shiftKey) return;
    const pay = fromScript() ? enterPays(real(e)) : null;
    if (pay) { holdPay(e, pay); return; }
    const t = e.target as HTMLElement;
    const multi = t?.tagName === "TEXTAREA" || t?.isContentEditable; const sb = sendIn(t?.closest?.("form"));
    if (!((multi && draftNear(t)) || sb)) return;
    stop(e);
    if (e.type !== "keydown") return;
    const init = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true, ctrlKey: e.ctrlKey, metaKey: e.metaKey } as KeyboardEventInit;
    record({ route: "enter", label: sb ? btnName(sb).trim().slice(0, 40) : "回车发送", content: draftNear(t), rect: rectOf(sb ?? t) }, () => { for (const type of ["keydown", "keypress", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, init)); });
  };
  const origSubmit = HTMLFormElement.prototype.submit;
  const origRequestSubmit = HTMLFormElement.prototype.requestSubmit;
  const origClick = HTMLElement.prototype.click;
  const origDispatch = EventTarget.prototype.dispatchEvent;
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  const origBeacon = navigator.sendBeacon;
  // 逐项还原，一项失败不挡其余：装到一半出错时也要把已经换掉的换回来，页面不能留着半套拦截。
  const restore = () => {
    for (const t of PRESS) window.removeEventListener(t, onPress, true);
    window.removeEventListener("click", onClick, true);
    window.removeEventListener("submit", onSubmit, true);
    for (const t of ["keydown", "keypress", "keyup"]) window.removeEventListener(t, onKey as EventListener, true);
    for (const [obj, key, value] of [[HTMLFormElement.prototype, "submit", origSubmit], [HTMLFormElement.prototype, "requestSubmit", origRequestSubmit], [HTMLElement.prototype, "click", origClick], [EventTarget.prototype, "dispatchEvent", origDispatch], [window, "fetch", origFetch], [XMLHttpRequest.prototype, "open", origOpen], [XMLHttpRequest.prototype, "send", origSend], [navigator, "sendBeacon", origBeacon]] as const) {
      try { (obj as any)[key] = value; } catch { /* 页面把它设成只读：没换上，也就不用换回 */ }
    }
  };
  try {
    // shadow DOM 里的点击、不冒泡出来的合成事件和表单提交到不了 window 上的监听：在脚本调用的入口上就认付款。
    HTMLElement.prototype.click = function (this: HTMLElement) { const p = fromScript() ? payTarget(this) : null; if (p) { holdPay(null, p); return; } return origClick.call(this); };
    HTMLFormElement.prototype.requestSubmit = function (this: HTMLFormElement, submitter?: HTMLElement | null) { const p = fromScript() ? (submitter ? payTarget(submitter) : payIn(this)) : null; if (p) { holdPay(null, p); return; } return origRequestSubmit.call(this, submitter); };
    EventTarget.prototype.dispatchEvent = function (this: EventTarget, ev: Event) {
      if (this instanceof Element && !ev.isTrusted && fromScript()) {
        const p = ev.type === "click" || PRESS.includes(ev.type) ? payTarget(this)
          : ev.type === "submit" ? (this instanceof HTMLFormElement ? ((ev as SubmitEvent).submitter ? payTarget((ev as SubmitEvent).submitter) : payIn(this)) : null)
          : (ev as KeyboardEvent).key === "Enter" && !(ev as KeyboardEvent).shiftKey && /^key/.test(ev.type) ? enterPays(this) : null;
        if (p) { holdPay(null, p); return false; }
      }
      return origDispatch.call(this, ev);
    };
    const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
    // 只拦像发送接口的请求（路径里有 send、message、comment、reply、post 等词）：保存、搜索、读数据的请求照常发。这是按名字猜，名字不像的发送接口拦不到。
    const sendy = (url: string) => { try { return /(send|message|msg|chat|comment|reply|post|tweet|mail|publish|share|submit|发送)/i.test(new URL(url, location.href).pathname); } catch { return false; } };
    const where = (url: string) => { try { const u = new URL(url, location.href); return u.host === location.host ? u.pathname : u.host + u.pathname; } catch { return String(url).slice(0, 60); } };
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { const pay = fromScript() ? payIn(this) : null; if (pay) { holdPay(null, pay); return; } const sb = sendIn(this); if (sb && fromScript()) { record({ route: "script", label: btnName(sb).trim().slice(0, 40), content: draftNear(sb), rect: rectOf(sb) }, () => origSubmit.call(this)); return; } return origSubmit.call(this); };
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = input instanceof Request ? input.url : String(input);
      if (method !== "GET" && method !== "HEAD" && sendy(url) && fromScript()) {
        record({ route: "request", label: `${method} ${where(url)}`.slice(0, 60), content: typeof init?.body === "string" ? init.body.replace(/\s+/g, " ").slice(0, 120) : draftNear(document.activeElement), rect: null }, async () => {
          const response = await origFetch.call(window, input, init);
          if (!response.ok) throw new Error(`发送请求返回 HTTP ${response.status}，请核对网页上的结果，不要重复发送。`);
        });
        return Promise.reject(new TypeError(`这个请求要等用户确认后才会发出（${marker}）`));
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
    for (const t of PRESS) window.addEventListener(t, onPress, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    for (const t of ["keydown", "keypress", "keyup"]) window.addEventListener(t, onKey as EventListener, true);
  } catch (error) { restore(); throw error; }
  const disarm = () => {
    restore();
    delete w.__sideagentSendBlock;
    Object.defineProperty(w, "__sideagentSendHeld", { value: held.slice(0, 1), configurable: true, enumerable: false });
    return blocked;
  };
  Object.defineProperty(w, "__sideagentSendBlock", { value: { disarm }, configurable: true, enumerable: false });
}

type BlockedSend = { route: "script" | "enter" | "request"; label: string; content: string; rect: { left: number; top: number; width: number; height: number } | null };
type BlockedPay = Omit<BlockedSend, "route"> & { route: "pay" };

const DISARM = `(() => window.__sideagentSendBlock ? window.__sideagentSendBlock.disarm() : [])()`;
const REDO = `(async () => { const h = window.__sideagentSendHeld; delete window.__sideagentSendHeld; if (!h?.[0]) return false; if (await h[0]() === false) throw new Error("浏览器没有接受发送请求，请核对网页上的结果，不要重复发送。"); return true; })()`;
const DROP = `(() => { delete window.__sideagentSendHeld; return true; })()`;

/** js 工具只走 CDP Runtime.evaluate，避免 MAIN world eval 被页面 CSP 拦截。 */
export async function evaluateJs(
  params: { code: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeExecute?: (() => Promise<void>) & {checkNow?: () => void},
  sendGuard?: SendGuard,
): Promise<{ value: unknown; sendConfirmed?: true; sendNote?: string; heldReason?: HeldReason }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  await assertCompiles(tab.id, params.code);

  await beforeExecute?.();

  const tabId = tab.id;
  const marker = `sideagent-script-${crypto.randomUUID()}`;
  const armed = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", { expression: `(${armSendBlock.toString()})(${JSON.stringify(marker)}, ${isPayLabel.toString()})`, returnByValue: true });

  // 拦截没装上就不跑：否则脚本里的付款、发送动作会直接落到网页上。
  if (armed.exceptionDetails) throw Object.assign(new Error(`没能在这个网页上装好付款和发送拦截，脚本没有运行：${oneLine(armed.exceptionDetails.exception?.description ?? armed.exceptionDetails.text ?? "未知原因")}`), { executionFact: "not_executed" as const });
  let res: CdpEvalResult;
  let held: Array<BlockedSend | BlockedPay> = [];

  try {
    res = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", {
      expression: `${params.code}\n//# sourceURL=${marker}`,
      awaitPromise: true,
      returnByValue: true,
    },beforeExecute);
  } finally {
    const read = await sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", { expression: DISARM, returnByValue: true }).catch(() => undefined);
    held = Array.isArray(read?.result?.value) ? read.result.value as Array<BlockedSend | BlockedPay> : [];
  }

  const pay = held.find((b): b is BlockedPay => b.route === "pay");
  const blocked = held.filter((b): b is BlockedSend => b.route !== "pay");

  // 付款不问、不重做：圈出按钮交给用户；同一脚本里拦下的发送动作也一并丢掉，不再去问。
  if (pay) {
    await sendCommand(tabId, "Runtime.evaluate", { expression: DROP }).catch(() => {});
    const x = pay.rect ? pay.rect.left + pay.rect.width / 2 : -1;
    const y = pay.rect ? pay.rect.top + pay.rect.height / 2 : -1;
    await showPayStopOnPage(tabId, pay.label, x, y);
    const note = `${payStopText(pay.label)} The rest of the script may already have run.${blocked.length ? ` ${blocked.length} send action(s) in the same script were dropped, not sent.` : ""}`;
    const failed = res.exceptionDetails ? oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常") : "";

    return { value: res.result?.value, heldReason: "pay", sendNote: failed ? `${note} The script also threw: ${failed}` : note };
  }

  let sendNote: string | undefined;
  // 所有页面异常的堆栈都会带 sourceURL；只匹配错误首行，避免吞掉脚本自己的异常。
  const interruptedByConfirmation = res.exceptionDetails?.exception?.description?.split("\n", 1)[0] === `TypeError: 这个请求要等用户确认后才会发出（${marker}）`;

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
      // 用户没让发（先不发、停、离开、超时）不是脚本出错：脚本照常算跑完，结果里写明没发，侧栏不标红。
      const heldReason = (error as { heldReason?: HeldReason }).heldReason;
      if (heldReason) return { value: res.result?.value, heldReason, sendNote: `脚本里的发送动作（${first.label}）没有发出：${(error as Error).message}${extra}` };
      throw Object.assign(error as Error, { message: `脚本里的发送动作（${first.label}）先拦下，问了用户：${(error as Error).message}脚本其余部分可能已经运行。${extra}` });
    }
    let redo: CdpEvalResult;
    try {
      const check = async () => {
        await beforeExecute?.();
        if (sendGuard.cancelled()) throw Object.assign(new Error("用户已停下或接管：发送动作没有执行。"), { heldReason: "stopped" as const });
      };
      redo = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", { expression: REDO, awaitPromise: true, returnByValue: true }, check, 15_000);
    } finally {
      await sendCommand(tabId, "Runtime.evaluate", { expression: DROP }).catch(() => {});
    }

    if (redo.exceptionDetails) throw new Error(`发送请求未确认成功，请核对网页上的结果，不要重复发送。${oneLine(redo.exceptionDetails.exception?.description ?? redo.exceptionDetails.text ?? "请求失败")}`);
    if (redo.result?.value !== true) throw new Error(`用户确认了发送，但没能重做脚本里的发送动作（${first.label}），不知道发出去没有，请看网页，不要重复发送。`);
    sendNote = `脚本里的发送动作（${first.label}）先拦下，用户确认后才发出。${extra}`;
    if (interruptedByConfirmation) sendNote += "发送动作已执行；原脚本在等待确认时中断，后面的语句没有继续运行，不要重复发送。";
  }

  if (res.exceptionDetails && (!interruptedByConfirmation || !sendNote)) {
    const reason = oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常");
    if (sendNote) throw Object.assign(new Error(`${sendNote}不要重复发送。脚本另有错误：${reason}`), { sendConfirmed: true as const });
    throw new Error(reason);
  }

  if (res.result?.type === 'function') {
    throw new Error('返回的是尚未调用的函数，函数体没有执行。请使用立即调用表达式，例如 (() => { return document.title; })()，不要只传 () => { ... }。');
  }

  return { value: res.result?.value, ...(sendNote ? { sendConfirmed: true as const, sendNote } : {}) };
}
