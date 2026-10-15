import { isPopout, targetWindowId } from "./target-window.js";
import { Check, createElement as icon, Ellipsis, Undo2 } from "lucide";
import { WORKING_TABS_STORAGE_KEY, executionKey } from "../../../shared/protocol.js";
import { imagePlaceholdersAsText } from "../shared/answer-html.js";
import { toast } from "./sonar-citations.js";
import { answerMarkdown } from "../../../shared/answer-cards.js";
import { fillUndoLabel, fillUndoOf, isFillUndoPending, onFillUndoChange, requestFillUndo } from "./fill-undo.js";
import { isShortened, visibleBody, visibleMarkdown } from "./answer-shorten.js";

/** 不属于回答正文的界面文字：复制时去掉。收短时只复制看得到的那一层，多半是要转给别人。 */
const CHROME = ".gc-actions,.gc-faces,.gc-evidence,.answer-actions,.answer-panel,.fill-undo-result,.source-fav,.answer-sources,.citation-row,.memory-used-toggle,.memory-used-line,.memory-used-cite-row";

export function resultCommandShortcut(): string {
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

/**
 * 回答的纯文本，按屏幕上的样子断行：段落之间空一行，列表每项一行，表格每行一行，单元格之间是制表符。
 * innerText 只在元素画出来时按版式断行；摘出来的副本没画出来，innerText 退回 textContent，各段会连成一行。
 * 所以先挂到页面上读，挂在 body 下而不是对话区：对话区可能没在显示，也不惊动盯着对话区的观察者。读完同步拿掉，不会画到屏幕上。
 */
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

export async function copyAnswerText(answer: HTMLElement): Promise<void> {
  await writeClipboard(answerPlainText(answerBody(answer)));
}

export async function copyAnswerMarkdown(answer: HTMLElement): Promise<void> {
  if (isShortened(answer)) return writeClipboard(visibleMarkdown(answerBody(answer)));
  await writeClipboard(answer.dataset.markdown ? answerMarkdown(answer.dataset.markdown).trim() : answerPlainText(answerBody(answer)));
}

/** 去掉「切过去看」后主按钮要跟着换，否则按钮还写「在页面上查看」，点下去却是复制。 */
function removeShowTab(button: Element): void {
  const answer = button.closest<HTMLElement>(".msg.assistant");
  button.remove();
  if (answer) refreshPrimaryAction(answer);
}

export function tableTsv(answer: HTMLElement): string | null {
  const table = answer.querySelector("table");
  if (!table) return null;
  return [...table.querySelectorAll("tr")].map((row) =>
    [...row.querySelectorAll("th,td")].map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim()).join("\t"),
  ).join("\n");
}

export async function copyAnswerTable(answer: HTMLElement): Promise<void> {
  const tsv = tableTsv(answerBody(answer));
  if (!tsv) throw new Error("没有表格");
  await writeClipboard(tsv);
}

export function listResultActions(answer: HTMLElement): ResultAction[] {
  const actions: ResultAction[] = [];
  const undo = fillUndoOf(answer);

  // 这一轮填过表、还没提交：最可能要做的是把填错的改回去，所以它当主动作。
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

export function refreshPrimaryAction(answer: HTMLElement): void {
  const primary = answer.querySelector<HTMLButtonElement>(".answer-primary");
  if (!primary) return;
  const undo = fillUndoOf(answer);
  // 还原过、已提交、页面变了：按钮灰掉，写为什么不能再点；正在还原时也灰掉。
  const stuck = undo && (undo.state !== "ready" || isFillUndoPending(answer));
  const action = stuck ? null : listResultActions(answer).find((a) => a.primary);
  if (!stuck && !action) return;
  primary.dataset.action = action?.id ?? "undo-fill";
  primary.disabled = !!stuck;
  primary.replaceChildren();
  primary.classList.remove("copied");
  if (undo) primary.append(icon(Undo2));
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

  // 复制按钮两面叠在同一格：宽度按较宽的一面算，切换时旁边的东西不动。
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

/** 动作没做成：在一排末尾看得见地写出来（复制成功时这一格只给读屏，这里要撤掉）。 */
export function showFailed(answer: HTMLElement): void {
  const feedback = answer.querySelector<HTMLElement>(".answer-action-feedback");

  if (!feedback) return;
  feedback.classList.remove("answer-feedback-sr");
  feedback.textContent = "没做成";
}

/** 复制成功：复制按钮原地变成画出来的对勾，1.5 秒后变回；主按钮不是复制时（比如还原）在一排末尾写一句，同样到时清掉。读屏都念“已复制”。 */
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

/** keyboard：空输入框按回车。还原会改网页里的格子，只能点按钮，回车不触发；按钮灰着时回车什么也不做。 */
export async function runPrimaryAction(answer: HTMLElement, { keyboard = false } = {}): Promise<void> {
  const undo = fillUndoOf(answer);

  if (undo && (undo.state !== "ready" || isFillUndoPending(answer) || keyboard)) return;
  const action = listResultActions(answer).find((a) => a.primary);
  try {
    await action?.run(answer);
    if (action?.id.startsWith("copy")) showCopied(answer);
  } catch {
    showFailed(answer);
  }
}

onFillUndoChange(refreshPrimaryAction);

const SECTION_TITLES = { sources: "读过的网页" } as const;

/**
 * 文末一排在回答落定时添加：复制 · 来源 · 耗时（docs/evals/20261006-answer-receipt.md）。
 * 最新一条回答一直显示，旧回答悬停才出现（样式表按 .answer-latest 区分）。
 * 「来源」展开回答下方的面板：读过的网页，由 answer-sources 填进来；用到的记忆跟在首句后面（main.ts placeUsedLine）。
 */
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

  sources.onclick = () => {
    panel.hidden = !panel.hidden;
    sources.setAttribute("aria-expanded", String(!panel.hidden));

    // 来源列表常在最后一条回答下面，展开时滚到看得见。
    if (!panel.hidden) panel.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  actions.append(primary, more, sources, time, feedback);
  // 收短后主动作跟着当前层：一句层里看不到的表格不再是“复制为表格”。
  answer.addEventListener("answer-shorten", () => refreshPrimaryAction(answer));
  answer.append(actions, panel);
  document.querySelectorAll(".answer-latest").forEach(node => node.classList.remove("answer-latest"));
  answer.classList.add("answer-latest");
  refreshPrimaryAction(answer);
}

/** 「来源」面板里的一节；回答还没有文末一排时返回 null。 */
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

  // SAFETY: 上面刚建的结构里第二个子元素就是 body。
  return section.querySelector<HTMLElement>(".answer-panel-body")!;
}

/** 面板内容变了之后调用：有内容才露出「来源」，按钮前放最多两个站点的首字母方块。 */
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
  // SAFETY: cloneNode 保持原节点类型。
  const squares = [...hosts.values()].slice(0, 2).map(node => node.cloneNode(true) as HTMLElement);

  button.replaceChildren(...squares, "来源");
}

/** 站点图标：浏览器缓存里的网站真图标（YIS-74）；取不到时退回首字母方块。 */
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

/** 后台把每个对话的工作标签页记在 storage.session 的这个键下（background/state.ts），侧栏只读。 */
/**
 * 结果页在后台时，最新回答的文末一排加「切过去看」：助手不替用户切标签（10-13 用户决定），由用户点。
 * 只给普通网页、这一轮读过或打开过它的网站、且侧栏所在窗口没在看它时出现：工作页跨任务保留，纯问答不该挂上一次的结果页。
 * 点过、页面关了、用户自己切过去就去掉（main.ts 监听标签事件）。
 */
export async function offerWorkingTab(answer: HTMLElement, conversationId: string, sources: ReadonlyArray<{ url: string }>): Promise<void> {
  if (!chrome.storage?.session || !chrome.tabs?.get) return;
  const stored = await chrome.storage.session.get(WORKING_TABS_STORAGE_KEY).catch(() => null);
  // SAFETY: 后台在这个键下只写「执行身份 → 标签页 id」；下面仍按数字核对。
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
  // 只有最新一条回答带这个按钮。
  document.querySelectorAll(".answer-show-tab").forEach(removeShowTab);
  let host = tab.url;

  try { host = new URL(tab.url).host.replace(/^www\./, ""); } catch { /* 上面已确认是网址 */ }
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
    removeShowTab(button);
    const now = await chrome.tabs.get(tabId).catch(() => null);

    if (!now) { toast("那一页已经关掉了");

 return; }

    const targetWindow = await targetWindowId();
    await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);

    // 在会话小窗口里点：标签页所在的浏览器窗口可能压在后面，要提到前面才看得见。
    if (now.windowId !== targetWindow || isPopout) await chrome.windows.update(now.windowId, { focused: true }).catch(() => undefined);
  };

  time.before(button);
  refreshPrimaryAction(answer);
}

/** 那一页关了或已经在眼前：去掉指向它的「切过去看」。 */
export function dropShowTab(tabId: number): void {
  document.querySelectorAll(`.answer-show-tab[data-tab-id="${tabId}"]`).forEach(removeShowTab);
}

export function setAnswerTime(answer: HTMLElement, text: string): void {
  const time = answer.querySelector<HTMLElement>(":scope > .answer-actions > .answer-time");

  if (time) time.textContent = text;
}
