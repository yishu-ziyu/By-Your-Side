import { RunOrbActivity, orbStateRuns } from "./run-orb.js";
import { CollaborationProgress, renderCollaboration } from "./collaboration-progress.js";
import { mountVoiceUI } from "./voice-ui.js";
import { createOrb, type OrbHandle } from "./orb.js";
/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 *
 * 渲染层依赖：marked（assistant 消息 Markdown 渲染）+ dompurify（消毒）+ lucide（图标）。
 */
import { renderMarkdownHtml } from "./markdown.js";
import { attachAnswerActions } from "./answer-actions.js";
import { revealText } from "./stream-reveal.js";
import { beginStarterProbe, isLatestStarterProbe, noteStarterTab, probePageProfile, starterTab, suggestionsFor, type PageProfile } from "./starter-suggestions.js";
import { renderReceipt } from "./receipt-view.js";
import { receiptCopy } from "./receipt-copy.js";
import type { TaskReceipt, TaskActionRequest } from "../../../shared/task-actions.js";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Hand, Check, CircleAlert, Ellipsis, Plus, LoaderCircle, BookOpen, Database, Play, SlidersHorizontal } from "lucide";
import { describeSteps, recordingHint, type DemoStep } from "../../../shared/demo-record.js";
import { skillHealth, skillRunSummary, skillStepsText, sensitiveSkillInput, type Skill, type SkillRun, type SkillCandidate } from "../../../shared/skill.js";
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
  finishedRunTitle,
  spokenDuration,
  loaderSubtitle,
  workerEventRunPolicy,
  isLiveViewportPinned,
  liveViewportOverflows,
} from "./steps.js";
import { cursorColor } from "../shared/palette.js";
import { LEAD_COLOR, displayColor, displayNameFor, personFor } from "../../../shared/cast.js";
import { mountGrok, mountKenney, type GrokHandle } from "../shared/grok-bot.js";
import { mountCompanion } from "./companion.js";
import { ArtifactCards } from "./artifact-card.js";
import {
  humanizeModelError,
} from "./models.js";
import { mountModelPicker } from "./model-picker.js";
import { mountReadingSettings } from "./reading-settings.js";
import { AttachmentsManager } from "./attachments.js";
import { LEAD_SESSION_ID, isLeadSession, parseServerMessage } from "../../../shared/protocol.js";
import type { AgentMode, AgentRunState, AgentUiEvent, Attachment, ClientMessage, ConversationSummary, ServerMessage, TeamView } from "../../../shared/protocol.js";
import { DEFAULT_STEP_VOICE, isStepVoice, parseVoicePersona, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, type UserDelivery, type VoiceInputContext } from "../../../shared/voice.js";
import { MEMORY_TEXT_MAX, normalizeMemoryHostname, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import { isWriteTool, memberBoundPageLabel, memberStatusLabel, panelLive, shouldFinishRunOnDisconnect, shouldShowTeamCard, teamSummaryLabel } from "../../../shared/control.js";
import { conversationBackgroundLabel, conversationStateLabel, resultCardCopy } from "./selectors.js";
import { TaskBar } from "./task-bar.js";
import { ResumeEntry } from "./resume-entry.js";
import { DeliveryPresentationTiming, deliveryPresentation } from "./delivery-facts-view.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelHistoryEntry, type PanelToBg } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";
import { DEFAULT_MARK_MOTION, isMarkMotion, MARK_MOTION_KEY, type MarkMotion } from "../shared/mark-motion.js";
import { acceptTeamStatus, emptyTeamRun, isRunId, observeRunStarted, type TeamRunState } from "../shared/team-run.js";
import { MemoryManagementState, memoryScopeLabel, sameMemorySnapshot, type MemoryApplyResult } from "./memory.js";
import { ConsentPanel } from "./consent.js";

const TOKEN_KEY = "sideagent_token";

const TEACH_MODE_KEY = "sideagent_teach_mode";

const PLACEHOLDER_IDLE = "说说你想完成什么…";

const PLACEHOLDER_RUNNING = "插话：调整 Agent 的方向…（Enter 发送）";

const PLACEHOLDER_USER = "现在归你。可补充要求，Enter 保存；交还后生效";

const PLACEHOLDER_DRAINING = "正在停止所有 Agent 的新动作。";

const PLACEHOLDER_PARTIAL = "部分成员已恢复。未续跑的人仍归你。";


// 渲染出的链接一律新开标签页
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(renderMarkdownHtml(text));
}

const app = document.getElementById("app")!;

app.innerHTML = `
  <header id="topbar">
    <div class="brand-cluster">
      <img id="logo" src="icons/brand-mark.svg" alt="" />
      <span id="brand">By Your Side</span>
    </div>
    <div id="status-pill" class="activity-island" title="当前连接与执行状态">
      <span id="status-dot" class="dot island-pulse-dot"></span>
      <span id="status-text">未连接</span>
    </div>
    <button id="header-more" type="button" popovertarget="header-menu" aria-label="更多" title="更多"></button>
    <div id="header-menu" popover="auto" aria-label="更多功能">
      <button id="record-toggle" type="button" title="你亲手做一遍，AI 记录为可复用的技能" aria-pressed="false"><span>示范给 AI</span></button>
      <button id="memory-open" type="button" aria-haspopup="dialog" aria-expanded="false"><span>技能与记忆</span></button>
      <hr />
      <button id="model-settings-open" type="button"><span>模型与语音</span></button>
      <button id="reading-settings-btn" type="button"><span>阅读外观</span></button>
      <button id="companion-toggle" type="button" aria-pressed="true"><span>显示小伙伴 M</span></button>
    </div>
  </header>
  <div id="conversation-bar">
    <button id="conversation-switcher" type="button" aria-haspopup="menu" aria-expanded="false">新会话 ▾</button>
    <button id="conversation-new" type="button" aria-label="新会话" title="新会话">＋</button>
  </div>
  <div id="operation-bar">
    <select id="teach-toggle" aria-label="操作方式" title="选择由 AI 操作，或由 AI 指导你操作">
      <option value="act">帮我操作</option>
      <option value="teach">指导我操作</option>
    </select>
  </div>
  <button id="conversation-background" type="button" hidden></button>
  <div id="consent-requests" aria-label="请求授权" hidden></div>
  <div id="task-bar-root"></div>
  <div id="task-strip" aria-label="当前会话与结果">
    <div id="task-result-card" hidden>
      <div id="task-result-primary"></div>
      <div id="task-result-secondary"></div>
    </div>
  </div>
  <div id="conversation-menu" role="menu" hidden></div>
  <button id="memory-shade" type="button" aria-label="关闭记忆" hidden></button>
  <section id="memory-drawer" role="dialog" aria-label="技能与记忆" aria-modal="false" hidden>
    <div class="memory-drawer-head">
      <div>
        <h2 id="memory-title">技能与记忆</h2>
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
  <div id="messages">
    <div id="resume-entry-root"></div>
  </div>
  <div id="team-card" hidden></div>
  <section id="starter" aria-label="开始方式">
    <p id="starter-title">说说你想完成什么</p>
    <p id="starter-sub">浏览器 AI 助手，帮你读页面、整理信息或操作网页。</p>
    <div id="starter-actions">
      <button type="button" data-starter="请概括当前页面的要点。">概括当前页</button>
      <button type="button" data-starter="请帮我填写当前页面的表单，提交前让我确认。">帮我填写表单</button>
    </div>
  </section>
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
        <button type="button" id="demo-stop" hidden>结束示范</button>
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
        <button id="composer-more" type="button" popovertarget="composer-menu" aria-label="输入选项">···</button>
        <button id="takeover-btn" type="button" title="拿回当前页面，Agent 先停手" hidden>接管</button>
        <button id="abort-btn" type="button" title="中止" hidden></button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span>
          <span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
  <div id="composer-menu" popover="auto"><button id="voice-diagnostics-open" type="button">语音诊断</button></div>
  <div id="model-popover" hidden></div>
  <div id="setup" hidden>
    <h2>By Your Side 设置</h2>
    <p class="hint">native host 未安装时的调试通道：先跑 <code>npm run dev:agent</code>，把终端里的 token 粘贴到下面（只需设置一次）。正常用法：<code>npm run install:host</code> 后无需本页。</p>
    <input id="token-input" type="text" placeholder="token" autocomplete="off" />
    <div id="setup-err" class="err"></div>
    <button id="setup-save" type="button">保存并连接</button>
  </div>
`;

/**
 * 宿主没有记忆、技能存储时（只装扩展），不给只会报「存储不可用」的入口：
 * 「示范给 AI」要把示范编译成技能，「技能与记忆」要读这两个存储。旧宿主不报时按有处理。
 */
function applyHostFeatures(features: { memory: boolean; skills: boolean } | undefined): void {
  const skills = features?.skills ?? true;
  const memory = features?.memory ?? true;
  document.getElementById("record-toggle")!.hidden = !skills;
  document.getElementById("memory-open")!.hidden = !skills && !memory;
  document.querySelector<HTMLElement>("#header-menu hr")!.hidden = !skills && !memory;
}

// 原生 popover 负责外部点击和 Escape；各入口复用已有行为。
const headerMore = document.getElementById("header-more") as HTMLButtonElement;

const headerMenu = document.getElementById("header-menu")!;

headerMore.append(icon(Ellipsis));

headerMore.addEventListener("click", (event) => {
  headerMenu.classList.toggle("keyboard-open", event.detail === 0);
});

headerMenu.addEventListener("click", (event) => {
  if (!(event.target as Element).closest("button")) return;
  headerMenu.hidePopover();

  // Dialogs move focus themselves; a recording command returns to its visible trigger.
  if (headerMenu.contains(document.activeElement)) headerMore.focus();
});

mountReadingSettings({
  topbar: document.getElementById("topbar")!, app,
  trigger: document.getElementById("reading-settings-btn") as HTMLButtonElement,
  returnFocus: headerMore,
});

const statusDot = document.getElementById("status-dot") as HTMLElement;

const statusText = document.getElementById("status-text")!;

const messagesEl = document.getElementById("messages")!;

const composerEl = document.getElementById("composer") as HTMLElement;

const inputEl = document.getElementById("input") as HTMLTextAreaElement;

const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;

sendBtn.disabled = true;

const takeoverBtn = document.getElementById("takeover-btn") as HTMLButtonElement;

const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;

const teachToggle = document.getElementById("teach-toggle") as HTMLSelectElement;

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

/** 附件管理器构造期间会回调 onChanged；装配完成前不碰任务条。 */
let attachmentsReady = false;

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

/**
 * 面板每次"打开进入"都开一段新会话：文档启动即置位，重连不重置。
 * 决定方式——上一段还是空白页（标题仍是"新会话"）就复用它，否则另开一段；
 * 方案见 docs/evals/20260911-open-panel-new-session.md。
 */
let bootFreshSession = true;

let bootInheritedId: string | null = null;

let bootDecisionTimer: ReturnType<typeof setTimeout> | null = null;

let bootCreateTimer: ReturnType<typeof setTimeout> | null = null;

/** 会话清单迟迟不到时的兜底时限；新建请求迟迟没有回执时的回退时限。 */
const BOOT_DECISION_TIMEOUT_MS = 6_000;

const BOOT_CREATE_FALLBACK_MS = 4_000;

const conversations = new Map<string, ConversationSummary>();

const consentPanel = new ConsentPanel(
  document.getElementById("consent-requests")!,
  () => selectedConversationId,
  id => conversations.get(id)?.title ?? "其他会话",
  id => selectConversation(id),
  message => send(message),
);

window.addEventListener("pagehide", () => consentPanel.dispose());

const receiptMessages = new Map<string, HTMLElement>();

const receiptForks = new Map<string, { request: TaskActionRequest; resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();

const receiptForkPromises = new Map<string, Promise<void>>();

function forkReceipt(receipt: TaskReceipt): Promise<void> {
  const key = `${receipt.conversationId}:${receipt.requestId}`;
  const existing = receiptForkPromises.get(key);

  if (existing) return existing;

  if (!receipt.newConversationRequest) return Promise.reject(new Error('缺少原请求，请重新输入。'));
  const request = structuredClone(receipt.newConversationRequest);
  const creationId = crypto.randomUUID();

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { receiptForks.delete(creationId); reject(new Error('新会话回执未到达，未自动发送原请求；请检查会话列表。')); }, 15000);
    receiptForks.set(creationId, {request, resolve, reject, timer});

    if (!send({type:'conversation_create',requestId:creationId})) {
      clearTimeout(timer); receiptForks.delete(creationId); reject(new Error('连接已断开，原请求未发送。'));
    }
  });

  receiptForkPromises.set(key,promise);
  void promise.catch(() => receiptForkPromises.delete(key));

  return promise;
}

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

/** 当前会话的输入草稿是否已真正恢复完（切会话清空，旧 restore 不得标新会话）。 */
let currentDraftReady = false;

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
    currentDraftReady = true;
    updateStarterVisibility();
  } finally { restoringDraft = false; }
}

/**
 * 起点引导只在"会话历史回放完 + 当前草稿恢复完"后出现：慢恢复期间 input 还是空的，
 * 提前显示会让点击把 storage 里的原草稿覆盖成建议（约定见 docs/human-ai-contract.md）。
 * 建议只写进草稿，发送仍由用户决定；出现与收起交给 styles.css 的 :has 判断。
 */
function starterReady(): boolean {
  return historyPrimed && currentDraftReady;
}

function updateStarterVisibility(): void {
  app.classList.toggle("starter-ready", starterReady());

  const tabId = starterTab();

  if (starterReady() && tabId != null) void refreshStarterSuggestions(tabId);
}

function bindStarterButton(button: HTMLButtonElement): void {
  button.onclick = () => {
    // 还没恢复完就点（引导不可见时的键盘/事件竞态）：不写草稿，别覆盖正在恢复的原草稿。
    if (!starterReady()) return;

    if (!inputEl.value.trim()) {
      inputEl.value = button.dataset.starter ?? "";
      autoResize();
      saveDraft();
    }

    inputEl.focus();
  };
}

document.querySelectorAll<HTMLButtonElement>("#starter button[data-starter]").forEach(bindStarterButton);

/** 会话里还没有任何回合：续做卡挂载点常驻在 #messages 里，它没内容时不算。 */
function conversationEmpty(): boolean {
  return !Array.from(messagesEl.children).some((child) => child.id !== "resume-entry-root" || child.childElementCount > 0);
}

new MutationObserver(() => app.classList.toggle("conversation-empty", conversationEmpty())).observe(messagesEl, { childList: true, subtree: true });

app.classList.toggle("conversation-empty", conversationEmpty());

/** 空白新对话时按当前页面结构换一组建议；探测失败（受限页等）沿用默认建议。 */
async function refreshStarterSuggestions(tabId: number): Promise<void> {
  if (!conversationEmpty() || typeof chrome === "undefined" || !chrome.scripting?.executeScript) return;
  const probe = beginStarterProbe();
  let profile: PageProfile | null = null;

  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: probePageProfile });
    profile = frame?.result ?? null;
  } catch {
    profile = null;
  }

  if (!isLatestStarterProbe(probe)) return;
  const box = document.getElementById("starter-actions");

  box?.replaceChildren(...suggestionsFor(profile).map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.starter = item.prompt;
    button.textContent = item.label;
    bindStarterButton(button);

    return button;
  }));
}

function upsertConversation(c: ConversationSummary): void {
  if (conversations.get(c.id)?.state === "running" && c.state === "idle" && !c.checkpoint && c.id !== selectedConversationId) completedConversations.add(c.id);

  if (c.checkpoint) completedConversations.delete(c.id);
  conversations.set(c.id, c);

  if (c.id === selectedConversationId) noteRunStarted(c.runId);
}

function renderConversations(): void {
  const current = conversations.get(selectedConversationId);
  const currentTitle = document.createElement("span");
  currentTitle.className = "conversation-title";
  currentTitle.textContent = current?.title || "新会话";
  conversationSwitcher.replaceChildren(currentTitle, icon(ChevronDown));
  conversationSwitcher.title = current?.title || "切换会话";
  conversationNew.disabled = !conversationReady || !transportConnected || conversationRequest !== null;
  conversationNew.replaceChildren(icon(conversationRequest ? LoaderCircle : Plus));
  conversationNew.setAttribute("aria-label", conversationRequest ? "正在新建会话" : "新会话");
  conversationNew.setAttribute("aria-busy", String(!!conversationRequest));
  conversationNew.title = conversationRequest ? "正在新建会话" : "新会话";
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
    ?? list.find((c) => c.id !== selectedConversationId && c.checkpoint === "interrupted")
    ?? list.find((c) => c.id !== selectedConversationId && completedConversations.has(c.id));

  conversationBackground.hidden = !other;

  if (other) {
    conversationBackground.textContent = `${other.title} · ${conversationBackgroundLabel(other)} ↗`;
    conversationBackground.onclick = () => selectConversation(other.id);
  }
}

function resetConversationRender(): void {
  if (currentRun) { clearInterval(currentRun.timer); currentRun.orb.dispose(); }

  closeBlocks();
  currentRun = null;
  lastRun = null;
  runStartAt = 0;
  toolChips.clear();
  sessionRun.clear();
  teamView = null;
  teamRunId = null;
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
  currentDraftReady = false;
  updateStarterVisibility();
  const resumeRoot = document.getElementById("resume-entry-root");
  messagesEl.replaceChildren();

  if (resumeRoot) messagesEl.appendChild(resumeRoot);
  resumeEntry.clear();
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, "idle");
  companion.onTakeover(false);
}

function selectConversation(id: string, notify = true): void {
  const preserveInitialDraft = !conversationReady && (inputEl.value.length > 0 || attachments.getAttachments().length > 0 || pendingAsk !== null);

  if (id !== selectedConversationId) voiceUI.stop();
  completedConversations.delete(id);
  conversationMenu.hidden = true;
  conversationSwitcher.setAttribute("aria-expanded", "false");

  if (id !== selectedConversationId || !conversationReady) {
    if (conversationReady) saveDraft();
    selectedConversationId = id;
    conversationReady = true;
    sendBtn.disabled = false;

    if (preserveInitialDraft) saveDraft();
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
    modelPicker.reset();
    void restoreDraft(id).catch(() => addMsg("msg error", "未能恢复这段会话的输入草稿。"));
  }

  renderConversations();
  renderTaskStrip();
  taskBar.reset();
  queryTaskView();
  consentPanel.refresh();

  if (notify) port?.postMessage({ kind: "select_conversation", conversationId: id } satisfies PanelToBg);
  port?.postMessage({ kind: "sync", conversationId: id, afterSeq: lastHistorySeq } satisfies PanelToBg);
}

/**
 * 打开进入时的会话决策：清单里上一段还是空白的新会话就复用它，否则另开一段。
 * 清单没到、后台还没连上都不急着建；等下一次清单/连接事件或兜底时限再定。
 */
function resolveBootSession(inheritedId: string, listKnown: boolean): void {
  if (!bootFreshSession) return;
  bootInheritedId = inheritedId;
  const inherited = conversations.get(inheritedId);

  if (!inherited && !listKnown) return;

  if (inherited && inherited.title === "新会话" && inherited.state === "idle") {
    finishBootSession();
    selectConversation(inheritedId, false);

    return;
  }

  if (!requestNewConversation()) { armBootDecisionTimeout();

 return; }

  finishBootSession();
}

function finishBootSession(): void {
  bootFreshSession = false;

  if (bootDecisionTimer !== null) {
    clearTimeout(bootDecisionTimer);
    bootDecisionTimer = null;
  }
}

function armBootDecisionTimeout(): void {
  if (bootDecisionTimer !== null) return;
  bootDecisionTimer = setTimeout(() => {
    bootDecisionTimer = null;

    if (!bootFreshSession) return;

    if (!transportConnected) { armBootDecisionTimeout();

 return; }

    if (!requestNewConversation()) { armBootDecisionTimeout();

 return; }

    finishBootSession();
  }, BOOT_DECISION_TIMEOUT_MS);
}

/** 新开会话的请求；返回是否真的发出（未连接或端口不可用时不动状态，留给下一次重试）。 */
function requestNewConversation(): boolean {
  if (conversationRequest) return true;

  if (conversationReady) saveDraft();
  conversationRequest = crypto.randomUUID();
  renderConversations();

  if (!send({ type: "conversation_create", requestId: conversationRequest })) {
    conversationRequest = null;
    renderConversations();

    return false;
  }

  if (bootCreateTimer !== null) clearTimeout(bootCreateTimer);
  bootCreateTimer = setTimeout(() => {
    bootCreateTimer = null;

    if (conversationReady || conversationRequest === null) return;
    // 后台迟迟没有回执：不把面板卡在"正在新建"，退回显示上一段。
    conversationRequest = null;
    renderConversations();

    if (bootInheritedId) selectConversation(bootInheritedId, false);
  }, BOOT_CREATE_FALLBACK_MS);

  return true;
}

conversationSwitcher.onclick = () => {
  conversationMenu.hidden = !conversationMenu.hidden;
  conversationSwitcher.setAttribute("aria-expanded", String(!conversationMenu.hidden));
};

conversationNew.onclick = () => {
  if (!conversationReady || conversationRequest) return;
  requestNewConversation();
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
  headerMore.focus();
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

recordToggle.prepend(icon(Play));

memoryOpen.prepend(icon(Database));

document.getElementById("reading-settings-btn")!.prepend(icon(BookOpen));

const modelSettingsOpen = document.getElementById("model-settings-open")!;

modelSettingsOpen.prepend(icon(SlidersHorizontal));

modelSettingsOpen.addEventListener("click", () => void chrome.runtime.openOptionsPage());

function clipTitle(text: string, max = 16): string {
  const t = text.trim();

  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 活动标签页快照：页面标牌与任务条材料共用同一份事实，不重复假设。 */
let activeTabInfo: { id: number; title: string; url: string } | null = null;

async function refreshActiveTabPill(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
    if (tabTitleText) tabTitleText.textContent = "浏览器活动标签页";

    return;
  }

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab) return;

    if (tab.id != null) {
      activeTabInfo = { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
      noteStarterTab(tab.id);
      void refreshStarterSuggestions(tab.id);
    }

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
  chrome.tabs.onActivated?.addListener(() => { void refreshActiveTabPill(); taskBar.noteTabsChanged(); });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status || changeInfo.title || changeInfo.url) {
      void refreshActiveTabPill();
      taskBar.noteTabsChanged();
    }
  });
  chrome.tabs.onRemoved?.addListener(() => taskBar.noteTabsChanged());
}

void refreshActiveTabPill();

const companion = mountCompanion({
  appEl: app,
  composerEl,
  inputEl,
  messagesEl,
  pagePillEl: pagePill,
});

// ── 小伙伴 M 显示开关：存 chrome.storage.local，面板重开保持；默认显示 ──
const COMPANION_VISIBLE_KEY = "sideagent_companion_visible";

// SAFETY: #companion-toggle 在上面的面板模板里写死为 <button>。
const companionToggle = document.getElementById("companion-toggle") as HTMLButtonElement;

function applyCompanionVisible(visible: boolean): void {
  app.dataset.companion = visible ? "on" : "off";
  companionToggle.setAttribute("aria-pressed", String(visible));
}

void chrome.storage.local.get(COMPANION_VISIBLE_KEY).then((stored) => applyCompanionVisible(stored[COMPANION_VISIBLE_KEY] !== false));

companionToggle.addEventListener("click", () => {
  const visible = app.dataset.companion === "off";

  applyCompanionVisible(visible);
  void chrome.storage.local.set({ [COMPANION_VISIBLE_KEY]: visible });
});

// ── 教学模式开关 ───────────────────────────────────────────────────
// 开关状态存 chrome.storage.local（面板重开恢复显示）；运行时权威在 background
// （chrome.storage.session），background 推来的 mode 消息会反向收敛本地存储。

let markMotion: MarkMotion = DEFAULT_MARK_MOTION;

let teachMode = false;

function renderTeachToggle(): void {
  teachToggle.classList.toggle("on", teachMode);
  teachToggle.value = teachMode ? "teach" : "act";
  const motionLabel = markMotion === "boil" ? "持续微抖" : "生长定格";
  teachToggle.title = teachMode
    ? `教学模式已开启（手绘动效：${motionLabel}，右击切换）：Agent 只标注引导，由你手动操作（选择“帮我操作”关闭）`
    : `教学模式：Agent 只标注引导，由你手动操作（选择“指导我操作”开启，右击切换手绘动效：${motionLabel}）`;
}

function applyMode(mode: AgentMode, persist: boolean): void {
  teachMode = mode === "teach";
  renderTeachToggle();

  if (persist) void chrome.storage.local.set({ [TEACH_MODE_KEY]: teachMode });
}

void chrome.storage.local.get([TEACH_MODE_KEY, MARK_MOTION_KEY]).then((stored) => {
  const motion = stored[MARK_MOTION_KEY];
  markMotion = isMarkMotion(motion) ? motion : DEFAULT_MARK_MOTION;
  applyMode(stored[TEACH_MODE_KEY] === true ? "teach" : "act", false);
});

teachToggle.onchange = () => {
  applyMode(teachToggle.value === "teach" ? "teach" : "act", true);
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

let learnedCandidates: SkillCandidate[] = [];

// ── 知识抽屉：技能与记忆一个入口（方案一：摘要 + 展开） ──────────────
// 默认只露「名字 + 事实行 + 一个主按钮」；凭证、步骤、脚本、其余动作收进一次展开。

/** 打开抽屉：分段决定看哪一半；两边各自按需拉数据。 */
async function openKnowledge(segment: "skills" | "memory"): Promise<void> {
  memoryDrawer.hidden = false;
  memoryShade.hidden = false;
  memoryOpen.setAttribute("aria-expanded", "true");
  setKnowledgeSegment(segment);
  memoryClose.focus();
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
  const conversationId = selectedConversationId;
  const hostname = await currentHostname();

  if (conversationId !== selectedConversationId) return;
  skillRequest = crypto.randomUUID();
  const skillList: Extract<ClientMessage, { type: "skill_list" }> = { type: "skill_list", conversationId, requestId: skillRequest };

  if (hostname) skillList.hostname = hostname;
  send(skillList);
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
  const editing = skillList.querySelector<HTMLFormElement>(".skill-run-inputs");

  if (editing) {
    // A late list refresh must not discard values the user has begun typing.
    // Keep the existing row and its handlers; a changed version disables execution.
    const current = skillEntries.find(entry => entry.skill.id === editing.dataset.skillId)?.skill;

    if (!current || String(current.version) !== editing.dataset.skillVersion) {
      const submit = editing.querySelector<HTMLButtonElement>('button[type="submit"]');

      if (submit) { submit.disabled = true; submit.textContent = "做法已变化，请重新打开后核对"; }
    }

    return;
  }

  skillList.replaceChildren();

  for (const candidate of learnedCandidates) {
    const card = document.createElement("div");
    card.className = "observe-card";
    card.dataset.skillCandidate = candidate.skill.id;
    const title = document.createElement("p");
    title.textContent = `${candidate.skill.name.replace(/\{\{([^{}]+)\}\}/g, "〔$1〕")} · 待你确认保存`;
    const facts = document.createElement("p");
    facts.className = "row-facts";
    facts.textContent = `${candidate.evidence.actionCount} 步已执行并核对结果；尚未启用，不保存输入内容。`;
    const detail = document.createElement("details");
    detail.className = "disc";
    const summary = document.createElement("summary"); summary.textContent = "查看做法与完成条件";
    const body = document.createElement("div"); body.className = "disc-body";

    for (const text of [...skillStepsText(candidate.skill), candidate.skill.check.text]) {
      const line = document.createElement("p"); line.textContent = text; body.appendChild(line);
    }

    detail.append(summary, body);
    const actions = document.createElement("div"); actions.className = "row-actions";
    const save = document.createElement("button"); save.type = "button"; save.className = "btn primary"; save.textContent = "保存这份做法";
    const dismiss = document.createElement("button"); dismiss.type = "button"; dismiss.className = "btn ghost"; dismiss.textContent = "不用保存";

    const decide = (type: "skill_candidate_save" | "skill_candidate_dismiss") => {
      skillRequest = crypto.randomUUID(); save.disabled = true; dismiss.disabled = true;

      if (!send({ type, requestId: skillRequest, id: candidate.skill.id, sourceRunId: candidate.sourceRunId })) {
        save.disabled = false; dismiss.disabled = false;
      }
    };

    save.onclick = () => decide("skill_candidate_save"); dismiss.onclick = () => decide("skill_candidate_dismiss");
    actions.append(save, dismiss); card.append(title, facts, detail, actions); skillList.appendChild(card);
  }

  if (skillEntries.length === 0 && learnedCandidates.length === 0) {
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
      if (!health.stale) { startSkillRun(skill, runBtn);

 return; }

      // 可能过期：不直接跑，先就地确认，不弹原生对话框（那会卡住整个面板）
      runBtn.textContent = "可能过期，仍然要跑？";

      if (!row.querySelector(".stale-confirm")) {
        const confirmRow = document.createElement("div");
        confirmRow.className = "row-actions stale-confirm";
        const yes = document.createElement("button");
        yes.type = "button";
        yes.className = "btn";
        yes.textContent = "确认跑一次";
        yes.onclick = () => { confirmRow.remove(); runBtn.textContent = "照上次那样跑"; startSkillRun(skill, runBtn, undefined, true); };

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
    noteBtn.onclick = () => { noteBox.hidden = !noteBox.hidden;

 if (!noteBox.hidden) noteInput.focus(); };

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

function startSkillRun(skill: Skill, button: HTMLButtonElement, inputs?: Record<string, string>, allowStale = false): void {
  const keys = Object.keys(skill.inputs);

  if (keys.length && inputs === undefined) {
    const row = button.closest(".row");

    if (!row || row.querySelector(".skill-run-inputs")) return;
    const form = document.createElement("form"); form.className = "skill-run-inputs disc-body";
    form.dataset.skillId = skill.id; form.dataset.skillVersion = String(skill.version);
    const fields = new Map<string, HTMLInputElement>();
    const hint = document.createElement("p"); hint.textContent = "这次用什么材料？修改只对本次生效。"; form.appendChild(hint);

    for (const key of keys) {
      const label = document.createElement("label"); label.textContent = key;
      const input = document.createElement("input");
      const sensitive = sensitiveSkillInput(skill, key);
      input.type = sensitive ? "password" : "text"; input.autocomplete = "off"; input.maxLength = 8000;
      input.value = sensitive ? "" : skill.inputs[key]!; input.required = sensitive || !input.value;
      label.appendChild(input); form.appendChild(label); fields.set(key, input);
    }

    const submit = document.createElement("button"); submit.type = "submit"; submit.className = "btn primary"; submit.textContent = "用这些材料执行";
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "btn ghost"; cancel.textContent = "取消"; cancel.onclick = () => { form.remove(); renderSkills(); };

    form.append(submit, cancel);
    form.onsubmit = event => {
      event.preventDefault();
      const values = Object.fromEntries([...fields].map(([key, input]) => [key, input.value]));
      fields.forEach(input => { input.value = ""; }); form.remove(); startSkillRun(skill, button, values, allowStale);
    };

    row.appendChild(form); fields.values().next().value?.focus();

 return;
  }

  button.disabled = true;
  button.textContent = "跑着…";
  skillRequest = crypto.randomUUID();

  if (!send({ type: "skill_run", requestId: skillRequest, id: skill.id, expectedVersion: skill.version, inputs, allowStale })) {
    button.disabled = false; button.textContent = "照上次那样跑";
  }
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
  recordToggle.querySelector("span")!.textContent = recording ? "结束示范" : "示范给 AI";
  document.getElementById("demo-stop")!.hidden = !recording;
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

  if (!host) { addMsg("msg error", "这份示范没有可用的站点信息，换个普通网页再试。");

 return; }

  demoCompile.disabled = true;
  demoCompile.textContent = "编译中…";
  skillRequestId = crypto.randomUUID();

  const compile: Extract<ClientMessage, { type: "skill_compile" }> = {
    type: "skill_compile",
    requestId: skillRequestId,
    intent: demoIntent.value,
    hostname: host,
    demoId: `${selectedConversationId}-${steps.length}-${steps[0]?.at ?? 0}`,
    steps,
  };

  if (redoSkillId) {
    compile.updateId = redoSkillId;

    if (redoSkillVersion !== null) compile.expectedVersion = redoSkillVersion;
  }

  send(compile);
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

document.getElementById("demo-stop")!.onclick = () => recordToggle.click();

demoClose.onclick = () => {
  port?.postMessage({ kind: "demo", action: "dismiss", conversationId: selectedConversationId } satisfies PanelToBg);
  demoState = { recording: false, steps: [], truncated: false };
  demoIntent.value = "";
  demoSkill.hidden = true;
  demoSkill.replaceChildren();
  renderDemo();
};

// ── 模型选择器 ─────────────────────────────────────────────────────
// 芯片在输入区左下，搜索面板从芯片长出：完整实现见 ./model-picker.ts。
// 数据源是 agent 下发的 hello_ok.models / model_info；选择后发 set_model，
// 等 agent 回 model_info 再更新显示（收到回执才改变状态）。
const modelPicker = mountModelPicker({
  host: {
    button: modelBtn,
    mark: modelMark,
    name: modelName,
    reasoningTag: modelReasoningTag,
    popover: modelPopover,
    composer: composerEl,
    app,
  },
  sendSetModel: (model) => {
    send({ type: "set_model", model });
  },
});

let port: chrome.runtime.Port | null = null;

let reconnectAttempt = 0;

/**
 * service worker 被 Chrome 停掉（空闲、更新、崩溃）后，面板手里的端口不一定收到断开事件：
 * 状态仍显示已连接，发出的任务落进死端口、静默丢失。不做一次往返就无法知道端口是否活着，所以：
 * - 1 秒内收到过 pong 的端口直接发；否则消息先排队、发 ping，pong 回来再发出。
 * - ping 1.5 秒没有回应就换端口重连，连上后发出排队的消息（消息没离开面板，重发不会重复执行）。
 * - 每 5 秒也 ping 一次：空闲时提前发现死端口；面板开着时顺带让 service worker 保持存活。
 */
const PORT_PING_MS = 5_000;

const PORT_FRESH_MS = 1_000;

const PORT_PONG_TIMEOUT_MS = 1_500;

let lastPong = 0;

let pingSentAt: number | null = null;

let portWatch: ReturnType<typeof setInterval> | null = null;

const queuedSends: PanelToBg[] = [];

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

/** 运行状态行的球：比 chip 略大一点，它是整条状态行唯一的"在跑"指示。 */
const ORB_BOX_STATUS = 24;

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
  orbMark: HTMLSpanElement;
  orbActivity: RunOrbActivity;
  collaboration: CollaborationProgress;
  collaborationEl: HTMLElement;
  root: HTMLDetailsElement;
  body: HTMLElement;
  iconBox: HTMLElement;
  chainEl: HTMLElement;
  timeEl: HTMLElement;
  chain: StepChain;
  start: number;
  /** 运行中唯一的状态行：summary 里的「正在做什么 · 耗时」，细节收进 body 点开再看。 */
  titleEl: HTMLElement;
  orb: OrbHandle;
  /** 耗时读数 interval；finishRun 必清，防泄漏。 */
  timer: number;
  /** 最近一个工具的中文动作名（loader 副标题）。 */
  lastToolShort: string | null;
  /** 当前 chip 分组；思考块插入后另起一组。 */
  chipGroup: ChipGroup | null;
  workers: Map<string, WorkerLane>;
  /** 这一轮动过页面（标注、开标签、填写等）；只读回合结束后不留过程行。 */
  changedPage: boolean;
}

/** 当前 run；run 外为 null。 */
let currentRun: RunHost | null = null;

/** finishRun 刚收掉的那一块。全员 idle 后到达的 agent_end 复用它，禁止再开 loader。 */
let lastRun: RunHost | null = null;

/** 显式交付气泡：按 delivery.id 只渲染一次，状态更新不重复生成。 */
const deliveredBubbles = new Map<string, HTMLElement>();

const resultByConversation = new Map<string, { summary: string | null; remaining: string[]; unknown: boolean; speechFailed: boolean }>();

/** T06：正式交付 → 结果可见的下一帧采样；只在验收模式读取。 */
const deliveryTiming = new DeliveryPresentationTiming();

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
 *
 * `_` 前缀表示"有意未使用"：这条回退路径随时可能接回，删掉会丢掉那个待定决定。
 */
const _TOOL_ICONS = new Map<string, Parameters<typeof icon>[0]>([
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
    pill.title = text;
    pill.setAttribute("aria-label", text);
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

  appendToMessages(div);

  if (!applyingHistory) {
    companion.onSend(div);
  }

  scrollToEnd();

  return div;
}

function appendToMessages(node: HTMLElement): void {
  const resumeRoot = document.getElementById("resume-entry-root");

  if (resumeRoot && resumeRoot.parentElement === messagesEl) {
    messagesEl.insertBefore(node, resumeRoot);
  } else {
    messagesEl.appendChild(node);
  }
}

/** 模型写给用户的文件：一张卡片一个文件名，点「下载」保存。 */
const artifactCards = new ArtifactCards((el) => {
  appendToMessages(el);
  scrollToEnd();
});

function addMsg(cls: string, text: string): HTMLElement {
  if (cls.split(/\s+/).includes("user")) {
    return addUserMsg(text);
  }

  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  appendToMessages(div);
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
// 一次 run（用户消息 → agent_end）只有一条状态行：[光球] 正在做什么 · 耗时（在 summary 上）。
// 思考块与工具 chips 收进同一个 details 的 body，运行中也不展开——要看过程点一下。


function ensureRun(): NonNullable<typeof currentRun> {
  if (currentRun) return currentRun;
  const root = document.createElement("details");
  root.className = "run-steps";
  // 过程默认收起，工具与协作任务使用同一个展开入口。
  root.open = false;
  const summary = document.createElement("summary");
  const iconBox = document.createElement("span");
  iconBox.className = "run-icon";
  const orb = createOrb("thinking", ORB_BOX_STATUS);

  if (!applyingHistory) orb.setRunning(true);
  const orbMark = document.createElement("span");
  orbMark.className = "run-orb-mark";
  orbMark.hidden = true;
  orbMark.setAttribute("role", "img");
  iconBox.append(orb.el, orbMark);
  const title = document.createElement("span");
  title.className = "run-title";
  title.textContent = `正在${loaderSubtitle(null)}`;
  const chainEl = document.createElement("span");
  chainEl.className = "run-chain";
  const timeEl = document.createElement("span");
  timeEl.className = "run-time";
  const chevron = document.createElement("span");
  chevron.className = "run-chevron";
  chevron.appendChild(icon(ChevronDown));
  summary.append(iconBox, title, chainEl, timeEl, chevron);
  const collaborationEl = document.createElement("div");
  collaborationEl.className = "run-collaboration";
  collaborationEl.hidden = true;

  const body = document.createElement("div");
  body.className = "run-body";
  runBodyPinned = true;
  bindLiveViewport(body, (next) => {
    runBodyPinned = next;
  });
  body.append(collaborationEl);
  const reveal = document.createElement("div");
  reveal.className = "run-reveal";
  reveal.append(body);
  root.append(summary, reveal);
  messagesEl.appendChild(root);
  const start = runStartAt || eventTime();
  timeEl.textContent = recordedDuration(start, eventTime()) ?? "";

  // 唯一状态行的耗时读数 100ms 刷新
  const timer = window.setInterval(() => {
    timeEl.textContent = recordedDuration(start, Date.now()) ?? "";
  }, 100);

  currentRun = {
    root,
    body,
    iconBox,
    chainEl,
    timeEl,
    chain: new StepChain(),
    start,
    titleEl: title,
    orb,
    timer,
    lastToolShort: null,
    chipGroup: null,
    workers: new Map(),
    orbActivity: new RunOrbActivity(),
    orbMark,
    collaboration: new CollaborationProgress(),
    collaborationEl,
    changedPage: false,
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
  const reveal = document.createElement("div");
  reveal.className = "run-reveal";
  reveal.append(body);
  root.append(summary, reveal);
  run.body.appendChild(root);

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

/** teamView 属于哪一次 run。旧 run 的 team 不能盖住新 run 的运行状态（见 shared/team-run.ts）。 */
let teamRunId: string | null = null;

function setTeamView(next: TeamView | null): void {
  applyTeamRun(next === null ? emptyTeamRun() : { team: next, runId: teamRunId });
}

function applyTeamRun(next: TeamRunState): void {
  if (next.team === teamView && next.runId === teamRunId) return;
  teamView = next.team;
  teamRunId = next.runId;
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, sessionRun.get(LEAD_SESSION_ID) ?? (next.team ? "user" : "idle"));
}

/** agent_start 携带 runId：换 run 清旧 team，同 run（交还触发）保留。 */
function noteRunStarted(runId: string | null | undefined): void {
  if (!isRunId(runId)) return;
  applyTeamRun(observeRunStarted({ team: teamView, runId: teamRunId }, runId));
}

function applyTeamStatus(team: TeamView, runId: string | null | undefined): void {
  const decision = acceptTeamStatus({ team: teamView, runId: teamRunId }, team, runId, applyingHistory);

  if (decision.accept) applyTeamRun(decision.state);
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

function renderTaskStrip(): void {
  // 目标/活动/材料/控制层由任务条（task-bar.ts）接管；这里只保留结果卡。
  // 当已有消息流内的接续卡或结果已通过正文呈现时，隐藏顶部结果卡，防止信息五重重复。
  const card = resultCardCopy(resultByConversation.get(selectedConversationId) ?? { summary: null });
  const cardEl = document.getElementById("task-result-card");
  const primaryEl = document.getElementById("task-result-primary");
  const secondaryEl = document.getElementById("task-result-secondary");
  const resumeRoot = document.getElementById("resume-entry-root");
  const hasResume = !!resumeRoot && !resumeRoot.hidden && resumeRoot.hasChildNodes();

  if (cardEl && primaryEl && secondaryEl) {
    const result = resultByConversation.get(selectedConversationId);
    const plainReply = !!result?.summary && !result.unknown && !result.remaining?.length && !result.speechFailed;
    cardEl.hidden = !card.visible || plainReply || hasResume;
    primaryEl.textContent = card.primary;
    secondaryEl.textContent = card.secondary;
    secondaryEl.hidden = !card.secondary;
  }

  const strip = document.getElementById("task-strip")!;
  strip.hidden = !Array.from(strip.children).some((child) => !(child as HTMLElement).hidden);
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

  renderTaskStrip();
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
    // 页面归用户：停掉"在跑"的读数与光球，状态行只留结果
    clearInterval(currentRun.timer);
  }

  if (currentRun) {
    if (teamView?.phase === "aborted") currentRun.orbActivity.stop();
    syncRunOrb(currentRun);
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

const RUN_ORB_MARKS = {
  user: { icon: Hand, label: "等待你操作" },
  completed: { icon: Check, label: "已完成" },
  failed: { icon: CircleAlert, label: "执行失败" },
  stopped: { icon: Square, label: "已停止" },
} as const;

function syncRunOrb(run: RunHost): void {
  const state = run.orbActivity.state(lastUserHasPage);
  const mark = state in RUN_ORB_MARKS ? RUN_ORB_MARKS[state as keyof typeof RUN_ORB_MARKS] : null;
  run.orbMark.hidden = !mark;

  if (mark && run.orbMark.dataset.state !== state) {
    run.orbMark.dataset.state = state;
    run.orbMark.setAttribute("aria-label", mark.label);
    run.orbMark.title = mark.label;
    const graphic = icon(mark.icon);
    graphic.setAttribute("aria-hidden", "true");
    run.orbMark.replaceChildren(graphic);
  }

  if (mark && state !== "completed") run.titleEl.textContent = mark.label;
  run.orb.setState(state);
  run.orb.setRunning(!applyingHistory && orbStateRuns(state));
}

function finishRun(): void {
  const run = currentRun;
  currentRun = null;
  runStartAt = 0;

  if (!run) return;
  lastRun = run;
  // 耗时读数 interval 立即停掉：run 完成/中断/空 run 都不留泄漏
  clearInterval(run.timer);
  // 空 run（纯文本回复，无思考/工具步骤）不留壳；只读回合（问答、读页）正常结束也不留过程行，
  // 用户看回答和页面本身即可。动过页面、失败或被停止时才保留「查看执行过程」。
  const hasSteps = Array.from(run.body.children).some(child => !(child as HTMLElement).hidden);
  run.orbActivity.finish();
  const outcome = run.orbActivity.state();
  const keepProcess = run.changedPage || outcome === "failed" || outcome === "stopped";

  if (!hasSteps || !keepProcess) {
    run.root.remove();

    if (lastRun === run) lastRun = null;

    if (!applyingHistory) companion.onRunFinish();

    return;
  }

  run.collaboration.finish();
  renderCollaboration(run.collaborationEl, run.collaboration);
  run.root.classList.add("done");
  run.orbActivity.finish();
  syncRunOrb(run);
  const title = run.root.querySelector(".run-title");

  if (title) {
    const outcome = run.orbActivity.state();
    title.textContent = finishedRunTitle(run.body.querySelectorAll(".chip").length, outcome === "failed" || outcome === "stopped" ? outcome : "completed");
  }

  run.timeEl.textContent = spokenDuration(run.start, eventTime()) ?? "";
  run.root.open = false;
  placeProcessBeforeAnswer(run.root);

  if (!applyingHistory) companion.onRunFinish();
  scrollToEnd();
}

/**
 * 过程行放在这一轮用户消息（和「收到」这类确认语）之后、回答之前：先看到做了什么，再看结论。
 * 回答可能在过程块创建前就已开始渲染，所以结束时按位置规则摆放，而不是依赖事件先后。
 */
function placeProcessBeforeAnswer(root: HTMLElement): void {
  let anchor: Element | null = root.previousElementSibling;

  while (anchor && !anchor.classList.contains("user")) anchor = anchor.previousElementSibling;

  if (!anchor) return;
  let next = anchor.nextElementSibling;

  while (next instanceof HTMLElement && next !== root && next.dataset.deliveryKind === "ack") next = next.nextElementSibling;

  if (next && next !== root) messagesEl.insertBefore(root, next);
}

/** 步骤容器：run 进行中进聚合块，否则直接进消息流。 */
function stepsContainer(): HTMLElement {
  return currentRun?.body ?? messagesEl;
}

function closeBlocks(): void {
  if (currentAssistant) {
    const answer = currentAssistant;
    // 最终稿放完后再挂复制按钮：放字期间每帧重渲染正文，先挂的按钮会被冲掉。
    revealText(answer, currentAssistantText, { render: renderMarkdown, live: !applyingHistory, final: true, onProgress: scrollToEnd, after: () => attachAnswerActions(answer) });
  }

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
      // B：收束——这一行落定一次（200ms 归位），不反向播放
      label.classList.add("settle-once");
      window.setTimeout(() => label.classList.remove("settle-once"), 400);
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
    run.body.appendChild(details);
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
    revealText(currentAssistant, currentAssistantText, { render: renderMarkdown, live: !applyingHistory, final: false, onProgress: scrollToEnd });
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

      // 新思考块隔开前后工具调用：另起 chip 分组
      if (currentRun) currentRun.chipGroup = null;
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
    entry.chip.setAttribute("aria-expanded", "false");
    group.detail.hidden = true;

    return;
  }

  group.expanded?.chip.classList.remove("active");
  group.expanded?.chip.setAttribute("aria-expanded", "false");
  group.expanded = entry;
  entry.chip.classList.add("active");
  entry.chip.setAttribute("aria-expanded", "true");
  renderChipDetail(entry);
  group.detail.hidden = false;
  scrollToEnd();
}

const BOOKKEEPING_TOOLS = new Set(["send_user_message", "task_goals"]);

/** 用户能在页面上看到后果的动作；滚动、悬停、事件监听只是为了读页。 */
const PAGE_VIEWING_TOOLS = new Set(["scroll", "wheel", "hover", "arm_event", "wait_event", "disarm_event"]);

function changesPage(name: string): boolean {
  return isWriteTool(name) && !PAGE_VIEWING_TOOLS.has(name);
}

function onToolStart(
  ev: { toolCallId: string; name: string; params: Record<string, unknown> },
  sessionId?: string,
): void {
  const action = describeTool(ev.name, ev.params);

  if (ev.name === "await_message") {
    action.full = (currentRun ?? lastRun)?.collaboration.waitingFor(ev.params.from) ?? action.full;
  }

  if (ev.name === "post" && ev.params.to === "main" && ev.params.kind === "done") {
    const output = sessionId ? (currentRun ?? lastRun)?.collaboration.members.get(sessionId)?.output : null;
    action.full = `交回${output ?? "结果"}给主助手`;
  }

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

    // 交付回答、核对目标清单是助手的内部记账，不算用户看得懂的一步。
    if (BOOKKEEPING_TOOLS.has(ev.name)) {
      run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
      syncRunOrb(run);

      return;
    }

    addChainStep(action.short);
    run.lastToolShort = action.short;

    if (!run.chipGroup) run.chipGroup = buildChipGroup(run.body);
    group = run.chipGroup;
  }

  run.orbActivity.observe({ kind: "tool_start", ...ev }, sessionId ?? "main");
  syncRunOrb(run);

  if (changesPage(ev.name)) run.changedPage = true;

  if (live && orbStateRuns(run.orbActivity.state(lastUserHasPage))) run.titleEl.textContent = `正在${action.full}`;

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip";
  chip.setAttribute("aria-expanded", "false");

  // A：正在跑的那个 chip 才有蓝边和底色；历史回放不进入运行态
  if (!applyingHistory) chip.classList.add("running");
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

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string; declined?: true }): void {
  const run = currentRun ?? lastRun;

  if (run) {
    run.orbActivity.observe({ kind: "tool_end", name: "", ...ev });
    syncRunOrb(run);
  }

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
  // 用户拒绝授权的那一步照你的意思没做：不画成失败。
  const failed = ev.isError && !ev.declined;
  entry.dot.className = `chip-dot ${chipState(true, failed)}`;
  // B：收束——蓝边底色按 --m-move 退回常态
  entry.chip.classList.remove("running");
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

  if (failed) entry.chip.classList.add("error");

  const label = entry.chip.querySelector(".chip-label");

  if (ev.declined && label) label.textContent = `${label.textContent}（你没有允许）`;
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
  const { lane, run } = found;

  if (ev.kind === "error" || ev.kind === "agent_end" || ev.kind === "run_stopped") { run.orbActivity.observe(ev, sessionId); syncRunOrb(run); }

  if (run.collaboration.apply(sessionId, ev)) renderCollaboration(run.collaborationEl, run.collaboration);

  switch (ev.kind) {
    case "worker_task": {
      const chip = ev.spawnToolCallId ? toolChips.get(ev.spawnToolCallId)?.chip : null;
      const label = chip?.querySelector(".chip-label");

      if (label) label.textContent = `请了 ${displayNameFor(sessionId)} · ${ev.task}`;
      break;
    }

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

function handleAgentEvent(ev: AgentUiEvent, sessionId?: string, runId?: string | null): void {
  if (sessionId && !isLeadSession(sessionId)) {
    handleWorkerEvent(sessionId, ev);

    return;
  }

  const progressRun = currentRun ?? lastRun;

  if (progressRun && (ev.kind === "error" || ev.kind === "agent_end" || ev.kind === "run_stopped")) { progressRun.orbActivity.observe(ev); syncRunOrb(progressRun); }

  if (progressRun && progressRun.collaboration.apply("main", ev)) {
    renderCollaboration(progressRun.collaborationEl, progressRun.collaboration);
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
      if (!runId || runId === conversations.get(selectedConversationId)?.runId) noteRunStarted(runId);
      leadDeliveryMode = (ev as { deliveryMode?: "explicit" }).deliveryMode ?? null;
      resultByConversation.delete(selectedConversationId);
      renderTaskStrip();
      closeBlocks();
      break;
    case "turn_end":
      closeBlocks();
      break;
    case "agent_end":
      closeBlocks();
      leadDeliveryMode = null;
      artifactCards.settleAfterTurn();
      break;
    case "user_delivery":
      handleUserDelivery(ev.delivery);
      break;
    case "artifact":
      artifactCards.apply(ev);
      break;
    case 'user_delivery_stream': {
      const s=ev.stream;
      const bubble=deliveredBubbles.get(s.id);
      const state=bubble?{official:bubble.dataset.streaming===undefined,streaming:bubble.dataset.streaming==='true',cancelled:bubble.dataset.streaming==='cancelled'}:undefined;
      const plan=deliveryPresentation({kind:'stream',phase:s.phase},state);

      if(plan==='ignore'||plan==='status')break;

      if(plan==='mark_cancelled'){bubble!.dataset.streaming='cancelled';bubble!.title='这次回答未完成';break;}

      const target=bubble??addMsg('msg assistant markdown','');

      if(!bubble){target.dataset.deliveryId=s.id;target.dataset.deliveryKind=s.kind;deliveredBubbles.set(s.id,target);}

      target.dataset.streaming='true';
      revealText(target, s.text, { render: renderMarkdown, live: !applyingHistory, final: false, onProgress: scrollToEnd });placeStartAcknowledgement(target, s.kind);scrollToEnd();break;
    }

    case "turn_start":
      break;
    case "notice":
      if (ev.progress) {
        // 进度说明只属于正在跑的这一轮：放进过程行标题，不在对话里留下一句过时的话。
        // 不为它新建过程行：压缩可能发生在回合结束后，新建的行不会再收尾。
        if (currentRun && !applyingHistory) currentRun.titleEl.textContent = ev.message;
      } else if(ev.plan){
        const key=`plan:${ev.plan.conversationId}:${ev.plan.id}`;
        const text=`语音计划 · 共${ev.plan.steps.length}步\n`+ev.plan.steps.map((s,i)=>`${i+1}. ${s.targetTitle??'目标会话'} · ${s.receipt?.message??(s.status==='pending'?'结果待确认':'未执行')}\n${s.text}`).join('\n');
        const previous=receiptMessages.get(key);

if(previous)previous.textContent=text;else receiptMessages.set(key,addMsg('msg notice',text));
      }else if (ev.receipt) {
        // 任务条材料只认这张回执：accepted/applied 才把这次发出的材料升级为「已随任务送入」。
        taskBar.noteReceipt(ev.receipt);

        if (ev.receipt.conversationId === selectedConversationId) {
          if (ev.receipt.action === "abort") {
            if (ev.receipt.status === "accepted" || ev.receipt.status === "applied") taskBar.noteStopAccepted();
            else if (ev.receipt.status === "rejected" || ev.receipt.status === "failed") taskBar.noteControlResult("stop", false, ev.receipt.message);
          }
        }

        resumeEntry.noteReceipt(ev.receipt);
        const key=`${ev.receipt.conversationId}:${ev.receipt.requestId}`;
        const previous = receiptMessages.get(key);

        // 普通接收/送达回执不进消息流：用户已看到自己的消息，任务条讲运行状态；只有拒绝、失败、需要决定的回执才展示。
        if (receiptCopy(ev.receipt, selectedConversationId).collapsed) {
          previous?.remove();
          receiptMessages.delete(key);
          break;
        }

        const restoreFocus = previous?.contains(document.activeElement);
        const receipt = renderReceipt(ev.receipt, selectedConversationId, previous, forkReceipt);

        if (previous) previous.replaceWith(receipt);
        else messagesEl.append(receipt);
        receiptMessages.set(key, receipt);

        if (restoreFocus) receipt.querySelector<HTMLElement>('summary,button')?.focus({preventScroll:true});
        scrollToEnd();
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

function placeStartAcknowledgement(bubble: HTMLElement, kind: string): void {
  if (kind === "ack" && currentRun) messagesEl.insertBefore(bubble, currentRun.root);
}

function handleUserDelivery(delivery: UserDelivery): void {
  if (!delivery || typeof delivery.id !== "string" || !delivery.id) return;
  // 任务身份：交付只落在自己的会话；跨会话送达不渲染、不入结果卡。
  const cid = delivery.conversationId;

  if (!cid || cid !== selectedConversationId) return;
  const receivedAt = performance.now();
  const currentRunId = conversations.get(cid)?.runId ?? null;
  // 晚到的旧 run 交付只能归档到自己的历史位置，不能改写当前结果卡。
  const staleForStrip = delivery.kind !== "ack" && currentRunId !== null && delivery.runId !== null && delivery.runId !== currentRunId;

  if ((delivery.kind === "finding" || delivery.kind === "reply") && !staleForStrip) {
    const previous = resultByConversation.get(cid);
    const facts = delivery.facts;
    resultByConversation.set(cid, {
      summary: delivery.text.trim().slice(0, 160),
      // 未完成项只来自事实链；旧记录缺字段时保持原值，不从叙述猜。
      remaining: facts ? facts.remaining.map((item) => item.description) : previous?.remaining ?? [],
      unknown: facts ? facts.remaining.some((item) => item.status === "unknown") : previous?.unknown ?? false,
      speechFailed: previous?.speechFailed ?? false,
    });
    renderTaskStrip();
  }

  const existing = deliveredBubbles.get(delivery.id);

  const existingState = existing
    ? { official: existing.dataset.streaming === undefined, streaming: existing.dataset.streaming === 'true', cancelled: existing.dataset.streaming === 'cancelled' }
    : undefined;

  const plan = deliveryPresentation({ kind: 'delivery' }, existingState);

  if (plan === 'status') {
    const oldStatus = existing!.dataset.deliveryStatus ?? "";
    const oldRank = DELIVERY_STATUS_RANK[oldStatus] ?? -1;
    const newRank = DELIVERY_STATUS_RANK[delivery.status] ?? -1;

    if (newRank > oldRank) existing!.dataset.deliveryStatus = delivery.status;

    return;
  }

  if (plan === 'update_text') {
    const answer = existing!;
    delete answer.dataset.streaming;
    revealText(answer, delivery.text, { render: renderMarkdown, live: !applyingHistory, final: true, onProgress: scrollToEnd,
      after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') attachAnswerActions(answer); } });
    existing!.dataset.deliveryKind = delivery.kind;
    placeStartAcknowledgement(existing!, delivery.kind);
    existing!.dataset.deliveryStatus = delivery.status;
    voiceUI.deliver?.(delivery);
    scrollToEnd();
    scheduleDeliveryVisible(existing!, receivedAt);

    return;
  }

  voiceUI.deliver?.(delivery);

  const bubble = addMsg("msg assistant markdown", "");
  // 整段一次送达的回答也按同样节奏放出来，不一下子整块冒出。
  revealText(bubble, delivery.text, { render: renderMarkdown, live: !applyingHistory, final: true, onProgress: scrollToEnd,
    after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') attachAnswerActions(bubble); } });
  bubble.dataset.deliveryId = delivery.id;
  bubble.dataset.deliveryKind = delivery.kind;
  bubble.dataset.deliveryStatus = delivery.status;
  deliveredBubbles.set(delivery.id, bubble);
  placeStartAcknowledgement(bubble, delivery.kind);
  scrollToEnd();
  scheduleDeliveryVisible(bubble, receivedAt);
}

/** 收到正式交付 → 结果可见的下一帧；历史回放不算新的呈现。 */
function scheduleDeliveryVisible(bubble: HTMLElement, receivedAt: number): void {
  if (applyingHistory) return;
  requestAnimationFrame(() => {
    const visible = bubble.isConnected && (bubble.textContent ?? "").trim().length > 0;
    deliveryTiming.record(receivedAt, visible);
  });
}

// ── 连接管理（panel ⇆ background Port） ────────────────────────────

function clearDemoView(): void {
  demoState = { recording: false, steps: [], truncated: false };
  renderDemo();
}

function send(msg: ClientMessage): boolean {
  if (!port || !transportConnected) return false;
  const envelope: PanelToBg = { kind: "client", msg: { ...msg, conversationId: msg.conversationId ?? selectedConversationId } };

  if (queuedSends.length || performance.now() - lastPong > PORT_FRESH_MS) {
    queuedSends.push(envelope);
    pingPort();

    return true;
  }

  try {
    port.postMessage(envelope);

    return true;
  } catch {
    return false;
  }
}

// ── T05 接续入口：消费 task_view；「继续原任务」只提交现有 resume 动作 ──
const resumeEntry = new ResumeEntry({
  root: document.getElementById("resume-entry-root")!,
  sendResume: (request) => send({ type: "task_action", request }),
  getContext: async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

      if (!tab?.id) return null;

      return { tabId: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
    } catch {
      return null;
    }
  },
});

/** 面板重开/重连/切会话时补取权威视图；拿不到时保持本地已渲染事实，不编造。 */
function queryTaskView(): void {
  if (!conversationReady || !transportConnected) return;
  send({ type: "task_view_query", requestId: crypto.randomUUID() });
}

// 验收测量入口（只读）：触发一次视图补取 / 读取「收到快照 → 摘要下一帧」的采样。
// 不产生任务、权限或页面动作，供隔离浏览器验收脚本使用。
// 验收钩子只在显式验收模式下暴露（acceptance 脚本打开 sidepanel.html?acceptance=t05）
if (new URLSearchParams(location.search).get("acceptance") === "t05") {
  (globalThis as { __t05QueryView?: () => void }).__t05QueryView = () => queryTaskView();
  (globalThis as { __resumeEntryTiming?: () => unknown }).__resumeEntryTiming = () => resumeEntry.timing();
}

// T06 验收测量入口（只读）：把后台会转发的同一信封喂给真实接收路径，读取「收到交付 → 结果可见」采样。
// 只渲染交付，不发送任何请求、不产生任务或页面动作；验收脚本从这里驱动 50 次事件更新。
if (new URLSearchParams(location.search).get("acceptance") === "t06") {
  (globalThis as { __t06AcceptDelivery?: (message: ServerMessage) => void }).__t06AcceptDelivery =
    (message) => handleBgMessage({ kind: "server", conversationId: message.conversationId, msg: message });
  (globalThis as { __t06DeliveryTiming?: () => unknown }).__t06DeliveryTiming = () => deliveryTiming.summary();
}

function handleMemoryResult(msg: Extract<ServerMessage, { type: "memory_result" }>): void {
  const outcome = memoryState.receive(msg.conversationId, msg);
  processMemoryOutcome(outcome);
}

const inputContext = (): VoiceInputContext => {
  const context: VoiceInputContext = { attachments: attachments?.getAttachments() ?? [] };

  if (pendingAsk) {
    context.context = { tabId: pendingAsk.tabId, title: pendingAsk.title, url: pendingAsk.url, selection: { text: pendingAsk.text } };
  }

  return context;
};

const voiceUI = mountVoiceUI(composerEl, () => selectedConversationId, send, inputContext);

void chrome.storage.local.get(STEP_VOICE_STORAGE_KEY).then((stored) => {
  const voice = stored[STEP_VOICE_STORAGE_KEY];
  voiceUI.setVoice(isStepVoice(voice) ? voice : DEFAULT_STEP_VOICE);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(STEP_VOICE_STORAGE_KEY in changes)) return;
  const voice = changes[STEP_VOICE_STORAGE_KEY].newValue;
  voiceUI.setVoice(isStepVoice(voice) ? voice : DEFAULT_STEP_VOICE);
});

void chrome.storage.local.get(VOICE_PERSONA_STORAGE_KEY).then((stored) => voiceUI.setPersona(parseVoicePersona(stored[VOICE_PERSONA_STORAGE_KEY])));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && VOICE_PERSONA_STORAGE_KEY in changes) voiceUI.setPersona(parseVoicePersona(changes[VOICE_PERSONA_STORAGE_KEY].newValue));
});

const diagnosticRecord = composerEl.querySelector<HTMLElement>('.voice-record');

if (diagnosticRecord) diagnosticRecord.hidden = true;

document.querySelector('#composer-menu')?.addEventListener('beforetoggle', (event) => {
  if ((event as ToggleEvent).newState !== 'open') return;
  const button = document.querySelector('#composer-more')!.getBoundingClientRect();
  const menu = document.querySelector<HTMLElement>('#composer-menu')!;
  menu.style.left = `${Math.max(8, button.right - 160)}px`;
  menu.style.top = `${Math.max(8, button.top - 58)}px`;
});

document.querySelector('#voice-diagnostics-open')?.addEventListener('click', () => {
  document.querySelector<HTMLElement>('#composer-menu')?.hidePopover();

  if (!diagnosticRecord) return;
  diagnosticRecord.hidden = !diagnosticRecord.hidden;
  const details = diagnosticRecord.querySelector<HTMLDetailsElement>('details');

  if (details) details.open = !diagnosticRecord.hidden;
});

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);

  if (!msg) return;

  if (consentPanel.receive(msg)) return;

  if (msg.type === "voice") { voiceUI.receive(msg);

 return; }

  if (msg.type === "memory_result") {
    handleMemoryResult(msg);

    return;
  }

  if (msg.type === "skill_result") {
    if (msg.conversationId && msg.conversationId !== selectedConversationId) return;

    if (msg.action === "list" && msg.ok) {
      if (msg.requestId !== skillRequest) return;
      skillEntries = (msg.skills ?? []).map(skill => ({ skill, runs: msg.runs?.[skill.id] ?? [] }));
      learnedCandidates = msg.candidates ?? [];
      renderSkills();

      return;
    }

    if (msg.action === "candidate_save" || msg.action === "candidate_dismiss") {
      if (msg.requestId !== skillRequest) return;
      addMsg(msg.ok ? "msg" : "msg error", !msg.ok ? `没有保存更改：${msg.error}` : msg.action === "candidate_save" ? "做法已保存，下次同类任务会先检查能否直接复用。" : "这份做法不会保存，也不会自动执行。");
      void refreshSkills();

 return;
    }

    if (msg.action === "run" && msg.requestId === skillRequest) {
      if (!msg.ok || !msg.run) { addMsg("msg error", `这次没跑成：${msg.error ?? "未知原因"}`); void refreshSkills();

 return; }

      const outcome = msg.run;
      addMsg(outcome.ok ? "msg" : "msg error", outcome.ok
        ? `照上次那样跑完了：${outcome.steps} 步 · ${Math.max(0.1, outcome.elapsedMs / 1000).toFixed(1)} 秒。`
          + (outcome.skipped?.length ? `第 ${outcome.skipped.join("、")} 步没认出来，已跳过。` : "")
        : `跑到第 ${outcome.failedStep ?? "?"} 步停下了：${outcome.error ?? ""}`);
      void refreshSkills(); // 刷新事实行：跑过几次、上次结果

      return;
    }

    if ((msg.action === "note" || msg.action === "rollback") && msg.requestId === skillRequest) {
      if (!msg.ok) { addMsg("msg error", `没做成：${msg.error ?? "未知原因"}`);

 return; }

      addMsg("msg", msg.action === "note"
        ? `已确认记下：下次重新示范「${msg.skill?.name ?? "这份技能"}」时会提醒你。`
        : `已回到上一版：${msg.skill?.name ?? ""}（现在是第 ${msg.skill?.version ?? "?"} 版）`);
      void refreshSkills();

      return;
    }

    if (msg.action === "forget" && msg.ok) { void refreshSkills();

 return; }

    demoCompile.disabled = false;
    demoCompile.textContent = "编译成脚本";

    if (msg.ok && msg.skill) { renderSkillResult(msg.skill); redoSkillId = null; redoSkillVersion = null; }
    else if (msg.requestId === skillRequestId) addMsg("msg error", `编译没成：${msg.error ?? "未知原因"}`);

    return;
  }

  if (msg.type === "conversation_created" || msg.type === "conversation_updated") {
    upsertConversation(msg.conversation);

    if (msg.type === 'conversation_created' && msg.requestId) {
      const pending = receiptForks.get(msg.requestId);

      if (pending) {
        clearTimeout(pending.timer); receiptForks.delete(msg.requestId);
        const {request} = pending;
        const moved: TaskActionRequest = {requestId:crypto.randomUUID(),conversationId:msg.conversation.id,source:'text',action:'start',expectedRunId:null,forkedFrom:{conversationId:request.conversationId,requestId:request.requestId},text:request.text,context:request.context,attachments:request.attachments};

        if (send({type:'task_action',conversationId:msg.conversation.id,request:moved})) { pending.resolve(); selectConversation(msg.conversation.id); }
        else pending.reject(new Error('新会话已创建，但原请求尚未发出；连接恢复后可重试。'));
      }
    }

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

  if (msg.conversationId && msg.conversationId !== selectedConversationId) {
    // 模型目录是全局事实（一次枚举、全部会话通用）：别会话捎来的 model_info 只放行目录，
    // 模型本身仍按会话归属丢弃，不把别会话的当前模型安到本会话头上。
    // live 复现：225 条 models=163 的 model_info 被整条过滤，芯片停在空目录。
    if (msg.type === "model_info" && Array.isArray(msg.models) && msg.models.length > 0) modelPicker.update(undefined, msg.models);

    return;
  }

  switch (msg.type) {
    case "hello_ok":
      setStatus("on", "已连接");
      applyHostFeatures(msg.features);
      modelPicker.apply(msg.model, msg.models);
      setupEl.hidden = true;
      break;
    case "model_info":
      modelPicker.update(msg.model, msg.models);
      break;
    case "hello_error":
      showSetup(msg.error);
      break;
    case "status":
      setSessionState(msg.sessionId ?? LEAD_SESSION_ID, msg.state);
      break;
    case "task_view":
      // T05 接续入口：投影摘要 + 恢复按钮；checkpoint 损坏由会话摘要明确指出。
      resumeEntry.apply(msg.view, { checkpointUnavailable: conversations.get(selectedConversationId)?.checkpoint === "unavailable" });
      renderTaskStrip();

      // T03 任务条：只信视图自己的任务身份，跨会话/旧 run 的视图不改当下这一条。
      if (msg.view.conversationId === selectedConversationId) taskBar.updateView(msg.view);
      break;
    case "team_status":
      noteRunStarted(conversations.get(selectedConversationId)?.runId);
      applyTeamStatus(msg.team, msg.runId);
      break;
    case "agent_event":
      handleAgentEvent(msg.event, msg.sessionId, msg.runId);
      break;
    default:
      break;
  }
}

function handleBgMessage(envelope: BgToPanel): void {
  if (envelope.kind === "pong") {
    lastPong = performance.now();
    pingSentAt = null;
    reconnectAttempt = 0;
    flushQueuedSends();

    return;
  }

  if (envelope.kind === "conversations") {
    if (envelope.resumeReading) finishBootSession();

    for (const c of envelope.conversations) upsertConversation(c);

    if (bootFreshSession) resolveBootSession(envelope.selectedConversationId, envelope.conversations.length > 0);
    else if (envelope.selectedConversationId !== selectedConversationId || !conversationReady) {
      selectConversation(envelope.selectedConversationId, false);
    }

    renderConversations();

    return;
  }

  if (envelope.kind === "server") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId
      && !envelope.msg.type.startsWith("conversation_") && !envelope.msg.type.startsWith("consent_") && envelope.msg.type !== "memory_result"
      // 模型目录是全局事实（一次枚举、全部会话通用）：别会话捎来的 model_info 放行进内层，
      // 由内层只收目录、不收模型。live 复现：225 条 models=163 在这里被整条丢弃。
      && envelope.msg.type !== "model_info") return;
    handleServerMessage(JSON.stringify(envelope.msg));

    return;
  }

  if (envelope.kind === "history") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;

    if (bootFreshSession) {
      // 打开进入尚未定会话时仍要让这一次的正式交付出现，不能等历史回放。
      for (const entry of envelope.entries) {
        const item = entry.item;

        if (item.kind === "server" && item.msg.type === "agent_event" && (item.msg.event.kind === "user_delivery" || item.msg.event.kind === "user_delivery_stream")) {
          handleAgentEvent(item.msg.event, item.msg.sessionId);
        }
      }

      return;
    }

    applyHistory(envelope.entries, envelope.replay === true);

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
  consentPanel.setConnected(transportConnected);
  renderConversations();

  if (envelope.state === "connected") {
    // 换端口期间排队的消息：新端口已连上活的 service worker，补发。
    flushQueuedSends();
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
    voiceUI.reconnected();
    // 面板重开或重连：补取当前只读视图，摘要不靠旧缓存。
    queryTaskView();

    // 清单可能先于连接到达：连上后补一次打开决策，别等兜底时限。
    if (bootFreshSession && bootInheritedId !== null) resolveBootSession(bootInheritedId, conversations.size > 0);
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
    modelPicker.reset();
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

function applyHistory(entries: PanelHistoryEntry[], restoring = false): void {
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

  // 实时增量与历史都走此入口。批次处理完后，只恢复仍在运行的主球；
  // 完成块已由 finishRun 收束，不会在回放时重新转动。
  if (currentRun && !restoring) syncRunOrb(currentRun);
  const replay = !historyPrimed && fresh.length > 1;
  historyPrimed = true;
  updateStarterVisibility();

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
  lastPong = performance.now();
  watchPort();
  p.onMessage.addListener((msg: BgToPanel) => handleBgMessage(msg));
  p.onDisconnect.addListener(() => {
    voiceUI.disconnect();

    if (port === p) port = null;
    scheduleReconnect();
  });
  const sync: Extract<PanelToBg, { kind: "sync" }> = { kind: "sync", afterSeq: lastHistorySeq };

  if (conversationReady) sync.conversationId = selectedConversationId;
  p.postMessage(sync satisfies PanelToBg);
}

function watchPort(): void {
  portWatch ??= setInterval(pingPort, PORT_PING_MS);
}

/** 同一时间只有一个 ping 在路上；超时没回 pong 就换端口。 */
function pingPort(): void {
  if (!port || pingSentAt !== null) return;
  const sentAt = performance.now();
  pingSentAt = sentAt;

  try {
    port.postMessage({ kind: "ping" } satisfies PanelToBg);
  } catch {
    replaceDeadPort();

    return;
  }

  setTimeout(() => {
    if (pingSentAt === sentAt) replaceDeadPort();
  }, PORT_PONG_TIMEOUT_MS);
}

function flushQueuedSends(): void {
  if (!port || !transportConnected) return;

  for (const queued of queuedSends.splice(0)) port.postMessage(queued);
}

/** 主动断开可疑端口并立即重连；对自己调用 disconnect 不会触发本端的 onDisconnect。 */
function replaceDeadPort(): void {
  const dead = port;
  port = null;
  pingSentAt = null;
  transportConnected = false;

  try {
    dead?.disconnect();
  } catch {
    /* 已断开 */
  }

  connect();
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
  modelPicker.reposition();
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

      if (attachmentsReady) syncTaskBarDraft();
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

attachmentsReady = true;

// ── 任务条（T03）：消费 task_view，材料事实来自实际发出的请求与回执 ──
function resolveTabPage(tabId: number): Promise<{ title?: string; url?: string } | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.get) return Promise.resolve(null);

  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(null);

 return; }

        resolve({ title: tab.title, url: tab.url });
      });
    } catch {
      resolve(null);
    }
  });
}

function activeTabId(): Promise<number | null> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) return Promise.resolve(null);

  // 与 background attachPageContext 同口径：先最后聚焦窗口，再兜底任一活动标签页。
  return chrome.tabs.query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => tab ?? chrome.tabs.query({ active: true }).then(([fallback]) => fallback).catch(() => undefined))
    .then((tab) => tab?.id ?? null)
    .catch(() => null);
}

const taskBar = new TaskBar({
  root: document.getElementById("task-bar-root")!,
  resolvePage: resolveTabPage,
  getActiveTabId: activeTabId,
  removeDraftAttachment: (id) => attachments.removeItem(id),
  removeDraftSelection: clearPendingAsk,
  currentConversationId: () => selectedConversationId,
  // 重试走真实控制入口：与接管/停止按钮同一条路径，不新增权限。
  onRetryControl: (action) => {
    if (action === "stop") stopCurrentTask();
    else takeoverBtn.click();
  },
});

window.addEventListener("pagehide", () => taskBar.dispose());

/**
 * 草稿材料：选区引用与附件瓷贴是唯一可移除入口；页面按发送时会附上的那一页如实展示。
 * 任务条只汇总，不自己采集页面内容。
 */
function syncTaskBarDraft(): void {
  const atts = attachments.getAttachments().map((a) => ({ id: a.id, name: a.name }));

  const page = pendingAsk
    ? { tabId: pendingAsk.tabId, title: pendingAsk.title, url: pendingAsk.url }
    : activeTabInfo
      ? { tabId: activeTabInfo.id, title: activeTabInfo.title, url: activeTabInfo.url }
      : null;

  const selection = pendingAsk?.text ?? null;
  const hasText = inputEl.value.trim().length > 0;
  taskBar.setDraft(page || selection || atts.length ? { page, selection, attachments: atts } : null, hasText);
}

syncTaskBarDraft();

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
  syncTaskBarDraft();
}

function clearPendingAsk(): void {
  pendingAsk = null;

  if (askCiteEl) askCiteEl.hidden = true;

  if (askCiteText) askCiteText.textContent = "";
  void chrome.storage?.session?.remove(ASK_STORE);
  saveDraft();
  syncTaskBarDraft();
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
  const conversation = selectedConversationId;

  const request = {
    requestId: crypto.randomUUID(),
    conversationId: selectedConversationId,
    source: 'text' as const,
    action: (running||held ? 'steer' : 'start') as "steer" | "start",
    expectedRunId: conversations.get(selectedConversationId)?.runId ?? null,
    text,
    context,
    attachments: clientAttachments,
  };

  const sent = send(running||held ? { type: "task_action", request } : { type: "task_action", request });

  if (!sent) { noticeSendFailed();

 return; }

  // 本地反馈：快照这次真正送出的材料；回执 accepted 之前只显示「发送中」
  taskBar.noteRequestSent({ requestId: request.requestId, action: request.action, context, attachments: clientAttachments });

  // 没有选区引用时，后台会附当前页面上下文：把这一页也补进材料，界面与实际上行一致。
  if (!context) {
    void (async () => {
      try {
        const id = await activeTabId();

        // 期间切了会话就不再补这条材料（任务条已重置）。
        if (id == null || conversation !== selectedConversationId) return;
        const info = (await resolveTabPage(id)) ?? { title: "", url: "" };
        taskBar.noteRequestPage(request.requestId, { tabId: id, title: info.title ?? "", url: info.url ?? "" });
      } catch { /* 拿不到页面信息就只展示已知材料，不猜 */ }
    })();
  }

  sendFailNotified = false;
  inputEl.value = "";
  clearPendingAsk();
  attachments.clear();
  autoResize();
  saveDraft();
}

function stopCurrentTask(): void {
  if (!send({ type: "abort" })) return;
  taskBar.noteControlRequested("stop");

  if (currentRun) { currentRun.orbActivity.stop(); syncRunOrb(currentRun); }
}

sendBtn.onclick = () => {
  if (sendBtn.classList.contains("stopping")) {
    stopCurrentTask();
  } else {
    sendInput();
  }
};

inputEl.addEventListener("input", () => { autoResize(); saveDraft(); syncTaskBarDraft(); });

window.addEventListener("pagehide", saveDraft);

inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});

takeoverBtn.onclick = () => {
  taskBar.noteControlRequested("takeover");
  port?.postMessage({ kind: "control", action: "takeover", conversationId: selectedConversationId } satisfies PanelToBg);
};

abortBtn.onclick = stopCurrentTask;

armBootDecisionTimeout();

connect();
