import { sourceExcerpts } from "./answer-sources.js";
import { isPopout, targetWindowId } from "./target-window.js";
import { Check, createElement as icon, Ellipsis, Undo2 } from "lucide";
import { WORKING_TABS_STORAGE_KEY, executionKey } from "../../../shared/protocol.js";
import { imagePlaceholdersAsText } from "../shared/answer-html.js";
import { noteFailure } from "./sonar-citations.js";
import { answerMarkdown } from "../../../shared/answer-cards.js";
import { answerFillUndoOf as fillUndoOf, fillUndoLabel, isFillUndoPending, onFillUndoChange, requestFillUndo } from "./fill-undo.js";
import { isShortened, visibleBody, visibleMarkdown } from "./answer-shorten.js";
import { bindMotionIcon, setMotionIcon } from "./motion-icon.js";
import { uiEvent } from "./ui-trace.js";

const CHROME = ".gc-actions,.gc-faces,.gc-evidence,.answer-actions,.answer-panel,.fill-undo-result,.source-fav,.answer-sources,.citation-row,.memory-used-toggle,.memory-used-line,.memory-used-cite-row";

function resultCommandShortcut(): string {
  return /Mac/i.test(navigator.platform) ? "⇧⌘K" : "Ctrl+Shift+K";
}

export interface ResultAction {
  id: string;
  label: string;
  shortcut?: string;
  primary?: boolean;
  run: (answer: HTMLElement) => Promise<void>;
}

function answerBody(answer: HTMLElement): HTMLElement {
  const body = visibleBody(answer, CHROME);
  imagePlaceholdersAsText(body);

  return body;
}

export function answerPlainText(body: HTMLElement): string {
  Object.assign(body.style, { position: "fixed", top: "0", left: "-100000px", pointerEvents: "none" });
  body.setAttribute("aria-hidden", "true");
  document.body.append(body);

  try {
    return body.innerText.trim();
  } finally {
    body.remove();
  }
}

async function writeClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

async function copyAnswerText(answer: HTMLElement): Promise<void> {
  await writeClipboard(answerPlainText(answerBody(answer)));
}

async function copyAnswerMarkdown(answer: HTMLElement): Promise<void> {
  if (isShortened(answer) || answer.querySelector(".gc-num")) return writeClipboard(visibleMarkdown(answerBody(answer)));
  await writeClipboard(answer.dataset.markdown ? answerMarkdown(answer.dataset.markdown, sourceExcerpts).trim() : answerPlainText(answerBody(answer)));
}

function removeShowTab(button: Element): void {
  const answer = button.closest<HTMLElement>(".msg.assistant");
  button.remove();
  if (answer) refreshPrimaryAction(answer);
}

function tableTsv(answer: HTMLElement): string | null {
  const table = answer.querySelector("table");
  if (!table) return null;
  return [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join("\t"),
  ).join("\n");
}

async function copyAnswerTable(answer: HTMLElement): Promise<void> {
  const tsv = tableTsv(answerBody(answer));
  if (!tsv) throw new Error("没有表格");
  await writeClipboard(tsv);
}

export function listResultActions(answer: HTMLElement): ResultAction[] {
  const actions: ResultAction[] = [];
  const undo = fillUndoOf(answer);

  if (undo?.state === "ready") actions.push({ id: "undo-fill", label: fillUndoLabel(undo), primary: true, run: requestFillUndo });
  const table = tableTsv(answerBody(answer));
  const pageBtn = answer.querySelector<HTMLButtonElement>(".answer-show-tab");
  if (table) actions.push({ id: "copy-table", label: "复制为表格", shortcut: actions.length ? undefined : "↵", primary: !actions.length, run: copyAnswerTable });
  if (pageBtn) {
    actions.push({
      id: "show-page",
      label: "在页面上查看",
      shortcut: actions.some((a) => a.primary) ? undefined : "↵",
      primary: !actions.some((a) => a.primary),
      run: async () => { pageBtn.click(); },
    });
  }
  if (!actions.some((a) => a.primary)) {
    actions.unshift({ id: "copy", label: "复制", shortcut: "↵", primary: true, run: copyAnswerText });
  } else {
    actions.push({ id: "copy", label: "复制", run: copyAnswerText });
  }
  actions.push({ id: "copy-md", label: "复制为 Markdown", run: copyAnswerMarkdown });
  const sources = answer.querySelector<HTMLButtonElement>(".answer-sources-btn");
  if (sources && !sources.hidden) {
    actions.push({ id: "sources", label: "打开来源", run: async () => { sources.click(); } });
  }
  return actions;
}

function refreshPrimaryAction(answer: HTMLElement): void {
  const primary = answer.querySelector<HTMLButtonElement>(".answer-primary");
  if (!primary) return;
  const undo = fillUndoOf(answer);
  const stuck = undo && (undo.state !== "ready" || isFillUndoPending(answer));
  const action = stuck ? null : listResultActions(answer).find((a) => a.primary);
  if (!stuck && !action) return;
  primary.dataset.action = action?.id ?? "undo-fill";
  primary.disabled = !!stuck;
  primary.replaceChildren();
  primary.classList.remove("copied");
  if (undo) {
    primary.append(icon(Undo2));
    bindMotionIcon(primary, "undo-2");
  } else {
    setMotionIcon(primary, null);
  }
  const label = document.createElement("span");
  label.textContent = action?.label ?? (isFillUndoPending(answer) ? "正在还原…" : fillUndoLabel(undo!));
  const hint = document.createElement("span");
  hint.className = "answer-enter-hint";
  hint.textContent = "↵";
  hint.hidden = true;

  if (!action?.id.startsWith("copy")) {
    primary.append(label, hint);

    return;
  }

  const idle = document.createElement("span");
  idle.className = "answer-face";
  idle.append(label, hint);
  const done = document.createElement("span");
  done.className = "answer-face answer-face-done";
  done.setAttribute("aria-hidden", "true");
  const check = icon(Check);
  check.querySelector("path")?.setAttribute("pathLength", "1");
  done.append(check, Object.assign(document.createElement("span"), { textContent: "已复制" }));
  primary.append(idle, done);
}

const COPIED_MS = 1500;

export function showFailed(answer: HTMLElement): void {
  noteFailure(answer, "没做成");
}

export function showCopied(answer: HTMLElement): void {
  const primary = answer.querySelector<HTMLButtonElement>(".answer-primary");
  const feedback = answer.querySelector<HTMLElement>(".answer-action-feedback");
  const inPlace = !!primary?.querySelector(".answer-face-done");

  if (inPlace) {
    primary!.classList.remove("copied");
    void primary!.offsetWidth;
    primary!.classList.add("copied");
  }

  if (feedback) {
    feedback.textContent = "已复制";
    feedback.classList.toggle("answer-feedback-sr", inPlace);
  }

  clearTimeout(Number(answer.dataset.copiedTimer));
  answer.dataset.copiedTimer = String(setTimeout(() => {
    primary?.classList.remove("copied");

    if (feedback?.textContent === "已复制") feedback.textContent = "";
  }, COPIED_MS));
}

export async function runPrimaryAction(answer: HTMLElement, { keyboard = false } = {}): Promise<void> {
  const undo = fillUndoOf(answer);

  if (undo && (undo.state !== "ready" || isFillUndoPending(answer) || keyboard)) return;
  const action = listResultActions(answer).find((a) => a.primary);
  if (action) uiEvent("ui_answer_action", { action: action.id, from: keyboard ? "enter" : "button" });
  try {
    await action?.run(answer);
    if (action?.id.startsWith("copy")) showCopied(answer);
  } catch {
    showFailed(answer);
  }
}

onFillUndoChange(refreshPrimaryAction);

const SECTION_TITLES = { sources: "读过的网页" } as const;

let answerPanelCount = 0;

export function attachAnswerActions(answer: HTMLElement): void {
  if (answer.querySelector(".answer-actions") || !answer.textContent?.trim()) return;
  const actions = document.createElement("div");
  actions.className = answer.classList.contains("stream-enter") ? "answer-actions enter" : "answer-actions";
  const primary = document.createElement("button");
  primary.type = "button";
  primary.className = "answer-primary";
  primary.addEventListener("click", () => { void runPrimaryAction(answer); });
  const more = document.createElement("button");
  more.type = "button";
  more.className = "answer-command-btn";
  more.setAttribute("aria-label", "更多动作");
  more.title = resultCommandShortcut();
  more.append(icon(Ellipsis));
  more.addEventListener("click", () => {
    answer.dispatchEvent(new CustomEvent("answer-command", { bubbles: true }));
  });
  const sources = document.createElement("button");
  sources.type = "button";
  sources.className = "answer-sources-btn";
  sources.hidden = true;
  sources.setAttribute("aria-expanded", "false");
  const time = document.createElement("span");
  time.className = "answer-time";
  const feedback = document.createElement("span");
  feedback.className = "answer-action-feedback";
  feedback.setAttribute("role", "status");
  const panel = document.createElement("div");
  panel.className = "answer-panel";
  panel.hidden = true;
  answerPanelCount += 1;
  panel.id = `answer-panel-${answerPanelCount}`;
  sources.setAttribute("aria-controls", panel.id);
  const sourceRows = () => Array.from(panel.querySelectorAll<HTMLElement>(".answer-source"));

  sources.onclick = (event) => {
    panel.hidden = !panel.hidden;
    uiEvent("ui_answer_sources", { open: !panel.hidden });
    sources.setAttribute("aria-expanded", String(!panel.hidden));

    if (!panel.hidden) {
      panel.scrollIntoView({ block: "nearest", behavior: "smooth" });

      if (event.detail === 0) sourceRows()[0]?.focus();
    }
  };

  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      sources.click();
      sources.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const rows = sourceRows();
      const at = rows.indexOf(document.activeElement as HTMLElement);

      if (at < 0) return;
      event.preventDefault();
      rows[(at + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
    }
  });

  actions.append(primary, more, sources, time, feedback);
  answer.addEventListener("answer-shorten", () => refreshPrimaryAction(answer));
  answer.append(actions, panel);
  document.querySelectorAll(".answer-latest").forEach(node => node.classList.remove("answer-latest"));
  answer.classList.add("answer-latest");
  refreshPrimaryAction(answer);
}

export function answerPanelSection(answer: HTMLElement, kind: keyof typeof SECTION_TITLES): HTMLElement | null {
  const panel = answer.querySelector<HTMLElement>(":scope > .answer-panel");

  if (!panel) return null;
  let section = panel.querySelector<HTMLElement>(`:scope > [data-section="${kind}"]`);

  if (!section) {
    section = document.createElement("section");
    section.dataset.section = kind;
    const title = document.createElement("h3");
    title.textContent = SECTION_TITLES[kind];
    const body = document.createElement("div");
    body.className = "answer-panel-body";
    section.append(title, body);

    panel.append(section);
  }

  return section.querySelector<HTMLElement>(".answer-panel-body")!;
}

export function refreshAnswerPanel(answer: HTMLElement): void {
  const button = answer.querySelector<HTMLButtonElement>(":scope > .answer-actions > .answer-sources-btn");
  const panel = answer.querySelector<HTMLElement>(":scope > .answer-panel");

  if (!button || !panel) return;

  for (const section of panel.querySelectorAll<HTMLElement>(":scope > section")) {
    section.hidden = !section.querySelector(".answer-panel-body")?.childElementCount;
  }

  const shown = panel.querySelectorAll(":scope > section:not([hidden])");
  button.hidden = shown.length === 0;

  if (button.hidden) panel.hidden = true;

  const glyphs = Array.from(panel.querySelectorAll<HTMLElement>(".answer-source-glyph"));
  const hosts = new Map(glyphs.map(node => [node.dataset.host ?? node.textContent ?? "", node]));
  const squares = [...hosts.values()].slice(0, 2).map(node => node.cloneNode(true) as HTMLElement);

  button.replaceChildren(...squares, "来源");
}

export function siteGlyph(url: string, host: string): HTMLElement {
  const glyph = document.createElement("span");
  glyph.className = "answer-source-glyph";
  glyph.dataset.host = host;
  glyph.setAttribute("aria-hidden", "true");
  const letter = host.charAt(0).toUpperCase();

  if (!chrome.runtime?.getURL) {
    glyph.textContent = letter;

    return glyph;
  }

  const img = document.createElement("img");
  img.alt = "";
  img.src = `${chrome.runtime.getURL("/_favicon/")}?pageUrl=${encodeURIComponent(url)}&size=32`;
  img.onerror = () => { glyph.textContent = letter; };

  glyph.append(img);

  return glyph;
}

export async function offerWorkingTab(answer: HTMLElement, conversationId: string, sources: ReadonlyArray<{ url: string }>): Promise<void> {
  if (!chrome.storage?.session || !chrome.tabs?.get) return;
  const stored = await chrome.storage.session.get(WORKING_TABS_STORAGE_KEY).catch(() => null);
  const map = stored?.[WORKING_TABS_STORAGE_KEY] as Record<string, unknown> | undefined;
  const tabId = map?.[executionKey(conversationId)];

  if (typeof tabId !== "number") return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const targetWindow = await targetWindowId();

  if (!tab?.url || !/^https?:/.test(tab.url) || (tab.active && tab.windowId === targetWindow)) return;
  const origin = (url: string) => { try { return new URL(url).origin; } catch { return null; } };

  if (!sources.some(source => origin(source.url) === origin(tab.url!))) return;
  const time = answer.querySelector<HTMLElement>(":scope > .answer-actions > .answer-time");

  if (!time || !answer.isConnected || !answer.classList.contains("answer-latest") || answer.querySelector(".answer-show-tab")) return;
  document.querySelectorAll(".answer-show-tab").forEach(removeShowTab);
  let host = tab.url;

  try { host = new URL(tab.url).host.replace(/^www\./, ""); } catch {  }
  const title = (tab.title || host).trim();
  const label = `切过去看：${title.length > 30 ? `${title.slice(0, 30)}…` : title}`;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "answer-show-tab";
  button.dataset.tabId = String(tabId);
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(siteGlyph(tab.url, host), "切过去看");

  button.onclick = async () => {
    uiEvent("ui_answer_show_tab");
    button.disabled = true;
    const now = await chrome.tabs.get(tabId).catch(() => null);

    if (!now) {
      button.replaceChildren(...button.querySelectorAll(".answer-source-glyph"), "那一页已关掉");
      button.title = "那一页已经关掉了";
      button.setAttribute("aria-label", "那一页已经关掉了");

      return;
    }
    removeShowTab(button);

    const targetWindow = await targetWindowId();
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);

    if (now.windowId !== targetWindow || isPopout) await chrome.windows.update(now.windowId, { focused: true }).catch(() => undefined);
  };

  time.before(button);
  refreshPrimaryAction(answer);
}

export function dropShowTab(tabId: number): void {
  document.querySelectorAll(`.answer-show-tab[data-tab-id="${tabId}"]`).forEach(removeShowTab);
}

export function setAnswerTime(answer: HTMLElement, text: string): void {
  const time = answer.querySelector<HTMLElement>(":scope > .answer-actions > .answer-time");

  if (time) time.textContent = text;
}
