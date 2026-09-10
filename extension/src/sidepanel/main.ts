import { mountVoiceUI } from "./voice-ui.js";
import { createOrb, type OrbHandle } from "./orb.js";
/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 *
 * 渲染层依赖：marked（assistant 消息 Markdown 渲染）+ dompurify（消毒）+ lucide（图标）。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, GraduationCap, Search, Hand } from "lucide";
import { describeSteps, recordingHint, type DemoStep } from "../../../shared/demo-record.js";
import { skillHealth, skillRunSummary, skillStepsText, type Skill, type SkillRun } from "../../../shared/skill.js";
import { defaultIntent, describePattern, type ObservedPattern } from "../../../shared/observe.js";
import { describeAnchor } from "../../../shared/skill.js";
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
  historyEventTime,
  recordedDuration,
  loaderSubtitle,
  pixelDelay,
  workerEventRunPolicy,
  isLiveViewportPinned,
  liveViewportOverflows,
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
import type { AgentMode, AgentRunState, AgentUiEvent, Attachment, ClientMessage, ConversationSummary, ModelOption, ServerMessage, TeamView } from "../../../shared/protocol.js";
import type { UserDelivery } from "../../../shared/voice.js";
import { MEMORY_TEXT_MAX, normalizeMemoryHostname, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import { memberBoundPageLabel, memberStatusLabel, panelLive, shouldFinishRunOnDisconnect, shouldShowTeamCard, teamSummaryLabel } from "../../../shared/control.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelHistoryEntry, type PanelToBg } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";
import { MemoryManagementState, memoryScopeLabel, sameMemorySnapshot, type MemoryApplyResult } from "./memory.js";

const TOKEN_KEY = "sideagent_token";
const TEACH_MODE_KEY = "sideagent_teach_mode";
const PLACEHOLDER_IDLE = "给 By Your Side 发消息，Enter 发送，Shift+Enter 换行";
const PLACEHOLDER_RUNNING = "插话：调整 Agent 的方向…（Enter 发送）";
const PLACEHOLDER_USER = "现在归你。可补充要求，Enter 保存；交还后生效";
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
    <button id="record-toggle" type="button" title="看我做一次：你亲手做一遍，我先只看不动手" aria-pressed="false"></button>
    <div id="status-pill" class="activity-island" title="当前连接与执行状态">
      <span id="status-dot" class="dot island-pulse-dot"></span>
      <span id="status-text">未连接</span>
    </div>
  </header>
  <div id="conversation-bar">
    <button id="conversation-switcher" type="button" aria-haspopup="menu" aria-expanded="false">新会话 ▾</button>
    <button id="memory-open" type="button" aria-haspopup="dialog" aria-expanded="false">知识</button>
    <button id="conversation-new" type="button">＋ 新会话</button>
  </div>
  <button id="conversation-background" type="button" hidden></button>
  <div id="conversation-menu" role="menu" hidden></div>
  <button id="memory-shade" type="button" aria-label="关闭记忆" hidden></button>
  <section id="memory-drawer" role="dialog" aria-label="知识与记忆" aria-modal="false" hidden>
    <div class="memory-drawer-head">
      <div>
        <h2 id="memory-title">知识</h2>
        <p id="knowledge-sub">技能与记忆，都在这儿</p>
      </div>
      <button id="memory-close" type="button">关闭</button>
    </div>
    <div id="knowledge-seg" role="tablist">
      <button type="button" id="seg-skills" role="tab" aria-selected="true">技能</button>
      <button type="button" id="seg-memory" role="tab" aria-selected="false">记忆</button>
      <button type="button" id="observe-toggle" aria-pressed="false" title="观察：只记骨架，不记你输入的内容"></button>
      <span id="observe-hint"></span>
    </div>
    <div id="knowledge-body">
      <div id="skill-pane" hidden>
        <div id="observe-candidates"></div>
        <div id="skill-list"></div>
      </div>
      <div id="memory-body" hidden></div>
    </div>
  </section>
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
    <div id="demo-strip" hidden>
      <div id="demo-head">
        <span id="demo-title"></span>
        <button type="button" id="demo-close" title="收起这份示范记录">✕</button>
      </div>
      <ol id="demo-steps"></ol>
      <div id="demo-actions">
        <input id="demo-intent" type="text" maxlength="200" placeholder="一句话说明你要的是什么，例如：把未跟进的客户整理成表" />
        <button type="button" id="demo-compile">编译成脚本</button>
      </div>
      <div id="demo-skill" hidden></div>
    </div>
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
const recordToggle = document.getElementById("record-toggle") as HTMLButtonElement;
const demoStrip = document.getElementById("demo-strip") as HTMLDivElement;
const demoTitle = document.getElementById("demo-title") as HTMLSpanElement;
const demoSteps = document.getElementById("demo-steps") as HTMLOListElement;
const demoClose = document.getElementById("demo-close") as HTMLButtonElement;
const demoActions = document.getElementById("demo-actions") as HTMLDivElement;
const demoIntent = document.getElementById("demo-intent") as HTMLInputElement;
const demoCompile = document.getElementById("demo-compile") as HTMLButtonElement;
const demoSkill = document.getElementById("demo-skill") as HTMLDivElement;
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
const receiptMessages = new Map<string, HTMLElement>();
const conversationSwitcher = document.getElementById("conversation-switcher") as HTMLButtonElement;
const conversationNew = document.getElementById("conversation-new") as HTMLButtonElement;
const conversationMenu = document.getElementById("conversation-menu")!;
const conversationBackground = document.getElementById("conversation-background") as HTMLButtonElement;
const memoryOpen = document.getElementById("memory-open") as HTMLButtonElement;
const memoryShade = document.getElementById("memory-shade") as HTMLButtonElement;
const memoryDrawer = document.getElementById("memory-drawer") as HTMLElement;
const memoryClose = document.getElementById("memory-close") as HTMLButtonElement;
const memoryTitle = document.getElementById("memory-title") as HTMLElement;
const memoryBody = document.getElementById("memory-body") as HTMLElement;
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
  userBubbles.clear();
  deliveredBubbles.clear();
  receiptMessages.clear();
  leadDeliveryMode = null;
  currentLeadDraft = null;
  currentLeadDraftDetails = null;
  historyPrimed = false;
  messagesEl.replaceChildren();
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, "idle");
  companion.onTakeover(false);
}

function selectConversation(id: string, notify = true): void {
  if (id !== selectedConversationId) voiceUI.stop();
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
    clearDemoView();
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

type MemoryInspection = {
  action: Extract<AgentUiEvent, { kind: "memory" }>["action"];
  entries: MemoryEntry[];
  message?: string;
};
type MemoryEdit = {
  id: string;
  text: string;
  scopeKind: MemoryScope["kind"];
  hostname: string;
  pendingRequestId: string | null;
  error: string;
};
type MemoryForget = { id: string; pendingRequestId: string | null; error: string };
type MemoryUiRequest = { action: "list" | "update" | "forget"; entryId?: string };

const memoryState = new MemoryManagementState();
const memoryUiRequests = new Map<string, MemoryUiRequest>();
let memoryLoaded = false;
let memoryListRequestId: string | null = null;
let memoryListError = "";
let memoryInspection: MemoryInspection | null = null;
let memoryEdit: MemoryEdit | null = null;
let memoryForget: MemoryForget | null = null;
let currentMemoryHostname = "";

function memoryButton(label: string, action: string, id?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.memoryAction = action;
  if (id) button.dataset.memoryId = id;
  button.textContent = label;
  return button;
}

function memorySourceLabel(entry: MemoryEntry): string {
  const conversation = conversations.get(entry.sourceConversationId);
  return conversation?.title || "原会话";
}

function formatMemoryTime(timestamp: number): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "short", day: "numeric" }).format(timestamp);
  } catch {
    return "";
  }
}

function renderMemoryInspection(): HTMLElement | null {
  const inspection = memoryInspection;
  if (!inspection) return null;
  const section = document.createElement("section");
  section.className = "memory-inspection";
  const title = document.createElement("strong");
  title.textContent = inspection.action === "used"
    ? `这次回复使用了 ${inspection.entries.length} 条记忆`
    : inspection.action === "forgotten"
      ? "忘记记录"
      : inspection.action === "updated"
        ? "更新的记忆"
        : "保存的记忆";
  section.appendChild(title);
  if (inspection.message) {
    const message = document.createElement("p");
    message.textContent = inspection.message;
    section.appendChild(message);
  } else if (inspection.action === "forgotten") {
    const message = document.createElement("p");
    message.textContent = "这条记忆不再用于新请求。旧聊天仍然保留。";
    section.appendChild(message);
  }
  for (const snapshot of inspection.entries) {
    const item = document.createElement("div");
    item.className = "memory-inspection-item";
    const text = document.createElement("p");
    text.textContent = snapshot.text;
    const meta = document.createElement("small");
    meta.textContent = `${memoryScopeLabel(snapshot.scope)} · 版本 ${snapshot.version}`;
    item.append(text, meta);
    const current = memoryState.get(snapshot.id);
    if (!current) {
      const changed = document.createElement("small");
      changed.className = "memory-inspection-changed";
      changed.textContent = "这条记忆现已忘记。这里保留的是旧回复的使用记录。";
      item.appendChild(changed);
    } else if (!sameMemorySnapshot(snapshot, current)) {
      const changed = document.createElement("small");
      changed.className = "memory-inspection-changed";
      changed.textContent = "此后已更新。下方列表显示当前版本。";
      item.appendChild(changed);
    }
    section.appendChild(item);
  }
  return section;
}

function renderMemoryEdit(entry: MemoryEntry): HTMLElement {
  const edit = memoryEdit!;
  const form = document.createElement("div");
  form.className = "memory-edit";

  const textLabel = document.createElement("label");
  textLabel.textContent = "记忆内容";
  const textarea = document.createElement("textarea");
  textarea.dataset.memoryField = "text";
  textarea.dataset.memoryId = entry.id;
  textarea.maxLength = MEMORY_TEXT_MAX;
  textarea.value = edit.text;
  textarea.disabled = edit.pendingRequestId !== null;
  textarea.oninput = () => { edit.text = textarea.value; edit.error = ""; };
  textLabel.appendChild(textarea);

  const scopeLabel = document.createElement("label");
  scopeLabel.textContent = "适用范围";
  const select = document.createElement("select");
  select.dataset.memoryField = "scope";
  select.dataset.memoryId = entry.id;
  select.disabled = edit.pendingRequestId !== null;
  for (const [value, label] of [["all", "所有会话"], ["site", "指定站点"]] as const) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = edit.scopeKind === value;
    select.appendChild(option);
  }
  select.onchange = () => {
    edit.scopeKind = select.value as MemoryScope["kind"];
    if (edit.scopeKind === "site" && !edit.hostname) edit.hostname = currentMemoryHostname;
    edit.error = "";
    renderMemoryDrawer();
  };
  scopeLabel.appendChild(select);

  const hostnameLabel = document.createElement("label");
  hostnameLabel.textContent = "网站域名";
  hostnameLabel.hidden = edit.scopeKind !== "site";
  const hostname = document.createElement("input");
  hostname.type = "text";
  hostname.dataset.memoryField = "hostname";
  hostname.dataset.memoryId = entry.id;
  hostname.placeholder = "example.com";
  hostname.value = edit.hostname;
  hostname.disabled = edit.pendingRequestId !== null;
  hostname.oninput = () => { edit.hostname = hostname.value; edit.error = ""; };
  hostnameLabel.appendChild(hostname);

  const hint = document.createElement("p");
  hint.className = "memory-quiet";
  hint.textContent = `跨会话保留，只在相关任务中使用。${edit.text.length}/${MEMORY_TEXT_MAX}`;
  const error = document.createElement("p");
  error.className = "memory-error";
  error.hidden = !edit.error;
  error.textContent = edit.error;
  const actions = document.createElement("div");
  actions.className = "memory-actions";
  const cancel = memoryButton("取消", "cancel-edit", entry.id);
  cancel.disabled = edit.pendingRequestId !== null;
  const save = memoryButton(edit.pendingRequestId ? "正在保存…" : edit.error ? "重试保存" : "保存修改", "save", entry.id);
  save.className = "memory-primary";
  save.disabled = edit.pendingRequestId !== null;
  actions.append(cancel, save);
  form.append(textLabel, scopeLabel, hostnameLabel, hint, error, actions);
  return form;
}

function renderMemoryEntry(entry: MemoryEntry): HTMLElement {
  const card = document.createElement("article");
  card.className = "memory-row";
  card.dataset.memoryId = entry.id;
  if (memoryEdit?.id === entry.id) {
    card.appendChild(renderMemoryEdit(entry));
    return card;
  }

  const text = document.createElement("p");
  text.className = "memory-row-text";
  text.textContent = entry.text;
  const meta = document.createElement("div");
  meta.className = "memory-row-meta";
  const scope = document.createElement("span");
  scope.className = "memory-scope";
  scope.textContent = memoryScopeLabel(entry.scope);
  const actions = document.createElement("div");
  actions.append(
    memoryButton(card.classList.contains("show-source") ? "收起来源" : "查看来源", "source", entry.id),
    memoryButton("修改", "edit", entry.id),
    memoryButton("忘记", "forget", entry.id),
  );
  actions.lastElementChild?.classList.add("memory-danger");
  meta.append(scope, actions);
  card.append(text, meta);

  const source = document.createElement("details");
  source.className = "memory-source";
  source.dataset.memorySource = entry.id;
  const summary = document.createElement("summary");
  summary.textContent = "来源";
  const detail = document.createElement("p");
  detail.textContent = `会话：${memorySourceLabel(entry)}\n保存于 ${formatMemoryTime(entry.createdAt)} · 当前版本 ${entry.version}`;
  if (entry.experience) detail.textContent += `\n来自这次纠正的待验证做法；再次使用仍需检查。\n${entry.experience.evidence.map(line => line.replace(/^feedback-\d+：/, "你的纠正：").replace(/^(?:previous-)?observation-\d+：/, "网页结果：")).join("\n")}`;
  source.append(summary, detail);
  card.appendChild(source);

  if (memoryForget?.id === entry.id) {
    const confirm = document.createElement("div");
    confirm.className = "memory-forget-confirm";
    const heading = document.createElement("strong");
    heading.textContent = "忘记这条记忆？";
    const explanation = document.createElement("p");
    explanation.textContent = "以后不再从记忆中使用它。旧聊天和已经生成的回复仍会保留。";
    const error = document.createElement("p");
    error.className = "memory-error";
    error.hidden = !memoryForget.error;
    error.textContent = memoryForget.error;
    const confirmActions = document.createElement("div");
    confirmActions.className = "memory-actions";
    const cancel = memoryButton("取消", "cancel-forget", entry.id);
    cancel.disabled = memoryForget.pendingRequestId !== null;
    const forget = memoryButton(
      memoryForget.pendingRequestId ? "正在忘记…" : memoryForget.error ? "重试忘记" : "确认忘记",
      "confirm-forget",
      entry.id,
    );
    forget.className = "memory-danger memory-forget-submit";
    forget.disabled = memoryForget.pendingRequestId !== null;
    confirmActions.append(cancel, forget);
    confirm.append(heading, explanation, error, confirmActions);
    card.appendChild(confirm);
  }
  return card;
}

function renderMemoryDrawer(): void {
  const entries = memoryState.getEntries();
  memoryTitle.textContent = entries.length ? `记忆 · ${entries.length}` : "记忆";
  memoryBody.replaceChildren();
  const inspection = renderMemoryInspection();
  if (inspection) memoryBody.appendChild(inspection);

  const intro = document.createElement("p");
  intro.className = "memory-quiet memory-intro";
  intro.textContent = "你可以查看、纠正或忘记自己的全部记忆。站点范围只决定何时使用。";
  memoryBody.appendChild(intro);

  if (memoryListError) {
    const failure = document.createElement("div");
    failure.className = "memory-load-error";
    const text = document.createElement("span");
    text.textContent = memoryListError;
    failure.append(text, memoryButton("重试", "reload"));
    memoryBody.appendChild(failure);
  }
  if (!memoryLoaded && memoryListRequestId) {
    const loading = document.createElement("div");
    loading.className = "memory-empty";
    loading.textContent = "正在读取记忆…";
    memoryBody.appendChild(loading);
    return;
  }
  if (!memoryLoaded && !memoryListRequestId) {
    const unavailable = document.createElement("div");
    unavailable.className = "memory-empty";
    unavailable.append("还不能读取记忆。", memoryButton("重试", "reload"));
    memoryBody.appendChild(unavailable);
    return;
  }
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    const heading = document.createElement("strong");
    heading.textContent = "还没有保存的记忆";
    const text = document.createElement("p");
    text.textContent = "在聊天里明确说「请记住」，保存成功后会出现在这里。";
    empty.append(heading, text);
    memoryBody.appendChild(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "memory-list";
  for (const entry of entries) list.appendChild(renderMemoryEntry(entry));
  memoryBody.appendChild(list);
}

function processMemoryOutcome(outcome: MemoryApplyResult): void {
  if (outcome.kind === "ignored") return;
  const uiRequest = memoryUiRequests.get(outcome.requestId);
  memoryUiRequests.delete(outcome.requestId);
  if (outcome.action === "list") {
    if (memoryListRequestId !== outcome.requestId) return;
    memoryListRequestId = null;
    if (outcome.kind === "success") {
      memoryLoaded = true;
      memoryListError = "";
      if (memoryEdit && !memoryState.get(memoryEdit.id)) memoryEdit = null;
      if (memoryForget && !memoryState.get(memoryForget.id)) memoryForget = null;
    } else {
      memoryListError = `未能读取记忆：${outcome.error}`;
    }
  } else if (outcome.action === "update" && uiRequest?.entryId) {
    if (memoryEdit?.id === uiRequest.entryId && memoryEdit.pendingRequestId === outcome.requestId) {
      memoryEdit.pendingRequestId = null;
      if (outcome.kind === "success") memoryEdit = null;
      else memoryEdit.error = `修改未保存：${outcome.error}`;
    }
  } else if (outcome.action === "forget" && uiRequest?.entryId) {
    if (memoryForget?.id === uiRequest.entryId && memoryForget.pendingRequestId === outcome.requestId) {
      memoryForget.pendingRequestId = null;
      if (outcome.kind === "success") memoryForget = null;
      else memoryForget.error = `没有忘记这条记忆：${outcome.error}`;
    }
  }
  if (!memoryDrawer.hidden) renderMemoryDrawer();
}

function dispatchMemoryRequest(message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" }>, ui: MemoryUiRequest): void {
  memoryUiRequests.set(message.requestId, ui);
  if (send(message)) return;
  processMemoryOutcome(memoryState.rejectLocally(message.requestId, "连接不可用，请重试"));
}

function requestMemoryList(): void {
  const message = memoryState.beginList(selectedConversationId);
  memoryListRequestId = message.requestId;
  memoryListError = "";
  renderMemoryDrawer();
  dispatchMemoryRequest(message, { action: "list" });
}

function openMemoryDrawer(inspection: MemoryInspection | null = null): void {
  memoryInspection = inspection;
  memoryEdit = null;
  memoryForget = null;
  memoryDrawer.hidden = false;
  memoryShade.hidden = false;
  memoryOpen.setAttribute("aria-expanded", "true");
  renderMemoryDrawer();
  requestMemoryList();
}

function closeMemoryDrawer(): void {
  memoryDrawer.hidden = true;
  memoryShade.hidden = true;
  memoryOpen.setAttribute("aria-expanded", "false");
  memoryEdit = null;
  memoryForget = null;
  memoryInspection = null;
  memoryOpen.focus();
}

memoryOpen.onclick = () => memoryDrawer.hidden ? void openKnowledge(knowledgeSegment) : closeMemoryDrawer();
memoryClose.onclick = closeMemoryDrawer;
memoryShade.onclick = closeMemoryDrawer;
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !memoryDrawer.hidden) {
    event.preventDefault();
    closeMemoryDrawer();
  }
});

memoryBody.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button[data-memory-action]");
  if (!target) return;
  const action = target.dataset.memoryAction;
  const id = target.dataset.memoryId;
  if (action === "reload") {
    requestMemoryList();
    return;
  }
  if (!id) return;
  const entry = memoryState.get(id);
  if (!entry) {
    requestMemoryList();
    return;
  }
  if (action === "source") {
    const details = memoryBody.querySelector<HTMLDetailsElement>(`details[data-memory-source="${CSS.escape(id)}"]`);
    if (details) details.open = !details.open;
    return;
  }
  if (action === "edit") {
    memoryForget = null;
    memoryEdit = {
      id,
      text: entry.text,
      scopeKind: entry.scope.kind,
      hostname: entry.scope.kind === "site" ? entry.scope.hostname : currentMemoryHostname,
      pendingRequestId: null,
      error: "",
    };
    renderMemoryDrawer();
    memoryBody.querySelector<HTMLTextAreaElement>(`textarea[data-memory-id="${CSS.escape(id)}"]`)?.focus();
    return;
  }
  if (action === "cancel-edit") {
    memoryEdit = null;
    renderMemoryDrawer();
    return;
  }
  if (action === "save" && memoryEdit?.id === id) {
    const text = memoryEdit.text.trim();
    if (!text) {
      memoryEdit.error = "记忆内容不能为空。";
      renderMemoryDrawer();
      return;
    }
    if (text.length > MEMORY_TEXT_MAX) {
      memoryEdit.error = `记忆内容最多 ${MEMORY_TEXT_MAX} 个字符。`;
      renderMemoryDrawer();
      return;
    }
    let scope: MemoryScope = { kind: "all" };
    if (memoryEdit.scopeKind === "site") {
      const hostname = normalizeMemoryHostname(memoryEdit.hostname);
      if (!hostname) {
        memoryEdit.error = "请输入网站域名，例如 example.com。";
        renderMemoryDrawer();
        return;
      }
      memoryEdit.hostname = hostname;
      scope = { kind: "site", hostname };
    }
    const message = memoryState.beginUpdate(selectedConversationId, entry, text, scope);
    memoryEdit.pendingRequestId = message.requestId;
    memoryEdit.error = "";
    renderMemoryDrawer();
    dispatchMemoryRequest(message, { action: "update", entryId: id });
    return;
  }
  if (action === "forget") {
    memoryEdit = null;
    memoryForget = { id, pendingRequestId: null, error: "" };
    renderMemoryDrawer();
    return;
  }
  if (action === "cancel-forget") {
    memoryForget = null;
    renderMemoryDrawer();
    return;
  }
  if (action === "confirm-forget" && memoryForget?.id === id) {
    const message = memoryState.beginForget(selectedConversationId, entry);
    memoryForget.pendingRequestId = message.requestId;
    memoryForget.error = "";
    renderMemoryDrawer();
    dispatchMemoryRequest(message, { action: "forget", entryId: id });
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
recordToggle.appendChild(icon(Hand));

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
      if (tab.url) {
        const pageUrl = new URL(tab.url);
        host = pageUrl.host;
        currentMemoryHostname = normalizeMemoryHostname(pageUrl.hostname) ?? "";
      }
    } catch {
      currentMemoryHostname = "";
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

const knowledgeDrawer = document.getElementById("memory-drawer") as HTMLElement;
const segSkills = document.getElementById("seg-skills") as HTMLButtonElement;
const segMemory = document.getElementById("seg-memory") as HTMLButtonElement;
const skillPane = document.getElementById("skill-pane") as HTMLDivElement;
const skillList = document.getElementById("skill-list") as HTMLDivElement;
const observeToggle = document.getElementById("observe-toggle") as HTMLButtonElement;
const observeHint = document.getElementById("observe-hint") as HTMLSpanElement;
const observeCandidates = document.getElementById("observe-candidates") as HTMLDivElement;
let knowledgeSegment: "skills" | "memory" = "skills";
let observing = false;
let observedPatterns = 0;
let observedCandidates: ObservedPattern[] = [];
let redoSkillId: string | null = null;
let redoSkillVersion: number | null = null;
let skillRequest = "";
let skillEntries: Array<{ skill: Skill; runs: SkillRun[] }> = [];

// ── 知识抽屉：技能与记忆一个入口（方案一：摘要 + 展开） ──────────────
// 默认只露「名字 + 事实行 + 一个主按钮」；凭证、步骤、脚本、其余动作收进一次展开。

/** 打开抽屉：分段决定看哪一半；两边各自按需拉数据。 */
async function openKnowledge(segment: "skills" | "memory"): Promise<void> {
  memoryDrawer.hidden = false;
  memoryShade.hidden = false;
  memoryOpen.setAttribute("aria-expanded", "true");
  setKnowledgeSegment(segment);
}

function setKnowledgeSegment(segment: "skills" | "memory"): void {
  knowledgeSegment = segment;
  segSkills.setAttribute("aria-selected", String(segment === "skills"));
  segMemory.setAttribute("aria-selected", String(segment === "memory"));
  skillPane.hidden = segment !== "skills";
  memoryBody.hidden = segment !== "memory";
  if (segment === "skills") {
    // 先按手上的数据画一次（多半是空态），别让抽屉在等到回复前是一片空白
    renderObserve();
    renderSkills();
    void refreshSkills();
    return;
  }
  renderMemoryDrawer();
  requestMemoryList();
}

async function refreshSkills(): Promise<void> {
  const hostname = await currentHostname();
  skillRequest = crypto.randomUUID();
  send({ type: "skill_list", requestId: skillRequest, ...(hostname ? { hostname } : {}) });
  port?.postMessage({ kind: "observe", action: "list", conversationId: selectedConversationId } satisfies PanelToBg);
}

/** 当前活动页的站点：技能按站点列，不看别的站。 */
async function currentHostname(): Promise<string> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.url ? new URL(tab.url).hostname : "";
  } catch {
    return "";
  }
}

function renderObserve(): void {
  observeToggle.textContent = observing ? `观察：开 · 已记 ${observedPatterns} 段` : "观察：关";
  observeToggle.setAttribute("aria-pressed", String(observing));
  observeToggle.title = observing
    ? "只记骨架：点了哪些对象、同一站点的一串动作。不记你输入的内容；敏感站点与密码字段直接跳过。"
    : "打开后我才会观察你的操作，从中找出你可能常做的事，再问你要不要以后替你跑。";
  observeHint.textContent = observing ? "只记骨架" : "打开后才会看你常做的事";
  observeCandidates.replaceChildren();
  for (const pattern of observedCandidates) {
    const card = document.createElement("div");
    card.className = "observe-card";
    const text = document.createElement("p");
    text.textContent = describePattern(pattern, anchor => describeAnchor(anchor));
    const detail = document.createElement("details");
    detail.className = "disc";
    const summary = document.createElement("summary");
    summary.textContent = "看它记下的这几步";
    const body = document.createElement("div");
    body.className = "disc-body";
    const list = document.createElement("ol");
    for (const anchor of pattern.anchors) {
      const li = document.createElement("li");
      li.textContent = describeAnchor(anchor);
      list.appendChild(li);
    }
    body.appendChild(list);
    detail.append(summary, body);
    const actions = document.createElement("div");
    actions.className = "row-actions";
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "btn primary";
    accept.textContent = "以后替我跑";
    accept.onclick = () => {
      accept.disabled = true;
      skillRequestId = crypto.randomUUID();
      send({
        type: "skill_compile",
        requestId: skillRequestId,
        intent: defaultIntent(pattern, anchor => describeAnchor(anchor)),
        hostname: pattern.hostname,
        demoId: `observed-${pattern.hostname}-${pattern.signature.slice(0, 24)}`,
        steps: pattern.anchors.map((anchor, index) => ({ at: index * 1000, kind: "click" as const, anchor, page: `https://${pattern.hostname}/` })),
      });
      port?.postMessage({ kind: "observe", action: "accept", conversationId: selectedConversationId, signature: pattern.signature, hostname: pattern.hostname } satisfies PanelToBg);
    };
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "btn ghost";
    dismiss.textContent = "不用";
    dismiss.onclick = () => {
      port?.postMessage({ kind: "observe", action: "dismiss", conversationId: selectedConversationId, signature: pattern.signature, hostname: pattern.hostname } satisfies PanelToBg);
      observedCandidates = observedCandidates.filter(p => !(p.signature === pattern.signature && p.hostname === pattern.hostname));
      renderObserve();
    };
    actions.append(accept, dismiss);
    card.append(text, detail, actions);
    observeCandidates.appendChild(card);
  }
}

/** 技能行：摘要 + 展开。过期的技能主按钮变短，点下去先就地确认。 */
function renderSkills(): void {
  skillList.replaceChildren();
  if (skillEntries.length === 0) {
    const empty = document.createElement("p");
    empty.className = "memory-quiet";
    empty.textContent = transportConnected
      ? "这一页还没有技能。亲手做一遍再填一句话编译；或者打开观察，让它自己看出你常做的事。"
      : "还没连上伴随进程，技能与观察暂时读不到。";
    skillList.appendChild(empty);
    return;
  }
  for (const { skill, runs } of skillEntries) {
    const health = skillHealth(runs);
    const row = document.createElement("div");
    row.className = "row";
    const head = document.createElement("div");
    head.className = "row-head";
    const name = document.createElement("span");
    name.className = "row-name";
    name.textContent = skill.name;
    const facts = document.createElement("span");
    facts.className = health.stale ? "row-facts stale" : "row-facts";
    facts.textContent = [skillRunSummary(runs), skill.version > 1 ? `第 ${skill.version} 版` : ""].filter(Boolean).join(" · ");
    head.append(name, facts);

    const actions = document.createElement("div");
    actions.className = "row-actions";
    const runBtn = document.createElement("button");
    runBtn.type = "button";
    runBtn.className = "btn primary";
    runBtn.textContent = "照上次那样跑";
    runBtn.onclick = () => {
      if (!health.stale) { startSkillRun(skill, runBtn); return; }
      // 可能过期：不直接跑，先就地确认，不弹原生对话框（那会卡住整个面板）
      runBtn.textContent = "可能过期，仍然要跑？";
      if (!row.querySelector(".stale-confirm")) {
        const confirmRow = document.createElement("div");
        confirmRow.className = "row-actions stale-confirm";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "btn";
        yes.textContent = "确认跑一次";
        yes.onclick = () => { confirmRow.remove(); runBtn.textContent = "照上次那样跑"; startSkillRun(skill, runBtn); };
        const no = document.createElement("button");
        no.type = "button";
        no.className = "btn ghost";
        no.textContent = "算了";
        no.onclick = () => { confirmRow.remove(); runBtn.textContent = "照上次那样跑"; };
        confirmRow.append(yes, no);
        row.appendChild(confirmRow);
      }
    };
    actions.appendChild(runBtn);

    const detail = document.createElement("details");
    detail.className = "disc";
    const summary = document.createElement("summary");
    summary.textContent = "凭证、步骤与其余动作";
    const body = document.createElement("div");
    body.className = "disc-body";
    if (skill.notes?.length) {
      const notes = document.createElement("p");
      notes.className = "check";
      notes.textContent = `你说过不对的地方：${skill.notes.map((note: { text: string }) => note.text).join("；")}`;
      body.appendChild(notes);
    }
    if (skill.check.text) {
      const check = document.createElement("p");
      check.className = "check";
      check.textContent = `完成凭证：${skill.check.text}`;
      body.appendChild(check);
    }
    if (skill.weakSteps || skill.droppedSteps) {
      const weak = document.createElement("p");
      weak.className = "check";
      weak.textContent = skill.weakSteps
        ? `有 ${skill.weakSteps} 步没记到对象名：跑的时候认不出来就跳过，不会因此停下。`
        : `有 ${skill.droppedSteps} 步没记到对象名，已跳过。`;
      body.appendChild(weak);
    }
    const steps = document.createElement("ol");
    for (const line of skillStepsText(skill)) {
      const li = document.createElement("li");
      li.textContent = line;
      steps.appendChild(li);
    }
    const script = document.createElement("pre");
    script.textContent = skill.program;
    body.append(steps, script);

    const secondary = document.createElement("div");
    secondary.className = "row-actions";
    const redo = document.createElement("button");
    redo.type = "button";
    redo.className = "btn";
    redo.textContent = "重新示范";
    redo.title = "就按新做法再做一遍：内容替换、版本加一，旧版本留着可回退";
    redo.onclick = () => {
      redoSkillId = skill.id;
      redoSkillVersion = skill.version;
      knowledgeDrawer.hidden = true;
      port?.postMessage({ kind: "demo", action: "start", conversationId: selectedConversationId } satisfies PanelToBg);
      addMsg("msg", `重新示范：现在你亲手做一遍（会覆盖「${skill.name}」，旧版本留着）。做完点「做完了」，再点「编译成脚本」。`);
    };
    const noteBox = document.createElement("div");
    noteBox.className = "skill-note-box";
    noteBox.hidden = true;
    const noteInput = document.createElement("input");
    noteInput.type = "text";
    noteInput.maxLength = 200;
    noteInput.placeholder = "哪里不对？一句话，下次重新示范时提醒你";
    const noteSend = document.createElement("button");
    noteSend.type = "button";
    noteSend.className = "btn";
    noteSend.textContent = "记下";
    noteSend.onclick = () => {
      const text = noteInput.value.trim();
      if (!text) return;
      noteBox.hidden = true;
      noteInput.value = "";
      addMsg("msg", `记下了：下次重新示范「${skill.name}」时会提醒你这条。`);
      skillRequest = crypto.randomUUID();
      send({ type: "skill_note", requestId: skillRequest, id: skill.id, note: text });
      window.setTimeout(() => void refreshSkills(), 700);
    };
    noteBox.append(noteInput, noteSend);
    const noteBtn = document.createElement("button");
    noteBtn.type = "button";
    noteBtn.className = "btn ghost";
    noteBtn.textContent = "这次不太对";
    noteBtn.onclick = () => { noteBox.hidden = !noteBox.hidden; if (!noteBox.hidden) noteInput.focus(); };
    const rollback = document.createElement("button");
    rollback.type = "button";
    rollback.className = "btn ghost";
    rollback.textContent = "回到上一版";
    rollback.disabled = skill.version <= 1;
    rollback.onclick = () => {
      rollback.disabled = true;
      addMsg("msg", `正在回到「${skill.name}」的上一版…`);
      skillRequest = crypto.randomUUID();
      send({ type: "skill_rollback", requestId: skillRequest, id: skill.id, expectedVersion: skill.version });
      window.setTimeout(() => void refreshSkills(), 700);
    };
    const forget = document.createElement("button");
    forget.type = "button";
    forget.className = "btn ghost";
    forget.textContent = "忘掉";
    forget.onclick = () => {
      skillRequest = crypto.randomUUID();
      send({ type: "skill_forget", requestId: skillRequest, id: skill.id });
    };
    secondary.append(redo, noteBtn, rollback, forget);
    body.append(secondary, noteBox);
    detail.append(summary, body);
    row.append(head, actions, detail);
    skillList.appendChild(row);
  }
}

function startSkillRun(skill: Skill, button: HTMLButtonElement): void {
  button.disabled = true;
  button.textContent = "跑着…";
  skillRequest = crypto.randomUUID();
  send({ type: "skill_run", requestId: skillRequest, id: skill.id, expectedVersion: skill.version });
}

segSkills.onclick = () => setKnowledgeSegment("skills");
segMemory.onclick = () => setKnowledgeSegment("memory");
observeToggle.onclick = () => {
  port?.postMessage({ kind: "observe", action: observing ? "off" : "on", conversationId: selectedConversationId } satisfies PanelToBg);
};

// ── 示范录制（看我做） ─────────────────────────────────────────────
// 记录在 background 进行；面板只发开关指令、把已记步骤讲清楚。
// 默认只显示步骤与完成情况，脚本代码以后折叠在「代码」里，不铺在脸上。

let demoState: { recording: boolean; steps: DemoStep[]; truncated: boolean } = { recording: false, steps: [], truncated: false };
let skillRequestId = "";

function renderDemo(): void {
  const { recording, steps, truncated } = demoState;
  recordToggle.classList.toggle("on", recording);
  recordToggle.classList.toggle("recording", recording);
  recordToggle.setAttribute("aria-pressed", String(recording));
  recordToggle.title = recording
    ? `${recordingHint(steps, truncated)}；做完点这里结束`
    : "看我做一次：你亲手做一遍，我先只看不动手";
  demoStrip.hidden = !recording && steps.length === 0;
  if (demoStrip.hidden) return;
  demoTitle.textContent = recording ? recordingHint(steps, truncated) : `示范结束：记下 ${steps.length} 步${truncated ? "（中途已达上限）" : ""}`;
  demoSteps.replaceChildren(...describeSteps(steps).map((line) => {
    const li = document.createElement("li");
    li.textContent = line;
    return li;
  }));
  demoSteps.lastElementChild?.scrollIntoView({ block: "nearest" });
  demoActions.hidden = recording;
}

/** 编译入口：把这一份示范 + 你的一句话交给伴随进程编译成技能。 */
demoCompile.onclick = () => {
  const steps = demoState.steps;
  if (!steps.length) return;
  const host = hostnameOf(steps);
  if (!host) { addMsg("msg error", "这份示范没有可用的站点信息，换个普通网页再试。"); return; }
  demoCompile.disabled = true;
  demoCompile.textContent = "编译中…";
  skillRequestId = crypto.randomUUID();
  send({
    type: "skill_compile",
    requestId: skillRequestId,
    intent: demoIntent.value,
    hostname: host,
    demoId: `${selectedConversationId}-${steps.length}-${steps[0]?.at ?? 0}`,
    steps,
    ...(redoSkillId ? { updateId: redoSkillId, ...(redoSkillVersion === null ? {} : { expectedVersion: redoSkillVersion }) } : {}),
  });
};

function hostnameOf(steps: DemoStep[]): string | null {
  for (const step of steps) {
    if (!step.page) continue;
    try { return new URL(step.page).hostname; } catch { /* 跳过坏地址 */ }
  }
  return null;
}

/** 编译结果卡：默认只讲步骤与完成凭证，脚本折起来。 */
function renderSkillResult(skill: Skill): void {
  demoSkill.hidden = false;
  demoSkill.replaceChildren();
  const title = document.createElement("div");
  title.className = "demo-skill-title";
  title.textContent = skill.version > 1 ? `已更新：${skill.name}（第 ${skill.version} 版）` : `已编译：${skill.name}`;
  const list = document.createElement("ol");
  for (const line of skillStepsText(skill)) {
    const li = document.createElement("li");
    li.textContent = line;
    list.appendChild(li);
  }
  const check = document.createElement("p");
  check.className = "demo-skill-check";
  check.textContent = `完成凭证：${skill.check.text}`;
  const note = document.createElement("p");
  note.className = "demo-skill-check";
  note.textContent = skill.weakSteps
    ? `示范里有 ${skill.weakSteps} 步没记到对象名：跑的时候认不出来就跳过，不会因此停下。`
    : skill.droppedSteps ? `示范里有 ${skill.droppedSteps} 步没记到对象名，已跳过。` : "";
  note.hidden = !skill.weakSteps && !skill.droppedSteps;
  const detail = document.createElement("details");
  const summary = document.createElement("summary");
  summary.textContent = "看脚本";
  const pre = document.createElement("pre");
  pre.textContent = skill.program;
  detail.append(summary, pre);
  demoSkill.append(title, list, note, check, detail);
}

recordToggle.onclick = () => {
  const action = demoState.recording ? "stop" : "start";
  port?.postMessage({ kind: "demo", action, conversationId: selectedConversationId } satisfies PanelToBg);
};

demoClose.onclick = () => {
  port?.postMessage({ kind: "demo", action: "dismiss", conversationId: selectedConversationId } satisfies PanelToBg);
  demoState = { recording: false, steps: [], truncated: false };
  demoIntent.value = "";
  demoSkill.hidden = true;
  demoSkill.replaceChildren();
  renderDemo();
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

/**
 * 面板要从触发它的那颗按钮长出来：把缩放原点对齐到按钮中点。
 * 不能读面板自己的 rect —— 展开动画的 transform 会污染测量，所以用 offsetLeft 换算布局位置。
 */
function alignModelPopoverOrigin(): void {
  const parent = modelPopover.offsetParent as HTMLElement | null;
  if (!parent) return;
  const popLeft = parent.getBoundingClientRect().left + modelPopover.offsetLeft;
  const btn = modelBtn.getBoundingClientRect();
  const x = Math.round(btn.left - popLeft + btn.width / 2);
  if (x > 0 && x < modelPopover.offsetWidth) {
    modelPopover.style.transformOrigin = `${x}px bottom`;
  }
}

/** 展开只有这一次：列表项依次落位。搜索会重渲染列表，靠一次性 class 避免每次输入都重播。 */
function playPopoverOpening(): void {
  modelPopover.classList.remove("opening");
  void modelPopover.offsetWidth;
  modelPopover.classList.add("opening");
  window.setTimeout(() => modelPopover.classList.remove("opening"), 600);
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
    alignModelPopoverOrigin();
    playPopoverOpening();
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

/**
 * 光球显示尺寸。比它替换掉的图标略大一点：球是细线，实心图标同尺寸会显得球单薄。
 * 三处各自跟着那行的字号走，不强行统一成一个数。
 */
const ORB_BOX_THINKING = 18;
const ORB_BOX_CHIP = 16;
const ORB_BOX_RECEIPT = 15;
/** 球句柄按宿主元素找回：折叠、结束时要把对应那个定格。 */
const orbByHost = new WeakMap<HTMLElement, OrbHandle>();
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

/** 显式交付气泡：按 delivery.id 只渲染一次，状态更新不重复生成。 */
const deliveredBubbles = new Map<string, HTMLElement>();
/** Lead 当前 run 是否启用了 explicit deliveryMode。 */
let leadDeliveryMode: "explicit" | null = null;
let currentLeadDraft: HTMLElement | null = null;
let currentLeadDraftDetails: HTMLDetailsElement | null = null;

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
  /** 工具在跑时转，结束定格——完成是收束，不是把球换成图标 */
  orb: OrbHandle;
  dur: HTMLElement;
  start: number;
  name: string;
  paramsText: string;
  resultText: string;
  group: ChipGroup;
}

const toolChips = new Map<string, ToolChipEntry>();

/** 工具名 → 图标；未知名称回退扳手。 */
/**
 * 工具名 → 图标。
 * 05 之后 chip 的图标位换成了光球，这里暂时没有调用方；留着是因为"chip 要不要同时保留
 * 工具图标"还没最终定，回退时直接接回 onToolStart 即可。
 */
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
let runBodyPinned = true;
let thinkPinned = true;
let followingLive = false;

function nearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
}

function followLive(el: HTMLElement | null, stick: boolean): void {
  if (!el) return;
  if (stick) {
    followingLive = true;
    el.scrollTop = el.scrollHeight;
    followingLive = false;
  }
  el.classList.toggle("overflowing", liveViewportOverflows(el.scrollHeight, el.clientHeight));
}

function bindLiveViewport(el: HTMLElement, setPinned: (next: boolean) => void): void {
  el.addEventListener("scroll", () => {
    if (followingLive) return;
    setPinned(isLiveViewportPinned(el.scrollTop, el.scrollHeight, el.clientHeight));
  });
}

messagesEl.addEventListener("scroll", () => {
  pinned = nearBottom();
  toBottomBtn.hidden = pinned;
});

function scrollToEnd(force = false): void {
  followLive(currentRun?.body ?? null, force || runBodyPinned);
  followLive(currentThinking, force || thinkPinned);
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

function renderMemoryReceipt(event: Extract<AgentUiEvent, { kind: "memory" }>): HTMLElement {
  const receipt = document.createElement("div");
  receipt.className = `memory-receipt memory-receipt-${event.action}`;
  const mark = document.createElement("span");
  mark.className = "memory-receipt-mark";
  // 记忆的身份标记：connecting 球（星座接线），替代原来的文字勾。记录已落定，球定格不转。
  mark.appendChild(createOrb("connecting", ORB_BOX_RECEIPT).el);
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.memoryReceipt = event.action;
  button.textContent = event.action === "used"
    ? `使用了 ${event.entries.length} 条记忆 · 查看`
    : event.action === "forgotten"
      ? event.entries.some(entry => entry.experience) ? "旧做法已停用 · 查看" : "已忘记 · 查看"
      : event.action === "updated"
        ? "记忆已更新 · 查看"
        : event.entries.some(entry => entry.experience) ? "已整理这次纠正 · 查看" : "已记住 · 查看";
  const snapshots = event.entries.map((entry) => ({ ...entry, scope: { ...entry.scope } }));
  button.onclick = () => openMemoryDrawer({ action: event.action, entries: snapshots, message: event.message });
  receipt.append(mark, button);
  if (event.entries.length === 1) {
    const scope = document.createElement("span");
    scope.className = "memory-receipt-scope";
    scope.textContent = memoryScopeLabel(event.entries[0]!.scope);
    receipt.appendChild(scope);
  }
  messagesEl.appendChild(receipt);
  scrollToEnd();
  return receipt;
}

// ── 执行步骤聚合块 ──────────────────────────────────────────
// 一次 run（用户消息 → agent_end）中的思考块与工具 chips 收进同一个 details；
// 块懒创建于首个步骤事件，运行中展开，结束后折叠并标注总耗时。
// 运行中的等待态用像素格 loader（相位波纹 + 实时耗时 + 当前动作副标题）。

/** 3×3 像素格 loader：相位波纹动画 + 0.1s 精度耗时 + 当前动作副标题。 */
function buildPixelLoader(): { root: HTMLElement; elapsed: HTMLElement; sub: HTMLElement } {
  const root = document.createElement("div");
  root.className = "px-wrap";
  const grid = document.createElement("div");
  grid.className = "px-grid";
  // 3×3：光球上线后这里退成背景，只负责"整体还在跑"，视觉重量让给球
  for (let i = 0; i < 9; i++) {
    const cell = document.createElement("i");
    cell.style.animationDelay = `${pixelDelay(i, 3)}s`;
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
  runBodyPinned = true;
  bindLiveViewport(body, (next) => {
    runBodyPinned = next;
  });
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

/** 收束退场：让元素把退出动画走完再摘除，避免"啪"地消失。animationend 与超时双保险。 */
function settleOut(el: HTMLElement): void {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    el.remove();
  };
  if (!el.isConnected) {
    finish();
    return;
  }
  el.classList.add("leaving");
  el.addEventListener("animationend", finish, { once: true });
  window.setTimeout(finish, 500);
}

function finishRun(): void {
  const run = currentRun;
  currentRun = null;
  runStartAt = 0;
  if (!run) return;
  lastRun = run;
  // 耗时读数 interval 立即停掉：run 完成/中断/空 run 都不留泄漏
  clearInterval(run.timer);
  // 空 run（纯文本回复，无思考/工具步骤）不留壳：等待态之外没有别的内容就整块撤掉
  const hasSteps = [...run.body.children].some((el) => el !== run.loader);
  if (!hasSteps) {
    run.loader.remove();
    run.root.remove();
    if (lastRun === run) lastRun = null;
    if (!applyingHistory) companion.onRunFinish();
    return;
  }
  run.root.classList.add("done");
  run.iconBox.replaceChildren(icon(List));
  if (applyingHistory) {
    run.loader.remove();
  } else {
    // 等待态收束退出，完成图标从同一点展开——不是"啪"地换一个（04 settle）
    settleOut(run.loader);
    run.iconBox.classList.add("settling");
  }
  const title = run.root.querySelector(".run-title");
  if (title) title.textContent = "查看执行过程";
  // Keep the process in its original position above the final response.
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
    orbByHost.get(currentThinkingDetails)?.setRunning(false);
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
  if (currentLeadDraftDetails) {
    orbByHost.get(currentLeadDraftDetails)?.setRunning(false);
    currentLeadDraftDetails.classList.remove("streaming");
    currentLeadDraftDetails.open = false;
  }
  currentLeadDraft = null;
  currentLeadDraftDetails = null;
}

function appendLeadDelta(delta: string): void {
  const run = ensureRun();
  if (!currentLeadDraft) {
    const details = document.createElement("details");
    details.className = "thinking streaming";
    details.open = false;
    const summary = document.createElement("summary");
    const orb = createOrb("composing", ORB_BOX_THINKING);
    if (!applyingHistory) orb.setRunning(true);
    orbByHost.set(details, orb);
    summary.appendChild(orb.el);
    const label = document.createElement("span");
    label.textContent = "执行过程";
    summary.appendChild(label);
    const pre = document.createElement("pre");
    details.append(summary, pre);
    run.body.insertBefore(details, run.loader);
    currentLeadDraft = pre;
    currentLeadDraftDetails = details;
  }
  currentLeadDraft.appendChild(document.createTextNode(delta));
  scrollToEnd();
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
      const orb = createOrb("composing", ORB_BOX_THINKING);
      if (!applyingHistory) orb.setRunning(true);
      orbByHost.set(details, orb);
      summary.appendChild(orb.el);
      const label = document.createElement("span");
      label.textContent = "正在思考…";
      summary.appendChild(label);
      const pre = document.createElement("pre");
      thinkPinned = true;
      bindLiveViewport(pre, (next) => {
        thinkPinned = next;
      });
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
  // 工具在跑时用光球（solving = 色带归位）；跑完定格在同一颗球上，不换成别的图标
  const chipOrb = createOrb("solving", ORB_BOX_CHIP);
  if (!applyingHistory) chipOrb.setRunning(true);
  iconBox.appendChild(chipOrb.el);
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
    orb: chipOrb,
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
  // 球停下并定格：完成是收束，不是把球换掉
  entry.orb.setRunning(false);
  // 完成不是变色，是收束：点从放大处缩回原位（04 settle）
  if (!applyingHistory) {
    entry.dot.classList.add("settling");
    window.setTimeout(() => entry.dot.classList.remove("settling"), 500);
  }
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
    case "memory":
      renderMemoryReceipt(ev);
      break;
    case "text_delta":
      if (leadDeliveryMode === "explicit") {
        appendLeadDelta(ev.delta);
      } else {
        appendDelta("assistant", ev.delta);
      }
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
      leadDeliveryMode = (ev as { deliveryMode?: "explicit" }).deliveryMode ?? null;
      closeBlocks();
      break;
    case "turn_end":
      closeBlocks();
      break;
    case "agent_end":
      closeBlocks();
      leadDeliveryMode = null;
      break;
    case "user_delivery":
      handleUserDelivery(ev.delivery);
      break;
    case 'user_delivery_stream': {
      const s=ev.stream;
      let bubble=deliveredBubbles.get(s.id);
      if(s.phase==='cancelled'){
        if(bubble?.dataset.streaming==='true'){bubble.dataset.streaming='cancelled';bubble.title='这次回答未完成';}
        break;
      }
      if(bubble&&bubble.dataset.streaming!=='true')break;
      if(!bubble){bubble=addMsg('msg assistant markdown','');bubble.dataset.deliveryId=s.id;bubble.dataset.deliveryKind=s.kind;bubble.dataset.streaming='true';deliveredBubbles.set(s.id,bubble);}
      bubble.innerHTML=renderMarkdown(s.text);scrollToEnd();break;
    }
    case "turn_start":
      break;
    case "notice":
      if(ev.plan){
        const key=`plan:${ev.plan.conversationId}:${ev.plan.id}`;
        const text=`语音计划 · 共${ev.plan.steps.length}步\n`+ev.plan.steps.map((s,i)=>`${i+1}. ${s.targetTitle??'目标会话'} · ${s.receipt?.message??(s.status==='pending'?'结果待确认':'未执行')}\n${s.text}`).join('\n');
        const previous=receiptMessages.get(key);if(previous)previous.textContent=text;else receiptMessages.set(key,addMsg('msg notice',text));
      }else if (ev.receipt) {
        const key=`${ev.receipt.conversationId}:${ev.receipt.requestId}`;
        const text=`${ev.receipt.targetTitle} · ${ev.message}${ev.receipt.text&&!ev.message.includes(ev.receipt.text)?`\n原话：${ev.receipt.text}`:''}`;
        const previous=receiptMessages.get(key);
        if (previous) previous.textContent=text;
        else receiptMessages.set(key,addMsg('msg notice',text));
      } else addMsg("msg notice", ev.message);
      break;
    case "error":
      addMsg("msg error", humanizeModelError(ev.message));
      break;
  }
}

const DELIVERY_STATUS_RANK: Record<string, number> = {
  composed: 0,
  speaking: 1,
  played: 2,
};

function handleUserDelivery(delivery: UserDelivery): void {
  if (!delivery || typeof delivery.id !== "string" || !delivery.id) return;

  const existing = deliveredBubbles.get(delivery.id);
  if (existing) {
    if(existing.dataset.streaming==='true'){
      existing.innerHTML=renderMarkdown(delivery.text);delete existing.dataset.streaming;
      existing.dataset.deliveryKind=delivery.kind;
      existing.dataset.deliveryStatus=delivery.status;voiceUI.deliver?.(delivery);scrollToEnd();return;
    }
    const oldStatus = existing.dataset.deliveryStatus ?? "";
    const oldRank = DELIVERY_STATUS_RANK[oldStatus] ?? -1;
    const newRank = DELIVERY_STATUS_RANK[delivery.status] ?? -1;
    if (newRank > oldRank) {
      existing.dataset.deliveryStatus = delivery.status;
    }
    return;
  }

  voiceUI.deliver?.(delivery);

  const bubble = addMsg("msg assistant markdown", "");
  bubble.innerHTML = renderMarkdown(delivery.text);
  bubble.dataset.deliveryId = delivery.id;
  bubble.dataset.deliveryKind = delivery.kind;
  bubble.dataset.deliveryStatus = delivery.status;
  deliveredBubbles.set(delivery.id, bubble);
  scrollToEnd();
}

// ── 连接管理（panel ⇆ background Port） ────────────────────────────

function clearDemoView(): void {
  demoState = { recording: false, steps: [], truncated: false };
  renderDemo();
}

function send(msg: ClientMessage): boolean {
  if (!port || !transportConnected) return false;
  const envelope: PanelToBg = { kind: "client", msg: { ...msg, conversationId: msg.conversationId ?? selectedConversationId } };
  try {
    port.postMessage(envelope);
    return true;
  } catch {
    return false;
  }
}

function handleMemoryResult(msg: Extract<ServerMessage, { type: "memory_result" }>): void {
  const outcome = memoryState.receive(msg.conversationId, msg);
  processMemoryOutcome(outcome);
}

const voiceUI = mountVoiceUI(composerEl, () => selectedConversationId, send,()=>({
  ...(pendingAsk?{context:{tabId:pendingAsk.tabId,title:pendingAsk.title,url:pendingAsk.url,selection:{text:pendingAsk.text}}}:{}),
  attachments:attachments?.getAttachments()??[],
}));

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);
  if (!msg) return;
  if (msg.type === "voice") { voiceUI.receive(msg); return; }
  if (msg.type === "memory_result") {
    handleMemoryResult(msg);
    return;
  }
  if (msg.type === "skill_result") {
    if (msg.action === "list" && msg.ok) {
      skillEntries = (msg.skills ?? []).map(skill => ({ skill, runs: msg.runs?.[skill.id] ?? [] }));
      renderSkills();
      return;
    }
    if (msg.action === "run" && msg.requestId === skillRequest) {
      if (!msg.ok || !msg.run) { addMsg("msg error", `这次没跑成：${msg.error ?? "未知原因"}`); return; }
      const outcome = msg.run;
      addMsg(outcome.ok ? "msg" : "msg error", outcome.ok
        ? `照上次那样跑完了：${outcome.steps} 步 · ${Math.max(0.1, outcome.elapsedMs / 1000).toFixed(1)} 秒。`
          + (outcome.skipped?.length ? `第 ${outcome.skipped.join("、")} 步没认出来，已跳过。` : "")
        : `跑到第 ${outcome.failedStep ?? "?"} 步停下了：${outcome.error ?? ""}`);
      void refreshSkills(); // 刷新事实行：跑过几次、上次结果
      return;
    }
    if ((msg.action === "note" || msg.action === "rollback") && msg.requestId === skillRequest) {
      if (!msg.ok) { addMsg("msg error", `没做成：${msg.error ?? "未知原因"}`); return; }
      addMsg("msg", msg.action === "note"
        ? `已确认记下：下次重新示范「${msg.skill?.name ?? "这份技能"}」时会提醒你。`
        : `已回到上一版：${msg.skill?.name ?? ""}（现在是第 ${msg.skill?.version ?? "?"} 版）`);
      void refreshSkills();
      return;
    }
    if (msg.action === "forget" && msg.ok) { void refreshSkills(); return; }
    demoCompile.disabled = false;
    demoCompile.textContent = "编译成脚本";
    if (msg.ok && msg.skill) { renderSkillResult(msg.skill); redoSkillId = null; redoSkillVersion = null; }
    else if (msg.requestId === skillRequestId) addMsg("msg error", `编译没成：${msg.error ?? "未知原因"}`);
    return;
  }
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
      && !envelope.msg.type.startsWith("conversation_") && envelope.msg.type !== "memory_result") return;
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
  if (envelope.kind === "observe") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    observing = envelope.observing;
    observedCandidates = envelope.candidates;
    observedPatterns = envelope.patterns;
    renderObserve();
    return;
  }
  if (envelope.kind === "demo") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    demoState = { recording: envelope.recording, steps: envelope.steps, truncated: envelope.truncated };
    renderDemo();
    return;
  }
  if (envelope.kind === "ask_selection") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    applyPendingAsk(envelope.ask);
    return;
  }
  if (envelope.kind === "delivery") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    handleDeliveryReceipt(envelope.seq, envelope.ok, envelope.original);
    return;
  }
  if (envelope.kind !== "conn") return;
  // 连接状态
  transportConnected = envelope.state === "connected";
  renderConversations();
  if (envelope.state === "connected") {
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
    voiceUI.reconnected();
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
/** seq → 用户气泡。delivery 回执只标记自己的气泡，绝不触碰输入框（issue #4 竞态边界）。 */
const userBubbles = new Map<number, HTMLElement>();

/** background→agent 上行确定失败的回执：标记未送达并提供原文重试；迟到/重复/未知 seq 忽略。 */
function handleDeliveryReceipt(seq: number, ok: boolean, original: ClientMessage): void {
  if (ok) return;
  if (!Number.isInteger(seq)) return;
  const bubble = userBubbles.get(seq);
  if (!bubble || bubble.dataset.failed === "true") return;
  bubble.dataset.failed = "true";
  bubble.classList.add("undelivered");
  const tag = document.createElement("span");
  tag.className = "delivery-tag";
  tag.textContent = "未送达";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.dataset.retry = "";
  retry.textContent = "重试";
  retry.title = "重新发送这条消息";
  retry.onclick = () => {
    if (!send(original)) {
      noticeSendFailed();
      return;
    }
    bubble.dataset.retried = "true";
    retry.disabled = true;
    retry.textContent = "已重试";
  };
  bubble.append(tag, retry);
}

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
        const bubble = addUserMsg(entry.item.text, entry.item.attachments);
        bubble.dataset.seq = String(entry.seq);
        userBubbles.set(entry.seq, bubble);
        if (entry.item.undelivered) handleDeliveryReceipt(entry.seq, false, entry.item.undelivered.original);
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
    voiceUI.disconnect();
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
  onChanged: (_count, scope) => {
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

/** 断线发送失败提示：同一轮只提示一次，成功发送后复位。 */
let sendFailNotified = false;

function noticeSendFailed(): void {
  if (sendFailNotified) return;
  sendFailNotified = true;
  addMsg("msg notice", "这条没有发出去：与后台的连接断了。正文和引用都还在，恢复连接后重新发送即可。");
}

function sendInput(): void {
  if (!conversationReady) return;
  const held=panelLive(sessionRun.values(), teamView).userHasPage;
  const text = inputEl.value.trim();
  const pendingAtts = attachments.getAttachments();
  if (!text && pendingAtts.length === 0) return;
  // steer 归入进行中的 run，不动计时起点；新消息重开计时
  if (!running&&!held) runStartAt = Date.now();
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
    running||held
      ? { type: "task_action", request:{requestId:crypto.randomUUID(),conversationId:selectedConversationId,source:'text',action:'steer',expectedRunId:conversations.get(selectedConversationId)?.runId??null,text,context,attachments:clientAttachments} }
      : { type: "task_action", request:{requestId:crypto.randomUUID(),conversationId:selectedConversationId,source:'text',action:'start',expectedRunId:conversations.get(selectedConversationId)?.runId??null,text,context,attachments:clientAttachments} },
  );
  if (!sent) { noticeSendFailed(); return; }
  sendFailNotified = false;
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
