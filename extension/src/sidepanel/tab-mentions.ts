/**
 * A2：输入 @ 把别的标签页拉进这次提问。
 * 弹层列站点图标、标题、域名；当前页排第一。选中后飞进输入区，变成页面胶囊。
 * 待读（描边）→ 已读（实心 + ✓，扩展后台真读到正文才变）→ 读不到（划线 + 原因）。
 */
import { targetWindowId } from "./target-window.js";
import { siteGlyph } from "./answer-actions.js";
import { reducedMotion } from "./branch-graph.js";

export type MentionStatus = "pending" | "read" | "unread";

export interface MentionedTab {
  tabId: number;
  title: string;
  url: string;
  status: MentionStatus;
  reason?: string;
}

interface TabMentions {
  handleKeydown: (event: KeyboardEvent) => boolean;
  pages: () => Array<{ tabId: number; title: string; url: string }>;
  items: () => MentionedTab[];
  clear: () => void;
  remove: (tabId: number) => void;
  /** 切回会话时放回这段会话没发出去的 @ 页面。 */
  restore: (items: MentionedTab[], options?: { keepStatus?: boolean }) => void;
  isOpen: () => boolean;
}

const MAX = 6;
const FLIP_MS = 200;
const EXIT_MS = 110;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}

export function hostOf(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return ""; }
}

function isBrowserPage(url: string): boolean {
  return /^(chrome|edge|about|devtools|chrome-extension):/i.test(url);
}

/** 光标前最近一个独立的 @，后面直到光标的筛选字（不含空格）。 */
function mentionQuery(value: string, cursor: number): { start: number; query: string } | null {
  const before = value.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && /[\w.@-]/i.test(before.charAt(at - 1))) return null;
  const query = before.slice(at + 1);
  if (/[\s\n]/.test(query)) return null;
  return { start: at, query };
}

export function mountTabMentions(opts: {
  composerEl: HTMLElement;
  inputEl: HTMLTextAreaElement;
  stripEl: HTMLElement;
  /** 用户去掉了一页：草稿要跟着存。 */
  onChange?: () => void;
}): TabMentions {
  const { composerEl, inputEl, stripEl } = opts;
  const host = composerEl.parentElement ?? composerEl;
  const menu = el("div", "tab-mention-menu");
  menu.id = "tab-mention-menu";
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "打开的标签页");
  menu.hidden = true;
  host.insertBefore(menu, composerEl);

  const picked: MentionedTab[] = [];
  let rows: chrome.tabs.Tab[] = [];
  let active = 0;
  let dismissedFor: string | null = null;

  const syncStrip = (): void => {
    stripEl.hidden = picked.length === 0;
    stripEl.replaceChildren();
    for (const item of picked) {
      stripEl.append(chipEl(item));
    }
  };

  function chipEl(item: MentionedTab): HTMLElement {
    const chip = el("span", "tab-mention-chip");
    chip.dataset.tabId = String(item.tabId);
    chip.dataset.status = item.status;
    chip.title = item.reason ? `${item.title}\n${item.reason}` : `${item.title}\n${item.url}`;
    chip.setAttribute("aria-label", item.status === "unread"
      ? `读不到：${item.title}${item.reason ? `，${item.reason}` : ""}`
      : item.status === "read" ? `已读：${item.title}` : `待读：${item.title}`);
    const glyph = siteGlyph(item.url, hostOf(item.url) || item.title);
    glyph.className = "tab-mention-glyph";
    const label = el("span", "tab-mention-label", item.title || hostOf(item.url) || "标签页");
    chip.append(glyph, label);
    if (item.status === "read") chip.append(el("span", "tab-mention-ok", "✓"));
    const remove = el("button", "tab-mention-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `去掉 ${item.title || "这一页"}`);
    remove.addEventListener("click", () => {
      const i = picked.findIndex((p) => p.tabId === item.tabId);
      if (i >= 0) picked.splice(i, 1);
      syncStrip();
      opts.onChange?.();
    });
    chip.append(remove);
    return chip;
  }

  function close(): void {
    menu.hidden = true;
    inputEl.removeAttribute("aria-activedescendant");
  }

  function isOpen(): boolean { return !menu.hidden; }

  async function listTabs(): Promise<chrome.tabs.Tab[]> {
    const targetWindow = await targetWindowId();
    const tabs = await chrome.tabs.query({});
    const usable = tabs.filter((t) => t.id != null && t.url && !isBrowserPage(t.url));
    const currentId = (await chrome.tabs.query({ active: true, windowId: targetWindow })).find((t) => t.id)?.id;
    usable.sort((a, b) => {
      if (a.id === currentId) return -1;
      if (b.id === currentId) return 1;
      if (a.active !== b.active) return a.active ? -1 : 1;
      return (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0);
    });
    return usable;
  }

  function paint(tabs: chrome.tabs.Tab[], query: string): void {
    const q = query.trim().toLowerCase();
    const taken = new Set(picked.map((p) => p.tabId));
    rows = tabs.filter((t) => {
      if (t.id == null || taken.has(t.id)) return false;
      if (!q) return true;
      const hay = `${t.title ?? ""} ${hostOf(t.url ?? "")} ${t.url ?? ""}`.toLowerCase();
      return hay.includes(q);
    }).slice(0, 12);
    active = Math.min(active, Math.max(0, rows.length - 1));
    menu.replaceChildren();
    if (!rows.length) {
      menu.append(el("div", "tab-mention-empty", tabs.length ? "没有匹配的标签页" : "没有可拉进来的标签页"));
    }
    rows.forEach((tab, i) => {
      const item = el("div", "tab-mention-item");
      item.id = `tab-mention-opt-${i}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(i === active));
      const hostName = hostOf(tab.url ?? "");
      item.append(siteGlyph(tab.url ?? "", hostName || "·"), el("span", "tab-mention-name", tab.title || hostName || "标签页"), el("span", "tab-mention-host", hostName));
      if (tab.active) item.append(el("span", "tab-mention-now", "当前页"));
      item.addEventListener("mousedown", (e) => e.preventDefault());
      item.addEventListener("click", () => { active = i; void pick(); });
      item.addEventListener("mousemove", () => { if (active !== i) { active = i; highlight(); } });
      menu.append(item);
    });
    menu.hidden = false;
    inputEl.setAttribute("aria-expanded", "true");
    highlight();
  }

  function highlight(): void {
    menu.querySelectorAll<HTMLElement>(".tab-mention-item").forEach((item, i) => {
      item.setAttribute("aria-selected", String(i === active));
      if (i === active) item.scrollIntoView({ block: "nearest" });
    });
    if (rows.length) inputEl.setAttribute("aria-activedescendant", `tab-mention-opt-${active}`);
  }

  async function refresh(): Promise<void> {
    const found = mentionQuery(inputEl.value, inputEl.selectionStart ?? inputEl.value.length);
    if (!found || picked.length >= MAX || dismissedFor === inputEl.value) { close(); return; }
    if (dismissedFor !== null) dismissedFor = null;
    const tabs = await listTabs();
    if (mentionQuery(inputEl.value, inputEl.selectionStart ?? inputEl.value.length)?.start !== found.start) return;
    paint(tabs, found.query);
  }

  async function pick(): Promise<void> {
    const tab = rows[active];
    const found = mentionQuery(inputEl.value, inputEl.selectionStart ?? inputEl.value.length);
    const row = menu.querySelector<HTMLElement>(`#tab-mention-opt-${active}`);
    const from = row?.getBoundingClientRect();
    close();
    if (!tab?.id || !found) return;
    if (picked.some((p) => p.tabId === tab.id)) return;
    const next: MentionedTab = {
      tabId: tab.id,
      title: (tab.title ?? "").trim() || hostOf(tab.url ?? "") || "标签页",
      url: tab.url ?? "",
      status: "pending",
    };
    picked.push(next);
    inputEl.value = `${inputEl.value.slice(0, found.start)}${inputEl.value.slice(inputEl.selectionStart ?? found.start + 1 + found.query.length)}`;
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.focus({ preventScroll: true });
    syncStrip();
    const chip = stripEl.querySelector<HTMLElement>(`.tab-mention-chip[data-tab-id="${tab.id}"]`);
    if (from && chip && !reducedMotion()) fly(from, chip);
  }

  function fly(from: DOMRect, to: HTMLElement): void {
    const dest = to.getBoundingClientRect();
    const ghost = to.cloneNode(true) as HTMLElement;
    ghost.classList.add("tab-mention-fly");
    ghost.style.left = `${dest.left}px`;
    ghost.style.top = `${dest.top}px`;
    ghost.style.width = `${dest.width}px`;
    ghost.style.height = `${dest.height}px`;
    ghost.style.transform = `translate(${from.left - dest.left}px, ${from.top - dest.top}px)`;
    document.body.append(ghost);
    to.style.opacity = "0";
    requestAnimationFrame(() => {
      ghost.style.transform = "translate(0,0)";
      ghost.style.width = `${dest.width}px`;
    });
    window.setTimeout(() => { ghost.remove(); to.style.opacity = ""; }, FLIP_MS);
  }

  let timer = 0;
  inputEl.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => { void refresh(); }, 40);
  });
  inputEl.addEventListener("click", () => { void refresh(); });
  inputEl.addEventListener("keyup", () => { void refresh(); });
  document.addEventListener("mousedown", (e) => {
    if (!isOpen()) return;
    if (menu.contains(e.target as Node) || inputEl.contains(e.target as Node)) return;
    close();
  });

  function handleKeydown(e: KeyboardEvent): boolean {
    if (!isOpen() || e.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!rows.length) return true;
      active = (active + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      highlight();
      return true;
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void pick();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      dismissedFor = inputEl.value;
      if (!reducedMotion()) {
        menu.classList.add("tab-mention-out");
        window.setTimeout(() => { menu.classList.remove("tab-mention-out"); close(); }, EXIT_MS);
      } else close();
      return true;
    }
    return false;
  }

  return {
    handleKeydown,
    pages: () => picked.filter((p) => p.status !== "unread").map(({ tabId, title, url }) => ({ tabId, title, url })),
    items: () => picked.map((p) => ({ ...p })),
    clear: () => { picked.length = 0; syncStrip(); close(); },
    remove: (tabId) => {
      const index = picked.findIndex((item) => item.tabId === tabId);
      if (index < 0) return;
      picked.splice(index, 1);
      syncStrip();
      opts.onChange?.();
    },
    restore: (items, options) => {
      picked.length = 0;
      for (const item of items.slice(0, MAX)) {
        if (typeof item?.tabId === "number") picked.push({ ...item, status: options?.keepStatus ? item.status : "pending", reason: options?.keepStatus ? item.reason : undefined });
      }
      syncStrip();
      close();
    },
    isOpen,
  };
}
