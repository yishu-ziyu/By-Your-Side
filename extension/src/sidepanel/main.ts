import { createMarginalia } from "./marginalia.js";
import { installDropzone } from "./dropzone.js";
import { attachSourceCitations, captureCitationContext, type CitationContext } from "./sonar-citations.js";
import { attachAnswerSources } from "./answer-sources.js";
import { RunOrbActivity, orbStateRuns } from "./run-orb.js";
import { mountLiveGraph, type LiveGraph } from "./branch-view.js";
import { answerSkeleton } from "./run-heartbeat.js";
import { reducedMotion } from "./branch-graph.js";
import { mountVoiceUI } from "./voice-ui.js";
import { observeForCue } from "./cue.js";
import { sendConfirmCard } from "./send-confirm-card.js";
import { mountDictation } from "./dictation.js";
import { createOrb, type OrbHandle } from "./orb.js";
/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 *
 * 渲染层依赖：marked（assistant 消息 Markdown 渲染）+ dompurify（消毒）+ lucide（图标）。
 */
import { renderMarkdownHtml } from "./markdown.js";
import { bindAnswerCards, renderAnswerHtml } from "./answer-cards.js";
import { answerSpeech } from "../../../shared/answer-cards.js";
import { linkifyPageRefs, quotedNames } from "./page-refs.js";
import { attachAnswerActions as attachCopyActions, dropShowTab, offerWorkingTab, setAnswerTime, siteGlyph } from "./answer-actions.js";
import { adoptFillUndo, fillUndoOf, fillUndoLabel, handFillUndoToCard, isFillUndoPending, noteFillUndo, requestFillUndo, resetFillUndo, setFillUndoHost } from "./fill-undo.js";
import { attachShorten } from "./answer-shorten.js";
import { revealText } from "./stream-reveal.js";
import { configureOpenThreads, receiveOpenThreadsTasks, refreshOpenThreads } from "./open-threads.js";
import { mountVoiceOrb } from "../shared/orb-style.js";
import { syncColorTone } from "../shared/color-tone.js";
import { dropPendingMessage, holdPendingMessage, noteNeedsModelManual, playConnectArrival, renderReceipt } from "./receipt-view.js";
import { receiptCopy } from "./receipt-copy.js";
import type { TaskReceipt, TaskActionRequest } from "../../../shared/task-actions.js";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Hand, Check, CircleAlert, Ellipsis, SquarePen, LoaderCircle, BookOpen, SlidersHorizontal, PictureInPicture2 } from "lucide";
import { Camera, SquareDashedMousePointer, ImagePlus } from "lucide";
import { ChevronDown, ChevronRight, ArrowDown, Globe, PenLine, MousePointerClick, List, Brain, FileText, TextQuote, Keyboard, SquareTerminal, Workflow, Eye, ListChecks, Highlighter, ArrowLeftRight, X as XIcon, Languages, Download, Users, Bookmark, Wrench, Search } from "lucide";
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
  openedPageTitle,
  shortAction,
  splitAction,
  isPrepTool,
  actionKind,
  pastAction,
  HELD_TEXT,
  type ActionKind,
  isLiveViewportPinned,
  liveViewportOverflows,
} from "./steps.js";
import { LEAD_COLOR, displayColor, displayNameFor } from "../../../shared/cast.js";
import { ArtifactCards } from "./artifact-card.js";
import { mountErrorCards, type KeyTestResult } from "./error-card.js";
import { describeModelError, plainToolError } from "../../../shared/user-facing.js";
import { INPROC_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_VOICE_MODEL_KEY } from "../inproc/shared.js";
import { mountModelMenu } from "./model-menu.js";
import { chipLabel } from "./models.js";
import { mountReadingSettings } from "./reading-settings.js";
import { D_STATE, D_TAP } from "../shared/motion-tokens.js";
import { AttachmentsManager } from "./attachments.js";
import { currentCircleSet, revealCircle } from "./circle-select.js";
import { LEAD_SESSION_ID, isLeadSession, isPageInteractionMessage, parseServerMessage } from "../../../shared/protocol.js";
import { checkNoteForUser, evidenceLine, mergeEvidence, nextWorkingTab, readbackKey } from "./claim-hold.js";
import type { AgentRunState, AgentUiEvent, Attachment, FieldReadback, ClientMessage, ConversationSummary, HeldReason, ModelOption, PageContext, ServerMessage, TeamView } from "../../../shared/protocol.js";
import { DEFAULT_STEP_VOICE, isStepVoice, parseVoicePersona, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, type UserDelivery, type VoiceInputContext } from "../../../shared/voice.js";
import { MEMORY_KIND_LABEL, MEMORY_TEXT_MAX, normalizeMemoryHostname, type MemoryEntry, type MemoryScope } from "../../../shared/memory.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import { isWriteTool, memberBoundPageLabel, memberStatusLabel, panelLive, shouldFinishRunOnDisconnect, shouldShowTeamCard, teamSummaryLabel } from "../../../shared/control.js";
import { conversationBackgroundLabel, conversationDayGroup, conversationOutcome, conversationRelativeTime, resultCardCopy } from "./selectors.js";
import { TaskBar, stateHeadline } from "./task-bar.js";
import type { TaskView } from "../../../shared/task-view.js";
import { plainStep } from "../../../shared/user-facing.js";
import { ResumeEntry } from "./resume-entry.js";
import { DeliveryPresentationTiming, deliveryPresentation } from "./delivery-facts-view.js";
import { PANEL_PORT_NAME, parseDeliveryReceipt, type BgToPanel, type DeliveryReceipt, type FillUndoView, type PanelHistoryEntry, type PanelToBg, type UserTurnContext } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";
import { NUDGE_DRAFT_KEY } from "../shared/nudge.js";
import { installProactiveCard } from "./proactive-card.js";
import { acceptTeamStatus, emptyTeamRun, isRunId, observeRunStarted, type TeamRunState } from "../shared/team-run.js";
import { memoryScopeLabel, type MemoryApplyResult } from "./memory.js";
import { createAskCard, stepAsk, type AskInput, type MemoryAskCard, type MemoryAskEvent } from "./memory-ask.js";
import { mountMemoryDrawer, type MemoryInspection } from "./memory-drawer.js";
import { createGhostBar } from "./ghost-bar.js";
import { installChromeQuiet } from "./chrome-quiet.js";
import { createSteerRibbon } from "./in-flight-steer.js";
import { mountSlashSkills } from "./slash-skills.js";
import { mountTabMentions, type MentionedTab } from "./tab-mentions.js";
import { mountTaskPlan, paintPlanReceipt, siteName } from "./task-plan.js";
import { mountAnswerCommand } from "./answer-command.js";
import { mountChapters } from "./chapters.js";
import { activeTargetTab, isFloat, isPopout, popoutConversation, targetWindowId } from "./target-window.js";
import { FLOAT_CARD_DEFAULT_RECT, FLOAT_CARD_KEY, readFloatCard } from "../shared/float-card.js";
import { bindMotionIcon } from "./motion-icon.js";
import { mountDottedGlow } from "./dotted-glow.js";

syncColorTone();

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

/** 最近一次带圈发出的问题：回答里的 ①② 指向这一组圈（YIS-90）。换了对话就不认。 */
let circleRefs: { conversationId: string; target: { tabId: number; set: number }; max: number } | null = null;

/** 回答里的 ①②…（不超过这次圈的个数）换成按钮：点一下页面滚回那一圈再指一下；那一圈不在了写「原处已变化」。 */
function linkifyCircleRefs(answer: HTMLElement): void {
  const refs = circleRefs;

  if (!refs || refs.conversationId !== selectedConversationId || answer.querySelector(".circle-ref")) return;
  const walker = document.createTreeWalker(answer, NodeFilter.SHOW_TEXT, { acceptNode: node => (node.parentElement?.closest("pre,code,button,a") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
  const nodes: Text[] = [];

  for (let node = walker.nextNode(); node; node = walker.nextNode()) if (node instanceof Text && /[①-⑨]/.test(node.data)) nodes.push(node);

  for (const node of nodes) {
    const parts = node.data.split(/([①-⑨])/);
    const fragment = document.createDocumentFragment();

    for (const part of parts) {
      const n = part.length === 1 ? "①②③④⑤⑥⑦⑧⑨".indexOf(part) + 1 : 0;

      if (n < 1 || n > refs.max) { if (part) fragment.append(part);

 continue; }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "circle-ref";
      button.dataset.ref = String(n);
      button.textContent = String(n);
      button.title = `回到页面上的第 ${n} 圈`;
      button.onclick = () => void revealCircle(refs.target, n).then((ok) => {
        if (ok || button.nextElementSibling?.classList.contains("circle-ref-gone")) return;
        const gone = document.createElement("span");
        gone.className = "circle-ref-gone";
        gone.textContent = "原处已变化";
        button.after(gone);
        setTimeout(() => gone.remove(), 2400);
      });
      fragment.append(button);
    }

    node.replaceWith(fragment);
  }
}

/** 等后台回话的请求：页面引用的查询和指认。 */
const pageRefWaits = new Map<string, (value: string[] | boolean) => void>();

function askPageRefs<T extends string[] | boolean>(message: PanelToBg & { id: string }): Promise<T> {
  return new Promise<T>((done) => {
    const timer = setTimeout(() => { pageRefWaits.delete(message.id); done((message.kind === "page_refs_check" ? [] : false) as T); }, 8_000);
    pageRefWaits.set(message.id, (value) => { clearTimeout(timer); done(value as T); });

    if (!port) { pageRefWaits.get(message.id)?.(message.kind === "page_refs_check" ? [] : false); pageRefWaits.delete(message.id); return; }
    port.postMessage(message);
  });
}

/** 回答里「」括起的控件：读页时拿到过位置、现在还在页上的，加虚线，点了在页面上圈出。 */
async function markPageRefs(answer: HTMLElement): Promise<void> {
  // 没有「」/粗体/引号也要问：后台会把助手圈过的控件报回来。
  const names = quotedNames(answer);
  const found = await askPageRefs<string[]>({ kind: "page_refs_check", id: crypto.randomUUID(), names });

  if (!answer.isConnected) return;
  linkifyPageRefs(answer, found, {
    point: (name) => askPageRefs<boolean>({ kind: "page_ref_point", id: crypto.randomUUID(), name }),
    say: (text) => { sendInput(text); },
  });
}

/** delivered：这是一次正式交付（本轮的最终回答），不是过渡文字；带上它这一轮读过或打开的页面。 */
function attachAnswerActions(answer: HTMLElement, delivered?: UserDelivery): void {
  if ((currentRun ?? lastRun)?.sendDeclined) {
    // 只在这一轮最后定稿的回答里留一个入口，正文和已经整理的资料照常显示。
    for (let node: Element | null = answer; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
      node.querySelectorAll(".send-declined-card").forEach(card => card.remove());
    }
    answer.insertAdjacentHTML("beforeend", DECLINED_ANSWER);
  }
  attachCopyActions(answer);
  linkifyCircleRefs(answer);
  adoptUsedLine(answer);
  placeTaskCardAfter(answer);
  syncAnswerTime(answer);
  if (!replayingHistory && answer === fillUndoAnswer()) adoptFillUndo(answer);
  if (!replayingHistory && planCardRun) paintPlanCard();
  attachShorten(answer);
  // 文末一排是回答写完后才加的：原本跟着底部的，再贴一次底，否则这一排卡在侧栏底边，拖把手时前一小段把手不动。
  scrollToEnd();

  if (delivered && !replayingHistory) void markPageRefs(answer);
  // 补放历史时不给：那一页早已不是这次回答的结果页。
  if (delivered && !replayingHistory) void offerWorkingTab(answer, selectedConversationId, delivered.sources ?? delivered.facts?.sources ?? []);
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

const PLACEHOLDER_USER = "补充要求，按 Enter 保存。点「交还」后生效";

const PLACEHOLDER_DRAINING = "正在接管，助手不再做新的操作。";

const PLACEHOLDER_PARTIAL = "部分页面已交还。其余页面仍归你。";


// 渲染出的链接一律新开标签页
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** 正文在 renderMarkdownHtml 里已按回答的规则消毒；整段（含我们画的卡片、代码块的条）再过一遍，挡住能改到回答外面的东西。 */
const PANEL_HTML = { FORBID_TAGS: ["style", "link", "meta", "base", "form", "iframe", "object", "embed", "foreignObject", "dialog"], FORBID_ATTR: ["style"] };

/** 拒绝发送后仍能再次提出发送请求；这个入口附在回答后面，保留已经交付的资料。 */
const DECLINED_ANSWER = '<div class="gen-card send-declined-card"><div class="gc-actions"><button type="button" class="gc-btn primary" data-card-say="现在发送吧">现在发送吧</button></div></div>';

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(renderAnswerHtml(text, renderMarkdownHtml), PANEL_HTML);
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
      <button id="popout-open" type="button"><span>浮在页面上</span></button>
      <button id="model-settings-open" type="button"><span>模型与语音</span></button>
      <button id="reading-settings-btn" type="button"><span>字体字号</span></button>
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
    <label id="memory-search-field" class="memory-search-field">
      <span id="memory-search-icon" aria-hidden="true"></span>
      <input id="memory-search" type="search" placeholder="搜索记忆和过往任务" aria-label="搜索记忆和过往任务" autocomplete="off">
    </label>
    <div id="knowledge-body">
      <div id="memory-body"></div>
    </div>
  </section>
  <div id="marginalia-rail" aria-label="段落提示" hidden></div>
  <div id="messages-frame">
    <div id="messages">
      <div id="resume-entry-root"></div>
    </div>
    <div class="scroll-fade" data-edge="top" aria-hidden="true"></div>
    <div class="scroll-fade" data-edge="bottom" aria-hidden="true"></div>
  </div>
  <div id="team-card" hidden></div>
  <section id="starter" aria-label="开始方式">
    <canvas id="starter-glow" aria-hidden="true"></canvas>
    <p id="starter-brand"></p>
    <canvas id="starter-orb" aria-hidden="true"></canvas>
    <p id="starter-title">说说你想完成什么</p>
    <p id="starter-sub"></p>
    <button type="button" id="starter-connect">连接模型</button>
  </section>
  <div class="composer-dock-wrap">
    <div id="morph-sheet" class="page-morph-sheet" hidden>
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
      <div class="action-menu-item pressable" id="menu-action-screenshot" title="只截当前网页中可见的部分。">
        <span class="action-menu-item-icon" data-icon="camera"></span>
        <span class="action-menu-item-label">页面截图</span>
      </div>
      <div class="action-menu-item pressable" id="menu-action-region" title="在网页上圈出想问的地方，可以圈好几处（Esc 退出）">
        <span class="action-menu-item-icon" data-icon="region"></span>
        <span class="action-menu-item-label">圈出来问 <span class="action-menu-item-key" id="region-key">⌘⇧S</span></span>
      </div>
      <div class="action-menu-item pressable" id="menu-action-upload">
        <span class="action-menu-item-icon" data-icon="upload"></span>
        <span class="action-menu-item-label">添加电脑里的图片</span>
      </div>
      <hr />
      <p class="composer-menu-label" title="显示当前段落的原文或解释。">段落提示</p>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="off">关闭</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="source">原文摘录</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" data-marginalia="ai">解释段落<span>让助手解释正在读的段落。这会把段落发给模型</span></button>
      <hr />
      <button id="voice-diagnostics-open" class="action-menu-radio" type="button">语音诊断</button>
    </div>
    <input type="file" id="file-input" accept="image/*" multiple hidden />
    <select id="marginalia-mode" aria-label="段落提示模式" hidden><option value="off">关闭</option><option value="source">原文摘录</option><option value="ai">解释段落 · 会发给模型</option></select>
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
      <p id="handoff-banner" hidden role="status"></p>
      <div id="mention-strip" class="mention-strip" hidden></div>
      <textarea id="input" rows="1" placeholder="${PLACEHOLDER_IDLE}"></textarea>
      <div id="composer-bar">
        <div id="composer-bar-inner">
          <button id="attach-btn" class="composer-icon-btn" type="button" title="添加附件或截图" aria-haspopup="true">+</button>
          <span id="composer-spacer"></span>
        </div>
        <button id="takeover-btn" type="button" title="接管：助手暂停，由你操作页面。操作完，点「交还」。" hidden>接管</button>
        <button id="steer-send-btn" type="button" title="发出插话（Enter）" aria-label="发出插话" hidden></button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span>
          <span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
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

// 跳到某一章就是往上翻：不再跟随到底部。
const chapters = mountChapters(messagesEl, document.getElementById("messages-frame")!, () => { pinned = false; }, () => replayingHistory);

const composerEl = document.getElementById("composer") as HTMLElement;

const inputEl = document.getElementById("input") as HTMLTextAreaElement;

const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;

sendBtn.disabled = true;

// 「圈出来问」的按键由侧栏自己处理（attachments.ts），不是 Chrome 快捷键：按系统写法显示（#236）。
document.getElementById("region-key")!.textContent = /Mac/i.test(navigator.platform) ? "⌘⇧S" : "Ctrl+Shift+S";

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

const tabMentions = mountTabMentions({
  composerEl,
  inputEl,
  stripEl: document.getElementById("mention-strip")!,
  onChange: () => saveDraft(),
});

let pendingContinueDraft: string | null = null;

const taskPlan = mountTaskPlan({ root: document.getElementById("task-bar-root")! });

const answerCommand = mountAnswerCommand({
  inputEl,
  latestAnswer: () => document.querySelector<HTMLElement>(".msg.assistant.answer-latest"),
  saveSkill: (text) => slashSkills.saveFromText(text),
  continueInNew: (text) => {
    pendingContinueDraft = `接着刚才：${text}`;
    document.getElementById("conversation-new")?.click();
  },
});

document.addEventListener("answer-command", (event) => {
  const answer = (event.target as HTMLElement | null)?.closest<HTMLElement>(".msg.assistant");
  answerCommand.open(answer);
});

const takeoverBtn = document.getElementById("takeover-btn") as HTMLButtonElement;


// 附件瓷贴与动作菜单 DOM
const attachmentsStrip = document.getElementById("attachments-strip") as HTMLElement;

const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement;

const attachMenu = document.getElementById("attach-menu") as HTMLElement;

// 点工具行的空白处就是要打字：按下时把焦点给输入框，不让它先失焦。
document.getElementById("composer-bar")!.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button")) return;
  event.preventDefault();
  inputEl.focus();
});

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
let dictationUI: ReturnType<typeof mountDictation> | undefined;

/** 这个侧栏页面自己看着的会话：刷新后回到它，不跟别的侧栏页面走。关掉侧栏再开是新页面，跟最近操作的那个侧栏。 */
const PANEL_CONVERSATION_KEY = "sideagent-panel-conversation";

// 单独窗口第一次打开时显示地址里的会话；之后刷新回到它自己最后看的那个。地址里的会话已经删了，开机时按「记着的会话不在了」新建一个。
// 浮动卡片每换一次标签页就重挂一次，地址里的会话总是最新的，同一标签页里上次留下的不算。
if (popoutConversation) {
  try { if (isFloat || !sessionStorage.getItem(PANEL_CONVERSATION_KEY)) sessionStorage.setItem(PANEL_CONVERSATION_KEY, popoutConversation); } catch { /* 记不住就跟最近操作的侧栏 */ }
}

let conversationReady = false;

let transportConnected = false;

const completedConversations = new Set<string>();

let conversationRequest: string | null = null;

/** 点「新会话」那一刻输入框里的字；会话建好前多打的字归新会话。 */
let draftAtNewRequest: string | null = null;
/** 新会话建好前按了发送：这条属于新会话，建好后再发。 */
let sendAfterCreate = false;

/**
 * 面板打开时恢复上次会话；上次的事已经做完、又放了一阵子，就直接进新会话，让人从起点开始。
 * 还在跑、等用户、中途被打断的会话总是回到原处，免得找不到进度；刷新与重连也不换会话。
 */
let bootFreshSession = true;

let bootInheritedId: string | null = null;

let bootDecisionTimer: ReturnType<typeof setTimeout> | null = null;

let bootCreateTimer: ReturnType<typeof setTimeout> | null = null;

/** 会话清单迟迟不到时的兜底时限；新建请求迟迟没有回执时的回退时限。 */
const BOOT_DECISION_TIMEOUT_MS = 6_000;

const BOOT_IDLE_NEW_SESSION_MS = 30 * 60_000;

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
    const timer = setTimeout(() => { receiptForks.delete(creationId); reject(new Error('新会话可能没有建好，原来的消息没有发出。打开会话列表看一下。')); }, 15000);
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

type ConversationDraft = { text: string; attachments: Attachment[]; ask: PendingAsk | null; pages?: MentionedTab[] };

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
  const draft: ConversationDraft = { text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk, pages: tabMentions.items() };
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
    tabMentions.restore(Array.isArray(draft?.pages) ? draft.pages : []);
    pendingAsk = draft?.ask ?? null;

    if (pendingAsk) applyPendingAsk(pendingAsk);
    else if (askCiteEl) askCiteEl.hidden = true;
    autoResize();
    draftFingerprints.set(id, JSON.stringify({ text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk, pages: tabMentions.items() }));
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

/** 侧栏开着时的主动卡（YIS-106）：画在对话流最新处；点句子把这件事放进输入框，不发送。 */
const proactiveCard = installProactiveCard({
  mount: node => { appendToMessages(node); scrollToEnd(); },
  selected: () => selectedConversationId,
  ready: starterReady,
  memory: text => {
    memorySearch.value = text;
    memoryDrawerCtrl.setSearchQuery(text);
    openMemoryDrawer();
  },
  ask: text => {
    inputEl.value = inputEl.value.trim() ? `${inputEl.value.trimEnd()}\n${text}` : text;
    inputEl.dispatchEvent(new Event("input"));
    inputEl.focus();
    inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
  },
});

function updateStarterVisibility(): void {
  app.classList.toggle("starter-ready", starterReady());
  void takeNudgeDraft();
  void proactiveCard.refresh();
  refreshOpenThreads();
}

/** 有没有连模型：null 表示还没收到 hello_ok。只在确知没连时，起点引导换成「先连接模型」（#233）。 */
let modelConnected: boolean | null = null;

function paintStarterModelState(): void {
  const none = modelConnected === false;
  app.classList.toggle("no-model", none);
  document.getElementById("starter-title")!.textContent = none ? "先连接模型" : "说说你想完成什么";
  document.getElementById("starter-sub")!.textContent = none ? "连接以后，助手就能读这个页面、整理信息、在页面上操作。" : "";
}

document.getElementById("starter-connect")!.onclick = () => void chrome.runtime.openOptionsPage();

/**
 * 没连模型时发出的话（#233）：卡片承诺「连好以后，这句话会自动发出」。只存在内存里，按会话分开；
 * 用户自己再发任何话就作废。resending 是已交出、还没在历史里见到的那一次重发：它的历史不再画第二个用户气泡。
 */
/** 用户最近一次自己发话的时刻：连好后的自动重发在动画期间被它抢先时，旧那句不再补发。 */
let userSentAt = 0;
const resendAfterConnect = new Map<string, { text: string; page: Promise<PageContext | undefined>; card: HTMLElement; bubble: HTMLElement | null }>();

/** 这个面板最近交出的一条话问的是哪一页；没连模型的回执按 requestId 认领它。 */
let lastSentPage: { requestId: string; page: Promise<PageContext | undefined> } | null = null;

let resending: { conversationId: string; text: string; bubble: HTMLElement | null } | null = null;

/**
 * 用户存过主模型。宿主列模型失败时 hello_ok 也会是空目录：存过就不当成「没连」（#244 审阅）。
 * 只用来否决「没连」，不触发重发：刚存好时宿主可能还没就绪，重发要等它带着模型回 hello_ok。
 */
let modelSaved: boolean | null = null;

/** 宿主上一次报的有没有模型：自动重发只看它从没有变成有。 */
let hostReportedModel: boolean | null = null;

void chrome.storage.local.get(INPROC_CONFIG_KEY).then((stored) => {
  modelSaved = !!stored[INPROC_CONFIG_KEY];

  if (modelSaved && modelConnected === false) { modelConnected = true; paintStarterModelState(); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && INPROC_CONFIG_KEY in changes) modelSaved = !!changes[INPROC_CONFIG_KEY]!.newValue;
});

/** hello_ok / model_info 告诉侧栏有没有模型。目录（models）比 model 可靠：别的会话回放的 hello_ok 可能不带 model。 */
function noteModelPresence(model: string | undefined, models: ModelOption[] | undefined): void {
  const was = hostReportedModel;
  hostReportedModel = !!model || !!models?.length;
  modelConnected = hostReportedModel || modelSaved === true;
  paintStarterModelState();

  if (bootFreshSession && !modelConnected && bootInheritedId !== null) resolveBootSession(bootInheritedId, conversations.size > 0);

  if (was !== false || !hostReportedModel) return;
  const pending = resendAfterConnect.get(selectedConversationId);
  resendAfterConnect.clear();

  // 卡片已不在当前会话的消息里（换过会话或重开过）：不替用户发。
  if (!pending || !pending.card.isConnected) return;
  const conversationId = selectedConversationId;

  void pending.page.then(async (page) => {
    if (conversationId !== selectedConversationId || !pending.card.isConnected) return;
    resending = { conversationId, text: pending.text, bubble: pending.bubble };
    const startedAt = performance.now();
    await playConnectArrival(pending.card, currentModelId ? chipLabel(currentModelId, knownModels) : null, pending.bubble);

    if (conversationId !== selectedConversationId) {
      resending = null;

      return;
    }

    // 动画播完才真发；动画期间用户自己发了新话，或者发不出：卡片改写成「这句没有发出」，不让它看起来已经发了，也不排到新话后面。
    if (userSentAt > startedAt || !sendInput(pending.text, page)) {
      resending = null;
      dropPendingMessage(pending.card, pending.bubble);
    }
  });
}

function lastUserBubble(): HTMLElement | null {
  const bubbles = messagesEl.querySelectorAll<HTMLElement>(".msg.user");

  return bubbles[bubbles.length - 1] ?? null;
}

function lastUserBubbleFor(text: string): HTMLElement | null {
  const bubbles = messagesEl.querySelectorAll<HTMLElement>(".msg.user");

  for (let i = bubbles.length - 1; i >= 0; i -= 1) {
    const bubble = bubbles[i]!;
    const body = bubble.querySelector(".user-msg-text")?.textContent ?? bubble.textContent ?? "";

    if (body.trim() === text.trim()) return bubble;
  }

  return lastUserBubble();
}

/** 会话里还没有任何回合：续做卡挂载点常驻在 #messages 里，它没内容时不算。 */
function conversationEmpty(): boolean {
  return !Array.from(messagesEl.children).some((child) => child.id !== "resume-entry-root" || child.childElementCount > 0);
}

new MutationObserver(() => app.classList.toggle("conversation-empty", conversationEmpty())).observe(messagesEl, { childList: true, subtree: true });

app.classList.toggle("conversation-empty", conversationEmpty());

function upsertConversation(c: ConversationSummary): void {
  if (conversations.get(c.id)?.state === "running" && c.state === "idle" && !c.checkpoint && c.id !== selectedConversationId) completedConversations.add(c.id);

  if (c.checkpoint) completedConversations.delete(c.id);
  conversations.set(c.id, c);

  if (c.id === selectedConversationId) noteRunStarted(c.runId);
}

let conversationFilter = "";
/** 筛选框只建一次：每次重画都换一个新框，中文输入法打到一半会断。 */
let conversationFilterEl: HTMLInputElement | null = null;
let conversationRowsSig = "";

const conversationOutcomeWas = new Map<string, string>();

function latestTaskFor(id: string): TaskHistoryEntry | undefined {
  let latest: TaskHistoryEntry | undefined;

  for (const task of memoryDrawerCtrl.getPastTasks()) {
    if (task.conversationId !== id) continue;
    if (!latest || task.endedAt > latest.endedAt) latest = task;
  }

  return latest;
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
  const now = Date.now();
  const list = [...conversations.values()].sort((a, b) => {
    const waitA = conversationOutcome(a, { completed: completedConversations.has(a.id), task: latestTaskFor(a.id) }).kind === "waiting";
    const waitB = conversationOutcome(b, { completed: completedConversations.has(b.id), task: latestTaskFor(b.id) }).kind === "waiting";
    if (waitA !== waitB) return waitA ? -1 : 1;

    return b.updatedAt - a.updatedAt;
  });
  const query = conversationFilter.trim().toLowerCase();
  const shown = list.filter((c) => {
    if (!query) return true;
    const outcome = conversationOutcome(c, { completed: completedConversations.has(c.id), task: latestTaskFor(c.id) });

    return (c.title || "新会话").toLowerCase().includes(query) || outcome.line.toLowerCase().includes(query) || (c.site ?? "").toLowerCase().includes(query);
  });
  if (!conversationFilterEl) {
    const el = document.createElement("input");
    el.type = "search";
    el.className = "conversation-menu-filter";
    el.placeholder = "筛选会话";
    el.setAttribute("aria-label", "筛选会话");
    el.oninput = () => { conversationFilter = el.value; renderConversations(); };
    // 回车选中筛出来的第一条。
    el.onkeydown = (e) => {
      if (e.key !== "Enter" || e.isComposing) return;
      e.preventDefault();
      conversationMenu.querySelector<HTMLButtonElement>("button[data-conversation-id]")?.click();
    };
    conversationFilterEl = el;
  }
  const filter = conversationFilterEl;
  if (filter.value !== conversationFilter) filter.value = conversationFilter;
  const nodes: HTMLElement[] = [];
  const sig: string[] = [];
  let lastGroup = "";

  for (const c of shown) {
    const outcome = conversationOutcome(c, { completed: completedConversations.has(c.id), task: latestTaskFor(c.id) });
    const group = outcome.kind === "waiting" ? "等你" : conversationDayGroup(c.updatedAt, now);

    if (group !== lastGroup) {
      lastGroup = group;
      const head = document.createElement("div");
      head.className = "conversation-menu-group";
      head.textContent = group;
      nodes.push(head);
      sig.push(group);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitemradio");
    button.setAttribute("aria-checked", String(c.id === selectedConversationId));
    button.dataset.conversationId = c.id;
    button.dataset.outcome = outcome.kind;
    button.title = c.title || "新会话";
    const mark = document.createElement("span");
    mark.className = "conversation-menu-mark";
    mark.dataset.kind = outcome.kind;
    mark.textContent = outcome.icon;
    if (outcome.kind === "waiting") {
      const dot = document.createElement("i");
      dot.className = "conversation-menu-wait-dot";
      mark.append(dot);
    }
    const info = document.createElement("div");
    info.className = "conversation-menu-info";
    const title = document.createElement("span");
    title.className = "conversation-menu-title";
    title.textContent = c.title || "新会话";
    const ending = document.createElement("small");
    ending.className = "conversation-menu-ending";
    ending.textContent = outcome.line;
    info.append(title, ending);
    const meta = document.createElement("div");
    meta.className = "conversation-menu-meta";
    if (c.site) {
      const site = document.createElement("span");
      site.className = "conversation-menu-site";
      site.textContent = c.site.charAt(0).toUpperCase();
      site.title = c.site;
      meta.append(site);
    }
    const updated = document.createElement("small");
    updated.className = "conversation-menu-updated";
    updated.textContent = conversationRelativeTime(c.updatedAt, now);
    meta.append(updated);
    button.append(mark, info, meta);
    button.onclick = () => selectConversation(c.id);
    const prev = conversationOutcomeWas.get(c.id);
    const flash = !!prev && prev !== outcome.kind && !conversationMenu.hidden;
    if (flash) button.classList.add("conversation-row-flash");
    conversationOutcomeWas.set(c.id, outcome.kind);
    nodes.push(button);
    sig.push([c.id, c.title, c.site ?? "", outcome.kind, outcome.line, updated.textContent, c.id === selectedConversationId, flash].join("\u0001"));
  }

  // 内容没变就不重画：打开列表后过往任务的结果才到，重画会换掉鼠标正按着的那一行，这次点击就丢了。
  const signature = sig.join("\u0002");

  if (filter.parentElement !== conversationMenu || signature !== conversationRowsSig) {
    conversationRowsSig = signature;
    if (filter.parentElement !== conversationMenu) conversationMenu.replaceChildren(filter);
    while (filter.nextSibling) filter.nextSibling.remove();
    conversationMenu.append(...nodes);
  }

  // 从当前会话另开出去的事已有自己的卡片，不再上顶部条。
  const elsewhere = (c: ConversationSummary) => c.id !== selectedConversationId && separateAskOrigins.get(c.id) !== selectedConversationId;
  const other = list.find((c) => elsewhere(c) && c.state === "running")
    ?? list.find((c) => elsewhere(c) && c.state === "user")
    ?? list.find((c) => elsewhere(c) && c.checkpoint === "interrupted")
    ?? list.find((c) => elsewhere(c) && completedConversations.has(c.id));

  conversationBackground.hidden = !other;

  if (other) {
    conversationBackground.textContent = `${conversationBackgroundLabel(other)}：${other.title} ↗`;
    conversationBackground.onclick = () => selectConversation(other.id);
  }
}

function resetConversationRender(): void {
  resetFillUndo();
  planCardRun = null;
  planUndo = null;
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
  clearPendingRedelivers();
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
  goalNote = null;
  goalStep = null;
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
  modelMenu.usage(null);
  renderTeamCard();
  setSessionState(LEAD_SESSION_ID, "idle");
}

function selectConversation(id: string, notify = true): void {
  const preserveInitialDraft = !conversationReady && (inputEl.value.length > 0 || attachments.getAttachments().length > 0 || pendingAsk !== null);

  if (id !== selectedConversationId) { voiceUI.stop(); dictationUI?.cancel(); }
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
    takeAutoRetryLock(id);

    try { sessionStorage.setItem(PANEL_CONVERSATION_KEY, id); } catch { /* 记不住只影响刷新后回到哪个会话 */ }
    if (isFloat) void rememberFloatConversation(id);
    sendBtn.disabled = false;

    if (preserveInitialDraft) saveDraft();
    draftRevision += 1;
    resetConversationRender();
    restoringDraft = true;
    inputEl.value = "";
    autoResize();
    pendingAsk = null;

    if (askCiteEl) askCiteEl.hidden = true;
    attachments.restore([], id);
    tabMentions.clear();
    restoringDraft = false;

    if (typed !== null) { inputEl.value = typed; syncSteerSend(); autoResize(); saveDraft(); currentDraftReady = true; updateStarterVisibility(); }
    else void restoreDraft(id).catch(() => addMsg("msg error", "未能恢复这段会话的输入草稿。"));
  }

  renderConversations();
  renderTaskStrip();
  taskBar.reset();
  taskPlan.reset();
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
  // 没连模型时宿主不建会话，空清单就是真的空：直接用后台选中的会话，不等两段兜底时限（#233）。
  const noModel = modelConnected === false;

  // 刷新前记着的会话已经不在清单里了：不能停在它上面（发什么都会被宿主拒），只能新建。
  const goneRemembered = !inherited && listKnown && inheritedId === rememberedConversation();

  if (!inherited && !listKnown && !noModel) return;

  // 侧栏自己刷新时 sessionStorage 还记着这段会话，那不是重新打开，留在原处。
  const settled = inherited !== undefined && inheritedId !== rememberedConversation() && inherited.state === "idle" && !inherited.checkpoint
    && inherited.title !== "新会话" && Date.now() - inherited.updatedAt > BOOT_IDLE_NEW_SESSION_MS;

  if ((inherited && !settled) || (noModel && !goneRemembered)) {
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
    // 后台迟迟没有回执：不把面板卡在"正在新建"，退回显示上一段。挂起的那条不发进旧会话，留在输入框。
    conversationRequest = null;
    sendAfterCreate = false;
    renderConversations();

    if (bootInheritedId) selectConversation(bootInheritedId, false);
  }, BOOT_CREATE_FALLBACK_MS);

  return true;
}

conversationSwitcher.onclick = () => {
  conversationMenu.hidden = !conversationMenu.hidden;
  conversationSwitcher.setAttribute("aria-expanded", String(!conversationMenu.hidden));
  if (conversationMenu.hidden) conversationFilter = "";
  else {
    conversationFilter = "";
    if (!memoryDrawerCtrl.isPastTasksPending()) requestPastTasks();
    renderConversations();
    conversationFilterEl?.focus();
  }
};

conversationNew.onclick = () => {
  if (!conversationReady || conversationRequest) return;
  requestNewConversation();
};

document.addEventListener("click", (e) => {
  // 打开列表时会重画标题按钮里的字，点中的那段字已不在文档里；按点击发生时的路径判断，不按现在的 DOM。
  const path = e.composedPath();
  if (!path.includes(conversationMenu) && !path.includes(conversationSwitcher)) {
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

/** 纠正后的询问：状态按 askId 留在面板内存里，切会话重绘时照原样画回；它发出的请求各自等自己的结果。 */
const memoryAskCards = new Map<string, MemoryAskCard>();

const memoryAskHandlers = new Map<string, (result: AskInput) => void>();

const memorySearch = document.getElementById("memory-search") as HTMLInputElement;

const memoryDrawerCtrl = mountMemoryDrawer({
  memoryDrawer,
  memoryShade,
  memoryOpen,
  memoryClose,
  memoryTitle,
  memoryBody,
  memorySearch,
  send: (msg) => send(msg),
  selectedConversationId: () => selectedConversationId,
  conversationTitle: (id) => conversations.get(id)?.title,
  onPastTasksRendered: () => { if (!conversationMenu.hidden) renderConversations(); },
  usedLineHandlers,
  memoryAskCards,
  memoryAskHandlers,
  stepMemoryAsk: (askId, input) => stepMemoryAsk(askId, input),
});

const {
  memoryState,
  receiptUndos,
  openMemoryDrawer,
  requestMemoryList,
  requestPastTasks,
  dispatchMemoryRequest,
  processMemoryOutcome,
  handlePastTasksResult,
} = memoryDrawerCtrl;

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

const screenshotAction = document.getElementById("menu-action-screenshot");
if (screenshotAction) bindMotionIcon(screenshotAction, "camera");

const memorySearchField = document.getElementById("memory-search-field");
const memorySearchIcon = document.getElementById("memory-search-icon");
if (memorySearchField && memorySearchIcon) {
  memorySearchIcon.append(icon(Search));
  bindMotionIcon(memorySearchField, "search");
}

/** 运行中：停止键一直在；输入框里有字时，它左边多一个发送键，发出的是插话。 */
function syncSteerSend(): void {
  // 按 id 现取：切会话可能在这段模块代码跑到之前就调用。
  const steer = document.getElementById("steer-send-btn");
  const send = document.getElementById("send-btn");
  const input = document.getElementById("input") as HTMLTextAreaElement | null;

  if (steer && send && input) steer.hidden = !send.classList.contains("stopping") || !input.value.trim();

  // 没字也没附件时发送键看起来不能点（#236）。不动 disabled：它只表示会话是否就绪。
  if (send && input) {
    const idle = !send.classList.contains("stopping") && !input.value.trim() && !attachments?.getAttachments().length;

    if (idle) send.setAttribute("aria-disabled", "true");
    else send.removeAttribute("aria-disabled");
  }
}

const readingSettingsButton = document.getElementById("reading-settings-btn")!;
readingSettingsButton.prepend(icon(BookOpen));
bindMotionIcon(readingSettingsButton, "book-open");

const modelSettingsOpen = document.getElementById("model-settings-open")!;

modelSettingsOpen.prepend(icon(SlidersHorizontal));
bindMotionIcon(modelSettingsOpen, "sliders-horizontal");

modelSettingsOpen.addEventListener("click", () => void chrome.runtime.openOptionsPage());

const popoutOpen = document.getElementById("popout-open")!;

popoutOpen.prepend(icon(PictureInPicture2));

// 浮动卡片里不再开浮动卡片；语音和说话输入这一版不放进卡片（styles.css 按 data-popout 藏起）。
if (isPopout) {
  popoutOpen.remove();
  document.documentElement.dataset.popout = "";
}

popoutOpen.addEventListener("click", () => void openFloat());

/** 用 IntersectionObserver v2 看元素此刻是否完整、原样（不透明、没变形、没被盖住）地露在屏幕上。 */
function watchFullyVisible(target: Element, onChange: (visible: boolean) => void): void {
  // SAFETY: trackVisibility / delay 和回调条目上的 isVisible 是 IntersectionObserver v2 的，DOM 类型里还没有；没有 isVisible 就当看不全。
  new IntersectionObserver(([entry]) => onChange((entry as (IntersectionObserverEntry & { isVisible?: boolean }) | undefined)?.isVisible === true),
    { trackVisibility: true, delay: 100 } as IntersectionObserverInit).observe(target);
}

// 浮动卡片挂在网页上，网页能把宿主元素调透明、挪位置、盖东西，把这里的发送、确认按钮伪装成网页内容骗人点。
// 这一页此刻没有完整、原样地露在屏幕上时，点击一律不生效。
if (isFloat) {
  let visible = false;
  watchFullyVisible(document.body, v => { visible = v; });
  // 键盘也拦：输入框已有焦点时网页再盖上假界面，用户以为在网页里按回车，实际发的是这里的消息。
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "keydown"]) {
    addEventListener(type, ev => { if (!visible) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  }
}

/** 当前会话改成浮在网页上的卡片，侧栏随即关掉；卡片跟着用户换标签页，位置和大小沿用上次的。 */
async function openFloat(): Promise<void> {
  const tab = await activeTargetTab();

  if (!tab?.url || !/^https?:/.test(tab.url)) {
    addMsg("msg notice", "这个页面放不了浮动卡片。换到一个普通网页再试。");
    return;
  }
  const stored = readFloatCard((await chrome.storage.local.get(FLOAT_CARD_KEY))[FLOAT_CARD_KEY]);

  await chrome.storage.local.set({ [FLOAT_CARD_KEY]: { open: true, collapsed: false, conversation: selectedConversationId, rect: stored?.rect ?? FLOAT_CARD_DEFAULT_RECT } });
  window.close();
}

// 别的窗口里的卡片（或侧栏点「浮在页面上」）换了会话：这张卡片也换过去，几张卡片看的总是同一个会话。
if (isFloat) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !(FLOAT_CARD_KEY in changes)) return;
    const next = readFloatCard(changes[FLOAT_CARD_KEY]!.newValue);
    if (next && conversationReady && next.conversation !== selectedConversationId) selectConversation(next.conversation);
  });
}

async function rememberFloatConversation(id: string): Promise<void> {
  const stored = readFloatCard((await chrome.storage.local.get(FLOAT_CARD_KEY))[FLOAT_CARD_KEY]);

  if (stored && stored.conversation !== id) await chrome.storage.local.set({ [FLOAT_CARD_KEY]: { ...stored, conversation: id } });
}

// 打开这个单独窗口的浏览器窗口关了：页面标牌和「按窗口找侧栏」都换到最近获得焦点的普通窗口。
if (isPopout) {
  chrome.windows.onRemoved.addListener(() => {
    void refreshActiveTabPill();
    void targetWindowId().then(windowId => {
      if (windowId != null) port?.postMessage({ kind: "panel_window", windowId } satisfies PanelToBg);
    }).catch(() => { /* 端口刚断：重连时会再报 */ });
  });
}

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
    const tab = await activeTargetTab();

    if (!tab) return;

    if (tab.id != null) {
      activeTabInfo = { id: tab.id, title: tab.title ?? "", url: tab.url ?? "" };
      ghostBar.setTab(activeTabInfo);
      marginalia.setPage(activeTabInfo);
    }

    const title = tab.title || tab.url || "未知页面";
    let host = "";

    try {
      if (tab.url) {
        const pageUrl = new URL(tab.url);
        host = pageUrl.host;
        memoryDrawerCtrl.setCurrentHostname(normalizeMemoryHostname(pageUrl.hostname) ?? "");
      }
    } catch {
      memoryDrawerCtrl.setCurrentHostname("");
    }

    const displayLabel = host ? `${host} · ${clipTitle(title, 14)}` : clipTitle(title, 20);

    if (tabTitleText) tabTitleText.textContent = displayLabel;

    if (tabIconSq) {
      if (tab.favIconUrl && tab.favIconUrl.startsWith("http")) {
        const img = document.createElement("img");
        img.src = tab.favIconUrl;
        img.alt = "";
        img.style.cssText = "width:12px;height:12px;border-radius:2px;object-fit:cover;";
        tabIconSq.replaceChildren(img);
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
  const willOpen = open !== undefined ? open : morphSheet.hidden;
  morphSheet.hidden = !willOpen;

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
    !morphSheet.hidden &&
    !morphSheet.contains(e.target as Node) &&
    !pagePill?.contains(e.target as Node)
  ) {
    toggleMorphSheet(false);
  }
});

if (typeof chrome !== "undefined" && chrome.tabs) {
  chrome.tabs.onActivated?.addListener((info) => { dropShowTab(info.tabId); void refreshActiveTabPill(); taskBar.noteTabsChanged(); });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status || changeInfo.title || changeInfo.url) {
      void refreshActiveTabPill();
      taskBar.noteTabsChanged();
    }
  });
  chrome.tabs.onRemoved?.addListener((tabId) => { dropShowTab(tabId); taskBar.noteTabsChanged(); });
}

void refreshActiveTabPill();

// 输入框左下角「模型 · 快」：一个菜单里选模型和思考强度。选模型发 set_model，等宿主回 model_info 才改显示。
const modelMenu = mountModelMenu({
  composer: document.getElementById("composer")!,
  after: document.getElementById("attach-btn")!,
  sendThinking: (model, level, restore) => { send({ type: "set_thinking", model, level, ...(restore ? {restore} : {}) }); },
  setModel: (model) => { send({ type: "set_model", model }); },
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

/**
 * 后台把同一次出错发给看着这个会话的每个侧栏，只能有一个替用户自动重试：每个会话一把锁，先拿到的侧栏负责，它关掉或切走后由下一个接手。
 * 锁按会话分：侧栏只收自己看着的会话的出错，全局一把锁会让拿着锁、却看着别的会话的侧栏把这次重试漏掉。
 * 不按窗口编号排：chrome.runtime.getContexts 给侧栏的 windowId 是 -1。
 */
const AUTO_RETRY_LOCK = "sideagent-auto-retry-owner";

let autoRetryLock: { conversationId: string; held: boolean; release: () => void } | null = null;

function takeAutoRetryLock(conversationId: string): void {
  if (autoRetryLock?.conversationId === conversationId) return;
  autoRetryLock?.release();

  if (!navigator.locks) return;
  let release = () => {};
  const done = new Promise<void>(resolve => { release = resolve; });
  const lock = { conversationId, held: false, release: () => release() };
  autoRetryLock = lock;
  // 还没拿到就切走了：拿到时 done 已经结束，锁当场放掉。
  void navigator.locks.request(`${AUTO_RETRY_LOCK}:${conversationId}`, () => { lock.held = true; return done; });
}

async function ownsAutoRetry(): Promise<boolean> {
  if (!navigator.locks) return true;

  if (autoRetryLock?.held && autoRetryLock.conversationId === selectedConversationId) return true;
  const { held = [] } = await navigator.locks.query();

  return !held.some(lock => lock.name === `${AUTO_RETRY_LOCK}:${selectedConversationId}`);
}

const errorCards = mountErrorCards({
  mount: (el) => appendToMessages(el),
  app,
  models: () => knownModels,
  currentModel: () => currentModelId,
  switchModel: (id) => new Promise((resolve, reject) => {
    if (pendingModelSwitch) clearTimeout(pendingModelSwitch.timer);
    pendingModelSwitch = { id, done: resolve, timer: setTimeout(() => { pendingModelSwitch = null; reject(new Error("切换超时")); }, 10_000) };
    send({ type: "set_model", model: id });
  }),
  retry: (key, auto) => { send({ type: "retry_after_error", ...(key ? { key } : {}), ...(auto ? { auto: true as const } : {}) }); },
  ownsAutoRetry,
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

/** 后台忙时回复可能延迟；只有持续没有消息才换端口，未发出的消息留在队列。 */
const PORT_PING_MS = 5_000;

const PORT_FRESH_MS = 1_000;

const PORT_PONG_TIMEOUT_MS = 10_000;

let lastPortMessage = 0;

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

/** 过程行行首的球，和标题一行高。 */
const ORB_BOX_STATUS = 16;

/** 球句柄按宿主元素找回：折叠、结束时要把对应那个定格。 */
const orbByHost = new WeakMap<HTMLElement, OrbHandle>();

/** 用户发消息时刻：run 计时的起点（块体懒创建，先记时间戳）。 */
let runStartAt = 0;

/** 当前 run 的"执行步骤"聚合块。 */
interface RunHost {
  /** 这一轮用户在发送确认里选了「先不发」，之后没再确认发送。 */
  sendDeclined?: boolean;
  /** 回执前的绿对勾已经出现过：只在第一次当场画。 */
  doneMarkShown?: boolean;
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
  /** 进行中标题下方的说明行（调试提示条、教学没变化）；收尾时移除。做过的步骤只在 › 里（#263）。 */
  trail: HTMLElement;
  /** 进行中的第二行小字「已做 N 步 ›」（#263）；收尾后隐藏。 */
  metaEl: HTMLElement;
  /** 核对判继续后续做的这一轮：第二行开头写核对发现了什么（「核对发现：…」），代替单独一行橙字。 */
  checkNote: string | null;
  /** 正在算的这段思考从何时开始（上一步结束，或发送时刻）；不在想时为 NaN。 */
  thinkFrom: number;
  /** 想过的每一段：记录里 ≥3 秒的单列「想了 N 秒」，末行合计全部（#263）。 */
  thinkSegments: Array<{ start: number; end: number }>;
  /** 只对这一轮有用的说明（调试提示条，#103），跟在最近几步后面，随它收起。 */
  aside: string | null;
  /** 教学这一步点了但页面没变化（橙色），跟在最近几步后面；不等了就清掉。 */
  guideHint: string | null;
  /** 填写之后从网页读回的几栏（「草稿现在是：「…」」）：进行中跟在过程行下面，回答出现后收进过程。 */
  evidence: HTMLElement | null;
  evidenceLines: Array<{ key: string; field: string; value: string }>;
  /** 这一轮的回答（finding）：回答出现且这一轮已收尾后，开场话、读回、重复回答的旁白收进过程（foldAnsweredRun）。 */
  answer: { text: string; el: HTMLElement; hostNote: boolean } | null;
  /** 目标核对到哪了：checking 核对中；continued 判继续、由下一块过程接着做；unavailable 没有结论。 */
  check: "checking" | "done" | "not_done" | "needs_user" | "continued" | "unavailable" | null;
  /** 收尾时定下的回执材料，收起回答后的过程行据此重画（做了几步 · 耗时 · 核对状态）。 */
  receipt: { head: string; total: string | null; steps: number; failed: number; ended: "completed" | "failed" | "stopped" } | null;
  /** 并行/死路/接管的分叉层：紧跟在过程块后面（不放进 details，收起时也看得见）；单步回合是空的。 */
  graph: LiveGraph;
  beatEl: HTMLElement;
  /** 回答位置的骨架：回答或卡片一接上就由样式收起淡出。 */
  skeleton: HTMLElement;
  lastToolName: string | null;
  /** 在途的每一步是不是只看页面、等页面：全是才换成扫视的形态，有一步在动手就按动手画。 */
  readingTools: Map<string, boolean>;
}

const ACTION_ICONS = {
  open: Globe, fill: PenLine, click: MousePointerClick, key: Keyboard, script: SquareTerminal, run: Workflow, look: Eye, pick: ListChecks, mark: Highlighter,
  tab: ArrowLeftRight, close: XIcon, translate: Languages, download: Download, team: Users, remember: Bookmark, other: Wrench,
  read: FileText, many: List, think: Brain,
} as const;

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
    run.titleTimer = 0;
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

/** 目标核对判「没做完」、宿主马上接着做时记下还差的事；下一轮开始时写进过程行。 */
/** 核对判继续：下一轮过程行第二行要写的那句（checkNoteForUser）。 */
let goalNote: string | null = null;
/** 核对判继续、回答没出（交付前对清单）：接着做的是第几件、一共几件。 */
let goalStep: { at: number; of: number } | null = null;

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

let inspectTimer = 0;
let inspectChip: HTMLButtonElement | null = null;

function pageTargetOf(chip: HTMLButtonElement): { target: string; tabId?: number; url?: string; caption: string } | null {
  const target = chip.dataset.pageTarget;

  if (!target) return null;
  const tabId = Number(chip.dataset.pageTab);
  const step = chip.dataset.stepIndex ?? "";
  const past = chip.dataset.past ?? chip.querySelector(".chip-label")?.textContent?.trim() ?? "点击";

  return {
    target,
    tabId: Number.isFinite(tabId) && tabId > 0 ? tabId : undefined,
    url: chip.dataset.pageUrl || undefined,
    caption: step ? `第 ${step} 步 · ${past}` : past,
  };
}

function sendInspect(chip: HTMLButtonElement | null): void {
  inspectChip = chip;
  const found = chip ? pageTargetOf(chip) : null;

  if (!found) {
    port?.postMessage({ kind: "inspect_step" } satisfies PanelToBg);

    return;
  }

  port?.postMessage({
    kind: "inspect_step",
    target: found.target,
    tabId: found.tabId,
    url: found.url,
    caption: found.caption,
  } satisfies PanelToBg);
}

function queueInspect(chip: HTMLButtonElement | null): void {
  window.clearTimeout(inspectTimer);
  inspectTimer = window.setTimeout(() => sendInspect(chip), D_TAP);
}

function bindStepInspect(chip: HTMLButtonElement): void {
  chip.addEventListener("pointerenter", () => queueInspect(chip));
  chip.addEventListener("pointerleave", () => queueInspect(null));
  chip.addEventListener("focus", () => queueInspect(chip));
  chip.addEventListener("blur", () => queueInspect(null));
}

function markChipPageGone(chip: HTMLButtonElement, gone: boolean): void {
  chip.classList.toggle("page-gone", gone);
  let note = chip.querySelector<HTMLElement>(".chip-gone");

  if (!gone) {
    note?.remove();

    return;
  }

  if (!note) {
    note = document.createElement("span");
    note.className = "chip-gone";
    chip.append(note);
  }

  note.textContent = "页面已变";
}

function applyHandoffPhase(phase: "leaving" | "user" | "rereading" | "agent"): void {
  const banner = document.getElementById("handoff-banner");

  if (!banner) return;
  banner.hidden = phase === "leaving" || phase === "agent";
  banner.dataset.phase = phase;
  banner.textContent = phase === "user" ? "你在操作 · 助手在旁边等" : phase === "rereading" ? "助手先重读页面" : "";
  document.getElementById("composer")?.classList.toggle("you-operating", phase === "user");
  // 这一行写「你在操作」时，任务条不再说一遍「已暂停 · 页面归你」。
  taskBar.setHandoffShown(phase === "user");
}

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
const toBottomDot = document.createElement("span");
toBottomDot.className = "to-bottom-dot";
toBottomBtn.appendChild(toBottomDot);
/** 离开底部那一刻的内容高度；之后长高了，说明下面有新内容。 */
let heightWhenLeft = 0;

app.appendChild(toBottomBtn);

let pinned = true;

let runBodyPinned = true;

let thinkPinned = true;

let followingLive = false;

// 用户刚动过滚轮、手指、滚动键或滚动条，这段时间内不自动跟随，免得和正在进行的滚动抢位置。
const USER_SCROLL_QUIET_MS = 150;

let userScrollAt = -Infinity;

// 内容高度的近期记录：浏览器按上一帧画出的内容滚到底，scroll 事件到达前常又插进一段新字，
// 所以判断“滚回底部”要看用户刚才看到的底部，不只看现在的。
const SEEN_BOTTOM_MS = 100;

let heightLog: Array<{ at: number; height: number }> = [];

// 只留一条早于时间窗的记录（窗口开始时的高度）和窗口内的变化。
function pruneHeights(now: number): void {
  while (heightLog.length > 1 && now - heightLog[1]!.at >= SEEN_BOTTOM_MS) heightLog.shift();
}

function noteHeight(): void {
  const now = performance.now();
  pruneHeights(now);
  if (heightLog.at(-1)?.height !== messagesEl.scrollHeight) heightLog.push({ at: now, height: messagesEl.scrollHeight });
}

function seenBottom(): number {
  pruneHeights(performance.now());
  return Math.min(messagesEl.scrollHeight, ...heightLog.map((e) => e.height));
}

let lastScrollTop = 0;

// 跟随代码自己滚到的位置：它触发的 scroll 事件不算人滚。
let followScrollTop = -1;

let followRetry = 0;

function nearBottom(): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40;
}

function userScrolling(): boolean {
  return performance.now() - userScrollAt < USER_SCROLL_QUIET_MS;
}

function followLive(el: HTMLElement | null, stick: boolean): void {
  if (!el) return;

  if (stick) {
    followingLive = true;
    el.scrollTop = el.scrollHeight;
    followingLive = false;
  }

  el.classList.toggle("overflowing", liveViewportOverflows(el.scrollHeight, el.clientHeight));
  syncScrollFade(el, el);
}

function bindLiveViewport(el: HTMLElement, setPinned: (next: boolean) => void): void {
  // 平滑滚动的头几帧还离底部很近，只看位置会被下一次跟随拉回去；往上滚的意图在滚轮事件里就定了。
  el.addEventListener("wheel", (e) => { if (e.deltaY < 0 && el.scrollTop > 0) setPinned(false); }, { passive: true });
  el.addEventListener("scroll", () => {
    syncScrollFade(el, el);
    if (followingLive) return;
    setPinned(isLiveViewportPinned(el.scrollTop, el.scrollHeight, el.clientHeight));
  });
}

/** 哪一侧还有未显示的内容，哪一侧才渐隐。 */
function syncScrollFade(el: HTMLElement = messagesEl, frame: HTMLElement = messagesEl.parentElement!): void {
  const top = String(el.scrollTop > 0);
  const bottom = String(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  if (frame.dataset.fadeTop !== top) frame.dataset.fadeTop = top;
  if (frame.dataset.fadeBottom !== bottom) frame.dataset.fadeBottom = bottom;
}

function markUserScroll(): void {
  userScrollAt = performance.now();
}

// 位置没变就不会有 scroll 事件，不留记号，免得以后人滚到同一位置被当成跟随。
function followToEnd(): void {
  const before = messagesEl.scrollTop;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (messagesEl.scrollTop !== before) followScrollTop = messagesEl.scrollTop;
}

// 这些输入只让跟随让开一会儿；离不离开底部由随后对话区真的滚了没有、往哪滚决定，
// 所以在过程窗这类内层滚动区里滚、对话区没动时，跟随不变。
messagesEl.addEventListener("wheel", markUserScroll, { passive: true });

messagesEl.addEventListener("touchstart", markUserScroll, { passive: true });

messagesEl.addEventListener("touchmove", markUserScroll, { passive: true });

// 目标是滚动区本身：按在滚动条或空白处，点消息里的按钮不算。
messagesEl.addEventListener("pointerdown", (e) => {
  if (e.target === messagesEl) markUserScroll();
});

// 对话区不接焦点，滚动键多半落在 body 上；输入框里的方向键是移光标，不算。
document.addEventListener("keydown", (e) => {
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) markUserScroll();
});

// 往上滚就离开底部，往下滚回底部附近才重新跟上；不管是谁滚的，只跳过跟随自己那一下。
// 内容变短被浏览器夹回底部不算往上滚。
messagesEl.addEventListener("scroll", () => {
  const top = messagesEl.scrollTop;

  const atEnd = messagesEl.scrollHeight - top - messagesEl.clientHeight <= 1;

  if (top === followScrollTop) followScrollTop = -1;
  else {
    const next = seenBottom() - top - messagesEl.clientHeight < 40 && (top >= lastScrollTop || atEnd);

    // 只有人滚（滚轮、触摸、按键、按住滚动条）才离开底部：侧栏变窄时浏览器的滚动锚定也会挪位置，那不算。
    if (next || userScrolling()) pinned = next;
  }
  lastScrollTop = top;
  toBottomBtn.hidden = pinned;

  if (pinned) {
    heightWhenLeft = 0;
    toBottomBtn.classList.remove("has-new");
  } else if (!heightWhenLeft) heightWhenLeft = messagesEl.scrollHeight;
  syncScrollFade();
});

// 侧栏变窄时内容变高、滚动位置不变，跟随中就要贴回底部；两侧渐隐也要重算。
new ResizeObserver(() => {
  if (pinned && !userScrolling()) followToEnd();
  syncScrollFade();
  followLive(currentRun?.body ?? null, false);
}).observe(messagesEl);

new MutationObserver(() => {
  noteHeight();
  syncScrollFade();
  followLive(currentRun?.body ?? null, false);

  // 往上翻着读时下面写出了新内容：按钮带个小点、轻跳一下，只在这一次离开底部期间跳一次。
  if (!pinned && !replayingHistory && !toBottomBtn.hidden && !toBottomBtn.classList.contains("has-new") && heightWhenLeft > 0 && messagesEl.scrollHeight > heightWhenLeft + 8) toBottomBtn.classList.add("has-new");
}).observe(messagesEl, { childList: true, subtree: true, characterData: true });

function scrollToEnd(force = false): void {
  followLive(currentRun?.body ?? null, force || runBodyPinned);
  followLive(currentThinking, force || thinkPinned);

  if (force || (pinned && !userScrolling())) followToEnd();
  // 回答最后一段字恰好落在让开的那一会儿里，之后没人再叫跟随：让开结束后补一次。
  else if (pinned && !followRetry) followRetry = window.setTimeout(() => { followRetry = 0; scrollToEnd(); }, USER_SCROLL_QUIET_MS);
  toBottomBtn.hidden = pinned || nearBottom();
}

toBottomBtn.onclick = () => {
  pinned = true;
  followToEnd();
  toBottomBtn.hidden = true;
  heightWhenLeft = 0;
  toBottomBtn.classList.remove("has-new");
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


  // 用户发了新消息就回到底部重新跟随，之前往上翻过也一样。
  pinned = true;
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

  const pageTitle = [context.title, context.url].filter(Boolean).join("\n");

  // 和上一句是同一页时不再带页面卡：只在换了页面时说一次。
  if ((context.title || host) && previousPageChipTitle(bubble) !== pageTitle) {
    const glyph = siteGlyph(context.url, host);
    glyph.className = "cg";
    const chip = ctxChip(glyph, context.title || host, pageTitle);
    chip.classList.add("page");
    chips.push(chip);
  }

  for (const page of context.pages ?? []) {
    const glyph = siteGlyph(page.url, hostOf(page.url));
    glyph.className = "cg";
    const chip = ctxChip(glyph, page.title || hostOf(page.url), [page.title, page.url, page.reason].filter(Boolean).join("\n"));
    chip.dataset.tabId = String(page.tabId);
    chip.dataset.status = page.status ?? "pending";
    if (page.status === "read") {
      const ok = document.createElement("span");
      ok.className = "ctx-ok";
      ok.textContent = "✓";
      chip.append(ok);
    }
    chips.push(chip);
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

/** 前面最近一张页面卡的 title（「标题\n网址」）；中间几句没带卡说明还是同一页，接着往前找。 */
function previousPageChipTitle(bubble: HTMLElement): string | null {
  for (let node = bubble.previousElementSibling; node; node = node.previousElementSibling) {
    const chip = node.matches(".ctx-chips") ? node.querySelector<HTMLElement>(".ctx-chip.page") : null;

    if (chip) return chip.title;
  }

  return null;
}

function activeTabContext(): PageContext | undefined {
  return activeTabInfo?.url ? { tabId: activeTabInfo.id, url: activeTabInfo.url, title: activeTabInfo.title } : undefined;
}

/** 另开出去的会话 → 发起它的会话。 */
const separateAskOrigins = new Map<string, string>();

/** 停下的另开那件接着做：页面由后台按它自己保留的那页补上；那页已关才用你正看着的这页。 */
function resumeSeparateAsk(receipt: TaskReceipt): boolean {
  const context = activeTabContext();

  return send({ type: "task_action", request: { requestId: crypto.randomUUID(), conversationId: receipt.conversationId, source: "text", action: "resume", expectedRunId: receipt.runId, ...(context ? { context } : {}) } });
}

/** 当前会话里另开的一件事：在自己的会话和后台标签页里做，回答带回这里显示。 */
function isSeparateAsk(receipt: TaskReceipt): boolean {
  return receipt.source === "text" && receipt.action === "start" && receipt.originConversationId === selectedConversationId && receipt.conversationId !== selectedConversationId;
}

/**
 * 另开那件事的一张卡：做着时一行状态和「改成补充上一件」，做完换成「任务名 + 回答」。
 * 同一件事只占一张卡，收条更新时原地替换；你那句话下面的「接在当前任务里处理」改成「另开一件」。
 */
function renderSeparateAsk(receipt: TaskReceipt): void {
  separateAskOrigins.set(receipt.conversationId, receipt.originConversationId!);
  const key = `${receipt.conversationId}:${receipt.requestId}`;
  const previous = receiptMessages.get(key);
  const root = document.createElement("div");
  root.className = "msg separate-ask";
  root.dataset.requestId = receipt.requestId;
  const head = document.createElement("div");
  head.className = "separate-ask-head";
  const tag = document.createElement("span");
  tag.className = "separate-ask-tag";
  tag.textContent = receipt.targetTitle || receipt.text.slice(0, 36);
  const state = document.createElement("span");
  state.className = "separate-ask-state";
  // 重启后暂停的要求也是 queued，但不会自己开始：照宿主的原话说，并给「继续」。
  const paused = receipt.status === "queued" && /连接(已重启|断开)/.test(receipt.message);
  // 做到一半扩展后台重启、没能自动接着做：照宿主的原话说停下了，并给「继续」。
  const stopped = receipt.status === "unknown" && !receipt.result;
  state.textContent = receipt.result ? "已完成" : paused ? receipt.message : receipt.status === "queued" ? "排队中" : receipt.status === "accepted" ? "正在做，不打断当前任务" : receipt.message;
  head.append(tag, state);
  root.append(head);

  if (receipt.result) {
    const body = document.createElement("div");
    body.className = "separate-ask-answer";
    body.innerHTML = renderMarkdown(receipt.result.text);
    root.append(body);
  }
  const actions = document.createElement("div");
  actions.className = "separate-ask-actions";
  const view = document.createElement("button");
  view.type = "button";
  view.textContent = "看过程";
  view.onclick = () => selectConversation(receipt.conversationId);
  actions.append(view);

  if (paused) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = "继续";
    // 带页面的待办要在原页面上继续，宿主会核对你现在看着的是不是那一页。
    resume.onclick = () => { resume.disabled = true; const context = activeTabContext(); if (!send({ type: "task_action", request: { requestId: crypto.randomUUID(), conversationId: receipt.conversationId, source: "text", action: "resume", expectedRunId: null, ...(context ? { context } : {}) } })) resume.disabled = false; };
    actions.append(resume);
  }

  if (stopped) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = "继续";
    // 接上或被拒都会发回一张新卡片替换这张；一直没回音（例如转发途中断了连接）就让按钮恢复可点。
    resume.onclick = () => { resume.disabled = true; if (!resumeSeparateAsk(receipt)) resume.disabled = false; else setTimeout(() => { resume.disabled = false; }, 15_000); };
    actions.append(resume);
  }

  if (!receipt.result && (receipt.status === "queued" || receipt.status === "accepted")) {
    const merge = document.createElement("button");
    merge.type = "button";
    merge.textContent = "改成补充上一件";
    merge.onclick = () => {
      merge.disabled = true;
      // 上一件已做完时要在它的会话里接着做这一句，带上你正看着的页面。
      const context = activeTabContext();
      if (send({ type: "task_action", request: { requestId: crypto.randomUUID(), conversationId: receipt.conversationId, source: "text", action: "abort", expectedRunId: null, supplement: true, ...(context ? { context } : {}) } })) state.textContent = "正在并回上一件…";
      else merge.disabled = false;
    };
    actions.append(merge);
  }
  root.append(actions);

  if (previous) previous.replaceWith(root);
  else messagesEl.append(root);
  receiptMessages.set(key, root);
  // 收到提示紧跟在气泡（或它的页面标签）后面。
  let note = lastUserBubbleFor(receipt.text)?.nextElementSibling;
  if (note?.matches(".ctx-chips")) note = note.nextElementSibling;
  if (note instanceof HTMLElement && note.matches(".steer-received")) note.textContent = receipt.status === "applied" ? "已收到 · 并回上一件处理" : "另开一件 · 不打断当前任务";
}

/** 任务进行中发出的话会交给正在做的这一轮：在气泡下说一声收到了，免得看不出它是在排队还是被忽略了。 */
function markSteerReceived(bubble: HTMLElement): void {
  const note = document.createElement("div");
  note.className = "steer-received";
  note.textContent = "已收到 · 接在当前任务里处理";
  const chips = bubble.nextElementSibling;
  (chips instanceof HTMLElement && chips.matches(".ctx-chips") ? chips : bubble).after(note);
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
  const anchor = resumeRoot?.parentElement === messagesEl ? resumeRoot : null;

  if (node.parentElement === messagesEl && node.querySelector(".artifact-inline-frame")) {
    // Chromium's state-preserving move keeps the iframe's JS state and form
    // values. Move only the touched card, never the following messages or
    // unrelated cards from earlier turns.
    const container = messagesEl as HTMLElement & { moveBefore?: (child: Node, before: Node | null) => void };

    if (typeof container.moveBefore === "function") container.moveBefore(node, anchor);
    // Older engines: keep the live iframe in place rather than reloading it.
    return;
  }

  if (anchor) {
    messagesEl.insertBefore(node, anchor);
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

// ── 回答首句末尾「按你说过的「…」等 N 条 ›」：展开后插在首句与正文之间，每条可「忘掉」或「这里别用」 ──
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
    if (node instanceof HTMLElement && node.matches(".msg.assistant:not(.opening-line)")) return node;
  }

  return null;
}

function flushMemoryUsedLine(): void {
  const line = pendingUsedLine;
  pendingUsedLine = null;

  if (!line || !line.items.size) return;
  const answer = latestAnswer();

  // 这一轮没有回答（停止、出错）：不单独挂这一行，免得它悬在空处。
  if (!answer) return;

  // 复制按钮在最终稿放完后才挂：有它说明正文不会再整段重渲染。
  if (answer.querySelector(".answer-actions")) {
    placeUsedLine(line, answer);

    return;
  }

  if (repeatsEarlierUsedLine(line, null)) return;
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

  // 和上一行用的是同一组记忆：不再每条回答都重复一遍。也不登记到回答上，网页上点「忘记」时改的是看得到的那一行。
  if (repeatsEarlierUsedLine(line, answer)) {
    line.el.remove();
    line.cite.remove();
    usedLineByAnswer.delete(answer);

    return;
  }
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

/** 这一行实际用到的记忆（完整的一组，连同网站），摘要文字一样不代表用的是同几条。 */
const usedLineKey = (line: MemoryUsedLine): string => `${line.hostname ?? ""}\n${[...line.items.keys()].sort().join("\n")}`;

/** 对话里在 anchor 之前、看得到的最后一行用的是同一组记忆：只和紧挨着的上一行比，换过一组再换回来时重新显示。 */
function repeatsEarlierUsedLine(line: MemoryUsedLine, anchor: Node | null): boolean {
  const earlier = Array.from(messagesEl.querySelectorAll<HTMLElement>(".memory-used-toggle")).filter(cite =>
    cite !== line.cite && (!anchor || !!(cite.compareDocumentPosition(anchor) & Node.DOCUMENT_POSITION_FOLLOWING)));

  return earlier.at(-1)?.dataset.usedKey === usedLineKey(line);
}

const USED_GLYPHS: Record<"past" | "profile" | "method", string> = {
  past: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="5" r="4"/><path d="M5 2.8V5l1.5 1"/></svg>',
  profile: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="5" cy="3.3" r="1.8"/><path d="M1.6 9c.4-1.9 1.8-2.9 3.4-2.9S8 7.1 8.4 9"/></svg>',
  method: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 2.5h6M2 5h4M2 7.5h5"/></svg>',
};

/** 行内点名用上的第一条（带给助手时排第一），多条时加「等 N 条」（YIS-86）。太长的截断，全文在展开里。 */
function usedLineLabel(line: MemoryUsedLine): string {
  const first = line.items.values().next().value!;
  const text = first.kind === "entry" ? first.entry.text : first.task.done || first.task.goal;
  const short = text.length > 16 ? `${text.slice(0, 15)}…` : text;

  return `${first.kind === "entry" ? "按你说过的" : "按上次做过的"}「${short}」${line.items.size > 1 ? `等 ${line.items.size} 条` : ""}`;
}

function renderUsedLine(line: MemoryUsedLine): void {
  line.el.className = "memory-used-line";
  line.el.dataset.memoryUsedLine = String(line.items.size);
  const cite = line.cite;
  cite.type = "button";
  cite.className = "memory-used-toggle";
  cite.dataset.usedKey = usedLineKey(line);
  cite.setAttribute("aria-expanded", String(line.open));
  const chevron = document.createElement("span");
  chevron.className = "memory-used-chevron";
  chevron.textContent = "›";
  cite.replaceChildren(`${usedLineLabel(line)} `, chevron);
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
  // 过往任务显示做成了什么（和带给助手的一样），没有时显示原话目标。一行放不下就截断，悬停看全文。
  text.textContent = item.kind === "entry" ? item.entry.text : item.task.done || item.task.goal;
  text.title = text.textContent;
  const actions = document.createElement("span");
  actions.className = "memory-used-actions";
  const rerender = () => { if (line.el.isConnected || line === pendingUsedLine) renderUsedLine(line); };

  if (item.state === "used") {
    actions.append(usedButton("忘记", "forget", item, () => runUsedAction(item, "forget", rerender)));

    // 没有当前网站（扩展页、空白页）就没有「这里」可言。
    if (line.hostname) actions.append(usedButton("在这个网站不用", "not-here", item, () => runUsedAction(item, "not-here", rerender, line.hostname!)));
  } else {
    const note = document.createElement("span");
    note.className = "memory-used-note";
    note.textContent = item.state === "forgotten" ? "已忘记" : `在 ${line.hostname} 不用`;
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

/** 本对话里最近一次带上这条记忆、还没动过的那一行（从最新的回答往前找）。 */
function findUsedEntry(id: string): { line: MemoryUsedLine; item: UsedItem } | null {
  const answers = Array.from(messagesEl.querySelectorAll<HTMLElement>(".msg.assistant")).reverse();
  const lines = [pendingUsedLine, floatingUsedLine, ...answers.map(answer => usedLineByAnswer.get(answer) ?? null)];

  for (const line of lines) {
    const item = line?.items.get(`entry:${id}`);

    if (line && item?.state === "used" && !item.pending) return { line, item };
  }

  return null;
}

// 网页上「记得的」小卡点「忘掉」（YIS-87）：用回答下面那一行同一套「忘掉」，展开那一行让你看到「已忘掉 · 撤销」。
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (!isPageInteractionMessage(message) || message.type !== "MEMORY_FIELD_FORGET") return;
  const found = findUsedEntry(message.id);

  if (!found) { respond({ ok: false });

 return; }

  const { line, item } = found;
  line.open = true;
  runUsedAction(item, "forget", () => {
    if (line.el.isConnected || line === pendingUsedLine) renderUsedLine(line);

    if (!item.pending) respond({ ok: item.state === "forgotten" });
  });

  return true;
});

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
      item.error = `${action === "forget" ? "没能忘记" : action === "not-here" ? "没能改成在这个网站不用" : "没能撤销"}：${result.error ?? "再试一次"}`;
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
    done({ ok: false, error: "侧栏和扩展后台断开了。稍后再试。" });
  }
}

/** 「原来是…」只写变了的部分：新旧值在同一个「：」或空格之前完全相同，就省掉这一段（不在词中间截断）。 */
function changedPart(now: string, before: string): string {
  let cut = 0;

  for (let i = 0; i < Math.min(now.length, before.length) && now[i] === before[i]; i++) if ("：: ".includes(now[i]!)) cut = i + 1;

  return before.slice(cut) || before;
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
        : event.entries.some(entry => entry.experience) ? "已记下这次纠正 · 查看" : "已记住 · 查看";
  const snapshots = event.entries.map((entry) => ({ ...entry, scope: { ...entry.scope } }));
  button.onclick = () => openMemoryDrawer({ action: event.action, entries: snapshots, message: event.message });
  receipt.append(mark, button);
  const single = event.entries.length === 1 && !event.entries[0]!.experience ? event.entries[0]! : null;
  const saved = event.action === "saved" ? single : null;
  // 改了一条资料：回执写出新值和旧值，「撤销」把旧值恢复回来（YIS-85）。
  const previous = event.action === "updated" && single && event.replaced?.length === 1 && !event.replaced[0]!.experience ? event.replaced[0]! : null;
  const quick = saved ?? (previous && single);

  // 自动记下或改过的资料：回执直接写出记了什么，旁边给「撤销」（用户 2026-09-27 选择「自动记，给撤销」）。
  if (quick) {
    const text = document.createElement("span");
    text.className = "memory-receipt-text";
    text.textContent = previous ? `已更新：${quick.text}（原来是${changedPart(quick.text, previous.text)}）` : `已记住：${quick.text}`;
    text.title = text.textContent;
    button.textContent = "查看";
    const undo = document.createElement("button");
    undo.type = "button";
    undo.dataset.memoryUndo = quick.id;
    undo.textContent = "撤销";
    undo.onclick = () => {
      undo.disabled = true;
      const message = previous ? memoryState.beginRestore(selectedConversationId, previous) : memoryState.beginForget(selectedConversationId, quick);
      receiptUndos.set(message.requestId, (ok, error) => {
        if (ok) { text.textContent = previous ? `已撤销，还是${previous.text}` : "已撤销，不再记住这条"; text.title = text.textContent; undo.remove(); button.remove();

 return; }

        undo.disabled = false;
        text.textContent = `没能撤销：${error ?? "请重试"}`;
      });
      dispatchMemoryRequest(message, previous ? { action: "restore", entryId: previous.id } : { action: "forget", entryId: quick.id });
    };

    receipt.replaceChildren(mark, text, undo, button);
  }

  if (event.entries.length === 1 && !quick) {
    const scope = document.createElement("span");
    scope.className = "memory-receipt-scope";
    scope.textContent = memoryScopeLabel(event.entries[0]!.scope);
    receipt.appendChild(scope);
  }

  messagesEl.appendChild(receipt);
  scrollToEnd();

  return receipt;
}

/** 站点笔记写下了：这一轮下面一行小字，点「查看」展开笔记原文。 */
function renderSiteNotesReceipt(event: Extract<AgentUiEvent, { kind: "site_notes" }>): void {
  const receipt = document.createElement("div");
  receipt.className = "memory-receipt site-notes-receipt";
  const text = document.createElement("span");
  text.className = "memory-receipt-text";
  text.textContent = `记下了 ${siteName(`http://${event.host}/`, event.title)} 的${event.notes.length > 1 ? ` ${event.notes.length} 条` : ""}用法`;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = "查看";
  toggle.setAttribute("aria-expanded", "false");
  const list = document.createElement("ul");
  list.className = "site-notes-list";
  list.hidden = true;

  for (const note of event.notes) {
    const item = document.createElement("li");
    item.textContent = note;
    list.appendChild(item);
  }

  toggle.onclick = () => {
    list.hidden = !list.hidden;
    toggle.textContent = list.hidden ? "查看" : "收起";
    toggle.setAttribute("aria-expanded", String(!list.hidden));
  };
  receipt.append(text, toggle);
  appendToMessages(receipt);
  appendToMessages(list);
  scrollToEnd();
}

// ── 纠正后开口问「要我记住吗」──
/**
 * 询问事件：第一条带出卡片；同一 askId 带 outcome 的后续事件（现场或对话历史回放）把它推到结局。
 * 没有本地状态的回放卡片直接停在结局；没有结局的照常可点。
 */
function renderMemoryAsk(event: MemoryAskEvent): void {
  if (!memoryAskCards.has(event.askId)) memoryAskCards.set(event.askId, createAskCard(event, !replayingHistory));

  if (event.outcome) stepMemoryAsk(event.askId, { kind: "outcome", outcome: event.outcome });

  if (messagesEl.querySelector(`[data-memory-ask="${CSS.escape(event.askId)}"]`)) return;
  appendToMessages(buildMemoryAsk(event.askId));
  if (event.learned && !memoryDrawerCtrl.isListPending()) requestMemoryList();
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
    const rule = card.ask.rule.trim().replace(/[。.!！?？，,；;]+$/u, "");
    // 习惯是不带主语的短句（「在 B 站提取字幕并保存」）；纠正是助手第一人称的承诺（「以后我都…」），不加前缀。
    line.textContent = card.ask.habit ? `你好像每次都这样做：${rule}。要我记住吗？` : `${rule}，要我记住吗？`;

    if (card.ask.evidence?.length) {
      const why = document.createElement("details");
      why.className = "memory-ask-replaces";
      why.dataset.memoryAskEvidence = "";
      const summary = document.createElement("summary");
      summary.textContent = `依据：${card.ask.evidence.length} 天里做过，来自你自己的浏览`;
      why.append(summary, ...card.ask.evidence.map(text => Object.assign(document.createElement("div"), { textContent: text })));
      root.appendChild(why);
    }

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
    line.textContent = card.ask.learned ? `当时记下了：${card.ask.rule} 当前状态可在「记忆」中查看。` : "好，记住了。可在「记忆」面板查看或撤销";
  } else if (card.phase === "undone") {
    line.textContent = card.ask.learned ? "已删除这条规则。" : "已撤销。";

    if (card.ask.learned) {
      const details = document.createElement("details");
      details.className = "memory-ask-replaces";
      const summary = document.createElement("summary");
      summary.textContent = "删除影响";
      details.append(summary, "后续任务不再加载这条保存的规则。当前对话、过往任务和站点笔记仍可能影响回答，已执行的网页操作不变。");
      root.append(details);
    }
  } else if (card.phase === "inactive") {
    line.textContent = "这条规则已被替换或停用。";
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
    const undo = memoryAskButton("memory-ask-undo", card.pending === "undo" ? (card.ask.learned ? "正在删除…" : "正在撤销…") : (card.ask.learned ? "删除规则" : "撤销"), { kind: "undo" }, card);
    undo.dataset.memoryAskUndo = entry.id;
    line.append(card.ask.learned ? `已记住：${entry.text.trim().replace(/[。.!！]+$/u, "")}。` : "好，记住了。", scope);

    if (card.ask.learned) {
      scope.textContent = entry.scope.kind === "site" ? `仅 ${entry.scope.hostname}` : "所有网站";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "memory-ask-undo";
      edit.textContent = "编辑";
      edit.onclick = () => {
        memoryDrawerCtrl.openForEdit(entry);
      };
      line.append(edit);
    }

    line.append(undo);
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
  root.dataset.phase = "thinking";
  // 过程默认收起，工具与协作任务使用同一个展开入口。
  root.open = false;
  const summary = document.createElement("summary");
  const iconBox = document.createElement("span");
  iconBox.className = "run-icon";
  const orb = createOrb("thinking", ORB_BOX_STATUS, true);

  if (!applyingHistory) orb.setRunning(true);
  const orbMark = document.createElement("span");
  orbMark.className = "run-orb-mark";
  orbMark.hidden = true;
  orbMark.setAttribute("role", "img");
  iconBox.append(orbMark);
  const actIcon = document.createElement("span");
  actIcon.className = "run-act-icon";
  setActionIcon(actIcon, "think");
  const beat = document.createElement("span");
  beat.className = "run-beat";
  beat.setAttribute("aria-hidden", "true");
  beat.append(orb.el);
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
  // 第二行小字：已做几步（#263 A）。整行可点，和 › 一样展开记录。
  const meta = document.createElement("span");
  meta.className = "run-meta";
  meta.hidden = true;
  summary.append(iconBox, actIcon, beat, title, chainEl, timeEl, chevron, meta);
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
  root.addEventListener("toggle", () => followLive(body, false));
  // 恢复记录时任务卡不在记录里，接续入口一直留在消息流末尾：过程块和这一轮其他内容一样排在它前面，
  // 否则插在过程块前面的开场话会落到入口后面，收尾时收不进过程。实时时入口很快被任务卡收走，保持原样。
  if (replayingHistory) appendToMessages(root);
  else messagesEl.appendChild(root);
  const graph = mountLiveGraph({ history: () => applyingHistory });
  root.after(graph.el);
  const trail = document.createElement("div");
  trail.className = "run-trail";
  trail.hidden = true;
  graph.el.after(trail);
  const skeleton = answerSkeleton();
  trail.after(skeleton);
  const start = runStartAt || eventTime();
  retirePlanCard();
  taskPlan.adopt(root, body);

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
    timer: 0,
    lastToolShort: null,
    chipGroup: null,
    orbActivity: new RunOrbActivity(),
    orbMark,
    changedPage: false,
    titleAt: 0,
    titleTimer: 0,
    actIcon,
    trail,
    metaEl: meta,
    checkNote: null,
    thinkFrom: start,
    thinkSegments: [],
    aside: null,
    guideHint: null,
    evidence: null,
    evidenceLines: [],
    answer: null,
    check: null,
    receipt: null,
    graph,
    beatEl: beat,
    skeleton,
    lastToolName: null,
    readingTools: new Map(),
  };
  startLiveSeconds(currentRun, start);

  return currentRun;
}

/** 进行中标题下方的说明行（调试提示条、教学点了没变化）。做过的步骤不再列在这里，只在 › 里（#263）。 */
function renderTrail(run: RunHost): void {
  const key = JSON.stringify([run.aside, run.guideHint]);

  if (run.trail.dataset.key === key) return;

  run.trail.dataset.key = key;
  const rows: HTMLElement[] = [];

  if (run.aside) {
    const aside = document.createElement("div");
    aside.className = "trail-aside";
    aside.textContent = run.aside;
    rows.push(aside);
  }

  if (run.guideHint) {
    const hint = document.createElement("div");
    hint.className = "trail-aside warn";
    hint.textContent = run.guideHint;
    rows.push(hint);
  }

  run.trail.replaceChildren(...rows);
  run.trail.hidden = rows.length === 0;

  if (run.graph.el.nextElementSibling !== run.trail) run.graph.el.after(run.trail);
}

/** 记录里秒数的门槛：一步、一段思考不到 3 秒都不写秒数，思考段也不单列（#263）。 */
const SHOW_SECS_MS = 3_000;

/** 两步之间短于这个就不算想过（工具连着调）。 */
const THINK_MIN_MS = 100;

function stopLiveSeconds(run: RunHost): void {
  if (!run.timer) return;
  clearInterval(run.timer);
  run.timer = 0;
}

/** 首字前挂这么久还没回音，只换标题，不改秒数和墨点。 */
const WAIT_STALE_MS = 15_000;
const WAIT_STALE_TITLE = "还没有回音";
const THINKING_TITLE = "正在思考";

/** 每秒刷新一次秒数，刷新时刻对齐 from 之后的整秒（多留一点余量，免得早到几毫秒少数一秒）：显示的秒数最多比真实慢 1 秒。 */
function startLiveSeconds(run: RunHost, from = Date.now()): void {
  if (run.timer) return;
  const tick = () => {
    if (currentRun !== run) return;
    run.timeEl.textContent = liveSeconds(run);
    maybeStaleWait(run);
  };
  const delay = 1000 - (((Date.now() - from) % 1000) + 1000) % 1000 + 30;
  const align = window.setTimeout(() => {
    if (run.timer !== align) return;
    run.timer = window.setInterval(tick, 1000);
    tick();
  }, delay);
  run.timer = align;
}

/** 第一行的秒数：贴在动词后面。在想就数这段（≥1 秒才写），在跑一步就数这一步（≥3 秒才写）。历史回放没有时钟时不写。 */
function liveSeconds(run: RunHost): string {
  const now = Date.now();

  if (Number.isFinite(run.thinkFrom)) {
    if (now - run.thinkFrom < 1_000) return "";
    return spokenDuration(run.thinkFrom, now) ?? "";
  }
  const running = [...toolChips.values()].find(entry => entry.chip.isConnected && run.body.contains(entry.chip));

  return running && Number.isFinite(running.start) && now - running.start >= SHOW_SECS_MS ? spokenDuration(running.start, now) ?? "" : "";
}

/** 「还没有回音」只顶替「正在思考」：重试、压缩、接着做这些标题说的是更具体的事，不能盖掉。思考摘要也算回音。 */
function maybeStaleWait(run: RunHost): void {
  if (!Number.isFinite(run.thinkFrom) || run.body.querySelector(".chip, details.thinking")) return;
  if (Date.now() - run.thinkFrom < WAIT_STALE_MS) return;
  if (run.titleTimer || run.titleEl.textContent !== THINKING_TITLE) return;
  setRunTitle(run, WAIT_STALE_TITLE, true, "think");
}

/** 结束正在算的这段思考：≥3 秒的在记录里单列一行「想了 N 秒」。 */
function closeThink(run: RunHost, at: number): void {
  const from = run.thinkFrom;
  run.thinkFrom = Number.NaN;

  if (!Number.isFinite(from) || !Number.isFinite(at) || at - from < THINK_MIN_MS) return;
  run.thinkSegments.push({ start: from, end: at });
  const details = run.body.querySelector<HTMLElement>(`details.thinking[data-think-from="${from}"]`);

  // 回答出字时就结束了这段；closeBlocks 到这一轮结束才跑，要沿用这里的起止，不能算上回答放字的时间。
  if (details) details.dataset.thinkTo = String(at);

  if (at - from < SHOW_SECS_MS) return;
  // 模型写了思考过程的：就在那块的标题上写，点开还能看原文。
  const block = details?.querySelector<HTMLElement>(":scope > summary > span");

  if (block) { block.textContent = `想了 ${spokenDuration(from, at)}`;

 return; }
  const row = document.createElement("div");
  row.className = "run-think";
  row.textContent = `想了 ${spokenDuration(from, at)}`;
  (run.chipGroup?.row ?? run.body).appendChild(row);
}

/** 开始算一段思考（上一步结束、用户交还页面）。已经在算就不重开。 */
function openThink(run: RunHost, at: number): void {
  if (Number.isFinite(run.thinkFrom)) return;
  run.thinkFrom = at;

  // 秒数从这段重新数：刷新时刻对齐到这段的整秒，上一段的读数当场清掉。
  if (run.timer) {
    stopLiveSeconds(run);
    startLiveSeconds(run, at);
    run.timeEl.textContent = liveSeconds(run);
  }
}

/** 做完的步骤（不算准备动作和说明行）。 */
function doneSteps(run: RunHost): HTMLElement[] {
  return Array.from(run.body.querySelectorAll<HTMLElement>(".chip:not(.prep):not(.note):not(.running)"));
}

/** 第二行小字：「已做 N 步 ›」，有换了做法的步骤时跟一句。一步还没做完时不显示。 */
function renderRunMeta(run: RunHost): void {
  const done = doneSteps(run);
  const failed = done.filter(chip => chip.classList.contains("error")).length;
  const steps = done.length ? `已做 ${done.length - failed} 步${failed ? ` · ${failed} 步换了做法` : ""}` : "";
  const text = [run.checkNote, steps].filter(Boolean).join(" · ");

  if (run.metaEl.textContent !== text) run.metaEl.textContent = text;
  run.metaEl.hidden = !text;
}

/**
 * 收尾回执：「做了 6 步：打开词条 → … → 圈出 11 部」（#263 C）。短名链放不下时从中间省略，头尾优先留；
 * 头尾都放不下只留最后一个，再放不下只写步数。末尾「· N 步换了做法」从不省略。不写耗时。
 * 侧栏宽度会变（拖宽、切会话后才显示），所以每次尺寸变化重排一次。
 */
function paintReceipt(title: HTMLElement, head: string, names: string[], tail: string): void {
  const verb = document.createElement("span");
  verb.className = "act-verb";
  const chain = document.createElement("span");
  chain.className = "act-object run-chain-names";
  const warn = document.createElement("span");
  warn.className = "run-receipt-tail";
  warn.textContent = tail;
  title.classList.add("run-receipt");
  title.replaceChildren(verb, chain, warn);

  const fit = () => {
    const fits = () => chain.scrollWidth <= chain.clientWidth + 1 && title.scrollWidth <= title.clientWidth + 1;
    verb.textContent = names.length > 1 ? `${head}：` : head;

    if (names.length < 2) { chain.textContent = ""; return; }

    for (let k = names.length; k >= 2; k--) {
      const front = Math.ceil(k / 2), back = k - front;
      chain.textContent = k === names.length ? names.join(" → ") : [...names.slice(0, front), "…", ...names.slice(names.length - back)].join(" → ");

      if (fits()) return;
    }

    chain.textContent = `… → ${names[names.length - 1]}`;

    if (fits()) return;
    chain.textContent = "";
    verb.textContent = head;
  };

  fit();
  const observer = new ResizeObserver(() => { if (title.isConnected && verb.parentElement === title) fit(); else observer.disconnect(); });
  observer.observe(title.closest("details.run-steps") ?? title);
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

  // 只有一个助手时，「1 个 Agent 已暂停」「全队已恢复」只是在重复任务条和过程行；多个助手并行时才需要这张卡。
  if (!shouldShowTeamCard(view?.phase) || (view?.members.length ?? 0) < 2) {
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
    currentRun?.graph.user(flags.userHasPage);

    if (!flags.userHasPage) collapseHandoffCard(running ? "你已交还 · 我从你所在的页面接着做" : "任务已中止");
  }

  // 同一个位置：Agent 在做时是「我来」，页面归你时是「你继续」。
  takeoverBtn.hidden = !flags.takeoverVisible && !flags.userHasPage;
  takeoverBtn.dataset.mode = flags.userHasPage ? "handback" : "takeover";
  takeoverBtn.textContent = flags.userHasPage ? "交还" : "接管";
  takeoverBtn.title = flags.userHasPage ? "交还：助手先重读页面，再接着做。" : "接管：助手暂停，由你操作页面。操作完，点「交还」。";
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
    stopLiveSeconds(currentRun);
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
  // 页面归谁由输入框上方那一行说；过程行只记这一轮停着。
  user: { icon: Hand, label: "已暂停" },
  completed: { icon: Check, label: "本轮结束" },
  failed: { icon: CircleAlert, label: "出错" },
  stopped: { icon: Square, label: "已中止" },
} as const;

function syncRunOrb(run: RunHost): void {
  const state = run.orbActivity.state(lastUserHasPage);
  run.root.dataset.phase = state;
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
  const reading = run.readingTools.size > 0 && [...run.readingTools.values()].every(Boolean);
  run.orb.setState(state === "executing" && reading ? "reading" : state);
  run.orb.setRunning(!applyingHistory && orbStateRuns(state));
}

function finishRun(): void {
  const run = currentRun;
  currentRun = null;
  runStartAt = 0;

  if (!run) return;
  // 计划那一行只陪这一轮任务；做完、停下、出错都收掉，不挂到下一件事上。
  taskPlan.endRun();
  lastRun = run;
  // 耗时读数 interval 立即停掉：run 完成/中断/空 run 都不留泄漏
  stopLiveSeconds(run);
  const endedAt = eventTime();
  // 停下、出错、答完：正在算的那段思考在这一刻结束（#263 E6）。
  closeThink(run, endedAt);
  // 收尾后过程只留回执，进行中的说明行不再单列。
  run.trail.remove();
  // 骨架先按样式淡出，淡完再拿掉；没接上回答就结束（出错、停下、只有卡片）时也不留。
  const skeleton = run.skeleton;
  skeleton.dataset.state = "gone";
  window.setTimeout(() => skeleton.remove(), reducedMotion() ? 0 : D_STATE);
  // 空 run（纯文本回复，无思考/工具步骤）不留壳；只读回合（问答、读页）正常结束也不留过程行，
  // 用户看回答和页面本身即可。动过页面、失败或被停止时才保留「查看执行过程」。
  const hasSteps = Array.from(run.body.children).some(child => !(child as HTMLElement).hidden);
  run.orbActivity.finish();
  const outcome = run.orbActivity.state();
  const hasResumeReceipt = !!run.body.querySelector(".receipt-history");
  // 按主动卡发起的一轮（YIS-106）：步骤就是卡上那件事的结果，即使只读也留着。
  const keepProcess = run.changedPage || hasResumeReceipt || outcome === "failed" || outcome === "stopped" || cardTurn(run.root);

  // 核对判继续后续做的这一轮：即使没有步骤也留着，「核对发现：…」只写在这一行上，拿掉用户就看不到为什么又动起来。
  if (!run.checkNote && (!hasSteps || !keepProcess)) {
    const drop = () => {
      run.root.remove();
      run.graph.el.remove();

      if (lastRun === run) lastRun = null;
    };

    // 首字刚到还在淡出：等 --d-state 再拿掉，避免收起被掐断（#311）。
    if (run.root.classList.contains("run-quieting") && !reducedMotion()) window.setTimeout(drop, D_STATE);
    else drop();

    return;
  }

  run.root.classList.add("done");
  run.orbActivity.finish();
  syncRunOrb(run);
  const title = run.titleEl;

  if (title) {
    const outcome = run.orbActivity.state();
    // 准备动作（定位当前页、读页面结构）不算一件事。
    const done = Array.from(run.body.querySelectorAll<HTMLElement>(".chip:not(.prep):not(.note)"));
    const ended = outcome === "failed" || outcome === "stopped" ? outcome : "completed";
    const only = done.length === 1 && ended === "completed" ? done[0] : null;
    // SAFETY: data-kind 由 onToolStart 写入，取值就是 IconKind。
    setActionIcon(run.actIcon, only ? (only.dataset.kind as IconKind) : "many");
    clearTimeout(run.titleTimer);

    const failed = done.filter(chip => chip.classList.contains("error")).length;
    // 换了做法的那步不算进「做了几步」，单独写在末尾。
    const head = hasResumeReceipt && done.length === 0 && ended === "completed" ? "恢复记录"
      : only?.dataset.past ? only.dataset.past
      : finishedRunTitle(ended === "completed" ? done.length - failed : done.length, ended, failed);
    run.receipt = { head, total: spokenDuration(run.start, endedAt), steps: done.length, failed, ended };

    if (hasResumeReceipt && done.length === 0 && ended === "completed") setRunTitle(run, head, true);
    else if (only?.dataset.past) setRunTitle(run, head, true);
    else {
      // 回执：「做了 6 步：打开词条 → … → 圈出 11 部 · 1 步换了做法」（#263 C）。出错结束只写步数和「有 1 步没做成」。
      const names = ended === "failed" ? [] : done.filter(chip => !chip.classList.contains("error")).map(chip => chip.dataset.short ?? "").filter(Boolean);
      paintReceipt(title, head, names, ended === "completed" && failed ? ` · ${failed} 步换了做法` : "");
    }
  }

  // 回执不写耗时（10-06）；总时长和想了多久写在展开记录的末行。历史回放没有时钟时不写（#263 E1）。
  run.timeEl.textContent = "";
  run.metaEl.hidden = true;
  mergeRepeatedSteps(run);
  const total = spokenDuration(run.start, endedAt);

  if (total && hasSteps) {
    const thought = run.thinkSegments.reduce((sum, seg) => sum + (seg.end - seg.start), 0);
    const line = document.createElement("div");
    line.className = "run-total";
    line.textContent = thought >= 1_000 ? `共 ${total}，其中想了 ${spokenDuration(0, thought)}` : `共 ${total}`;
    run.body.appendChild(line);
  }
  const planTop = run.root.classList.contains("plan-card") && !pinned ? run.root.getBoundingClientRect().top : null;
  run.root.open = false;
  placeProcessBeforeAnswer(run.root);

  // 回执看后果：这一轮还原账本记到了页面改动（填过的栏、或撤不回的编辑器正文），不管原话怎么说都收成回执；计划行的关键词只管开头那行「会去 …」。
  if (run.receipt && (run.root.classList.contains("plan-card") || planUndo)) {
    run.root.classList.add("plan-card");
    planCardRun = run;
    paintPlanCard();
  }

  // 计划卡收成一行时整张卡变矮：用户翻在上面看时，把卡顶留在原处，不让内容跳走；被挤出视口的部分由顶部的渐隐边盖住。
  if (planTop !== null) messagesEl.scrollTop += run.root.getBoundingClientRect().top - planTop;
  // 分叉层跟着过程块走：紧跟在它后面，读回再跟在分叉层后面；这一轮没画分叉就不留空节点。
  run.graph.finish();

  if (run.graph.el.hidden) run.graph.el.remove();
  else run.root.after(run.graph.el);

  if (run.evidence) (run.graph.el.isConnected ? run.graph.el : run.root).after(run.evidence);

  for (let node = run.root.nextElementSibling; node && !node.matches(".msg.user"); node = node.nextElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant")) syncAnswerTime(node);
  }

  if (run.answer) foldAnsweredRun(run);
  scrollToEnd();
}

/** 最近一张收成回执的计划卡，和这一轮还原填写的状态（后台晚到时重画）。 */
let planCardRun: RunHost | null = null;
let planUndo: FillUndoView | null = null;

/**
 * 新一轮开始：上一张计划卡定格。还能撤销的收掉「撤销」（新一轮开始后后台不再留这一轮的还原，和回答下的按钮一样）；
 * 已撤销、收不回留着。之后这一轮的还原状态只画到新卡上。
 */
function retirePlanCard(): void {
  if (!planCardRun) { planUndo = null; return; }

  if (planUndo?.state === "ready") {
    const button = planCardRun.root.querySelector<HTMLButtonElement>(".plan-undo");
    // 用户已经没法恢复，就不在这一行留一个灰掉的按钮；连同前面的分隔点一起拿掉。
    if (button?.previousSibling?.textContent === " · ") button.previousSibling.remove();
    button?.remove();
    const scope = planCardRun.root.querySelector(".plan-fill-scope p");
    if (scope) scope.textContent = "新任务已开始，上一轮的填写记录不再用于恢复。";
  }
  planCardRun = null;
  planUndo = null;
}

/** 计划卡这一轮的回答：卡后面、下一条用户消息之前的那条回答。 */
function planCardAnswer(run: RunHost): HTMLElement | null {
  for (let node = run.root.nextElementSibling; node && !node.matches(".msg.user"); node = node.nextElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant") && node.querySelector(".answer-actions")) return node;
  }

  return null;
}

function paintPlanCard(): void {
  const run = planCardRun;

  if (!run?.root.isConnected || !run.receipt) return;
  const undo = planUndo;
  const answer = planCardAnswer(run);

  // 撤销只留卡上这一个：回答下不再出「还原填写」，撤销后的结果行放在卡下面，回答照样变淡。
  if (answer && undo) handFillUndoToCard(answer, run.root);
  // 整轮结论说了算：中途某步没做成、后来换做法做完，卡仍按 completed 收成一行；没做成的那步只在展开的过程里标 ✕。
  paintPlanReceipt(run.root, {
    filled: undo?.state === "ready" ? undo.count + (undo.unavailable?.length ?? 0) : undo?.state === "restored" ? undo.restored.length + undo.skipped.length + (undo.unavailable?.length ?? 0) : undo ? undo.fields.length || null : null,
    steps: run.receipt.steps - run.receipt.failed,
    total: run.receipt.total,
    ended: run.receipt.ended,
    // 页面换了、记录没了：用户在这行没有可做的事，不留「恢复记录已失效」；「网站已收到」是结果，照常写。
    undo: !undo || (undo.state === "ready" && undo.count === 0) || undo.state === "page_changed" ? "none" : answer && isFillUndoPending(answer) ? "pending" : undo.state === "ready" ? "ready" : undo.state === "restored" ? "done" : "closed",
    undoLabel: undo ? fillUndoLabel(undo) : "",
    undoable: undo?.state === "restored" ? [...undo.restored, ...undo.skipped.map(s => s.field)] : undo?.fields ?? [],
    unavailable: undo?.unavailable ?? [],
    untracked: undo?.untracked ?? [],
    onUndo: () => {
      const owner = planCardAnswer(run);

      if (owner) void requestFillUndo(owner).finally(paintPlanCard);
      else port?.postMessage({ kind: "fill_undo", conversationId: selectedConversationId } satisfies PanelToBg);
    },
  });
  adoptPlanResume();
}

/** 交付属于哪一块过程：正在跑的那块，或刚收尾的那块；runId 对不上就不属于任何一块。 */
function runForDelivery(runId: string | null): RunHost | null {
  const run = currentRun ?? lastRun;
  const own = run?.root.dataset.runId;

  return run && !(own && runId && own !== runId) ? run : null;
}

/** 回答（finding）已显示：记到它那一轮上；这一轮已收尾就马上收起，还在跑就等 finishRun。 */
function noteRunAnswer(delivery: UserDelivery, el: HTMLElement): void {
  if (delivery.kind !== "finding") return;
  const run = runForDelivery(delivery.runId);

  if (!run) return;
  run.answer = { text: delivery.text, el, hostNote: !!delivery.hostNote };

  if (run !== currentRun && run.root.isConnected && run.root.classList.contains("done")) foldAnsweredRun(run);
}

/** 收尾后，紧挨着的同一步（同样的字、同样的成败）在记录里合成一行，末尾写 ×N。回执的步数照旧按实际次数算。 */
function mergeRepeatedSteps(run: RunHost): void {
  const key = (chip: Element) => `${chip.classList.contains("error")}|${chip.querySelector(".chip-label")?.textContent ?? ""}`;

  for (const row of run.body.querySelectorAll<HTMLElement>(".chip-row")) {
    let first: HTMLElement | null = null;
    let count = 1;

    const flush = () => {
      if (first && count > 1) first.querySelector(".chip-label")?.append(` ×${count}`);
    };

    for (const node of Array.from(row.children)) {
      if (first && node.matches(".chip") && key(node) === key(first)) {
        node.remove();
        count += 1;
        continue;
      }
      flush();
      first = node instanceof HTMLElement && node.matches(".chip") ? node : null;
      count = 1;
    }
    flush();
  }
}

/**
 * 核对判继续时，上一份回答不再算数：从对话里拿掉，屏幕上同一件事只留一份回答。
 * 那一轮留着过程时收进它的过程；只读的一轮收尾时不留过程，就直接拿掉最近那份回答。
 */
function supersedeAnswer(run: RunHost | null): void {
  const el = run?.answer?.el ?? latestAnswerEl();

  if (!el?.isConnected) return;

  if (run?.answer) {
    const old = document.createElement("div");
    old.className = "run-superseded";
    old.textContent = `第一次的回答：${run.answer.text.replace(/\s+/g, " ").trim()}`;
    run.body.insertBefore(old, run.body.querySelector(":scope > .run-total"));
  }
  el.remove();
}

/** 最近一条用户消息之后的最后一份正式回答（不含「收到」这类确认语和开场话）。 */
function latestAnswerEl(): HTMLElement | null {
  for (let node = messagesEl.lastElementChild; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant[data-delivery-id]:not(.opening-line)") && node.dataset.deliveryKind !== "ack") return node;
  }

  return null;
}

/** 比较旁白和回答时不看空白和 Markdown 记号。 */
function comparableText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[\s*_`#>~|-]/g, "");
}

/**
 * 回答出现后，这一轮只留一个结论（#334）：开场话收进过程顶部（安静的一行计划）、读回收到步骤后面、
 * 与回答逐字相同的「执行过程」旁白删掉；过程行改写成「做了 N 步 · 耗时 · 核对状态」。进行中不调用。
 */
function foldAnsweredRun(run: RunHost): void {
  const answer = run.answer;

  if (!answer || !run.receipt) return;

  // 最后一步没做成、随后交了回答：这一轮做完了，过程行照常写核对结论，没做成的那几步在展开的过程里。
  // 计划卡不改：整轮停在没做成，卡头仍写「没做完」，和换了做法后做完的 completed 分开。
  if (run.receipt.ended === "failed" && run.orbActivity.onlyStepFailed() && !run.root.classList.contains("plan-card")) {
    run.receipt.ended = "completed";
    run.receipt.head = finishedRunTitle(run.receipt.steps - run.receipt.failed, "completed");
  }
  const openings: HTMLElement[] = [];

  for (let node = run.root.previousElementSibling; node && !node.matches(".msg.user, details.run-steps, .redo-anchor"); node = node.previousElementSibling) {
    if (node instanceof HTMLElement && node.matches(".opening-line")) openings.unshift(node);
  }

  for (const line of openings.reverse()) {
    line.classList.remove("msg", "assistant");
    line.classList.add("run-plan");
    run.body.prepend(line);
  }

  if (run.evidence && run.evidence.parentElement !== run.body) run.body.insertBefore(run.evidence, run.body.querySelector(":scope > .run-total"));
  const said = comparableText(answer.text);
  const shown = comparableText(answer.el.textContent ?? "");

  for (const narration of run.body.querySelectorAll<HTMLElement>(":scope > details.thinking.narration")) {
    const text = comparableText(narration.querySelector("pre")?.textContent ?? "");

    if (text && (text === said || text === shown)) narration.remove();
  }

  paintAnsweredTitle(run);
}

/** 「继续原任务」卡这时在对话里显示着。 */
function resumeCardShown(): boolean {
  const root = document.getElementById("resume-entry-root");

  return !!root?.isConnected && !root.hidden && root.childElementCount > 0 && !!root.closest("#messages");
}

/** 过程行上的核对状态：核对中…、已核对页面（绿）；没做完时写有 N 步没做成（橙），已有续做卡时由卡说。 */
function runCheckStatus(run: RunHost): { text: string; tone: "ok" | "warn" | null } | null {
  if (!run.receipt || run.receipt.ended !== "completed") return null;

  if (run.check === "checking") return { text: "核对中…", tone: null };

  if (run.check === "done") return { text: "已核对页面", tone: "ok" };
  const notDone = run.receipt.failed ? `有 ${run.receipt.failed} 步没做成` : "还没做成";

  // 核对判没做完：回答下面有「继续原任务」卡时由它说还差什么并给按钮，过程行不说第二遍；没有卡时过程行说。
  if (run.check === "not_done") return resumeCardShown() ? null : { text: notDone, tone: "warn" };

  // 判继续：下一块过程接着做；等用户回答：回答里已经在问。这两种这一行都不下结论。没核对或核对没结论时，宿主补过一句就照它说没做成。
  if (run.check !== "continued" && run.check !== "needs_user" && run.answer?.hostNote) return { text: notDone, tone: "warn" };

  return null;
}

/** 核对确认做完时回执前的绿对勾。当场核对完的那一次一笔画出来；之后重画和从记录重放都直接是画好的样子。 */
function doneMark(run: RunHost): HTMLElement {
  const mark = document.createElement("span");
  mark.className = "run-done-mark";
  mark.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M3.5 8.5l3 3 6-7");
  path.setAttribute("pathLength", "1");
  svg.append(path);
  mark.append(svg);

  if (!run.doneMarkShown && !replayingHistory) mark.classList.add("fresh");
  run.doneMarkShown = true;

  return mark;
}

function paintAnsweredTitle(run: RunHost): void {
  const title = run.titleEl;

  if (!run.receipt || !title) return;
  clearTimeout(run.titleTimer);
  const verb = document.createElement("span");
  verb.className = "act-verb";
  verb.textContent = run.receipt.head;
  const tail = document.createElement("span");
  tail.className = "run-receipt-tail";
  tail.textContent = run.receipt.total ? ` · ${run.receipt.total}` : "";
  const status = runCheckStatus(run);
  const check = document.createElement("span");
  check.className = "run-check";
  check.textContent = status ? ` · ${status.text}` : "";

  if (status?.tone) check.dataset.tone = status.tone;
  title.classList.add("run-receipt");
  // 回执这一行会重画好几次：已有的对勾留在原处，不拆下来重插，画到一半的那一笔才不会断。
  const kept = status?.tone === "ok" ? title.querySelector<HTMLElement>(":scope > .run-done-mark") : null;
  const mark = status?.tone === "ok" ? kept ?? doneMark(run) : null;

  for (const node of [...title.childNodes]) if (node !== mark) node.remove();

  if (mark && !mark.isConnected) title.prepend(mark);
  title.append(verb, tail, check);
}

/**
 * 过程行放在这一轮用户消息（和它的 chip、「收到」这类确认语）之后、回答之前：先看到做了什么，再看结论。
 * 回答可能在过程块创建前就已开始渲染，所以结束时按位置规则摆放，而不是依赖事件先后。
 */
function placeProcessBeforeAnswer(root: HTMLElement): void {
  let anchor: Element | null = root.previousElementSibling;

  while (anchor && !anchor.classList.contains("user")) anchor = anchor.previousElementSibling;

  if (!anchor) return;
  // 核对判继续后接着做的一轮：排在判继续那一刻留下的定位点之后。
  let redo: Element | null = null;

  for (let node = anchor.nextElementSibling; node && node !== root; node = node.nextElementSibling) {
    if (node.classList.contains("redo-anchor")) redo = node;
  }

  if (redo) { if (redo.nextElementSibling !== root) redo.after(root); return; }
  let next = anchor.nextElementSibling;

  // chip 跟着用户消息（chip C），「收到」这类确认语和开场话也留在前面；夹在开场话前面的任务卡之后会移到回答后面，不挡住它。
  // 核对判继续后接着做的一轮：排在前一轮的过程和读回之后，不插到它们前面。
  const keepsBefore = (node: HTMLElement) => node.dataset.deliveryKind === "ack" || node.matches(".opening-line, .ctx-chips, .steer-received, details.run-steps.done, .run-live-graph, .fill-evidence")
    || (node.matches(".ai-task-card") && !!node.nextElementSibling?.matches(".opening-line"));

  while (next instanceof HTMLElement && next !== root && keepsBefore(next)) next = next.nextElementSibling;

  if (next && next !== root && next.parentNode === messagesEl) messagesEl.insertBefore(root, next);
}

function cardTurn(root: HTMLElement): boolean {
  let node = root.previousElementSibling;

  while (node && !node.matches(".msg.user")) node = node.previousElementSibling;

  return !!node?.classList.contains("card-turn");
}

/** 步骤容器：run 进行中进聚合块，否则直接进消息流。 */
function stepsContainer(): HTMLElement {
  return currentRun?.body ?? messagesEl;
}

function closeBlocks(): void {
  if (currentAssistant) {
    const answer = currentAssistant;
    // 最终稿放完后再挂复制按钮：放字期间每帧重渲染正文，先挂的按钮会被冲掉。
    revealText(answer, currentAssistantText, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd, after: () => attachAnswerActions(answer) });
  }

  // 流式光标移除；进行中的思考块折叠并落定文案（带耗时）
  document.querySelector(".msg.assistant.streaming")?.classList.remove("streaming");

  if (currentThinkingDetails) {
    orbByHost.get(currentThinkingDetails)?.setRunning(false);
    currentThinkingDetails.classList.remove("streaming");
    currentThinkingDetails.open = false;
    const label = currentThinkingDetails.querySelector("summary span");

    const thinkFrom = Number(currentThinkingDetails.dataset.thinkFrom);
    const thinkTo = Number(currentThinkingDetails.dataset.thinkTo);

    if (label && Number.isFinite(thinkTo)) {
      if (thinkTo - thinkFrom < SHOW_SECS_MS) label.textContent = `思考过程${recordedDuration(thinkFrom, thinkTo) ? ` ${recordedDuration(thinkFrom, thinkTo)}` : ""}`;
      label.classList.add("settle-once");
      window.setTimeout(() => label.classList.remove("settle-once"), 400);
    } else if (label) {
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
let quietTimer = 0;

function quietRunForProse(): void {
  const run = currentRun;

  // 计划卡留到这一轮结束：计划是这一轮的承诺，不因先出字就收掉。
  if (!run || run.body.querySelector(".chip") || run.root.classList.contains("plan-card")) return;
  // 首字到达立刻停表，不留 0 秒，也不再累加（#311）。
  stopLiveSeconds(run);
  run.thinkFrom = Number.NaN;
  run.timeEl.textContent = "";
  clearTimeout(quietTimer);
  quietTimer = 0;
  const root = run.root;

  if (applyingHistory || reducedMotion()) {
    root.classList.remove("run-quieting");
    root.hidden = true;

    return;
  }

  root.classList.add("run-quieting");
  quietTimer = window.setTimeout(() => {
    quietTimer = 0;

    if (!root.isConnected) return;

    if (run.body.querySelector(".chip")) {
      root.classList.remove("run-quieting");

      return;
    }

    root.hidden = true;
    root.classList.remove("run-quieting");
  }, D_STATE);
}

/** 模型直接写的正文：没调过工具时放在回答位置逐段显示；新一轮的正文出现时，上一轮那段只是过程。 */
function appendLeadAnswer(delta: string): void {
  // 过程行照常在跑：停止、出错时这段正文按原样收进去，过程行也随之保留。
  const run = ensureRun();

  if (leadAnswer && leadAnswerTurnClosed) foldLeadAnswer();

  if (!leadAnswer) {
    // 这一轮出过字，骨架就不再回来：这段正文之后被收进过程时，回答位置空着也不再放骨架。
    run.skeleton.dataset.state = "gone";
    quietRunForProse();
    leadAnswer = addMsg("msg assistant markdown streaming", "");
    leadAnswerText = "";
    leadAnswerTurnClosed = false;
    steerRibbon.decorate(leadAnswer, !replayingHistory);
  }

  leadAnswerText += delta;
  revealText(leadAnswer, leadAnswerText, { render: renderMarkdown, live: !replayingHistory, final: false, onProgress: scrollToEnd });
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

/** 开场话定稿后放到过程行前面；之后的回答另起气泡，不接到它后面。 */
function keepOpeningLine(line: HTMLElement): void {
  revealText(line, leadAnswerText, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd });
  line.classList.remove("streaming");
  line.classList.add("opening-line");

  if (currentRun) messagesEl.insertBefore(line, currentRun.root);
  leadAnswer = null;
  leadAnswerText = "";
  leadAnswerTurnClosed = false;
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
    if (!currentAssistant) {
      if (currentRun) currentRun.skeleton.dataset.state = "gone";
      currentAssistant = addMsg("msg assistant markdown streaming", "");
    }
    currentAssistantText += delta;
    revealText(currentAssistant, currentAssistantText, { render: renderMarkdown, live: !replayingHistory, final: false, onProgress: scrollToEnd });
  } else {
    if (!currentThinking) {
      addChainStep("思考");
      currentThinkingStart = eventTime();
      const details = document.createElement("details");
      details.className = "thinking streaming";
      details.open = true;

      // 这段思考结束时（closeThink）把标题改成「想了 N 秒」，不再另加一行（#263）。
      if (currentRun && Number.isFinite(currentRun.thinkFrom)) details.dataset.thinkFrom = String(currentRun.thinkFrom);
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

let handoffCard: HTMLElement | null = null;

/** 「需要你来这一步」卡：交还前一直在；交还后收成一行灰字。 */
function showHandoffCard(ask: string): void {
  const card = document.createElement("div");
  card.className = "handoff-card";
  const title = document.createElement("strong");
  title.textContent = "需要你来这一步";
  const body = document.createElement("p");
  body.className = "handoff-ask";
  body.textContent = ask;
  const note = document.createElement("p");
  note.className = "handoff-note";
  note.textContent = "交给你期间，我不读也不动这个页面。";
  const actions = document.createElement("div");
  actions.className = "handoff-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn-primary";
  done.textContent = "做好了，交还";
  done.onclick = () => port?.postMessage({ kind: "control", action: "handback", conversationId: selectedConversationId } satisfies PanelToBg);
  const hint = document.createElement("span");
  hint.className = "handoff-note";
  hint.textContent = "或点页面右边的「继续」";
  actions.append(done, hint);
  card.append(title, body, note, actions);
  appendToMessages(card);
  scrollToEnd();
  handoffCard = card;
}

function collapseHandoffCard(text = "你已交还 · 我从你所在的页面接着做"): void {
  if (!handoffCard) return;
  handoffCard.className = "handoff-done";
  handoffCard.textContent = text;
  handoffCard = null;
}

function changesPage(name: string, tabsAction: string | undefined): boolean {
  // 开、关标签页也是用户看得见的后果；tabs 的其余动作只是查看。
  if (name === "tabs") return tabsAction === "open" || tabsAction === "close";

  return isWriteTool(name) && !PAGE_VIEWING_TOOLS.has(name);
}

function onToolStart(ev: { toolCallId: string; name: string; params: Record<string, unknown> }): void {
  const action = describeTool(ev.name, ev.params);
  const run = ensureRun();
  closeBlocks();
  // 想完了，开始动手（交付、交给用户也算）：这段思考到此为止（#263）。
  closeThink(run, eventTime());

  // 助手把页面交给用户：不进步骤链，单独一张卡。
  if (ev.name === "hand_to_user") {
    run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
    syncRunOrb(run);
    run.graph.user(true);
    showHandoffCard(String(ev.params.ask ?? ""));

    return;
  }

  // 交还后助手又动手了（补放历史时也一样）：卡不能再留着可点的「交还」。
  collapseHandoffCard();

  // 交付回答是助手的内部记账，不算用户看得懂的一步。
  if (BOOKKEEPING_TOOLS.has(ev.name)) {
    run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
    syncRunOrb(run);

    return;
  }

  run.root.classList.remove("run-quieting");
  run.root.hidden = false;
  startLiveSeconds(run);
  addChainStep(action.short);
  run.lastToolShort = action.short;

  // #58 C 取代 #47 的自动展开：进行中只有一行「正在…」，做过的步骤收在 › 里。

  if (!run.chipGroup) run.chipGroup = buildChipGroup(run.body);
  const group = run.chipGroup;

  const prep = isPrepTool(ev.name, ev.params);
  run.readingTools.set(ev.toolCallId, prep);
  run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
  syncRunOrb(run);

  // 教学的步骤行就是这一轮的结果（用户自己点过的每一步），收尾时要留下。
  if (ev.name === "guide_step" || changesPage(ev.name, typeof ev.params.action === "string" ? ev.params.action : undefined)) run.changedPage = true;

  const kind: IconKind = prep ? "read" : actionKind(ev.name, ev.params);

  run.lastToolName = ev.name;

  if (orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    setRunTitle(run, `正在${actionCardLabel(ev.name, ev.params)}`, false, kind);
  }

  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = prep ? "chip prep" : "chip";
  chip.dataset.kind = kind;
  chip.dataset.past = pastAction(ev.name, ev.params);
  chip.dataset.short = shortAction(ev.name, ev.params);
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
  if (typeof ev.params.target === "string" && ev.params.target) chip.dataset.pageTarget = ev.params.target;
  chip.dataset.stepIndex = String(group.row.querySelectorAll(".chip").length + 1);
  bindStepInspect(chip);

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
  run.graph.start({
    id: ev.toolCallId,
    name: ev.name,
    params: ev.params,
    label: shortAction(ev.name, ev.params),
    url: typeof ev.params.url === "string" ? ev.params.url : undefined,
  });
  scrollToEnd();
}

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string; reason?: string; repeatRefused?: true; heldReason?: HeldReason; sendConfirmed?: true; pageTarget?: { target: string; label: string; tabId: number; url: string } }): void {
  // 10-09/10-10 存下的侧栏历史只有旧标记 sendDeclined、没有原因：按「不发」画，不画成失败；那段历史不再要紧时删掉这一行。
  if (!ev.heldReason && (ev as { sendDeclined?: unknown }).sendDeclined === true) ev = { ...ev, heldReason: "declined" };
  const run = currentRun ?? lastRun;

  if (run && ev.heldReason === "declined") run.sendDeclined = true;
  if (run && ev.sendConfirmed) run.sendDeclined = false;

  if (run) {
    run.readingTools.delete(ev.toolCallId);
    run.orbActivity.observe({ kind: "tool_end", name: "", ...ev });
    syncRunOrb(run);
  }

  const entry = toolChips.get(ev.toolCallId);
  toolChips.delete(ev.toolCallId);

  // 这一步做完、下一步还没开始：模型在想下一步。第一行只写「正在思考」并从这里开始数秒，做了几步在第二行（#263）。
  if (run && run === currentRun && !toolChips.size && orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    run.lastToolName = null;
    setRunTitle(run, "正在思考", false, "think");
    openThink(run, eventTime());
  }

  if (!entry) return;
  // 用户拒绝授权、没让发送的那一步照你的意思没做：不画成失败。
  const failed = ev.isError && !ev.repeatRefused && !ev.heldReason;
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

  const end = eventTime();
  // 记录里只给 ≥3 秒的一步写秒数（#263）；历史回放没有时钟就不写。
  const slow = Number.isFinite(entry.start) && Number.isFinite(end) && end - entry.start >= SHOW_SECS_MS;
  entry.dur.hidden = !slow;
  entry.dur.textContent = slow ? spokenDuration(entry.start, end) ?? "" : "";

  if (failed) entry.chip.classList.add("error");

  if (ev.pageTarget) {
    if (ev.pageTarget.target) entry.chip.dataset.pageTarget = ev.pageTarget.target;
    if (ev.pageTarget.url) entry.chip.dataset.pageUrl = ev.pageTarget.url;
    if (ev.pageTarget.tabId) entry.chip.dataset.pageTab = String(ev.pageTarget.tabId);
  }

  const label = entry.chip.querySelector<HTMLElement>(".chip-label");
  // 打开页面：拿到标题后用页面名，不用网址（#102）。页面标题来自网页，只作文字显示。
  const pageTitle = !failed && entry.chip.dataset.kind === "open" ? openedPageTitle(ev.resultText ?? "") : null;

  if (ev.pageTarget?.label && label && !pageTitle && !ev.heldReason) {
    const next = actionCardLabel(entry.name, {}, ev.pageTarget.label);
    entry.chip.dataset.past = next;
    entry.chip.dataset.short = next;
    paintAction(label, next);
  }

  if (pageTitle && label) {
    entry.chip.dataset.past = `打开了 ${pageTitle}`;
    entry.chip.dataset.short = shortAction("navigate", {}, pageTitle);
    paintAction(label, `打开页面 ${pageTitle}`);
  }

  if (ev.repeatRefused && label) label.append("（已做过，没再重复）");

  // 发送确认：确认过的照常写点了，没让发的写结果。
  if (ev.sendConfirmed && label) {
    entry.chip.dataset.past = `${entry.chip.dataset.past ?? ""}（你确认过）`;
    label.append("（你确认过）");
  }

  if (ev.heldReason && label) {
    const text = HELD_TEXT[ev.heldReason];
    entry.chip.dataset.past = text;
    label.textContent = text;
  }

  if (failed && label) {
    const note = document.createElement("span");
    note.className = "act-failed";
    note.textContent = ` · ${ev.reason ?? "没做成"}`;
    label.append(note);
  }

  run?.graph.end(ev.toolCallId, {
    failed,
    reason: ev.reason ?? (failed ? plainToolError(ev.resultText ?? "") : undefined),
    result: pageTitle ?? (failed ? undefined : entry.chip.dataset.short),
    label: entry.chip.dataset.short ?? undefined,
  });

  const text = ev.resultText ?? "";

  if (text) entry.resultText = text.length > 800 ? `${text.slice(0, 797)}...` : text;

  // 详情正展开着这个 chip 时实时补上结果
  if (entry.group.expanded === entry) renderChipDetail(entry);

  if (run && run === currentRun) renderRunMeta(run);

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

/** 填写之后网页里这一栏的实际内容：程序读回，不经助手转述（R1）。敏感栏不显示。 */
function showReadback(readback: NonNullable<Extract<AgentUiEvent, { kind: "tool_end" }>["readback"]>, key: string): void {
  const line = evidenceLine(readback, key);
  const run = currentRun;

  if (!line || !run) return;
  run.evidenceLines = mergeEvidence(run.evidenceLines, line);

  if (!run.evidence) {
    run.evidence = document.createElement("div");
    run.evidence.className = "fill-evidence";
    (run.trail.isConnected ? run.trail : run.root).after(run.evidence);
  }

  run.evidence.replaceChildren(...run.evidenceLines.map(({ field, value }) => {
    const row = document.createElement("div");
    row.className = "fill-evidence-line";
    const label = document.createElement("b");
    label.textContent = `${field}现在是：`;
    row.append(label, `「${value}」`);

    return row;
  }));
  scrollToEnd();
}

/** 读回按哪一栏记（R1、R2）：工具开始时记下填写的目标和当时的工作标签页，结束时用它区分同名的两栏。 */
let workingTabKey = "tab-start";
const fieldTargets = new Map<string, { target: unknown; tab: string }>();

function noteFieldTarget(ev: AgentUiEvent): void {
  if (ev.kind !== "tool_start") return;
  workingTabKey = nextWorkingTab(workingTabKey, ev.name, ev.params, ev.toolCallId);
  fieldTargets.set(ev.toolCallId, { target: ev.params.target, tab: workingTabKey });
}

function fieldKeyOf(toolCallId: string, readback: FieldReadback): string {
  const start = fieldTargets.get(toolCallId);

  return readbackKey(start?.target, start?.tab ?? workingTabKey, readback);
}

function handleAgentEvent(ev: AgentUiEvent, sessionId?: string, runId?: string | null): void {
  // 并行助手已删除：非主会话的事件不再出现，出现也不渲染。
  if (sessionId && !isLeadSession(sessionId)) return;

  if (!replayingHistory) observeForCue(ev);
  noteFieldTarget(ev);

  const progressRun = currentRun ?? lastRun;

  if (progressRun && (ev.kind === "error" || ev.kind === "agent_end" || ev.kind === "run_stopped")) { progressRun.orbActivity.observe(ev); syncRunOrb(progressRun); }

  switch (ev.kind) {
    case "thinking_level":
      if (!replayingHistory) modelMenu.thinking(ev);
      break;
    case "memory":
      if (ev.action === "used") noteMemoryUsed(ev);
      // 网站规则已有具体内容与删除入口，保存事件只用于版本同步，不重复画一行。
      else if (!(ev.action === "saved" && ev.entries.some(entry => [...memoryAskCards.values()].some(card => card.ask.learned?.id === entry.id)))) renderMemoryReceipt(ev);
      refreshMemoryIfStale(ev.rev);
      break;
    case "memory_ask":
      renderMemoryAsk(ev);
      break;
    case "site_notes":
      renderSiteNotesReceipt(ev);
      break;
    case "text_delta":
      // 回答开始出字：这段思考结束（#263）。
      if (currentRun) closeThink(currentRun, eventTime());

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
      // 第一次动手前的那句是开场话（做什么、不碰什么）：留在过程行前面，不收起，也不当回答。
      if (leadDeliveryMode === "explicit") {
        if (!leadToolUsed && leadAnswer && leadAnswerText.trim()) keepOpeningLine(leadAnswer);
        else foldLeadAnswer();
        leadToolUsed = true;
      }

      onToolStart(ev);
      break;
    case "send_confirm_wait": {
      // 所有发送路径都以确认事件为准，脚本工具的结果格式不影响拒绝后的回答入口。
      const run = currentRun;
      if (run && ev.confirm?.outcome === "decline") run.sendDeclined = true;
      if (run && ev.confirm?.outcome === "send" && ev.confirm.clicked === "yes") run.sendDeclined = false;
      const card = sendConfirmCard(ev.confirm);

      if (card) {
        appendToMessages(card);
        scrollToEnd();
      }

      // 确认之后点没点下去的补报：等待早就结束了，只更新卡。
      if (ev.confirm?.clicked) break;

      // 新会话第一轮经补放历史到达（applyingHistory 为真），所以补放时也照样换标题。
      // 等你确认的时间不算「想了」（#263）。
      if (run) {
        setRunTitle(run, ev.waiting ? "等你确认发送" : "正在思考", true, ev.waiting ? undefined : "think");
        // 等你的时候过程行不扫光、回答位置不放骨架；这一步的工具还在途，所以 data-phase 仍是 executing。
        run.root.toggleAttribute("data-wait-user", ev.waiting);

        if (ev.waiting) closeThink(run, eventTime());
        else openThink(run, eventTime());
      }

      // 「不等了」不一定带 guide，到这里的也可能是教学一步结束：橙字一起清掉。
      if (run && !ev.waiting && run.guideHint) {
        run.guideHint = null;
        renderTrail(run);
      }

      break;
    }
    case "guide_wait": {
      // 教学一步在等用户自己点：标题写第几步在等你；点了没变化再加一行橙字；不等了回到「做了几件事」。
      const run = currentRun;

      if (!run) break;
      const waiting = ev.waiting && ev.guide;
      setRunTitle(run, waiting ? `第 ${waiting.step} 步 · 等你操作` : "正在思考", true, waiting ? undefined : "think");
      run.root.toggleAttribute("data-wait-user", !!waiting);

      // 等你自己点的时间不算「想了」（#263）。
      if (waiting) closeThink(run, eventTime());
      else openThink(run, eventTime());
      run.guideHint = waiting && waiting.state === "no_change" ? (waiting.target ? `点了「${waiting.target}」，页面没有变化` : "点了，页面没有变化") : null;
      renderTrail(run);
      break;
    }
    case "tool_end":
      onToolEnd(ev);

      if (ev.readback && !ev.isError) showReadback(ev.readback, fieldKeyOf(ev.toolCallId, ev.readback));
      fieldTargets.delete(ev.toolCallId);
      break;
    case "agent_start":
      if (!citationRequestPending) currentCitationSource = null;

      citationRequestPending = false;

      if (!runId || runId === conversations.get(selectedConversationId)?.runId) noteRunStarted(runId);

      // 上一轮还在「核对中…」就开始了新一轮（含不动手的问答）：那次核对作废、不会再有结论，过程行不再写核对中。
      if (lastRun && lastRun !== currentRun && lastRun.check === "checking" && lastRun.root.dataset.runId !== runId) {
        lastRun.check = "unavailable";

        if (lastRun.answer && lastRun.root.isConnected) paintAnsweredTitle(lastRun);
      }
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

      // 回答之后宿主自己接着做：标题说明为什么又动起来，第二行写核对发现了什么，直到这一轮结束（#105）。
      if (goalNote !== null) {
        const run = ensureRun();
        setRunTitle(run, goalStep ? `还在做第 ${goalStep.at} 件（共 ${goalStep.of} 件）` : "还没做完，接着做", true, "think");
        run.checkNote = goalNote;
        renderRunMeta(run);
        goalNote = null;
        goalStep = null;
      }

      break;
    case "goal_check": {
      goalNote = ev.status === "continue" ? checkNoteForUser(ev.finding, ev.remaining) : null;
      goalStep = ev.status === "continue" ? ev.step ?? null : null;

      // 用户说了不止一件事：回答扣到核对之后，这几秒过程行写在对清单，不让屏幕停着。
      if (ev.status === "checking" && ev.gate && currentRun) setRunTitle(currentRun, "正在对一遍还有没有没做的", true, "think");
      // 核对结论写在这一轮的过程行上（核对中… → 已核对页面 / 有 N 步没做成）。checking 在 agent_end 之前到，结论在收尾之后到。
      const checked = currentRun ?? lastRun;

      if (checked) {
        checked.check = ev.status === "checking" ? "checking" : ev.status === "done" ? "done" : ev.status === "continue" ? "continued" : ev.status === "needs_user" ? "needs_user" : ev.status === "unavailable" ? "unavailable" : "not_done";

        if (checked.answer && checked !== currentRun && checked.root.classList.contains("done")) paintAnsweredTitle(checked);
      }

      // 核对判继续：这份回答不算数了，收进它那一轮的过程（只读的一轮不留过程，直接拿掉）；核对发现写在续做那一轮的过程行上。
      // 续做的过程排在这一刻的对话末尾之后：留一个看不见的定位点，代替原来那行「核对发现」。
      // 回答没出过（交付前对清单扣下了）：没有要收起的回答，这一轮接着在同一块过程里做。
      if (ev.status === "continue" && !ev.held) {
        supersedeAnswer(checked?.answer ? checked : null);
        const anchor = document.createElement("div");
        anchor.className = "redo-anchor";
        anchor.hidden = true;
        appendToMessages(anchor);
      }
      break;
    }
    case "turn_end":
      closeBlocks();
      break;
    case "context_usage":
      modelMenu.usage({ used: ev.used, window: ev.window, model: ev.model });
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
      revealText(target, s.text, { render: renderMarkdown, live: !replayingHistory, final: false, onProgress: scrollToEnd });placeStartAcknowledgement(target, s.kind);scrollToEnd();break;
    }

    case "turn_start":
      break;
    case "notice":
      if (ev.aside) {
        // 只对这一轮有用：跟在过程行下方，回合结束随最近几步收起。新会话第一轮经补放历史到达，所以补放时也挂上；
        // 已结束的历史里没有在跑的一轮，不再出现。没有在跑的一轮的实时说明照旧进消息流。
        if (currentRun) {
          currentRun.aside = ev.message;
          renderTrail(currentRun);
        } else if (!applyingHistory) {
          addMsg("msg notice", ev.message);
        }
      } else if (ev.progress) {
        // 进度说明只属于正在跑的这一轮：放进过程行标题，不在对话里留下一句过时的话。
        // 不为它新建过程行：压缩可能发生在回合结束后，新建的行不会再收尾。
        if (currentRun && !applyingHistory) setRunTitle(currentRun, ev.message);
      } else if(ev.plan){
        const key=`plan:${ev.plan.conversationId}:${ev.plan.id}`;
        const text=`语音计划 · 共${ev.plan.steps.length}步\n`+ev.plan.steps.map((s,i)=>`${i+1}. ${s.targetTitle??'目标会话'} · ${s.receipt?.message??(s.status==='pending'?'结果未知':'没做')}\n${s.text}`).join('\n');
        const previous=receiptMessages.get(key);

if(previous)previous.textContent=text;else receiptMessages.set(key,addMsg('msg notice',text));
      }else if (ev.receipt) {
        // 任务条材料只认这张回执：accepted/applied 才把这次发出的材料升级为「已随任务送入」。
        taskBar.noteReceipt(ev.receipt);

        // 插话没被采纳：下一段回答不是按它写的，不挂「已改方向」。
        if (ev.receipt.action === "steer" && (ev.receipt.status === "rejected" || ev.receipt.status === "failed")) steerRibbon.reset();
        // 新任务没被接下（例如还没连模型）：这一轮不会开始，计划行也不该留着。
        if (ev.receipt.action === "start" && (ev.receipt.status === "rejected" || ev.receipt.status === "failed") && ev.receipt.conversationId === selectedConversationId) taskPlan.endRun();

        if (ev.receipt.conversationId === selectedConversationId) {
          if (ev.receipt.action === "abort") {
            if (ev.receipt.status === "accepted" || ev.receipt.status === "applied") taskBar.noteStopAccepted();
            else if (ev.receipt.status === "rejected" || ev.receipt.status === "failed") taskBar.noteControlResult("stop", false, ev.receipt.message);
          }
        }

        resumeEntry.noteReceipt(ev.receipt);

        if (isSeparateAsk(ev.receipt)) { renderSeparateAsk(ev.receipt); scrollToEnd(); break; }
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

        // 只认领这个面板刚交出的那条：知道它问的是哪一页才自动重发。回放的旧卡片、语音发的话都请用户自己再发。
        if (ev.receipt.needsModel && ev.receipt.text.trim()) {
          if (!replayingHistory && lastSentPage?.requestId === ev.receipt.requestId) {
            const bubble = lastUserBubbleFor(ev.receipt.text);
            holdPendingMessage(receipt, bubble);
            resendAfterConnect.set(ev.receipt.conversationId, { text: ev.receipt.text, page: lastSentPage.page, card: receipt, bubble });
          } else noteNeedsModelManual(receipt);
        }

        if (restoreFocus) receipt.querySelector<HTMLElement>('summary,button')?.focus({preventScroll:true});
        scrollToEnd();
      } else addMsg("msg notice", ev.message);
      break;
    case "error": {
      const copy = describeModelError(ev.message);

      if (copy) errorCards.show(copy, !replayingHistory);
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
      summary: answerSpeech(delivery.text).trim().slice(0, 160),
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
    revealText(answer, delivery.text, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd,
      after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') { attachAnswerActions(answer, delivery); attachDeliverySources(answer, delivery); } } });
    existing!.dataset.deliveryKind = delivery.kind;
    placeStartAcknowledgement(existing!, delivery.kind);
    existing!.dataset.deliveryStatus = delivery.status;
    voiceUI.deliver?.(delivery);

    noteRunAnswer(delivery, answer);
    scrollToEnd();
    scheduleDeliveryVisible(existing!, receivedAt);

    return;
  }

  voiceUI.deliver?.(delivery);

  const bubble = addMsg("msg assistant markdown", "");
  steerRibbon.decorate(bubble, !replayingHistory);
  // 整段一次送达的回答也按同样节奏放出来，不一下子整块冒出。
  revealText(bubble, delivery.text, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd,
    after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') { attachAnswerActions(bubble, delivery); attachDeliverySources(bubble, delivery); } } });
  bubble.dataset.deliveryId = delivery.id;
  bubble.dataset.deliveryKind = delivery.kind;
  bubble.dataset.deliveryStatus = delivery.status;
  deliveredBubbles.set(delivery.id, bubble);
  placeStartAcknowledgement(bubble, delivery.kind);

  noteRunAnswer(delivery, bubble);
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
  return post({ kind: "client", msg: { ...msg, conversationId: msg.conversationId ?? selectedConversationId } });
}

/** 要上行到助手的消息：没连上返回 false；端口可能已失效时先排队，等 pong 再发。 */
function post(envelope: PanelToBg): boolean {
  if (!port || !transportConnected) return false;

  if (queuedSends.length || performance.now() - lastPortMessage > PORT_FRESH_MS) {
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
/** 装好后第一次看到空会话时才播产品名开场；记在本机，换会话、重开侧栏都不再播。 */
const INTRO_SEEN_KEY = "starter_intro_seen";
{
  const canvas = document.querySelector<HTMLCanvasElement>("#starter-orb")!;
  const brand = document.getElementById("starter-brand")!;
  brand.setAttribute("aria-label", "By Your Side");
  brand.append(...Array.from("By Your Side", (ch, i) => {
    const span = document.createElement("span");
    span.textContent = ch;
    span.setAttribute("aria-hidden", "true");
    span.style.setProperty("--i", String(i));
    return span;
  }));
  const glow = document.querySelector<HTMLCanvasElement>("#starter-glow")!;
  let stop: (() => void) | null = null;
  let introPending = false;
  const observer = new IntersectionObserver(([entry]) => {
    if (entry?.isIntersecting && !stop) {
      const stopOrb = mountVoiceOrb(canvas, 56, () => "idle");
      const stopGlow = mountDottedGlow(glow, () => (brand.offsetParent ? brand : canvas));
      stop = () => { stopOrb(); stopGlow(); };
      const starter = document.getElementById("starter")!;
      if (introPending) { introPending = false; starter.classList.add("starter-intro"); void chrome.storage.local.set({ [INTRO_SEEN_KEY]: true }); }
      starter.classList.remove("starter-enter");
      void starter.offsetWidth;
      starter.classList.add("starter-enter");
    } else if (!entry?.isIntersecting && stop) { stop(); stop = null; }
  });
  // 先读完有没有播过，再开始看光球：否则第一帧已经按普通入场播掉了。
  void chrome.storage.local.get(INTRO_SEEN_KEY).then((stored) => {
    introPending = stored[INTRO_SEEN_KEY] !== true;
    observer.observe(canvas);
  }, () => observer.observe(canvas));
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
      const tab = await activeTargetTab({ lastFocused: true });

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
  const labels = { satisfied: "做完了", pending: "还没做", blocked: "没做成", unknown: "结果未知" };

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
    chip.title = "这些材料已发给助手。助手没有核对材料内容。";
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

  (planResumeHost(view.runId) ?? card.querySelector(".ai-task-footer")!).append(resumeRoot);
}

/**
 * 这一轮是计划卡、又没做完或中止：「继续原任务」放进计划卡里，下面不再另起一张卡说同一件事。
 * 挪的是同一个 resume-entry-root，按钮、回执和超时照旧由 ResumeEntry 处理。
 */
function planResumeHost(runId: string | null | undefined): HTMLElement | null {
  const root = planCardRun?.root;

  if (!root?.isConnected || !root.matches(".plan-failed, .plan-stopped")) return null;

  if (runId && root.dataset.runId && root.dataset.runId !== runId) return null;
  let host = root.querySelector<HTMLElement>(":scope > .plan-resume");

  if (!host) {
    host = document.createElement("div");
    host.className = "plan-resume";
    root.append(host);
  }

  return host;
}

/** 计划卡晚于任务视图定下「没做完」时，把已经放进下面那张卡的继续入口挪上来。 */
function adoptPlanResume(): void {
  const resumeRoot = document.getElementById("resume-entry-root");
  const taskCard = resumeRoot?.closest<HTMLElement>(".ai-task-card");

  if (!resumeRoot || !taskCard) return;
  const host = planResumeHost(taskCard.dataset.runId);

  if (host) host.append(resumeRoot);
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
  const hasLearnedRules = [...memoryAskCards.values()].some(card => card.ask.learned);
  memoryDrawerCtrl.refreshIfStale(rev, hasLearnedRules);
}

const inputContext = (): VoiceInputContext => {
  const context: VoiceInputContext = { attachments: attachments?.getAttachments() ?? [] };

  if (pendingAsk) {
    context.context = { tabId: pendingAsk.tabId, title: pendingAsk.title, url: pendingAsk.url, ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}) };
  }

  return context;
};

const voiceUI = mountVoiceUI(composerEl, () => selectedConversationId, send, inputContext);
// 话筒输入文字，声波按钮开启语音对话。
dictationUI = mountDictation({
  composer: composerEl,
  inputEl,
  before: composerEl.querySelector<HTMLElement>(".voice-start")!,
  notice: (text) => addMsg("msg notice", text),
  conversation: () => selectedConversationId,
  voiceBusy: () => document.querySelector<HTMLElement>(".voice-progress")?.hidden === false,
});

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

// 侧栏只看选的是不是 GPT-Live（要走 WebRTC）；值是否有效由宿主判断。
void chrome.storage.local.get(INPROC_VOICE_MODEL_KEY).then((stored) => voiceUI.setVoiceModel(stored[INPROC_VOICE_MODEL_KEY]));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && INPROC_VOICE_MODEL_KEY in changes) voiceUI.setVoiceModel(changes[INPROC_VOICE_MODEL_KEY].newValue);
});

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
        else pending.reject(new Error('新会话已建好，原来的消息还没发出。连接恢复后，再发一次。'));
      }
    }

    if (msg.type === "conversation_created" && msg.requestId === conversationRequest) {
      conversationRequest = null;
      selectConversation(msg.conversation.id);

      if (pendingContinueDraft) {
        inputEl.value = pendingContinueDraft;
        pendingContinueDraft = null;
        inputEl.dispatchEvent(new Event("input", { bubbles: true }));
        autoResize();
        saveDraft();
      }

      if (sendAfterCreate) { sendAfterCreate = false; sendInput(); }
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
    if (msg.type === "model_info" && Array.isArray(msg.models) && msg.models.length > 0) modelMenu.update(undefined, msg.models);

    return;
  }

  switch (msg.type) {
    case "hello_ok":
      setStatus("on", "已连接");
      applyHostFeatures(msg.features);
      modelMenu.update(msg.model, msg.models ?? []);
      noteModelInfo(msg.model, msg.models);
      noteModelPresence(msg.model, msg.models);
      modelMenu.connected();
      break;
    case "model_info":
      modelMenu.update(msg.model, msg.models);
      noteModelInfo(msg.model, msg.models);

      if (msg.model || msg.models?.length) noteModelPresence(msg.model, msg.models);
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

      // 页面归你的时间不算「想了」；交还后模型接着想，从交还那一刻数（#263 E12）。
      if ((msg.sessionId ?? LEAD_SESSION_ID) === LEAD_SESSION_ID && currentRun) {
        if (msg.state === "user") closeThink(currentRun, eventTime());
        else if (msg.state === "running" && !toolChips.size) openThink(currentRun, eventTime());
      }

      // 模型开始前后台要先读页（大页面几秒）：一报「运行中」就出过程行，agent_start 沿用这一行。
      // 不排除补放历史：新会话第一轮正是经补放到达的。
      if (msg.state === "running" && (msg.sessionId ?? LEAD_SESSION_ID) === LEAD_SESSION_ID && awaitingFirstStep()) ensureRun();
      break;
    case "task_view":
      // T05 接续入口：投影摘要 + 恢复按钮；checkpoint 损坏由会话摘要明确指出。
      resumeEntry.apply(msg.view, { checkpointUnavailable: conversations.get(selectedConversationId)?.checkpoint === "unavailable" });

      // 续做卡出现或消失后，上一轮过程行的核对状态跟着改：没做完只说一次。
      if (lastRun?.answer && lastRun.receipt && lastRun.root.classList.contains("done") && lastRun.root.isConnected) paintAnsweredTitle(lastRun);

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

/** 还原状态属于这一轮的回答：最新一条用户消息后面还没有写完的回答时，先不挂，等回答写完再补（adoptFillUndo）。 */
function fillUndoAnswer(): HTMLElement | null {
  const answer = messagesEl.querySelector<HTMLElement>(".msg.assistant.answer-latest");
  const user = Array.from(messagesEl.querySelectorAll<HTMLElement>(".msg.user")).pop();

  if (!answer || (user && answer.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING)) return null;

  return answer;
}

setFillUndoHost({
  send: () => port?.postMessage({ kind: "fill_undo", conversationId: selectedConversationId } satisfies PanelToBg),
  follow: () => scrollToEnd(),
});

function handleBgMessage(envelope: BgToPanel): void {
  if (envelope.kind === "fill_undo") {
    if (envelope.conversationId && envelope.conversationId !== selectedConversationId) return;
    noteFillUndo(envelope.undo, envelope.refused, fillUndoAnswer());
    // 新一轮开始时后台推 null：已撤销、收不回是上一张卡的结论，留着；只有还能撤销的才收掉。
    if (envelope.undo) {
      planUndo = envelope.undo;
      paintPlanCard();
    } else if (planUndo?.state === "ready") retirePlanCard();

    return;
  }

  if (envelope.kind === "pong") {
    lastPortMessage = performance.now();
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

    // 后台先记下每一条再广播，随后的回放已含这条；先放实时条会抬高 lastHistorySeq，回放就整段被跳过。
    if (!historyPrimed && envelope.replay !== true) return;

    applyHistory(envelope.entries, envelope.replay === true);

    return;
  }

  if (envelope.kind === "synced") {
    // 同步回放总以 synced 收尾（background syncPanel）：此时历史已补齐，可以判断旧端口上的消息是否丢了。
    restoreLostSend();
    // 后台先补发还原状态、再回放历史：历史放完后才知道哪条是这一轮的回答。
    const undoAnswer = fillUndoAnswer();

    if (undoAnswer) {
      adoptFillUndo(undoAnswer);
      const undo = fillUndoOf(undoAnswer);
      if (undo && lastRun?.receipt && planCardAnswer(lastRun) === undoAnswer) {
        planCardRun = lastRun;
        planUndo = undo;
        lastRun.root.classList.add("plan-card");
        paintPlanCard();
      }
    }

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

  if (envelope.kind === "mention_status") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    // 同一标签页可能被好几条消息 @ 过：只改这一条消息下面的胶囊。
    const row = userBubbles.get(envelope.seq)?.nextElementSibling;
    const chip = row instanceof HTMLElement && row.matches(".ctx-chips")
      ? row.querySelector<HTMLElement>(`.ctx-chip[data-tab-id="${envelope.tabId}"]`)
      : null;
    if (chip) {
      chip.dataset.status = envelope.status;
      if (envelope.status === "read" && !chip.querySelector(".ctx-ok")) {
        const ok = document.createElement("span");
        ok.className = "ctx-ok";
        ok.textContent = "✓";
        chip.append(ok);
      }
      if (envelope.reason) chip.title = `${chip.title}\n${envelope.reason}`;
    }

    return;
  }

  if (envelope.kind === "page_refs_found" || envelope.kind === "page_ref_pointed") {
    pageRefWaits.get(envelope.id)?.(envelope.kind === "page_refs_found" ? envelope.names : envelope.ok);
    pageRefWaits.delete(envelope.id);

    return;
  }

  if (envelope.kind === "inspect_step_result") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    if (inspectChip) {
      markChipPageGone(inspectChip, !envelope.ok);
    }

    return;
  }

  if (envelope.kind === "handoff_phase") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    applyHandoffPhase(envelope.phase);

    return;
  }

  if (envelope.kind === "delivery") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;
    const receipt = parseDeliveryReceipt(envelope);

    if (receipt) handleDeliveryReceipt(receipt);

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
    modelMenu.reset();
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

/** 点了「重试」还在等回执的气泡：留着原文，后台说那条历史没了时另发一条；等不到回执就把「重试」还给用户。 */
const pendingRedelivers = new Map<number, { original: ClientMessage; timer: ReturnType<typeof setTimeout> }>();

const REDELIVER_TIMEOUT_MS = 10_000;

function clearPendingRedelivers(): void {
  for (const pending of pendingRedelivers.values()) clearTimeout(pending.timer);
  pendingRedelivers.clear();
}

function enableRetry(bubble: HTMLElement): void {
  const retry = bubble.querySelector<HTMLButtonElement>("button[data-retry]");

  if (!retry) return;
  retry.disabled = false;
  retry.textContent = "重试";
}

/** 拿掉一个旧的用户气泡和它下面的页面卡。 */
function removeUserBubble(seq: number, bubble: HTMLElement): void {
  const chips = bubble.nextElementSibling;

  if (chips instanceof HTMLElement && chips.matches(".ctx-chips")) chips.remove();
  bubble.remove();
  userBubbles.delete(seq);
}

/**
 * background→agent 上行的回执：ok=false 标记未送达并提供「重试」；重试再失败时让「重试」能再点；
 * ok=true（重试送达）去掉标记。只有点了「重试」的侧栏处理 reason：gone（后台已没有那条历史）把原文另发一条、
 * 拿掉旧气泡；resent（别的侧栏刚另发过）只拿掉旧气泡。重复或未知 seq 忽略。
 */
function handleDeliveryReceipt({ seq, ok, text, original, reason }: DeliveryReceipt): void {
  const bubble = userBubbles.get(seq);
  const pending = pendingRedelivers.get(seq);

  if (pending) {
    clearTimeout(pending.timer);
    pendingRedelivers.delete(seq);
  }

  if (!bubble) return;

  if (ok) {
    bubble.classList.remove("undelivered");
    bubble.querySelectorAll(".delivery-tag, button[data-retry]").forEach((el) => el.remove());
    delete bubble.dataset.failed;

    return;
  }

  if (reason) {
    if (!pending) return;

    // 另发的那条会在历史里画出新气泡，所以先确认发出去了再拿掉旧的。
    if (reason === "gone" && !send(pending.original)) {
      enableRetry(bubble);
      noticeSendFailed();

      return;
    }

    removeUserBubble(seq, bubble);

    return;
  }

  if (bubble.dataset.failed === "true") {
    enableRetry(bubble);

    return;
  }

  if (!original || text === undefined) return;
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
    if (!post({ kind: "redeliver", seq, text, conversationId: selectedConversationId })) {
      noticeSendFailed();

      return;
    }

    retry.disabled = true;
    retry.textContent = "已重试";
    clearTimeout(pendingRedelivers.get(seq)?.timer);
    pendingRedelivers.set(seq, {
      original,
      timer: setTimeout(() => {
        pendingRedelivers.delete(seq);
        enableRetry(bubble);
      }, REDELIVER_TIMEOUT_MS),
    });
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
        const steering = running && !entry.item.undelivered;

        if (!running) {
          runStartAt = eventTime();
          if (restoring) {
            const context = entry.item.context;
            const pages = context?.pages ?? [];
            if (taskPlan.shouldAsk(entry.item.text, pages, context?.url ?? "")) {
              taskPlan.announce(entry.item.text, pages, context?.url ?? "", context?.title);
            }
          }
        }
        else if (steering) steerRibbon.noteSteer(entry.item.text);
        confirmSentText(entry.item.text);
        const resent = resending && resending.conversationId === selectedConversationId && resending.text === entry.item.text ? resending : null;
        resending = null;
        resendAfterConnect.delete(selectedConversationId);
        const held = messagesEl.querySelector<HTMLElement>(".msg.user.held-pending");
        const reuse = resent?.bubble?.isConnected ? resent.bubble : held && entry.item.text && (held.querySelector(".user-msg-text")?.textContent ?? held.textContent ?? "").trim() === entry.item.text.trim() ? held : null;
        // 连好模型后的自动重发：原话的气泡已经在上面，不再画第二个。
        const bubble = reuse ?? addUserMsg(entry.item.text, entry.item.attachments);
        bubble.dataset.seq = String(entry.seq);
        userBubbles.set(entry.seq, bubble);
        chapters.noteUserTurn(bubble, entry.item, !running && !lastUserHasPage);

        if (entry.item.card) proactiveCard.turn(entry.item.card, bubble, entry.occurredAt);
        else if (entry.item.context) renderTurnContext(bubble, entry.item.context);

        if (steering && !reuse) markSteerReceived(bubble);

        if (entry.item.undelivered) handleDeliveryReceipt({ seq: entry.seq, ok: false, text: entry.item.text, original: entry.item.undelivered.original });
      }
      else {
        chapters.noteServer(entry.item.msg);
        handleServerMessage(JSON.stringify(entry.item.msg));
      }

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
  lastPortMessage = performance.now();
  watchPort();
  p.onMessage.addListener((msg: BgToPanel) => {
    if (port !== p) return;
    // Any reply proves this port is alive, even while a busy background delays pong.
    lastPortMessage = performance.now();
    pingSentAt = null;
    handleBgMessage(msg);
    flushQueuedSends();
  });
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    port = null;
    pingSentAt = null;
    transportConnected = false;
    voiceUI.disconnect();
    scheduleReconnect();
  });
  const sync: Extract<PanelToBg, { kind: "sync" }> = { kind: "sync", afterSeq: lastHistorySeq };

  if (conversationReady) sync.conversationId = selectedConversationId;
  else {
    const remembered = rememberedConversation();

    if (remembered) sync.conversationId = remembered;
  }
  p.postMessage(sync satisfies PanelToBg);
  // 按住说话、右键提问、阅读转到侧栏交给用户动手的那个窗口里的侧栏；后台从侧栏的上下文里拿不到窗口号。
  // 单独窗口报的是它要操作的那个浏览器窗口，不是它自己。
  void targetWindowId().then(windowId => {
    if (windowId != null && port === p) p.postMessage({ kind: "panel_window", windowId } satisfies PanelToBg);
  }).catch(() => { /* 拿不到窗口号：这些动作跟最近操作的侧栏 */ });
}

function rememberedConversation(): string | undefined {
  try { return sessionStorage.getItem(PANEL_CONVERSATION_KEY) ?? undefined; } catch { return undefined; }
}

// 用户点进哪个侧栏，按住说话、右键菜单就跟哪个侧栏的会话。
function reportFocus(): void {
  try { port?.postMessage({ kind: "focus" } satisfies PanelToBg); } catch { /* 端口刚断，重连时会再报自己的会话 */ }
}

window.addEventListener("focus", reportFocus);
document.addEventListener("pointerdown", reportFocus, true);

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
  console.info("[voice] panel_port_replaced", JSON.stringify({ lastMessageAgeMs: performance.now() - lastPortMessage, pingAgeMs: pingSentAt === null ? null : performance.now() - pingSentAt }));
  const dead = port;
  port = null;
  pingSentAt = null;
  transportConnected = false;
  // Local disconnect does not fire onDisconnect on this side.
  voiceUI.disconnect();

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
  // 程序改输入框（恢复草稿、起点建议、附件增减）都经过这里：发送键的样子跟着变。
  syncSteerSend();
  composerEl.classList.toggle("has-text", Boolean(inputEl.value.trim()));
}

// 侧栏刚打开时宽度还没展开，那一刻算出的高度会按很窄的宽度折行，变宽后要重算。
let inputWidth = 0;
new ResizeObserver(() => {
  if (inputEl.clientWidth === inputWidth) return;
  inputWidth = inputEl.clientWidth;
  autoResize();
}).observe(inputEl);

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

  // 先看这个页面要操作的窗口，再兜底任一活动标签页。
  return activeTargetTab({ lastFocused: true })
    .then((tab) => tab ?? chrome.tabs.query({ active: true }).then(([fallback]) => fallback).catch(() => undefined))
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
  addMsg("msg notice", "这条消息没有发出。侧栏和扩展后台断开了。你的文字和引用都还在。连接恢复后，再发送一次。");
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
  taskPlan.endRun();

  // 自动重发那次没送到：之后用户自己再发同一句，要画新气泡，不能接回上面的旧气泡。
  if (resending?.conversationId === lost.conversationId && resending.text === lost.text) resending = null;

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

/**
 * quick：改方向快捷按钮的原话。只发这句话，不带输入框里的草稿、引用和附件，也不清掉它们。
 * quickPage：quick 这句话问的是哪一页（连好模型后重发时用原来那页）。返回是否交了出去。
 */
function sendInput(quick?: string, quickPage?: PageContext): boolean {
  if (!conversationReady) return false;
  if (!quick && dictationUI?.busy()) {
    addMsg("msg notice", "请先结束说话输入，等文字出现后再发送。按 Esc 可以取消。");
    return false;
  }

  // 点「新会话」后、新会话建好前：选中的还是旧会话，现在发会落进旧会话。等建好再发。
  if (conversationRequest && !quick) { sendAfterCreate = true; return false; }
  const held=panelLive(sessionRun.values(), teamView).userHasPage;

  // 语音输入或粘贴偶尔带进看不见的控制字符（如退格 \b），发出去前去掉；换行和制表保留。
  const text = Array.from(quick ?? inputEl.value).filter((ch) => {
    const code = ch.charCodeAt(0);

    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("").trim();

  const pendingAtts = quick ? [] : attachments.getAttachments();

  if (!text && pendingAtts.length === 0) return false;

  // steer 归入进行中的 run，不动计时起点；新消息重开计时
  if (!running&&!held) runStartAt = Date.now();

  const context: PageContext | undefined = quickPage ?? (pendingAsk && !quick
    ? {
        tabId: pendingAsk.tabId,
        title: pendingAsk.title,
        url: pendingAsk.url,
        // 只挂了来源页、没定位到段落时没有选段：只带页面。
        ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}),
      }
    : undefined);

  const mentioned = quick ? [] : tabMentions.pages();
  const planUrl = pendingAsk?.url || activeTabInfo?.url || "";
  const planTitle = pendingAsk?.title || activeTabInfo?.title || "";
  const planPages = tabMentions.items();
  const announcePlan = !quick && !running && !held && taskPlan.shouldAsk(text, mentioned, planUrl);

  const clientAttachments = pendingAtts.length > 0 ? pendingAtts : undefined;
  const conversation = selectedConversationId;
  const circled = pendingAtts.flatMap(att => (att.circle ? [att.circle] : []));
  const circleSet = currentCircleSet();

  if (circled.length && circleSet) circleRefs = { conversationId: conversation, target: circleSet, max: Math.max(...circled) };

  const request = {
    requestId: crypto.randomUUID(),
    conversationId: selectedConversationId,
    source: 'text' as const,
    action: (running||held ? 'steer' : 'start') as "steer" | "start",
    expectedRunId: conversations.get(selectedConversationId)?.runId ?? null,
    text,
    context,
    pages: mentioned.length ? mentioned : undefined,
    attachments: clientAttachments,
  };

  const sent = send(running||held ? { type: "task_action", request } : { type: "task_action", request });

  if (!sent) { noticeSendFailed();

 return false; }

  if (announcePlan) taskPlan.announce(text, planPages, planUrl, planTitle);

  marginalia.showConversation();
  const citationPage = context ?? activeTabInfo;

  if (!running && !held) { currentCitationSource = citationPage ? captureCitationContext(citationPage) : null; citationRequestPending = true; }

  const queued = queuedSends.some((e) => e.kind === "client" && e.msg.type === "task_action" && e.msg.request.requestId === request.requestId);
  unconfirmedSend = { text, ask: quick ? null : pendingAsk, attachments: pendingAtts, conversationId: conversation, postedOn: queued ? "queued" : port ?? "queued" };

  // 本地反馈：快照这次真正送出的材料；回执过了安静期（SENDING_QUIET_MS）还没 accepted，才显示「发送中」
  taskBar.noteRequestSent({ requestId: request.requestId, action: request.action, context, attachments: clientAttachments });

  // 没有选区引用时，后台会附当前页面上下文：把这一页也补进材料，界面与实际上行一致。
  // 同一页也记给这次请求：没连模型被退回时，连好后照这一页重发，而不是重发时开着的设置页（#233）。
  const page = context ? Promise.resolve(context) : (async () => {
    try {
      const id = await activeTabId();

      if (id == null) return undefined;
      const info = (await resolveTabPage(id)) ?? { title: "", url: "" };

      return { tabId: id, title: info.title ?? "", url: info.url ?? "" };
    } catch { return undefined; /* 拿不到页面信息就只展示已知材料，不猜 */ }
  })();

  lastSentPage = { requestId: request.requestId, page };

  // 期间切了会话就不再补这条材料（任务条已重置）。
  if (!context) void page.then((known) => { if (known && conversation === selectedConversationId) taskBar.noteRequestPage(request.requestId, known); });

  sendFailNotifiedFor = null;
  // 用户自己又发了话（连没连模型都算，同一句再发一次也算）：没连模型时记下的那句不再自动重发，它的卡改成「这句没有发出」。
  // 连好后的自动重发不会走到这里：那时记录已经取走。
  const superseded = resendAfterConnect.get(conversation);

  if (superseded) dropPendingMessage(superseded.card, superseded.bubble);
  resendAfterConnect.delete(conversation);
  if (!quick) userSentAt = performance.now();

  if (quick) return true;
  inputEl.value = "";
  tabMentions.clear();
  syncSteerSend();
  clearPendingAsk();
  attachments.clear();
  autoResize();
  saveDraft();

  return true;
}

function stopCurrentTask(): void {
  if (!send({ type: "abort" })) return;
  taskBar.noteControlRequested("stop");

  if (currentRun) { currentRun.orbActivity.stop(); syncRunOrb(currentRun); }
}

// 回答卡片上的「替我说一句」按钮：只发按钮上的话，不带草稿和附件。
bindAnswerCards(messagesEl, (text) => sendInput(text), () => selectedConversationId);

sendBtn.onclick = () => {
  if (sendBtn.classList.contains("stopping")) {
    stopCurrentTask();
  } else {
    sendInput();
  }
};

inputEl.addEventListener("input", () => { autoResize(); saveDraft(); syncTaskBarDraft(); syncSteerSend(); });
// 点进来或开始打字就让后台先连上模型服务；后台自己限次数，这里不节流。
inputEl.addEventListener("focus", () => { send({ type: "warm_up" }); });
inputEl.addEventListener("input", () => { if (inputEl.value.length === 1) send({ type: "warm_up" }); });

window.addEventListener("pagehide", saveDraft);

inputEl.addEventListener("keydown", (e) => {
  if (tabMentions.handleKeydown(e)) return;
  if (slashSkills.handleKeydown(e)) return;
  if (answerCommand.handleKeydown(e)) return;

  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});

document.addEventListener("keydown", (e) => {
  if (answerCommand.handleKeydown(e)) return;
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
