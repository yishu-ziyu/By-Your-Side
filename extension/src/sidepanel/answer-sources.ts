/**
 * #49 回答出处：回答顶上「读了 N 个网站」，正文里引到的已读页面旁加角标；
 * 点开出处 → 主窗口切到那一页（已开着就复用）、尽量定位并高亮段落，同时把这一页挂到输入框旁。
 *
 * 诚实边界（与 delivery-facts-view 一致）：
 * - 只用交付事实链 `facts.sources`（本 run 真实读到/打开的页面）；旧记录没有这个字段就什么都不画。
 * - 角标只加在正文链接指向已读页面的地方；模型正文里没读过的链接不标成出处。
 * - 段落定位复用 PINPOINT_DOM_TARGET：找不到唯一位置就不假装高亮，回到页顶并提示「已打开来源页」。
 */
import { isPageElementSource, type PageElementSource } from "../../../shared/protocol.js";
import { USER_DELIVERY_SOURCE_MAX, type UserDeliverySourceRef } from "../../../shared/voice.js";
import { sourceLabel } from "./delivery-facts-view.js";
import { captureCitationContext, citationValues } from "./sonar-citations.js";

/** 点开出处后要挂到输入框的页面；passage 只在原页真的定位到段落时才有。 */
export interface SourcePageChip { tabId: number; title: string; url: string; passage: PageElementSource | null }

/** 同一页面：忽略锚点和末尾斜杠，其余（含查询串）都要一致。 */
function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch { return null; }
}

function toast(text: string): void {
  document.querySelector(".source-toast")?.remove();
  const note = document.createElement("div");
  note.className = "source-toast";
  note.setAttribute("role", "status");
  note.textContent = text;
  document.body.append(note);
  setTimeout(() => note.remove(), 2400);
}

/** 已开着这一页就切过去（优先侧栏所在窗口），否则在当前标签旁新开，不覆盖用户正在看的页面。 */
async function bringSourceTab(url: string): Promise<{ tab: chrome.tabs.Tab; reused: boolean } | null> {
  const key = pageKey(url);
  const current = await chrome.windows.getCurrent().catch(() => null);
  const tabs = await chrome.tabs.query({});
  const open = tabs.filter(tab => tab.id && tab.url && pageKey(tab.url) === key);
  const reuse = open.find(tab => tab.windowId === current?.id) ?? open[0];

  if (reuse?.id) {
    const tab = await chrome.tabs.update(reuse.id, { active: true });

    if (reuse.windowId !== current?.id) await chrome.windows.update(reuse.windowId, { focused: true }).catch(() => undefined);

    return tab ? { tab, reused: true } : null;
  }

  const [active] = await chrome.tabs.query({ active: true, windowId: current?.id ?? chrome.windows.WINDOW_ID_CURRENT });
  const created: chrome.tabs.CreateProperties = { url, active: true };

  if (current?.id) created.windowId = current.id;

  if (active) created.index = active.index + 1;
  const tab = await chrome.tabs.create(created);

  return { tab, reused: false };
}

async function waitForLoad(tabId: number, timeoutMs = 10_000): Promise<chrome.tabs.Tab | null> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);

    if (!tab) return null;

    if (tab.status === "complete" && tab.url) return tab;
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  return chrome.tabs.get(tabId).catch(() => null);
}

/** 用主张里的数字在原页找唯一段落并高亮；没有可核对的数字或位置不唯一就返回 null。 */
async function pinpointClaim(tabId: number, url: string, claim: string): Promise<PageElementSource | null> {
  const values = citationValues(claim);

  if (!values.length) return null;
  let context = await captureCitationContext({ tabId, url });

  // 新开的页面刚加载完，页面脚本可能还没就绪：稍等再问一次。
  if (!context) { await new Promise(resolve => setTimeout(resolve, 400)); context = await captureCitationContext({ tabId, url }); }

  if (!context) return null;

  for (const value of values) {
    const found = await chrome.runtime.sendMessage({ type: "PINPOINT_DOM_TARGET", action: "resolve", query: value, ...context }).catch(() => null);

    if (!found?.ok || !isPageElementSource(found.source)) continue;
    const shown = await chrome.runtime.sendMessage({ type: "PINPOINT_DOM_TARGET", action: "reveal", source: found.source, tabId }).catch(() => null);

    if (shown?.ok) return found.source;
  }

  return null;
}

async function openAnswerSource(source: UserDeliverySourceRef, claim: string | null, attach: (chip: SourcePageChip) => void): Promise<void> {
  let opened: Awaited<ReturnType<typeof bringSourceTab>>;

  try { opened = await bringSourceTab(source.url); } catch { opened = null; }

  if (!opened?.tab.id) { toast("来源页打不开");

 return; }

  const tabId = opened.tab.id;
  const tab = await waitForLoad(tabId);
  const url = tab?.url ?? source.url;
  const passage = claim && tab?.url ? await pinpointClaim(tabId, tab.url, claim) : null;

  if (!passage) {
    if (opened.reused) await chrome.scripting.executeScript({ target: { tabId }, func: () => window.scrollTo({ top: 0 }) }).catch(() => undefined);
    toast("已打开来源页");
  }

  attach({ tabId, url, title: tab?.title?.trim() || source.title?.trim() || sourceLabel(url), passage });
}

/** 角标对应的主张：链接所在的那一段。 */
function claimOf(link: HTMLElement): string {
  // SAFETY: cloneNode 保持原节点类型；link 本身是 HTMLElement，closest 命中的也是元素。
  const block = (link.closest("p,li,td,th,blockquote") ?? link).cloneNode(true) as HTMLElement;
  block.querySelectorAll(".source-mark").forEach(node => node.remove());

  return block.textContent ?? "";
}

/**
 * 给一条已渲染的回答加出处。可重复调用（正文重渲染后再调一次），不会叠出两份。
 * sources 缺省（旧记录）或为空时不画任何东西。
 */
export function attachAnswerSources(answer: HTMLElement, sources: readonly UserDeliverySourceRef[] | undefined, attach: (chip: SourcePageChip) => void): void {
  answer.querySelectorAll(".answer-sources,.source-mark").forEach(node => node.remove());

  if (!sources?.length) return;
  const keyed = new Map<string, { source: UserDeliverySourceRef; label: string; index: number }>();

  for (const source of sources) {
    const key = pageKey(source.url);

    if (key && !keyed.has(key)) keyed.set(key, { source, label: source.title?.trim() || sourceLabel(source.url), index: keyed.size + 1 });
  }

  if (!keyed.size) return;
  // 宿主最多记 USER_DELIVERY_SOURCE_MAX 条，记满时实际可能更多：只说「至少」。
  const capped = sources.length >= USER_DELIVERY_SOURCE_MAX;
  const head = document.createElement("details");
  head.className = "answer-sources";
  const summary = document.createElement("summary");
  summary.textContent = `读了${capped ? "至少 " : " "}${keyed.size} 个网站`;
  const list = document.createElement("ol");

  for (const { source, label, index } of keyed.values()) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-source";
    button.title = source.url;
    const number = document.createElement("span");
    number.className = "answer-source-index";
    number.textContent = String(index);
    const text = document.createElement("span");
    text.className = "answer-source-label";
    text.textContent = label;
    button.append(number, text);
    button.onclick = () => void openAnswerSource(source, null, attach);
    item.append(button);
    list.append(item);
  }

  head.append(summary, list);
  answer.prepend(head);

  for (const link of answer.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const entry = keyed.get(pageKey(link.href) ?? "");

    if (!entry) continue;
    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "source-mark";
    mark.textContent = String(entry.index);
    mark.title = `打开出处并定位：${entry.label}`;
    mark.setAttribute("aria-label", `打开出处 ${entry.index}：${entry.label}`);
    mark.onclick = () => void openAnswerSource(entry.source, claimOf(link), attach);
    link.after(mark);
  }
}
