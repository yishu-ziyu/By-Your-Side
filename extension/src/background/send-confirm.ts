/**
 * 点「发送」前停下，在网页上问用户（docs/evals/20261009-send-confirm.md R1）。
 * 发出去的消息收不回来，所以只有用户在网页上点「发送」才放行；「不发」、停、接管、离开网页、2 分钟没理都不点。
 * 确认框画在网页的 closed shadow 里，带 overlay 标记：助手的点击落在上面会被 assertNotOwnOverlay 拒绝。
 */
import { OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM } from "../shared/overlay.js";
import { isSendLabel } from "../shared/mark-actions.js";
import { readCurrentDocument } from "./exec/page-readiness.js";
import { bringForwardForUser } from "./foreground.js";
import type { HeldReason } from "../../../shared/protocol.js";

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
  /** 告诉宿主这次调用正在等用户（放宽期限）或已经不等了（恢复普通期限）。 */
  waiting(on: boolean): void;
}

type Outcome = "send" | "decline" | "stopped" | "left" | "timeout";

/** 每种「用户没让发」都带这句：别让助手改按回车或点别的按钮把它发出去。 */
const NO_OTHER_WAY = "不要换别的办法发出去：不要按回车，也不要点别的按钮。";

const TEXT: Record<Exclude<Outcome, "send">, string> = {
  decline: `用户在网页上选了「不发」：没有点「发送」，草稿还留在页面上。不要再点这个按钮。${NO_OTHER_WAY}在回复里告诉用户没有发送。`,
  stopped: `用户停下了任务或接管了页面：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}`,
  left: `用户离开或关掉了这个网页：没有点「发送」。${NO_OTHER_WAY}在回复里告诉用户没有发送。`,
  timeout: `用户 2 分钟内没有在网页上确认：没有点「发送」，草稿还留在页面上。${NO_OTHER_WAY}在回复里告诉用户还没发送，等用户自己决定。`,
};

const REPEAT_TEXT = `用户这一轮已经在网页上选了「不发」：这次没有再问，也没有点「发送」，草稿还留在页面上。不要再点这个按钮。${NO_OTHER_WAY}在回复里告诉用户没有发送；用户再说要发时才会重新问。`;

const BUSY_TEXT = `这个网页上已经有一个「发送」在等用户确认：这次没有点，也没有再出确认框。等那个确认有了结果再说。${NO_OTHER_WAY}`;

const PROGRAM_TEXT = "网页脚本程序里不能点「发送」：发送前要等用户在网页上确认，程序等不了，所以这次没有点。请改用单独的 click 工具点这个按钮。";

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

/** 在页面 ISOLATED world 里画确认框；序列化进页面，必须自包含。 */
/** 确认框上写的网站、按钮名、内容都由程序从网页读出（R2），不用助手的话；页面文字只用 textContent 放进去。 */
function showSendConfirm(attr: string, kind: string, portName: string, label: string, content: string | null): void {
  document.querySelectorAll(`[${attr}="${kind}"]`).forEach(node => node.remove());
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
button.yes{background:#fff;color:#141413}
button:focus-visible{outline:2px solid #0a84ff;outline-offset:2px}
</style><div class="cap" role="alertdialog" aria-label="要发送吗？" aria-describedby="site what"><div class="site" id="site"></div><div class="row"><span class="ask">要发送吗？</span><button class="no" type="button">不发</button><button class="yes" type="button" tabindex="-1">发送</button></div></div>`;
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
  const close = () => host.remove();
  port.onDisconnect.addListener(close);

  // 「发送」只认真实的鼠标点击：不进 Tab 顺序，键盘触发（detail 为 0）不算，防止按键把它按下去。
  const answer = (choice: "send" | "decline") => (event: MouseEvent) => {
    if (!event.isTrusted || (choice === "send" && event.detail === 0)) return;
    close();
    port.postMessage({ choice });
  };

  root.querySelector<HTMLButtonElement>(".no")!.addEventListener("click", answer("decline"));
  root.querySelector<HTMLButtonElement>(".yes")!.addEventListener("click", answer("send"));
  (document.body ?? document.documentElement).appendChild(host);
}

/**
 * 按钮名以「发送 / Send」开头时，先在网页上问用户；用户点「发送」才返回 true，其余结局都抛「没执行」。
 * 名字不是发送的按钮直接返回 false，不多等一步。
 */
export async function confirmSendIfNeeded(tabId: number, label: string, guard: SendGuard | undefined, readContent: () => Promise<string | undefined>): Promise<boolean> {
  if (!guard || !isSendLabel(label)) return false;

  if (guard.inProgram) throw notSent(PROGRAM_TEXT);
  const key = guard.task === undefined ? null : `${guard.task}\u0000${tabId}\u0000${label.trim()}`;

  if (key && declined.has(key)) throw notSent(REPEAT_TEXT, "repeat");

  if (pendingTabs.has(tabId)) throw notSent(BUSY_TEXT, "busy");
  pendingTabs.add(tabId);

  try {
    // 助手平时在后台标签里做事；要用户在网页上回答时，先把这页切到其窗口内前台（不抢别的窗口）。
    await bringForwardForUser(tabId, "send_confirm");

    return await askUser(tabId, guard, key, label, await readContent());
  } finally { pendingTabs.delete(tabId); }
}

async function askUser(tabId: number, guard: SendGuard, key: string | null, label: string, content: string | undefined): Promise<boolean> {
  const portName = `${PORT_PREFIX}${crypto.randomUUID()}`;
  const connected = new Promise<chrome.runtime.Port>(take => waitingPorts.set(portName, { tabId, take }));
  let port: chrome.runtime.Port | null = null;

  try {
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: "ISOLATED", func: showSendConfirm, args: [OVERLAY_ATTR, OVERLAY_KIND_SEND_CONFIRM, portName, label, content ?? null] });
    port = await Promise.race([connected, new Promise<null>(done => setTimeout(() => done(null), SHOW_MS))]);
  } catch { /* 页面不让注入：下面按没显示出来处理 */ }

  waitingPorts.delete(portName);

  if (!port) throw notSent("确认框没能显示在网页上，所以没有点「发送」。");
  const shown = port;
  guard.waiting(true);
  const cleanups: Array<() => void> = [];

  const outcome = await new Promise<Outcome>(done => {
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
  shown.disconnect();
  guard.waiting(false);

  if (outcome === "send" && guard.cancelled()) throw notSent(TEXT.stopped, "stopped");

  if (outcome === "send") return true;

  // 只记明确的「不发」；停、离开、超时不记，用户回来再让发时照常问。
  if (outcome === "decline" && key) {
    if (declined.size >= 200) declined.delete(declined.values().next().value!);
    declined.add(key);
  }

  throw notSent(TEXT[outcome], outcome === "decline" ? "declined" : outcome);
}
