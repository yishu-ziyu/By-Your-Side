/**
 * 侧栏里的发送确认卡（docs/evals/20261015-panel-send-confirm.md）。网页上的确认框照旧在，两边回答的是后台同一个等待。
 * 卡上的网站、按钮名、内容都由扩展从网页读出，这里只用 textContent 放进去。
 * 按钮只在后台说这次确认还在等时出现：重开侧栏回放历史时，答过或过期的确认只剩一行结果。
 */
import { SEND_ARM_MS, SEND_CONFIRM_PANEL_PORT } from "../relay.js";
import { HELD_TEXT } from "./steps.js";
import type { SendConfirmOutcome, SendConfirmView } from "../../../shared/protocol.js";

const OUTCOMES: readonly SendConfirmOutcome[] = ["send", "decline", "stopped", "left", "timeout"];

const CLICKS: readonly unknown[] = ["yes", "no", "unknown"];

/** 「已发送」只在按钮真的点下去以后写；确认了、点击结果还没到时只写确认了。 */
const SENT_TEXT: Record<NonNullable<SendConfirmView["clicked"]>, string> = {
  yes: "你确认过，已发送",
  no: "你确认了，但没点到发送键，草稿还在",
  unknown: "你确认了发送，没能确认发出去没有，请看一眼网页",
};

const OUTCOME_TEXT: Record<Exclude<SendConfirmOutcome, "send">, string> = {
  decline: HELD_TEXT.declined,
  stopped: HELD_TEXT.stopped,
  left: HELD_TEXT.left,
  timeout: HELD_TEXT.timeout,
};

/** 历史和事件都是外部数据：形状不对就不画卡。 */
function isSendConfirmView(v: unknown): v is SendConfirmView {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;

  return typeof o.id === "string" && o.id.length > 0 && o.id.length <= 64 && typeof o.host === "string" && typeof o.label === "string"
    && (o.content === undefined || typeof o.content === "string") && (o.outcome === undefined || (OUTCOMES as readonly unknown[]).includes(o.outcome))
    && (o.clicked === undefined || CLICKS.includes(o.clicked))
    && (o.recipient === undefined || typeof o.recipient === "string") && (o.route === undefined || ["click", "script", "enter", "request"].includes(o.route as string));
}

/** armedAt：按钮第一次露出来以后多久起「发送」才算数（performance.now 的时刻）；重画不重新计时。 */
interface Card { view: SendConfirmView; el: HTMLElement; answering: boolean; armedAt?: number }

const cards = new Map<string, Card>();

/** 后台说还在等的确认 id；端口没连上时为空，卡上不出按钮。 */
let pending = new Set<string>();

/** 后台已经不等、过了一会儿结局还没到的确认：只剩一行，也不再为它连端口（后台重启时等待丢了，结局永远不会来）。 */
const ended = new Set<string>();

let port: chrome.runtime.Port | null = null;

/** 这条端口上收到过后台状态没有；收到过的 id 里哪些被报过还在等。用来分清「后台不等了」和「后台的状态还没到」。 */
let synced = false;

const seen = new Set<string>();

const unresolved = () => [...cards.values()].some(card => !card.view.outcome && !ended.has(card.view.id) && card.el.isConnected);

/** 只在有没结局的卡时连后台，免得空着的端口一直把后台唤醒。 */
function ensurePort(): void {
  if (port || !unresolved()) return;

  try { port = chrome.runtime.connect({ name: SEND_CONFIRM_PANEL_PORT }); } catch { return; }
  port.onMessage.addListener((message: { pending?: unknown }) => {
    if (!Array.isArray(message?.pending)) return;
    pending = new Set(message.pending.filter((id): id is string => typeof id === "string"));

    for (const id of pending) seen.add(id);

    // 后台先记下等待、再发事件：连上时报的状态里没有的卡，后台已经不等了；之后只认报过又消失的。
    for (const card of cards.values()) if (!card.view.outcome && !pending.has(card.view.id) && (!synced || seen.has(card.view.id))) endLater(card);
    synced = true;
    refreshAll();
  });
  port.onDisconnect.addListener(() => {
    port = null;
    synced = false;
    seen.clear();
    pending = new Set();
    refreshAll();
    setTimeout(ensurePort, 1000);
  });
}

const ENDED_GRACE_MS = 1500;

/** 后台不等了，结局事件绕经宿主、通常紧跟着到：过一会儿还没到，才收成「已经结束」，免得先闪一下这行再变成真结局。 */
function endLater(card: Card): void {
  setTimeout(() => {
    if (card.view.outcome || pending.has(card.view.id) || ended.has(card.view.id)) return;
    ended.add(card.view.id);
    paint(card);
  }, ENDED_GRACE_MS);
}

function refreshAll(): void {
  for (const card of cards.values()) if (card.el.isConnected) paint(card);
}

function row(list: HTMLElement, name: string, value: string): void {
  const dt = document.createElement("dt");
  dt.textContent = name;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function paint(card: Card): void {
  const { view, el } = card;
  el.replaceChildren();
  el.dataset.sendConfirm = view.id;

  if (view.outcome) {
    el.dataset.state = "done";
    const line = document.createElement("p");
    line.className = "send-confirm-line";
    line.textContent = view.outcome === "send" ? view.clicked ? SENT_TEXT[view.clicked] : "你确认了发送" : OUTCOME_TEXT[view.outcome];
    el.append(line);

    return;
  }

  // 后台已经不等、又没有结局（例如扩展后台重启，等待丢了）：只剩一行，不留按钮。
  if (ended.has(view.id)) {
    el.dataset.state = "ended";
    const line = document.createElement("p");
    line.className = "send-confirm-line";
    line.textContent = "这次确认已经结束";
    el.append(line);

    return;
  }

  const live = pending.has(view.id);
  el.dataset.state = live ? "open" : "checking";
  const title = document.createElement("p");
  title.className = "send-confirm-title";
  const to = view.recipient ? `发给 ${view.recipient}，` : "";
  title.textContent = view.content ? `把这段 ${[...view.content.replace(/…$/, "")].length} 字的内容${to}在 ${view.host} 上` : `点「${view.label}」${to}在 ${view.host} 上`;
  const list = document.createElement("dl");
  list.className = "send-confirm-kv";
  row(list, "网站", view.host);
  row(list, "按钮", `「${view.label}」`);

  // 读不到要发的内容就不写这一行，不编。
  if (view.content) row(list, "内容", `「${view.content}」`);
  if (view.recipient) row(list, "发给", view.recipient);
  if (view.route && view.route !== "click") row(list, "方式", { script: "页面脚本", enter: "回车键", request: "网页请求" }[view.route]);
  el.append(title, list);

  if (!live) return;
  card.armedAt ??= performance.now() + SEND_ARM_MS;
  const acts = document.createElement("div");
  acts.className = "send-confirm-acts";
  acts.append(button("decline", "先不发", card), button("send", "发送", card));
  el.append(acts);
}

function button(choice: "send" | "decline", text: string, card: Card): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = choice === "send" ? "send-confirm-yes" : "send-confirm-no";
  b.textContent = text;
  b.disabled = card.answering;

  // 和网页上的确认框一样：「发送」不进 Tab 顺序，只认真实的鼠标点击（键盘触发时 detail 为 0）；脚本合成的点击、刚露出来那一会儿的点击都不算。
  if (choice === "send") {
    b.tabIndex = -1;
    const wait = (card.armedAt ?? 0) - performance.now();

    if (wait > 0) setTimeout(() => b.toggleAttribute("data-armed", true), wait);
    else b.toggleAttribute("data-armed", true);
  }

  b.addEventListener("click", event => {
    if (!event.isTrusted || (choice === "send" && (event.detail === 0 || performance.now() < (card.armedAt ?? Infinity))) || card.answering || !port) return;
    card.answering = true;
    port.postMessage({ id: card.view.id, choice });
    paint(card);
  });

  return b;
}

/**
 * send_confirm_wait 事件带的确认内容：第一次见到这个 id 时返回新卡（调用方放进对话），之后只原地更新。
 * 不等了的事件带结局：卡收成一行结果，两个窗口的侧栏都一样。
 */
export function sendConfirmCard(raw: unknown): HTMLElement | null {
  if (!isSendConfirmView(raw)) return null;
  const known = cards.get(raw.id);

  if (known?.el.isConnected) {
    known.view = { ...known.view, ...raw };
    paint(known);

    return null;
  }

  const el = document.createElement("div");
  el.className = "send-confirm";
  el.setAttribute("role", "group");
  el.setAttribute("aria-label", "发送确认");
  const card: Card = { view: raw, el, answering: false };
  cards.set(raw.id, card);
  paint(card);

  // 端口早已连上、后台的状态里没有这个 id：多半是回放出来的旧确认。给后台一点时间报上来，还没有就收成一行。
  if (synced && !pending.has(raw.id)) endLater(card);

  // 回放历史是同步的一批：等这一批放完再看要不要连后台，答过的确认不必连。
  queueMicrotask(ensurePort);

  return el;
}
