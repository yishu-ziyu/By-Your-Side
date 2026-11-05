import { sourceExcerpts, receiveSourceExcerpts } from "./answer-sources.js";
import { createMarginalia } from "./marginalia.js";
import { installDropzone } from "./dropzone.js";
import { attachSourceCitations, captureCitationContext, type CitationContext } from "./sonar-citations.js";
import { attachAnswerSources } from "./answer-sources.js";
import { renderFactCheck } from "./fact-check-note.js";
import { RunOrbActivity, orbStateRuns } from "./run-orb.js";
import { mountLiveGraph, type LiveGraph } from "./branch-view.js";
import { reducedMotion } from "./branch-graph.js";
import { mountVoiceUI } from "./voice-ui.js";
import { observeForCue } from "./cue.js";
import { resetSendConfirmCards, sendConfirmCard } from "./send-confirm-card.js";
import { mountDictation } from "./dictation.js";
import { createOrb, type OrbHandle } from "./orb.js";
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
import { handoffChoices } from "../../../shared/handoff-choice.js";
import type { TaskReceipt, TaskActionRequest } from "../../../shared/task-actions.js";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Hand, Check, CircleAlert, Ellipsis, SquarePen, LoaderCircle, BookOpen, SlidersHorizontal, PictureInPicture2 } from "lucide";
import { Camera, SquareDashedMousePointer, Paperclip } from "lucide";
import { ChevronRight, ArrowDown, Globe, PenLine, MousePointerClick, List, Brain, FileText, TextQuote, Keyboard, SquareTerminal, Workflow, Eye, ListChecks, Highlighter, ArrowLeftRight, X as XIcon, Languages, Download, Users, Bookmark, Wrench, Search } from "lucide";
import {
  StepChain,
  chipState,
  describeTool,
  actionCardLabel,
  historyEventTime,
  recordedDuration,
  finishedRunTitle,
  skillStepText,
  spokenDuration,
  loaderSubtitle,
  shortAction,
  splitAction,
  isPrepTool,
  actionKind,
  pastAction,
  HELD_TEXT,
  type ActionKind,
  isLiveViewportPinned,
  liveViewportOverflows } from "./steps.js";
import { isStepName, type StepDetail } from "../../../shared/tool-event-for-ui.js";
import { LEAD_COLOR, displayColor, displayNameFor } from "../../../shared/cast.js";
import { ArtifactCards } from "./artifact-card.js";
import { mountErrorCards, type KeyTarget, type KeyTestResult } from "./error-card.js";
import { describeModelError, plainError } from "../../../shared/user-facing.js";
import { INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY, INPROC_CREDENTIAL_PREFIX, INPROC_VOICE_MODEL_KEY } from "../inproc/shared.js";
import { CONNECTION_PREFIX, credentialFingerprint, modelConfig, withModelSettings } from "../settings/connections.js";
import { mountModelMenu } from "./model-menu.js";
import { chipLabel } from "./models.js";
import { mountReadingSettings } from "./reading-settings.js";
import { D_STATE, D_TAP } from "../shared/motion-tokens.js";
import { AttachmentsManager } from "./attachments.js";
import { MaterialsTray, type TrayRemoval } from "./materials-tray.js";
import { hideTabIdsInHtml } from "./tab-id-text.js";
import { fileChip, fileMeta } from "./file-chip.js";
import { currentCircleSet, revealCircle } from "./circle-select.js";
import { LEAD_SESSION_ID, isLeadSession, parseServerMessage } from "../../../shared/protocol.js";
import { checkNoteForUser, evidenceLine, mergeEvidence, nextWorkingTab, readbackKey } from "./claim-hold.js";
import type { AgentRunState, AgentUiEvent, Attachment, FieldReadback, ClientMessage, ConversationSummary, HeldReason, ModelConnectionIdentity, ModelOption, PageContext, ServerMessage, TeamView } from "../../../shared/protocol.js";
import { DEFAULT_STEP_VOICE, isStepVoice, parseVoicePersona, STEP_VOICE_STORAGE_KEY, VOICE_PERSONA_STORAGE_KEY, type UserDelivery, type VoiceInputContext } from "../../../shared/voice.js";
import { normalizeMemoryHostname,} from "../../../shared/memory.js";
import type { TaskHistoryEntry } from "../../../shared/task-history.js";
import { panelLive, shouldFinishRunOnDisconnect } from "../../../shared/control.js";
import { isWriteTool } from "../../../shared/effect-policy.js";
import { conversationDayGroup, conversationOutcome, conversationRelativeTime, otherTaskCopy, resultCardCopy } from "./selectors.js";
import { liveStatus, runMetaLine, STEER_OTHER_WAY } from "../../../shared/run-status.js";
import { TaskBar, stateHeadline } from "./task-bar.js";
import { mountComposerGlide } from "./composer-glide.js";
import type { TaskView } from "../../../shared/task-view.js";
import { plainStep } from "../../../shared/user-facing.js";
import { ResumeEntry } from "./resume-entry.js";
import { deliveryPresentation } from "./delivery-presentation.js";
import { PANEL_PORT_NAME, parseDeliveryReceipt, type BgToPanel, type DeliveryReceipt, type FillUndoView, type PanelHistoryEntry, type PanelToBg, type UserTurnContext } from "../relay.js";
import { ASK_STORE, type PendingAsk } from "../shared/ask-selection.js";
import { NUDGE_DRAFT_KEY } from "../shared/nudge.js";
import { installProactiveCard } from "./proactive-card.js";
import { acceptTeamStatus, emptyTeamRun, isRunId, observeRunStarted, type TeamRunState } from "../shared/team-run.js";
import { setUiRunSource, uiEvent } from "./ui-trace.js";
import { watchSelfUse } from "../shared/self-use.js";
import { mountMemoryDrawer } from "./memory-drawer.js";
import { mountMemoryInline } from "./memory-inline.js";
import { createGhostBar } from "./ghost-bar.js";
import { installChromeQuiet } from "./chrome-quiet.js";
import { createSteerRibbon } from "./in-flight-steer.js";
import { mountSlashSkills } from "./slash-skills.js";
import { mountTabMentions, type MentionedTab } from "./tab-mentions.js";
import { paintPlanReceipt, siteName } from "./task-plan.js";
import { mountAnswerCommand } from "./answer-command.js";
import { connectSkillOperations, deleteSkillOperation, knownSkillOperations, onSkillOperationsChange, receiveSkillOperationRun, receiveSkillOperations, refreshSkillOperations, runSkillOperation, skillOperationsLoaded } from "./skill-operations.js";
import { mountChapters } from "./chapters.js";
import { activeTargetTab, isFloat, isPopout, popoutConversation, targetWindowId } from "./target-window.js";
import { FLOAT_CARD_DEFAULT_RECT, FLOAT_CARD_KEY, readFloatCard } from "../shared/float-card.js";
import { bindMotionIcon } from "./motion-icon.js";
import { mountDottedGlow } from "./dotted-glow.js";
import { skillResultText } from "../shared/skill-result.js";
import { isVoiceDiagnosticsOn, VOICE_DIAGNOSTICS_KEY } from "../shared/voice-diagnostics.js";

syncColorTone();

const answerSources = new WeakMap<HTMLElement, Promise<CitationContext | null>>();

let currentCitationSource: Promise<CitationContext | null> | null = null;

let replayingHistory = false;

let citationRequestPending = false;

let circleRefs: { conversationId: string; target: { tabId: number; set: number }; max: number } | null = null;

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
        const shown = button.nextElementSibling?.classList.contains("circle-ref-gone") ? button.nextElementSibling : null;

        if (ok) { shown?.remove();

 return; }

        if (shown) return;
        const gone = document.createElement("span");
        gone.className = "circle-ref-gone";
        gone.textContent = "原处已变化";
        button.after(gone);
      });
      fragment.append(button);
    }

    node.replaceWith(fragment);
  }
}

const pageRefWaits = new Map<string, (value: string[] | boolean) => void>();

function askPageRefs<T extends string[] | boolean>(message: PanelToBg & { id: string }): Promise<T> {
  return new Promise<T>((done) => {
    const timer = setTimeout(() => { pageRefWaits.delete(message.id); done((message.kind === "page_refs_check" ? [] : false) as T); }, 8_000);
    pageRefWaits.set(message.id, (value) => { clearTimeout(timer); done(value as T); });

    if (!port) { pageRefWaits.get(message.id)?.(message.kind === "page_refs_check" ? [] : false); pageRefWaits.delete(message.id); return; }
    port.postMessage(message);
  });
}

async function markPageRefs(answer: HTMLElement): Promise<void> {
  const names = quotedNames(answer);
  const found = await askPageRefs<string[]>({ kind: "page_refs_check", id: crypto.randomUUID(), names });

  if (!answer.isConnected) return;
  linkifyPageRefs(answer, found, {
    point: (name) => askPageRefs<boolean>({ kind: "page_ref_point", id: crypto.randomUUID(), name }),
    say: (text) => { sendInput(text); },
  });
}

function attachAnswerActions(answer: HTMLElement, delivered?: UserDelivery): void {
  if ((currentRun ?? lastRun)?.sendDeclined) {
    for (let node: Element | null = answer; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
      node.querySelectorAll(".send-declined-card").forEach(card => card.remove());
    }
    answer.insertAdjacentHTML("beforeend", DECLINED_ANSWER);
  }
  attachCopyActions(answer);
  const run = currentRun ?? lastRun;

  if (run) attachSkillUndo(run, answer);
  linkifyCircleRefs(answer);
  memoryInline.adoptUsedLine(answer);
  placeTaskCardAfter(answer);
  syncAnswerTime(answer);
  if (!replayingHistory && answer === fillUndoAnswer()) adoptFillUndo(answer);
  if (!replayingHistory && planCardRun) paintPlanCard();
  attachShorten(answer);
  scrollToEnd();

  if (delivered && !replayingHistory) void markPageRefs(answer);
  if (delivered && !replayingHistory) void offerWorkingTab(answer, selectedConversationId, delivered.sources ?? delivered.facts?.sources ?? []);
  const source = answerSources.get(answer);

  if (source) void source.then(context => attachSourceCitations(answer, context));
}

function placeTaskCardAfter(answer: HTMLElement): void {
  const card = Array.from(messagesEl.querySelectorAll<HTMLElement>(".ai-task-card")).pop();

  if (!card || !(card.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING)) return;

  for (let node = card.nextElementSibling; node && node !== answer; node = node.nextElementSibling) {
    if (node.classList.contains("user")) return;
  }

  answer.after(card);
}

function syncAnswerTime(answer: HTMLElement): void {
  for (let node = answer.previousElementSibling; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
    if (node.matches("details.run-steps.done")) {
      setAnswerTime(answer, node.querySelector(".run-time")?.textContent ?? "");

      return;
    }
  }
}

function attachDeliverySources(answer: HTMLElement, delivery: UserDelivery): void {
  attachAnswerSources(answer, delivery.sources ?? delivery.facts?.sources);
}

const PLACEHOLDER_IDLE = "说说你想完成什么…";

const PLACEHOLDER_RUNNING = "补充或改方向…";

const PLACEHOLDER_USER = "补充要求，按 Enter 保存。点「交还」后生效";

const PLACEHOLDER_DRAINING = "正在接管，助手不再做新的操作。";

const PLACEHOLDER_PARTIAL = "部分页面已交还。其余页面仍归你。";

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

const PANEL_HTML = { FORBID_TAGS: ["style", "link", "meta", "base", "form", "iframe", "object", "embed", "foreignObject", "dialog"], FORBID_ATTR: ["style"] };

const DECLINED_ANSWER = '<div class="gen-card send-declined-card"><div class="gc-actions"><button type="button" class="gc-btn primary" data-card-say="现在发送吧">现在发送吧</button></div></div>';

function renderMarkdown(text: string): string {
  return hideTabIdsInHtml(DOMPurify.sanitize(renderAnswerHtml(text, renderMarkdownHtml, sourceExcerpts), PANEL_HTML));
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
      <details id="site-note-management"><summary>站点用法</summary><button id="site-note-refresh" type="button">刷新</button><div id="site-note-management-body"></div></details>
      <div id="memory-body"></div>
    </div>
  </section>
  <div id="marginalia-rail" aria-label="段落提示" hidden></div>
  <div id="messages-frame">
    <div id="messages">
      <div id="resume-entry-root"></div>
    </div>
    <div class="scroll-fade" data-edge="top" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
    <div class="scroll-fade" data-edge="bottom" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
  </div>
  <section id="starter" aria-label="开始方式">
    <canvas id="starter-glow" aria-hidden="true"></canvas>
    <p id="starter-brand"></p>
    <canvas id="starter-orb" aria-hidden="true"></canvas>
    <p id="starter-title">说说你想完成什么</p>
    <p id="starter-sub"></p>
    <button type="button" id="starter-connect">连接模型</button>
  </section>
  <div class="composer-dock-wrap">
    <div id="attach-menu" class="action-menu-popover" role="menu" aria-label="添加与设置" hidden>
      <button type="button" role="menuitem" tabindex="-1" class="action-menu-item pressable" id="menu-action-upload" title="PDF、Word、Excel、PPT、CSV、文本和代码文件，以及图片。文件在本机读成文字再交给助手，也可以直接拖进输入框。">
        <span class="action-menu-item-icon" data-icon="upload"></span>
        <span class="action-menu-item-text"><span class="action-menu-item-label">添加文件或图片</span><span class="action-menu-item-sub">PDF、Word、Excel 等</span></span>
      </button>
      <button type="button" role="menuitem" tabindex="-1" class="action-menu-item pressable" id="menu-action-screenshot" title="只截当前网页中可见的部分。">
        <span class="action-menu-item-icon" data-icon="camera"></span>
        <span class="action-menu-item-label">页面截图</span>
      </button>
      <button type="button" role="menuitem" tabindex="-1" class="action-menu-item pressable" id="menu-action-region" title="在网页上圈出想问的地方，可以圈好几处（Esc 退出）">
        <span class="action-menu-item-icon" data-icon="region"></span>
        <span class="action-menu-item-label">圈出来问 <span class="action-menu-item-key" id="region-key">⌘⇧S</span></span>
      </button>
      <hr />
      <div role="group" aria-labelledby="marginalia-menu-label">
      <p class="composer-menu-label" id="marginalia-menu-label" title="显示当前段落的原文或解释。">段落提示</p>
      <button type="button" class="action-menu-radio" role="menuitemradio" tabindex="-1" data-marginalia="off">关闭</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" tabindex="-1" data-marginalia="source">原文摘录</button>
      <button type="button" class="action-menu-radio" role="menuitemradio" tabindex="-1" data-marginalia="ai">解释段落<span>让助手解释正在读的段落。这会把段落发给模型</span></button>
      </div>
      <hr />
      <button id="voice-diagnostics-open" class="action-menu-radio" type="button" role="menuitem" tabindex="-1">语音诊断</button>
    </div>
    <input type="file" id="file-input" multiple hidden />
    <select id="marginalia-mode" aria-label="段落提示模式" hidden><option value="off">关闭</option><option value="source">原文摘录</option><option value="ai">解释段落 · 会发给模型</option></select>
    <div id="confirm-dock" hidden></div>
    <p id="confirm-announce" class="sr-only" role="status"></p>
    <div id="task-bar-root"></div>
    <div id="composer" class="composer-glass-dock">
      <div id="materials-tray-root"></div>
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
          <button id="attach-btn" class="composer-icon-btn" type="button" title="添加文件、截图或圈出来问" aria-label="添加文件、截图或圈出来问" aria-haspopup="menu" aria-expanded="false" aria-controls="attach-menu">+</button>
          <button id="translate-btn" class="composer-icon-btn" type="button" title="翻译这一页（⌥T），再点一次还原" aria-label="翻译这一页"></button>
          <button id="takeover-btn" type="button" title="接管：助手暂停，由你操作页面。操作完，点「交还」。" hidden>接管</button>
          <span id="composer-spacer"></span>
        </div>
        <button id="steer-send-btn" type="button" title="发出插话（Enter）" aria-label="发出插话" hidden></button>
        <button id="send-btn" class="kinetic-morph-button" type="button" title="发送">
          <span class="morph-icon-send"></span>
          <span class="morph-icon-stop"></span>
        </button>
      </div>
    </div>
  </div>
`;

function applyHostFeatures(features: { memory: boolean } | undefined): void {
  const memory = features?.memory ?? true;
  document.getElementById("memory-open")!.hidden = !memory;
}

const headerMore = document.getElementById("header-more") as HTMLButtonElement;

const headerMenu = document.getElementById("header-menu")!;

headerMore.append(icon(Ellipsis));

headerMore.addEventListener("click", (event) => {
  headerMenu.classList.toggle("keyboard-open", event.detail === 0);
});

headerMenu.addEventListener("click", (event) => {
  if (!(event.target as Element).closest("button")) return;
  headerMenu.hidePopover();

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

const chapters = mountChapters(messagesEl, document.getElementById("messages-frame")!, () => { pinned = false; }, () => replayingHistory);

const composerEl = document.getElementById("composer") as HTMLElement;

const inputEl = document.getElementById("input") as HTMLTextAreaElement;

const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;

sendBtn.disabled = true;

document.getElementById("region-key")!.textContent = /Mac/i.test(navigator.platform) ? "⌘⇧S" : "Ctrl+Shift+S";

const ghostBar = createGhostBar(document.getElementById("ghost-bar")!);

installChromeQuiet({
  input: inputEl,
  messages: messagesEl,
  faded: () => ["#conversation-switcher", "#conversation-new", "#memory-open", "#header-more", "#attach-btn"].flatMap(selector => Array.from(document.querySelectorAll<HTMLElement>(selector))),
  hoverZone: "#topbar:hover, #composer-bar:hover",
  menuOpen: () => !!document.querySelector("#header-menu:popover-open") || ["conversation-menu", "attach-menu", "memory-drawer"].some(id => document.getElementById(id)?.hidden === false),
});

const steerRibbon = createSteerRibbon(composerEl, inputEl, (text) => sendInput(text));

const slashSkills = mountSlashSkills({
  composerEl, inputEl,
  run: (text) => { inputEl.value = text; inputEl.dispatchEvent(new Event("input")); sendInput(); },
  runOperation: (operation, input) => {
    const card = addMsg("msg assistant skill-operation-result", "");
    card.dataset.skillId = operation.id;
    const paint = (msg?: Extract<ServerMessage, { type: "skill_operation_run_result" }>): void => {
      card.replaceChildren();
      const head = document.createElement("div");
      head.className = "skill-operation-result-head";
      const title = document.createElement("strong");
      title.textContent = operation.name;
      const meta = document.createElement("span");
      meta.textContent = "直接运行 · 未调用模型";
      head.append(title, meta);
      const body = document.createElement("pre");
      if (!msg) body.textContent = "正在读取当前页面…";
      else if (!msg.ok) {
        card.dataset.state = "error";
        body.textContent = `没有运行成功：${plainError(msg.error, "连接中断，请再试一次。")}`;
      } else if (!msg.result || msg.result.status !== "observed" && msg.result.status !== "empty") {
        card.dataset.state = "error";
        body.textContent = `没有运行成功：${plainError(msg.result && "reason" in msg.result ? msg.result.reason : "", "没有取得结果")}`;
      } else {
        const result = msg.result;
        card.dataset.state = result.status;
        body.textContent = skillResultText(result.data);
        if (result.status === "empty") meta.textContent += " · 没有读到内容";
      }
      card.append(head, body);
      scrollToEnd();
    };
    paint();
    if (!runSkillOperation(operation.id, input, activeTabContext()?.tabId, paint)) paint({ type: "skill_operation_run_result", requestId: "", ok: false, error: "助手没连上，请再试一次。" });
  },
  verifiedRequest: isLatestVerifiedRequest,
});
connectSkillOperations(msg => send(msg));
onSkillOperationsChange(() => {
  for (const button of messagesEl.querySelectorAll<HTMLButtonElement>(".skill-undo[data-skill-id]")) paintSkillUndo(button);
});

function paintSkillUndo(button: HTMLButtonElement): void {
  if (!skillOperationsLoaded()) return;
  const kept = knownSkillOperations().some(item => item.id === button.dataset.skillId);
  button.textContent = kept ? "撤销" : "已撤销";
  button.disabled = !kept;
}

function isLatestVerifiedRequest(bubble: HTMLElement): boolean {
  const runs = [...messagesEl.querySelectorAll<HTMLElement>("details.run-steps")]
    .filter(item => item.querySelector('.run-check[data-tone="ok"]') && !item.querySelector(".chip[data-skill-write]"));
  const endedAt = Number(runs.at(-1)?.dataset.endedAt);

  if (!Number.isFinite(endedAt) || Date.now() - endedAt > 30 * 60_000) return false;
  const run = runs.at(-1);

  for (let node = run?.previousElementSibling; node; node = node.previousElementSibling) {
    if (node.matches(".msg.user")) return node === bubble;
  }

  return false;
}

const tabMentions = mountTabMentions({
  composerEl,
  inputEl,
  stripEl: document.getElementById("mention-strip")!,
  onChange: () => {
    saveDraft();
    materialsTray?.sync();
  },
});

let pendingContinueDraft: string | null = null;


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

const attachmentsStrip = document.getElementById("attachments-strip") as HTMLElement;

const attachBtn = document.getElementById("attach-btn") as HTMLButtonElement;

const attachMenu = document.getElementById("attach-menu") as HTMLElement;

document.getElementById("composer-bar")!.addEventListener("mousedown", (event) => {
  if (event.button !== 0 || !(event.target instanceof Element) || event.target.closest("button")) return;
  event.preventDefault();
  inputEl.focus();
});

const fileInput = document.getElementById("file-input") as HTMLInputElement;

let attachments!: AttachmentsManager;
let materialsTray: MaterialsTray | null = null;

const askCiteEl = document.getElementById("ask-cite") as HTMLElement | null;

const askCiteHost = document.getElementById("ask-cite-host") as HTMLElement | null;

const askCiteText = document.getElementById("ask-cite-text") as HTMLElement | null;

const askCiteClose = document.getElementById("ask-cite-close") as HTMLButtonElement | null;

let pendingAsk: PendingAsk | null = null;

let selectedConversationId = "default";
let cancelPendingKeySaves = (): void => {};
let dictationUI: ReturnType<typeof mountDictation> | undefined;

const PANEL_CONVERSATION_KEY = "sideagent-panel-conversation";

if (popoutConversation) {
  try { if (isFloat || !sessionStorage.getItem(PANEL_CONVERSATION_KEY)) sessionStorage.setItem(PANEL_CONVERSATION_KEY, popoutConversation); } catch {  }
}

let conversationReady = false;

let transportConnected = false;

const completedConversations = new Set<string>();

let conversationRequest: string | null = null;

let draftAtNewRequest: string | null = null;
let sendAfterCreate = false;

let bootFreshSession = true;

let bootInheritedId: string | null = null;

let bootDecisionTimer: ReturnType<typeof setTimeout> | null = null;

let bootCreateTimer: ReturnType<typeof setTimeout> | null = null;

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

let currentDraftReady = false;

let draftWrites = Promise.resolve();

const DRAFT_KEY = "sideagent_conversation_draft:";

const DRAFT_ATTACHMENTS_KEY = "sideagent_conversation_draft_attachments:";

const draftFingerprint = (draft: ConversationDraft): string => JSON.stringify({ ...draft, attachments: draft.attachments.map(a => a.id) });

function writeDraft(id: string, draft: ConversationDraft, withAttachments: boolean): void {
  const { attachments: atts, ...rest } = draft;
  draftWrites = draftWrites.catch(() => {}).then(() => chrome.storage.local.set({ [DRAFT_KEY + id]: rest, ...(withAttachments ? { [DRAFT_ATTACHMENTS_KEY + id]: atts } : {}) }));
}

function saveDraft(): void {
  if (restoringDraft || !attachments) return;
  const id = selectedConversationId;
  const draft: ConversationDraft = { text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk, pages: tabMentions.items() };
  const fingerprint = draftFingerprint(draft);
  const previous = draftFingerprints.get(id);

  if (previous === fingerprint) return;
  const attachmentsChanged = !previous || JSON.parse(previous).attachments.join() !== draft.attachments.map(a => a.id).join();
  draftRevision += 1;
  draftFingerprints.set(id, fingerprint);
  conversationDrafts.set(id, draft);
  writeDraft(id, draft, attachmentsChanged);
}

async function restoreDraft(id: string): Promise<void> {
  const revision = draftRevision;
  let draft = conversationDrafts.get(id);

  if (!draft) {
    const stored = await chrome.storage.local.get([DRAFT_KEY + id, DRAFT_ATTACHMENTS_KEY + id]);

    if (revision !== draftRevision || selectedConversationId !== id) return;
    const saved = stored[DRAFT_KEY + id] as Partial<ConversationDraft> | undefined;
    const atts = stored[DRAFT_ATTACHMENTS_KEY + id] ?? saved?.attachments;
    draft = saved || atts ? { text: "", ask: null, ...saved, attachments: Array.isArray(atts) ? atts : [] } : undefined;
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
    draftFingerprints.set(id, draftFingerprint({ text: inputEl.value, attachments: attachments.getAttachments(), ask: pendingAsk, pages: tabMentions.items() }));
    currentDraftReady = true;
    updateStarterVisibility();
  } finally { restoringDraft = false; }
}

function starterReady(): boolean {
  return historyPrimed && currentDraftReady;
}

let takingNudgeDraft = false;

async function takeNudgeDraft(): Promise<void> {
  if (!starterReady() || takingNudgeDraft) return;
  takingNudgeDraft = true;
  let text = "";

  try {
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

let modelConnected: boolean | null = null;

function paintStarterModelState(): void {
  const none = modelConnected === false;
  app.classList.toggle("no-model", none);
  document.getElementById("starter-title")!.textContent = none ? "先连接模型" : "说说你想完成什么";
  document.getElementById("starter-sub")!.textContent = none ? "连接以后，助手就能读这个页面、整理信息、在页面上操作。" : "";
}

document.getElementById("starter-connect")!.onclick = () => void chrome.runtime.openOptionsPage();

let userSentAt = 0;
const resendAfterConnect = new Map<string, { text: string; page: Promise<PageContext | undefined>; card: HTMLElement; bubble: HTMLElement | null }>();

let lastSentPage: { requestId: string; page: Promise<PageContext | undefined> } | null = null;

let resending: { conversationId: string; text: string; bubble: HTMLElement | null } | null = null;

let modelSaved: boolean | null = null;

let hostReportedModel: boolean | null = null;

void chrome.storage.local.get(INPROC_CONFIG_KEY).then((stored) => {
  modelSaved = !!stored[INPROC_CONFIG_KEY];

  if (modelSaved && modelConnected === false) { modelConnected = true; paintStarterModelState(); }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && INPROC_CONFIG_KEY in changes) modelSaved = !!changes[INPROC_CONFIG_KEY]!.newValue;
});

function noteModelPresence(model: string | undefined, models: ModelOption[] | undefined): void {
  const was = hostReportedModel;
  hostReportedModel = !!model || !!models?.length;
  modelConnected = hostReportedModel || modelSaved === true;
  paintStarterModelState();

  if (bootFreshSession && !modelConnected && bootInheritedId !== null) resolveBootSession(bootInheritedId, conversations.size > 0);

  if (was !== false || !hostReportedModel) return;
  const pending = resendAfterConnect.get(selectedConversationId);
  resendAfterConnect.clear();

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

function conversationEmpty(): boolean {
  return !Array.from(messagesEl.children).some((child) => child.id !== "resume-entry-root" || child.childElementCount > 0);
}

new MutationObserver(() => app.classList.toggle("conversation-empty", conversationEmpty())).observe(messagesEl, { childList: true, subtree: true });

app.classList.toggle("conversation-empty", conversationEmpty());

mountComposerGlide(app, document.querySelector<HTMLElement>(".composer-dock-wrap")!, document.getElementById("starter")!, [app, messagesEl, document.getElementById("status-pill")!, sendBtn]);

function upsertConversation(c: ConversationSummary): void {
  if (conversations.get(c.id)?.state === "running" && c.state === "idle" && !c.checkpoint && c.id !== selectedConversationId) completedConversations.add(c.id);

  if (c.checkpoint) completedConversations.delete(c.id);
  conversations.set(c.id, c);

  if (c.id === selectedConversationId) noteRunStarted(c.runId);
}

let conversationFilter = "";
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

  const signature = sig.join("\u0002");

  if (filter.parentElement !== conversationMenu || signature !== conversationRowsSig) {
    conversationRowsSig = signature;
    if (filter.parentElement !== conversationMenu) conversationMenu.replaceChildren(filter);
    while (filter.nextSibling) filter.nextSibling.remove();
    conversationMenu.append(...nodes);
  }

  const elsewhere = (c: ConversationSummary) => c.id !== selectedConversationId && separateAskOrigins.get(c.id) !== selectedConversationId;
  const other = list.find((c) => elsewhere(c) && c.state === "running")
    ?? list.find((c) => elsewhere(c) && c.state === "user")
    ?? list.find((c) => elsewhere(c) && c.checkpoint === "interrupted")
    ?? list.find((c) => elsewhere(c) && completedConversations.has(c.id));

  conversationBackground.hidden = true;
  conversationBackground.replaceChildren();
  conversationSwitcher.dataset.other = "";
  conversationSwitcher.removeAttribute("data-other");

  const waiting = list.filter((c) => elsewhere(c) && (c.state === "running" || c.state === "user" || c.checkpoint === "interrupted"));
  const cue = waiting[0] ?? other;
  const otherKey = cue && waiting.length ? `${waiting.length}:${cue.id}:${cue.title}` : "";
  const existingOther = document.getElementById("conversation-other");

  if (cue && waiting.length) {
    conversationSwitcher.dataset.other = String(waiting.length);
    conversationSwitcher.title = otherTaskCopy(waiting.length, cue.title).line;
  }

  if ((existingOther?.dataset.other ?? "") !== otherKey) {
    existingOther?.remove();

    if (cue && waiting.length) {
      const row = document.createElement("div");
      row.id = "conversation-other";
      row.dataset.other = otherKey;
      row.className = "conversation-other";
      const copy = otherTaskCopy(waiting.length, cue.title);
      const line = document.createElement("p");
      line.textContent = copy.line;
      const go = document.createElement("button");
      go.type = "button";
      go.textContent = copy.action;
      go.onclick = (event) => { event.stopPropagation(); selectConversation(cue.id); };
      row.append(line, go);
      conversationMenu.prepend(row);
    }
  }
}

function resetConversationRender(): void {
  sourceExcerpts.clear();
  resetFillUndo();
  resetSendConfirmCards();
  planCardRun = null;
  planUndo = null;
  if (currentRun) { clearInterval(currentRun.timer); currentRun.orb.dispose(); }

  closeBlocks();
  currentRun = null;
  lastRun = null;
  sendChangedRuns.clear();
  runStartAt = 0;
  toolChips.clear();
  sessionRun.clear();
  teamView = null;
  teamRunId = null;
  running = false;
  steerRibbon.reset();
  lastUserHasPage = false;
  applyHandoffPhase("agent");
  lastHistorySeq = 0;
  userBubbles.clear();
  clearPendingRedelivers();
  deliveredBubbles.clear();
  receiptMessages.clear();
  memoryInline.resetUsedLines();
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
  setSessionState(LEAD_SESSION_ID, "idle");
}

function selectConversation(id: string, notify = true): void {
  const preserveInitialDraft = !conversationReady && (inputEl.value.length > 0 || attachments.getAttachments().length > 0 || pendingAsk !== null);

  if (id !== selectedConversationId) { cancelPendingKeySaves(); voiceUI.stop(); dictationUI?.cancel(); memoryInline.asksUnanswered("switched_conversation"); }
  completedConversations.delete(id);
  conversationMenu.hidden = true;
  conversationSwitcher.setAttribute("aria-expanded", "false");

  if (id !== selectedConversationId || !conversationReady) {
    const typed = draftAtNewRequest !== null && inputEl.value !== draftAtNewRequest ? inputEl.value : null;

    if (typed !== null) inputEl.value = draftAtNewRequest!;
    draftAtNewRequest = null;

    if (conversationReady) saveDraft();
    selectedConversationId = id;
    conversationReady = true;
    takeAutoRetryLock(id);

    try { sessionStorage.setItem(PANEL_CONVERSATION_KEY, id); } catch {  }
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
  queryTaskView();

  if (notify) port?.postMessage({ kind: "select_conversation", conversationId: id } satisfies PanelToBg);
  port?.postMessage({ kind: "sync", conversationId: id, afterSeq: lastHistorySeq } satisfies PanelToBg);
}

function resolveBootSession(inheritedId: string, listKnown: boolean): void {
  if (!bootFreshSession) return;
  bootInheritedId = inheritedId;
  const inherited = conversations.get(inheritedId);
  const noModel = modelConnected === false;

  const goneRemembered = !inherited && listKnown && inheritedId === rememberedConversation();

  if (!inherited && !listKnown && !noModel) return;

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

const memoryInline = mountMemoryInline({
  messagesEl,
  appendToMessages: (node) => appendToMessages(node),
  scrollToEnd: () => scrollToEnd(),
  send: (msg) => send(msg),
  conversationId: () => selectedConversationId,
  replaying: () => replayingHistory,
  drawer: () => memoryDrawerCtrl,
});

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
  onOutcome: (outcome) => memoryInline.settle(outcome),
});

const {
  memoryState,
  openMemoryDrawer,
  requestPastTasks,
  processMemoryOutcome,
  handlePastTasksResult,
} = memoryDrawerCtrl;

const morphSend = sendBtn.querySelector(".morph-icon-send");

const morphStop = sendBtn.querySelector(".morph-icon-stop");

if (morphSend) morphSend.appendChild(icon(ArrowUp));

if (morphStop) morphStop.appendChild(icon(Square));

const steerSendBtn = document.getElementById("steer-send-btn") as HTMLButtonElement;

steerSendBtn.append(icon(ArrowUp));
const translateBtn = document.getElementById("translate-btn") as HTMLButtonElement;
translateBtn.append(icon(Languages));
translateBtn.addEventListener("click", () => { send({ type: "page_translate" }); });

steerSendBtn.onclick = () => sendInput();

for (const [key, node] of [["camera", Camera], ["region", SquareDashedMousePointer], ["upload", Paperclip]] as const) {
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

function syncSteerSend(): void {
  const steer = document.getElementById("steer-send-btn");
  const send = document.getElementById("send-btn");
  const input = document.getElementById("input") as HTMLTextAreaElement | null;

  if (steer && send && input) steer.hidden = !send.classList.contains("stopping") || !input.value.trim();

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

if (isPopout) {
  popoutOpen.remove();
  document.documentElement.dataset.popout = "";
}

popoutOpen.addEventListener("click", () => void openFloat());

function watchFullyVisible(target: Element, onChange: (visible: boolean) => void): void {
  new IntersectionObserver(([entry]) => onChange((entry as (IntersectionObserverEntry & { isVisible?: boolean }) | undefined)?.isVisible === true),
    { trackVisibility: true, delay: 100 } as IntersectionObserverInit).observe(target);
}

if (isFloat) {
  let visible = false;
  watchFullyVisible(document.body, v => { visible = v; });
  for (const type of ["pointerdown", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu", "keydown"]) {
    addEventListener(type, ev => { if (!visible) { ev.preventDefault(); ev.stopImmediatePropagation(); } }, true);
  }
}

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

if (isPopout) {
  chrome.windows.onRemoved.addListener(() => {
    void refreshActiveTab();
    void targetWindowId().then(windowId => {
      if (windowId != null) port?.postMessage({ kind: "panel_window", windowId } satisfies PanelToBg);
    }).catch(() => {  });
  });
}

function clipTitle(text: string, max = 16): string {
  const t = text.trim();

  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

let activeTabInfo: { id: number; title: string; url: string } | null = null;

async function refreshActiveTab(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.tabs?.query) {
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


    try {
      if (tab.url) {
        const pageUrl = new URL(tab.url);
        memoryDrawerCtrl.setCurrentHostname(normalizeMemoryHostname(pageUrl.hostname) ?? "");
      }
    } catch {
      memoryDrawerCtrl.setCurrentHostname("");
    }

    materialsTray?.sync();
  } catch {
    materialsTray?.sync();
  }
}

if (typeof chrome !== "undefined" && chrome.tabs) {
  chrome.tabs.onActivated?.addListener((info) => { dropShowTab(info.tabId); void refreshActiveTab(); taskBar.noteTabsChanged(); });
  chrome.tabs.onUpdated?.addListener((_tabId, changeInfo) => {
    if (changeInfo.status || changeInfo.title || changeInfo.url) {
      void refreshActiveTab();
      taskBar.noteTabsChanged();
    }
  });
  chrome.tabs.onRemoved?.addListener((tabId) => { dropShowTab(tabId); taskBar.noteTabsChanged(); });
}

void refreshActiveTab();

const modelMenu = mountModelMenu({
  composer: document.getElementById("composer")!,
  after: document.getElementById("attach-btn")!,
  sendThinking: (model, level, restore) => { send({ type: "set_thinking", model, level, ...(restore ? {restore} : {}) }); },
  setModel: (model) => { send({ type: "set_model", model }); },
});

let knownModels: ModelOption[] = [];

let currentModelId: string | undefined;

let pendingModelSwitch: { id: string; done: () => void; timer: ReturnType<typeof setTimeout> } | null = null;

const keyTests = new Map<string, (result: KeyTestResult) => void>();
const keySaves = new Map<string, (ok: boolean) => void>();
const keySaveCancels = new Map<string, () => void>();
cancelPendingKeySaves = () => { for (const cancel of keySaveCancels.values()) cancel(); };
addEventListener("pagehide", cancelPendingKeySaves);

function noteModelInfo(model: string | undefined, models: ModelOption[] | undefined): void {
  if (models?.length) knownModels = models;

  if (!model) return;
  currentModelId = model;

  if (pendingModelSwitch?.id === model) { clearTimeout(pendingModelSwitch.timer); pendingModelSwitch.done(); pendingModelSwitch = null; }
}

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
  void navigator.locks.request(`${AUTO_RETRY_LOCK}:${conversationId}`, () => { lock.held = true; return done; });
}

async function ownsAutoRetry(): Promise<boolean> {
  if (!navigator.locks) return true;

  if (autoRetryLock?.held && autoRetryLock.conversationId === selectedConversationId) return true;
  const { held = [] } = await navigator.locks.query();

  return !held.some(lock => lock.name === `${AUTO_RETRY_LOCK}:${selectedConversationId}`);
}

const keyRoleKeys = [INPROC_CONFIG_KEY, INPROC_FAST_CONFIG_KEY, INPROC_BACKUP_CONFIG_KEY];

async function resolveKeyTarget(identity: ModelConnectionIdentity): Promise<KeyTarget | null> {
  const conversationId = selectedConversationId;
  return withModelSettings(async () => {
    const stored = await chrome.storage.local.get(null);
    const connection = modelConfig(stored[CONNECTION_PREFIX + identity.provider]);
    const candidates = keyRoleKeys.map(role => modelConfig(stored[role])).filter(config => config && config.provider === identity.provider && config.modelId === identity.modelId);
    if (connection && connection.provider === identity.provider) candidates.push({ ...connection, modelId: identity.modelId });
    else if (identity.provider !== "custom" && stored[INPROC_CREDENTIAL_PREFIX + identity.provider]) candidates.push({ provider: identity.provider, modelId: identity.modelId });
    const bound = await Promise.all(candidates.map(async config => {
      if (!config || config.provider !== "custom") return config;
      if (!config.baseUrl || !identity.endpointHash) return null;
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(config.baseUrl));
      const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
      return hash === identity.endpointHash ? config : null;
    }));
    const unique = [...new Map(bound.filter(config => config !== null).map(config => [JSON.stringify(config), config])).values()];
    const config = unique[0];
    if (unique.length !== 1 || !config || selectedConversationId !== conversationId) return null;
    if (config.provider === "custom" && keyRoleKeys.some(role => { const current = modelConfig(stored[role]); return current?.provider === "custom" && current.baseUrl !== config.baseUrl; })) return null;
    const credential: unknown = stored[INPROC_CREDENTIAL_PREFIX + config.provider];
    if (credential && typeof credential === "object" && "type" in credential && credential.type === "oauth") return null;
    return { config, credential: stored[INPROC_CREDENTIAL_PREFIX + config.provider], conversationId, runId: identity.runId, roles: JSON.stringify(keyRoleKeys.map(role => modelConfig(stored[role]))), connection: JSON.stringify(connection) };
  });
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
  retry: (_key, auto, target) => { send({ type: "retry_after_error", ...(target ? { target: target.config, expectedRunId: target.runId, keySaveRequestId: target.saveRequestId, conversationId: target.conversationId ?? undefined } : {}), ...(auto ? { auto: true as const } : {}) }); },
  ownsAutoRetry,
  resolveKeyTarget,
  testKey: (key, target) => new Promise((resolve) => {
    if (selectedConversationId !== target.conversationId) { resolve({ ok: false, reason: "原任务已变化，请重新打开。" }); return; }
    const requestId = crypto.randomUUID();
    keyTests.set(requestId, resolve);
    setTimeout(() => { if (keyTests.delete(requestId)) resolve({ ok: false, reason: "测试没有回音，再试一次。" }); }, 70_000);
    send({ type: "model_key_test", requestId, key, target: target.config, expectedRunId: target.runId });
  }),
  saveKey: async (target, key, stillCurrent) => {
    if (selectedConversationId !== target.conversationId || !stillCurrent()) return false;
    const credentialHash = await credentialFingerprint(target.credential);
    if (selectedConversationId !== target.conversationId || !stillCurrent()) return false;
    return new Promise<boolean>(resolve => {
      const requestId = crypto.randomUUID();
      const cancel = () => {
        for (let i = queuedSends.length - 1; i >= 0; i -= 1) {
          const envelope = queuedSends[i];
          if (envelope?.kind === "client" && envelope.msg.type === "model_key_save" && envelope.msg.requestId === requestId) queuedSends.splice(i, 1);
        }
        const msg: ClientMessage = { type: "model_key_cancel", requestId, conversationId: target.conversationId ?? undefined };
        try { if (port) port.postMessage({ kind: "client", msg }); else send(msg); } catch {  }
      };
      keySaveCancels.set(requestId, cancel);
      const watch = setInterval(() => { if (selectedConversationId !== target.conversationId || !stillCurrent()) { cancel(); clearInterval(watch); } }, 100);
      keySaves.set(requestId, ok => { clearInterval(watch); keySaveCancels.delete(requestId); if (ok) target.saveRequestId = requestId; resolve(ok); });
      setTimeout(() => { if (keySaves.delete(requestId)) { clearInterval(watch); keySaveCancels.delete(requestId); cancel(); resolve(false); } }, 10_000);
      if (!send({ type: "model_key_save", requestId, key, target: target.config, expectedRunId: target.runId, roles: target.roles, connection: target.connection, credentialHash, conversationId: target.conversationId ?? undefined })) {
        keySaves.delete(requestId);
        keySaveCancels.delete(requestId);
        clearInterval(watch);
        resolve(false);
      }
    });
  },
  scrollToEnd: () => scrollToEnd(true),
});

let port: chrome.runtime.Port | null = null;

let reconnectAttempt = 0;

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




const ORB_BOX_THINKING = 18;

const ORB_BOX_CHIP = 16;

const ORB_BOX_STATUS = 16;

const orbByHost = new WeakMap<HTMLElement, OrbHandle>();

let runStartAt = 0;

interface RunHost {
  sendDeclined?: boolean;
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
  titleEl: HTMLElement;
  orb: OrbHandle;
  timer: number;
  lastToolShort: string | null;
  chipGroup: ChipGroup | null;
  changedPage: boolean;
  titleAt: number;
  titleTimer: number;
  actIcon: HTMLElement;
  trail: HTMLElement;
  metaEl: HTMLElement;
  checkNote: string | null;
  thinkFrom: number;
  thinkSegments: Array<{ start: number; end: number }>;
  aside: string | null;
  guideHint: string | null;
  evidence: HTMLElement | null;
  evidenceLines: Array<{ key: string; field: string; value: string }>;
  answer: { text: string; el: HTMLElement; hostNote: boolean } | null;
  check: "checking" | "done" | "not_done" | "needs_user" | "continued" | "unavailable" | null;
  receipt: { head: string; total: string | null; steps: number; failed: number; ended: "completed" | "failed" | "stopped" } | null;
  graph: LiveGraph;
  beatEl: HTMLElement;
  lastToolName: string | null;
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

let currentRun: RunHost | null = null;

let lastRun: RunHost | null = null;
const sendChangedRuns = new Set<string>();

const deliveredBubbles = new Map<string, HTMLElement>();

const resultByConversation = new Map<string, { summary: string | null; remaining: string[]; unknown: boolean; speechFailed: boolean }>();

let leadDeliveryMode: "explicit" | null = null;

let currentLeadDraft: HTMLElement | null = null;

let currentLeadDraftDetails: HTMLDetailsElement | null = null;

let leadAnswer: HTMLElement | null = null;

let leadAnswerText = "";

let leadAnswerTurnClosed = false;

let leadToolUsed = false;

let goalNote: string | null = null;
let goalStep: { at: number; of: number } | null = null;

interface ChipGroup {
  root: HTMLElement;
  row: HTMLElement;
  detail: HTMLElement;
  expanded: ToolChipEntry | null;
}

interface ToolChipEntry {
  chip: HTMLElement;
  dot: HTMLElement;
  orb: OrbHandle;
  dur: HTMLElement;
  start: number;
  name: string;
  detail: StepDetail | null;
  group: ChipGroup;
}

const toolChips = new Map<string, ToolChipEntry>();

let inspectTimer = 0;
let inspectChip: HTMLElement | null = null;

function pageTargetOf(chip: HTMLElement): { target: string; tabId?: number; url?: string; caption: string } | null {
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

function sendInspect(chip: HTMLElement | null): void {
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

function queueInspect(chip: HTMLElement | null): void {
  window.clearTimeout(inspectTimer);
  inspectTimer = window.setTimeout(() => sendInspect(chip), D_TAP);
}

function bindStepInspect(chip: HTMLElement): void {
  chip.addEventListener("pointerenter", () => queueInspect(chip));
  chip.addEventListener("pointerleave", () => queueInspect(null));
  chip.addEventListener("focus", () => queueInspect(chip));
  chip.addEventListener("blur", () => queueInspect(null));
}

function markChipPageGone(chip: HTMLElement, gone: boolean): void {
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
  banner.textContent = phase === "user" ? (handoffCard?.dataset.choice === "true" ? "等你选择 · 助手在旁边等" : "你在操作 · 助手在旁边等") : phase === "rereading" ? "助手先重读页面" : "";
  document.getElementById("composer")?.classList.toggle("you-operating", phase === "user");
  taskBar.setHandoffShown(phase === "user");
}

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

const toBottomBtn = document.createElement("button");

toBottomBtn.id = "to-bottom";

toBottomBtn.type = "button";

toBottomBtn.title = "回到底部";

toBottomBtn.setAttribute("aria-label", "回到底部");

toBottomBtn.setAttribute("aria-controls", "messages");

toBottomBtn.hidden = true;

toBottomBtn.appendChild(icon(ArrowDown));
const toBottomDot = document.createElement("span");
toBottomDot.className = "to-bottom-dot";
toBottomBtn.appendChild(toBottomDot);
let heightWhenLeft = 0;
const markToBottomNew = (fresh: boolean): void => {
  toBottomBtn.classList.toggle("has-new", fresh);
  toBottomBtn.setAttribute("aria-label", fresh ? "回到底部，有新内容" : "回到底部");
};

app.appendChild(toBottomBtn);

let pinned = true;

let runBodyPinned = true;


let followingLive = false;

const USER_SCROLL_QUIET_MS = 150;

let userScrollAt = -Infinity;

const SEEN_BOTTOM_MS = 100;

let heightLog: Array<{ at: number; height: number }> = [];

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
  el.addEventListener("wheel", (e) => { if (e.deltaY < 0 && el.scrollTop > 0) setPinned(false); }, { passive: true });
  el.addEventListener("scroll", () => {
    syncScrollFade(el, el);
    if (followingLive) return;
    setPinned(isLiveViewportPinned(el.scrollTop, el.scrollHeight, el.clientHeight));
  });
}

function syncScrollFade(el: HTMLElement = messagesEl, frame: HTMLElement = messagesEl.parentElement!): void {
  const top = String(el.scrollTop > 0);
  const bottom = String(el.scrollHeight - el.scrollTop - el.clientHeight > 1);
  if (frame.dataset.fadeTop !== top) frame.dataset.fadeTop = top;
  if (frame.dataset.fadeBottom !== bottom) frame.dataset.fadeBottom = bottom;
}

function markUserScroll(): void {
  userScrollAt = performance.now();
}

function followToEnd(): void {
  const before = messagesEl.scrollTop;
  messagesEl.scrollTop = messagesEl.scrollHeight;
  if (messagesEl.scrollTop !== before) followScrollTop = messagesEl.scrollTop;
}

messagesEl.addEventListener("wheel", markUserScroll, { passive: true });

messagesEl.addEventListener("touchstart", markUserScroll, { passive: true });

messagesEl.addEventListener("touchmove", markUserScroll, { passive: true });

messagesEl.addEventListener("pointerdown", (e) => {
  if (e.target === messagesEl) markUserScroll();
});

document.addEventListener("keydown", (e) => {
  const target = e.target instanceof HTMLElement ? e.target : null;
  if (target?.closest("input, textarea, [contenteditable]")) return;
  if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) markUserScroll();
});

messagesEl.addEventListener("scroll", () => {
  const top = messagesEl.scrollTop;

  const atEnd = messagesEl.scrollHeight - top - messagesEl.clientHeight <= 1;

  if (top === followScrollTop) followScrollTop = -1;
  else {
    const next = seenBottom() - top - messagesEl.clientHeight < 40 && (top >= lastScrollTop || atEnd);

    if (next || userScrolling()) pinned = next;
  }
  lastScrollTop = top;
  toBottomBtn.hidden = pinned;

  if (pinned) {
    heightWhenLeft = 0;
    markToBottomNew(false);
  } else if (!heightWhenLeft) heightWhenLeft = messagesEl.scrollHeight;
  syncScrollFade();
});

new ResizeObserver(() => {
  if (pinned && !userScrolling()) followToEnd();
  syncScrollFade();
  followLive(currentRun?.body ?? null, false);
}).observe(messagesEl);

new MutationObserver(() => {
  noteHeight();
  syncScrollFade();
  followLive(currentRun?.body ?? null, false);

  if (!pinned && !replayingHistory && !toBottomBtn.hidden && !toBottomBtn.classList.contains("has-new") && heightWhenLeft > 0 && messagesEl.scrollHeight > heightWhenLeft + 8) markToBottomNew(true);
}).observe(messagesEl, { childList: true, subtree: true, characterData: true });

function scrollToEnd(force = false): void {
  followLive(currentRun?.body ?? null, force || runBodyPinned);

  if (force || (pinned && !userScrolling())) followToEnd();
  else if (pinned && !followRetry) followRetry = window.setTimeout(() => { followRetry = 0; scrollToEnd(); }, USER_SCROLL_QUIET_MS);
  toBottomBtn.hidden = pinned || nearBottom();
}

toBottomBtn.onclick = () => {
  pinned = true;
  followToEnd();
  toBottomBtn.hidden = true;
  heightWhenLeft = 0;
  markToBottomNew(false);
};

const USER_MSG_FILES_SHOWN = 4;

function addUserMsg(text: string, atts?: Attachment[]): HTMLElement {
  const div = document.createElement("div");
  div.className = "msg user";

  if (atts && atts.length > 0) {
    const thumbs = document.createElement("div");
    thumbs.className = "user-msg-attachments";

    const files = atts.filter(att => att.type === "file");
    const shownFiles = files.length > USER_MSG_FILES_SHOWN + 1 ? USER_MSG_FILES_SHOWN : files.length;

    for (const att of atts) {
      if (att.type === "file") {
        const chip = fileChip(att.name, att.format, fileMeta(att)).el;
        chip.classList.add("user-msg-file");
        chip.hidden = files.indexOf(att) >= shownFiles;

        if (att.note) chip.title = att.note;
        thumbs.appendChild(chip);
      } else if (att.type === "image") {
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

    if (shownFiles < files.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "user-msg-files-more";
      more.textContent = `+${files.length - shownFiles} 个文件`;
      more.onclick = (e) => {
        e.stopPropagation();
        thumbs.querySelectorAll<HTMLElement>(".user-msg-file[hidden]").forEach(chip => { chip.hidden = false; });
        more.remove();
      };
      thumbs.appendChild(more);
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

  pinned = true;
  scrollToEnd();

  return div;
}

function renderTurnContext(bubble: HTMLElement, context: UserTurnContext): void {
  const next = bubble.nextElementSibling;
  const row = next instanceof HTMLElement && next.matches(".ctx-chips") ? next : document.createElement("div");
  row.className = "ctx-chips";
  row.setAttribute("aria-label", "这一轮带给助手的内容");
  const chips: HTMLElement[] = [];
  const host = hostOf(context.url);

  const pageTitle = [context.title, context.url].filter(Boolean).join("\n");

  const pageName = context.title || host;
  if (pageName && previousPageChipTitle(bubble) !== pageTitle && pageSourceVisible(pageName, bubble)) {
    const glyph = siteGlyph(context.url, host);
    glyph.className = "cg";
    const chip = ctxChip(glyph, `来自页面：${clipTitle(pageName, 22)}`, pageTitle);
    chip.classList.add("page", "page-from");
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

function pageSourceVisible(title: string, bubble: HTMLElement): boolean {
  const name = title.trim();
  if (!name) return false;
  if ([...name].length <= 24) return true;
  const ask = bubble.querySelector(".user-msg-text")?.textContent ?? bubble.textContent ?? "";
  const askChars = new Set([...ask].filter((ch) => /[\u4e00-\u9fffA-Za-z0-9]/.test(ch)));
  return [...name].filter((ch) => askChars.has(ch)).length >= 4;
}

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

const separateAskOrigins = new Map<string, string>();

function resumeSeparateAsk(receipt: TaskReceipt): boolean {
  const context = activeTabContext();

  return send({ type: "task_action", request: { requestId: crypto.randomUUID(), conversationId: receipt.conversationId, source: "text", action: "resume", expectedRunId: receipt.runId, ...(context ? { context } : {}) } });
}

function isSeparateAsk(receipt: TaskReceipt): boolean {
  return receipt.source === "text" && receipt.action === "start" && receipt.originConversationId === selectedConversationId && receipt.conversationId !== selectedConversationId;
}

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
  const paused = receipt.status === "queued" && /连接(已重启|断开)/.test(receipt.message);
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
    resume.onclick = () => { resume.disabled = true; const context = activeTabContext(); if (!send({ type: "task_action", request: { requestId: crypto.randomUUID(), conversationId: receipt.conversationId, source: "text", action: "resume", expectedRunId: null, ...(context ? { context } : {}) } })) resume.disabled = false; };
    actions.append(resume);
  }

  if (stopped) {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.textContent = "继续";
    resume.onclick = () => { resume.disabled = true; if (!resumeSeparateAsk(receipt)) resume.disabled = false; else setTimeout(() => { resume.disabled = false; }, 15_000); };
    actions.append(resume);
  }

  if (!receipt.result && (receipt.status === "queued" || receipt.status === "accepted")) {
    const merge = document.createElement("button");
    merge.type = "button";
    merge.textContent = "改成补充上一件";
    merge.onclick = () => {
      merge.disabled = true;
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
  let note = lastUserBubbleFor(receipt.text)?.nextElementSibling;
  if (note?.matches(".ctx-chips")) note = note.nextElementSibling;
  if (note instanceof HTMLElement && note.matches(".steer-received")) {
    const label = note.querySelector(".steer-received-label");
    if (label) label.textContent = receipt.status === "applied" ? "已收到 · 并回上一件处理" : "另开一件 · 不打断当前任务";
  }
}

function markSteerReceived(bubble: HTMLElement): void {
  const note = document.createElement("div");
  note.className = "steer-received";
  const label = document.createElement("span");
  label.className = "steer-received-label";
  label.textContent = "已收到 · 接在当前任务里处理";
  note.append(label);
  const saveButton = bubble.querySelector<HTMLButtonElement>(".pskill-save");
  if (saveButton) note.append(saveButton);
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
    const container = messagesEl as HTMLElement & { moveBefore?: (child: Node, before: Node | null) => void };

    if (typeof container.moveBefore === "function") container.moveBefore(node, anchor);
    return;
  }

  if (anchor) {
    messagesEl.insertBefore(node, anchor);
  } else {
    messagesEl.appendChild(node);
  }
}

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

const pendingSiteNoteDeletes = new Map<string, (ok: boolean, error?: string) => void>();
let siteNoteListRequest = "";
const siteNoteManagement = document.getElementById("site-note-management") as HTMLDetailsElement;
const siteNoteBody = document.getElementById("site-note-management-body")!;

function requestSiteNotes(): void {
  siteNoteListRequest = crypto.randomUUID();
  const requestId = siteNoteListRequest;
  siteNoteBody.textContent = "正在读取…";
  if (!send({ type: "site_note_list", requestId })) { siteNoteBody.textContent = "未连接，无法读取。请刷新重试。"; return; }
  setTimeout(() => { if (siteNoteListRequest === requestId) { siteNoteListRequest = ""; siteNoteBody.textContent = "读取超时，请刷新重试。"; } }, 15000);
}
siteNoteManagement.addEventListener("toggle", () => { if (siteNoteManagement.open) requestSiteNotes(); });
document.getElementById("site-note-refresh")!.addEventListener("click", requestSiteNotes);
memoryOpen.addEventListener("click", () => { if (!memoryDrawer.hidden && siteNoteManagement.open) requestSiteNotes(); });
chrome.runtime.onMessage.addListener((message, sender) => {
  if (sender.id === chrome.runtime.id && message?.type === "site_notes_changed" && !memoryDrawer.hidden && siteNoteManagement.open) requestSiteNotes();
});

function renderSiteNoteList(msg: Extract<ServerMessage, { type: "site_note_list_result" }>): void {
  if (msg.requestId !== siteNoteListRequest) return;
  siteNoteListRequest = "";
  siteNoteBody.replaceChildren();
  if (!msg.ok || !msg.notes) { siteNoteBody.textContent = `无法读取：${plainError(msg.error, "请再试一次")}`; return; }
  const paused = document.createElement("p");
  paused.textContent = "自动学习和使用已暂停。已有站点用法仍可查看或删除。";
  siteNoteBody.append(paused);
  if (!msg.notes.length) { const empty = document.createElement("p"); empty.textContent = "暂无站点用法"; siteNoteBody.append(empty); }
  for (const note of msg.notes) {
    const row = document.createElement("p");
    const label = document.createElement("span");
    label.textContent = `${note.host}：${note.text} `;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "删除";
    const status = document.createElement("span");
    button.onclick = () => {
      const requestId = crypto.randomUUID();
      button.disabled = true;
      status.textContent = "正在删除…";
      const timer = setTimeout(() => {
        if (!pendingSiteNoteDeletes.delete(requestId)) return;
        button.disabled = false;
        status.textContent = "删除结果未知，请重新打开列表核对。";
      }, 15000);
      pendingSiteNoteDeletes.set(requestId, (ok, error) => {
        clearTimeout(timer);
        if (ok) { row.remove(); void chrome.runtime.sendMessage({ type: "site_notes_changed" }).catch(() => {}); }
        else { button.disabled = false; status.textContent = `删除失败：${plainError(error, "请再试一次")}`; }
      });
      if (!send({ type: "site_note_delete", requestId, ...note })) {
        pendingSiteNoteDeletes.delete(requestId); clearTimeout(timer); button.disabled = false; status.textContent = "未连接，删除失败。";
      }
    };
    row.append(label, button, status);
    siteNoteBody.append(row);
  }
}

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

function awaitingFirstStep(): boolean {
  const last = [...messagesEl.children].reverse().find((e) => e.matches(".msg.user, .msg.assistant, details.run-steps"));

  return !!last?.matches(".msg.user");
}

function ensureRun(): NonNullable<typeof currentRun> {
  if (currentRun) return currentRun;
  const root = document.createElement("details");
  root.className = "run-steps";
  root.dataset.phase = "thinking";
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
  paintAction(title, `正在：${loaderSubtitle(null)}`);
  const chainEl = document.createElement("span");
  chainEl.className = "run-chain";
  const timeEl = document.createElement("span");
  timeEl.className = "run-time";
  const chevron = document.createElement("span");
  chevron.className = "run-chevron";
  chevron.appendChild(icon(ChevronRight));
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
  if (replayingHistory) appendToMessages(root);
  else messagesEl.appendChild(root);
  const graph = mountLiveGraph({ history: () => applyingHistory });
  root.after(graph.el);
  const trail = document.createElement("div");
  trail.className = "run-trail";
  trail.hidden = true;
  graph.el.after(trail);
  const start = runStartAt || eventTime();
  retirePlanCard();

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
    lastToolName: null,
    readingTools: new Map(),
  };
  startLiveSeconds(currentRun, start);

  return currentRun;
}

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

const SHOW_SECS_MS = 3_000;

const THINK_MIN_MS = 100;

function stopLiveSeconds(run: RunHost): void {
  if (!run.timer) return;
  clearInterval(run.timer);
  run.timer = 0;
}

const WAIT_STALE_MS = 15_000;
const WAIT_STALE_TITLE = "还没有回音";
const THINKING_TITLE = "正在：思考";

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

function liveSeconds(run: RunHost): string {
  return refreshLiveStatus(run);
}

function runningTool(run: RunHost) {
  return [...toolChips.values()].find(entry => entry.chip.isConnected && run.body.contains(entry.chip));
}

function refreshLiveStatus(run: RunHost): string {
  if (run.root.hasAttribute("data-wait-user") || applyingHistory) return "";
  const tool = runningTool(run);
  const from = Number.isFinite(run.thinkFrom) ? run.thinkFrom : tool && Number.isFinite(tool.start) ? tool.start : Number.NaN;
  const step = Number.isFinite(run.thinkFrom) ? "思考" : (tool?.chip.dataset.past || run.lastToolShort || "这一步");
  const status = liveStatus({ step: plainStep(step), from, now: Date.now() });
  if (!status) return "";
  const shown = run.titleEl.textContent ?? "";
  if (shown !== status.title && (shown === "" || shown.startsWith("正在：") || shown === "仍在处理")) setRunTitle(run, status.title, true, Number.isFinite(run.thinkFrom) ? "think" : undefined);
  return status.time;
}

function maybeStaleWait(run: RunHost): void {
  refreshLiveStatus(run);
}

function closeThink(run: RunHost, at: number): void {
  const from = run.thinkFrom;
  run.thinkFrom = Number.NaN;

  if (!Number.isFinite(from) || !Number.isFinite(at) || at - from < THINK_MIN_MS) return;
  run.thinkSegments.push({ start: from, end: at });

  if (at - from < SHOW_SECS_MS) return;
  const row = document.createElement("div");
  row.className = "run-think";
  row.textContent = `想了 ${spokenDuration(from, at)}`;
  (run.chipGroup?.row ?? run.body).appendChild(row);
}

function openThink(run: RunHost, at: number): void {
  if (Number.isFinite(run.thinkFrom)) return;
  run.thinkFrom = at;

  if (run.timer) {
    stopLiveSeconds(run);
    startLiveSeconds(run, at);
    run.timeEl.textContent = liveSeconds(run);
  }
}

function doneSteps(run: RunHost): HTMLElement[] {
  return Array.from(run.body.querySelectorAll<HTMLElement>(".chip:not(.prep):not(.note):not(.running)"));
}

function renderRunMeta(run: RunHost): void {
  const done = doneSteps(run);
  const failed = done.filter(chip => chip.classList.contains("error")).length;
  const steps = runMetaLine(done.length, failed) ?? "";
  const text = [run.checkNote, steps].filter(Boolean).join(" · ");

  if (run.metaEl.textContent !== text) run.metaEl.textContent = text;
  run.metaEl.hidden = !text;
}

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

let teamRunId: string | null = null;

function setTeamView(next: TeamView | null): void {
  applyTeamRun(next === null ? emptyTeamRun() : { team: next, runId: teamRunId });
}

function applyTeamRun(next: TeamRunState): void {
  if (next.team === teamView && next.runId === teamRunId) return;
  teamView = next.team;
  teamRunId = next.runId;
  setSessionState(LEAD_SESSION_ID, sessionRun.get(LEAD_SESSION_ID) ?? (next.team ? "user" : "idle"));
}

function noteRunStarted(runId: string | null | undefined): void {
  if (!isRunId(runId)) return;
  applyTeamRun(observeRunStarted({ team: teamView, runId: teamRunId }, runId));
}

function applyTeamStatus(team: TeamView, runId: string | null | undefined): void {
  const decision = acceptTeamStatus({ team: teamView, runId: teamRunId }, team, runId, applyingHistory);

  if (decision.accept) applyTeamRun(decision.state);
}

function renderTaskStrip(): void {
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
    const phase = document.getElementById("handoff-banner")?.dataset.phase;

    if (flags.userHasPage && phase !== "user" && phase !== "leaving") applyHandoffPhase("user");
    else if (!flags.userHasPage && phase === "user") applyHandoffPhase("agent");
  }

  takeoverBtn.hidden = !flags.takeoverVisible && !flags.userHasPage;
  translateBtn.hidden = !takeoverBtn.hidden;
  takeoverBtn.dataset.mode = flags.userHasPage ? "handback" : "takeover";
  const handingOver = teamView?.phase === "draining" || teamView?.phase === "restoring";
  takeoverBtn.disabled = handingOver;
  const handback = handoffCard?.querySelector<HTMLButtonElement>(".btn-primary");
  if (handback) handback.disabled = !flags.userHasPage || handingOver;
  takeoverBtn.textContent = flags.userHasPage ? "交还" : "接管";
  takeoverBtn.title = flags.userHasPage ? "交还：助手先重读页面，再接着做。" : "接管：助手暂停，由你操作页面。操作完，点「交还」。";
  steerRibbon.setRunning(running && !flags.userHasPage);

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
          ? (handoffCard?.dataset.choice === "true" ? "回复你的选择，我会接着做" : handoffCard ? "做好了说一声，我接着做" : PLACEHOLDER_USER)
          : flags.composer === "running"
            ? PLACEHOLDER_RUNNING
            : PLACEHOLDER_IDLE;

  if (flags.userHasPage && currentRun) {
    stopLiveSeconds(currentRun);
  }

  if (currentRun) {
    if (teamView?.phase === "aborted") currentRun.orbActivity.stop();
    syncRunOrb(currentRun);
  }

  if (flags.finishRun) {
    const outcome = currentRun?.orbActivity.state();

    if (outcome === "stopped" || outcome === "failed") foldLeadAnswer();
    closeBlocks();
    finishRun();
    sessionRun.clear();
    }
}

function addChainStep(label: string): void {
  const run = ensureRun();
  run.chain.push(label);
  run.chainEl.textContent = run.chain.render();
}

const RUN_ORB_MARKS = {
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
  for (const acts of run.root.querySelectorAll(".run-escalate")) acts.remove();
  lastRun = run;
  stopLiveSeconds(run);
  const endedAt = eventTime();
  closeThink(run, endedAt);
  run.trail.remove();
  const hasSteps = Array.from(run.body.children).some(child => !(child as HTMLElement).hidden);
  run.orbActivity.finish();
  const outcome = run.orbActivity.state();
  const hasResumeReceipt = !!run.body.querySelector(".receipt-history");
  const keepProcess = run.changedPage || hasResumeReceipt || outcome === "failed" || outcome === "stopped" || cardTurn(run.root);

  if (!run.checkNote && (!hasSteps || !keepProcess)) {
    const drop = () => {
      run.root.remove();
      run.graph.el.remove();

      if (lastRun === run) lastRun = null;
    };

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
    const done = Array.from(run.body.querySelectorAll<HTMLElement>(".chip:not(.prep):not(.note)"));
    const ended = outcome === "failed" || outcome === "stopped" ? outcome : "completed";
    const only = done.length === 1 && ended === "completed" ? done[0] : null;
    setActionIcon(run.actIcon, only ? (only.dataset.kind as IconKind) : "many");
    clearTimeout(run.titleTimer);

    const failed = done.filter(chip => chip.classList.contains("error")).length;
    const skillChip = ended === "completed" ? done.find(chip => chip.dataset.skill === "saved" || chip.dataset.skill === "used") ?? done.find(chip => chip.dataset.skill === "unused") : undefined;
    const head = hasResumeReceipt && done.length === 0 && ended === "completed" ? "恢复记录"
      : skillChip?.dataset.past ? skillChip.dataset.past
      : only?.dataset.past ? only.dataset.past
      : finishedRunTitle(ended === "completed" ? done.length - failed : done.length, ended, failed);
    run.receipt = { head, total: spokenDuration(run.start, endedAt), steps: done.length, failed, ended };

    if (Number.isFinite(endedAt)) run.root.dataset.endedAt = String(endedAt);

    if (hasResumeReceipt && done.length === 0 && ended === "completed") setRunTitle(run, head, true);
    else if (skillChip || only?.dataset.past) setRunTitle(run, head, true);
    else {
      const names = ended === "failed" ? [] : done.filter(chip => !chip.classList.contains("error")).map(chip => chip.dataset.short ?? "").filter(Boolean);
      paintReceipt(title, head, names, ended === "completed" && failed ? ` · ${failed} 次没做成` : "");
    }
  }

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

  if (run.receipt && (run.root.classList.contains("plan-card") || planUndo)) {
    run.root.classList.add("plan-card");
    planCardRun = run;
    paintPlanCard();
  }

  if (planTop !== null) messagesEl.scrollTop += run.root.getBoundingClientRect().top - planTop;
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

let planCardRun: RunHost | null = null;
let planUndo: FillUndoView | null = null;

function retirePlanCard(): void {
  if (!planCardRun) { planUndo = null; return; }

  if (planUndo?.state === "ready") {
    const button = planCardRun.root.querySelector<HTMLButtonElement>(".plan-undo");
    if (button?.previousSibling?.textContent === " · ") button.previousSibling.remove();
    button?.remove();
    const scope = planCardRun.root.querySelector(".plan-fill-scope p");
    if (scope) scope.textContent = "新任务已开始，上一轮的填写记录不再用于恢复。";
  }
  planCardRun = null;
  planUndo = null;
}

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

  if (answer && undo) handFillUndoToCard(answer, run.root);
  paintPlanReceipt(run.root, {
    filled: undo?.state === "ready" ? undo.count + (undo.unavailable?.length ?? 0) : undo?.state === "restored" ? undo.restored.length + undo.skipped.length + (undo.unavailable?.length ?? 0) : undo ? undo.fields.length || null : null,
    steps: run.receipt.steps - run.receipt.failed,
    total: run.receipt.total,
    ended: run.receipt.ended,
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

function runForDelivery(runId: string | null): RunHost | null {
  const run = currentRun ?? lastRun;
  const own = run?.root.dataset.runId;

  return run && !(own && runId && own !== runId) ? run : null;
}

function noteRunAnswer(delivery: UserDelivery, el: HTMLElement): void {
  if (delivery.kind !== "finding") return;
  const run = runForDelivery(delivery.runId);

  if (!run) return;
  run.answer = { text: delivery.text, el, hostNote: !!delivery.hostNote };

  if (run !== currentRun && run.root.isConnected && run.root.classList.contains("done")) foldAnsweredRun(run);
}

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

function latestAnswerEl(): HTMLElement | null {
  for (let node = messagesEl.lastElementChild; node && !node.matches(".msg.user"); node = node.previousElementSibling) {
    if (node instanceof HTMLElement && node.matches(".msg.assistant[data-delivery-id]:not(.opening-line)") && node.dataset.deliveryKind !== "ack") return node;
  }

  return null;
}

function comparableText(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[\s*_`#>~|-]/g, "");
}

function foldAnsweredRun(run: RunHost): void {
  const answer = run.answer;

  if (!answer || !run.receipt) return;

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
  attachSkillUndo(run);
}

function attachSkillUndo(run: RunHost, answer = run.answer?.el): void {
  const id = run.body.querySelector<HTMLElement>('.chip[data-skill="saved"]')?.dataset.skillId;
  const actions = answer?.querySelector<HTMLElement>(":scope > .answer-actions");

  if (!id || !actions || actions.querySelector(".skill-undo")) return;
  const undo = document.createElement("button");
  undo.type = "button";
  undo.className = "skill-undo";
  undo.dataset.skillId = id;
  undo.textContent = "撤销";
  undo.title = "删掉刚存的这条技能";
  undo.addEventListener("click", () => {
    undo.disabled = true;

    if (!deleteSkillOperation(id, ok => { if (!ok) { undo.textContent = "没撤销成，再试一次"; undo.disabled = false; } })) {
      undo.disabled = false;
      undo.textContent = "没连上，再试一次";
    }
  });
  actions.prepend(undo);
  refreshSkillOperations();
}

function resumeCardShown(): boolean {
  const root = document.getElementById("resume-entry-root");

  return !!root?.isConnected && !root.hidden && root.childElementCount > 0 && !!root.closest("#messages");
}

function runCheckStatus(run: RunHost): { text: string; tone: "ok" | "warn" | null } | null {
  if (!run.receipt || run.receipt.ended !== "completed") return null;

  if (run.root.dataset.runId && sendChangedRuns.has(run.root.dataset.runId)) return null;
  if (run.check === "checking") return { text: "核对中…", tone: null };

  if (run.check === "done") return { text: "已核对页面", tone: "ok" };
  const notDone = run.receipt.failed ? `有 ${run.receipt.failed} 步没做成` : "还没做成";

  if (run.check === "not_done") return resumeCardShown() ? null : { text: notDone, tone: "warn" };

  if (run.check !== "continued" && run.check !== "needs_user" && run.answer?.hostNote) return { text: notDone, tone: "warn" };

  return null;
}

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
  const kept = status?.tone === "ok" ? title.querySelector<HTMLElement>(":scope > .run-done-mark") : null;
  const mark = status?.tone === "ok" ? kept ?? doneMark(run) : null;

  for (const node of [...title.childNodes]) if (node !== mark) node.remove();

  if (mark && !mark.isConnected) title.prepend(mark);
  title.append(verb, tail, check);
}

function placeProcessBeforeAnswer(root: HTMLElement): void {
  let anchor: Element | null = root.previousElementSibling;

  while (anchor && !anchor.classList.contains("user")) anchor = anchor.previousElementSibling;

  if (!anchor) return;
  let redo: Element | null = null;

  for (let node = anchor.nextElementSibling; node && node !== root; node = node.nextElementSibling) {
    if (node.classList.contains("redo-anchor")) redo = node;
  }

  if (redo) { if (redo.nextElementSibling !== root) redo.after(root); return; }
  let next = anchor.nextElementSibling;

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

function stepsContainer(): HTMLElement {
  return currentRun?.body ?? messagesEl;
}

function closeBlocks(): void {
  if (currentAssistant) {
    const answer = currentAssistant;
    revealText(answer, currentAssistantText, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd, after: () => attachAnswerActions(answer) });
  }

  document.querySelector(".msg.assistant.streaming")?.classList.remove("streaming");

  currentAssistant = null;
  currentAssistantText = "";

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

let quietTimer = 0;

function quietRunForProse(): void {
  const run = currentRun;

  if (!run || run.body.querySelector(".chip") || run.root.classList.contains("plan-card")) return;
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

function appendLeadAnswer(delta: string): void {
  const run = ensureRun();

  if (leadAnswer && leadAnswerTurnClosed) foldLeadAnswer();

  if (!leadAnswer) {
    quietRunForProse();
    leadAnswer = addMsg("msg assistant markdown streaming", "");
    leadAnswerText = "";
    leadAnswerTurnClosed = false;
    steerRibbon.decorate(leadAnswer, !replayingHistory);
  }

  leadAnswerText += delta;
  revealText(leadAnswer, leadAnswerText, { render: renderMarkdown, live: !replayingHistory, final: false, onProgress: scrollToEnd });
}

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

function keepOpeningLine(line: HTMLElement): void {
  revealText(line, leadAnswerText, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd });
  line.classList.remove("streaming");
  line.classList.add("opening-line");

  if (currentRun) messagesEl.insertBefore(line, currentRun.root);
  leadAnswer = null;
  leadAnswerText = "";
  leadAnswerTurnClosed = false;
}

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

const traceText = new WeakMap<HTMLElement, string>();

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

function appendDelta(delta: string): void {
  if (!currentAssistant) {
    currentAssistant = addMsg("msg assistant markdown streaming", "");
  }
  currentAssistantText += delta;
  revealText(currentAssistant, currentAssistantText, { render: renderMarkdown, live: !replayingHistory, final: false, onProgress: scrollToEnd });

  scrollToEnd();
}

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

function renderChipDetail(entry: ToolChipEntry): void {
  const detail = entry.group.detail;
  const found = entry.detail;

  if (!found) return;
  const line = document.createElement(found.href ? "a" : "div");
  line.className = "chip-detail-text";
  line.textContent = found.text;

  if (line instanceof HTMLAnchorElement && found.href) {
    line.href = found.href;
    line.target = "_blank";
    line.rel = "noopener noreferrer";
  }

  detail.replaceChildren(line);
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

const PAGE_VIEWING_TOOLS = new Set(["scroll", "hover", "arm_event", "wait_event", "disarm_event"]);

let handoffCard: HTMLElement | null = null;

function showHandoffCard(ask: string, choice = false): void {
  const card = document.createElement("div");
  card.className = "handoff-card";
  if (choice) card.dataset.choice = "true";
  const title = document.createElement("strong");
  title.textContent = choice ? "需要你选一下" : "需要你来这一步";
  const body = document.createElement("p");
  body.className = "handoff-ask";
  body.textContent = ask;
  const note = document.createElement("p");
  note.className = "handoff-note";
  note.textContent = choice ? "回复选择后，我会接着操作。" : "交给你期间，我不读也不动这个页面。";
  const actions = document.createElement("div");
  actions.className = "handoff-actions";
  const done = document.createElement("button");
  done.type = "button";
  done.className = "btn-primary";
  done.textContent = choice ? "继续" : "做好了，交还";
  done.disabled = !panelLive(sessionRun.values(), teamView).userHasPage || teamView?.phase === "draining" || teamView?.phase === "restoring";
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
  if (handoffCard.dataset.choice === "true" && text.startsWith("你已交还")) text = "已继续 · 我从当前页面接着做";
  handoffCard.className = "handoff-done";
  handoffCard.textContent = text;
  handoffCard = null;
}

function changesPage(name: string, tabsAction: string | undefined, method: unknown): boolean {
  if (name === "tabs") return tabsAction === "open" || tabsAction === "close";

  if (name === "fetch") return String(method ?? "GET").toUpperCase() === "POST";

  return isWriteTool(name) && !PAGE_VIEWING_TOOLS.has(name);
}

function onToolStart(ev: { toolCallId: string; name: string; params: Record<string, unknown>; detail?: StepDetail }): void {
  const action = describeTool(ev.name, ev.params);
  const run = ensureRun();
  closeBlocks();
  closeThink(run, eventTime());

  if (ev.name === "hand_to_user") {
    run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
    syncRunOrb(run);
    showHandoffCard(String(ev.params.ask ?? ""), !!handoffChoices(ev.params.ask, ev.params.kind, ev.params.options));

    return;
  }

  collapseHandoffCard();

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

  if (!run.chipGroup) run.chipGroup = buildChipGroup(run.body);
  const group = run.chipGroup;

  const prep = isPrepTool(ev.name, ev.params);
  run.readingTools.set(ev.toolCallId, prep);
  run.orbActivity.observe({ kind: "tool_start", ...ev }, "main");
  syncRunOrb(run);

  if (ev.name === "guide_step" || changesPage(ev.name, typeof ev.params.action === "string" ? ev.params.action : undefined, ev.params.method)) run.changedPage = true;

  const kind: IconKind = prep ? "read" : actionKind(ev.name, ev.params);

  run.lastToolName = ev.name;

  if (orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    setRunTitle(run, `正在：${actionCardLabel(ev.name, ev.params)}`, false, kind);
  }

  const expandable = ev.detail ?? null;
  const chip = document.createElement(expandable ? "button" : "div");
  if (chip instanceof HTMLButtonElement) chip.type = "button";
  chip.className = prep ? "chip prep" : "chip";
  chip.dataset.kind = kind;
  chip.dataset.past = pastAction(ev.name, ev.params);
  chip.dataset.short = shortAction(ev.name, ev.params);

  if (ev.name === "learned_operation" && (ev.params.action === "save" || ev.params.action === "delete")) chip.dataset.skillWrite = "1";
  if (expandable) chip.setAttribute("aria-expanded", "false");

  if (!applyingHistory) chip.classList.add("running");
  const dot = document.createElement("span");
  dot.className = `chip-dot ${chipState(false, false)}`;
  const iconBox = document.createElement("span");
  iconBox.className = "chip-icon";
  setActionIcon(iconBox, kind);
  const chipOrb = createOrb("solving", ORB_BOX_CHIP);

  if (!applyingHistory) chipOrb.setRunning(true);
  const label = document.createElement("span");
  label.className = "chip-label";
  paintAction(label, actionCardLabel(ev.name, ev.params));
  const dur = document.createElement("span");
  dur.className = "dur";
  dur.hidden = true;
  chip.append(dot, iconBox, label, dur);

  if (expandable) {
    const more = document.createElement("span");
    more.className = "chip-more";
    more.appendChild(icon(ChevronRight));
    chip.append(more);
  }

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
    detail: expandable,
    group,
  };

  if (expandable) chip.onclick = () => toggleChipDetail(entry);
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

function onToolEnd(ev: { toolCallId: string; isError: boolean; pageTitle?: string; timeout?: { copy: string; retry: boolean }; reason?: string; repeatRefused?: true; heldReason?: HeldReason; sendConfirmed?: true; pageTarget?: { target: string; label: string; tabId: number; url: string }; skill?: { id: string; name: string; outcome: "saved" | "used" | "unused" } }): void {
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

  if (run && run === currentRun && !toolChips.size && orbStateRuns(run.orbActivity.state(lastUserHasPage))) {
    run.lastToolName = null;
    setRunTitle(run, THINKING_TITLE, false, "think");
    openThink(run, eventTime());
  }

  if (!entry) return;
  const failed = ev.isError && !ev.repeatRefused && !ev.heldReason;
  entry.dot.className = `chip-dot ${chipState(true, failed)}`;
  entry.chip.classList.remove("running");
  entry.orb.setRunning(false);

  if (!applyingHistory) {
    entry.dot.classList.add("settling");
    window.setTimeout(() => entry.dot.classList.remove("settling"), 500);
  }

  const end = eventTime();
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
  const pageTitle = !failed && entry.chip.dataset.kind === "open" ? ev.pageTitle ?? null : null;

  if (ev.pageTarget?.label && isStepName(ev.pageTarget.label) && label && !pageTitle && !ev.heldReason) {
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

  if (entry.name === "learned_operation") refreshSkillOperations();

  if (ev.skill && label) {
    const text = skillStepText(ev.skill);
    entry.chip.dataset.past = text;
    entry.chip.dataset.short = text;
    entry.chip.dataset.skill = ev.skill.outcome;
    entry.chip.dataset.skillId = ev.skill.id;
    paintAction(label, text);
  }

  if (ev.repeatRefused && label) label.append("（已做过，没再重复）");

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
    const timeout = ev.timeout ?? null;
    const note = document.createElement("span");
    note.className = "act-failed";
    note.textContent = ` · ${timeout?.copy ?? ev.reason ?? "没做成"}`;
    label.append(note);
    if (timeout) {
      const acts = document.createElement("span");
      acts.className = "run-escalate";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "重试";
      retry.onclick = (event) => { event.preventDefault(); event.stopPropagation(); sendInput("重试刚才没做成的那一步。"); };
      const other = document.createElement("button");
      other.type = "button";
      other.textContent = "换个方法";
      other.onclick = (event) => { event.preventDefault(); event.stopPropagation(); sendInput(STEER_OTHER_WAY); };
      const halt = document.createElement("button");
      halt.type = "button";
      halt.textContent = "中止";
      halt.onclick = (event) => { event.preventDefault(); event.stopPropagation(); if (run && currentRun === run && sendBtn.classList.contains("stopping")) stopCurrentTask(); };
      if (timeout.retry) acts.append(retry);
      acts.append(other, halt);
      label.after(acts);
    }
  }

  run?.graph.end(ev.toolCallId, {
    failed,
    reason: ev.reason ?? (failed ? "没做成" : undefined),
    result: pageTitle ?? (failed ? undefined : entry.chip.dataset.short),
    label: entry.chip.dataset.short ?? undefined,
  });

  if (run && run === currentRun) renderRunMeta(run);

  scrollToEnd();
}

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
      if (ev.action === "used") memoryInline.noteUsed(ev);
      else if (!(ev.action === "saved" && ev.entries.some(entry => memoryInline.isLearnedRule(entry.id)))) memoryInline.renderReceipt(ev);
      refreshMemoryIfStale(ev.rev);
      break;
    case "memory_ask":
      memoryInline.renderAsk(ev);
      break;
    case "site_notes":
      renderSiteNotesReceipt(ev);
      break;
    case "answer_sources":
      receiveSourceExcerpts(ev.sources);
      break;
    case "fact_check": {
      const answer = renderFactCheck(ev, messagesEl, (answer, text) => {
        answer.dataset.markdown = text;
        if (answer === currentAssistant) currentAssistantText = text;
        revealText(answer, text, { render: renderMarkdown, live: false, final: true, after: () => attachAnswerActions(answer) });
      });
      if (!replayingHistory) uiEvent("ui_fact_check", {
        outcome: answer ? "applied" : "answer_missing",
        problems: ev.problems.length,
        documentVisible: !document.hidden,
        answerId: answer?.dataset.deliveryId ?? null,
      }, runId ?? null);
      break;
    }
    case "text_delta":
      if (currentRun) closeThink(currentRun, eventTime());

      if (leadDeliveryMode === "explicit") {
        if (leadToolUsed) appendLeadDelta(ev.delta);
        else appendLeadAnswer(ev.delta);
      } else {
        appendDelta(ev.delta);
      }

      break;
    case "thinking_delta":
      break;
    case "tool_start":
      if (leadDeliveryMode === "explicit") {
        if (!leadToolUsed && leadAnswer && leadAnswerText.trim()) keepOpeningLine(leadAnswer);
        else foldLeadAnswer();
        leadToolUsed = true;
      }

      onToolStart(ev);
      break;
    case "send_confirm_wait": {
      const run = currentRun;
      if (run && ev.confirm?.outcome === "decline") run.sendDeclined = true;
      const resultRun = run ?? lastRun;
      const resultRunId = runId ?? resultRun?.root.dataset.runId;
      if (resultRunId && (ev.confirm?.clicked === "changed" || ev.confirm?.clicked === "unverified")) {
        if (sendChangedRuns.size >= 200) sendChangedRuns.delete(sendChangedRuns.values().next().value!);
        sendChangedRuns.add(resultRunId);
      }
      if (resultRun && ev.confirm?.clicked === "yes") resultRun.sendDeclined = false;
      if (resultRunId && ev.confirm?.clicked === "yes") sendChangedRuns.delete(resultRunId);
      if (resultRun?.answer && resultRun.receipt && resultRun.root.classList.contains("done") && ev.confirm?.clicked) paintAnsweredTitle(resultRun);
      const card = sendConfirmCard(ev.confirm);

      if (card && !document.getElementById("confirm-dock")?.contains(card)) {
        appendToMessages(card);
        scrollToEnd();
      }

      if (ev.confirm?.clicked) break;

      if (run) {
        run.root.toggleAttribute("data-wait-user", ev.waiting);

        if (ev.waiting) {
          closeThink(run, eventTime());
          setRunTitle(run, "等你确认", true);
        } else {
          setRunTitle(run, "正在：思考", true, "think");
          openThink(run, eventTime());
        }
      }

      if (run && !ev.waiting && run.guideHint) {
        run.guideHint = null;
        renderTrail(run);
      }

      break;
    }
    case "guide_wait": {
      const run = currentRun;

      if (!run) break;
      const waiting = ev.waiting && ev.guide;
      setRunTitle(run, waiting ? `第 ${waiting.step} 步 · 等你操作` : THINKING_TITLE, true, waiting ? undefined : "think");
      run.root.toggleAttribute("data-wait-user", !!waiting);

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
      ensureRun();

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

      resumeEntry.holdForCheck(ev.status === "checking");
      if (ev.status === "checking" && ev.gate && currentRun) setRunTitle(currentRun, "正在对一遍还有没有没做的", true, "think");
      const checked = currentRun ?? lastRun;

      if (checked) {
        checked.check = ev.status === "checking" ? "checking" : ev.status === "done" ? "done" : ev.status === "continue" ? "continued" : ev.status === "needs_user" ? "needs_user" : ev.status === "unavailable" ? "unavailable" : "not_done";

        if (checked.answer && checked !== currentRun && checked.root.classList.contains("done")) paintAnsweredTitle(checked);
      }
      if (ev.status === "open" && !resumeCardShown()) addMsg("msg notice", checkNoteForUser(ev.finding, ev.remaining));

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
      memoryInline.flushUsedLine();
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
        if (currentRun) {
          currentRun.aside = ev.message;
          renderTrail(currentRun);
        } else if (!applyingHistory) {
          addMsg("msg notice", ev.message);
        }
      } else if (ev.progress) {
        if (currentRun && !applyingHistory) setRunTitle(currentRun, ev.message);
      } else if(ev.plan){
        const key=`plan:${ev.plan.conversationId}:${ev.plan.id}`;
        const text=`语音计划 · 共${ev.plan.steps.length}步\n`+ev.plan.steps.map((s,i)=>`${i+1}. ${s.targetTitle??'目标会话'} · ${s.receipt?.message??(s.status==='pending'?'结果未知':'没做')}\n${s.text}`).join('\n');
        const previous=receiptMessages.get(key);

if(previous)previous.textContent=text;else receiptMessages.set(key,addMsg('msg notice',text));
      }else if (ev.receipt) {
        materialsTray?.noteReceipt(ev.receipt);

        if (ev.receipt.action === "steer" && (ev.receipt.status === "rejected" || ev.receipt.status === "failed")) steerRibbon.reset();

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

      if (copy) errorCards.show({ ...copy, ...(ev.modelConnection ? { modelConnection: ev.modelConnection } : {}) }, !replayingHistory);
      else if (!errorCards.recoveryFailed(plainError(ev.message, "重试没有成功。"))) {
        const plain = plainError(ev.message, "");

        if (plain) addMsg("msg error", plain);
        else errorCards.show({ kind: "unknown", title: "这一步出错了", copy: "你的话还在，可以重试。", detail: ev.message }, !replayingHistory);
      }
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
  const cid = delivery.conversationId;

  if (!cid || cid !== selectedConversationId) return;
  const currentRunId = conversations.get(cid)?.runId ?? null;
  const staleForStrip = delivery.kind !== "ack" && currentRunId !== null && delivery.runId !== null && delivery.runId !== currentRunId;

  if ((delivery.kind === "finding" || delivery.kind === "reply") && !staleForStrip) {
    const previous = resultByConversation.get(cid);
    const facts = delivery.facts;
    resultByConversation.set(cid, {
      summary: answerSpeech(delivery.text).trim().slice(0, 160),
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

    return;
  }

  voiceUI.deliver?.(delivery);

  const bubble = addMsg("msg assistant markdown", "");
  steerRibbon.decorate(bubble, !replayingHistory);
  revealText(bubble, delivery.text, { render: renderMarkdown, live: !replayingHistory, final: true, onProgress: scrollToEnd,
    after: () => { if (delivery.kind === 'reply' || delivery.kind === 'finding') { attachAnswerActions(bubble, delivery); attachDeliverySources(bubble, delivery); } } });
  bubble.dataset.deliveryId = delivery.id;
  bubble.dataset.deliveryKind = delivery.kind;
  bubble.dataset.deliveryStatus = delivery.status;
  deliveredBubbles.set(delivery.id, bubble);
  placeStartAcknowledgement(bubble, delivery.kind);

  noteRunAnswer(delivery, bubble);
  scrollToEnd();
}

function send(msg: ClientMessage): boolean {
  return post({ kind: "client", msg: { ...msg, conversationId: msg.conversationId ?? selectedConversationId } });
}

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

function renderStreamTaskCard(view: TaskView): void {
  const resumeRoot = document.getElementById("resume-entry-root")!;

  if (!view.runId || !view.goal || view.state === "none") return;

  let card = Array.from(messagesEl.querySelectorAll<HTMLElement>(".ai-task-card"))
    .find(node => node.dataset.runId === view.runId);

  if (card && Number(card.dataset.observedAt) > view.observedAt) return;

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

  (planResumeHost(view.runId) ?? card.querySelector(".ai-task-footer")!).append(resumeRoot);
}

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

function adoptPlanResume(): void {
  const resumeRoot = document.getElementById("resume-entry-root");
  const taskCard = resumeRoot?.closest<HTMLElement>(".ai-task-card");

  if (!resumeRoot || !taskCard) return;
  const host = planResumeHost(taskCard.dataset.runId);

  if (host) host.append(resumeRoot);
}

function queryTaskView(): void {
  if (!conversationReady || !transportConnected) return;
  send({ type: "task_view_query", requestId: crypto.randomUUID() });
}

function handleMemoryResult(msg: Extract<ServerMessage, { type: "memory_result" }>): void {
  const outcome = memoryState.receive(msg.conversationId, msg);
  processMemoryOutcome(outcome);

  if (outcome.kind === "ignored") memoryInline.settleIgnored(msg.requestId);

  if (outcome.kind === "ignored" && outcome.reason === "unknown-request" && msg.ok) refreshMemoryIfStale(msg.rev);
}

function refreshMemoryIfStale(rev: number | undefined): void {
  memoryDrawerCtrl.refreshIfStale(rev, memoryInline.hasLearnedRules());
}

const inputContext = (): VoiceInputContext => {
  const context: VoiceInputContext = { attachments: attachments?.getAttachments() ?? [] };

  if (pendingAsk) {
    context.context = { tabId: pendingAsk.tabId, title: pendingAsk.title, url: pendingAsk.url, ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}) };
  }

  return context;
};

const voiceUI = mountVoiceUI(composerEl, () => selectedConversationId, send, inputContext);
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

void chrome.storage.local.get(INPROC_VOICE_MODEL_KEY).then((stored) => voiceUI.setVoiceModel(stored[INPROC_VOICE_MODEL_KEY]));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && INPROC_VOICE_MODEL_KEY in changes) voiceUI.setVoiceModel(changes[INPROC_VOICE_MODEL_KEY].newValue);
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && VOICE_PERSONA_STORAGE_KEY in changes) voiceUI.setPersona(parseVoicePersona(changes[VOICE_PERSONA_STORAGE_KEY].newValue));
});

const diagnosticRecord = composerEl.querySelector<HTMLElement>('.voice-record');

if (diagnosticRecord) diagnosticRecord.hidden = true;

const voiceDiagnosticsEntry = document.querySelector<HTMLElement>('#voice-diagnostics-open');

function showVoiceDiagnosticsEntry(on: boolean): void {
  if (voiceDiagnosticsEntry) voiceDiagnosticsEntry.hidden = !on;
  voiceDiagnosticsEntry?.previousElementSibling?.toggleAttribute('hidden', !on);

  if (!on && diagnosticRecord) diagnosticRecord.hidden = true;
}

showVoiceDiagnosticsEntry(false);
void chrome.storage.local.get(VOICE_DIAGNOSTICS_KEY).then(stored => showVoiceDiagnosticsEntry(isVoiceDiagnosticsOn(stored[VOICE_DIAGNOSTICS_KEY])));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && VOICE_DIAGNOSTICS_KEY in changes) showVoiceDiagnosticsEntry(isVoiceDiagnosticsOn(changes[VOICE_DIAGNOSTICS_KEY]!.newValue));
});

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

  if (msg.type === "site_note_delete_result") {
    pendingSiteNoteDeletes.get(msg.requestId)?.(msg.ok, msg.error);
    pendingSiteNoteDeletes.delete(msg.requestId);
    return;
  }
  if (msg.type === "site_note_list_result") { renderSiteNoteList(msg); return; }

  if (msg.type === "memory_result") {
    handleMemoryResult(msg);

    return;
  }

  if (msg.type === "skill_operations_result") {
    receiveSkillOperations(msg);

    return;
  }

  if (msg.type === "skill_operation_run_result") {
    receiveSkillOperationRun(msg);

    return;
  }

  if (msg.type === "task_history_result") {
    if (memoryInline.settleTaskHistory(msg.requestId, msg.ok, msg.error)) {
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
    case "model_key_save_result":
      keySaves.get(msg.requestId)?.(msg.ok);
      keySaves.delete(msg.requestId);
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

      if ((msg.sessionId ?? LEAD_SESSION_ID) === LEAD_SESSION_ID && currentRun) {
        if (msg.state === "user") closeThink(currentRun, eventTime());
        else if (msg.state === "running" && !toolChips.size) openThink(currentRun, eventTime());
      }

      if (msg.state === "running" && (msg.sessionId ?? LEAD_SESSION_ID) === LEAD_SESSION_ID && awaitingFirstStep()) ensureRun();
      break;
    case "task_view":
      resumeEntry.apply(msg.view.continuation ? null : msg.view, { checkpointUnavailable: conversations.get(selectedConversationId)?.checkpoint === "unavailable" });

      if (lastRun?.answer && lastRun.receipt && lastRun.root.classList.contains("done") && lastRun.root.isConnected) paintAnsweredTitle(lastRun);

      if (msg.view.conversationId === selectedConversationId) renderStreamTaskCard(msg.view);
      renderTaskStrip();

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
      && !envelope.msg.type.startsWith("conversation_") && envelope.msg.type !== "memory_result" && envelope.msg.type !== "task_history_result" && envelope.msg.type !== "skill_operations_result" && envelope.msg.type !== "site_note_delete_result" && envelope.msg.type !== "site_note_list_result"
      && envelope.msg.type !== "model_info") return;
    handleServerMessage(JSON.stringify(envelope.msg));

    return;
  }

  if (envelope.kind === "history") {
    if ((envelope.conversationId ?? "default") !== selectedConversationId) return;

    if (bootFreshSession) {
      for (const entry of envelope.entries) {
        const item = entry.item;

        if (item.kind === "server" && item.msg.type === "agent_event" && (item.msg.event.kind === "user_delivery" || item.msg.event.kind === "user_delivery_stream")) {
          handleAgentEvent(item.msg.event, item.msg.sessionId);
        }
      }

      return;
    }

    if (!historyPrimed && envelope.replay !== true) return;

    applyHistory(envelope.entries, envelope.replay === true);

    return;
  }

  if (envelope.kind === "synced") {
    restoreLostSend();
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
      const reason = plainError(envelope.reason, "");
      if (reason) chip.title = `${chip.title}\n${reason}`;
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
  transportConnected = envelope.state === "connected";
  renderConversations();

  if (envelope.state === "connected") {
    flushQueuedSends();
    setStatus("on", "已连接");
    voiceUI.reconnected();
    queryTaskView();
    marginalia.refresh();

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

    if (envelope.detail && envelope.detail !== lastDisconnectDetail) {
      lastDisconnectDetail = envelope.detail;
      addMsg("msg notice", envelope.detail);
    }

  }
}

let lastHistorySeq = 0;

let historyOccurredAt: number | undefined;

function eventTime(): number { return historyEventTime(applyingHistory, historyOccurredAt); }

const userBubbles = new Map<number, HTMLElement>();

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

function removeUserBubble(seq: number, bubble: HTMLElement): void {
  const chips = bubble.nextElementSibling;

  if (chips instanceof HTMLElement && chips.matches(".ctx-chips")) chips.remove();
  bubble.remove();
  userBubbles.delete(seq);
}

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
        }
        else if (steering) steerRibbon.noteSteer(entry.item.text);
        confirmSentText(entry.item.text);
        const resent = resending && resending.conversationId === selectedConversationId && resending.text === entry.item.text ? resending : null;
        resending = null;
        resendAfterConnect.delete(selectedConversationId);
        const held = messagesEl.querySelector<HTMLElement>(".msg.user.held-pending");
        const reuse = resent?.bubble?.isConnected ? resent.bubble : held && entry.item.text && (held.querySelector(".user-msg-text")?.textContent ?? held.textContent ?? "").trim() === entry.item.text.trim() ? held : null;
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
  void targetWindowId().then(windowId => {
    if (windowId != null && port === p) p.postMessage({ kind: "panel_window", windowId } satisfies PanelToBg);
  }).catch(() => {  });
}

function rememberedConversation(): string | undefined {
  try { return sessionStorage.getItem(PANEL_CONVERSATION_KEY) ?? undefined; } catch { return undefined; }
}

function reportFocus(): void {
  try { port?.postMessage({ kind: "focus" } satisfies PanelToBg); } catch {  }
}

window.addEventListener("focus", reportFocus);
document.addEventListener("pointerdown", reportFocus, true);

function watchPort(): void {
  portWatch ??= setInterval(pingPort, PORT_PING_MS);
}

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

function replaceDeadPort(): void {
  console.info("[voice] panel_port_replaced", JSON.stringify({ lastMessageAgeMs: performance.now() - lastPortMessage, pingAgeMs: pingSentAt === null ? null : performance.now() - pingSentAt }));
  const dead = port;
  port = null;
  pingSentAt = null;
  transportConnected = false;
  voiceUI.disconnect();

  try {
    dead?.disconnect();
  } catch {
  }

  connect();
}

function scheduleReconnect(): void {
  setStatus("retry", "重连中…");
  const delay = Math.min(5_000, 500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  setTimeout(connect, delay);
}

function autoResize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 140)}px`;
  syncSteerSend();
  composerEl.classList.toggle("has-text", Boolean(inputEl.value.trim()));
  materialsTray?.sync();
}

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
    } else {
      const draft = conversationDrafts.get(scope) ?? { text: "", attachments: [], ask: null };
      draft.attachments = attachments.getAttachments(scope);
      conversationDrafts.set(scope, draft);
      writeDraft(scope, draft, true);
    }
  },
  onDisplayChanged: (scope) => {
    if (!scope || scope === selectedConversationId) materialsTray?.sync();
  },
  onError: (errMsg) => {
    addMsg("msg error", errMsg);
  },
});

materialsTray = new MaterialsTray({
  root: document.getElementById("materials-tray-root")!,
  app,
  inputHasText: () => Boolean(inputEl.value.trim()),
  conversationId: () => selectedConversationId,
  onRetry: (original) => {
    const request = { ...original, requestId: crypto.randomUUID() };

    if (!send({ type: "task_action", request })) { noticeSendFailed(); return false; }
    materialsTray?.noteRequestSent(request);
    return true;
  },
  onReceiptDetails: (receipt) => {
    const card = receiptMessages.get(`${receipt.conversationId}:${receipt.requestId}`);

    if (card instanceof HTMLDetailsElement) card.open = true;
    card?.scrollIntoView({ block: "nearest", behavior: "instant" });
    card?.querySelector<HTMLElement>("summary,button")?.focus({ preventScroll: true });
  },
  page: () => activeTabInfo ? { tabId: activeTabInfo.id, title: activeTabInfo.title, url: activeTabInfo.url } : null,
  selection: () => pendingAsk,
  mentions: () => tabMentions.items(),
  attachments: () => attachments.snapshot(selectedConversationId),
  onAdd: () => attachBtn.click(),
  onMention: () => {
    const start = inputEl.selectionStart ?? inputEl.value.length;
    const end = inputEl.selectionEnd ?? start;
    const before = inputEl.value.slice(0, start);
    inputEl.setRangeText(before && !/\s$/.test(before) ? " @" : "@", start, end, "end");
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    inputEl.focus({ preventScroll: true });
  },
  onAddFiles: (files) => { void attachments.addFiles(files); },
  onRemove: removeDraftMaterials,
});
materialsTray.sync();

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

  return activeTargetTab({ lastFocused: true })
    .then((tab) => tab ?? chrome.tabs.query({ active: true }).then(([fallback]) => fallback).catch(() => undefined))
    .then((tab) => tab?.id ?? null)
    .catch(() => null);
}

const taskBar = new TaskBar({
  root: document.getElementById("task-bar-root")!,
  resolvePage: resolveTabPage,
  currentConversationId: () => selectedConversationId,
  onRetryControl: (action) => {
    if (action === "stop") stopCurrentTask();
    else requestTakeover();
  },
  onContinuationControl: (action, view) => {
    const context = activeTabContext();
    send({ type: 'task_action', request: { requestId: crypto.randomUUID(), conversationId: view.conversationId, source: 'text', action, expectedRunId: view.runId, expectedControlVersion: view.controlVersion, ...(context ? { context } : {}) } });
  },
});

window.addEventListener("pagehide", () => taskBar.dispose());

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function removeDraftMaterials(items: TrayRemoval[]): () => void {
  const beforeAsk = pendingAsk;
  const beforeMentions = tabMentions.items();
  const beforeAttachments = attachments.getAttachments(selectedConversationId);

  for (const item of items) {
    if (item.kind === "selection") clearPendingAsk();
    else if (item.kind === "mention" && item.tabId !== undefined) tabMentions.remove(item.tabId);
    else if (item.kind === "attachment" && item.attachmentId) attachments.removeItem(item.attachmentId, selectedConversationId);
  }

  autoResize();
  saveDraft();

  return () => {
    if (beforeAsk) {
      applyPendingAsk(beforeAsk);
      void chrome.storage?.session?.set({ [ASK_STORE]: { ...beforeAsk, conversationId: selectedConversationId } });
    }
    tabMentions.restore(beforeMentions, { keepStatus: true });
    attachments.restore(beforeAttachments, selectedConversationId);
    autoResize();
    saveDraft();
    materialsTray?.sync();
  };
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
  materialsTray?.sync();
}

function clearPendingAsk(): void {
  pendingAsk = null;
  askCiteEl?.classList.remove("feed-token");

  if (askCiteEl) askCiteEl.hidden = true;

  if (askCiteText) askCiteText.textContent = "";
  void chrome.storage?.session?.remove(ASK_STORE);
  saveDraft();
  materialsTray?.sync();
}

askCiteClose?.addEventListener("click", () => clearPendingAsk());

let sendFailNotifiedFor: string | null = null;

function noticeSendFailed(): void {
  if (sendFailNotifiedFor === selectedConversationId) return;
  sendFailNotifiedFor = selectedConversationId;
  addMsg("msg notice", "这条消息没有发出。侧栏和扩展后台断开了。你的文字和引用都还在。连接恢复后，再发送一次。");
}

let unconfirmedSend: { requestId: string; text: string; ask: PendingAsk | null; attachments: ReturnType<typeof attachments.getAttachments>; conversationId: string; postedOn: chrome.runtime.Port | "queued" } | null = null;

function confirmSentText(text: string): void {
  if (unconfirmedSend && unconfirmedSend.text === text) unconfirmedSend = null;
}

function restoreLostSend(): void {
  const lost = unconfirmedSend;

  if (!lost || lost.postedOn === "queued" || lost.postedOn === port || lost.conversationId !== selectedConversationId) return;
  unconfirmedSend = null;
  materialsTray?.forgetRequest(lost.conversationId, lost.requestId);

  if (resending?.conversationId === lost.conversationId && resending.text === lost.text) resending = null;

  if (!inputEl.value.trim() && !pendingAsk) {
    inputEl.value = lost.text;

    if (lost.attachments.length > 0) attachments.restore(lost.attachments, selectedConversationId);

    if (lost.ask) applyPendingAsk(lost.ask);
    autoResize();
    saveDraft();
  }

  sendFailNotifiedFor = null;
  noticeSendFailed();
}

let sendAfterRead: HTMLElement | null = null;

function sendInput(quick?: string, quickPage?: PageContext): boolean {
  if (!conversationReady) return false;
  if (!quick && dictationUI?.busy()) {
    addMsg("msg notice", "请先结束说话输入，等文字出现后再发送。按 Esc 可以取消。");
    return false;
  }

  if (conversationRequest && !quick) { sendAfterCreate = true; return false; }
  const held=panelLive(sessionRun.values(), teamView).userHasPage;

  const text = Array.from(quick ?? inputEl.value).filter((ch) => {
    const code = ch.charCodeAt(0);

    return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
  }).join("").trim();

  if (!quick && attachments.reading()) {
    const conversation = selectedConversationId;

    if (!sendAfterRead) {
      sendAfterRead = addMsg("msg notice", `文件还在读（${attachments.reading()} 个），读完就发送。`);
      void attachments.whenRead(conversation).then(() => {
        sendAfterRead?.remove();
        sendAfterRead = null;

        if (selectedConversationId === conversation) sendInput();
      });
    }

    return false;
  }

  const pendingAtts = quick ? [] : attachments.getAttachments();

  if (!text && pendingAtts.length === 0) return false;

  if (!running&&!held) runStartAt = Date.now();

  const context: PageContext | undefined = quickPage ?? (pendingAsk && !quick
    ? {
        tabId: pendingAsk.tabId,
        title: pendingAsk.title,
        url: pendingAsk.url,
        ...(pendingAsk.text ? { selection: { text: pendingAsk.text } } : {}),
      }
    : undefined);

  const mentioned = quick ? [] : tabMentions.pages();

  const clientAttachments = pendingAtts.length > 0 ? pendingAtts : undefined;
  const conversation = selectedConversationId;
  const circled = pendingAtts.flatMap(att => (att.type === "image" && att.circle ? [att.circle] : []));
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


  marginalia.showConversation();
  const citationPage = context ?? activeTabInfo;

  if (!running && !held) { currentCitationSource = citationPage ? captureCitationContext(citationPage) : null; citationRequestPending = true; }

  const queued = queuedSends.some((e) => e.kind === "client" && e.msg.type === "task_action" && e.msg.request.requestId === request.requestId);
  unconfirmedSend = { requestId: request.requestId, text, ask: quick ? null : pendingAsk, attachments: pendingAtts, conversationId: conversation, postedOn: queued ? "queued" : port ?? "queued" };

  materialsTray?.noteRequestSent({ ...request, context: context ?? (activeTabInfo ? {
    tabId: activeTabInfo.id, title: activeTabInfo.title, url: activeTabInfo.url,
  } : undefined) });

  const page = context ? Promise.resolve(context) : (async () => {
    try {
      const id = await activeTabId();

      if (id == null) return undefined;
      const info = (await resolveTabPage(id)) ?? { title: "", url: "" };

      return { tabId: id, title: info.title ?? "", url: info.url ?? "" };
    } catch { return undefined;  }
  })();

  lastSentPage = { requestId: request.requestId, page };

  sendFailNotifiedFor = null;
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

bindAnswerCards(messagesEl, (text) => sendInput(text), () => selectedConversationId);

sendBtn.onclick = () => {
  if (sendBtn.classList.contains("stopping")) {
    stopCurrentTask();
  } else {
    sendInput();
  }
};

inputEl.addEventListener("input", () => { autoResize(); saveDraft(); syncSteerSend(); });
inputEl.addEventListener("focus", () => { send({ type: "warm_up" }); });
inputEl.addEventListener("input", () => { if (inputEl.value.length === 1) send({ type: "warm_up" }); });

window.addEventListener("pagehide", saveDraft);

setUiRunSource(() => conversations.get(selectedConversationId)?.runId ?? null);

const selfUseBanner = document.createElement("div");
selfUseBanner.id = "self-use-banner";
selfUseBanner.hidden = true;
selfUseBanner.textContent = "模拟用户正在试用：这段时间不写记忆，也不记过往任务和浏览习惯";
messagesEl.before(selfUseBanner);
watchSelfUse(active => { selfUseBanner.hidden = !active; });
const panelOpenedAt = Date.now();
uiEvent("ui_panel_open");
document.addEventListener("visibilitychange", () => uiEvent(document.hidden ? "ui_panel_hidden" : "ui_panel_visible"));
window.addEventListener("pagehide", () => {
  memoryInline.asksUnanswered("panel_closed");
  uiEvent("ui_panel_close", { openMs: Date.now() - panelOpenedAt });
});

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
