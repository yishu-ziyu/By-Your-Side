/**
 * 点「发送」前停下，在网页上问用户（docs/evals/20261009-send-confirm.md R1）。
 * 发出去的消息收不回来，所以只有用户点「发送」才放行；「不发」、停、接管、离开网页、2 分钟没理都不点。
 * 确认框画在网页的 closed shadow 里，带 overlay 标记：助手的点击落在上面会被 assertNotOwnOverlay 拒绝。
 * 侧栏同时出一张确认卡（docs/evals/20261015-panel-send-confirm.md），两边回答的是同一个等待。
 */
import { OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM } from "../shared/overlay.js";
import { isSendLabel } from "../shared/mark-actions.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { bringForwardForUser } from "./foreground.js";
import { SEND_ARM_MS, SEND_CONFIRM_PANEL_PORT } from "../relay.js";
import type { GuideWait, HeldReason, SendConfirmView } from "../../../shared/protocol.js";
import { isPanelUrl } from "./target-window.js";

/** 用户多久没理就按「不发」处理。宿主那边放宽的期限比这个长，所以总是这里先给出「没点」的结果。 */
export const SEND_CONFIRM_MS = 120_000;

const PORT_PREFIX = "send-confirm:";

/** 确认框没在这么久内连上后台，就当没显示出来，不点。 */
const SHOW_MS = 5_000;

const POLL_MS = 150;

export interface SendGuard {
  /** 网页脚本程序（browser_run）里的点击：程序有总期限，不能在里面等用户。 */
  inProgram: boolean;
  /** 这一轮的身份（任务 + 用户说到第几句）：用户说过「不发」的按钮，到用户再说话之前不再问。没有任务身份时不记。 */
  task: string | undefined;
  /** 停、接管、控制轮次变了：等确认要马上结束。 */
  cancelled(): boolean;
  /** 告诉宿主这次调用正在等用户（放宽期限）或已经不等了（恢复普通期限）。guide：教学这一步在等用户点（guide_step 也用这个钩子）；send：侧栏确认卡的内容和结局。 */
  waiting(on: boolean, guide?: GuideWait, send?: SendConfirmView): void;
}

/** 页面上和侧栏里写同一句：发什么、发给谁、在哪个网站。 */
export function sendSentence(host: string, label: string, content?: string, recipient?: string): string {
  const to = recipient ? `发给 ${recipient}，` : "";
  return content ? `把这段 ${[...content.replace(/…$/, "")].length} 字的内容${to}在 ${host} 上` : `点「${label.trim()}」${to}在 ${host} 上`;
}

/** 网页上读「发给谁」：同一表单/容器里的收件人栏，否则页面的主标题。序列化进页面，必须自包含。 */
export function readRecipientInPage(x: number | null, y: number | null): string | null {
  const at = x === null || y === null ? document.activeElement : document.elementFromPoint(x, y);
  const scope = at?.closest("form,[role=dialog],[role=form],main") ?? document;
  const clip = (t: string | null | undefined) => { const v = (t ?? "").replace(/\s+/g, " ").trim(); return v ? (v.length > 40 ? v.slice(0, 40) + "…" : v) : null; };
  for (const el of scope.querySelectorAll<HTMLInputElement>("input,[contenteditable=true]")) {
    const name = [el.name, el.id, el.getAttribute("aria-label"), el.labels?.[0]?.textContent, el.placeholder].join(" ");
    if (/(^|\s)(to|recipients?|收件人|发给)\b/i.test(name) || /收件人|发给/.test(name)) { const v = clip(el.value ?? el.textContent); if (v) return v; }
  }
  return clip(document.querySelector("h1,h2")?.textContent) ?? clip(document.title);
}

export interface SendDetails { content?: string; recipient?: string; rect?: { left: number; top: number; width: number; height: number }; route?: SendConfirmView["route"] }

type Outcome = NonNullable<SendConfirmView["outcome"]>;

/** 每种「用户没让发」都带这句：别让助手改按回车或点别的按钮把它发出去。 */
const NO_OTHER_WAY = "不要换别的办法发出去：不要按回车，不要点别的按钮，也不要用脚本。";

const TEXT: Record<Exclude<Outcome, "send">, string> = {
  decline: `用户选了「不发」：没有点「发送」，草稿还留在页面上。不要再点这个按钮。${NO_OTHER_WAY}在回复里告诉用户没有发送。`,
  stopped: `用户停下了任务或接管了页面：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}`,
  left: `用户离开或关掉了这个网页：没有点「发送」。${NO_OTHER_WAY}在回复里告诉用户没有发送。`,
  timeout: `用户 2 分钟内没有确认：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}在回复里告诉用户还没发送，等用户自己决定。`,
};

const REPEAT_TEXT = `用户这一轮已经选了「不发」：这次没有再问，也没有点「发送」，草稿还留在页面上。不要再点这个按钮。${NO_OTHER_WAY}在回复里告诉用户没有发送；用户再说要发时才会重新问。`;

const BUSY_TEXT = `这个网页上已经有一个「发送」在等用户确认：这次没有点，也没有再出确认框。等那个确认有了结果再说。${NO_OTHER_WAY}`;


/** 没执行的结果：带 heldReason 时，宿主不把「用户没让发」（不发、停、离开、超时）当成工具出错去连续计数，也不进「换个办法试」；侧栏按它写给用户看的那句话。 */
function notSent(message: string, heldReason?: HeldReason): Error {
  return Object.assign(new Error(message), { executionFact: "not_executed" as const }, heldReason ? { heldReason } : {});
}

const declined = new Set<string>();

/** 正在等确认的标签页：同一页同时只问一个，第二个确认框会盖掉第一个，用户点了也回不到第一个等待。 */
const pendingTabs = new Set<number>();

const waitingPorts = new Map<string, { tabId: number; take: (port: chrome.runtime.Port) => void }>();

chrome.runtime.onConnect.addListener(port => {
  if (!port.name.startsWith(PORT_PREFIX)) return;
  const waiting = waitingPorts.get(port.name);

  // 只认这次确认框所在标签页的顶层文档。
  if (!waiting || port.sender?.id !== chrome.runtime.id || port.sender.tab?.id !== waiting.tabId || port.sender.frameId !== 0) { port.disconnect(); return; }
  waitingPorts.delete(port.name);
  waiting.take(port);
});

/** 正在等的确认（按这次等待的 id）：侧栏的回答交给同一个等待。 */
const panelAnswers = new Map<string, (choice: "send" | "decline") => void>();

const panelPorts = new Set<chrome.runtime.Port>();

/** 用户确认过、还没点下去的那次发送（按这次调用的 guard）：点完再补报真实结果。 */
const confirmedViews = new WeakMap<SendGuard, SendConfirmView>();

/**
 * 包住一次 click：用户确认过发送时，点完再告诉侧栏真的点下去没有，卡上的「已发送」只在点下去以后写。
 * 结果是「没执行」时没点到；其余出错不知道点下去没有。
 */
export async function reportSendClick<T extends { sendConfirmed?: true }>(guard: SendGuard, run: Promise<T>): Promise<T> {
  const report = (clicked: NonNullable<SendConfirmView["clicked"]>) => {
    const view = confirmedViews.get(guard);

    if (!view) return;
    confirmedViews.delete(guard);
    guard.waiting(false, undefined, { ...view, clicked });
  };

  try {
    const result = await run;
    report(result?.sendConfirmed ? "yes" : "unknown");

    return result;
  } catch (error) {
    report((error as { executionFact?: unknown })?.executionFact === "not_executed" ? "no" : "unknown");
    throw error;
  }
}

/** 侧栏据此决定确认卡上有没有按钮：重开侧栏、回放历史时，只有还在等的那张能点。 */
function publishPending(): void {
  const pending = [...panelAnswers.keys()];

  for (const port of panelPorts) port.postMessage({ pending });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== SEND_CONFIRM_PANEL_PORT) return;

  // 只认扩展自己的侧栏页：网页和内容脚本的 sender.url 是网页地址。
  if (port.sender?.id !== chrome.runtime.id || !isPanelUrl(port.sender.url)) { port.disconnect(); return; }
  panelPorts.add(port);
  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    // 侧栏都关了：等于「先不发」。
    if (panelPorts.size === 0) for (const answer of [...panelAnswers.values()]) answer("decline");
  });
  // 侧栏只回 id 和选择；按钮是否真由用户点击，由侧栏判（isTrusted），这里只认还在等的 id。
  port.onMessage.addListener((message: { id?: unknown; choice?: unknown }) => {
    if (typeof message?.id !== "string" || (message.choice !== "send" && message.choice !== "decline")) return;
    panelAnswers.get(message.id)?.(message.choice);
  });
  port.postMessage({ pending: [...panelAnswers.keys()] });
});

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).host : ""; } catch { return ""; }
}

/** 在页面 ISOLATED world 里画确认框；序列化进页面，必须自包含。 */
/** 确认框上写的网站、按钮名、内容都由程序从网页读出（R2），不用助手的话；页面文字只用 textContent 放进去。 */
function showSendConfirm(attr: string, kind: string, portName: string, label: string, content: string | null, armMs: number, sentence: string, rect: { left: number; top: number; width: number; height: number } | null): void {
  document.querySelectorAll(`[${attr}="${kind}"]`).forEach(node => node.remove());
  // 同时在网页上圈出要点的那个按钮。
  const ring = document.createElement("div");
  ring.setAttribute(attr, kind);
  if (rect) ring.style.cssText = `all:initial;position:fixed;z-index:2147483646;pointer-events:none;left:${rect.left - 4}px;top:${rect.top - 4}px;width:${rect.width + 8}px;height:${rect.height + 8}px;border:3px solid #ff9f0a;border-radius:10px;box-shadow:0 0 0 4px rgba(255,159,10,.25)`;
  const host = document.createElement("div");
  host.setAttribute(attr, kind);
  host.style.cssText = "all:initial;display:block;position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%)";
  const root = host.attachShadow({ mode: "closed" });
  root.innerHTML = `<style>
.cap{display:flex;flex-direction:column;gap:6px;max-width:min(420px,calc(100vw - 32px));padding:10px 8px 8px 16px;border-radius:20px;background:rgba(20,20,19,.92);color:#fff;font:14px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28)}
.row{display:flex;align-items:center;gap:10px}
.ask{flex:1}
.site{padding-right:8px;font-size:12px;color:rgba(255,255,255,.62);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.what{padding-right:8px;font-size:13px;color:rgba(255,255,255,.88);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
button{all:unset;box-sizing:border-box;padding:6px 14px;border-radius:99px;background:rgba(255,255,255,.14);color:#fff;font-weight:600;cursor:pointer}
button:hover{background:rgba(255,255,255,.22)}
button.yes{background:#fff;color:#141413;opacity:.6;transition:opacity .2s}
button.yes.armed{opacity:1}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
</style><div class="cap" role="alertdialog" aria-label="发送确认" aria-describedby="site what"><div class="site" id="site"></div><div class="row"><span class="ask"></span><button class="no" type="button">先不发</button><button class="yes" type="button" tabindex="-1">发送</button></div></div>`;
  root.querySelector(".ask")!.textContent = sentence;
  root.querySelector(".site")!.textContent = `${location.host} · 「${label.trim()}」`;

  // 读不到要发的内容就不写这一行，不编。
  if (content) {
    const what = document.createElement("div");
    what.className = "what";
    what.id = "what";
    what.textContent = `「${content}」`;
    root.querySelector(".site")!.after(what);
  }
  const port = chrome.runtime.connect({ name: portName });
  const close = () => { host.remove(); ring.remove(); window.removeEventListener("keydown", onKey, true); };
  // Esc 等于「先不发」。
  const onKey = (event: KeyboardEvent) => { if (event.isTrusted && event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); port.postMessage({ choice: "decline" }); } };
  window.addEventListener("keydown", onKey, true);
  port.onDisconnect.addListener(close);

  // 「发送」只认真实的鼠标点击：不进 Tab 顺序，键盘触发（detail 为 0）不算，防止按键把它按下去；刚出现的那一会儿也不算。
  let armedAt = Infinity;
  const answer = (choice: "send" | "decline") => (event: MouseEvent) => {
    if (!event.isTrusted || (choice === "send" && (event.detail === 0 || performance.now() < armedAt))) return;
    close();
    port.postMessage({ choice });
  };

  root.querySelector<HTMLButtonElement>(".no")!.addEventListener("click", answer("decline"));
  root.querySelector<HTMLButtonElement>(".yes")!.addEventListener("click", answer("send"));
  (document.body ?? document.documentElement).appendChild(host);
  if (rect) (document.body ?? document.documentElement).appendChild(ring);
  armedAt = performance.now() + armMs;
  setTimeout(() => root.querySelector(".yes")?.classList.add("armed"), armMs);
}

/**
 * 按钮名以「发送 / Send」开头时，先在网页上问用户；用户点「发送」才返回 true，其余结局都抛「没执行」。
 * 名字不是发送的按钮直接返回 false，不多等一步。
 */
export async function confirmSendIfNeeded(tabId: number, label: string, guard: SendGuard | undefined, readContent: () => Promise<string | SendDetails | undefined>): Promise<boolean> {
  if (!guard || !isSendLabel(label)) return false;

  return confirmSend(tabId, label, guard, readContent);
}

/** 脚本、回车、网络请求这些路径：调用方已经认定是在发东西，不再看按钮名，直接问同一个确认。 */
export async function confirmSend(tabId: number, label: string, guard: SendGuard, readContent: () => Promise<string | SendDetails | undefined>): Promise<boolean> {

  const key = guard.task === undefined ? null : `${guard.task}\u0000${tabId}\u0000${label.trim()}`;

  if (key && declined.has(key)) throw notSent(REPEAT_TEXT, "repeat");

  if (pendingTabs.has(tabId)) throw notSent(BUSY_TEXT, "busy");
  pendingTabs.add(tabId);

  try {
    // 助手平时在后台标签里做事；要用户在网页上回答时，先把这页切到其窗口内前台（不抢别的窗口）。
    await bringForwardForUser(tabId, "send_confirm");

    const read = await readContent().catch(() => undefined);

    return await askUser(tabId, guard, key, label, typeof read === "string" ? { content: read } : read ?? {});
  } finally { pendingTabs.delete(tabId); }
}

async function askUser(tabId: number, guard: SendGuard, key: string | null, label: string, details: SendDetails): Promise<boolean> {
  const { content, recipient, rect, route } = details;
  let host = "";
  try { host = hostOf((await chrome.tabs.get(tabId)).url); } catch { /* 读不到网址 */ }
  const portName = `${PORT_PREFIX}${crypto.randomUUID()}`;
  const connected = new Promise<chrome.runtime.Port>(take => waitingPorts.set(portName, { tabId, take }));
  let port: chrome.runtime.Port | null = null;

  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: showSendConfirm, args: [OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM, portName, label, content ?? null, SEND_ARM_MS, sendSentence(host, label, content, recipient), rect ?? null] });
    port = await Promise.race([connected, new Promise<null>(done => setTimeout(() => done(null), SHOW_MS))]);
  } catch { /* 页面不让注入：下面按没显示出来处理 */ }

  waitingPorts.delete(portName);

  if (!port) throw notSent("确认框没能显示在网页上，所以没有点「发送」。");
  const shown = port;
  const view: SendConfirmView = { id: crypto.randomUUID(), host: hostOf(shown.sender?.url), label: label.trim(), ...(content ? { content } : {}), ...(recipient ? { recipient } : {}), ...(route ? { route } : {}) };
  const cleanups: Array<() => void> = [];

  const outcome = await new Promise<Outcome>(done => {
    panelAnswers.set(view.id, done);
    publishPending();
    guard.waiting(true, undefined, view);
    shown.onMessage.addListener((message: { choice?: unknown }) => {
      if (message?.choice === "send" || message?.choice === "decline") done(message.choice);
    });
    shown.onDisconnect.addListener(() => done("left"));
    const removed = (closed: number) => { if (closed === tabId) done("left"); };
    // 网页自己改网址（pushState、#）不换文档，确认框还在；只有顶层文档换了才算离开。
    const updated = (changed: number, info: { url?: string; status?: string }) => {
      if (changed !== tabId || (info.url === undefined && info.status !== "loading")) return;
      void readCurrentDocument(tabId).then(now => { if (now && now.documentId !== shown.sender?.documentId) done("left"); });
    };
    chrome.tabs.onRemoved.addListener(removed);
    chrome.tabs.onUpdated.addListener(updated);
    const poll = setInterval(() => { if (guard.cancelled()) done("stopped"); }, POLL_MS);
    const timer = setTimeout(() => done("timeout"), SEND_CONFIRM_MS);
    cleanups.push(() => { chrome.tabs.onRemoved.removeListener(removed); chrome.tabs.onUpdated.removeListener(updated); clearInterval(poll); clearTimeout(timer); });
  });

  for (const cleanup of cleanups) cleanup();
  panelAnswers.delete(view.id);
  publishPending();
  shown.disconnect();
  const final: Outcome = outcome === "send" && guard.cancelled() ? "stopped" : outcome;
  // 草稿只随开始等的那条事件存一次；结局这条不再带。
  const { content: _draft, ...withoutDraft } = view;
  guard.waiting(false, undefined, { ...withoutDraft, outcome: final });

  if (final === "send") confirmedViews.set(guard, withoutDraft);

  if (outcome === "send" && final === "stopped") throw notSent(TEXT.stopped, "stopped");

  if (outcome === "send") return true;

  // 只记明确的「不发」；停、离开、超时不记，用户回来再让发时照常问。
  if (outcome === "decline" && key) {
    if (declined.size >= 200) declined.delete(declined.values().next().value!);
    declined.add(key);
  }

  throw notSent(TEXT[outcome], outcome === "decline" ? "declined" : outcome);
}
