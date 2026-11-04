import { createElement as icon, Send } from "lucide";
import { SEND_ARM_MS, SEND_CONFIRM_PANEL_PORT } from "../relay.js";
import { HELD_TEXT } from "./steps.js";
import { confirmCopy, confirmCountdown, confirmSecondsLeft } from "../../../shared/send-confirm-copy.js";
import type { SendConfirmOutcome, SendConfirmView } from "../../../shared/protocol.js";

const OUTCOMES: readonly SendConfirmOutcome[] = ["send", "decline", "stopped", "left", "timeout"];

const CLICKS: readonly unknown[] = ["yes", "no", "unknown", "changed", "unverified"];

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

interface Card { view: SendConfirmView; el: HTMLElement; answering: boolean; announced?: boolean; warned?: boolean; armedAt?: number; tick?: number }

const cards = new Map<string, Card>();

let pending = new Set<string>();

const ended = new Set<string>();

let port: chrome.runtime.Port | null = null;

let synced = false;

const seen = new Set<string>();

const unresolved = () => [...cards.values()].some(card => !card.view.outcome && !ended.has(card.view.id) && card.el.isConnected);

function ensurePort(): void {
  if (port || !unresolved()) return;

  try { port = chrome.runtime.connect({ name: SEND_CONFIRM_PANEL_PORT }); } catch { return; }
  port.onMessage.addListener((message: { pending?: unknown }) => {
    if (!Array.isArray(message?.pending)) return;
    pending = new Set(message.pending.filter((id): id is string => typeof id === "string"));

    for (const id of pending) seen.add(id);

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

function announce(text: string): void {
  const region = document.getElementById("confirm-announce");

  if (region) region.textContent = text;
}

function paint(card: Card): void {
  const { view, el } = card;

  if (view.outcome) {
    if (view.outcome === "timeout" && card.announced) announce(OUTCOME_TEXT.timeout);
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

    if (!card.announced) {
      card.announced = true;
      announce(`需要你确认：${copy.headline}`);
    }

    const tick = () => {
      const now = Date.now();
      wait.textContent = confirmCountdown(now, view.startedAt, view.expiresAt);
      const left = confirmSecondsLeft(now, view.startedAt, view.expiresAt);

      if (left > 0 && left <= 10 && !card.warned) {
        card.warned = true;
        announce("这次确认还剩 10 秒");
      }
    };
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

  if (synced && !pending.has(raw.id)) endLater(card);

  queueMicrotask(ensurePort);

  return el;
}
