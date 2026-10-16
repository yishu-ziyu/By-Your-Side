import { sendCommand } from "../debugger.js";
import { LEAD_SESSION_ID } from "../../../../shared/protocol.js";
import { resolveWorkingTab } from "../state.js";
import { oneLine } from "../util.js";
import { confirmSend, readRecipientInPage, type SendGuard } from "../send-confirm.js";
import { isHostPageProbe } from "../../../../shared/effect-policy.js";

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
 * 同一段时间里，脚本自己的代码写网站存下的数据（localStorage / sessionStorage、IndexedDB、cookie，含同源子框架）直接在页面里抛错、
 * 不重做（#494）：否则脚本能改存储再重画页面，让没成功的一步看起来做完了。看的是写入的直接调用方：脚本点按钮后网站自己的处理函数保存照常放行。
 * 改 DOM 和样式不拦，用户会要求改页面样子。拦不到：直接给属性赋值（localStorage.x = ...）、脚本运行中新建的框架、从别的框架借来的原生函数。
 * 返回的控制对象只交给宿主（CDP 远程对象），不挂到 window 上：页面拿不到，伪造不了结果，也拆不掉别的调用的拦截。
 * 模型的调用按标签页排队，但宿主的只读探测不排队，可能和它同时装上：每次只包一层、结束时只撤自己那一层；
 * 被别人压在下面的那层变成直通，由上层撤掉时一并跳过。
 */
function armSendBlock(marker: string, guardStorage: boolean) {
  type Rect = { left: number; top: number; width: number; height: number };
  type Blocked = { route: "script" | "enter" | "request"; label: string; content: string; rect: Rect | null };
  type Fn = (...args: any[]) => any;
  const UNWRAP = Symbol.for("sideagent.unwrap");
  let active = true;
  const restores: Array<() => void> = [];
  // 一层包装：下面那层还在用时撤到它为止；下面那层已经结束（直通）就继续往下跳过。
  const bottom = (orig: Fn | undefined) => { let cur = orig; for (let next; (next = (cur as any)?.[UNWRAP]?.());) cur = next; return cur; };
  const wrap = (obj: any, key: string, make: (orig: Fn) => Fn) => {
    const orig = obj[key] as Fn; const wrapper = make(orig);
    Object.defineProperty(wrapper, UNWRAP, { value: () => active ? null : orig });
    obj[key] = wrapper;
    restores.push(() => { if (obj[key] === wrapper) obj[key] = bottom(orig); });
  };
  const wrapSetter = (obj: any, key: string, make: (orig: Fn) => Fn) => {
    const desc = Object.getOwnPropertyDescriptor(obj, key); if (!desc?.set) return;
    const orig = desc.set; const wrapper = make(orig);
    Object.defineProperty(wrapper, UNWRAP, { value: () => active ? null : orig });
    Object.defineProperty(obj, key, { ...desc, set: wrapper });
    restores.push(() => { const now = Object.getOwnPropertyDescriptor(obj, key); if (now?.set === wrapper) Object.defineProperty(obj, key, { ...now, set: bottom(orig) }); });
  };
  const stack = () => { const E = Error as unknown as { stackTraceLimit: number }; const limit = E.stackTraceLimit; E.stackTraceLimit = 40; const s = new Error().stack ?? ""; E.stackTraceLimit = limit; return s.split("\n").slice(1); };
  const fromScript = () => active && stack().some(f => f.includes(marker));
  // 第一个有来源的帧就是直接调用方；没有来源的帧（这里的包装、Array.forEach 之类的内建函数）跳过。
  const directFromScript = () => { if (!active) return false; const caller = stack().find(f => !/\(<anonymous>(:\d+:\d+)?\)$|at <anonymous>(:\d+:\d+)?$/.test(f.trim())); return !!caller && caller.includes(marker); };
  const isSend = (t: string) => { const s = (t ?? "").trim().replace(/\s+/g, " "); return s.startsWith("发送") || /^send(\s|$)/i.test(s); };
  const btnName = (b: Element) => b.getAttribute("aria-label") || (b as HTMLElement).innerText || (b as HTMLInputElement).value || b.getAttribute("title") || "";
  const actionable = (el: Element | null | undefined) => el?.closest?.("button,[role=button],input[type=submit],input[type=button],a") ?? null;
  const sendIn = (scope: Element | null | undefined) => scope ? [...scope.querySelectorAll("button,[role=button],input[type=submit]")].find(b => isSend(btnName(b))) ?? null : null;
  const rectOf = (el: Element | null | undefined): Rect | null => { let r = el?.getBoundingClientRect(); if (el && r && (r.bottom < 0 || r.top > innerHeight)) { el.scrollIntoView({ block: "center" }); r = el.getBoundingClientRect(); } return r ? { left: r.left, top: r.top, width: r.width, height: r.height } : null; };
  const draftNear = (el: Element | null | undefined) => {
    const scope = el?.closest("form,[role=dialog],[role=form]") ?? el?.parentElement?.parentElement ?? null;
    const f = (el && (el.tagName === "TEXTAREA" || (el as HTMLElement).isContentEditable) ? el : scope?.querySelector("textarea,[contenteditable=true],input[type=text]:not([name*=to i])")) as HTMLTextAreaElement | HTMLElement | null;
    const v = ((f as HTMLTextAreaElement)?.value ?? (f as HTMLElement)?.innerText ?? "").replace(/\s+/g, " ").trim();
    return v.length > 120 ? v.slice(0, 120) + "…" : v;
  };
  const blocked: Blocked[] = [];
  let held: Array<() => unknown> = [];
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
  const meta = new WeakMap<XMLHttpRequest, { method: string; url: string }>();
  // 只拦像发送接口的请求（路径里有 send、message、comment、reply、post 等词）：保存、搜索、读数据的请求照常发。这是按名字猜，名字不像的发送接口拦不到。
  const sendy = (url: string) => { try { return /(send|message|msg|chat|comment|reply|post|tweet|mail|publish|share|submit|发送)/i.test(new URL(url, location.href).pathname); } catch { return false; } };
  const where = (url: string) => { try { const u = new URL(url, location.href); return u.host === location.host ? u.pathname : u.host + u.pathname; } catch { return String(url).slice(0, 60); } };
  wrap(HTMLFormElement.prototype, "submit", origSubmit => function (this: HTMLFormElement) { const sb = sendIn(this); if (sb && fromScript()) { record({ route: "script", label: btnName(sb).trim().slice(0, 40), content: draftNear(sb), rect: rectOf(sb) }, () => origSubmit.call(this)); return; } return origSubmit.call(this); });
  wrap(window, "fetch", origFetch => function (input: RequestInfo | URL, init?: RequestInit) {
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const url = input instanceof Request ? input.url : String(input);
    if (method !== "GET" && method !== "HEAD" && sendy(url) && fromScript()) {
      record({ route: "request", label: `${method} ${where(url)}`.slice(0, 60), content: typeof init?.body === "string" ? init.body.replace(/\s+/g, " ").slice(0, 120) : draftNear(document.activeElement), rect: null }, () => origFetch.call(window, input, init));
      return Promise.reject(new TypeError("这个请求要等用户确认后才会发出（By Your Side 发送确认）"));
    }
    return origFetch.call(window, input, init);
  });
  wrap(XMLHttpRequest.prototype, "open", origOpen => function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) { meta.set(this, { method: String(method).toUpperCase(), url: String(url) }); return origOpen.call(this, method, url, ...rest); });
  wrap(XMLHttpRequest.prototype, "send", origSend => function (this: XMLHttpRequest, body?: Document | XMLHttpRequestBodyInit | null) {
    const m = meta.get(this);
    if (m && m.method !== "GET" && m.method !== "HEAD" && sendy(m.url) && fromScript()) { const xhr = this; record({ route: "request", label: `${m.method} ${where(m.url)}`.slice(0, 60), content: typeof body === "string" ? body.replace(/\s+/g, " ").slice(0, 120) : draftNear(document.activeElement), rect: null }, () => origSend.call(xhr, body)); return; }
    return origSend.call(this, body);
  });
  wrap(navigator, "sendBeacon", origBeacon => function (url: string | URL, data?: BodyInit | null) { if (sendy(String(url)) && fromScript()) { record({ route: "request", label: `POST ${where(String(url))}`.slice(0, 60), content: typeof data === "string" ? data.slice(0, 120) : "", rect: null }, () => origBeacon.call(navigator, url, data)); return false; } return origBeacon.call(navigator, url, data); });
  // 只记固定的几类和次数，不记键名、值：结果会进宿主的错误文字。
  const storageKinds = new Set<"localStorage" | "sessionStorage" | "indexedDB" | "cookie">();
  let storageCount = 0;
  if (guardStorage) {
    const realms: Window[] = [];
    // 同源子框架（含 about:blank、srcdoc）和顶层共用一份存储；跨源框架读 document 会抛错，跳过。
    const collect = (win: Window) => { realms.push(win); for (let i = 0; i < win.frames.length; i++) { try { const f = win.frames[i]!; void f.document; collect(f); } catch { /* 跨源 */ } } };
    collect(window);
    for (const win of realms) {
      const g = win as unknown as { Storage: typeof Storage; IDBFactory: typeof IDBFactory; Document: typeof Document; sessionStorage: Storage };
      const refuse = (kind: "localStorage" | "sessionStorage" | "indexedDB" | "cookie") => { storageKinds.add(kind); storageCount++; throw new Error("By Your Side blocked this write: a script may not write the site's saved data"); };
      const area = (s: Storage) => { try { return s === g.sessionStorage ? "sessionStorage" as const : "localStorage" as const; } catch { return "localStorage" as const; } };
      for (const key of ["setItem", "removeItem", "clear"]) wrap(g.Storage.prototype, key, orig => function (this: Storage, ...args: unknown[]) { if (directFromScript()) refuse(area(this)); return orig.apply(this, args); });
      for (const key of ["open", "deleteDatabase"]) wrap(g.IDBFactory.prototype, key, orig => function (this: IDBFactory, ...args: unknown[]) { if (directFromScript()) refuse("indexedDB"); return orig.apply(this, args); });
      wrapSetter(g.Document.prototype, "cookie", orig => function (this: Document, v: string) { if (directFromScript()) refuse("cookie"); orig.call(this, v); });
    }
  }
  window.addEventListener("click", onClick, true);
  window.addEventListener("submit", onSubmit, true);
  for (const t of ["keydown", "keypress", "keyup"]) window.addEventListener(t, onKey as EventListener, true);
  let disarmed = false;
  return {
    disarm() {
      if (!disarmed) {
        disarmed = true; active = false;
        window.removeEventListener("click", onClick, true);
        window.removeEventListener("submit", onSubmit, true);
        for (const t of ["keydown", "keypress", "keyup"]) window.removeEventListener(t, onKey as EventListener, true);
        for (const restore of restores) { try { restore(); } catch { /* 框架已卸载 */ } }
        held = held.slice(0, 1);
      }
      return { blocked, storage: { kinds: [...storageKinds], count: storageCount } };
    },
    redo() { const h = held[0]; held = []; if (!h) return false; h(); return true; },
    drop() { held = []; return true; },
  };
}

type BlockedSend = { route: "script" | "enter" | "request"; label: string; content: string; rect: { left: number; top: number; width: number; height: number } | null };

const STORAGE_KINDS: ReadonlySet<string> = new Set(["localStorage", "sessionStorage", "indexedDB", "cookie"]);

/**
 * 同一标签页上模型的 js 调用一个接一个跑，从装拦截到确认后重做都算在内：否则后一次的拦截会截走前一次用户批准后重做的发送。
 * 宿主写死的只读探测不排队。排队等的比代理侧 js 的 RPC 期限（DEFAULT_TOOL_TIMEOUT_MS）短：等不到就不跑，
 * 免得代理已经按超时处理了，这段脚本才在页面上跑起来。
 */
const JS_QUEUE_WAIT_MS = 25_000;
const jsTurns = new Map<number, Promise<void>>();

async function inTabTurn<T>(tabId: number, run: () => Promise<T>): Promise<T> {
  const before = jsTurns.get(tabId) ?? Promise.resolve();
  let release!: () => void;
  const tail = before.then(() => new Promise<void>(resolve => { release = resolve; }));
  const releaseLater = () => { void before.then(() => release()); };
  jsTurns.set(tabId, tail);
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const ready = await Promise.race([before.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), JS_QUEUE_WAIT_MS); })]);

    if (!ready) throw Object.assign(new Error(`这个标签页上前一段脚本 ${JS_QUEUE_WAIT_MS / 1000} 秒还没结束，这段脚本没有运行，页面没有变化。`), { executionFact: "not_executed" as const });
    return await run();
  } finally {
    clearTimeout(timer);
    releaseLater();
    void tail.then(() => { if (jsTurns.get(tabId) === tail) jsTurns.delete(tabId); });
  }
}

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
  const tabId = tab.id;
  const go = async () => { await beforeExecute?.(); return runArmed(tabId, params, beforeExecute, sendGuard); };

  return isHostPageProbe("js", params) ? go() : inTabTurn(tabId, go);
}

async function runArmed(
  tabId: number,
  params: { code: string; tabId?: number },
  beforeExecute: ((() => Promise<void>) & {checkNow?: () => void}) | undefined,
  sendGuard: SendGuard | undefined,
): Promise<{ value: unknown; sendConfirmed?: true; sendNote?: string }> {
  const marker = `sideagent-script-${crypto.randomUUID()}`;
  // 宿主写死的只读探测不装存储拦截：它们不写数据，也不该因拦截改变行为。
  const guardStorage = !isHostPageProbe("js", params);
  const armed = await sendCommand<{ result?: { objectId?: string }; exceptionDetails?: unknown }>(tabId, "Runtime.evaluate", { expression: `(${armSendBlock.toString()})(${JSON.stringify(marker)}, ${guardStorage})`, objectGroup: marker });
  const control = armed.result?.objectId;

  if (!control || armed.exceptionDetails) throw Object.assign(new Error("没能在页面里装上脚本拦截，脚本未运行，页面没有变化。"), { executionFact: "not_executed" as const });
  const callControl = (method: "disarm" | "redo" | "drop") => sendCommand<{ result?: { value?: unknown } }>(tabId, "Runtime.callFunctionOn", { objectId: control, functionDeclaration: `function () { return this.${method}(); }`, returnByValue: true });

  try {
    let res: CdpEvalResult;
    let blocked: BlockedSend[] = [];
    let storage = { kinds: [] as string[], count: 0 };

    // 拦截一直留到脚本真正结束：提前撤下，迟到的发送就不经确认发出去了。存储拦截只看直接调用方，留着不碍网站自己保存。
    try {
      res = await sendCommand<CdpEvalResult>(tabId, "Runtime.evaluate", {
        expression: `${params.code}\n//# sourceURL=${marker}`,
        awaitPromise: true,
        returnByValue: true,
      },beforeExecute);
    } finally {
      const read = await callControl("disarm").catch(() => undefined);
      const v = read?.result?.value as { blocked?: unknown; storage?: { kinds?: unknown; count?: unknown } } | null | undefined;
      blocked = Array.isArray(v?.blocked) ? v.blocked as BlockedSend[] : [];
      const kinds = Array.isArray(v?.storage?.kinds) ? v.storage.kinds.filter((x): x is string => typeof x === "string" && STORAGE_KINDS.has(x)) : [];
      const count = typeof v?.storage?.count === "number" && Number.isFinite(v.storage.count) ? Math.max(kinds.length, Math.floor(v.storage.count)) : kinds.length;
      storage = { kinds, count: kinds.length ? count : 0 };
    }

    let sendNote: string | undefined;

    if (blocked.length) {
      const first = blocked[0]!;
      const extra = blocked.length > 1 ? `另有 ${blocked.length - 1} 个发送动作被丢弃。` : "";

      if (!sendGuard) {
        await callControl("drop").catch(() => {});
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
        await callControl("drop").catch(() => {});
        // 用户没让发（先不发、停、离开、超时）不是脚本出错：脚本照常算跑完，结果里写明没发，侧栏不标红。
        if ((error as { heldReason?: unknown }).heldReason) return { value: res!.result?.value, sendNote: `脚本里的发送动作（${first.label}）没有发出：${(error as Error).message}${extra}` };
        throw Object.assign(error as Error, { message: `脚本里的发送动作（${first.label}）先拦下，问了用户：${(error as Error).message}脚本其余部分可能已经运行。${extra}` });
      }
      const redo = await callControl("redo").catch(() => undefined);

      if (redo?.result?.value !== true) throw new Error(`用户确认了发送，但没能重做脚本里的发送动作（${first.label}），不知道发出去没有，请看网页。`);
      sendNote = `脚本里的发送动作（${first.label}）先拦下，用户确认后才发出。${extra}`;
    }

    if (storage.count) {
      throw new Error(`${sendNote ? `${sendNote}\n` : ""}The script tried to write the site's saved data (${storage.kinds.join(", ")}; ${storage.count} write${storage.count > 1 ? "s" : ""}). This is not allowed, so those writes did not happen; other parts of the script may have run. Do the step with a normal action (fill, press_key, click). If the normal action has no effect after one retry, stop and tell the user which step had no effect.`);
    }

    if (res.exceptionDetails) {
      throw new Error(oneLine(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "JS 执行异常"));
    }

    if (res.result?.type === 'function') {
      throw new Error('返回的是尚未调用的函数，函数体没有执行。请使用立即调用表达式，例如 (() => { return document.title; })()，不要只传 () => { ... }。');
    }

    return { value: res.result?.value, ...(sendNote ? { sendConfirmed: true as const, sendNote } : {}) };
  } finally {
    await sendCommand(tabId, "Runtime.releaseObjectGroup", { objectGroup: marker }).catch(() => {});
  }
}
