/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 *
 * 渲染层依赖：marked（assistant 消息 Markdown 渲染）+ dompurify（消毒）+ lucide（图标）。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Wrench, Brain, GraduationCap, Search } from "lucide";
import {
  MousePointerClick,
  PenLine,
  Keyboard,
  ArrowDownUp,
  ScanSearch,
  Camera,
  CodeXml,
  Globe,
  List,
  Tag,
  Eraser,
  CircleCheck,
  ChevronDown,
  ArrowDown,
  Check,
  Users,
  Send,
  Inbox,
} from "lucide";
import {
  StepChain,
  chipState,
  describeTool,
  formatDuration,
  historyEventTime,
  recordedDuration,
  loaderSubtitle,
  pixelDelay,
  workerEventRunPolicy,
} from "./steps.js";
import { cursorColor } from "../shared/palette.js";
import { LEAD_COLOR, displayColor, displayNameFor, personFor } from "../../../shared/cast.js";
import { mountGrok, mountKenney, type GrokHandle } from "../shared/grok-bot.js";
import { mountCompanion } from "./companion.js";
import {
  chipLabel,
  displayName,
  filterModels,
  groupModelsByProvider,
  humanizeModelError,
  modelReasoningMeta,
  providerLabel,
  providerMark,
} from "./models.js";
import { AttachmentsManager } from "./attachments.js";
import { LEAD_SESSION_ID, isLeadSession, parseServerMessage } from "../../../shared/protocol.js";
import type { AgentMode, AgentRunState, AgentUiEvent, Attachment, ClientMessage, ConversationSummary, ModelOption, TeamView } from "../../../shared/protocol.js";
import { memberBoundPageLabel, memberStatusLabel, panelLive, shouldFinishRunOnDisconnect, shouldShowTeamCard, teamSummaryLabel } from "../../../shared/control.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelHistoryEntry, type PanelToBg } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";

const TOKEN_KEY = "sideagent_token";
const TEACH_MODE_KEY = "sideagent_teach_mode";
const PLACEHOLDER_IDLE = "给 By Your Side 发消息，Enter 发送，Shift+Enter 换行";
const PLACEHOLDER_RUNNING = "插话：调整 Agent 的方向…（Enter 发送）";
const PLACEHOLDER_USER = "现在归你。点页面上的「交还」让 Agent 继续";
const PLACEHOLDER_DRAINING = "正在停止所有 Agent 的新动作。";
const PLACEHOLDER_PARTIAL = "部分成员已恢复。未续跑的人仍归你。";

marked.setOptions({ breaks: true, gfm: true });

// 渲染出的链接一律新开标签页
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false }));
}

const app = document.getElementById("app")!;
app.innerHTML = `
  <header id="topbar">
    <div class="brand-cluster">
      <img id="logo" src="icons/icon-48.png" alt="" />
      <span id="brand">By Your Side</span>
    </div>
    <button id="teach-toggle" type="button" title="教学模式：Agent 只标注引导，由你手动操作" aria-pressed="false"></button>
    <div id="status-pill" class="activity-island" title="当前连接与执行状态">
      <span id="status-dot" class="dot island-pulse-dot"></span>
      <span id="status-text">未连接</span>
    </div>
  </header>
  <div id="conversation-bar">
    <button id="conversation-switcher" type="button" aria-haspopup="menu" aria-expanded="false">新会话 ▾</button>
    <button id="conversation-new" type="button">＋ 新会话</button>
  </div>
  <button id="conversation-background" type="button" hidden></button>
  <div id="conversation-menu" role="menu" hidden></div>
  <div id="messages"></div>
  <div id="team-card" hidden></div>
  <div class="composer-dock-wrap">
    <div id="morph-sheet" class="page-morph-sheet" style="display: none;">
      <div class="morph-sheet-head">
        <span>当前活动标签页检查器</span>
        <button type="button" id="close-morph-sheet" class="sheet-close-btn" title="关闭">✕</button>
      </div>
      <div class="morph-sheet-body" id="morph-sheet-body">
        <div id="morph-sheet-title">标题：检测中…</div>
        <div id="morph-sheet-url">URL：-</div>
        <div id="morph-sheet-status">状态：活跃连接已就绪</div>
      </div>
    </div>
    <div id="attach-menu" class="action-menu-popover" hidden>
      <div class="action-menu-item" id="menu-action-screenshot">
        <span class="action-menu-item-icon">📸</span>
        <span class="action-menu-item-label">截取当前网页视口</span>
      </div>
      <div class="action-menu-item" id="menu-action-upload">
        <span class="action-menu-item-icon">📁</span>
        <span class="action-menu-item-label">上传本地图片</span>
      </div>
    </div>
    <input type="file" id="file-input" accept="image/*" multiple hidden />
    <div id="composer" class="composer-glass-dock">
      <div id="page-pill" class="morphing-page-pill" title="当前活动标签页（点击展开检查面板）">
        <span id="tab-icon-sq" class="tab-icon-sq"></span>
        <span id="tab-title-text" class="tab-title-text">检测标签页…</span>
        <i class="tab-live-dot"></i>
      </div>
      <div id="ask-cite" hidden>
        <span id="ask-cite-host"></span>
        <span id="ask-cite-text"></span>
        <button type="button" id="ask-cite-close" title="去掉这段引用">×</button>
      </div>
      <div id="attachments-strip" class="attachments-strip" hidden></div>
      <textarea id="input" rows="1" placeholder="${PLACEHOLDER_IDLE}"></textarea>
      <div id="composer-bar">
        <button id="attach-btn" class="composer-icon-btn" type="button" title="添加附件或截屏" aria-haspopup="true">+</button>
        <button id="model-btn" type="button" title="切换模型" hidden aria-haspopup="listbox" aria-expanded="false">
          <span id="model-mark" class="model-mark" hidden></span>
          <span id="model-name"></span>
          <span id="model-reasoning-tag" class="reasoning-tag" hidden></span>
        </button>
        <span id="composer-spacer"></span>
        <button id="takeover-btn" type="button" title="拿回当前页面，Agent 先停手" hidden>接管</button>
        <button id="abort-btn" type="button" title="中止" hidden></button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span>
          <span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
  <div id="model-popover" hidden></div>
  <div id="setup" hidden>
    <h2>By Your Side 设置</h2>
    <p class="hint">native host 未安装时的调试通道：先跑 <code>npm run dev:agent</code>，把终端里的 token 粘贴到下面（只需设置一次）。正常用法：<code>npm run install:host</code> 后无需本页。</p>
    <input id="token-input" type="text" placeholder="token" autocomplete="off" />
    <div id="setup-err" class="err"></div>
    <button id="setup-save" type="button">保存并连接</button>
  </div>
`;

const statusDot = document.getElementById("status-dot") as HTMLElement;
const statusText = document.getElementById("status-text")!;
const messagesEl = document.getElementById("messages")!;
const composerEl = document.getElementById("composer") as HTMLElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const takeoverBtn = document.getElementById("takeover-btn") as HTMLButtonElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const teachToggle = document.getElementById("teach-toggle") as HTMLButtonElement;
const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;
const modelMark = document.getElementById("model-mark") as HTMLElement;
const modelName = document.getElementById("model-name")!;
const modelReasoningTag = document.getElementById("model-reasoning-tag") as HTMLElement;
const modelPopover = document.getElementById("model-popover")!;
const setupEl = document.getElementById("setup")!;
const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const setupErr = document.getElementById("setup-err")!;
const setupSave = document.getElementById("setup-save") as HTMLButtonElement;

// 附件瓷贴与动作菜单 DOM
const attachmentsStrip = document.getElementById("attachments-strip") as HTMLElement;
const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement;
const attachMenu = document.getElementById("attach-menu") as HTMLElement;
const fileInput = document.getElementById("file-input") as HTMLInputElement;
let attachments!: AttachmentsManager;

// 页面感知胶囊与检查器 DOM
const pagePill = document.getElementById("page-pill") as HTMLElement | null;
const askCiteEl = document.getElementById("ask-cite") as HTMLElement | null;
const askCiteHost = document.getElementById("ask-cite-host") as HTMLElement | null;
const askCiteText = document.getElementById("ask-cite-text") as HTMLElement | null;
const askCiteClose = document.getElementById("ask-cite-close") as HTMLButtonElement | null;
let pendingAsk: PendingAsk | null = null;
let selectedConversationId = "default";
let conversationReady = false;
let transportConnected = false;
const completedConversations = new Set<string>();
let conversationRequest: string | null = null;
const conversations = new Map<string, ConversationSummary>();
const conversationSwitcher = document.getElementById("conversation-switcher") as HTMLButtonElement;
const conversationNew = document.getElementById("conversation-new") as HTMLButtonElement;
const conversationMenu = document.getElementById("conversation-menu")!;
const conversationBackground = document.getElementById("conversation-background") as HTMLButtonElement;
type ConversationDraft = { text: string; attachments: Attachment[]; ask: PendingAsk | null };
const conversationDrafts = new Map<string, ConversationDraft>();
const draftFingerprints = new Map<string, string>();
let restoringDraft = false;
let draftRevision = 0;
let draftWrites = Promise.resolve();
const DRAFT_KEY = "sideagent_conversation_draft:";

function saveDraft(): void {
  if (restoringDraft || !attachments) return;
  const id = selectedConversationId;
  const draft: ConversationDraft = { text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk };
  const fingerprint = JSON.stringify(draft);
  if (draftFingerprints.get(id) === fingerprint) return;
  draftRevision += 1;
  draftFingerprints.set(id, fingerprint);
  conversationDrafts.set(id, draft);
  draftWrites = draftWrites.catch(() => {}).then(() => chrome.storage.local.set({ [DRAFT_KEY + id]: draft }));
}

async function restoreDraft(id: string): Promise<void> {
  const revision = draftRevision;
  let draft = conversationDrafts.get(id);
  if (!draft) {
    const stored = await chrome.storage.local.get(DRAFT_KEY + id);
    if (revision !== draftRevision || selectedConversationId !== id) return;
    draft = stored[DRAFT_KEY + id] as ConversationDraft | undefined;
  }
  if (selectedConversationId !== id) return;
  restoringDraft = true;
  try {
    inputEl.value = typeof draft?.text === "string" ? draft.text : "";
    attachments.restore(draft?.attachments ?? [], id);
    pendingAsk = draft?.ask ?? null;
    if (pendingAsk) applyPendingAsk(pendingAsk);
    else if (askCiteEl) askCiteEl.hidden = true;
    autoResize();
    draftFingerprints.set(id, JSON.stringify({ text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk }));
  } finally { restoringDraft = false; }
}

function upsertConversation(c: ConversationSummary): void {
  if (conversations.get(c.id)?.state === "running" && c.state === "idle" && c.id !== selectedConversationId) completedConversations.add(c.id);
  conversations.set(c.id, c);
}

function conversationStateLabel(c: ConversationSummary): string {
  return c.state === "running" ? "运行中" : c.state === "user" ? "现在归你" : "空闲";
}

function renderConversations(): void {
  const current = conversations.get(selectedConversationId);
  const currentTitle = document.createElement("span");
  currentTitle.className = "conversation-title";
  currentTitle.textContent = current?.title || "新会话";
  conversationSwitcher.replaceChildren(currentTitle, icon(ChevronDown));
  conversationSwitcher.title = current?.title || "切换会话";
  conversationNew.disabled = !conversationReady || !transportConnected || conversationRequest !== null;
  conversationNew.textContent = conversationRequest ? "正在新建…" : "＋ 新会话";
  const list = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  const rows = list.map((c) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(c.id === selectedConversationId));
    button.dataset.conversationId = c.id;
    const title = document.createElement("span");
    title.textContent = c.title || "新会话";
    const state = document.createElement("small");
    state.textContent = conversationStateLabel(c);
    button.append(title, state);
    button.onclick = () => selectConversation(c.id);
    return button;
  });
  conversationMenu.replaceChildren(...rows);
  const other = list.find((c) => c.id !== selectedConversationId && c.state === "running")
    ?? list.find((c) => c.id !== selectedConversationId && c.state === "user")
    ?? list.find((c) => c.id !== selectedConversationId && completedConversations.has(c.id));
  conversationBackground.hidden = !other;
  if (other) {
    conversationBackground.textContent = `${other.title} · ${other.state === "running" ? "后台运行中" : other.state === "user" ? "现在归你" : "已结束"} ↗`;
    conversationBackground.onclick = () => selectConversation(other.id);
  }
}

function resetConversationRender(): void {
  if (currentRun) clearInterval(currentRun.timer);
  closeBlocks();
  currentRun = null;
  lastRun = null;
  runStartAt = 0;
  toolChips.clear();
  sessionRun.clear();
  teamView = null;
  running = false;
  lastUserHasPage = false;
  lastHistorySeq = 0;
  historyPrimed = false;
  messagesEl.replaceChildren();
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, "idle");
  companion.onTakeover(false);
}

function selectConversation(id: string, notify = true): void {
  completedConversations.delete(id);
  conversationMenu.hidden = true;
  conversationSwitcher.setAttribute("aria-expanded", "false");
  if (id !== selectedConversationId || !conversationReady) {
    if (conversationReady) saveDraft();
    selectedConversationId = id;
    conversationReady = true;
    draftRevision += 1;
    resetConversationRender();
    restoringDraft = true;
    inputEl.value = "";
    pendingAsk = null;
    if (askCiteEl) askCiteEl.hidden = true;
    attachments.restore([], id);
    restoringDraft = false;
    const summary = conversations.get(id);
    if (summary) applyMode(summary.mode, false);
    closeModelPopover();
    modelState = null;
    renderModelPicker();
    void restoreDraft(id).catch(() => addMsg("msg error", "未能恢复这段会话的输入草稿。"));
  }
  renderConversations();
  if (notify) port?.postMessage({ kind: "select_conversation", conversationId: id } satisfies PanelToBg);
  port?.postMessage({ kind: "sync", conversationId: id, afterSeq: lastHistorySeq } satisfies PanelToBg);
}

conversationSwitcher.onclick = () => {
  conversationMenu.hidden = !conversationMenu.hidden;
  conversationSwitcher.setAttribute("aria-expanded", String(!conversationMenu.hidden));
};
conversationNew.onclick = () => {
  if (!conversationReady || conversationRequest) return;
  saveDraft();
  conversationRequest = crypto.randomUUID();
  renderConversations();
  send({ type: "conversation_create", requestId: conversationRequest });
};
document.addEventListener("click", (e) => {
  if (!conversationMenu.contains(e.target as Node) && !conversationSwitcher.contains(e.target as Node)) {
    conversationMenu.hidden = true;
    conversationSwitcher.setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !conversationMenu.hidden) {
    conversationMenu.hidden = true;
    conversationSwitcher.setAttribute("aria-expanded", "false");
    conversationSwitcher.focus();
  }
});
const morphSheet = document.getElementById("morph-sheet") as HTMLElement | null;
const closeMorphSheetBtn = document.getElementById("close-morph-sheet") as HTMLButtonElement | null;
const tabIconSq = document.getElementById("tab-icon-sq") as HTMLElement | null;
const tabTitleText = document.getElementById("tab-title-text") as HTMLElement | null;
const morphSheetTitle = document.getElementById("morph-sheet-title") as HTMLElement | null;
const morphSheetUrl = document.getElementById("morph-sheet-url") as HTMLElement | null;
const morphSheetStatus = document.getElementById("morph-sheet-status") as HTMLElement | null;

const morphSend = sendBtn.querySelector(".morph-icon-send");
const morphStop = sendBtn.querySelector(".morph-icon-stop");
if (morphSend) morphSend.appendChild(icon(ArrowUp));
if (morphStop) morphStop.appendChild(icon(Square));
abortBtn.appendChild(icon(Square));
teachToggle.appendChild(icon(GraduationCap));

function clipTitle(text: string, max = 16): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

async function refreshActiveTabPill(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    if (tabTitleText) tabTitleText.textContent = "浏览器活动标签页";
    return;
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    const title = tab.title || tab.url || "未知页面";
    let host = "";
    try {
      if (tab.url) host = new URL(tab.url).host;
    } catch {
      // ignore
    }
    const displayLabel = host ? `${host} · ${clipTitle(title, 14)}` : clipTitle(title, 20);
    if (tabTitleText) tabTitleText.textContent = displayLabel;
    if (tabIconSq) {
      if (tab.favIconUrl && tab.favIconUrl.startsWith("http")) {
        tabIconSq.innerHTML = `<img src="${DOMPurify.sanitize(tab.favIconUrl)}" style="width:12px;height:12px;border-radius:2px;object-fit:cover;" alt="" />`;
      } else {
        const letter = (host || title || "W").replace(/^www\./, "").charAt(0).toUpperCase();
        tabIconSq.textContent = letter;
      }
    }
    if (morphSheetTitle) morphSheetTitle.textContent = `标题：${title}`;
    if (morphSheetUrl) morphSheetUrl.textContent = `URL：${tab.url || "-"}`;
    if (morphSheetStatus) morphSheetStatus.textContent = `状态：${tab.status === "complete" ? "已就绪 (complete)" : "加载中 (loading)"}`;
  } catch {
    if (tabTitleText) tabTitleText.textContent = "活动标签页就绪";
  }
}

function toggleMorphSheet(open?: boolean): void {
  if (!morphSheet) return;
  const willOpen = open !== undefined ? open : morphSheet.style.display === "none" || !morphSheet.style.display;
  morphSheet.style.display = willOpen ? "flex" : "none";
  if (willOpen) void refreshActiveTabPill();
}

pagePill?.addEventListener("click", () => toggleMorphSheet());
closeMorphSheetBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleMorphSheet(false);
});
document.addEventListener("click", (e) => {
  if (
    morphSheet &&
    morphSheet.style.display === "flex" &&
    !morphSheet.contains(e.target as Node) &&
    !pagePill?.contains(e.target as Node)
  ) {
    toggleMorphSheet(false);
  }
});

if (typeof chrome !== "undefined" && chrome.tabs) {
  chrome.tabs.onActivated?.addListener(() => void refreshActiveTabPill());
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status || changeInfo.title || changeInfo.url) {
      void refreshActiveTabPill();
    }
  });
}
void refreshActiveTabPill();

const companion = mountCompanion({
  appEl: app,
  composerEl,
  inputEl,
  messagesEl,
  pagePillEl: pagePill,
});

// ── 教学模式开关 ───────────────────────────────────────────────────
// 开关状态存 chrome.storage.local（面板重开恢复显示）；运行时权威在 background
// （chrome.storage.session），background 推来的 mode 消息会反向收敛本地存储。

const MARK_MOTION_KEY = "sideagent_mark_motion";
type MarkMotion = "grow" | "boil";
let markMotion: MarkMotion = "grow";
let teachMode = false;

function renderTeachToggle(): void {
  teachToggle.classList.toggle("on", teachMode);
  teachToggle.setAttribute("aria-pressed", String(teachMode));
  const motionLabel = markMotion === "boil" ? "持续微抖" : "生长定格";
  teachToggle.title = teachMode
    ? `教学模式已开启（手绘动效：${motionLabel}，右击切换）：Agent 只标注引导，由你手动操作（点击关闭）`
    : `教学模式：Agent 只标注引导，由你手动操作（点击开启，右击切换手绘动效：${motionLabel}）`;
}

function applyMode(mode: AgentMode, persist: boolean): void {
  teachMode = mode === "teach";
  renderTeachToggle();
  if (persist) void chrome.storage.local.set({ [TEACH_MODE_KEY]: teachMode });
}

void chrome.storage.local.get([TEACH_MODE_KEY, MARK_MOTION_KEY]).then((stored) => {
  if (stored[MARK_MOTION_KEY] === "boil" || stored[MARK_MOTION_KEY] === "grow") {
    markMotion = stored[MARK_MOTION_KEY];
  }
  applyMode(stored[TEACH_MODE_KEY] === true ? "teach" : "act", false);
});

teachToggle.onclick = () => {
  applyMode(teachMode ? "act" : "teach", true);
  send({ type: "set_mode", mode: teachMode ? "teach" : "act" });
};

teachToggle.oncontextmenu = (ev) => {
  ev.preventDefault();
  markMotion = markMotion === "grow" ? "boil" : "grow";
  void chrome.storage.local.set({ [MARK_MOTION_KEY]: markMotion });
  renderTeachToggle();
};

// ── 模型选择器 ─────────────────────────────────────────────────────
// 芯片在输入区左下；数据源是 agent 下发的 hello_ok.models / model_info。
// 选择后发 set_model，等 agent 回 model_info 再更新显示。

/** 当前模型信息：model = "provider/id"，models = 可选列表（已配置凭据的 provider）。 */
let modelState: { model?: string; models: ModelOption[] } | null = null;
let modelQuery = "";

function closeModelPopover(): void {
  modelPopover.hidden = true;
  modelBtn.setAttribute("aria-expanded", "false");
}

function paintMark(el: HTMLElement, provider: string | undefined): void {
  if (!provider) {
    el.hidden = true;
    return;
  }
  const { letter, hue } = providerMark(provider);
  el.hidden = false;
  el.textContent = letter;
  el.style.background = `hsl(${hue} 42% 44%)`;
}

function currentProvider(): string | undefined {
  const id = modelState?.model;
  if (!id) return undefined;
  return modelState?.models.find((m) => m.id === id)?.provider ?? id.split("/")[0];
}

function positionModelPopover(): void {
  const composer = document.getElementById("composer")!;
  const appBox = app.getBoundingClientRect();
  const box = composer.getBoundingClientRect();
  modelPopover.style.bottom = `${appBox.bottom - box.top + 8}px`;
}

function modelSearchInput(): HTMLInputElement | null {
  return modelPopover.querySelector(".model-search-input");
}

function ensurePopoverChrome(): HTMLElement {
  let list = modelPopover.querySelector(".model-list") as HTMLElement | null;
  if (list) return list;
  const search = document.createElement("div");
  search.className = "model-search";
  const searchIcon = document.createElement("span");
  searchIcon.className = "model-search-icon";
  searchIcon.appendChild(icon(Search));
  const input = document.createElement("input");
  input.type = "search";
  input.className = "model-search-input";
  input.placeholder = "搜索模型…";
  input.setAttribute("aria-label", "搜索模型");
  input.autocomplete = "off";
  input.addEventListener("input", () => {
    modelQuery = input.value;
    renderModelList();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      moveModelHighlight(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const cur = modelPopover.querySelector(".model-item.current-nav") as HTMLButtonElement | null;
      cur?.click();
    }
  });
  search.append(searchIcon, input);
  list = document.createElement("div");
  list.className = "model-list";
  list.setAttribute("role", "listbox");
  modelPopover.replaceChildren(search, list);
  return list;
}

function visibleModelButtons(): HTMLButtonElement[] {
  return [...modelPopover.querySelectorAll<HTMLButtonElement>(".model-item")];
}

function moveModelHighlight(delta: number): void {
  const items = visibleModelButtons();
  if (items.length === 0) return;
  const idx = items.findIndex((el) => el.classList.contains("current-nav"));
  const next = items[(idx < 0 ? (delta > 0 ? 0 : items.length - 1) : idx + delta + items.length) % items.length]!;
  items.forEach((el) => el.classList.toggle("current-nav", el === next));
  next.scrollIntoView({ block: "nearest" });
}

function renderModelList(): void {
  const list = ensurePopoverChrome();
  const models = filterModels(modelState?.models ?? [], modelQuery);
  list.replaceChildren();
  if (models.length === 0) {
    const empty = document.createElement("div");
    empty.className = "model-empty";
    empty.textContent = modelQuery.trim() ? "无匹配模型" : "暂无可用模型";
    list.appendChild(empty);
    return;
  }
  for (const group of groupModelsByProvider(models)) {
    const header = document.createElement("div");
    header.className = "model-group";
    header.textContent = providerLabel(group.provider);
    list.appendChild(header);
    for (const m of group.models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-item";
      item.dataset.model = m.id;
      item.title = m.id;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(m.id === modelState?.model));
      if (m.id === modelState?.model) item.classList.add("current");
      const mark = document.createElement("span");
      mark.className = "model-mark";
      paintMark(mark, m.provider);
      const label = document.createElement("span");
      label.className = "model-label";
      label.textContent = displayName(m);
      item.append(mark, label);
      // 无可信能力证据时不渲染能力标签（issue #2 / 验收 B2）
      const meta = modelReasoningMeta(m.provider, m.modelId);
      if (meta.tag) {
        const tag = document.createElement("span");
        tag.className = `reasoning-tag tag-${meta.tier}`;
        tag.textContent = meta.tag;
        item.append(tag);
      }
      const check = document.createElement("span");
      check.className = "model-check";
      if (m.id === modelState?.model) check.appendChild(icon(Check));
      item.append(check);
      item.onclick = () => {
        closeModelPopover();
        if (m.id !== modelState?.model) send({ type: "set_model", model: m.id });
      };
      list.appendChild(item);
    }
  }
  const current = list.querySelector(".model-item.current") ?? list.querySelector(".model-item");
  current?.classList.add("current-nav");
}

function renderModelPicker(): void {
  const models = modelState?.models ?? [];
  const model = modelState?.model;
  modelBtn.hidden = !model && models.length === 0;
  modelBtn.disabled = models.length === 0;
  modelName.textContent = chipLabel(model, models);
  modelBtn.title = model ? `切换模型（${model}）` : "切换模型";
  const provider = currentProvider();
  paintMark(modelMark, provider);

  if (modelReasoningTag) {
    if (model) {
      const found = models.find((m) => m.id === model);
      const prov = found?.provider ?? provider ?? "";
      const modelId = found?.modelId ?? (model.includes("/") ? model.split("/")[1]! : model);
      const meta = modelReasoningMeta(prov, modelId);
      // 无可信能力证据时芯片同样不显示能力标签（issue #2 / 验收 B2）
      modelReasoningTag.hidden = !meta.tag;
      if (meta.tag) {
        modelReasoningTag.textContent = meta.tag;
        modelReasoningTag.className = `reasoning-tag tag-${meta.tier}`;
      }
    } else {
      modelReasoningTag.hidden = true;
    }
  }

  if (models.length === 0) {
    closeModelPopover();
    return;
  }
  if (!modelPopover.hidden) renderModelList();
}

function applyModelInfo(model: string | undefined, models: ModelOption[] | undefined): void {
  modelState = { model: model ?? modelState?.model, models: models ?? modelState?.models ?? [] };
  renderModelPicker();
}

modelBtn.appendChild(icon(ChevronDown));
modelBtn.onclick = () => {
  const opening = modelPopover.hidden;
  if (opening) {
    modelQuery = "";
    const input = modelSearchInput();
    if (input) input.value = "";
    renderModelList();
    positionModelPopover();
    modelPopover.hidden = false;
    modelBtn.setAttribute("aria-expanded", "true");
    queueMicrotask(() => modelSearchInput()?.focus());
  } else {
    closeModelPopover();
  }
};
document.addEventListener("click", (e) => {
  if (!modelPopover.hidden && !modelPopover.contains(e.target as Node) && !modelBtn.contains(e.target as Node)) {
    closeModelPopover();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || modelPopover.hidden) return;
  const input = modelSearchInput();
  if (input && input.value) {
    input.value = "";
    modelQuery = "";
    renderModelList();
    input.focus();
    return;
  }
  closeModelPopover();
});

let port: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;
let lastDisconnectDetail = "";
let running = false;
let applyingHistory = false;
let historyPrimed = false;
let lastUserHasPage = false;
let currentAssistant: HTMLElement | null = null;
let currentAssistantText = "";
let currentThinking: HTMLElement | null = null;
let currentThinkingDetails: HTMLDetailsElement | null = null;
let currentThinkingStart = 0;
/** 用户发消息时刻：run 计时的起点（块体懒创建，先记时间戳）。 */
let runStartAt = 0;
interface WorkerLane {
  root: HTMLDetailsElement;
  body: HTMLElement;
  chainEl: HTMLElement;
  chain: StepChain;
  chipGroup: ChipGroup | null;
  lastLine: HTMLElement;
  face: HTMLElement;
  status: HTMLElement;
  waiting: boolean;
  grok: GrokHandle | null;
  awaiting: Set<string>;
}

/** 当前 run 的"执行步骤"聚合块。 */
interface RunHost {
  root: HTMLDetailsElement;
  body: HTMLElement;
  iconBox: HTMLElement;
  chainEl: HTMLElement;
  timeEl: HTMLElement;
  chain: StepChain;
  start: number;
  /** 像素格 loader（运行中常驻 body 底部）。 */
  loader: HTMLElement;
  loaderElapsed: HTMLElement;
  loaderSub: HTMLElement;
  /** 耗时读数 interval；finishRun 必清，防泄漏。 */
  timer: number;
  /** 最近一个工具的中文动作名（loader 副标题）。 */
  lastToolShort: string | null;
  /** 当前 chip 分组；思考块插入后另起一组。 */
  chipGroup: ChipGroup | null;
  workers: Map<string, WorkerLane>;
}

/** 当前 run；run 外为 null。 */
let currentRun: RunHost | null = null;
/** finishRun 刚收掉的那一块。全员 idle 后到达的 agent_end 复用它，禁止再开 loader。 */
let lastRun: RunHost | null = null;

/** 一段连续工具调用的 chip 行 + 共享详情区（最多展开一个）。 */
interface ChipGroup {
  root: HTMLElement;
  row: HTMLElement;
  detail: HTMLElement;
  expanded: ToolChipEntry | null;
}

interface ToolChipEntry {
  chip: HTMLButtonElement;
  dot: HTMLElement;
  dur: HTMLElement;
  start: number;
  name: string;
  paramsText: string;
  resultText: string;
  group: ChipGroup;
}

const toolChips = new Map<string, ToolChipEntry>();

/** 工具名 → 图标；未知名称回退扳手。 */
const TOOL_ICONS = new Map<string, Parameters<typeof icon>[0]>([
  ["click", MousePointerClick],
  ["fill", PenLine],
  ["page_operation", PenLine],
  ["share_tab", Users],
  ["type_text", Keyboard],
  ["press_key", Keyboard],
  ["scroll", ArrowDownUp],
  ["snapshot", ScanSearch],
  ["read_element", ScanSearch],
  ["screenshot", Camera],
  ["js", CodeXml],
  ["navigate", Globe],
  ["open_tab", Globe],
  ["list_tabs", List],
  ["switch_tab", List],
  ["close_tab", List],
  ["mark", Tag],
  ["clear_marks", Eraser],
  ["spawn_worker", Users],
  ["list_workers", Users],
  ["stop_worker", Square],
  ["post", Send],
  ["await_message", Inbox],
]);

// ── 渲染 ───────────────────────────────────────────────────────────

function setStatus(mode: "off" | "on" | "retry", text: string): void {
  statusDot.className = `dot island-pulse-dot${mode === "on" ? " on" : mode === "retry" ? " retry" : ""}`;
  statusText.textContent = text;
  const pill = document.getElementById("status-pill");
  if (pill) {
    pill.classList.toggle("status-on", mode === "on");
    pill.classList.toggle("status-retry", mode === "retry");
    pill.classList.toggle("status-off", mode === "off");
  }
}

// 跟随滚动：用户上翻后不再强拉到底，右下角浮出"回到底部"圆钮
const toBottomBtn = document.createElement("button");
toBottomBtn.id = "to-bottom";
toBottomBtn.type = "button";
toBottomBtn.title = "回到底部";
toBottomBtn.hidden = true;
toBottomBtn.appendChild(icon(ArrowDown));
app.appendChild(toBottomBtn);

let pinned = true;

function nearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

messagesEl.addEventListener("scroll", () => {
  pinned = nearBottom();
  toBottomBtn.hidden = pinned;
});

function scrollToEnd(force = false): void {
  if (force || pinned) messagesEl.scrollTop = messagesEl.scrollHeight;
  toBottomBtn.hidden = nearBottom();
}

toBottomBtn.onclick = () => {
  pinned = true;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  toBottomBtn.hidden = true;
};

function addUserMsg(text: string, atts?: Attachment[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg user";
  if (atts && atts.length > 0) {
    const thumbs = document.createElement("div");
    thumbs.className = "user-msg-attachments";
    for (const att of atts) {
      if (att.type === "image") {
        const img = document.createElement("img");
        img.className = "user-msg-img-thumb";
        img.src = `data:${att.mimeType};base64,${att.dataBase64}`;
        img.alt = att.name || "图片附件";
        img.title = att.name || "点击查看原图";
        img.onclick = (e) => {
          e.stopPropagation();
          window.open(img.src, "_blank");
        };
        thumbs.appendChild(img);
      }
    }
    div.appendChild(thumbs);
  }
  if (text) {
    const textEl = document.createElement("div");
    textEl.className = "user-msg-text";
    textEl.textContent = text;
    div.appendChild(textEl);
  } else if (!atts || atts.length === 0) {
    div.textContent = "";
  }
  messagesEl.appendChild(div);
  if (!applyingHistory) {
    companion.onSend(div);
  }
  scrollToEnd();
  return div;
}

function addMsg(cls: string, text: string): HTMLElement {
  if (cls.split(/\s+/).includes("user")) {
    return addUserMsg(text);
  }
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToEnd();
  return div;
}

// ── 执行步骤聚合块 ──────────────────────────────────────────
// 一次 run（用户消息 → agent_end）中的思考块与工具 chips 收进同一个 details；
// 块懒创建于首个步骤事件，运行中展开，结束后折叠并标注总耗时。
// 运行中的等待态用像素格 loader（相位波纹 + 实时耗时 + 当前动作副标题）。

/** 5×5 像素格 loader：相位波纹动画 + 0.1s 精度耗时 + 当前动作副标题。 */
function buildPixelLoader(): { root: HTMLElement; elapsed: HTMLElement; sub: HTMLElement } {
  const root = document.createElement("div");
  root.className = "px-wrap";
  const grid = document.createElement("div");
  grid.className = "px-grid";
  for (let i = 0; i < 25; i++) {
    const cell = document.createElement("i");
    cell.style.animationDelay = `${pixelDelay(i)}s`;
    grid.appendChild(cell);
  }
  const meta = document.createElement("div");
  meta.className = "px-meta";
  const line = document.createElement("div");
  line.append("处理中 · ");
  const elapsed = document.createElement("span");
  elapsed.className = "px-elapsed";
  elapsed.textContent = "0.0s";
  line.appendChild(elapsed);
  const sub = document.createElement("div");
  sub.className = "px-sub";
  sub.textContent = loaderSubtitle(null);
  meta.append(line, sub);
  root.append(grid, meta);
  return { root, elapsed, sub };
}

function ensureRun(): NonNullable<typeof currentRun> {
  if (currentRun) return currentRun;
  const root = document.createElement("details");
  root.className = "run-steps";
  root.open = true;
  const summary = document.createElement("summary");
  const iconBox = document.createElement("span");
  iconBox.className = "run-icon";
  const title = document.createElement("span");
  title.className = "run-title";
  title.textContent = "执行步骤";
  const chainEl = document.createElement("span");
  chainEl.className = "run-chain";
  const timeEl = document.createElement("span");
  timeEl.className = "run-time";
  const chevron = document.createElement("span");
  chevron.className = "run-chevron";
  chevron.appendChild(icon(ChevronDown));
  summary.append(iconBox, title, chainEl, timeEl, chevron);
  const body = document.createElement("div");
  body.className = "run-body";
  root.append(summary, body);
  messagesEl.appendChild(root);
  const start = runStartAt || eventTime();
  const { root: loader, elapsed: loaderElapsed, sub: loaderSub } = buildPixelLoader();
  loaderElapsed.textContent = recordedDuration(start, eventTime()) ?? "";
  body.appendChild(loader);
  // 耗时读数 100ms 刷新；reduced-motion 只停格子动画，读数照常
  const timer = window.setInterval(() => {
    loaderElapsed.textContent = recordedDuration(start, Date.now()) ?? "";
  }, 100);
  currentRun = {
    root,
    body,
    iconBox,
    chainEl,
    timeEl,
    chain: new StepChain(),
    start,
    loader,
    loaderElapsed,
    loaderSub,
    timer,
    lastToolShort: null,
    chipGroup: null,
    workers: new Map(),
  };
  if (!applyingHistory) companion.onStepStart(root);
  return currentRun;
}

function castAsset(file: string): string {
  return typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL(`cast/${file}`)
    : `cast/${file}`;
}

function paintLaneFace(lane: WorkerLane, id: string): void {
  const person = personFor(id);
  if (!person) return;
  lane.grok?.destroy();
  lane.grok = null;
  const kenney = (lane.waiting && person.kenneyWait) || person.kenney;
  if (kenney) {
    mountKenney(lane.face, castAsset(kenney.body), castAsset(kenney.face), 32);
    return;
  }
  lane.grok = mountGrok(lane.face, person, 32);
  lane.grok.setWaiting(lane.waiting);
}

function setLaneWaiting(lane: WorkerLane, id: string, waiting: boolean): void {
  if (lane.waiting === waiting) return;
  lane.waiting = waiting;
  const person = personFor(id);
  lane.status.textContent = waiting ? (person?.waitLine ?? "") : "";
  lane.status.hidden = !waiting;
  paintLaneFace(lane, id);
}

function ensureWorkerLane(id: string, run: RunHost): WorkerLane {
  const existing = run.workers.get(id);
  if (existing) return existing;
  const person = personFor(id);
  const root = document.createElement("details");
  root.className = "worker-lane";
  root.open = true;
  root.style.setProperty("--worker-c", cursorColor(id));
  const summary = document.createElement("summary");
  const face = document.createElement("span");
  face.className = "worker-face";
  const meta = document.createElement("div");
  meta.className = "worker-meta";
  const idrow = document.createElement("div");
  idrow.className = "worker-idrow";
  const name = document.createElement("span");
  name.className = "worker-name";
  name.textContent = displayNameFor(id);
  const status = document.createElement("span");
  status.className = "worker-status";
  status.hidden = true;
  idrow.append(name, status);
  const chainEl = document.createElement("span");
  chainEl.className = "worker-chain";
  meta.append(idrow, chainEl);
  summary.append(face, meta);
  const body = document.createElement("div");
  body.className = "worker-body";
  const lastLine = document.createElement("div");
  lastLine.className = "worker-last";
  lastLine.hidden = true;
  body.appendChild(lastLine);
  root.append(summary, body);
  if (run.loader.isConnected && run.loader.parentElement === run.body) {
    run.body.insertBefore(root, run.loader);
  } else {
    run.body.appendChild(root);
  }
  const lane: WorkerLane = {
    root,
    body,
    chainEl,
    chain: new StepChain(),
    chipGroup: null,
    lastLine,
    face,
    status,
    waiting: false,
    grok: null,
    awaiting: new Set(),
  };
  if (person) paintLaneFace(lane, id);
  run.workers.set(id, lane);
  return lane;
}

/**
 * 工人事件进哪条车道。图已 idle 时只复用刚收掉的块，绝不 ensureRun（否则「处理中」空转）。
 */
function laneForWorker(id: string): { lane: WorkerLane; run: RunHost; live: boolean } | null {
  const policy = workerEventRunPolicy({
    hasCurrentRun: currentRun != null,
    graphRunning: running,
    hasLastRun: lastRun != null,
  });
  if (policy === "drop") return null;
  if (policy === "reuse-last") {
    const run = lastRun;
    if (!run) return null;
    const lane = run.workers.get(id);
    return lane ? { lane, run, live: false } : null;
  }
  const run = policy === "current" && currentRun ? currentRun : ensureRun();
  return { lane: ensureWorkerLane(id, run), run, live: true };
}

const sessionRun = new Map<string, AgentRunState>();
let teamView: TeamView | null = null;

function setTeamView(next: TeamView | null): void {
  teamView = next;
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, sessionRun.get(LEAD_SESSION_ID) ?? (next ? "user" : "idle"));
}

function renderTeamCard(): void {
  const el = document.getElementById("team-card");
  if (!el) return;
  const view = teamView;
  if (!shouldShowTeamCard(view?.phase)) {
    el.hidden = true;
    el.replaceChildren();
    return;
  }
  el.hidden = false;
  const summary = document.createElement("div");
  summary.className = "team-summary";
  const title = document.createElement("strong");
  title.textContent = teamSummaryLabel(view!);
  const detail = document.createElement("button");
  detail.type = "button";
  detail.className = "team-detail";
  detail.textContent = "详情";
  summary.append(title, detail);
  const roster = document.createElement("div");
  roster.className = "team-roster";
  roster.hidden = true;
  for (const m of view!.members) {
    const row = document.createElement("div");
    row.className = "team-member";
    const dot = document.createElement("i");
    dot.className = "team-dot";
    dot.style.background = m.role === "lead" ? LEAD_COLOR : displayColor(m.sessionId);
    const name = document.createElement("span");
    name.textContent = `${m.role === "lead" ? "Lead" : displayNameFor(m.sessionId)} · ${memberBoundPageLabel(m)}`;
    const st = document.createElement("em");
    st.textContent = memberStatusLabel(m);
    if (m.phase === "paused_tab_closed" || m.phase === "paused_snapshot_failed" || m.phase === "aborted") {
      st.classList.add("warn");
    }
    row.append(dot, name, st);
    roster.appendChild(row);
  }
  detail.onclick = () => {
    roster.hidden = !roster.hidden;
    detail.textContent = roster.hidden ? "详情" : "收起";
  };
  el.replaceChildren(summary, roster);
}

function setSessionState(sessionId: string, state: AgentRunState): void {
  sessionRun.set(sessionId, state);
  const flags = panelLive(sessionRun.values(), teamView);
  running = flags.running;
  if (flags.userHasPage !== lastUserHasPage) {
    lastUserHasPage = flags.userHasPage;
    companion.onTakeover(flags.userHasPage);
  }
  takeoverBtn.hidden = !flags.takeoverVisible;
  abortBtn.hidden = !flags.abortVisible;
  // Send / Stop in-place morphing
  if (flags.abortVisible) {
    sendBtn.classList.add("stopping");
    sendBtn.title = "中止";
    sendBtn.hidden = false;
  } else {
    sendBtn.classList.remove("stopping");
    sendBtn.title = "发送";
    sendBtn.hidden = !flags.sendVisible;
  }
  const statusPill = document.getElementById("status-pill");
  if (statusPill) {
    statusPill.classList.toggle("running", flags.live);
  }
  inputEl.placeholder =
    teamView?.phase === "draining"
      ? PLACEHOLDER_DRAINING
      : teamView?.phase === "partial" || teamView?.phase === "restoring"
        ? PLACEHOLDER_PARTIAL
        : flags.composer === "user"
          ? PLACEHOLDER_USER
          : flags.composer === "running"
            ? PLACEHOLDER_RUNNING
            : PLACEHOLDER_IDLE;
  if (flags.userHasPage && currentRun) {
    clearInterval(currentRun.timer);
    currentRun.loader.remove();
  }
  if (flags.finishRun) {
    closeBlocks();
    finishRun();
    sessionRun.clear();
    renderTeamCard();
  }
}

function addChainStep(label: string): void {
  const run = ensureRun();
  run.chain.push(label);
  run.chainEl.textContent = run.chain.render();
}

function finishRun(): void {
  const run = currentRun;
  currentRun = null;
  runStartAt = 0;
  if (!run) return;
  lastRun = run;
  // 耗时读数 interval 立即停掉：run 完成/中断/空 run 都不留泄漏
  clearInterval(run.timer);
  run.loader.remove();
  // 空 run（纯文本回复，无思考/工具步骤）不留壳
  if (run.body.childElementCount === 0) {
    run.root.remove();
    if (lastRun === run) lastRun = null;
    if (!applyingHistory) companion.onRunFinish();
    return;
  }
  run.root.classList.add("done");
  run.iconBox.replaceChildren(icon(CircleCheck));
  const duration = recordedDuration(run.start, eventTime());
  run.timeEl.textContent = duration ? `耗时 ${duration}` : "";
  run.root.open = false;
  if (!applyingHistory) companion.onRunFinish();
  scrollToEnd();
}

/** 步骤容器：run 进行中进聚合块，否则直接进消息流。 */
function stepsContainer(): HTMLElement {
  return currentRun?.body ?? messagesEl;
}

function closeBlocks(): void {
  // 流式光标移除；进行中的思考块折叠并落定文案（带耗时）
  document.querySelector(".msg.assistant.streaming")?.classList.remove("streaming");
  if (currentThinkingDetails) {
    currentThinkingDetails.classList.remove("streaming");
    currentThinkingDetails.open = false;
    const label = currentThinkingDetails.querySelector("summary span");
    if (label) {
      label.textContent = currentThinkingStart
        ? `思考过程${recordedDuration(currentThinkingStart, eventTime()) ? ` ${recordedDuration(currentThinkingStart, eventTime())}` : ""}`
        : "思考过程";
    }
  }
  currentAssistant = null;
  currentAssistantText = "";
  currentThinking = null;
  currentThinkingDetails = null;
  currentThinkingStart = 0;
}

function appendDelta(kind: "assistant" | "thinking", delta: string): void {
  if (kind === "assistant") {
    // 流式 Markdown：累积原文，每个 delta 重渲染（marked 为同步解析，量小无压力）
    if (!currentAssistant) currentAssistant = addMsg("msg assistant markdown streaming", "");
    currentAssistantText += delta;
    currentAssistant.innerHTML = renderMarkdown(currentAssistantText);
  } else {
    if (!currentThinking) {
      addChainStep("思考");
      currentThinkingStart = eventTime();
      const details = document.createElement("details");
      details.className = "thinking streaming";
      details.open = true;
      const summary = document.createElement("summary");
      summary.appendChild(icon(Brain));
      const label = document.createElement("span");
      label.textContent = "正在思考…";
      summary.appendChild(label);
      const pre = document.createElement("pre");
      details.append(summary, pre);
      stepsContainer().appendChild(details);
      // 新思考块隔开前后工具调用：另起 chip 分组；loader 保持在 body 底部
      if (currentRun) {
        currentRun.chipGroup = null;
        currentRun.body.appendChild(currentRun.loader);
      }
      currentThinking = pre;
      currentThinkingDetails = details;
    }
    currentThinking.appendChild(document.createTextNode(delta));
  }
  scrollToEnd();
}

function shortParams(params: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(params);
    return s.length > 200 ? `${s.slice(0, 197)}...` : s;
  } catch {
    return "";
  }
}

// ── Tool Chips ───────────────────────────────────────────────
// 一段连续的工具调用收进一个 chip 组：chips 行（可换行）+ 共享详情区。
// 点击 chip 就地展开参数/结果，再点收起；一组内最多展开一个。

function buildChipGroup(host: HTMLElement, before?: HTMLElement | null): ChipGroup {
  const root = document.createElement("div");
  root.className = "chip-group";
  const row = document.createElement("div");
  row.className = "chip-row";
  const detail = document.createElement("div");
  detail.className = "chip-detail";
  detail.hidden = true;
  root.append(row, detail);
  if (before) host.insertBefore(root, before);
  else host.appendChild(root);
  return { root, row, detail, expanded: null };
}

/** 详情区内容：弱化原始名 + 参数 + 结果（复用原工具卡的文本与截断规则）。 */
function renderChipDetail(entry: ToolChipEntry): void {
  const detail = entry.group.detail;
  detail.replaceChildren();
  const raw = document.createElement("div");
  raw.className = "raw";
  raw.textContent = entry.name;
  detail.appendChild(raw);
  if (entry.paramsText) {
    const pre = document.createElement("pre");
    pre.textContent = entry.paramsText;
    detail.appendChild(pre);
  }
  if (entry.resultText) {
    const pre = document.createElement("pre");
    pre.className = "result";
    pre.textContent = entry.resultText;
    detail.appendChild(pre);
  }
}

function toggleChipDetail(entry: ToolChipEntry): void {
  const group = entry.group;
  if (group.expanded === entry) {
    group.expanded = null;
    entry.chip.classList.remove("active");
    group.detail.hidden = true;
    return;
  }
  group.expanded?.chip.classList.remove("active");
  group.expanded = entry;
  entry.chip.classList.add("active");
  renderChipDetail(entry);
  group.detail.hidden = false;
  scrollToEnd();
}

function onToolStart(
  ev: { toolCallId: string; name: string; params: Record<string, unknown> },
  sessionId?: string,
): void {
  const action = describeTool(ev.name, ev.params);
  let run: RunHost;
  let group: ChipGroup;
  let live = true;
  if (sessionId && !isLeadSession(sessionId)) {
    const found = laneForWorker(sessionId);
    if (!found) return;
    found.lane.chain.push(action.short);
    found.lane.chainEl.textContent = found.lane.chain.render();
    if (!found.lane.chipGroup) found.lane.chipGroup = buildChipGroup(found.lane.body, found.lane.lastLine);
    group = found.lane.chipGroup;
    run = found.run;
    live = found.live;
    if (live) run.lastToolShort = `${displayNameFor(sessionId)} · ${action.short}`;
    if (ev.name === "await_message") {
      found.lane.awaiting.add(ev.toolCallId);
      setLaneWaiting(found.lane, sessionId, true);
    }
  } else {
    run = ensureRun();
    closeBlocks();
    addChainStep(action.short);
    run.lastToolShort = action.short;
    if (!run.chipGroup) run.chipGroup = buildChipGroup(run.body);
    group = run.chipGroup;
  }
  if (live) {
    run.loaderSub.textContent = loaderSubtitle(run.lastToolShort);
    run.body.appendChild(run.loader);
  }

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  const dot = document.createElement("span");
  dot.className = `chip-dot ${chipState(false, false)}`;
  const iconBox = document.createElement("span");
  iconBox.className = "chip-icon";
  iconBox.appendChild(icon(TOOL_ICONS.get(ev.name) ?? Wrench));
  const label = document.createElement("span");
  label.className = "chip-label";
  label.textContent = action.full;
  const dur = document.createElement("span");
  dur.className = "dur";
  dur.hidden = true;
  chip.append(dot, iconBox, label, dur);
  const entry: ToolChipEntry = {
    chip,
    dot,
    dur,
    start: eventTime(),
    name: ev.name,
    paramsText: shortParams(ev.params),
    resultText: "",
    group,
  };
  chip.onclick = () => toggleChipDetail(entry);
  group.row.appendChild(chip);
  toolChips.set(ev.toolCallId, entry);
  scrollToEnd();
}

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string }): void {
  for (const run of [currentRun, lastRun]) {
    if (!run) continue;
    for (const [id, lane] of run.workers) {
      if (lane.awaiting.delete(ev.toolCallId)) {
        setLaneWaiting(lane, id, lane.awaiting.size > 0);
      }
    }
  }
  const entry = toolChips.get(ev.toolCallId);
  toolChips.delete(ev.toolCallId);
  if (!entry) return;
  entry.dot.className = `chip-dot ${chipState(true, ev.isError)}`;
  const duration = recordedDuration(entry.start, eventTime());
  entry.dur.hidden = duration === null;
  entry.dur.textContent = duration ?? "";
  if (ev.isError) entry.chip.classList.add("error");
  const text = ev.resultText ?? "";
  if (text) entry.resultText = text.length > 800 ? `${text.slice(0, 797)}...` : text;
  // 详情正展开着这个 chip 时实时补上结果
  if (entry.group.expanded === entry) renderChipDetail(entry);
  if (!applyingHistory) companion.onStepDone();
  scrollToEnd();
}

function handleWorkerEvent(sessionId: string, ev: AgentUiEvent): void {
  const found = laneForWorker(sessionId);
  if (!found) return;
  const { lane } = found;
  switch (ev.kind) {
    case "text_delta": {
      lane.lastLine.hidden = false;
      lane.lastLine.textContent = ((lane.lastLine.textContent ?? "") + ev.delta).slice(-280);
      break;
    }
    case "thinking_delta":
      break;
    case "tool_start":
      onToolStart(ev, sessionId);
      break;
    case "tool_end":
      onToolEnd(ev);
      break;
    case "agent_end":
      lane.root.open = false;
      lane.root.classList.add("done");
      break;
    case "notice":
    case "error":
      lane.lastLine.hidden = false;
      lane.lastLine.textContent = ev.kind === "error" ? humanizeModelError(ev.message) : ev.message;
      break;
    default:
      break;
  }
  scrollToEnd();
}

function handleAgentEvent(ev: AgentUiEvent, sessionId?: string): void {
  if (sessionId && !isLeadSession(sessionId)) {
    handleWorkerEvent(sessionId, ev);
    return;
  }
  switch (ev.kind) {
    case "text_delta":
      appendDelta("assistant", ev.delta);
      break;
    case "thinking_delta":
      appendDelta("thinking", ev.delta);
      break;
    case "tool_start":
      onToolStart(ev);
      break;
    case "tool_end":
      onToolEnd(ev);
      break;
    case "agent_start":
    case "turn_end":
      closeBlocks();
      break;
    case "agent_end":
      closeBlocks();
      break;
    case "turn_start":
      break;
    case "notice":
      addMsg("msg notice", ev.message);
      break;
    case "error":
      addMsg("msg error", humanizeModelError(ev.message));
      break;
  }
}

// ── 连接管理（panel ⇆ background Port） ────────────────────────────

function send(msg: ClientMessage): boolean {
  if (!port || !transportConnected) return false;
  const envelope: PanelToBg = { kind: "client", msg: { ...msg, conversationId: selectedConversationId } };
  try {
    port.postMessage(envelope);
    return true;
  } catch {
    return false;
  }
}

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);
  if (!msg) return;
  if (msg.type === "conversation_created" || msg.type === "conversation_updated") {
    upsertConversation(msg.conversation);
    if (msg.type === "conversation_created" && msg.requestId === conversationRequest) {
      conversationRequest = null;
      selectConversation(msg.conversation.id);
    }
    renderConversations();
    return;
  }
  if (msg.type === "conversation_list") {
    for (const c of msg.conversations) upsertConversation(c);
    renderConversations();
    return;
  }
  if (msg.conversationId && msg.conversationId !== selectedConversationId) return;
  switch (msg.type) {
    case "hello_ok":
      setStatus("on", "已连接");
      applyModelInfo(msg.model, msg.models ?? []);
      setupEl.hidden = true;
      break;
    case "model_info":
      applyModelInfo(msg.model, msg.models);
      break;
    case "hello_error":
      showSetup(msg.error);
      break;
    case "status":
      setSessionState(msg.sessionId ?? LEAD_SESSION_ID, msg.state);
      break;
    case "team_status":
      setTeamView(msg.team);
      break;
    case "agent_event":
      handleAgentEvent(msg.event, msg.sessionId);
      break;
    default:
      break;
  }
}

function handleBgMessage(envelope: BgToPanel): void {
  if (envelope.kind === "conversations") {
    for (const c of envelope.conversations) upsertConversation(c);
    if (envelope.selectedConversationId !== selectedConversationId || !conversationReady) {
      selectConversation(envelope.selectedConversationId, false);
    }
    renderConversations();
    return;
  }
  if (envelope.kind === "server") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId
      && !envelope.msg.type.startsWith("conversation_")) return;
    handleServerMessage(JSON.stringify(envelope.msg));
    return;
  }
  if (envelope.kind === "history") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    applyHistory(envelope.entries);
    return;
  }
  if (envelope.kind === "mode") {
    // background 是运行时权威：以其为准并收敛本地存储
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    applyMode(envelope.mode, false);
    return;
  }
  if (envelope.kind === "ask_selection") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    applyPendingAsk(envelope.ask);
    return;
  }
  if (envelope.kind !== "conn") return;
  // 连接状态
  transportConnected = envelope.state === "connected";
  renderConversations();
  if (envelope.state === "connected") {
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
  } else if (envelope.state === "connecting") {
    setStatus("retry", "连接中…");
  } else {
    if (shouldFinishRunOnDisconnect(panelLive(sessionRun.values(), teamView).userHasPage)) {
      closeBlocks();
      finishRun();
      sessionRun.clear();
      setTeamView(null);
    }
    conversationRequest = null;
    renderConversations();
    modelState = null;
    renderModelPicker();
    setStatus("off", "未连接");
    // 同一失败原因只提示一次，重试循环不刷屏
    if (envelope.detail && envelope.detail !== lastDisconnectDetail) {
      lastDisconnectDetail = envelope.detail;
      addMsg("msg notice", envelope.detail);
    }
    if (envelope.detail?.includes("token")) showSetup(envelope.detail);
  }
}

let lastHistorySeq = 0;
let historyOccurredAt: number | undefined;
function eventTime(): number { return historyEventTime(applyingHistory, historyOccurredAt); }

function applyHistory(entries: PanelHistoryEntry[]): void {
  const fresh: PanelHistoryEntry[] = [];
  applyingHistory = true;
  try {
    for (const entry of entries) {
      if (entry.seq <= lastHistorySeq) continue;
      fresh.push(entry);
      historyOccurredAt = entry.occurredAt;
      if (entry.item.kind === "user") {
        if (!running) runStartAt = eventTime();
        addUserMsg(entry.item.text, entry.item.attachments);
      }
      else handleServerMessage(JSON.stringify(entry.item.msg));
      lastHistorySeq = entry.seq;
    }
  } finally {
    applyingHistory = false;
    historyOccurredAt = undefined;
  }
  const replay = !historyPrimed && fresh.length > 1;
  historyPrimed = true;
  if (!replay) {
    const lastUser = [...fresh].reverse().find((e) => e.item.kind === "user");
    if (lastUser) {
      const bubble = messagesEl.querySelector(".msg.user:last-of-type");
      if (bubble) companion.onSend(bubble as HTMLElement);
    }
  }
  scrollToEnd(false);
}

function connect(): void {
  let p: chrome.runtime.Port;
  try {
    p = chrome.runtime.connect({ name: PANEL_PORT_NAME });
  } catch {
    scheduleReconnect();
    return;
  }
  port = p;
  p.onMessage.addListener((msg: BgToPanel) => handleBgMessage(msg));
  p.onDisconnect.addListener(() => {
    if (port === p) port = null;
    scheduleReconnect();
  });
  p.postMessage({ kind: "sync", ...(conversationReady ? { conversationId: selectedConversationId } : {}), afterSeq: lastHistorySeq } satisfies PanelToBg);
}

function scheduleReconnect(): void {
  setStatus("retry", "重连中…");
  const delay = Math.min(5_000, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  setTimeout(connect, delay);
}

// ── 设置界面与输入区 ───────────────────────────────────────────────

function showSetup(error?: string): void {
  setupEl.hidden = false;
  setupErr.textContent = error ?? "";
  void chrome.storage.local.get(TOKEN_KEY).then((stored) => {
    const saved = stored[TOKEN_KEY];
    tokenInput.value = typeof saved === "string" ? saved : "";
  });
  setStatus("off", "未连接");
}

setupSave.onclick = () => {
  const t = tokenInput.value.trim();
  if (!t) {
    setupErr.textContent = "请输入 token";
    return;
  }
  void chrome.storage.local.set({ [TOKEN_KEY]: t });
  setupEl.hidden = true;
  const retry: PanelToBg = { kind: "retry" };
  port?.postMessage(retry);
};

function autoResize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
  if (!modelPopover.hidden) positionModelPopover();
}

attachments = new AttachmentsManager({
  composerEl,
  stripEl: attachmentsStrip,
  inputEl,
  attachBtn,
  menuEl: attachMenu,
  fileInputEl: fileInput,
  onChanged: (count, scope) => {
    if (!scope || scope === selectedConversationId) {
      autoResize();
      saveDraft();
    } else {
      const draft = conversationDrafts.get(scope) ?? { text: "", attachments: [], ask: null };
      draft.attachments = attachments.getAttachments(scope);
      conversationDrafts.set(scope, draft);
      draftWrites = draftWrites.catch(() => {}).then(() => chrome.storage.local.set({ [DRAFT_KEY + scope]: draft }));
    }
  },
  onError: (errMsg) => {
    addMsg("msg error", errMsg);
  },
});

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function applyPendingAsk(ask: PendingAsk): void {
  pendingAsk = ask;
  if (!askCiteEl || !askCiteHost || !askCiteText) return;
  askCiteHost.textContent = hostOf(ask.url);
  askCiteText.textContent = ask.text;
  askCiteEl.hidden = false;
  inputEl.focus();
  saveDraft();
}

function clearPendingAsk(): void {
  pendingAsk = null;
  if (askCiteEl) askCiteEl.hidden = true;
  if (askCiteText) askCiteText.textContent = "";
  void chrome.storage?.session?.remove(ASK_STORE);
  saveDraft();
}

askCiteClose?.addEventListener("click", () => clearPendingAsk());

function sendInput(): void {
  if (!conversationReady || !port || panelLive(sessionRun.values(), teamView).userHasPage) return;
  const text = inputEl.value.trim();
  const pendingAtts = attachments.getAttachments();
  if (!text && pendingAtts.length === 0) return;
  // steer 归入进行中的 run，不动计时起点；新消息重开计时
  if (!running) runStartAt = Date.now();
  const context = pendingAsk
    ? {
        tabId: pendingAsk.tabId,
        title: pendingAsk.title,
        url: pendingAsk.url,
        selection: { text: pendingAsk.text },
      }
    : undefined;
  const clientAttachments = pendingAtts.length > 0 ? pendingAtts : undefined;
  const sent = send(
    running
      ? { type: "steer", text, context, attachments: clientAttachments }
      : { type: "user_message", text, context, attachments: clientAttachments },
  );
  if (!sent) return;
  inputEl.value = "";
  clearPendingAsk();
  attachments.clear();
  autoResize();
  saveDraft();
}

sendBtn.onclick = () => {
  if (sendBtn.classList.contains("stopping")) {
    send({ type: "abort" });
  } else {
    sendInput();
  }
};
inputEl.addEventListener("input", () => { autoResize(); saveDraft(); });
window.addEventListener("pagehide", saveDraft);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});
takeoverBtn.onclick = () => {
  port?.postMessage({ kind: "control", action: "takeover", conversationId: selectedConversationId } satisfies PanelToBg);
};
abortBtn.onclick = () => send({ type: "abort" });

connect();
