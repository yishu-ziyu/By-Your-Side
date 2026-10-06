/**
 * #49 回答出处：读过的页面列在回答下面「来源」面板里，每个来源一行；正文里引到的已读页面旁加站点小胶囊
 * （回执改版，docs/evals/20261006-answer-receipt.md；原来是回答前一行「读了 … ⌄」加数字角标）。
 * 点开出处 → 主窗口切到那一页（已开着就复用）、尽量定位并高亮段落。输入框旁的「当前页」标签随之换成这一页，不另挂第二个。
 *
 * 诚实边界（与 delivery-facts-view 一致）：
 * - 只用交付事实链 `facts.sources`（本 run 真实读到/打开的页面）；旧记录没有这个字段就什么都不画。
 * - 角标只加在正文链接指向已读页面的地方；模型正文里没读过的链接不标成出处。
 * - 段落定位复用 PINPOINT_DOM_TARGET：找不到唯一位置就不假装高亮，回到页顶并提示「已打开来源页」。
 */
import { isPageElementSource, type PageElementSource } from "../../../shared/protocol.js";
import { USER_DELIVERY_SOURCE_MAX, type UserDeliverySourceRef } from "../../../shared/voice.js";
import { sourceLabel } from "./delivery-facts-view.js";
import { captureCitationContext, citationValues, toast } from "./sonar-citations.js";
import { answerPanelSection, refreshAnswerPanel } from "./answer-actions.js";

/** 同一页面：忽略锚点和末尾斜杠，其余（含查询串）都要一致。 */
function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch { return null; }
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

async function openAnswerSource(source: UserDeliverySourceRef, claim: string | null): Promise<void> {
  let opened: Awaited<ReturnType<typeof bringSourceTab>>;

  try { opened = await bringSourceTab(source.url); } catch { opened = null; }

  if (!opened?.tab.id) { toast("来源页打不开");

 return; }

  const tabId = opened.tab.id;
  const tab = await waitForLoad(tabId);
  const passage = claim && tab?.url ? await pinpointClaim(tabId, tab.url, claim) : null;

  if (!passage) {
    if (opened.reused) await chrome.scripting.executeScript({ target: { tabId }, func: () => window.scrollTo({ top: 0 }) }).catch(() => undefined);
    toast("已打开来源页");
  }
}

function hostOf(url: string): string {
  // host 带非默认端口：同一台机器上的几个站分得开；常见网站端口默认，不受影响。
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return sourceLabel(url); }
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
export function attachAnswerSources(answer: HTMLElement, sources: readonly UserDeliverySourceRef[] | undefined): void {
  answer.querySelectorAll(".answer-sources,.source-mark").forEach(node => node.remove());
  refreshAnswerPanel(answer);

  if (!sources?.length) return;
  const keyed = new Map<string, { source: UserDeliverySourceRef; label: string; host: string; index: number }>();

  for (const source of sources) {
    const key = pageKey(source.url);

    if (key && !keyed.has(key)) keyed.set(key, { source, label: source.title?.trim() || sourceLabel(source.url), host: hostOf(source.url), index: keyed.size + 1 });
  }

  if (!keyed.size) return;
  const list = document.createElement("ol");
  list.className = "answer-sources";

  const untitled: Array<{ key: string; text: HTMLElement; where: HTMLElement }> = [];

  for (const [key, { source, label, host, index }] of keyed) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "answer-source";
    button.title = source.url;
    const number = document.createElement("span");
    number.className = "answer-source-index";
    number.textContent = String(index);
    const glyph = document.createElement("span");
    glyph.className = "answer-source-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = host.charAt(0).toUpperCase();
    const text = document.createElement("span");
    text.className = "answer-source-label";
    text.textContent = label;
    const where = document.createElement("span");
    where.className = "answer-source-host";
    where.dataset.hover = "在旁边打开";
    where.textContent = host;
    button.append(number, glyph, text, where);

    // 没有标题时第三列已经是地址，右边不再重复一遍。
    if (!source.title?.trim()) { button.classList.add("untitled"); untitled.push({ key, text, where }); }

    button.onclick = () => void openAnswerSource(source, null);
    item.append(button);
    list.append(item);
  }

  // 宿主最多记 USER_DELIVERY_SOURCE_MAX 条，记满时实际可能更多：面板末尾说一句。
  if (sources.length >= USER_DELIVERY_SOURCE_MAX) {
    const more = document.createElement("li");
    more.className = "answer-sources-capped";
    more.textContent = "可能还读过别的页面，这里最多列这么多";
    list.append(more);
  }

  const slot = answerPanelSection(answer, "sources");
  slot?.replaceChildren(list);
  refreshAnswerPanel(answer);

  // 用批量脚本读的页面不带标题；这些页面多半还开着，标签页知道标题。
  if (untitled.length && chrome.tabs?.query) {
    void chrome.tabs.query({}).then((tabs) => {
      for (const row of untitled) {
        const title = tabs.find((tab) => tab.url && tab.title?.trim() && pageKey(tab.url) === row.key)?.title?.trim();

        if (!title) continue;
        row.text.textContent = title;
        row.where.closest(".answer-source")?.classList.remove("untitled");
      }
    }).catch(() => undefined);
  }

  for (const link of answer.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const entry = keyed.get(pageKey(link.href) ?? "");

    if (!entry) continue;
    // 正文里指向已读页面的链接和它的角标做同一件事，不再一个开新标签、一个定位出处。
    link.onclick = (ev) => { ev.preventDefault(); void openAnswerSource(entry.source, claimOf(link)); };

    const mark = document.createElement("button");
    mark.type = "button";
    mark.className = "source-mark";
    const square = document.createElement("span");
    square.className = "answer-source-glyph";
    square.textContent = entry.host.charAt(0).toUpperCase();
    mark.append(square);

    // 链接文字已经是站名时只留方块，不把站名写两遍。
    if ((link.textContent ?? "").includes(entry.host)) mark.classList.add("glyph-only");
    else mark.append(entry.host);
    mark.title = `打开出处并定位：${entry.label}`;
    mark.setAttribute("aria-label", `打开出处 ${entry.index}：${entry.label}`);
    mark.onclick = () => void openAnswerSource(entry.source, claimOf(link));
    link.after(mark);
  }
}
