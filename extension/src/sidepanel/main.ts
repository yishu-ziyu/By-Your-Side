/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 *
 * 渲染层依赖：marked（assistant 消息 Markdown 渲染）+ dompurify（消毒）+ lucide（图标）。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import { createElement as icon, ArrowUp, Square, Wrench, Brain, GraduationCap } from "lucide";
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
} from "lucide";
import { StepChain, chipState, describeTool, formatDuration, loaderSubtitle, pixelDelay } from "./steps.js";
import { groupModelsByProvider, humanizeModelError, providerLabel } from "./models.js";
import { parseServerMessage } from "../../../shared/protocol.js";
import type { AgentMode, AgentUiEvent, ClientMessage, ModelOption } from "../../../shared/protocol.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelToBg } from "../relay.js";

const TOKEN_KEY = "sideagent_token";
const TEACH_MODE_KEY = "sideagent_teach_mode";
const PLACEHOLDER_IDLE = "给 SideAgent 发消息，Enter 发送，Shift+Enter 换行";
const PLACEHOLDER_RUNNING = "插话：调整 Agent 的方向…（Enter 发送）";

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
    <img id="logo" src="icons/icon-48.png" alt="" />
    <span id="brand">SideAgent</span>
    <button id="teach-toggle" type="button" title="教学模式：Agent 只标注引导，由你手动操作" aria-pressed="false"></button>
    <span id="status-pill"><span id="status-dot" class="dot"></span><span id="status-text">未连接</span><button id="model-btn" type="button" title="切换模型" hidden><span id="model-name"></span></button></span>
  </header>
  <div id="model-popover" hidden></div>
  <div id="messages"></div>
  <div id="composer">
    <textarea id="input" rows="1" placeholder="${PLACEHOLDER_IDLE}"></textarea>
    <button id="abort-btn" type="button" title="中止" hidden></button>
    <button id="send-btn" type="button" title="发送"></button>
  </div>
  <div id="setup" hidden>
    <h2>SideAgent 设置</h2>
    <p class="hint">native host 未安装时的调试通道：先跑 <code>npm run dev:agent</code>，把终端里的 token 粘贴到下面（只需设置一次）。正常用法：<code>npm run install:host</code> 后无需本页。</p>
    <input id="token-input" type="text" placeholder="token" autocomplete="off" />
    <div id="setup-err" class="err"></div>
    <button id="setup-save" type="button">保存并连接</button>
  </div>
`;

const statusDot = document.getElementById("status-dot") as HTMLElement;
const statusText = document.getElementById("status-text")!;
const messagesEl = document.getElementById("messages")!;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-btn") as HTMLButtonElement;
const abortBtn = document.getElementById("abort-btn") as HTMLButtonElement;
const teachToggle = document.getElementById("teach-toggle") as HTMLButtonElement;
const modelBtn = document.getElementById("model-btn") as HTMLButtonElement;
const modelName = document.getElementById("model-name")!;
const modelPopover = document.getElementById("model-popover")!;
const setupEl = document.getElementById("setup")!;
const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const setupErr = document.getElementById("setup-err")!;
const setupSave = document.getElementById("setup-save") as HTMLButtonElement;

sendBtn.appendChild(icon(ArrowUp));
abortBtn.appendChild(icon(Square));
teachToggle.appendChild(icon(GraduationCap));

// ── 教学模式开关 ───────────────────────────────────────────────────
// 开关状态存 chrome.storage.local（面板重开恢复显示）；运行时权威在 background
// （chrome.storage.session），background 推来的 mode 消息会反向收敛本地存储。

let teachMode = false;

function renderTeachToggle(): void {
  teachToggle.classList.toggle("on", teachMode);
  teachToggle.setAttribute("aria-pressed", String(teachMode));
  teachToggle.title = teachMode
    ? "教学模式已开启：Agent 只标注引导，由你手动操作（点击关闭）"
    : "教学模式：Agent 只标注引导，由你手动操作（点击开启）";
}

function applyMode(mode: AgentMode, persist: boolean): void {
  teachMode = mode === "teach";
  renderTeachToggle();
  if (persist) void chrome.storage.local.set({ [TEACH_MODE_KEY]: teachMode });
}

void chrome.storage.local.get(TEACH_MODE_KEY).then((stored) => {
  applyMode(stored[TEACH_MODE_KEY] === true ? "teach" : "act", false);
});

teachToggle.onclick = () => {
  applyMode(teachMode ? "act" : "teach", true);
  send({ type: "set_mode", mode: teachMode ? "teach" : "act" });
};

// ── 模型选择器 ─────────────────────────────────────────────────────
// 数据源是 agent 下发的 hello_ok.models / model_info（agent 为权威，面板不持久化）；
// 选择后发 set_model，等 agent 回 model_info 再更新显示（切换失败会有 error 事件）。

/** 当前模型信息：model = "provider/id"，models = 可选列表（已配置凭据的 provider）。 */
let modelState: { model?: string; models: ModelOption[] } | null = null;

function closeModelPopover(): void {
  modelPopover.hidden = true;
  modelBtn.setAttribute("aria-expanded", "false");
}

function renderModelPicker(): void {
  const models = modelState?.models ?? [];
  modelBtn.hidden = models.length === 0;
  modelName.textContent = modelState?.model ?? "选择模型";
  if (models.length === 0) {
    closeModelPopover();
    return;
  }
  modelPopover.replaceChildren();
  for (const group of groupModelsByProvider(models)) {
    const header = document.createElement("div");
    header.className = "model-group";
    header.textContent = providerLabel(group.provider);
    modelPopover.appendChild(header);
    for (const m of group.models) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "model-item";
      item.dataset.model = m.id;
      const check = document.createElement("span");
      check.className = "model-check";
      if (m.id === modelState?.model) {
        item.classList.add("current");
        check.appendChild(icon(Check));
      }
      const label = document.createElement("span");
      label.className = "model-label";
      label.textContent = m.name;
      const raw = document.createElement("span");
      raw.className = "model-id";
      raw.textContent = m.modelId;
      item.append(check, label, raw);
      item.onclick = () => {
        closeModelPopover();
        if (m.id !== modelState?.model) send({ type: "set_model", model: m.id });
      };
      modelPopover.appendChild(item);
    }
  }
}

function applyModelInfo(model: string | undefined, models: ModelOption[] | undefined): void {
  modelState = { model: model ?? modelState?.model, models: models ?? modelState?.models ?? [] };
  renderModelPicker();
}

modelBtn.appendChild(icon(ChevronDown));
modelBtn.setAttribute("aria-expanded", "false");
modelBtn.onclick = () => {
  const opening = modelPopover.hidden;
  if (opening) renderModelPicker();
  modelPopover.hidden = !opening;
  modelBtn.setAttribute("aria-expanded", String(opening));
};
document.addEventListener("click", (e) => {
  if (!modelPopover.hidden && !modelPopover.contains(e.target as Node) && !modelBtn.contains(e.target as Node)) {
    closeModelPopover();
  }
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModelPopover();
});

let port: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;
let lastDisconnectDetail = "";
let running = false;
let currentAssistant: HTMLElement | null = null;
let currentAssistantText = "";
let currentThinking: HTMLElement | null = null;
let currentThinkingDetails: HTMLDetailsElement | null = null;
let currentThinkingStart = 0;
/** 用户发消息时刻：run 计时的起点（块体懒创建，先记时间戳）。 */
let runStartAt = 0;
/** 当前 run 的"执行步骤"聚合块；run 外为 null。 */
let currentRun: {
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
} | null = null;

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
  ["type_text", Keyboard],
  ["press_key", Keyboard],
  ["scroll", ArrowDownUp],
  ["snapshot", ScanSearch],
  ["screenshot", Camera],
  ["js", CodeXml],
  ["navigate", Globe],
  ["open_tab", Globe],
  ["list_tabs", List],
  ["switch_tab", List],
  ["close_tab", List],
  ["mark", Tag],
  ["clear_marks", Eraser],
]);

// ── 渲染 ───────────────────────────────────────────────────────────

function setStatus(mode: "off" | "on" | "retry", text: string): void {
  statusDot.className = `dot${mode === "on" ? " on" : mode === "retry" ? " retry" : ""}`;
  statusText.textContent = text;
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

function addMsg(cls: string, text: string): HTMLElement {
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
  const start = runStartAt || Date.now();
  const { root: loader, elapsed: loaderElapsed, sub: loaderSub } = buildPixelLoader();
  body.appendChild(loader);
  // 耗时读数 100ms 刷新；reduced-motion 只停格子动画，读数照常
  const timer = window.setInterval(() => {
    loaderElapsed.textContent = `${((Date.now() - start) / 1000).toFixed(1)}s`;
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
  };
  return currentRun;
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
  // 耗时读数 interval 立即停掉：run 完成/中断/空 run 都不留泄漏
  clearInterval(run.timer);
  run.loader.remove();
  // 空 run（纯文本回复，无思考/工具步骤）不留壳
  if (run.body.childElementCount === 0) {
    run.root.remove();
    return;
  }
  run.root.classList.add("done");
  run.iconBox.replaceChildren(icon(CircleCheck));
  run.timeEl.textContent = `耗时 ${formatDuration(Date.now() - run.start)}`;
  run.root.open = false;
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
        ? `思考过程 ${formatDuration(Date.now() - currentThinkingStart)}`
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
      currentThinkingStart = Date.now();
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

function buildChipGroup(run: NonNullable<typeof currentRun>): ChipGroup {
  const root = document.createElement("div");
  root.className = "chip-group";
  const row = document.createElement("div");
  row.className = "chip-row";
  const detail = document.createElement("div");
  detail.className = "chip-detail";
  detail.hidden = true;
  root.append(row, detail);
  run.body.appendChild(root);
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

function onToolStart(ev: { toolCallId: string; name: string; params: Record<string, unknown> }): void {
  closeBlocks();
  const action = describeTool(ev.name, ev.params);
  addChainStep(action.short);
  const run = ensureRun();
  run.lastToolShort = action.short;
  run.loaderSub.textContent = loaderSubtitle(run.lastToolShort);
  if (!run.chipGroup) run.chipGroup = buildChipGroup(run);
  const group = run.chipGroup;

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
    start: Date.now(),
    name: ev.name,
    paramsText: shortParams(ev.params),
    resultText: "",
    group,
  };
  chip.onclick = () => toggleChipDetail(entry);
  group.row.appendChild(chip);
  toolChips.set(ev.toolCallId, entry);
  // loader 保持在 body 底部
  run.body.appendChild(run.loader);
  scrollToEnd();
}

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string }): void {
  const entry = toolChips.get(ev.toolCallId);
  toolChips.delete(ev.toolCallId);
  if (!entry) return;
  entry.dot.className = `chip-dot ${chipState(true, ev.isError)}`;
  entry.dur.hidden = false;
  entry.dur.textContent = formatDuration(Date.now() - entry.start);
  if (ev.isError) entry.chip.classList.add("error");
  const text = ev.resultText ?? "";
  if (text) entry.resultText = text.length > 800 ? `${text.slice(0, 797)}...` : text;
  // 详情正展开着这个 chip 时实时补上结果
  if (entry.group.expanded === entry) renderChipDetail(entry);
  scrollToEnd();
}

function handleAgentEvent(ev: AgentUiEvent): void {
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
      finishRun();
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

function send(msg: ClientMessage): void {
  const envelope: PanelToBg = { kind: "client", msg };
  try {
    port?.postMessage(envelope);
  } catch {
    /* 端口刚好断开，下一轮重连恢复 */
  }
}

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case "hello_ok":
      // 带可选模型列表时模型名进选择器；老版本 agent 无 models 字段则维持 pill 内联显示
      setStatus("on", msg.models ? "已连接" : msg.model ? `已连接 · ${msg.model}` : "已连接");
      if (msg.models) applyModelInfo(msg.model, msg.models);
      setupEl.hidden = true;
      break;
    case "model_info":
      applyModelInfo(msg.model, msg.models);
      break;
    case "hello_error":
      showSetup(msg.error);
      break;
    case "status":
      running = msg.state === "running";
      abortBtn.hidden = !running;
      sendBtn.hidden = running;
      inputEl.placeholder = running ? PLACEHOLDER_RUNNING : PLACEHOLDER_IDLE;
      if (!running) {
        closeBlocks();
        finishRun();
      }
      break;
    case "agent_event":
      handleAgentEvent(msg.event);
      break;
    default:
      break;
  }
}

function handleBgMessage(envelope: BgToPanel): void {
  if (envelope.kind === "server") {
    handleServerMessage(JSON.stringify(envelope.msg));
    return;
  }
  if (envelope.kind === "mode") {
    // background 是运行时权威：以其为准并收敛本地存储
    applyMode(envelope.mode, true);
    return;
  }
  // 连接状态
  if (envelope.state === "connected") {
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
  } else if (envelope.state === "connecting") {
    setStatus("retry", "连接中…");
  } else {
    closeBlocks();
    finishRun();
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
}

function scheduleReconnect(): void {
  closeBlocks();
  finishRun();
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
}

function sendInput(): void {
  const text = inputEl.value.trim();
  if (!text) return;
  addMsg("msg user", text);
  scrollToEnd(true);
  // steer 归入进行中的 run，不动计时起点；新消息重开计时
  if (!running) runStartAt = Date.now();
  send(running ? { type: "steer", text } : { type: "user_message", text });
  inputEl.value = "";
  autoResize();
}

sendBtn.onclick = sendInput;
inputEl.addEventListener("input", autoResize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});
abortBtn.onclick = () => send({ type: "abort" });

connect();
