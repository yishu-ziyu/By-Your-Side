import { createMarginalia } from "./marginalia.js";
import { installDropzone } from "./dropzone.js";
import { attachSourceCitations, captureCitationContext, type CitationContext } from "./sonar-citations.js";
import { attachAnswerSources } from "./answer-sources.js";
import { RunOrbActivity, orbStateRuns } from "./run-orb.js";
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
import { attachAnswerActions as attachCopyActions, setAnswerTime, siteGlyph } from "./answer-actions.js";
import { revealText } from "./stream-reveal.js";
import { beginStarterProbe, isLatestStarterProbe, noteStarterTab, probePageProfile, starterTab, suggestionsFor, type PageProfile } from "./starter-suggestions.js";
import { configureOpenThreads, receiveOpenThreadsTasks, refreshOpenThreads } from "./open-threads.js";
import { mountOrb } from "./voice-orb.js";
import { renderReceipt } from "./receipt-view.js";
import { receiptCopy } from "./receipt-copy.js";
import type { TaskReceipt, TaskActionRequest } from "../../../shared/task-actions.js";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Hand, Check, CircleAlert, Ellipsis, SquarePen, LoaderCircle, BookOpen, SlidersHorizontal } from "lucide";
import { Camera, SquareDashedMousePointer, ImagePlus } from "lucide";
import { ChevronDown, ChevronRight, ArrowDown, Globe, PenLine, MousePointerClick, List, Brain, Dot, FileText, TextQuote } from "lucide";
import {
  StepChain,
  chipState,
  describeTool,
  actionCardLabel,
  historyEventTime,
  recordedDuration,
  finishedRunTitle,
  spokenDuration,
  loaderSubtitle,
  splitAction,
  isPrepTool,
  actionKind,
  pastAction,
  type ActionKind,
  isLiveViewportPinned,
  liveViewportOverflows,
} from "./steps.js";
import { LEAD_COLOR, displayColor, displayNameFor } from "../../../shared/cast.js";
import { ArtifactCards } from "./artifact-card.js";
import { mountErrorCards, type KeyTestResult } from "./error-card.js";
import { describeModelError } from "../../../shared/user-facing.js";
import { INPROC_CREDENTIAL_PREFIX } from "../inproc/shared.js";
import { mountModelPicker } from "./model-picker.js";
import { mountReadingSettings } from "./reading-settings.js";
import { AttachmentsManager } from "./attachments.js";
import { LEAD_SESSION_ID, isLeadSession, parseServerMessage } from "../../../shared/protocol.js";
import type { AgentRunState, AgentUiEvent, Attachment, ClientMessage, ConversationSummary, ModelOption, ServerMessage, TeamView } from "../../../shared/protocol.js";
import { DEFAULT_STEP_VOICE, isStepVoice, parseVoicePersona, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, type UserDelivery, type VoiceInputContext } from "../../../shared/voice.js";
import { MEMORY_KIND_LABEL, MEMORY_TEXT_MAX, normalizeMemoryHostname, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import { isWriteTool, memberBoundPageLabel, memberStatusLabel, panelLive, shouldFinishRunOnDisconnect, shouldShowTeamCard, teamSummaryLabel } from "../../../shared/control.js";
import { conversationBackgroundLabel, conversationStateLabel, resultCardCopy } from "./selectors.js";
import { TaskBar, stateHeadline } from "./task-bar.js";
import type { TaskView } from "../../../shared/task-view.js";
import { plainStep } from "../../../shared/user-facing.js";
import { ResumeEntry } from "./resume-entry.js";
import { DeliveryPresentationTiming, deliveryPresentation } from "./delivery-facts-view.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelHistoryEntry, type PanelToBg, type UserTurnContext } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";
import { NUDGE_DRAFT_KEY } from "../shared/nudge.js";
import { acceptTeamStatus, emptyTeamRun, isRunId, observeRunStarted, type TeamRunState } from "../shared/team-run.js";
import { MemoryManagementState, memoryKindLabel, memoryScopeLabel, memoryUseLabel, sameMemorySnapshot, type MemoryApplyResult } from "./memory.js";
import { MemoryHistoryOpen } from "./memory-history-open.js";
import { createAskCard, stepAsk, type AskInput, type MemoryAskCard, type MemoryAskEvent } from "./memory-ask.js";
import { createGhostBar } from "./ghost-bar.js";
import { installChromeQuiet } from "./chrome-quiet.js";
import { createSteerRibbon } from "./in-flight-steer.js";
import { mountSlashSkills } from "./slash-skills.js";

const answerSources = new WeakMap<HTMLElement, Promise<CitationContext | null>>();

let currentCitationSource: Promise<CitationContext | null> | null = null;

let replayingHistory = false;

/** 这一轮带给助手的记忆：先攒着，这一轮结束（agent_end）时放进回答首句。 */
let pendingUsedLine: MemoryUsedLine | null = null;

/** 定稿回答 → 它的那一行。正文重渲染会冲掉插进去的节点，再挂复制按钮时放回。 */
const usedLineByAnswer = new WeakMap<HTMLElement, MemoryUsedLine>();

/** 这一轮结束时回答还没定稿（或没有回答）：先独立显示一行，回答定稿后搬进去。 */
let floatingUsedLine: MemoryUsedLine | null = null;

/** 「用了 N 条记忆」里各条按钮发出的请求，各自等自己的结果。 */
const usedLineHandlers = new Map<string, (result: { ok: boolean; entry?: MemoryEntry; entries?: MemoryEntry[]; error?: string }) => void>();

let citationRequestPending = false;

function attachAnswerActions(answer: HTMLElement): void {
  attachCopyActions(answer);
  adoptUsedLine(answer);
  placeTaskCardAfter(answer);
  syncAnswerTime(answer);
  const source = answerSources.get(answer);

  if (source) void source.then(context => attachSourceCitations(answer, context));
}

/** 「还差… 继续原任务」放在本轮回答之后：先看结论，再决定要不要接着做（#58 C）。 */
function placeTaskCardAfter(answer: HTMLElement): void {
  const card = Array.from(messagesEl.querySelectorAll<HTMLElement>(".ai-task-card")).pop();

  if (!card || !(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) return;

  for (let node = card.nextElementSibling; node && node !== answer; node = node.nextElementSibling) {
    if (node.classList.contains("user")) return;
  }

  answer.after(card);
}

/** 这一轮过程行的耗时挪到回答下面那一排（回执只说做了什么）。只读回合不留过程行，也就不写耗时。 */
function syncAnswerTime(answer: HTMLElement): void {
  for (let node = answer.previousElementSibling; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
    if (node.matches("details.run-steps.done")) {
      setAnswerTime(answer, node.querySelector(".run-time")?.textContent ?? "");

      return;
    }
  }
}

/** #49：本轮读过的页面 → 回答出处。新记录用独立的 sources，旧记录退回事实链里的 sources。 */
function attachDeliverySources(answer: HTMLElement, delivery: UserDelivery): void {
  attachAnswerSources(answer, delivery.sources ?? delivery.facts?.sources);
}

const PLACEHOLDER_IDLE = "说说你想完成什么…";

const PLACEHOLDER_RUNNING = "补充或改方向…";

const PLACEHOLDER_USER = "现在归你。可补充要求，Enter 保存；点「交还」后生效";

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
    <button id="conversation-switcher" type="button" aria-haspopup="menu" aria-expanded="false" title="切换会话">新会话</button>
    <div id="status-pill" class="activity-island" title="当前连接与执行状态">
      <span id="status-dot" class="dot island-pulse-dot"></span>
      <span id="status-text">未连接</span>
    </div>
    <button id="conversation-new" type="button" aria-label="新会话" title="新会话">＋</button>
    <button id="memory-open" type="button" title="看、改、删助手记住的事" aria-haspopup="dialog" aria-expanded="false">记忆</button>
    <button id="header-more" type="button" popovertarget="header-menu" aria-label="更多" title="更多"></button>
    <div id="header-menu" popover="auto" aria-label="更多功能">
        <button id="model-btn" type="button" title="切换模型" aria-label="切换当前模型" hidden aria-haspopup="listbox" aria-expanded="false">
          <span id="model-mark" class="model-mark" hidden></span>
          <span>当前模型</span>
          <span id="model-name"></span>
          <span id="model-reasoning-tag" class="reasoning-tag" hidden></span>
        </button>
      <button id="model-settings-open" type="button"><span>模型与语音</span></button>
      <button id="reading-settings-btn" type="button"><span>阅读外观</span></button>
    </div>
  </header>
  <div id="ghost-bar" aria-label="直接操作当前页" hidden></div>
  <button id="conversation-background" type="button" hidden></button>
  <div id="task-strip" aria-label="当前会话与结果">
    <div id="task-result-card" hidden>
      <div id="task-result-primary"></div>
      <div id="task-result-secondary"></div>
    </div>
  </div>
  <div id="conversation-menu" role="menu" hidden></div>
  <button id="memory-shade" type="button" aria-label="关闭记忆" hidden></button>
  <section id="memory-drawer" role="dialog" aria-label="记忆" aria-modal="false" hidden>
    <div class="memory-drawer-head">
      <div>
        <h2 id="memory-title">记忆</h2>
      </div>
      <button id="memory-close" type="button">关闭</button>
    </div>
    <input id="memory-search" type="search" placeholder="搜索记忆和过往任务" aria-label="搜索记忆和过往任务" autocomplete="off">
    <div id="knowledge-body">
      <div id="memory-body"></div>
    </div>
  </section>
  <div id="marginalia-rail" aria-label="伴读导轨" hidden></div>
  <div id="messages-frame">
    <div id="messages">
      <div id="resume-entry-root"></div>
    </div>
    <div class="scroll-fade" data-edge="top" aria-hidden="true"></div>
    <div class="scroll-fade" data-edge="bottom" aria-hidden="true"></div>
  </div>
  <div id="team-card" hidden></div>
  <section id="starter" aria-label="开始方式">
    <canvas id="starter-orb" aria-hidden="true"></canvas>
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
      <div class="action-menu-item pressable" id="menu-action-screenshot">
        <span class="action-menu-item-icon" data-icon="camera"></span>
        <span class="action-menu-item-label">截取当前网页视口</span>
      </div>
      <div class="action-menu-item pressable" id="menu-action-region" title="在网页上拖框截图（⌘/Ctrl+Shift+S，Esc 取消）">
        <span class="action-menu-item-icon" data-icon="region"></span>
        <span class="action-menu-item-label">从屏幕选取</span>
      </div>
      <div class="action-menu-item pressable" id="menu-action-upload">
        <span class="action-menu-item-icon" data-icon="upload"></span>
        <span class="action-menu-item-label">上传本地图片</span>
      </div>
      <hr />
      <p class="composer-menu-label">边注</p>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="off">关闭</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="source">原文摘录</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="ai">AI 解释<span>会调用模型</span></button>
      <hr />
      <button id="voice-diagnostics-open" class="action-menu-radio" type="button">语音诊断</button>
    </div>
    <input type="file" id="file-input" accept="image/*" multiple hidden />
    <select id="marginalia-mode" aria-label="边注模式" hidden><option value="off">关闭</option><option value="source">原文摘录</option><option value="ai">AI解释 · 会调用模型</option></select>
    <div id="task-bar-root"></div>
    <div id="page-pill" class="morphing-page-pill pressable" hidden title="当前活动标签页（点击展开检查面板）">
      <span id="tab-icon-sq" class="tab-icon-sq"></span>
      <span id="tab-title-text" class="tab-title-text">检测标签页…</span>
      <i class="tab-live-dot"></i>
    </div>
    <div id="composer" class="composer-glass-dock">
      <div id="ask-cite" hidden>
        <span id="ask-cite-host"></span>
        <span id="ask-cite-text"></span>
        <button type="button" id="ask-cite-close" aria-label="去掉这段引用" title="去掉这段引用">×</button>
      </div>
      <div id="attachments-strip" class="attachments-strip" hidden></div>
      <textarea id="input" rows="1" placeholder="${PLACEHOLDER_IDLE}"></textarea>
      <div id="composer-bar">
        <button id="attach-btn" class="composer-icon-btn" type="button" title="添加附件或截屏" aria-haspopup="true">+</button>
        <span id="composer-spacer"></span>
        <button id="takeover-btn" type="button" title="接管页面：助手先停手，你来操作；弄完点「交还」" hidden>接管</button>
        <button id="steer-send-btn" type="button" title="发出插话（Enter）" aria-label="发出插话" hidden></button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span>
          <span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
  <div id="model-popover" hidden></div>
`;

/** 宿主没有记忆存储时，不给只会报「存储不可用」的入口。旧宿主不报时按有处理。 */
function applyHostFeatures(features: { memory: boolean } | undefined): void {
  const memory = features?.memory ?? true;
  document.getElementById("memory-open")!.hidden = !memory;
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

const ghostBar = createGhostBar(document.getElementById("ghost-bar")!);

installChromeQuiet({
  input: inputEl,
  messages: messagesEl,
  faded: () => ["#conversation-switcher", "#conversation-new", "#memory-open", "#header-more", "#page-pill", "#attach-btn"].flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector))),
  hoverZone: "#topbar:hover, #composer-bar:hover, #page-pill:hover",
  menuOpen: () => !!document.querySelector("#header-menu:popover-open") || ["conversation-menu", "attach-menu", "memory-drawer"].some(id => document.getElementById(id)?.hidden === false),
});

const steerRibbon = createSteerRibbon(composerEl, inputEl, (text) => sendInput(text));

// #51 「/ 技能」：选中后把正文放进输入框，走正常发送路径（带当前页面上下文）。
const slashSkills = mountSlashSkills({
  composerEl, inputEl,
  run: (text) => { inputEl.value = text; inputEl.dispatchEvent(new Event("input")); sendInput(); },
});

const takeoverBtn = document.getElementById("takeover-btn") as HTMLButtonElement;


const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;

const modelMark = document.getElementById("model-mark") as HTMLElement;

const modelName = document.getElementById("model-name")!;

const modelReasoningTag = document.getElementById("model-reasoning-tag") as HTMLElement;

const modelPopover = document.getElementById("model-popover")!;

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

/** 点「新会话」那一刻输入框里的字；会话建好前多打的字归新会话。 */
let draftAtNewRequest: string | null = null;

/**
 * 面板打开时恢复上次会话；没有可用会话才新建。
 * 用户用＋明确新建，重启与重连不自动丢弃原任务。
 */
let bootFreshSession = true;

let bootInheritedId: string | null = null;

let bootDecisionTimer: ReturnType<typeof setTimeout> | null = null;

let bootCreateTimer: ReturnType<typeof setTimeout> | null = null;

/** 会话清单迟迟不到时的兜底时限；新建请求迟迟没有回执时的回退时限。 */
const BOOT_DECISION_TIMEOUT_MS = 6_000;

const BOOT_CREATE_FALLBACK_MS = 4_000;

const conversations = new Map<string, ConversationSummary>();

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

/**
 * 页角建议卡（#52）点了按钮：后台把建议的话放进 session 存储，这里取走填进输入框，由用户自己发送（YIS-74）。
 * 等当前草稿恢复完再填，免得被恢复覆盖；输入框已有字时接在后面，不吞掉用户的草稿。
 */
let takingNudgeDraft = false;

async function takeNudgeDraft(): Promise<void> {
  if (!starterReady() || takingNudgeDraft) return;
  takingNudgeDraft = true;
  let text = "";

  try {
    // 只有后台 nudge.ts 写这个键，值是建议的那句话。
    text = String((await chrome.storage.session.get(NUDGE_DRAFT_KEY))[NUDGE_DRAFT_KEY] ?? "").trim();
    await chrome.storage.session.remove(NUDGE_DRAFT_KEY);
  } finally { takingNudgeDraft = false; }

  if (!text) return;
  inputEl.value = inputEl.value.trim() ? `${inputEl.value.trimEnd()}\n${text}` : text;
  inputEl.dispatchEvent(new Event("input"));
  inputEl.focus();
  inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "session" && changes[NUDGE_DRAFT_KEY]?.newValue) void takeNudgeDraft();
});

function updateStarterVisibility(): void {
  app.classList.toggle("starter-ready", starterReady());
  void takeNudgeDraft();
  refreshOpenThreads();

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
  conversationSwitcher.replaceChildren(currentTitle);
  conversationSwitcher.title = current?.title || "切换会话";
  conversationNew.disabled = !conversationReady || !transportConnected || conversationRequest !== null;
  conversationNew.replaceChildren(icon(conversationRequest ? LoaderCircle : SquarePen));
  conversationNew.setAttribute("aria-label", conversationRequest ? "正在新建会话" : "新会话");
  conversationNew.setAttribute("aria-busy", String(!!conversationRequest));
  conversationNew.title = conversationRequest ? "正在新建会话" : "新会话";
  const list = [...conversations.values()].sort((a, b) => b.updatedAt - a.updatedAt);

  const updatedTimeFormat = new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });

  const rows = list.map((c) => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(c.id === selectedConversationId));
    button.dataset.conversationId = c.id;
    button.title = c.title || "新会话";
    const info = document.createElement("div");
    info.className = "conversation-menu-info";
    const title = document.createElement("span");
    title.className = "conversation-menu-title";
    title.textContent = c.title || "新会话";
    const updated = document.createElement("small");
    updated.className = "conversation-menu-updated";
    updated.textContent = `更新于 ${updatedTimeFormat.format(c.updatedAt)}`;
    info.append(title, updated);
    const state = document.createElement("small");
    state.textContent = conversationStateLabel(c);
    button.append(info, state);
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
  steerRibbon.reset();
  lastUserHasPage = false;
  lastHistorySeq = 0;
  userBubbles.clear();
  deliveredBubbles.clear();
  receiptMessages.clear();
  pendingUsedLine = null;
  floatingUsedLine = null;
  leadDeliveryMode = null;
  currentLeadDraft = null;
  currentLeadDraftDetails = null;
  leadAnswer = null;
  leadAnswerText = "";
  leadAnswerTurnClosed = false;
  leadToolUsed = false;
  historyPrimed = false;
  currentDraftReady = false;
  currentCitationSource = null;
  citationRequestPending = false;
  updateStarterVisibility();
  const resumeRoot = document.getElementById("resume-entry-root");
  artifactCards.reset();
  messagesEl.replaceChildren();

  if (resumeRoot) messagesEl.appendChild(resumeRoot);
  resumeEntry.clear();
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, "idle");
}

function selectConversation(id: string, notify = true): void {
  const preserveInitialDraft = !conversationReady && (inputEl.value.length > 0 || attachments.getAttachments().length > 0 || pendingAsk !== null);

  if (id !== selectedConversationId) voiceUI.stop();
  completedConversations.delete(id);
  conversationMenu.hidden = true;
  conversationSwitcher.setAttribute("aria-expanded", "false");

  if (id !== selectedConversationId || !conversationReady) {
    // 点「新会话」后、切过去之前打的字跟着用户走：旧会话草稿保持点击时的样子，否则这些字会被清掉。
    const typed = draftAtNewRequest !== null && inputEl.value !== draftAtNewRequest ? inputEl.value : null;

    if (typed !== null) inputEl.value = draftAtNewRequest!;
    draftAtNewRequest = null;

    if (conversationReady) saveDraft();
    selectedConversationId = id;
    conversationReady = true;
    sendBtn.disabled = false;

    if (preserveInitialDraft) saveDraft();
    draftRevision += 1;
    resetConversationRender();
    restoringDraft = true;
    inputEl.value = "";
    syncSteerSend();
    pendingAsk = null;

    if (askCiteEl) askCiteEl.hidden = true;
    attachments.restore([], id);
    restoringDraft = false;
    modelPicker.reset();

    if (typed !== null) { inputEl.value = typed; syncSteerSend(); autoResize(); saveDraft(); currentDraftReady = true; updateStarterVisibility(); }
    else void restoreDraft(id).catch(() => addMsg("msg error", "未能恢复这段会话的输入草稿。"));
  }

  renderConversations();
  renderTaskStrip();
  taskBar.reset();
  queryTaskView();

  if (notify) port?.postMessage({ kind: "select_conversation", conversationId: id } satisfies PanelToBg);
  port?.postMessage({ kind: "sync", conversationId: id, afterSeq: lastHistorySeq } satisfies PanelToBg);
}

/**
 * 打开进入时恢复清单里的上次会话，没有可用会话才新建。
 * 清单没到、后台还没连上都不急着建；等下一次清单/连接事件或兜底时限再定。
 */
function resolveBootSession(inheritedId: string, listKnown: boolean): void {
  if (!bootFreshSession) return;
  bootInheritedId = inheritedId;
  const inherited = conversations.get(inheritedId);

  if (!inherited && !listKnown) return;

  if (inherited) {
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

  if (conversationReady) { saveDraft(); draftAtNewRequest = inputEl.value; }

  conversationRequest = crypto.randomUUID();
  renderConversations();

  if (!send({ type: "conversation_create", requestId: conversationRequest })) {
    conversationRequest = null;
    draftAtNewRequest = null;
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

type MemoryUiRequest = { action: "list" | "update" | "forget" | "restore" | "ask" | "site" | "unforget"; entryId?: string };

const memoryState = new MemoryManagementState();

const memoryUiRequests = new Map<string, MemoryUiRequest>();

let memoryLoaded = false;

let memoryListRequestId: string | null = null;

let memoryListError = "";

let memoryInspection: MemoryInspection | null = null;

let memoryEdit: MemoryEdit | null = null;

let memoryForget: MemoryForget | null = null;

/** 历史里正在撤销替换的那条。 */
let memoryRestore: { id: string; pendingRequestId: string | null; error: string } | null = null;

const memoryHistoryOpen = new MemoryHistoryOpen();

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

  for (const [value, label] of [["all", "所有网站"], ["site", "指定网站"]] as const) {
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

function renderMemoryForgetConfirm(entry: MemoryEntry, state: MemoryForget): HTMLElement {
  const confirm = document.createElement("div");
  confirm.className = "memory-forget-confirm";
  const heading = document.createElement("strong");
  heading.textContent = "忘记这条记忆？";
  const explanation = document.createElement("p");
  explanation.textContent = "以后不再从记忆中使用它。旧聊天和已经生成的回复仍会保留。";
  const error = document.createElement("p");
  error.className = "memory-error";
  error.hidden = !state.error;
  error.textContent = state.error;
  const confirmActions = document.createElement("div");
  confirmActions.className = "memory-actions";
  const cancel = memoryButton("取消", "cancel-forget", entry.id);
  cancel.disabled = state.pendingRequestId !== null;

  const forget = memoryButton(
    state.pendingRequestId ? "正在忘记…" : state.error ? "重试忘记" : "确认忘记",
    "confirm-forget",
    entry.id,
  );

  forget.className = "memory-danger memory-forget-submit";
  forget.disabled = state.pendingRequestId !== null;
  confirmActions.append(cancel, forget);
  confirm.append(heading, explanation, error, confirmActions);

  return confirm;
}

/** inGroup：列在「做事的方法」组里——不重复种类名，补上日期，原话收进「查看来源」。 */
/** 「这里别用」过的网站：每个一行「在 某网站 不用」，旁边可恢复。记忆和过往任务共用。 */
function renderNotHere(hosts: string[] | undefined, restore: (hostname: string) => HTMLButtonElement): HTMLElement | null {
  if (!hosts?.length) return null;
  const notes = document.createElement("div");
  notes.className = "memory-not-here";

  for (const hostname of hosts) {
    const note = document.createElement("span");
    note.className = "memory-not-here-note";
    note.textContent = `在 ${hostname} 不用`;
    notes.append(note, restore(hostname));
  }

  return notes;
}

function renderMemoryEntry(entry: MemoryEntry, inGroup = false): HTMLElement {
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
  const facts = document.createElement("span");
  facts.className = "memory-facts";
  const kind = document.createElement("span");
  kind.className = "memory-kind";
  kind.dataset.kind = entry.kind;
  kind.textContent = memoryKindLabel(entry);
  const scope = document.createElement("span");
  scope.className = "memory-scope";
  scope.textContent = memoryUseLabel(entry);
  const used = document.createElement("span");
  used.className = "memory-used";
  used.textContent = entry.useCount ? `用过 ${entry.useCount} 次` : "还没用过";

  if (inGroup) {
    const date = document.createElement("span");
    date.className = "memory-used";
    date.textContent = formatMemoryTime(entry.createdAt);
    facts.append(scope, date, used);
  } else {
    facts.append(kind, scope, used);
  }

  const actions = document.createElement("div");
  actions.append(
    memoryButton(card.classList.contains("show-source") ? "收起来源" : "查看来源", "source", entry.id),
    memoryButton("修改", "edit", entry.id),
    memoryButton("忘记", "forget", entry.id),
  );
  actions.lastElementChild?.classList.add("memory-danger");
  meta.append(facts, actions);
  card.append(text);

  if (!inGroup && entry.sourceQuote && entry.sourceQuote !== entry.text) {
    const quote = document.createElement("p");
    quote.className = "memory-quote";
    quote.textContent = `你说：「${entry.sourceQuote}」`;
    card.appendChild(quote);
  }

  card.appendChild(meta);

  const notHere = renderNotHere(entry.notOnHosts, (hostname) => {
    const restore = memoryButton("恢复", "site-on", entry.id);
    restore.dataset.memoryHost = hostname;

    return restore;
  });

  if (notHere) card.appendChild(notHere);

  const source = document.createElement("details");
  source.className = "memory-source";
  source.dataset.memorySource = entry.id;
  const summary = document.createElement("summary");
  summary.textContent = "来源";
  const detail = document.createElement("p");
  detail.textContent = `${inGroup && entry.sourceQuote ? `你当时说：「${entry.sourceQuote}」\n` : ""}会话：${memorySourceLabel(entry)}\n保存于 ${formatMemoryTime(entry.createdAt)} · 当前版本 ${entry.version}`;

  if (entry.experience) detail.textContent += `\n来自这次纠正的待验证做法；再次使用仍需检查。\n${entry.experience.evidence.map(line => line.replace(/^feedback-\d+：/, "你的纠正：").replace(/^(?:previous-)?observation-\d+：/, "网页结果：")).join("\n")}`;
  source.append(summary, detail);
  card.appendChild(source);

  if (memoryForget?.id === entry.id) card.appendChild(renderMemoryForgetConfirm(entry, memoryForget));

  return card;
}

function renderMemoryDrawer(): void {
  // <details> 的 toggle 事件是异步的：用户刚点开、事件还没到就重绘，状态会丢。重绘前直接读现有 DOM。
  const shown = memoryBody.querySelector<HTMLDetailsElement>("details.memory-history");

  if (shown) memoryHistoryOpen.recordToggle(shown.open, shown.dataset.forced === "1");

  // 编辑/确认刚关闭，补上之前被推迟的那一次重读。
  if (memoryState.takeDeferredRefresh(memoryEditorBusy())) queueMicrotask(() => { if (!memoryDrawer.hidden) requestMemoryList(); });
  const memories = renderMemoryFacts();
  const tasks = pastTasks.filter(task => memoryMatches(task.goal, task.summary));
  memoryBody.appendChild(renderPastTasks(tasks));

  if (!memoryQuery) return;
  memoryTitle.textContent = `找到 ${memories + tasks.length} 条`;

  if (memories + tasks.length) return;
  const nothing = document.createElement("p");
  nothing.className = "memory-quiet memory-search-empty";
  nothing.textContent = `没有找到和「${memorySearch.value.trim()}」有关的记忆或任务。`;
  memoryBody.appendChild(nothing);
}

// ── 抽屉搜索（#75）：记忆、做法、历史和过往任务一起过滤；组头写匹配条数，没有匹配的组不占位置 ──
let memoryQuery = "";

const memoryMatches = (...texts: Array<string | undefined>) => !memoryQuery || texts.some(text => text?.toLowerCase().includes(memoryQuery));

const memorySearch = document.getElementById("memory-search") as HTMLInputElement;

memorySearch.addEventListener("input", () => {
  memoryQuery = memorySearch.value.trim().toLowerCase();
  renderMemoryDrawer();
});

// ── 过往任务：每个动手做过的任务结束时留的一条摘要，可删单条或全部清空 ──
let pastTasks: TaskHistoryEntry[] = [];

let pastTasksRequestId: string | null = null;

let pastTasksError = "";

let pastTasksConfirmClear = false;

const PAST_TASK_OUTCOME: Record<TaskHistoryEntry["outcome"], string> = { complete: "做完了", partial: "还差一些", stopped: "你停止了", error: "出错" };

function requestPastTasks(forget?: string | null): void {
  pastTasksRequestId = crypto.randomUUID();
  pastTasksError = "";

  const message: ClientMessage = forget === undefined
    ? { type: "task_history_list", requestId: pastTasksRequestId, conversationId: selectedConversationId }
    : { type: "task_history_forget", requestId: pastTasksRequestId, conversationId: selectedConversationId, id: forget };

  if (!send(message)) {
    pastTasksRequestId = null;
    pastTasksError = "连接不可用，请重试";
  }
}

/** 过往任务在某网站恢复使用（撤销「这里别用」）；结果和列表、删除一样回到 pastTasks。 */
function requestPastTaskSite(id: string, hostname: string): void {
  pastTasksRequestId = crypto.randomUUID();
  pastTasksError = "";

  if (!send({ type: "task_history_site", requestId: pastTasksRequestId, conversationId: selectedConversationId, id, hostname, off: false })) {
    pastTasksRequestId = null;
    pastTasksError = "连接不可用，请重试";
  }
}

function renderPastTasks(shown: TaskHistoryEntry[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "past-tasks";
  // 搜索时没有匹配的过往任务：整组不占位置。
  section.hidden = !!memoryQuery && !shown.length;
  const head = document.createElement("div");
  head.className = "past-tasks-head";
  const title = document.createElement("h3");
  title.textContent = shown.length ? `过往任务 · ${shown.length}` : "过往任务";
  head.appendChild(title);

  if (pastTasks.length && !memoryQuery) {
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = pastTasksConfirmClear ? "memory-danger" : "";
    clear.textContent = pastTasksConfirmClear ? "确认全部清空" : "全部清空";
    clear.onclick = () => {
      if (!pastTasksConfirmClear) { pastTasksConfirmClear = true; renderMemoryDrawer();

 return; }

      pastTasksConfirmClear = false;
      requestPastTasks(null);
      renderMemoryDrawer();
    };

    head.appendChild(clear);
  }

  section.appendChild(head);
  const intro = document.createElement("p");
  intro.className = "memory-quiet";
  intro.textContent = "动手做过的任务结束后留一条摘要，之后它能想起做过什么、在哪做的。只存在这台电脑上。";

  if (!memoryQuery) section.appendChild(intro);

  if (pastTasksError) {
    const failure = document.createElement("p");
    failure.className = "memory-error";
    failure.textContent = pastTasksError;
    section.appendChild(failure);
  }

  if (!pastTasks.length) {
    const empty = document.createElement("p");
    empty.className = "memory-quiet past-tasks-empty";
    empty.textContent = pastTasksRequestId ? "正在读取…" : "还没有记录。";
    section.appendChild(empty);

    return section;
  }

  for (const task of shown) {
    const row = document.createElement("article");
    row.className = "memory-row past-task";
    row.dataset.taskId = task.id;
    const goal = document.createElement("p");
    goal.className = "memory-row-text";
    goal.textContent = task.goal;
    const meta = document.createElement("div");
    meta.className = "memory-row-meta";
    const info = document.createElement("span");
    info.className = "memory-facts";
    const kind = document.createElement("span");
    kind.className = "memory-kind";
    kind.dataset.kind = "past";
    kind.textContent = MEMORY_KIND_LABEL.past;
    const detail = document.createElement("span");
    detail.className = "memory-quiet";
    detail.textContent = [formatMemoryTime(task.endedAt), PAST_TASK_OUTCOME[task.outcome], task.page ?? task.hosts[0], task.validity?.end ? memoryUseLabel({ scope: { kind: "all" }, validity: task.validity }) : ""].filter(Boolean).join(" · ");
    const used = document.createElement("span");
    used.className = "memory-used";
    used.textContent = task.useCount ? `用过 ${task.useCount} 次` : "还没用过";
    info.append(kind, detail, used);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "memory-danger";
    remove.textContent = "删除";
    remove.onclick = () => { requestPastTasks(task.id); renderMemoryDrawer(); };

    meta.append(info, remove);
    row.append(goal, meta);

    const notHere = renderNotHere(task.notOnHosts, (hostname) => {
      const restore = document.createElement("button");
      restore.type = "button";
      restore.textContent = "恢复";
      restore.onclick = () => { requestPastTaskSite(task.id, hostname); renderMemoryDrawer(); };

      return restore;
    });

    if (notHere) row.appendChild(notHere);

    if (task.unfinished.length) {
      const open = document.createElement("p");
      open.className = "memory-quiet";
      open.textContent = `还差：${task.unfinished.join("；")}`;
      row.appendChild(open);
    }

    section.appendChild(row);
  }

  return section;
}

function handlePastTasksResult(msg: Extract<ServerMessage, { type: "task_history_result" }>): void {
  if (msg.requestId !== pastTasksRequestId) return;
  pastTasksRequestId = null;

  if (msg.ok) pastTasks = msg.tasks ?? [];
  else pastTasksError = `未能读取过往任务：${msg.error ?? "未知原因"}`;

  if (!memoryDrawer.hidden) renderMemoryDrawer();
}

/** 被替换、失效的旧记忆：留作历史，不再带给助手；被替换的可以撤销替换。 */
function renderMemoryHistory(history: MemoryEntry[]): HTMLElement {
  const section = document.createElement("details");
  section.className = "memory-history";
  const ids = new Set(history.map((entry) => entry.id));
  const forced = (!!memoryForget && ids.has(memoryForget.id)) || (!!memoryRestore && ids.has(memoryRestore.id));
  section.open = memoryHistoryOpen.shouldOpen(forced);

  if (forced) section.dataset.forced = "1";
  section.addEventListener("toggle", () => memoryHistoryOpen.recordToggle(section.open, forced));
  const summary = document.createElement("summary");
  summary.textContent = `历史 · ${history.length}`;
  const intro = document.createElement("p");
  intro.className = "memory-quiet";
  intro.textContent = "换成新值后，旧的留在这里，不再带给助手。";
  section.append(summary, intro);

  for (const entry of history) {
    const row = document.createElement("article");
    row.className = "memory-row memory-history-row";
    row.dataset.memoryId = entry.id;
    row.dataset.status = entry.status;
    const text = document.createElement("p");
    text.className = "memory-row-text";
    text.textContent = entry.text;
    const meta = document.createElement("div");
    meta.className = "memory-row-meta";
    const facts = document.createElement("span");
    facts.className = "memory-facts";
    const status = document.createElement("span");
    status.className = "memory-status";
    const replacer = entry.replacedBy ? memoryState.get(entry.replacedBy) : undefined;
    status.textContent = entry.status === "replaced" ? "已被替换" : "已失效";
    const kind = document.createElement("span");
    kind.className = "memory-kind";
    kind.dataset.kind = entry.kind;
    kind.textContent = memoryKindLabel(entry);
    facts.append(status, kind);

    if (replacer) {
      const by = document.createElement("span");
      by.className = "memory-quiet";
      by.textContent = `换成了「${replacer.text.length > 24 ? `${replacer.text.slice(0, 23)}…` : replacer.text}」`;
      facts.append(by);
    }

    const actions = document.createElement("div");
    const pending = memoryRestore?.id === entry.id && memoryRestore.pendingRequestId !== null;

    if (entry.status === "replaced" || entry.status === "invalid") {
      const restore = memoryButton(pending ? "正在恢复…" : entry.status === "replaced" ? "撤销替换" : "恢复这条", "restore", entry.id);
      restore.disabled = pending;
      actions.append(restore);
    }

    const forget = memoryButton("删除", "forget", entry.id);
    forget.classList.add("memory-danger");
    actions.append(forget);
    meta.append(facts, actions);
    row.append(text, meta);

    if (memoryRestore?.id === entry.id && memoryRestore.error) {
      const error = document.createElement("p");
      error.className = "memory-error";
      error.textContent = memoryRestore.error;
      row.appendChild(error);
    }

    if (memoryForget?.id === entry.id) row.appendChild(renderMemoryForgetConfirm(entry, memoryForget));
    section.appendChild(row);
  }

  return section;
}

/** 做事的方法单独成组：纠正后点「记住」的，和从纠正里总结的待验证做法；每条照常可看来源、修改、忘记。 */
function renderMethodGroup(methods: MemoryEntry[]): HTMLElement {
  const group = document.createElement("section");
  group.className = "memory-group";
  group.dataset.memoryGroup = "method";
  group.hidden = !!memoryQuery && !methods.length;
  const heading = document.createElement("h3");
  heading.textContent = memoryQuery ? `${MEMORY_KIND_LABEL.method} · ${methods.length}` : MEMORY_KIND_LABEL.method;
  group.appendChild(heading);

  if (!methods.length) {
    const empty = document.createElement("p");
    empty.className = "memory-quiet";
    empty.textContent = "你纠正我之后，记下的做法会列在这里。";
    group.appendChild(empty);
  }

  for (const entry of methods) group.appendChild(renderMemoryEntry(entry, true));

  return group;
}

/** 画记忆部分，返回搜索时匹配的条数。 */
function renderMemoryFacts(): number {
  const all = memoryState.getEntries();
  const active = all.filter(entry => entry.status === "active");
  memoryTitle.textContent = active.length ? `记忆 · ${active.length}` : "记忆";
  const shown = all.filter(entry => memoryMatches(entry.text));
  const methods = shown.filter(entry => entry.status === "active" && entry.kind === "method");
  const entries = shown.filter(entry => entry.status === "active" && entry.kind !== "method");
  const history = shown.filter(entry => entry.status !== "active");
  const matched = shown.length;
  memoryBody.replaceChildren();
  const inspection = renderMemoryInspection();

  if (inspection) memoryBody.appendChild(inspection);

  const intro = document.createElement("p");
  intro.className = "memory-quiet memory-intro";
  intro.textContent = "你在对话里说过的邮箱、姓名、偏好和带日期的安排会自动记在这里。关于你的每轮都会用上；带日期的到那天过后不再主动用，仍能查到。可以纠正或忘记。";

  if (!memoryQuery) memoryBody.appendChild(intro);

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

    return 0;
  }

  if (!memoryLoaded && !memoryListRequestId) {
    const unavailable = document.createElement("div");
    unavailable.className = "memory-empty";
    unavailable.append("还不能读取记忆。", memoryButton("重试", "reload"));
    memoryBody.appendChild(unavailable);

    return 0;
  }

  if (entries.length === 0 && history.length === 0) {
    const empty = document.createElement("div");
    empty.className = "memory-empty";
    const heading = document.createElement("strong");
    heading.textContent = "还没有保存的记忆";
    const text = document.createElement("p");
    text.textContent = "你在对话里说过的邮箱、姓名等资料会自动记在这里。";
    empty.append(heading, text);

    if (!methods.length && !memoryQuery) memoryBody.appendChild(empty);
    memoryBody.appendChild(renderMethodGroup(methods));

    return matched;
  }

  const list = document.createElement("div");
  list.className = "memory-list";

  for (const entry of entries) list.appendChild(renderMemoryEntry(entry));
  memoryBody.appendChild(list);
  memoryBody.appendChild(renderMethodGroup(methods));

  if (history.length) memoryBody.appendChild(renderMemoryHistory(history));

  return matched;
}

/** 回执上的「撤销」各自等自己的结果。 */
const receiptUndos = new Map<string, (ok: boolean, error?: string) => void>();

/** 纠正后的询问：状态按 askId 留在面板内存里，切会话重绘时照原样画回；它发出的请求各自等自己的结果。 */
const memoryAskCards = new Map<string, MemoryAskCard>();

const memoryAskHandlers = new Map<string, (result: AskInput) => void>();

function processMemoryOutcome(outcome: MemoryApplyResult): void {
  if (outcome.kind === "ignored") return;
  const undo = receiptUndos.get(outcome.requestId);

  if (undo) {
    receiptUndos.delete(outcome.requestId);
    undo(outcome.kind === "success", outcome.kind === "failure" ? outcome.error : undefined);
  }

  const lineHandler = usedLineHandlers.get(outcome.requestId);

  if (lineHandler) {
    usedLineHandlers.delete(outcome.requestId);
    lineHandler(outcome.kind === "success" ? { ok: true, entry: outcome.entry, entries: outcome.entries } : { ok: false, error: outcome.error });
  }

  const askHandler = memoryAskHandlers.get(outcome.requestId);

  if (askHandler) {
    memoryAskHandlers.delete(outcome.requestId);
    askHandler(outcome.kind === "success"
      ? { kind: "result", ok: true, entry: outcome.entry, entries: outcome.entries, alreadySaved: outcome.alreadySaved }
      : { kind: "result", ok: false, error: outcome.error, askClosed: outcome.askClosed });
  }

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
  } else if (outcome.action === "restore" && uiRequest?.entryId) {
    if (memoryRestore?.id === uiRequest.entryId && memoryRestore.pendingRequestId === outcome.requestId) {
      memoryRestore.pendingRequestId = null;

      if (outcome.kind === "success") memoryRestore = null;
      else memoryRestore.error = `没有撤销：${outcome.error}`;
    }
  } else if (outcome.action === "forget" && uiRequest?.entryId) {
    if (memoryForget?.id === uiRequest.entryId && memoryForget.pendingRequestId === outcome.requestId) {
      memoryForget.pendingRequestId = null;

      if (outcome.kind === "success") memoryForget = null;
      else memoryForget.error = `没有忘记这条记忆：${outcome.error}`;
    }
  }

  if (!memoryDrawer.hidden) renderMemoryDrawer();

  // 忘记/撤销会连带改别的条目（重连历史、删整条历史、两条一起改），本地补丁不够，重新读全表。
  if (outcome.kind === "success" && (outcome.action === "forget" || outcome.action === "restore" || outcome.action === "site" || outcome.action === "unforget" || (outcome.action === "ask" && outcome.entry && !outcome.alreadySaved))) requestMemoryList();
}

function dispatchMemoryRequest(message: Extract<ClientMessage, { type: "memory_list" | "memory_update" | "memory_forget" | "memory_restore" | "memory_ask_answer" | "memory_site" | "memory_unforget" }>, ui: MemoryUiRequest): void {
  memoryUiRequests.set(message.requestId, ui);

  if (send(message)) return;
  processMemoryOutcome(memoryState.rejectLocally(message.requestId, "连接不可用，请重试"));
}

function requestMemoryList(): void {
  requestPastTasks();
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
  memoryHistoryOpen.reset();
  memoryDrawer.hidden = false;
  memoryShade.hidden = false;
  memoryOpen.setAttribute("aria-expanded", "true");
  renderMemoryDrawer();
  requestMemoryList();
  memoryClose.focus();
}

function closeMemoryDrawer(): void {
  memoryDrawer.hidden = true;
  memorySearch.value = "";
  memoryQuery = "";
  memoryShade.hidden = true;
  memoryOpen.setAttribute("aria-expanded", "false");
  memoryEdit = null;
  memoryForget = null;
  memoryInspection = null;
  memoryOpen.focus();
}

memoryOpen.onclick = () => memoryDrawer.hidden ? openMemoryDrawer() : closeMemoryDrawer();

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

  if (action === "restore") {
    const message = memoryState.beginRestore(selectedConversationId, entry);
    memoryRestore = { id, pendingRequestId: message.requestId, error: "" };
    renderMemoryDrawer();
    dispatchMemoryRequest(message, { action: "restore", entryId: id });

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

    return;
  }

  // 撤销「这里别用」：这个网站重新带这条；结果回来后重读全表。
  if (action === "site-on" && target.dataset.memoryHost) {
    target.disabled = true;
    dispatchMemoryRequest(memoryState.beginSite(selectedConversationId, entry, target.dataset.memoryHost, false), { action: "site", entryId: id });
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

const steerSendBtn = document.getElementById("steer-send-btn") as HTMLButtonElement;

steerSendBtn.append(icon(ArrowUp));

steerSendBtn.onclick = () => sendInput();

for (const [key, node] of [["camera", Camera], ["region", SquareDashedMousePointer], ["upload", ImagePlus]] as const) {
  document.querySelector(`#attach-menu [data-icon="${key}"]`)?.replaceChildren(icon(node));
}

/** 运行中：停止键一直在；输入框里有字时，它左边多一个发送键，发出的是插话。 */
function syncSteerSend(): void {
  // 按 id 现取：切会话可能在这段模块代码跑到之前就调用。
  const steer = document.getElementById("steer-send-btn");
  const send = document.getElementById("send-btn");
  const input = document.getElementById("input") as HTMLTextAreaElement | null;

  if (steer && send && input) steer.hidden = !send.classList.contains("stopping") || !input.value.trim();
}

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
      ghostBar.setTab(activeTabInfo);
      marginalia.setPage(activeTabInfo);
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

// ── 模型选择器 ─────────────────────────────────────────────────────
// 模型入口收在顶部更多菜单，选择面板在菜单触发器下方展开。
// 数据源是 agent 下发的 hello_ok.models / model_info；选择后发 set_model，
// 等 agent 回 model_info 再更新显示（收到回执才改变状态）。
const modelPicker = mountModelPicker({
  host: {
    button: modelBtn,
    mark: modelMark,
    name: modelName,
    reasoningTag: modelReasoningTag,
    popover: modelPopover,
    anchor: headerMore,
    app,
  },
  sendSetModel: (model) => {
    send({ type: "set_model", model });
  },
});

// ── 错误卡（#74）：模型出错时按种类给修复动作，修好后从出错处接着做 ──
let knownModels: ModelOption[] = [];

let currentModelId: string | undefined;

/** 错误卡换模型：等宿主回 model_info 确认换好再接着做。 */
let pendingModelSwitch: { id: string; done: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

const keyTests = new Map<string, (result: KeyTestResult) => void>();

function noteModelInfo(model: string | undefined, models: ModelOption[] | undefined): void {
  if (models?.length) knownModels = models;

  if (!model) return;
  currentModelId = model;

  if (pendingModelSwitch?.id === model) { clearTimeout(pendingModelSwitch.timer); pendingModelSwitch.done(); pendingModelSwitch = null; }
}

const errorCards = mountErrorCards({
  messages: messagesEl,
  app,
  models: () => knownModels,
  currentModel: () => currentModelId,
  switchModel: (id) => new Promise((resolve, reject) => {
    if (pendingModelSwitch) clearTimeout(pendingModelSwitch.timer);
    pendingModelSwitch = { id, done: resolve, timer: setTimeout(() => { pendingModelSwitch = null; reject(new Error("切换超时")); }, 10_000) };
    send({ type: "set_model", model: id });
  }),
  retry: (key) => { send(key ? { type: "retry_after_error", key } : { type: "retry_after_error" }); },
  testKey: (key) => new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    keyTests.set(requestId, resolve);
    setTimeout(() => { if (keyTests.delete(requestId)) resolve({ ok: false, reason: "测试没有回音，再试一次。" }); }, 70_000);
    send({ type: "model_key_test", requestId, key });
  }),
  saveKey: (provider, key) => chrome.storage.local.set({ [`${INPROC_CREDENTIAL_PREFIX}${provider}`]: { type: "api_key", key } }),
  scrollToEnd: () => scrollToEnd(true),
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

/** 当前 run 的"执行步骤"聚合块。 */
interface RunHost {
  orbMark: HTMLSpanElement;
  orbActivity: RunOrbActivity;
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
  /** 这一轮动过页面（标注、开标签、填写等）；只读回合结束后不留过程行。 */
  changedPage: boolean;
  /** 标题上次换字的时刻与排队中的下一句：每句至少停 RUN_TITLE_HOLD_MS，免得一闪而过。 */
  titleAt: number;
  titleTimer: number;
  /** 标题前的动作图标：跟着当前动作换，收尾后是那一件事或「多步」。 */
  actIcon: HTMLElement;
}

const ACTION_ICONS = { open: Globe, fill: PenLine, click: MousePointerClick, other: Dot, read: FileText, many: List, think: Brain } as const;

type IconKind = ActionKind | "read" | "many" | "think";

function setActionIcon(box: HTMLElement, kind: IconKind): void {
  if (box.dataset.kind === kind) return;
  box.dataset.kind = kind;
  const graphic = icon(ACTION_ICONS[kind]);
  graphic.setAttribute("aria-hidden", "true");
  box.replaceChildren(graphic);
}

const RUN_TITLE_HOLD_MS = 1100;

/** 过程灰字：动词墨色、对象浅灰，无图标（#58 C）。 */
function paintAction(el: HTMLElement, text: string): void {
  const { verb, object } = splitAction(text);
  const v = document.createElement("span");
  v.className = "act-verb";
  v.textContent = verb;

  if (!object) { el.replaceChildren(v);

 return; }

  const o = document.createElement("span");
  o.className = "act-object";
  o.textContent = object;
  el.replaceChildren(v, " ", o);
}

/** 换过程行标题（和它前面的图标一起换）。进行中每句至少停 1.1 秒，后来的只留最新一句排队；now=true（收尾）立即换。 */
function setRunTitle(run: RunHost, text: string, now = false, kind?: IconKind): void {
  clearTimeout(run.titleTimer);
  const wait = now || applyingHistory ? 0 : run.titleAt + RUN_TITLE_HOLD_MS - Date.now();

  const paint = () => {
    paintAction(run.titleEl, text);

    if (kind) setActionIcon(run.actIcon, kind);
    run.titleAt = Date.now();
  };

  if (wait <= 0) paint();
  else run.titleTimer = window.setTimeout(paint, wait);
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

/**
 * explicit 模式下模型直接写的正文：先在回答位置逐段显示。之后又调了工具、下一轮又写了正文，
 * 或这一轮没有用它交付（停止、出错），就收进「执行过程」；宿主在整轮结束时交付它，接管这个气泡，不再另起一个。
 */
let leadAnswer: HTMLElement | null = null;

let leadAnswerText = "";

/** 这段正文所在的那一轮模型输出已结束。 */
let leadAnswerTurnClosed = false;

/** 这一轮已调用过工具：之后的正文按「先核对再显示」留在执行过程，由宿主交付。 */
let leadToolUsed = false;

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

/** 对话区上下边缘：哪一侧还能继续滚，哪一侧就淡出去（不画分割线）。 */
function syncScrollFade(): void {
  const frame = messagesEl.parentElement!;
  frame.dataset.fadeTop = String(messagesEl.scrollTop > 0);
  frame.dataset.fadeBottom = String(messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight > 1);
}

messagesEl.addEventListener("scroll", () => {
  pinned = nearBottom();
  toBottomBtn.hidden = pinned;
  syncScrollFade();
});

// 内容变长、侧栏变高时滚动位置不变也要重算两侧。
new ResizeObserver(syncScrollFade).observe(messagesEl);

new MutationObserver(syncScrollFade).observe(messagesEl, { childList: true, subtree: true, characterData: true });

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
    slashSkills.decorateUserMessage(div, text);
  } else if (!atts || atts.length === 0) {
    div.textContent = "";
  }

  appendToMessages(div);


  scrollToEnd();

  return div;
}

/** chip C：这一轮带给助手的页面和选段，只读地跟在用户消息下面。消息已发出，所以不给「×」。 */
function renderTurnContext(bubble: HTMLElement, context: UserTurnContext): void {
  const next = bubble.nextElementSibling;
  const row = next instanceof HTMLElement && next.matches(".ctx-chips") ? next : document.createElement("div");
  row.className = "ctx-chips";
  row.setAttribute("aria-label", "这一轮带给助手的内容");
  const chips: HTMLElement[] = [];
  const host = hostOf(context.url);

  if (context.title || host) {
    const glyph = siteGlyph(context.url, host);
    glyph.className = "cg";
    chips.push(ctxChip(glyph, context.title || host, [context.title, context.url].filter(Boolean).join("\n")));
  }

  if (context.selection) {
    const glyph = document.createElement("span");
    glyph.className = "cg";
    glyph.append(icon(TextQuote));
    chips.push(ctxChip(glyph, `「${clipTitle(context.selection, 18)}」`, context.selection));
  }

  row.replaceChildren(...chips);

  if (chips.length && row !== next) bubble.after(row);
}

function ctxChip(glyph: HTMLElement, label: string, title: string): HTMLElement {
  const chip = document.createElement("span");
  chip.className = "ctx-chip";
  chip.title = title;
  const text = document.createElement("span");
  text.className = "cl";
  text.textContent = label;
  chip.append(glyph, text);

  return chip;
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
}, () => selectedConversationId);

function addMsg(cls: string, text: string): HTMLElement {
  if (cls.split(/\s+/).includes("user")) {
    return addUserMsg(text);
  }

  const div = document.createElement("div");
  div.className = cls;

  if (cls.split(/\s+/).includes("assistant") && currentCitationSource && !replayingHistory) answerSources.set(div, currentCitationSource);
  div.textContent = text;
  appendToMessages(div);
  scrollToEnd();

  return div;
}

// ── 回答首句末尾「用了 N 条记忆 ›」：展开后插在首句与正文之间，每条可「忘掉」或「这里别用」 ──
type UsedItem = ({ kind: "entry"; entry: MemoryEntry; removed?: MemoryEntry[] } | { kind: "task"; task: TaskHistoryEntry })
  & { state: "used" | "forgotten" | "not-here"; pending: boolean; error: string };

type MemoryUsedLine = {
  cite: HTMLButtonElement; el: HTMLElement; items: Map<string, UsedItem>; hostname: string | null;
  open: boolean; showAll: boolean; answer: HTMLElement | null;
};

/** 展开后先列几条，其余收在「另有 N 条」里。 */
const USED_VISIBLE = 3;

const usedItemKey = (item: UsedItem): string => item.kind === "entry" ? `entry:${item.entry.id}` : `task:${item.task.id}`;

/** 同一轮里多次带记忆（重试、助手又查了记忆）并成一行，同一条只算一次。 */
function noteMemoryUsed(event: Extract<AgentUiEvent, { kind: "memory" }>): void {
  const line = pendingUsedLine ?? {
    cite: document.createElement("button"), el: document.createElement("div"), items: new Map<string, UsedItem>(),
    hostname: null, open: false, showAll: false, answer: null,
  };

  pendingUsedLine = line;
  line.hostname = event.hostname ?? line.hostname;

  const incoming: UsedItem[] = [
    ...event.entries.map((entry): UsedItem => ({ kind: "entry", entry: { ...entry, scope: { ...entry.scope } }, state: "used", pending: false, error: "" })),
    ...(event.tasks ?? []).map((task): UsedItem => ({ kind: "task", task, state: "used", pending: false, error: "" })),
  ];

  for (const item of incoming) if (!line.items.has(usedItemKey(item))) line.items.set(usedItemKey(item), item);
  renderUsedLine(line);
}

/** 最后一条用户消息之后、消息流里的最后一个回答。 */
function latestAnswer(): HTMLElement | null {
  for (let node = messagesEl.lastElementChild; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant")) return node;
  }

  return null;
}

function flushMemoryUsedLine(): void {
  const line = pendingUsedLine;
  pendingUsedLine = null;

  if (!line || !line.items.size) return;
  const answer = latestAnswer();

  // 复制按钮在最终稿放完后才挂：有它说明正文不会再整段重渲染。
  if (answer?.querySelector(".answer-actions")) {
    placeUsedLine(line, answer);

    return;
  }

  floatingUsedLine = line;
  messagesEl.appendChild(line.el);
  scrollToEnd();
}

/** 回答定稿（或重渲染后重新挂复制按钮）时调用：把这一轮的那一行放进首句。 */
function adoptUsedLine(answer: HTMLElement): void {
  const line = usedLineByAnswer.get(answer) ?? (floatingUsedLine && answer === latestAnswer() ? floatingUsedLine : null);

  if (line) placeUsedLine(line, answer);
}

function placeUsedLine(line: MemoryUsedLine, answer: HTMLElement): void {
  if (floatingUsedLine === line) floatingUsedLine = null;
  line.answer = answer;
  usedLineByAnswer.set(answer, line);
  // #56 D + X1：「用了 N 条记忆 ›」跟在首句后面，点开在首段下面撑出小条；「来源」面板只放网页。
  const first = answer.firstElementChild;
  let head: HTMLElement;

  // 首段是段落或标题就接在句尾；是列表、代码块等就单独起一行放在最前。
  if (first instanceof HTMLElement && /^(P|H[1-6])$/.test(first.tagName)) {
    head = first;
  } else {
    head = document.createElement("p");
    head.className = "memory-used-cite-row";
    answer.prepend(head);
  }

  head.append(line.cite);
  head.after(line.el);
  renderUsedLine(line);
}

const USED_GLYPHS: Record<"past" | "profile" | "method", string> = {
  past: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="5" r="4"/><path d="M5 2.8V5l1.5 1"/></svg>',
  profile: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.3" r="1.8"/><path d="M1.6 9c.4-1.9 1.8-2.9 3.4-2.9S8 7.1 8.4 9"/></svg>',
  method: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2.5h6M2 5h4M2 7.5h5"/></svg>',
};

function renderUsedLine(line: MemoryUsedLine): void {
  line.el.className = "memory-used-line";
  line.el.dataset.memoryUsedLine = String(line.items.size);
  const cite = line.cite;
  cite.type = "button";
  cite.className = "memory-used-toggle";
  cite.setAttribute("aria-expanded", String(line.open));
  const chevron = document.createElement("span");
  chevron.className = "memory-used-chevron";
  chevron.textContent = "›";
  cite.replaceChildren(`用了 ${line.items.size} 条记忆 `, chevron);
  cite.onclick = () => { line.open = !line.open; renderUsedLine(line); };

  const list = document.createElement("ul");
  list.className = "memory-used-list";
  // 放进回答后由外层按 data-open 弹簧撑开（styles.css），列表本身常在，展开收起不重建节点。
  list.hidden = !line.open && !line.answer;
  line.el.dataset.open = String(line.open);
  const items = Array.from(line.items.values());
  const shown = line.showAll ? items : items.slice(0, USED_VISIBLE);

  for (const item of shown) list.appendChild(renderUsedItem(line, item));

  if (shown.length < items.length) {
    const more = document.createElement("li");
    more.className = "memory-used-more";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `另有 ${items.length - shown.length} 条`;
    button.onclick = () => { line.showAll = true; renderUsedLine(line); };

    more.appendChild(button);
    list.appendChild(more);
  }

  // 还没放进回答时，灰字和列表一起独立成行。
  line.el.replaceChildren(...(line.answer ? [] : [cite]), list);
}

function usedButton(label: string, action: string, item: UsedItem, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.dataset.memoryUsedAction = action;
  button.textContent = label;
  button.disabled = item.pending;
  button.onclick = onClick;

  return button;
}

function renderUsedItem(line: MemoryUsedLine, item: UsedItem): HTMLElement {
  const row = document.createElement("li");
  row.className = "memory-used-item";
  row.dataset.usedKind = item.kind;
  row.dataset.usedId = item.kind === "entry" ? item.entry.id : item.task.id;
  row.dataset.state = item.state;
  const glyph = document.createElement("span");
  glyph.className = "memory-used-glyph";
  glyph.setAttribute("aria-hidden", "true");
  glyph.innerHTML = USED_GLYPHS[item.kind === "entry" ? item.entry.kind : "past"];
  const text = document.createElement("span");
  text.className = "memory-used-text";
  // 过往任务显示摘要（做成了什么），没有摘要时显示原话目标。一行放不下就截断，悬停看全文。
  text.textContent = item.kind === "entry" ? item.entry.text : item.task.summary || item.task.goal;
  text.title = text.textContent;
  const actions = document.createElement("span");
  actions.className = "memory-used-actions";
  const rerender = () => { if (line.el.isConnected || line === pendingUsedLine) renderUsedLine(line); };

  if (item.state === "used") {
    actions.append(usedButton("忘掉", "forget", item, () => runUsedAction(item, "forget", rerender)));

    // 没有当前网站（扩展页、空白页）就没有「这里」可言。
    if (line.hostname) actions.append(usedButton("这里别用", "not-here", item, () => runUsedAction(item, "not-here", rerender, line.hostname!)));
  } else {
    const note = document.createElement("span");
    note.className = "memory-used-note";
    note.textContent = item.state === "forgotten" ? "已忘掉" : `在 ${line.hostname} 不用`;
    actions.append(note, usedButton("撤销", "undo", item, () => runUsedAction(item, "undo", rerender, line.hostname ?? undefined)));
  }

  row.append(glyph, text, actions);

  if (item.error) {
    const error = document.createElement("span");
    error.className = "memory-used-error";
    error.textContent = item.error;
    row.appendChild(error);
  }

  return row;
}

/** 忘掉 / 这里别用 / 撤销：记忆走记忆面板的同一套请求，过往任务走过往任务的请求。 */
function runUsedAction(item: UsedItem, action: "forget" | "not-here" | "undo", rerender: () => void, hostname?: string): void {
  const undoing = action === "undo" ? item.state : null;
  const next: UsedItem["state"] = action === "forget" ? "forgotten" : action === "not-here" ? "not-here" : "used";

  const done = (result: { ok: boolean; entry?: MemoryEntry; entries?: MemoryEntry[]; error?: string }) => {
    item.pending = false;

    if (result.ok) {
      item.state = next;
      item.error = "";

      if (item.kind === "entry") {
        if (action === "forget") item.removed = result.entries;
        const current = result.entry ?? result.entries?.find(entry => entry.id === item.entry.id);

        if (current) item.entry = current;
      }
    } else {
      item.error = `${action === "forget" ? "没有忘掉" : action === "not-here" ? "没有改成这里别用" : "没有撤销"}：${result.error ?? "请重试"}`;
    }

    rerender();
  };

  item.pending = true;
  item.error = "";
  rerender();

  if (item.kind === "entry") {
    const message = action === "forget" ? memoryState.beginForget(selectedConversationId, item.entry)
      : undoing === "forgotten" ? memoryState.beginUnforget(selectedConversationId, item.removed ?? [item.entry])
        : memoryState.beginSite(selectedConversationId, item.entry, hostname!, action === "not-here");

    usedLineHandlers.set(message.requestId, done);
    dispatchMemoryRequest(message, { action: message.type === "memory_forget" ? "forget" : message.type === "memory_unforget" ? "unforget" : "site", entryId: item.entry.id });

    return;
  }

  const requestId = crypto.randomUUID();

  const message: ClientMessage = action === "forget" ? { type: "task_history_forget", requestId, conversationId: selectedConversationId, id: item.task.id }
    : undoing === "forgotten" ? { type: "task_history_restore", requestId, conversationId: selectedConversationId, task: item.task }
      : { type: "task_history_site", requestId, conversationId: selectedConversationId, id: item.task.id, hostname: hostname!, off: action === "not-here" };

  usedLineHandlers.set(requestId, done);

  if (!send(message)) {
    usedLineHandlers.delete(requestId);
    done({ ok: false, error: "连接不可用，请重试" });
  }
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
  const saved = event.action === "saved" && event.entries.length === 1 && !event.entries[0]!.experience ? event.entries[0]! : null;

  // 自动记下的资料：回执直接写出记了什么，旁边给「撤销」（用户 2026-09-27 选择「自动记，给撤销」）。
  if (saved) {
    const text = document.createElement("span");
    text.className = "memory-receipt-text";
    text.textContent = `已记住：${saved.text}`;
    button.textContent = "查看";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.dataset.memoryUndo = saved.id;
    undo.textContent = "撤销";
    undo.onclick = () => {
      undo.disabled = true;
      const message = memoryState.beginForget(selectedConversationId, saved);
      receiptUndos.set(message.requestId, (ok, error) => {
        if (ok) { text.textContent = "已撤销，不再记住这条"; undo.remove(); button.remove();

 return; }

        undo.disabled = false;
        text.textContent = `没能撤销：${error ?? "请重试"}`;
      });
      dispatchMemoryRequest(message, { action: "forget", entryId: saved.id });
    };

    receipt.replaceChildren(mark, text, undo, button);
  }

  if (event.entries.length === 1 && !saved) {
    const scope = document.createElement("span");
    scope.className = "memory-receipt-scope";
    scope.textContent = memoryScopeLabel(event.entries[0]!.scope);
    receipt.appendChild(scope);
  }

  messagesEl.appendChild(receipt);
  scrollToEnd();

  return receipt;
}

// ── 纠正后开口问「要我记住吗」──
/**
 * 询问事件：第一条带出卡片；同一 askId 带 outcome 的后续事件（现场或对话历史回放）把它推到结局。
 * 没有本地状态的回放卡片直接停在结局；没有结局的照常可点。
 */
function renderMemoryAsk(event: MemoryAskEvent): void {
  if (!memoryAskCards.has(event.askId)) memoryAskCards.set(event.askId, createAskCard(event));

  if (event.outcome) stepMemoryAsk(event.askId, { kind: "outcome", outcome: event.outcome });

  if (messagesEl.querySelector(`[data-memory-ask="${CSS.escape(event.askId)}"]`)) return;
  appendToMessages(buildMemoryAsk(event.askId));
  scrollToEnd();
}

/** 用户动作或后台结果交给询问卡片：重画，有请求就发出去，结果（含被忽略）再回到这里。 */
function stepMemoryAsk(askId: string, input: AskInput): void {
  const current = memoryAskCards.get(askId);

  if (!current) return;
  const { card, request } = stepAsk(current, input);
  memoryAskCards.set(askId, card);
  messagesEl.querySelector(`[data-memory-ask="${CSS.escape(askId)}"]`)?.replaceWith(buildMemoryAsk(askId));

  if (!request) return;

  const message = request.type === "answer"
    ? memoryState.beginAskAnswer(selectedConversationId, askId, request.answer, request.text)
    : request.type === "update"
      ? memoryState.beginUpdate(selectedConversationId, request.entry, request.text, request.scope)
      : request.type === "restore"
        ? memoryState.beginRestore(selectedConversationId, request.entry)
        : memoryState.beginForget(selectedConversationId, request.entry);

  memoryAskHandlers.set(message.requestId, (result) => stepMemoryAsk(askId, result));
  dispatchMemoryRequest(message, request.type === "answer" ? { action: "ask" } : { action: request.type, entryId: request.entry.id });
}

function memoryAskButton(className: string, label: string, input: AskInput, card: MemoryAskCard): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = card.pending !== null || !stepAsk(card, input).request;
  button.onclick = () => stepMemoryAsk(card.ask.askId, input);

  return button;
}

function buildMemoryAsk(askId: string): HTMLElement {
  const card = memoryAskCards.get(askId)!;
  const root = document.createElement("div");
  root.className = "memory-ask";
  root.dataset.memoryAsk = askId;
  root.dataset.state = card.phase;
  const line = document.createElement("p");
  line.className = "memory-ask-line";
  root.appendChild(line);
  const scopeLabel = (scope: MemoryScope): string => scope.kind === "all" ? "所有网站" : "这个网站";

  if (card.phase === "open" || card.phase === "closed") {
    line.textContent = `${card.ask.habit ? "你好像总是" : ""}${card.ask.rule.trim().replace(/[。.!！?？，,；;]+$/u, "")}，要我记住吗？`;

    if (card.ask.replaces) {
      const replaces = document.createElement("p");
      replaces.className = "memory-ask-replaces";
      replaces.dataset.memoryAskReplaces = card.ask.replaces.id;
      replaces.textContent = `这会替换：${card.ask.replaces.text}`;
      root.appendChild(replaces);
    }

    // 已作废：问句加一行说明（后台的原话或「这条询问已结束」），不给按钮。
    if (card.phase === "closed") {
      const note = document.createElement("p");
      note.className = "memory-ask-replaces";
      note.textContent = card.error || "这条询问已结束";
      root.appendChild(note);

      return root;
    }

    // 「改一下」：在卡片里改规则文字，点「记住」时存改后的文字（范围仍是这张卡片的范围）。
    let draft: HTMLTextAreaElement | null = null;

    if (card.draft !== undefined) {
      draft = document.createElement("textarea");
      draft.className = "memory-ask-edit";
      draft.dataset.memoryAskEdit = "";
      draft.rows = 2;
      draft.maxLength = MEMORY_TEXT_MAX;
      draft.value = card.draft;
      draft.disabled = card.pending !== null;
      draft.setAttribute("aria-label", "改成要我记住的做法");
      root.appendChild(draft);
    }

    const pills = document.createElement("div");
    pills.className = "memory-ask-pills";

    for (const [answer, label] of [["remember", "记住"], ["once", "这次就行"]] as const) {
      const pill = memoryAskButton(answer === "remember" ? "memory-ask-pill memory-ask-yes" : "memory-ask-pill", label, { kind: answer }, card);
      pill.dataset.memoryAskAnswer = answer;

      if (answer === "remember" && draft) pill.onclick = () => stepMemoryAsk(card.ask.askId, { kind: "remember", text: draft.value });

      if (card.pending === answer) pill.setAttribute("aria-busy", "true");
      pills.appendChild(pill);
    }

    if (!draft) {
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "memory-ask-pill";
      edit.dataset.memoryAskEditOpen = "";
      edit.textContent = "改一下";
      edit.disabled = card.pending !== null;

      edit.onclick = () => {
        stepMemoryAsk(card.ask.askId, { kind: "edit" });
        messagesEl.querySelector<HTMLTextAreaElement>(`[data-memory-ask="${CSS.escape(card.ask.askId)}"] [data-memory-ask-edit]`)?.focus();
      };

      pills.appendChild(edit);
    }

    root.appendChild(pills);
  } else if (card.phase === "once") {
    line.textContent = "好，这次就不记了。";
  } else if (card.phase === "noted") {
    line.textContent = "好，记住了。可在「记忆」面板查看或撤销";
  } else if (card.phase === "undone") {
    line.textContent = "已撤销。";
  } else if (card.phase === "already") {
    line.append("已经记着了。");

    if (card.entry) {
      const scope = document.createElement("span");
      scope.className = "memory-ask-scope";
      scope.dataset.memoryAskScope = card.entry.scope.kind;
      scope.textContent = scopeLabel(card.entry.scope);
      line.append(scope);
    }
  } else if (card.entry) {
    const entry = card.entry;
    const scope = memoryAskButton("memory-ask-scope", scopeLabel(entry.scope), { kind: "scope" }, card);
    scope.dataset.memoryAskScope = entry.scope.kind;

    if (!scope.disabled) scope.title = entry.scope.kind === "site" ? `只在 ${entry.scope.hostname} 照做，点一下改成所有网站` : "在所有网站照做，点一下改成只在这个网站";
    const undo = memoryAskButton("memory-ask-undo", card.pending === "undo" ? "正在撤销…" : "撤销", { kind: "undo" }, card);
    undo.dataset.memoryAskUndo = entry.id;
    line.append("好，记住了。", scope, undo);
  }

  if (card.error) {
    const error = document.createElement("p");
    error.className = "memory-ask-error";
    error.setAttribute("role", "alert");
    error.textContent = card.error;
    root.appendChild(error);
  }

  return root;
}

// ── 执行步骤聚合块 ──────────────────────────────────────────
// 一次 run（用户消息 → agent_end）只有一条状态行：[光球] 正在做什么 · 耗时（在 summary 上）。
// 思考块、旁白与动作卡收进同一个 details 的 body；第一张动作卡出现时展开（#47），结束后收起成历史。


/** 最后一轮是刚发出的用户消息，后面还没有过程行或回答。 */
function awaitingFirstStep(): boolean {
  const last = [...messagesEl.children].reverse().find((e) => e.matches(".msg.user, .msg.assistant, details.run-steps"));

  return !!last?.matches(".msg.user");
}

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
  // 过程行不放光球（#58 C）：光球只属于起始区和语音。orb 对象仍跟踪状态，不挂进页面就不画帧。
  iconBox.append(orbMark);
  const actIcon = document.createElement("span");
  actIcon.className = "run-act-icon";
  setActionIcon(actIcon, "think");
  const title = document.createElement("span");
  title.className = "run-title";
  paintAction(title, `正在${loaderSubtitle(null)}`);
  const chainEl = document.createElement("span");
  chainEl.className = "run-chain";
  const timeEl = document.createElement("span");
  timeEl.className = "run-time";
  const chevron = document.createElement("span");
  chevron.className = "run-chevron";
  chevron.appendChild(icon(ChevronRight));
  summary.append(iconBox, actIcon, title, chainEl, timeEl, chevron);
  const body = document.createElement("div");
  body.className = "run-body";
  runBodyPinned = true;
  bindLiveViewport(body, (next) => {
    runBodyPinned = next;
  });
  const reveal = document.createElement("div");
  reveal.className = "run-reveal";
  reveal.append(body);
  root.append(summary, reveal);
  messagesEl.appendChild(root);
  const start = runStartAt || eventTime();
  timeEl.textContent = spokenDuration(start, eventTime()) ?? "";

  // 唯一状态行的耗时读数，按秒走
  const timer = window.setInterval(() => {
    timeEl.textContent = spokenDuration(start, Date.now()) ?? "";
  }, 1000);

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
    orbActivity: new RunOrbActivity(),
    orbMark,
    changedPage: false,
    titleAt: 0,
    titleTimer: 0,
    actIcon,
  };

  return currentRun;
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
  }

  // 同一个位置：Agent 在做时是「我来」，页面归你时是「你继续」。
  takeoverBtn.hidden = !flags.takeoverVisible && !flags.userHasPage;
  takeoverBtn.dataset.mode = flags.userHasPage ? "handback" : "takeover";
  takeoverBtn.textContent = flags.userHasPage ? "交还" : "接管";
  takeoverBtn.title = flags.userHasPage ? "交还页面，Agent 先重读页面再接着做" : "你来操作这个页面，Agent 先停手";
  steerRibbon.setRunning(running && !flags.userHasPage);

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

  syncSteerSend();

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
    // 停止或出错收尾：回答位置那段没交付的正文按原来的样子留在执行过程里（过程行因此保留）。
    const outcome = currentRun?.orbActivity.state();

    if (outcome === "stopped" || outcome === "failed") foldLeadAnswer();
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
  user: { icon: Hand, label: "已暂停 · 页面归你" },
  completed: { icon: Check, label: "本轮结束" },
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

  // 收尾后标题由 finishRun 定稿（做了几件事），迟到的 tool_end 不再改回状态词。
  if (mark && state !== "completed" && !run.root.classList.contains("done") && run.titleEl.textContent !== mark.label) setRunTitle(run, mark.label, true);
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
  const hasResumeReceipt = !!run.body.querySelector(".receipt-history");
  const keepProcess = run.changedPage || hasResumeReceipt || outcome === "failed" || outcome === "stopped";

  if (!hasSteps || !keepProcess) {
    run.root.remove();

    if (lastRun === run) lastRun = null;

    return;
  }

  run.root.classList.add("done");
  run.orbActivity.finish();
  syncRunOrb(run);
  const title = run.titleEl;

  if (title) {
    const outcome = run.orbActivity.state();
    // 准备动作（定位当前页、读页面结构）不算一件事。
    const done = Array.from(run.body.querySelectorAll<HTMLElement>(".chip:not(.prep)"));
    const ended = outcome === "failed" || outcome === "stopped" ? outcome : "completed";
    const only = done.length === 1 && ended === "completed" ? done[0] : null;
    // SAFETY: data-kind 由 onToolStart 写入，取值就是 IconKind。
    setActionIcon(run.actIcon, only ? (only.dataset.kind as IconKind) : "many");
    setRunTitle(run, hasResumeReceipt && done.length === 0 && ended === "completed"
      ? "恢复记录"
      : only?.dataset.past ?? finishedRunTitle(done.length, ended), true);
  }

  run.timeEl.textContent = spokenDuration(run.start, eventTime()) ?? "";
  run.root.open = false;
  placeProcessBeforeAnswer(run.root);

  for (let node = run.root.nextElementSibling; node && !node.matches(".msg.user"); node = node.nextElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant")) syncAnswerTime(node);
  }

  scrollToEnd();
}

/**
 * 过程行放在这一轮用户消息（和它的 chip、「收到」这类确认语）之后、回答之前：先看到做了什么，再看结论。
 * 回答可能在过程块创建前就已开始渲染，所以结束时按位置规则摆放，而不是依赖事件先后。
 */
function placeProcessBeforeAnswer(root: HTMLElement): void {
  let anchor: Element | null = root.previousElementSibling;

  while (anchor && !anchor.classList.contains("user")) anchor = anchor.previousElementSibling;

  if (!anchor) return;
  let next = anchor.nextElementSibling;

  // chip 跟着用户消息（chip C），「收到」这类确认语也留在前面。
  while (next instanceof HTMLElement && next !== root && (next.dataset.deliveryKind === "ack" || next.classList.contains("ctx-chips"))) next = next.nextElementSibling;

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

  closeLeadDraft();

  if (leadAnswer) {
    leadAnswer.classList.remove("streaming");
    leadAnswerTurnClosed = true;
  }
}

function closeLeadDraft(): void {
  if (currentLeadDraftDetails) {
    orbByHost.get(currentLeadDraftDetails)?.setRunning(false);
    currentLeadDraftDetails.classList.remove("streaming");
  }

  currentLeadDraft = null;
  currentLeadDraftDetails = null;
}

/** 正文开始出字、这一轮还没做过动作：「正在思考」让位给正文；之后有动作再出来。 */
function quietRunForProse(): void {
  if (currentRun && !currentRun.body.querySelector(".chip")) currentRun.root.hidden = true;
}

/** 模型直接写的正文：没调过工具时放在回答位置逐段显示；新一轮的正文出现时，上一轮那段只是过程。 */
function appendLeadAnswer(delta: string): void {
  // 过程行照常在跑：停止、出错时这段正文按原样收进去，过程行也随之保留。
  ensureRun();

  if (leadAnswer && leadAnswerTurnClosed) foldLeadAnswer();

  if (!leadAnswer) {
    quietRunForProse();
    leadAnswer = addMsg("msg assistant markdown streaming", "");
    leadAnswerText = "";
    leadAnswerTurnClosed = false;
    steerRibbon.decorate(leadAnswer, !applyingHistory);
  }

  leadAnswerText += delta;
  revealText(leadAnswer, leadAnswerText, { render: renderMarkdown, live: !applyingHistory, final: false, onProgress: scrollToEnd });
}

/**
 * 回答位置的正文不是最终回答：收进这一轮的「执行过程」（与它当初直接写进执行过程时一样），回答位置不留副本。
 * 这一轮已经收尾时不再新开过程行：原来这段正文随过程行一起不显示。
 */
function foldLeadAnswer(): void {
  const answer = leadAnswer;
  const text = leadAnswerText;
  const turnClosed = leadAnswerTurnClosed;

  if (!answer) return;
  leadAnswer = null;
  leadAnswerText = "";
  leadAnswerTurnClosed = false;
  steerRibbon.undecorate(answer);
  answer.remove();

  if (!currentRun || !text) return;
  closeLeadDraft();
  appendLeadDelta(text);

  if (turnClosed) closeLeadDraft();
}

/** 宿主交付的就是回答位置正在显示的那段正文：沿用这个气泡，不再另起一个。 */
function adoptLeadAnswer(deliveryId: string, kind: string, runId: string | null | undefined): void {
  if (!leadAnswer || deliveredBubbles.has(deliveryId) || (kind !== "finding" && kind !== "reply")) return;
  const currentRunId = conversations.get(selectedConversationId)?.runId ?? null;

  if (runId && currentRunId && runId !== currentRunId) return;
  leadAnswer.dataset.deliveryId = deliveryId;
  leadAnswer.dataset.deliveryKind = kind;
  leadAnswer.dataset.streaming = "true";
  deliveredBubbles.set(deliveryId, leadAnswer);
  leadAnswer = null;
  leadAnswerText = "";
  leadAnswerTurnClosed = false;
}

function appendLeadDelta(delta: string): void {
  const run = ensureRun();

  if (!currentLeadDraft) {
    const details = document.createElement("details");
    // #47：过程旁白直接露出，夹在前后动作卡之间；之后的动作另起一组卡。
    details.className = "thinking narration streaming";
    details.open = true;
    run.chipGroup = null;
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

  appendTrace(currentLeadDraft, delta);
  scrollToEnd();
}

/** 思考摘要、旁白按原文累积。 */
const traceText = new WeakMap<HTMLElement, string>();

/**
 * 只认 **粗体**：模型（如 GPT 的思考摘要）用它写每段的小标题，原样显示成「**Checking …**」。
 * 过程区不排标题、列表这类大块格式；空行压成换行，摘要读起来是一串短句。
 */
function appendTrace(pre: HTMLElement, delta: string): void {
  const text = (traceText.get(pre) ?? "") + delta;
  traceText.set(pre, text);

  const parts = text.replace(/\n{2,}/g, "\n").split(/\*\*([^*\n]+)\*\*/g).map((part, i) => {
    if (i % 2 === 0) return part;

    const strong = document.createElement("strong");
    strong.textContent = part;

    return strong;
  });

  pre.replaceChildren(...parts);
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

    appendTrace(currentThinking, delta);
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
  entry.chip.after(group.detail);
  renderChipDetail(entry);
  group.detail.hidden = false;
  scrollToEnd();
}

const BOOKKEEPING_TOOLS = new Set(["send_user_message"]);

/** 用户能在页面上看到后果的动作；滚动、悬停、事件监听只是为了读页。 */
const PAGE_VIEWING_TOOLS = new Set(["scroll", "hover", "arm_event", "wait_event", "disarm_event"]);

function changesPage(name: string, tabsAction: string | undefined): boolean {
  // 开、关标签页也是用户看得见的后果；tabs 的其余动作只是查看。
  if (name === "tabs") return tabsAction === "open" || tabsAction === "close";

  return isWriteTool(name) && !PAGE_VIEWING_TOOLS.has(name);
}

function onToolStart(ev: { toolCallId: string; name: string; params: Record<string, unknown> }): void {
  const action = describeTool(ev.name, ev.params);
  const run = ensureRun();
  closeBlocks();

  // 交付回答是助手的内部记账，不算用户看得懂的一步。
  if (BOOKKEEPING_TOOLS.has(ev.name)) {
    run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
    syncRunOrb(run);

    return;
  }

  run.root.hidden = false;
  addChainStep(action.short);
  run.lastToolShort = action.short;

  // #58 C 取代 #47 的自动展开：进行中只有一行「正在…」，做过的步骤收在 › 里。

  if (!run.chipGroup) run.chipGroup = buildChipGroup(run.body);
  const group = run.chipGroup;

  run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
  syncRunOrb(run);

  if (changesPage(ev.name, typeof ev.params.action === "string" ? ev.params.action : undefined)) run.changedPage = true;

  const prep = isPrepTool(ev.name, ev.params);
  const kind: IconKind = prep ? "read" : actionKind(ev.name, ev.params);

  if (orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    setRunTitle(run, `正在${actionCardLabel(ev.name, ev.params)}`, false, kind);
  }

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = prep ? "chip prep" : "chip";
  chip.dataset.kind = kind;
  chip.dataset.past = pastAction(ev.name, ev.params);
  chip.setAttribute("aria-expanded", "false");

  // A：正在跑的那个 chip 才有蓝边和底色；历史回放不进入运行态
  if (!applyingHistory) chip.classList.add("running");
  const dot = document.createElement("span");
  dot.className = `chip-dot ${chipState(false, false)}`;
  const iconBox = document.createElement("span");
  iconBox.className = "chip-icon";
  setActionIcon(iconBox, kind);
  // 工具在跑时用光球（solving = 色带归位）；跑完定格在同一颗球上，不换成别的图标
  const chipOrb = createOrb("solving", ORB_BOX_CHIP);

  if (!applyingHistory) chipOrb.setRunning(true);
  const label = document.createElement("span");
  label.className = "chip-label";
  paintAction(label, actionCardLabel(ev.name, ev.params));
  const dur = document.createElement("span");
  dur.className = "dur";
  dur.hidden = true;
  const more = document.createElement("span");
  more.className = "chip-more";
  more.appendChild(icon(ChevronRight));
  chip.append(dot, iconBox, label, dur, more);

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

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string; repeatRefused?: true }): void {
  const run = currentRun ?? lastRun;

  if (run) {
    run.orbActivity.observe({ kind: "tool_end", name: "", ...ev });
    syncRunOrb(run);
  }

  const entry = toolChips.get(ev.toolCallId);
  toolChips.delete(ev.toolCallId);

  // 这一步做完、下一步还没开始：模型在想下一步，标题不该停在刚结束的动作上（「正在读取页面结构 54 秒」）。
  if (run && run === currentRun && !toolChips.size && orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    setRunTitle(run, `正在${loaderSubtitle(null)}`, false, "think");
  }

  if (!entry) return;
  // 用户拒绝授权的那一步照你的意思没做：不画成失败。
  const failed = ev.isError && !ev.repeatRefused;
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

  if (ev.repeatRefused && label) label.append("（已做过，没再重复）");

  if (failed && label) {
    const note = document.createElement("span");
    note.className = "act-failed";
    note.textContent = " · 没成功";
    label.append(note);
  }

  const text = ev.resultText ?? "";

  if (text) entry.resultText = text.length > 800 ? `${text.slice(0, 797)}...` : text;

  // 详情正展开着这个 chip 时实时补上结果
  if (entry.group.expanded === entry) renderChipDetail(entry);

  scrollToEnd();
}

/** 成功恢复属于同一任务的执行记录；没有匹配过程时先保留一条中性历史回执。 */
function groupProcessReceipts(): void {
  const receipts = Array.from(messagesEl.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && !!node.dataset.processRunId,
  );

  for (const receipt of receipts) {
    const run = Array.from(messagesEl.querySelectorAll<HTMLElement>(".run-steps[data-run-id]"))
      .reverse().find((node) => node.dataset.runId === receipt.dataset.processRunId);

    run?.querySelector(".run-body")?.append(receipt);
  }
}

function handleAgentEvent(ev: AgentUiEvent, sessionId?: string, runId?: string | null): void {
  // 并行助手已删除：非主会话的事件不再出现，出现也不渲染。
  if (sessionId && !isLeadSession(sessionId)) return;

  const progressRun = currentRun ?? lastRun;

  if (progressRun && (ev.kind === "error" || ev.kind === "agent_end" || ev.kind === "run_stopped")) { progressRun.orbActivity.observe(ev); syncRunOrb(progressRun); }

  switch (ev.kind) {
    case "memory":
      if (ev.action === "used") noteMemoryUsed(ev);
      else renderMemoryReceipt(ev);
      refreshMemoryIfStale(ev.rev);
      break;
    case "memory_ask":
      renderMemoryAsk(ev);
      break;
    case "text_delta":
      if (leadDeliveryMode === "explicit") {
        if (leadToolUsed) appendLeadDelta(ev.delta);
        else appendLeadAnswer(ev.delta);
      } else {
        appendDelta("assistant", ev.delta);
      }

      break;
    case "thinking_delta":
      appendDelta("thinking", ev.delta);
      break;
    case "tool_start":
      // 正文之后又调了工具：那段正文是过渡话，先收进执行过程，再记这次工具调用。
      if (leadDeliveryMode === "explicit") {
        foldLeadAnswer();
        leadToolUsed = true;
      }

      onToolStart(ev);
      break;
    case "tool_end":
      onToolEnd(ev);
      break;
    case "agent_start":
      if (!citationRequestPending) currentCitationSource = null;

      citationRequestPending = false;

      if (!runId || runId === conversations.get(selectedConversationId)?.runId) noteRunStarted(runId);
      foldLeadAnswer();
      leadDeliveryMode = (ev as { deliveryMode?: "explicit" }).deliveryMode ?? null;
      leadToolUsed = false;
      resultByConversation.delete(selectedConversationId);
      renderTaskStrip();
      closeBlocks();

      errorCards.retire();
      // #58 C：一开始就有一行「正在思考」，模型想很久时也看得到在做（任务条不再兜这段）。
      // 新会话第一轮的开头经补放历史到达，所以补放时也建；补放到 agent_end 会照常收尾。
      ensureRun();
      break;
    case "turn_end":
      closeBlocks();
      break;
    case "agent_end":
      closeBlocks();
      flushMemoryUsedLine();
      // 宿主没有用它交付（停止、出错、交给用户）：和原来一样只留在执行过程里。
      foldLeadAnswer();
      leadDeliveryMode = null;
      steerRibbon.reset();
      artifactCards.settleAfterTurn();
      break;
    case "user_delivery":
      handleUserDelivery(ev.delivery);

      if (ev.delivery.conversationId === selectedConversationId) errorCards.delivered();
      break;
    case "artifact":
      artifactCards.apply(ev);
      break;
    case 'user_delivery_stream': {
      const s=ev.stream;

      if (s.phase === "streaming") adoptLeadAnswer(s.id, s.kind, s.runId);
      const bubble=deliveredBubbles.get(s.id);
      const state=bubble?{official:bubble.dataset.streaming===undefined,streaming:bubble.dataset.streaming==='true',cancelled:bubble.dataset.streaming==='cancelled'}:undefined;
      const plan=deliveryPresentation({kind:'stream',phase:s.phase},state);

      if(plan==='ignore'||plan==='status')break;

      if(plan==='mark_cancelled'){bubble!.dataset.streaming='cancelled';bubble!.title='这次回答未完成';break;}

      if(!bubble)quietRunForProse();

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
        if (currentRun && !applyingHistory) setRunTitle(currentRun, ev.message);
      } else if(ev.plan){
        const key=`plan:${ev.plan.conversationId}:${ev.plan.id}`;
        const text=`语音计划 · 共${ev.plan.steps.length}步\n`+ev.plan.steps.map((s,i)=>`${i+1}. ${s.targetTitle??'目标会话'} · ${s.receipt?.message??(s.status==='pending'?'结果待确认':'未执行')}\n${s.text}`).join('\n');
        const previous=receiptMessages.get(key);

if(previous)previous.textContent=text;else receiptMessages.set(key,addMsg('msg notice',text));
      }else if (ev.receipt) {
        // 任务条材料只认这张回执：accepted/applied 才把这次发出的材料升级为「已随任务送入」。
        taskBar.noteReceipt(ev.receipt);

        // 插话没被采纳：下一段回答不是按它写的，不挂「已改方向」。
        if (ev.receipt.action === "steer" && (ev.receipt.status === "rejected" || ev.receipt.status === "failed")) steerRibbon.reset();

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
        const copy = receiptCopy(ev.receipt, selectedConversationId);

        if (copy.collapsed) {
          previous?.remove();
          receiptMessages.delete(key);
          break;
        }

        const restoreFocus = previous?.contains(document.activeElement);
        const receipt = renderReceipt(ev.receipt, selectedConversationId, previous, forkReceipt);

        if (previous) previous.replaceWith(receipt);

        if (!previous || !copy.inProcess) messagesEl.append(receipt);
        receiptMessages.set(key, receipt);

        if (restoreFocus) receipt.querySelector<HTMLElement>('summary,button')?.focus({preventScroll:true});
        scrollToEnd();
      } else addMsg("msg notice", ev.message);
      break;
    case "error": {
      const copy = describeModelError(ev.message);

      if (copy) errorCards.show(copy);
      else addMsg("msg error", ev.message);
      break;
    }
  }

  if (currentRun && runId && currentRun.root.dataset.runId !== runId) {
    currentRun.root.dataset.runId = runId;
    groupProcessReceipts();
  } else if (ev.kind === "notice" && ev.receipt) {
    groupProcessReceipts();
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

  if (!staleForStrip) adoptLeadAnswer(delivery.id, delivery.kind, delivery.runId);
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
      after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') { attachAnswerActions(answer); attachDeliverySources(answer, delivery); } } });
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
  steerRibbon.decorate(bubble, !applyingHistory);
  // 整段一次送达的回答也按同样节奏放出来，不一下子整块冒出。
  revealText(bubble, delivery.text, { render: renderMarkdown, live: !applyingHistory, final: true, onProgress: scrollToEnd,
    after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') { attachAnswerActions(bubble); attachDeliverySources(bubble, delivery); } } });
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
// #53 继续上次的事：空白会话起点区的「没做完的事」卡，逻辑在 open-threads.ts。
// 起点区中央的光球：看得见时才转，起点区收起就停，不空耗。
{
  const canvas = document.querySelector<HTMLCanvasElement>("#starter-orb")!;
  let stop: (() => void) | null = null;
  new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && !stop) stop = mountOrb(canvas, 56, () => "idle");
    else if (!entry?.isIntersecting && stop) { stop(); stop = null; }
  }).observe(canvas);
}

configureOpenThreads({
  root: document.getElementById("starter")!,
  send,
  conversations: () => conversations.values(),
  currentConversationId: () => selectedConversationId,
  ready: () => starterReady() && conversationEmpty(),
  selectConversation: (id) => selectConversation(id),
});

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

/** Render only host facts. The footer reuses ResumeEntry's request, receipt and timeout handling. */
function renderStreamTaskCard(view: TaskView): void {
  const resumeRoot = document.getElementById("resume-entry-root")!;

  if (!view.runId || !view.goal || view.state === "none") return;

  let card = Array.from(messagesEl.querySelectorAll<HTMLElement>(".ai-task-card"))
    .find(node => node.dataset.runId === view.runId);

  if (card && Number(card.dataset.observedAt) > view.observedAt) return;
  // A completed plain answer is not a multi-step task; keep its original uncluttered path.

  if (view.state === "idle" && !view.results.length && !view.outstanding.length && !view.resumable) {
    if (card) { messagesEl.append(resumeRoot); card.remove(); }

    return;
  }

  if (!card) {
    card = document.createElement("section");
    card.className = "ai-task-card expanded";
    card.dataset.runId = view.runId;
    card.innerHTML = `<button type="button" class="ai-task-trigger" aria-expanded="true">
      <span class="trigger-top-row"><span class="target-scope"><span class="dot"></span><span class="task-site"></span></span>
      <span class="trigger-right"><span class="task-status-badge"></span><span class="task-chevron" aria-hidden="true">⌄</span></span></span>
      <span class="task-goal-line"></span></button>
      <div class="ai-task-reveal"><div class="ai-task-content"><div class="task-items"></div><div class="sources-row"></div></div></div>
      <div class="ai-task-footer"></div>`;
    const trigger = card.querySelector<HTMLButtonElement>(".ai-task-trigger")!;
    const reveal = card.querySelector<HTMLElement>(".ai-task-reveal")!;
    const content = card.querySelector<HTMLElement>(".ai-task-content")!;
    content.id = `task-content-${crypto.randomUUID()}`;
    trigger.setAttribute("aria-controls", content.id);
    trigger.onclick = () => {
      const expanded = card!.classList.toggle("expanded");
      trigger.setAttribute("aria-expanded", String(expanded));
      reveal.inert = !expanded;
    };

    appendToMessages(card);
  }

  card.dataset.observedAt = String(view.observedAt);
  card.querySelector(".task-goal-line")!.textContent = view.goal;
  // One ledger item may occur in both lists. Keep its last authoritative status, never infer success.
  const items = new Map([...view.results, ...view.outstanding].map(item => [item.id, item]));
  const done = [...items.values()].filter(item => item.status === "satisfied").length;
  card.querySelector(".task-status-badge")!.textContent = `${stateHeadline(view.state, view.resumable)}${items.size ? ` (${done}/${items.size})` : ""}`;
  const list = card.querySelector(".task-items")!;
  list.replaceChildren();
  const labels = { satisfied: "已完成", pending: "待执行", blocked: "受阻", unknown: "结果未知" };

  for (const item of items.values()) {
    const row = document.createElement("div");
    row.className = `task-item ${item.status === "satisfied" ? "done" : "pending"}`;
    const mark = document.createElement("span");
    mark.className = "task-item-icon";
    mark.textContent = item.status === "satisfied" ? "✓" : item.status === "pending" ? "○" : "!";
    mark.setAttribute("aria-hidden", "true");
    const title = document.createElement("span");
    title.textContent = `${labels[item.status]} · ${plainStep(item.description)}`;
    row.append(mark, title);
    list.append(row);
  }

  for (const active of view.active) {
    const row = document.createElement("div");
    row.className = "task-item pending";
    row.textContent = `正在执行 · ${plainStep(active.action)}`;
    list.append(row);
  }

  if (!list.childElementCount) list.textContent = view.state === "running" ? "正在准备任务…" : "没有已记录的步骤。";
  const sources = card.querySelector(".sources-row")!;
  sources.replaceChildren();

  for (const material of view.materials ?? []) {
    const chip = document.createElement("span");
    chip.className = "source-chip";
    chip.textContent = material.label;
    chip.title = "已随任务送入的材料，不代表内容已经核实";
    sources.append(chip);
  }

  const site = card.querySelector(".task-site")!;
  site.textContent = view.materials?.find(item => item.kind === "page")?.label ?? "当前任务";

  if (view.page) {
    const observedAt = view.observedAt;
    void resolveTabPage(view.page.tabId).then(page => {
      if (page?.url && card!.isConnected && Number(card!.dataset.observedAt) === observedAt) site.textContent = hostOf(page.url);
    });
  }
  // Move the existing root, not a copied resume button. Conversation reset preserves this node.

  card.querySelector(".ai-task-footer")!.append(resumeRoot);
}

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
  const askHandler = outcome.kind === "ignored" ? memoryAskHandlers.get(msg.requestId) : undefined;
  const lineHandler = outcome.kind === "ignored" ? usedLineHandlers.get(msg.requestId) : undefined;

  // 回答下方那行的请求被判作过期：不会再有结果，那一条恢复可点。
  if (lineHandler) {
    usedLineHandlers.delete(msg.requestId);
    lineHandler({ ok: false, error: "这条记忆刚在别处改过，请再试一次" });
  }

  // 询问卡片的请求结果被判作过期或不属于它：不会再有结果，卡片恢复可点。
  if (askHandler) {
    memoryAskHandlers.delete(msg.requestId);
    askHandler({ kind: "ignored" });
  }

  // 本面板没发过的结果（比如别处的写入）只带版本号：不同就重读。
  if (outcome.kind === "ignored" && outcome.reason === "unknown-request" && msg.ok) refreshMemoryIfStale(msg.rev);
}

/** 面板开着时，记忆被别处写入（如智能体刚保存）→ 重读列表，避免下次修改撞「版本冲突」。关着时下次打开本来就会重读。 */
function refreshMemoryIfStale(rev: number | undefined): void {
  if (memoryDrawer.hidden || !memoryLoaded) return;

  if (memoryState.noteRev(rev, memoryEditorBusy())) requestMemoryList();
}

/** 正在编辑、确认忘记或撤销：此时不重建面板里的输入框。 */
const memoryEditorBusy = (): boolean => !!(memoryEdit || memoryForget || memoryRestore);

const inputContext = (): VoiceInputContext => {
  const context: VoiceInputContext = { attachments: attachments?.getAttachments() ?? [] };

  if (pendingAsk) {
    context.context = { tabId: pendingAsk.tabId, title: pendingAsk.title, url: pendingAsk.url, ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}) };
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

// ＋ 菜单里的「边注」：打开菜单时勾上当前模式，点一项就切换并收起菜单。
attachBtn.addEventListener('click', () => {
  const mode = document.querySelector<HTMLSelectElement>('#marginalia-mode')!.value;

  for (const item of attachMenu.querySelectorAll<HTMLElement>('[data-marginalia]')) item.setAttribute('aria-checked', String(item.dataset.marginalia === mode));
});

attachMenu.addEventListener('click', (event) => {
  const item = (event.target as Element).closest<HTMLElement>('[data-marginalia]');

  if (!item) return;
  const select = document.querySelector<HTMLSelectElement>('#marginalia-mode')!;
  select.value = item.dataset.marginalia!;
  select.dispatchEvent(new Event('change'));
  attachments.closeMenu();
});

document.querySelector('#voice-diagnostics-open')?.addEventListener('click', () => {
  attachments.closeMenu();

  if (!diagnosticRecord) return;
  diagnosticRecord.hidden = !diagnosticRecord.hidden;
  const details = diagnosticRecord.querySelector<HTMLDetailsElement>('details');

  if (details) details.open = !diagnosticRecord.hidden;
});

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);

  if (!msg) return;

  if (msg.type === "voice") { voiceUI.receive(msg);

 return; }

  if (msg.type === "memory_result") {
    handleMemoryResult(msg);

    return;
  }

  if (msg.type === "task_history_result") {
    const lineHandler = usedLineHandlers.get(msg.requestId);

    if (lineHandler) {
      usedLineHandlers.delete(msg.requestId);
      lineHandler(msg.ok ? { ok: true } : { ok: false, error: msg.error ?? "请重试" });

      if (msg.ok && !memoryDrawer.hidden) requestPastTasks();

      return;
    }

    if (!receiveOpenThreadsTasks(msg)) handlePastTasksResult(msg);

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
      noteModelInfo(msg.model, msg.models);
      break;
    case "model_info":
      modelPicker.update(msg.model, msg.models);
      noteModelInfo(msg.model, msg.models);
      break;
    case "model_key_test_result":
      keyTests.get(msg.requestId)?.(msg);
      keyTests.delete(msg.requestId);
      break;
    case "hello_error":
      addMsg("msg error", msg.error);
      setStatus("off", "未连接");
      break;
    case "status":
      setSessionState(msg.sessionId ?? LEAD_SESSION_ID, msg.state);

      // 模型开始前后台要先读页（大页面几秒）：一报「运行中」就出过程行，agent_start 沿用这一行。
      // 不排除补放历史：新会话第一轮正是经补放到达的。
      if (msg.state === "running" && (msg.sessionId ?? LEAD_SESSION_ID) === LEAD_SESSION_ID && awaitingFirstStep()) ensureRun();
      break;
    case "task_view":
      // T05 接续入口：投影摘要 + 恢复按钮；checkpoint 损坏由会话摘要明确指出。
      resumeEntry.apply(msg.view, { checkpointUnavailable: conversations.get(selectedConversationId)?.checkpoint === "unavailable" });

      if (msg.view.conversationId === selectedConversationId) renderStreamTaskCard(msg.view);
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
    refreshOpenThreads();

    return;
  }

  if (envelope.kind === "server") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId
      && !envelope.msg.type.startsWith("conversation_") && envelope.msg.type !== "memory_result" && envelope.msg.type !== "task_history_result"
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

  if (envelope.kind === "synced") {
    // 同步回放总以 synced 收尾（background syncPanel）：此时历史已补齐，可以判断旧端口上的消息是否丢了。
    restoreLostSend();

    return;
  }

  if (envelope.kind === "page_section" || envelope.kind === "marginalia") {
    marginalia.receive(envelope);

    return;
  }

  if (envelope.kind === "ask_selection") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    applyPendingAsk(envelope.ask);

    return;
  }

  if (envelope.kind === "turn_context") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    const bubble = userBubbles.get(envelope.seq);

    if (bubble) renderTurnContext(bubble, envelope.context);

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
    // 换端口期间排队的消息：新端口已连上活的 service worker，补发。
    flushQueuedSends();
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
    voiceUI.reconnected();
    // 面板重开或重连：补取当前只读视图，摘要不靠旧缓存。
    queryTaskView();
    marginalia.refresh();

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
  replayingHistory = restoring;
  const fresh: PanelHistoryEntry[] = [];
  applyingHistory = true;

  try {
    for (const entry of entries) {
      if (entry.seq <= lastHistorySeq) continue;
      fresh.push(entry);
      historyOccurredAt = entry.occurredAt;

      if (entry.item.kind === "user") {
        if (!running) runStartAt = eventTime();
        else if (!entry.item.undelivered) steerRibbon.noteSteer(entry.item.text);
        confirmSentText(entry.item.text);
        const bubble = addUserMsg(entry.item.text, entry.item.attachments);
        bubble.dataset.seq = String(entry.seq);
        userBubbles.set(entry.seq, bubble);

        if (entry.item.context) renderTurnContext(bubble, entry.item.context);

        if (entry.item.undelivered) handleDeliveryReceipt(entry.seq, false, entry.item.undelivered.original);
      }
      else handleServerMessage(JSON.stringify(entry.item.msg));
      lastHistorySeq = entry.seq;
    }
  } finally {
    applyingHistory = false;
    replayingHistory = false;
    historyOccurredAt = undefined;
  }

  // 实时增量与历史都走此入口。批次处理完后，只恢复仍在运行的主球；
  // 完成块已由 finishRun 收束，不会在回放时重新转动。
  if (currentRun && !restoring) syncRunOrb(currentRun);
  historyPrimed = true;
  updateStarterVisibility();
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

  for (const queued of queuedSends.splice(0)) {
    port.postMessage(queued);

    if (unconfirmedSend?.postedOn === "queued" && queued.kind === "client" && queued.msg.type === "task_action" && queued.msg.request.text === unconfirmedSend.text) unconfirmedSend.postedOn = port;
  }
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
  removeDraftAttachment: (id) => attachments.removeItem(id),
  removeDraftSelection: clearPendingAsk,
  currentConversationId: () => selectedConversationId,
  // 重试走真实控制入口：与接管/停止按钮同一条路径，不新增权限。
  onRetryControl: (action) => {
    if (action === "stop") stopCurrentTask();
    else requestTakeover();
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
  askCiteEl.classList.toggle("feed-token", !!ask.element);
  askCiteText.textContent = ask.element && ask.element.kind !== "selection" ? `${ask.element.kind === "table" ? "📊" : ask.element.kind === "code" ? "⌘" : "▣"} ${ask.element.title}` : ask.text || ask.title;
  askCiteText.title = ask.text;
  askCiteEl.hidden = false;
  inputEl.focus({ preventScroll: true });
  saveDraft();
  syncTaskBarDraft();
}

function clearPendingAsk(): void {
  pendingAsk = null;
  askCiteEl?.classList.remove("feed-token");

  if (askCiteEl) askCiteEl.hidden = true;

  if (askCiteText) askCiteText.textContent = "";
  void chrome.storage?.session?.remove(ASK_STORE);
  saveDraft();
  syncTaskBarDraft();
}

askCiteClose?.addEventListener("click", () => clearPendingAsk());

/** 断线发送失败提示：同一会话连续失败只提示一次，成功发送后复位。 */
let sendFailNotifiedFor: string | null = null;

function noticeSendFailed(): void {
  if (sendFailNotifiedFor === selectedConversationId) return;
  sendFailNotifiedFor = selectedConversationId;
  addMsg("msg notice", "这条没有发出去：与后台的连接断了。正文和引用都还在，恢复连接后重新发送即可。");
}

/**
 * 已交出端口、还没在历史里见到的那一条。service worker 恰好在收到前停掉时，消息随旧端口消失，
 * background 没有记下它；换端口重新同步后历史里仍没有，就把正文、引用和附件放回输入框并提示没发出去。
 * 还排在面板队列里的消息会在新端口上补发，不算丢失。
 */
let unconfirmedSend: { text: string; ask: PendingAsk | null; attachments: ReturnType<typeof attachments.getAttachments>; conversationId: string; postedOn: chrome.runtime.Port | "queued" } | null = null;

function confirmSentText(text: string): void {
  if (unconfirmedSend && unconfirmedSend.text === text) unconfirmedSend = null;
}

/** 换端口后的同步回放已结束：旧端口上交出的消息若仍未出现在历史里，就是没送到 background。 */
function restoreLostSend(): void {
  const lost = unconfirmedSend;

  if (!lost || lost.postedOn === "queued" || lost.postedOn === port || lost.conversationId !== selectedConversationId) return;
  unconfirmedSend = null;

  // 用户已经在写新内容就不覆盖，只提示。
  if (!inputEl.value.trim() && !pendingAsk) {
    inputEl.value = lost.text;

    if (lost.attachments.length > 0) attachments.restore(lost.attachments, selectedConversationId);

    if (lost.ask) applyPendingAsk(lost.ask);
    autoResize();
    saveDraft();
    syncTaskBarDraft();
  }

  sendFailNotifiedFor = null;
  noticeSendFailed();
}

/** quick：改方向快捷按钮的原话。只发这句话，不带输入框里的草稿、引用和附件，也不清掉它们。 */
function sendInput(quick?: string): void {
  if (!conversationReady) return;
  const held=panelLive(sessionRun.values(), teamView).userHasPage;

  // 语音输入或粘贴偶尔带进看不见的控制字符（如退格 \b），发出去前去掉；换行和制表保留。
  const text = Array.from(quick ?? inputEl.value).filter((ch) => {
    const code = ch.charCodeAt(0);

    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("").trim();

  const pendingAtts = quick ? [] : attachments.getAttachments();

  if (!text && pendingAtts.length === 0) return;

  // steer 归入进行中的 run，不动计时起点；新消息重开计时
  if (!running&&!held) runStartAt = Date.now();

  const context = pendingAsk && !quick
    ? {
        tabId: pendingAsk.tabId,
        title: pendingAsk.title,
        url: pendingAsk.url,
        // 只挂了来源页、没定位到段落时没有选段：只带页面。
        ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}),
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

  marginalia.showConversation();
  const citationPage = context ?? activeTabInfo;

  if (!running && !held) { currentCitationSource = citationPage ? captureCitationContext(citationPage) : null; citationRequestPending = true; }

  const queued = queuedSends.some((e) => e.kind === "client" && e.msg.type === "task_action" && e.msg.request.requestId === request.requestId);
  unconfirmedSend = { text, ask: quick ? null : pendingAsk, attachments: pendingAtts, conversationId: conversation, postedOn: queued ? "queued" : port ?? "queued" };

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

  sendFailNotifiedFor = null;

  if (quick) return;
  inputEl.value = "";
  syncSteerSend();
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

inputEl.addEventListener("input", () => { autoResize(); saveDraft(); syncTaskBarDraft(); syncSteerSend(); });

window.addEventListener("pagehide", saveDraft);

inputEl.addEventListener("keydown", (e) => {
  if (slashSkills.handleKeydown(e)) return;

  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});

function requestTakeover(): void {
  taskBar.noteControlRequested("takeover");
  port?.postMessage({ kind: "control", action: "takeover", conversationId: selectedConversationId } satisfies PanelToBg);
}

takeoverBtn.onclick = () => {
  if (takeoverBtn.dataset.mode === "handback") port?.postMessage({ kind: "control", action: "handback", conversationId: selectedConversationId } satisfies PanelToBg);
  else requestTakeover();
};


const marginalia = createMarginalia(document.querySelector<HTMLSelectElement>("#marginalia-mode")!, document.getElementById("marginalia-rail")!);

installDropzone(document.getElementById("composer")!, (source, tabId) => {
  applyPendingAsk({ text: source.text, tabId, title: source.title, url: source.url, element: source });
  const template = source.kind === "table" ? "请分析此表格，说明关键指标及其依据。" : source.kind === "code" ? "请解释这段代码，并指出值得注意的问题。" : source.kind === "selection" ? "请解释这段内容，并说明依据。" : "请总结这张卡片，并说明重要信息的依据。";
  inputEl.value = inputEl.value.trim() ? `${inputEl.value}\n${template}` : template;
  inputEl.dispatchEvent(new Event("input", { bubbles: true }));
  inputEl.focus({ preventScroll: true });
}, () => ({ ready: currentDraftReady && conversationReady, scope: selectedConversationId, revision: draftRevision }));

armBootDecisionTimeout();

connect();
