import { isWriteTool } from "../../../shared/effect-policy.js";
import { isLeadSession } from "../../../shared/protocol.js";
import type { PanelHistoryItem, PanelHistoryServerMessage } from "../relay.js";

const RESUME_TEXT = "继续原任务";

const NAME_MAX = 14;

function chapterName(text: string): string {
  const plain = text.replace(/\s+/g, " ").trim().replace(/^(@\S+\s*)+/, "").trim();
  const chars = Array.from(plain);

  if (chars.length === 0) return "新任务";

  return chars.length > NAME_MAX ? `${chars.slice(0, NAME_MAX - 1).join("")}…` : plain;
}

export function mountChapters(messages: HTMLElement, frame: HTMLElement, onJump: () => void, replaying: () => boolean) {
  const row = document.createElement("nav");
  row.className = "chapter-row";
  row.setAttribute("aria-label", "章节");
  row.hidden = true;
  frame.before(row);
  let shown = "";
  let pending: { bubble: HTMLElement; text: string } | null = null;
  let errored = false;
  let ended = false;

  let drag: { pointer: number; x: number; scroll: number; moved: boolean } | null = null;
  let suppressClick = false;

  row.addEventListener("pointerdown", (event) => {
    suppressClick = false;
    if (event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    if (row.scrollWidth <= row.clientWidth) return;
    drag = { pointer: event.pointerId, x: event.clientX, scroll: row.scrollLeft, moved: false };
  });
  row.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    if (!(event.buttons & 1)) { endDrag(); return; }
    const delta = event.clientX - drag.x;
    if (!drag.moved && Math.abs(delta) < 8) return;
    if (!drag.moved) {
      drag.moved = true;
      suppressClick = true;
      row.setPointerCapture(event.pointerId);
      row.classList.add("dragging");
    }
    event.preventDefault();
    row.scrollLeft = drag.scroll - delta;
  });
  function endDrag() {
    const pointer = drag?.pointer;
    drag = null;
    row.classList.remove("dragging");
    if (pointer !== undefined && row.hasPointerCapture(pointer)) row.releasePointerCapture(pointer);
  }
  row.addEventListener("pointerup", endDrag);
  row.addEventListener("pointercancel", endDrag);
  row.addEventListener("lostpointercapture", endDrag);
  row.addEventListener("pointerleave", () => { if (!drag?.moved) endDrag(); });
  row.addEventListener("click", (event) => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  const syncFade = () => {
    const max = row.scrollWidth - row.clientWidth;
    row.dataset.overflow = String(max > 1);
    row.dataset.fadeStart = String(row.scrollLeft > 1);
    row.dataset.fadeEnd = String(max - row.scrollLeft > 1);
  };

  row.addEventListener("scroll", syncFade, { passive: true });
  new ResizeObserver(syncFade).observe(row);

  const dividers = () => [...messages.querySelectorAll<HTMLElement>(":scope > .chapter-divider")];

  const sync = () => {
    if (pending && !pending.bubble.isConnected) pending = null;
    const all = dividers();
    all.forEach((d, i) => { d.hidden = i === 0 && all.length < 2; });
    const key = all.map(d => `${d.dataset.chapter}\u0000${d.dataset.name}`).join("\u0001");

    if (key === shown) return;
    shown = key;
    row.hidden = all.length < 3;
    row.replaceChildren(...(row.hidden ? [] : all.map((d) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-jump";
      button.textContent = `${d.dataset.chapter} ${d.dataset.name}`;
      button.title = d.dataset.name ?? "";
      button.onclick = () => {
        onJump();
        const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
        d.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
      };

      return button;
    })));
    syncFade();
  };

  new MutationObserver(sync).observe(messages, { childList: true });

  const open = (bubble: HTMLElement, text: string) => {
    if (bubble.previousElementSibling?.matches(".chapter-divider")) return;
    const number = dividers().length + 1;
    const name = chapterName(text);
    const divider = document.createElement("div");
    divider.className = "chapter-divider";
    divider.setAttribute("role", "separator");
    divider.dataset.chapter = String(number);
    divider.dataset.name = name;

    if (!replaying()) divider.classList.add("fresh");
    const label = document.createElement("span");
    label.textContent = `${number} · ${name}`;
    divider.append(label);
    bubble.before(divider);
    sync();
  };

  return {
    noteUserTurn(bubble: HTMLElement, item: Extract<PanelHistoryItem, { kind: "user" }>, idle: boolean): void {
      if (!idle || item.undelivered || item.text.trim() === RESUME_TEXT) return;

      ended = false;

      if (dividers().length === 0) { pending = null; open(bubble, item.text); return; }
      pending = { bubble, text: item.text };
    },

    noteServer(msg: PanelHistoryServerMessage): void {
      if (msg.type !== "agent_event" || !isLeadSession(msg.sessionId)) return;
      const event = msg.event;

      if (event.kind === "agent_start") errored = false;
      else if (event.kind === "error") { errored = true; ended = false; }
      else if (event.kind === "agent_end") ended = !errored;
      else if (event.kind === "tool_start" && isWriteTool(event.name) && pending && !ended) {
        const { bubble, text } = pending;
        pending = null;

        if (bubble.isConnected) open(bubble, text);
      }
    },
  };
}
