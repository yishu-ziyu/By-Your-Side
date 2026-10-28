/**
 * 侧栏里的发送确认卡。网页上的确认框照旧在，两边回答的是后台同一个等待。
 * 卡上的网站、按钮名、内容都由扩展从网页读出，这里只用 textContent 放进去。
 * 待确认钉在输入框上方；答过或过期只在对话里留一行结果。
 */
import { createElement as icon, Send } from "lucide";
import { SEND_ARM_MS, SEND_CONFIRM_PANEL_PORT } from "../relay.js";
import { HELD_TEXT } from "./steps.js";
import { confirmCopy, confirmCountdown } from "../../../shared/send-confirm-copy.js";
import type { SendConfirmOutcome, SendConfirmView } from "../../../shared/protocol.js";

const OUTCOMES: readonly SendConfirmOutcome[] = ["send", "decline", "stopped", "left", "timeout"];

const CLICKS: readonly unknown[] = ["yes", "no", "unknown", "changed", "unverified"];

/** 「已发送」只在按钮真的点下去以后写；确认了、点击结果还没到时只写确认了。 */
const SENT_TEXT: Record<NonNullable<SendConfirmView["clicked"]>, string> = {
  yes: "你确认过，已发送",
  no: "你确认了，但没点到发送键，草稿还在",
  unknown: "你确认了发送，没能确认发出去没有，请看一眼网页",
  changed: "确认后内容、收件人或目标发生变化，未发送；请检查后重新确认",
  unverified: "无法核对发送内容，未发送；请检查网页",
};

const OUTCOME_TEXT: Record<Exclude<SendConfirmOutcome, "send">, string> = {
  decline: HELD_TEXT.declined,
  stopped: HELD_TEXT.stopped,
  left: HELD_TEXT.left,
  timeout: HELD_TEXT.timeout,
};

const OPTIONAL_STR = ["content", "recipient", "query", "path", "method", "body"] as const;
const OPTIONAL_NUM = ["startedAt", "expiresAt"] as const;
const KINDS = ["search", "send", "request"] as const;

/** 历史和事件都是外部数据：形状不对就不画卡。 */
function isSendConfirmView(v: unknown): v is SendConfirmView {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;

  return typeof o.id === "string" && o.id.length > 0 && o.id.length <= 64 && typeof o.host === "string" && typeof o.label === "string"
    && (o.outcome === undefined || (OUTCOMES as readonly unknown[]).includes(o.outcome))
    && (o.clicked === undefined || CLICKS.includes(o.clicked))
    && (o.route === undefined || ["click", "script", "enter", "request"].includes(o.route as string))
    && (o.kind === undefined || (KINDS as readonly unknown[]).includes(o.kind))
    && OPTIONAL_STR.every(key => o[key] === undefined || typeof o[key] === "string")
    && OPTIONAL_NUM.every(key => o[key] === undefined || (typeof o[key] === "number" && Number.isFinite(o[key])));
}

/** armedAt：按钮第一次露出来以后多久起「发送」才算数（performance.now 的时刻）；重画不重新计时。 */
interface Card { view: SendConfirmView; el: HTMLElement; answering: boolean; armedAt?: number; tick?: number }

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
    if (cards.get(card.view.id) !== card || !card.el.isConnected || card.view.outcome || pending.has(card.view.id) || ended.has(card.view.id)) return;
    ended.add(card.view.id);
    paint(card);
  }, ENDED_GRACE_MS);
}

function refreshAll(): void {
  for (const card of cards.values()) if (card.el.isConnected) paint(card);
}

/** 换会话时卸下旧卡；后台的等待不取消，切回来由历史回放恢复。 */
export function resetSendConfirmCards(): void {
  for (const card of cards.values()) stopTick(card);
  cards.clear();
  const shelf = dock();
  shelf?.replaceChildren();
  if (shelf) shelf.hidden = true;
}

function stopTick(card: Card): void {
  if (!card.tick) return;
  clearInterval(card.tick);
  card.tick = 0;
}

function dock(): HTMLElement | null {
  return document.getElementById("confirm-dock");
}

function place(card: Card, live: boolean): void {
  const shelf = dock();
  const { el } = card;

  if (live && shelf) {
    if (el.parentElement !== shelf) shelf.append(el);
    shelf.hidden = shelf.childElementCount === 0;
    return;
  }

  if (shelf?.contains(el)) {
    const messages = document.getElementById("messages");
    if (messages && el.parentElement !== messages) messages.append(el);
    shelf.hidden = shelf.childElementCount === 0;
  }
}

function resultLine(card: Card, text: string, state: string): void {
  const { el, view } = card;
  stopTick(card);
  el.replaceChildren();
  el.dataset.sendConfirm = view.id;
  el.dataset.state = state;
  const line = document.createElement("p");
  line.className = "send-confirm-line";
  line.textContent = text;
  el.append(line);
  place(card, false);
}

function paint(card: Card): void {
  const { view, el } = card;

  if (view.outcome) {
    resultLine(card, view.outcome === "send" ? view.clicked ? SENT_TEXT[view.clicked] : "你确认了发送" : OUTCOME_TEXT[view.outcome], "done");
    return;
  }

  if (ended.has(view.id)) {
    resultLine(card, "这次确认已经结束", "ended");
    return;
  }

  const live = pending.has(view.id);
  el.dataset.sendConfirm = view.id;
  el.dataset.state = live ? "open" : "checking";
  el.replaceChildren();
  const copy = confirmCopy(view);
  const title = document.createElement("h2");
  title.className = "send-confirm-title";
  if (copy.kind === "send") {
    title.append(icon(Send), document.createTextNode(view.recipient?.trim() || view.label.trim() || "发送"));
    const site = document.createElement("p");
    site.className = "send-confirm-site";
    site.textContent = view.host;
    el.append(title, site);
  } else {
    title.textContent = copy.headline;
    el.append(title);
  }

  if (copy.impact) {
    const impact = document.createElement("p");
    impact.className = "send-confirm-impact";
    impact.textContent = copy.impact;
    el.append(impact);
  }

  if (copy.quote) {
    const quote = document.createElement("blockquote");
    quote.className = "send-confirm-quote";
    quote.textContent = copy.quote;
    el.append(quote);
  }

  if (copy.tech) {
    const details = document.createElement("details");
    details.className = "send-confirm-tech";
    const summary = document.createElement("summary");
    summary.textContent = "技术细节";
    const pre = document.createElement("pre");
    pre.textContent = [copy.tech.method, copy.tech.path, copy.tech.body].filter(Boolean).join("\n");
    details.append(summary, pre);
    el.append(details);
  }

  if (live) {
    card.armedAt ??= performance.now() + SEND_ARM_MS;
    const wait = document.createElement("p");
    wait.className = "send-confirm-wait";
    wait.setAttribute("aria-live", "polite");
    const tick = () => { wait.textContent = confirmCountdown(Date.now(), view.startedAt, view.expiresAt); };
    tick();
    stopTick(card);
    card.tick = window.setInterval(tick, 1000);
    const acts = document.createElement("div");
    acts.className = "send-confirm-acts";
    acts.append(wait, button("decline", copy.no, card), button("send", copy.yes, card));
    el.append(acts);
  }

  place(card, live);
}

function button(choice: "send" | "decline", text: string, card: Card): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = choice === "send" ? "send-confirm-yes" : "send-confirm-no";
  b.textContent = text;
  b.disabled = card.answering;

  // 键盘确认必须明确聚焦按钮；输入框里的回车不能批准发送。
  if (choice === "send") {
    b.tabIndex = 0;
    const wait = (card.armedAt ?? 0) - performance.now();

    if (wait > 0) {
      b.toggleAttribute("data-arming", true);
      setTimeout(() => {
        b.toggleAttribute("data-arming", false);
        b.toggleAttribute("data-armed", true);
      }, wait);
    } else b.toggleAttribute("data-armed", true);
  }

  b.addEventListener("click", event => {
    if (!event.isTrusted || (choice === "send" && ((event.detail === 0 && document.activeElement !== b) || performance.now() < (card.armedAt ?? Infinity))) || card.answering || !port) return;
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
