/**
 * 侧栏怎么画回答里的卡片（解析和取数在 shared/answer-cards.ts，验收见 docs/evals/20261014-answer-cards.md）。
 * 流式时每次按已放出的前缀整体重画：写完的组件才画，写到一半的标签不露出来。
 * 按钮只做两件事：把按钮上的话当作用户的下一句发出，或切到某个标签页。不直接动页面。
 */
import { type Card, resolveProse, splitAnswer } from "../../../shared/answer-cards.js";
import { toast } from "./sonar-citations.js";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function cardHtml(card: Card): string {
  const blocks = card.blocks.map((b) => {
    switch (b.kind) {
      case "stats":
        return `<div class="gc-stats">${b.items.map((s) => `<div class="gc-stat${s.tag ? " best" : ""}"><div class="k"><span>${esc(s.label)}</span>${s.tag ? `<span class="tag">${esc(s.tag)}</span>` : ""}</div><div class="v">${esc(s.value)}</div><div class="n">${esc([s.note, s.formula].filter(Boolean).join(" · "))}</div></div>`).join("")}</div>`;
      case "steps":
        return `<ol class="gc-steps">${b.items.map((s, i) => `<li class="gc-step"><span class="num">${i + 1}</span><div><div class="t">${esc(s.title)}</div>${s.detail ? `<div class="d">${esc(s.detail)}</div>` : ""}</div></li>`).join("")}</ol>`;
      case "options":
        return `<div class="gc-options">${b.items.map((o) => `<div class="gc-option${o.pick ? " pick" : ""}"><div class="gc-row"><span class="name">${esc(o.name)}</span>${o.pick ? '<span class="badge">推荐</span>' : ""}${o.value ? `<span class="price">${esc(o.value)}</span>` : ""}${o.meta ? `<span class="meta">${esc(o.meta)}</span>` : ""}</div><div class="gc-why">${esc(o.why)}</div></div>`).join("")}</div>`;
      case "table":
        return `<table class="gc-table"><thead><tr>${b.cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${b.rows.map((r) => `<tr${r.tag ? ' class="best"' : ""}>${r.cells.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      case "checks":
        return `<ul class="gc-checks">${b.items.map((c) => `<li class="gc-check"><label><input type="checkbox"><span><span class="t">${esc(c.text)}</span>${c.note ? `<span class="d">${esc(c.note)}</span>` : ""}</span></label></li>`).join("")}</ul>`;
      case "callout":
        return `<div class="gc-callout ${b.tone}">${esc(b.text)}</div>`;
    }
  }).join("");
  // 按钮等卡片写完再出现，免得用户点到写了一半的那张。
  const buttons = card.closed ? card.buttons.map((b) => `<button type="button" class="gc-btn${b.primary ? " primary" : ""}" ${b.tab ? `data-card-tab="${esc(b.tab)}"` : `data-card-say="${esc(b.label)}"`}>${esc(b.label)}</button>`).join("") : "";

  return `<div class="gen-card">${card.title ? `<div class="gc-head"><div class="gc-title">${esc(card.title)}</div>${card.sub ? `<div class="gc-sub">${esc(card.sub)}</div>` : ""}</div>` : ""}${blocks ? `<div class="gc-body">${blocks}</div>` : ""}${buttons ? `<div class="gc-actions">${buttons}</div>` : ""}${card.source && card.closed ? `<div class="gc-foot">${esc(card.source)}</div>` : ""}</div>`;
}

/** 回答原文 → HTML。没有卡片时与原来的 Markdown 渲染一样；返回值仍需调用方消毒。 */
export function renderAnswerHtml(text: string, renderProse: (markdown: string) => string): string {
  const parts = splitAnswer(text);
  const cards = parts.flatMap((p) => ("card" in p && p.card ? [p.card] : []));
  const bold = (value: string) => `**${value}**`;

  return parts.map((p) => ("prose" in p ? (p.prose.trim() ? renderProse(resolveProse(p.prose, cards, bold)) : "") : p.card ? cardHtml(p.card) : "")).join("");
}

/**
 * 卡片按钮：say 把按钮上的话当作用户下一句发出；tab 切到那一页。用事件委托，流式重画后不用重新绑定。
 * 只认显示的字和要发的字一样的按钮：正文里夹带的原始 HTML 做不出“看着是 A、发出去是 B”的按钮。
 */
export function bindAnswerCards(root: HTMLElement, say: (text: string) => void): void {
  root.addEventListener("click", async (event) => {
    // SAFETY: click 事件的 target 是 Element。
    const button = (event.target as Element).closest<HTMLButtonElement>(".gen-card .gc-btn");

    if (!button) return;
    const label = button.textContent?.trim() ?? "";

    if (button.dataset.cardSay !== undefined) {
      if (button.dataset.cardSay === label && label) say(label);

      return;
    }
    const tabId = Number(button.dataset.cardTab);
    const tab = Number.isInteger(tabId) ? await chrome.tabs.get(tabId).catch(() => null) : null;

    if (!tab?.id) { toast("那一页已经关掉了");

 return; }
    await chrome.tabs.update(tab.id, { active: true }).catch(() => undefined);
    const win = await chrome.windows.getCurrent().catch(() => null);

    if (tab.windowId !== win?.id) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => undefined);
  });
}
