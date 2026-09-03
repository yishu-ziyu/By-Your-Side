/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 经 chrome.runtime Port 接入 background（background 持有到伴随进程的连接并执行工具）；
 * 本层只负责渲染对话流与转发用户输入。token 设置 UI 仅在 ws 调试回退下出现。
 */
import { parseServerMessage } from "../../../shared/protocol.js";
import type { AgentUiEvent, ClientMessage } from "../../../shared/protocol.js";
import { PANEL_PORT_NAME, type BgToPanel, type PanelToBg } from "../relay.js";

const TOKEN_KEY = "sideagent_token";

const app = document.getElementById("app")!;
app.innerHTML = `
  <div id="status-bar"><span id="status-dot" class="dot"></span><span id="status-text">未连接</span></div>
  <div id="messages"></div>
  <div id="input-row">
    <textarea id="input" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
    <button id="send-btn" type="button">发送</button>
    <button id="abort-btn" type="button" hidden>中止</button>
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
const setupEl = document.getElementById("setup")!;
const tokenInput = document.getElementById("token-input") as HTMLInputElement;
const setupErr = document.getElementById("setup-err")!;
const setupSave = document.getElementById("setup-save") as HTMLButtonElement;

let port: chrome.runtime.Port | null = null;
let reconnectAttempt = 0;
let lastDisconnectDetail = "";
let running = false;
let currentAssistant: HTMLElement | null = null;
let currentThinking: HTMLElement | null = null;
const toolCards = new Map<string, { card: HTMLElement; state: HTMLElement; result: HTMLElement }>();

// ── 渲染 ───────────────────────────────────────────────────────────

function setStatus(mode: "off" | "on" | "retry", text: string): void {
  statusDot.className = `dot${mode === "on" ? " on" : mode === "retry" ? " retry" : ""}`;
  statusText.textContent = text;
}

function scrollToEnd(): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMsg(cls: string, text: string): HTMLElement {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  messagesEl.appendChild(div);
  scrollToEnd();
  return div;
}

function closeBlocks(): void {
  currentAssistant = null;
  currentThinking = null;
}

function appendDelta(kind: "assistant" | "thinking", delta: string): void {
  if (kind === "assistant") {
    if (!currentAssistant) currentAssistant = addMsg("msg assistant", "");
    currentAssistant.appendChild(document.createTextNode(delta));
  } else {
    if (!currentThinking) {
      const details = document.createElement("details");
      details.className = "thinking";
      const summary = document.createElement("summary");
      summary.textContent = "思考过程";
      const pre = document.createElement("pre");
      details.append(summary, pre);
      messagesEl.appendChild(details);
      currentThinking = pre;
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

function onToolStart(ev: { toolCallId: string; name: string; params: Record<string, unknown> }): void {
  closeBlocks();
  const card = document.createElement("div");
  card.className = "tool-card";
  const head = document.createElement("div");
  head.className = "head";
  const spinner = document.createElement("span");
  spinner.className = "spinner";
  const name = document.createElement("span");
  name.textContent = ev.name;
  const state = document.createElement("span");
  state.className = "state";
  state.textContent = "运行中";
  head.append(spinner, name, state);
  const params = document.createElement("div");
  params.className = "params";
  params.textContent = shortParams(ev.params);
  const result = document.createElement("div");
  result.className = "result";
  result.hidden = true;
  card.append(head, params, result);
  messagesEl.appendChild(card);
  toolCards.set(ev.toolCallId, { card, state, result });
  scrollToEnd();
}

function onToolEnd(ev: { toolCallId: string; isError: boolean; resultText: string }): void {
  const entry = toolCards.get(ev.toolCallId);
  toolCards.delete(ev.toolCallId);
  if (!entry) return;
  entry.card.querySelector(".spinner")?.remove();
  entry.state.textContent = ev.isError ? "失败" : "完成";
  if (ev.isError) entry.card.classList.add("error");
  const text = ev.resultText ?? "";
  if (text) {
    entry.result.hidden = false;
    entry.result.textContent = text.length > 800 ? `${text.slice(0, 797)}...` : text;
  }
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
    case "agent_end":
      closeBlocks();
      break;
    case "turn_start":
      break;
    case "notice":
      addMsg("msg notice", ev.message);
      break;
    case "error":
      addMsg("msg error", ev.message);
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
      setStatus("on", msg.model ? `已连接 · ${msg.model}` : "已连接");
      setupEl.hidden = true;
      break;
    case "hello_error":
      showSetup(msg.error);
      break;
    case "status":
      running = msg.state === "running";
      abortBtn.hidden = !running;
      if (!running) closeBlocks();
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
  // 连接状态
  if (envelope.state === "connected") {
    // 等 hello_ok 带模型名到达；先亮绿灯
    setStatus("on", "已连接");
  } else if (envelope.state === "connecting") {
    setStatus("retry", "连接中…");
  } else {
    closeBlocks();
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

function sendInput(): void {
  const text = inputEl.value.trim();
  if (!text) return;
  addMsg("msg user", text);
  send(running ? { type: "steer", text } : { type: "user_message", text });
  inputEl.value = "";
}

sendBtn.onclick = sendInput;
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendInput();
  }
});
abortBtn.onclick = () => send({ type: "abort" });

connect();
