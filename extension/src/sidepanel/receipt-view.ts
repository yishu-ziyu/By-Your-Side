import type { TaskReceipt } from '../../../shared/task-actions.js';
import { D_LAYOUT, D_STATE, E_ENTER } from "../shared/motion-tokens.js";
import { receiptCopy } from './receipt-copy.js';

export function renderReceipt(receipt: TaskReceipt, conversationId: string, previous: HTMLElement | undefined, fork: (receipt: TaskReceipt) => Promise<void>): HTMLElement {
  if (previous?.classList.contains('receipt-decision') && receipt.newConversationRequest && receipt.status === 'rejected') return previous;
  const copy = receiptCopy(receipt, conversationId);
  const root = document.createElement('details');
  root.className = `msg receipt${copy.inProcess ? ' receipt-history' : copy.collapsed ? '' : ' notice'}`;

  if (copy.inProcess && receipt.runId) root.dataset.processRunId = receipt.runId;
  root.open = previous instanceof HTMLDetailsElement && previous.open;
  root.dataset.requestId = receipt.requestId;
  root.dataset.runId = receipt.runId ?? '';
  const summary = document.createElement('summary');
  summary.textContent = copy.summary;
  const detail = document.createElement('p');
  detail.textContent = copy.detail;
  root.append(summary, detail);

  if (previous?.classList.contains("needs-model-card") && receipt.needsModel) return previous;
  if (receipt.needsModel) return needsModelCard(receipt.text.trim() !== "");

  if (!receipt.newConversationRequest || receipt.status !== 'rejected') return root;
  summary.textContent = '查看原请求';
  root.className = 'msg receipt';
  const decision = document.createElement('section');
  decision.className = 'receipt-decision';
  decision.dataset.requestId = receipt.requestId;
  const title = document.createElement('strong');
  title.textContent = '这个新请求要另开会话吗？';
  const description = document.createElement('p');
  description.textContent = '当前任务会继续运行。';
  const actions = document.createElement('div');
  const create = document.createElement('button');
  create.type = 'button'; create.textContent = '另开会话';
  const dismiss = document.createElement('button');
  dismiss.type = 'button'; dismiss.textContent = '暂不处理';
  const status = document.createElement('p'); status.setAttribute('role','status');
  create.onclick = async () => {
    create.disabled = true; dismiss.disabled = true; status.textContent = '正在转交新会话…';

    try { await fork(receipt); status.textContent = '已转交新会话'; }
    catch (error) { status.textContent = error instanceof Error ? error.message : '未能转交，原任务不变。'; create.disabled = false; dismiss.disabled = false; }
  };

  dismiss.onclick = () => { actions.hidden = true; title.textContent = '新请求暂不处理'; description.textContent = '原请求保留在下方记录中。'; };

  actions.append(create,dismiss); decision.append(title,description,actions,status,root);

  return decision;
}

const CONNECT_MORPH_MS = D_STATE;
const CONNECT_FLIP_MS = D_LAYOUT;

const reduceMotion = () => globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

function needsModelCard(resends: boolean): HTMLElement {
  const card = document.createElement("section");
  card.className = "msg receipt-decision needs-model-card";
  card.dataset.f01 = "card";
  const old = document.createElement("div");
  old.className = "needs-model-old";
  const title = document.createElement("strong");
  title.textContent = "还没有连接模型";
  const description = document.createElement("p");
  description.textContent = resends ? "连接好之后，您的提问会自动发出。" : "连接好之后，请把刚才的提问再发一次。";
  const held = document.createElement("aside");
  held.className = "held-slot";
  const actions = document.createElement("div");
  const connect = document.createElement("button");
  connect.type = "button";
  connect.className = "needs-model-connect";
  connect.textContent = "连接模型";
  connect.onclick = () => void chrome.runtime.openOptionsPage();
  actions.append(connect);
  old.append(title, description, held, actions);
  const next = document.createElement("div");
  next.className = "needs-model-new";
  next.setAttribute("aria-hidden", "true");
  next.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.6 8.3l2.2 2.2 4.6-4.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="needs-model-label">已连上</span>`;
  card.append(old, next);

  return card;
}

export function noteNeedsModelManual(card: HTMLElement): void {
  const description = card.querySelector(".needs-model-old p") ?? card.querySelector("p");

  if (description) description.textContent = "连接好之后，请把刚才的提问再发一次。";
}

export function dropPendingMessage(card: HTMLElement, bubble: HTMLElement | null): void {
  if (bubble?.classList.contains("held-pending")) releaseHeld(bubble, card);
  card.classList.remove("needs-model-connected");
  card.dataset.f01 = "card";
  card.querySelector(".needs-model-new")?.setAttribute("aria-hidden", "true");
  card.classList.add("needs-model-dropped");
  const title = card.querySelector(".needs-model-old strong");
  const description = card.querySelector(".needs-model-old p");

  if (title) title.textContent = "这句没有发出";
  if (description) description.textContent = "连接好之后只会自动发出最后一次提问。这条需要的话，请再发一次。";
}

export function holdPendingMessage(card: HTMLElement, bubble: HTMLElement | null): void {
  if (!bubble || !card.isConnected || bubble.classList.contains("held-pending")) return;
  const slot = card.querySelector(".held-slot");

  if (!slot) return;
  bubble.classList.add("held-pending");
  bubble.dataset.f01 = "held";
  slot.append(bubble);
}

function invert(first: DOMRect, last: DOMRect): string {
  const sx = last.width ? first.width / last.width : 1;
  const sy = last.height ? first.height / last.height : 1;

  return `translate(${first.left - last.left}px, ${first.top - last.top}px) scale(${sx}, ${sy})`;
}

async function playTransform(el: HTMLElement, from: string, ms: number): Promise<void> {
  if (reduceMotion() || ms <= 0) {
    el.style.transform = "";

    return;
  }

  const anim = el.animate(
    [{ transform: from }, { transform: "translate(0, 0) scale(1, 1)" }],
    { duration: ms, easing: E_ENTER, fill: "forwards" },
  );

  try { await anim.finished; } catch {  }
  anim.cancel();
  el.style.transform = "";
}

function markSpan(name: string, startMark: string, run: () => Promise<void>): Promise<void> {
  performance.clearMarks(startMark);
  performance.clearMeasures(name);
  performance.mark(startMark);

  return run().finally(() => {
    try {
      performance.mark(`${name}-end`);
      performance.measure(name, startMark, `${name}-end`);
    } catch {  }
  });
}

function paintConnected(card: HTMLElement, model: string | null): void {
  const label = card.querySelector(".needs-model-label");

  if (label) label.textContent = model ? `已连上 ${model}` : "已连上";
  card.classList.add("needs-model-connected");
  card.dataset.f01 = "pill";
  card.querySelector(".needs-model-new")?.removeAttribute("aria-hidden");
}

function releaseHeld(bubble: HTMLElement, card: HTMLElement): void {
  bubble.classList.remove("held-pending");
  delete bubble.dataset.f01;
  bubble.style.transform = "";
  card.after(bubble);
}

export async function playConnectArrival(card: HTMLElement, model: string | null, bubble: HTMLElement | null): Promise<void> {
  if (!card.isConnected) return;

  if (card.classList.contains("needs-model-connected")) {
    if (bubble?.classList.contains("held-pending")) releaseHeld(bubble, card);

    return;
  }

  const held = bubble?.classList.contains("held-pending") ? bubble : null;
  const skip = reduceMotion();

  if (skip) {
    paintConnected(card, model);
    if (held) releaseHeld(held, card);

    return;
  }

  const cardFirst = card.getBoundingClientRect();
  const heldFirst = held?.getBoundingClientRect();

  if (held) {
    card.after(held);
    const now = held.getBoundingClientRect();
    held.style.transformOrigin = "0 0";
    held.style.transform = `translate(${heldFirst!.left - now.left}px, ${heldFirst!.top - now.top}px)`;
  }

  paintConnected(card, model);
  const cardLast = card.getBoundingClientRect();
  card.style.transformOrigin = "0 0";
  await markSpan("f01-morph", "f01-morph-start", () => playTransform(card, invert(cardFirst, cardLast), CONNECT_MORPH_MS));

  if (!held?.isConnected) return;
  const first = held.getBoundingClientRect();
  releaseHeld(held, card);
  const last = held.getBoundingClientRect();
  held.style.transformOrigin = "0 0";
  held.style.transform = invert(first, last);
  await markSpan("f01-flip", "f01-flip-start", () => playTransform(held, invert(first, last), CONNECT_FLIP_MS));
}
