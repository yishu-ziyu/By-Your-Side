import { isAnswerSource, type AnswerSource } from '../../../shared/answer-source.js';

export const sourceExcerpts = new Map<string, AnswerSource>();

export function receiveSourceExcerpts(value: unknown): void {
  if (!Array.isArray(value) || value.length > 512) return;
  for (const source of value) if (isAnswerSource(source) && !sourceExcerpts.has(source.id)) sourceExcerpts.set(source.id, source);
}

import { isPopout, targetWindowId } from "./target-window.js";
import { isPageElementSource, type PageElementSource } from "../../../shared/protocol.js";
import { USER_DELIVERY_SOURCE_MAX, type UserDeliverySourceRef } from "../../../shared/voice.js";
import { sourceLabel } from "./delivery-presentation.js";
import { captureCitationContext, citationValues, noteFailure, toast } from "./sonar-citations.js";
import { answerPanelSection, refreshAnswerPanel, siteGlyph } from "./answer-actions.js";
import { createElement as icon, ExternalLink } from "lucide";
import { bindMotionIcon } from "./motion-icon.js";

function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}${parsed.search}`;
  } catch { return null; }
}

async function bringSourceTab(url: string): Promise<{ tab: chrome.tabs.Tab; reused: boolean } | null> {
  const key = pageKey(url);
  const targetWindow = await targetWindowId();
  const tabs = await chrome.tabs.query({});
  const open = tabs.filter(tab => tab.id && tab.url && pageKey(tab.url) === key);
  const reuse = open.find(tab => tab.windowId === targetWindow) ?? open[0];

  if (reuse?.id) {
    const tab = await chrome.tabs.update(reuse.id, { active: true });

    if (reuse.windowId !== targetWindow || isPopout) await chrome.windows.update(reuse.windowId, { focused: true }).catch(() => undefined);

    return tab ? { tab, reused: true } : null;
  }

  const [active] = await chrome.tabs.query({ active: true, windowId: targetWindow ?? chrome.windows.WINDOW_ID_CURRENT });
  const created: chrome.tabs.CreateProperties = { url, active: true };

  if (targetWindow) created.windowId = targetWindow;

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

async function pinpointClaim(tabId: number, url: string, claim: string): Promise<PageElementSource | null> {
  const values = citationValues(claim);

  if (!values.length) return null;
  let context = await captureCitationContext({ tabId, url });

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

async function openAnswerSource(from: Element, source: UserDeliverySourceRef, claim: string | null): Promise<void> {
  let opened: Awaited<ReturnType<typeof bringSourceTab>>;

  try { opened = await bringSourceTab(source.url); } catch { opened = null; }

  if (!opened?.tab.id) { noteFailure(from, "来源页打不开");

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
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return sourceLabel(url); }
}

function claimOf(link: HTMLElement): string {
  const block = (link.closest("p,li,td,th,blockquote") ?? link).cloneNode(true) as HTMLElement;
  block.querySelectorAll(".source-fav").forEach(node => node.remove());

  return block.textContent ?? "";
}

export function attachAnswerSources(answer: HTMLElement, sources: readonly UserDeliverySourceRef[] | undefined): void {
  answer.querySelectorAll(".answer-sources,.source-fav").forEach(node => node.remove());
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
    const glyph = siteGlyph(source.url, host);
    const text = document.createElement("span");
    text.className = "answer-source-label";
    text.textContent = label;
    const where = document.createElement("span");
    where.className = "answer-source-host";
    where.dataset.hover = "在旁边打开";
    const hostText = document.createElement("span");
    hostText.className = "answer-source-host-text";
    hostText.textContent = host;
    where.append(hostText);
    const external = icon(ExternalLink, { width: 12, height: 12, "stroke-width": 1.8, "aria-hidden": "true" });
    external.classList.add("answer-source-external");
    where.append(external);
    button.append(number, glyph, text, where);
    bindMotionIcon(button, "external-link");

    if (!source.title?.trim()) { button.classList.add("untitled"); untitled.push({ key, text, where }); }

    button.onclick = () => void openAnswerSource(button, source, null);
    item.append(button);
    list.append(item);
  }

  if (sources.length >= USER_DELIVERY_SOURCE_MAX) {
    const more = document.createElement("li");
    more.className = "answer-sources-capped";
    more.textContent = "可能还读过别的页面，这里最多列这么多";
    list.append(more);
  }

  const slot = answerPanelSection(answer, "sources");
  slot?.replaceChildren(list);
  refreshAnswerPanel(answer);

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
    link.onclick = (ev) => { ev.preventDefault(); void openAnswerSource(link, entry.source, claimOf(link)); };

    const glyph = siteGlyph(entry.source.url, entry.host);
    glyph.classList.add("source-fav");
    link.prepend(glyph);
    link.title = `${entry.label} · ${entry.host}（点开回原页核对）`;
  }
}
