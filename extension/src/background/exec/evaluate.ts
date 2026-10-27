import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID, type HeldReason } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { confirmSend, readRecipientInPage, requestSummary, type SendGuard } from "../send-confirm.js";
import { payStopText, showPayStopOnPage } from "../pay-stop.js";
import { isPayLabel } from "../../shared/mark-actions.js";
import { SENSITIVE_FIELD_NAME } from "../../../../shared/trace-sanitize.js";
import { readFieldInPage } from "./field-read-in-page.js";
import { snapshotSendScopeInPage } from "./send-context.js";
import { requestShape } from "../../../../shared/request-confirm.js";

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
 * 模型常把 `() => { ... }` 当脚本交来：原样运行只得到一个函数，函数体没跑，还要白跑一轮重写。
 * 不带参数的函数表达式运行本身没有副作用，编译得过 `(…)()` 就替它调用；其余照原样运行。
 */
async function invokeBareFunction(tabId: number, code: string): Promise<string> {
  // 去掉末尾的分号和行注释：去错了只会编译不过、照原样运行。
  const body = code.trim().replace(/;*\s*(\/\/[^\n]*)?$/, "");

  if (!/^(async\s+)?(\(\s*\)\s*=>|function\s*[\w$]*\s*\(\s*\))/.test(body)) return code;
  const called = `(${body}\n)()`;
  const compiled = await sendCommand(tabId, "Runtime.enable")
    .then(() => sendCommand<CdpEvalResult>(tabId, "Runtime.compileScript", { expression: called, sourceURL: "", persistScript: false }))
    .catch(() => undefined);

  return compiled && !compiled.exceptionDetails ? called : code;
}

/**
 * 脚本运行期间先留住发送动作，结束后走和点击「发送」同一个确认。
 * 点名字以「发送 / Send」开头的按钮（element.click、dispatchEvent）、提交带这种按钮的表单（requestSubmit、form.submit）、
 * 合成的回车（输入框里有字，或表单里有发送按钮）、脚本发起的写入或无法确认只读的非 GET 网络请求（fetch、XHR、sendBeacon）。
 * 拦下的动作先不做；用户点「发送」后原样重做第一个，其余丢弃。序列化进页面，必须自包含。
 * 付款按钮另算：脚本点它、提交带它的表单、在这种表单里合成回车，一律拦下且永不重做，付款留给用户自己点。isPay 是 isPayLabel 本身，按源码传进来。
 */
function armSendBlock(marker: string, isPay: (text: string) => boolean, sensitiveName: string, recipient: typeof readRecipientInPage, readField: typeof readFieldInPage, snapshotScope: typeof snapshotSendScopeInPage, request: typeof requestShape): void {
  type Rect = { left: number; top: number; width: number; height: number };
  type Blocked = { route: "script" | "enter" | "request" | "pay"; label: string; content: string; body?: string; host?: string; rect: Rect | null };
  const w = window as unknown as Record<string, any>;
  if (w.__sideagentSendBlock) w.__sideagentSendBlock.disarm();
  const isSend = (t: string) => { const s = (t ?? "").trim().replace(/\s+/g, " "); return s.startsWith("发送") || /^send(\s|$)/i.test(s); };
  const btnName = (b: Element) => b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "";
  const actionable = (el: Element | null | undefined) => el?.closest?.("button,[role=button],input[type=submit],input[type=button],a") ?? null;
  const sendIn = (scope: Element | null | undefined) => scope ? [...scope.querySelectorAll("button,[role=button],input[type=submit]")].find(b => isSend(btnName(b))) ?? null : null;
  const fromScript = () => (new Error().stack ?? "").includes(marker);
  const rectOf = (el: Element | null | undefined): Rect | null => { let r = el?.getBoundingClientRect(); if (el && r && (r.bottom < 0 || r.top > innerHeight)) { el.scrollIntoView({ block: "center" }); r = el.getBoundingClientRect(); } return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const draftField = (el: Element | null | undefined) => {
    const scope = el?.closest("form,[role=dialog],[role=form]") ?? el?.parentElement?.parentElement ?? null;
    return (el && (el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) ? el : scope?.querySelector("textarea,[contenteditable=true],input[type=text]:not([name*=to i])")) as HTMLTextAreaElement | HTMLElement | null;
  };
  const sensitive = (f: Element) => (f instanceof HTMLInputElement && (f.type === "password" || f.hasAttribute("data-bys-was-password"))) || /one-time-code|cc-(number|csc|exp)/i.test(f.getAttribute("autocomplete") ?? "") || new RegExp(sensitiveName, "i").test([f.getAttribute("name"), f.id, f.getAttribute("placeholder"), f.getAttribute("aria-label"), f.getAttribute("title")].map(v => (v ?? "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-.]+/g, " ")).join(" "));
  const valueOf = (f: HTMLTextAreaElement | HTMLElement | null) => f ? ((f as HTMLTextAreaElement).value ?? f.innerText ?? "") : "";
  const draftNear = (el: Element | null | undefined) => {
    const f = draftField(el);
    const v = (f && !sensitive(f) ? valueOf(f) : "").replace(/\s+/g, " ").trim();
    return v.length > 120 ? v.slice(0, 120) + "…" : v;
  };
  const blocked: Blocked[] = [];
  const held: Array<{ run: () => unknown; cleanup?: () => void }> = [];
  const bodyUnchanged = (read: () => unknown): (() => boolean | "unverified") => {
    const body = read();
    if (body == null || typeof body === "string") return () => read() === body;
    if (body instanceof URLSearchParams) { const before = body.toString(); return () => read() === body && body.toString() === before; }
    if (body instanceof FormData) {
      const before = [...body.entries()];
      return () => {
        if (read() !== body) return false;
        const after = [...body.entries()];
        return before.length === after.length && before.every(([key, value], i) => after[i]?.[0] === key && after[i]?.[1] === value);
      };
    }
    if (body instanceof Blob) return () => read() === body;
    if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
      const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
      if (bytes.byteLength > 1_000_000) return () => "unverified";
      const before = bytes.slice();
      return () => read() === body && bytes.byteLength === before.byteLength && before.every((value, i) => bytes[i] === value);
    }
    return () => "unverified";
  };
  const requestBytes = async (request: Request): Promise<Uint8Array | null> => {
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const clone = request.clone();
      if (!clone.body) return new Uint8Array();
      reader = clone.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      const timeout = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 2_000); });
      for (;;) {
        const item = await Promise.race([reader.read(), timeout]);
        if (item === null) { void reader.cancel().catch(() => {}); return null; }
        if (item.done) break;
        size += item.value.byteLength;
        if (size > 1_000_000) { void reader.cancel().catch(() => {}); return null; }
        chunks.push(item.value.slice());
      }
      const joined = new Uint8Array(size);
      let at = 0;
      for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
      return joined;
    } catch { return null; }
    finally { if (timer !== undefined) clearTimeout(timer); try { reader?.releaseLock(); } catch { /* 读取仍在结束 */ } }
  };
  const record = (b: Blocked, redo: () => unknown, target?: Element | null, verify?: () => boolean | "unverified" | Promise<boolean | "unverified">, cleanup?: () => void) => {
    const field = target ? draftField(target) : null;
    const secret = !!field && sensitive(field);
    const value = secret ? "" : valueOf(field);
    const to = target ? recipient(null, null, 65536, target) : null;
    const scope = target ? snapshotScope(target, readField, sensitiveName) : null;
    blocked.push(b);
    held.push({ run: async () => {
      try {
        if (secret) throw new Error("BYS_SEND_CONTEXT_UNVERIFIED");
        if (target && (!target.isConnected || draftField(target) !== field || valueOf(field) !== value || recipient(null, null, 65536, target) !== to)) throw new Error("BYS_SEND_CONTEXT_CHANGED");
        if (target) {
          const current = snapshotScope(target, readField, sensitiveName);
          if (scope === null || current === null) throw new Error("BYS_SEND_CONTEXT_UNVERIFIED");
          if (current !== scope) throw new Error("BYS_SEND_CONTEXT_CHANGED");
        }
        const pending = verify?.();
        const verified = pending instanceof Promise ? await pending : pending;
        if (verified === "unverified") throw new Error("BYS_SEND_CONTEXT_UNVERIFIED");
        if (verified === false) throw new Error("BYS_SEND_CONTEXT_CHANGED");
      } catch (error) {
        if (error instanceof Error && error.message === "BYS_SEND_CONTEXT_CHANGED") throw error;
        throw new Error("BYS_SEND_CONTEXT_UNVERIFIED");
      }
      return redo();
    }, ...(cleanup ? { cleanup } : {}) });
  };
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
  const onClick = (e: MouseEvent) => { if (e.isTrusted) return; const p = fromScript() ? payTarget(real(e)) : null; if (p) { holdPay(e, p); return; } const b = actionable(e.target as Element); if (b && isSend(btnName(b))) { stop(e); record({ route: "script", label: btnName(b).trim().slice(0, 40), content: draftNear(b), rect: rectOf(b) }, () => (b as HTMLElement).click(), b); } };
  const onSubmit = (e: SubmitEvent) => { if (e.isTrusted && !fromScript()) return; const form = e.target as HTMLFormElement; const pay = !fromScript() ? null : e.submitter ? payTarget(e.submitter) : payIn(form); if (pay) { holdPay(e, pay); return; } const sub = e.submitter && isSend(btnName(e.submitter)) ? e.submitter : !e.submitter ? sendIn(form) : null; if (sub) { stop(e); record({ route: "script", label: btnName(sub).trim().slice(0, 40), content: draftNear(sub), rect: rectOf(sub) }, () => form.requestSubmit(e.submitter as HTMLElement ?? undefined), sub); } };
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
    record({ route: "enter", label: sb ? btnName(sb).trim().slice(0, 40) : "回车发送", content: draftNear(t), rect: rectOf(sb ?? t) }, () => { for (const type of ["keydown", "keypress", "keyup"]) t.dispatchEvent(new KeyboardEvent(type, init)); }, t);
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
    // 这段按源码注入、不在严格模式里：页面设成只读的方法赋值会悄悄失败，所以装完逐项核对。
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
    // 与请求工具运行同一份判定：搜索、查询、保存放行，写入和拿不准的都问。
    const needsConfirm = (method: string, url: string, body?: string) => (i => i === "write" || i === "unknown")(request(method, url, body, location.href).intent);
    const hostOf = (url: string) => { try { return new URL(url, location.href).host; } catch { return undefined; } };
    const text = (body: unknown) => typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : undefined;
    const where = (url: string) => { try { const u = new URL(url, location.href); return u.host === location.host ? u.pathname : u.host + u.pathname; } catch { return String(url).slice(0, 60); } };
    HTMLFormElement.prototype.submit = function (this: HTMLFormElement) { const pay = fromScript() ? payIn(this) : null; if (pay) { holdPay(null, pay); return; } const sb = sendIn(this); if (sb && fromScript()) { record({ route: "script", label: btnName(sb).trim().slice(0, 40), content: draftNear(sb), rect: rectOf(sb) }, () => origSubmit.call(this), sb); return; } return origSubmit.call(this); };
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const url = input instanceof Request ? input.url : String(input);
      if (method !== "GET" && method !== "HEAD" && needsConfirm(method, url, text(init?.body)) && fromScript()) {
        const headers = () => [...new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).entries()].sort(([a], [b]) => a.localeCompare(b));
        const beforeHeaders = JSON.stringify(headers());
        const requestBody = input instanceof Request && init?.body === undefined && input.body !== null ? input : null;
        const beforeRequest = requestBody ? requestBytes(requestBody) : null;
        const readBody = () => init?.body ?? (input instanceof Request ? input.body : undefined);
        const bodySame = requestBody ? null : bodyUnchanged(readBody);
        const metadataSame = () => String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase() === method && (input instanceof Request ? input.url : String(input)) === url && JSON.stringify(headers()) === beforeHeaders;
        const same = (): boolean | "unverified" | Promise<boolean | "unverified"> => {
          if (!metadataSame()) return false;
          if (requestBody && beforeRequest) {
            if (init?.body !== undefined) return false;
            return (async () => {
              const before = await beforeRequest;
              const after = await requestBytes(requestBody);
              if (!before || !after) return "unverified";
              return metadataSame() && init?.body === undefined && before.length === after.length && before.every((value, i) => value === after[i]);
            })();
          }
          return bodySame?.() ?? "unverified";
        };
        record({ route: "request", label: `${method} ${where(url)}`.slice(0, 60), content: "", body: text(init?.body)?.slice(0, 4000), host: hostOf(url), rect: null }, async () => {
          const response = await origFetch.call(window, input, init);
          if (!response.ok) throw new Error(`发送请求返回 HTTP ${response.status}，请核对网页上的结果，不要重复发送。`);
        }, null, same);
        return Promise.reject(new TypeError(`这个请求要等用户确认后才会发出（${marker}）`));
      }
      return origFetch.call(window, input, init);
    } as typeof fetch;
    XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) { meta.set(this, { method: String(method).toUpperCase(), url: String(url) }); return (origOpen as any).call(this, method, url, ...rest); } as typeof origOpen;
    XMLHttpRequest.prototype.send = function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
      const m = meta.get(this);
      if (m && m.method !== "GET" && m.method !== "HEAD" && needsConfirm(m.method, m.url, text(body)) && fromScript()) {
        const xhr = this; const sameBody = bodyUnchanged(() => body);
        const beforeOpen = Object.getOwnPropertyDescriptor(xhr, "open");
        const beforeHeader = Object.getOwnPropertyDescriptor(xhr, "setRequestHeader");
        const open = xhr.open, setHeader = xhr.setRequestHeader;
        const config = [xhr.timeout, xhr.withCredentials, xhr.responseType];
        let changed = false, installed = false;
        const trackedOpen = function (this: XMLHttpRequest, ...args: unknown[]) { changed = true; return (open as any).apply(this, args); };
        const trackedHeader = function (this: XMLHttpRequest, ...args: unknown[]) { changed = true; return (setHeader as any).apply(this, args); };
        const cleanup = () => {
          try { if (xhr.open === trackedOpen) { if (beforeOpen) Object.defineProperty(xhr, "open", beforeOpen); else delete (xhr as unknown as Record<string, unknown>).open; } } catch { /* 页面改过方法时不覆盖 */ }
          try { if (xhr.setRequestHeader === trackedHeader) { if (beforeHeader) Object.defineProperty(xhr, "setRequestHeader", beforeHeader); else delete (xhr as unknown as Record<string, unknown>).setRequestHeader; } } catch { /* 页面改过方法时不覆盖 */ }
        };
        try {
          Object.defineProperty(xhr, "open", { value: trackedOpen, configurable: true, writable: true });
          Object.defineProperty(xhr, "setRequestHeader", { value: trackedHeader, configurable: true, writable: true });
          installed = xhr.open === trackedOpen && xhr.setRequestHeader === trackedHeader;
        } catch { cleanup(); }
        const same = () => !installed ? "unverified" as const : !changed && xhr.open === trackedOpen && xhr.setRequestHeader === trackedHeader && xhr.readyState === 1 && xhr.timeout === config[0] && xhr.withCredentials === config[1] && xhr.responseType === config[2] && meta.get(xhr) === m && sameBody();
        record({ route: "request", label: `${m.method} ${where(m.url)}`.slice(0, 60), content: "", body: text(body)?.slice(0, 4000), host: hostOf(m.url), rect: null }, () => origSend.call(xhr, body), null, same, cleanup);
        return;
      }
      return origSend.call(this, body);
    };
    navigator.sendBeacon = function (url: string | URL, data?: BodyInit | null) { if (needsConfirm("POST", String(url), text(data)) && fromScript()) { const address = String(url); const sameBody = bodyUnchanged(() => data); record({ route: "request", label: `POST ${where(address)}`.slice(0, 60), content: "", body: text(data)?.slice(0, 4000), host: hostOf(String(url)), rect: null }, () => origBeacon.call(navigator, url, data), null, () => String(url) === address && sameBody()); return false; } return origBeacon.call(navigator, url, data); };
    for (const t of PRESS) window.addEventListener(t, onPress, true);
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    for (const t of ["keydown", "keypress", "keyup"]) window.addEventListener(t, onKey as EventListener, true);
    const stuck = [[HTMLFormElement.prototype.submit, origSubmit, "submit"], [HTMLFormElement.prototype.requestSubmit, origRequestSubmit, "requestSubmit"], [HTMLElement.prototype.click, origClick, "click"], [EventTarget.prototype.dispatchEvent, origDispatch, "dispatchEvent"], [window.fetch, origFetch, "fetch"], [XMLHttpRequest.prototype.open, origOpen, "XMLHttpRequest.open"], [XMLHttpRequest.prototype.send, origSend, "XMLHttpRequest.send"], [navigator.sendBeacon, origBeacon, "sendBeacon"]].filter(([now, orig]) => now === orig).map(([, , name]) => name);
    if (stuck.length) throw new Error(`页面不让替换 ${stuck.join("、")}`);
  } catch (error) { restore(); throw error; }
  const disarm = () => {
    restore();
    delete w.__sideagentSendBlock;
    for (const item of held.slice(1)) item.cleanup?.();
    Object.defineProperty(w, "__sideagentSendHeld", { value: held.slice(0, 1), configurable: true, enumerable: false });
    return blocked;
  };
  Object.defineProperty(w, "__sideagentSendBlock", { value: { disarm }, configurable: true, enumerable: false });
}

type BlockedSend = { route: "script" | "enter" | "request"; label: string; content: string; body?: string; host?: string; rect: { left: number; top: number; width: number; height: number } | null };
type BlockedPay = Omit<BlockedSend, "route"> & { route: "pay" };

const DISARM = `(() => window.__sideagentSendBlock ? window.__sideagentSendBlock.disarm() : [])()`;
const REDO = `(async () => { const h = window.__sideagentSendHeld; delete window.__sideagentSendHeld; if (!h?.[0]) return false; try { if (await h[0].run() === false) throw new Error("浏览器没有接受发送请求，请核对网页上的结果，不要重复发送。"); return true; } finally { h[0].cleanup?.(); } })()`;
const DROP = `(() => { const h = window.__sideagentSendHeld; delete window.__sideagentSendHeld; for (const item of h ?? []) item.cleanup?.(); return true; })()`;

/** js 工具只走 CDP Runtime.evaluate，避免 MAIN world eval 被页面 CSP 拦截。 */
export async function evaluateJs(
  params: { code: string; tabId?: number },
  sessionId: string = LEAD_SESSION_ID,
  beforeExecute?: (() => Promise<void>) & {checkNow?: () => void},
  sendGuard?: SendGuard,
): Promise<{ value: unknown; sendConfirmed?: true; sendNote?: string; heldReason?: HeldReason }> {
  const tab = await resolveWorkingTab(params.tabId, sessionId);

  if (tab.id == null) throw new Error("工作标签页无效");
  const code = await invokeBareFunction(tab.id, params.code);
  await assertCompiles(tab.id, code);

  await beforeExecute?.();

  const tabId = tab.id;
  const marker = `sideagent-script-${crypto.randomUUID()}`;
  const armed = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", { expression: `(${armSendBlock.toString()})(${JSON.stringify(marker)}, ${isPayLabel.toString()}, ${JSON.stringify(SENSITIVE_FIELD_NAME.source)}, ${readRecipientInPage.toString()}, ${readFieldInPage.toString()}, ${snapshotSendScopeInPage.toString()}, ${requestShape.toString()})`, returnByValue: true });

  // 拦截没装上就不跑：否则脚本里的付款、发送动作会直接落到网页上。
  if (armed.exceptionDetails) throw Object.assign(new Error(`没能在这个网页上装好付款和发送拦截，脚本没有运行：${oneLine(armed.exceptionDetails.exception?.description ?? armed.exceptionDetails.text ?? "未知原因")}`), { executionFact: "not_executed" as const });
  let res: CdpEvalResult;
  let held: Array<BlockedSend | BlockedPay> = [];

  try {
    res = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", {
      expression: `${code}\n//# sourceURL=${marker}`,
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
        // 请求正文会随侧栏记录存进本机：和请求工具一样先遮凭据，认不出格式就不写。
        const content = first.body !== undefined ? requestSummary(first.body) : first.content;
        return { ...(content ? { content } : {}), ...(first.host ? { host: first.host } : {}), ...(recipient ? { recipient } : {}), ...(first.rect ? { rect: first.rect } : {}), route: first.route };
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

    if (redo.exceptionDetails) {
      const reason = oneLine(redo.exceptionDetails.exception?.description ?? redo.exceptionDetails.text ?? "请求失败");
      if (reason.includes("BYS_SEND_CONTEXT_CHANGED")) return { value: res.result?.value, heldReason: "send_changed", sendNote: "确认期间发送内容或收件人发生变化：没有发送。脚本其他部分可能已经运行，请检查网页后重新确认。" };
      if (reason.includes("BYS_SEND_CONTEXT_UNVERIFIED")) return { value: res.result?.value, heldReason: "send_unverified", sendNote: "无法核对请求内容：没有发送。脚本其他部分可能已经运行，请检查网页。" };
      throw new Error(`发送请求未确认成功，请核对网页上的结果，不要重复发送。${reason}`);
    }
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
