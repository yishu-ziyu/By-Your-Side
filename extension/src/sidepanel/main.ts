/**
 * side panel 入口：原生 TS + DOM，无框架。
 * 连接 ws://127.0.0.1:7758，渲染对话流，转发 tool_call 到 background 执行。
 */
import { DEFAULT_HOST, DEFAULT_PORT, parseServerMessage } from "../../../shared/protocol.js";
import type { AgentUiEvent, ClientMessage } from "../../../shared/protocol.js";

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
    <p class="hint">在伴随进程终端里找到 token，粘贴到下面（只需设置一次）。</p>
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

let ws: WebSocket | null = null;
let token = "";
let reconnectAttempt = 0;
let suppressReconnect = false;
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

// ── 工具调用转发 ───────────────────────────────────────────────────

interface ToolResponse {
  ok: boolean;
  data?: unknown;
  error?: string;
}

function handleToolCall(id: string, name: string, params: Record<string, unknown>): void {
  chrome.runtime.sendMessage({ channel: "sideagent-tool", id, name, params }, (resp?: ToolResponse) => {
    const err = chrome.runtime.lastError;
    if (err) {
      send({ type: "tool_result", id, ok: false, error: (err.message ?? "后台执行失败").split("\n")[0] });
      return;
    }
    if (resp?.ok) send({ type: "tool_result", id, ok: true, data: resp.data });
    else send({ type: "tool_result", id, ok: false, error: resp?.error ?? "工具执行失败" });
  });
}

// ── 连接管理 ───────────────────────────────────────────────────────

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleServerMessage(raw: string): void {
  const msg = parseServerMessage(raw);
  if (!msg) return;
  switch (msg.type) {
    case "hello_ok": {
      const wasReconnect = reconnectAttempt > 0;
      reconnectAttempt = 0;
      setStatus("on", msg.model ? `已连接 · ${msg.model}` : "已连接");
      if (wasReconnect) addMsg("msg notice", "连接已恢复，之前的任务可能已中止");
      break;
    }
    case "hello_error":
      suppressReconnect = true;
      try {
        ws?.close();
      } catch {
        /* 忽略 */
      }
      showSetup(msg.error);
      break;
    case "status":
      running = msg.state === "running";
      abortBtn.hidden = !running;
      if (!running) closeBlocks();
      break;
    case "tool_call":
      handleToolCall(msg.id, msg.name, msg.params);
      break;
    case "agent_event":
      handleAgentEvent(msg.event);
      break;
  }
}

function connect(): void {
  suppressReconnect = false;
  setStatus(reconnectAttempt > 0 ? "retry" : "off", reconnectAttempt > 0 ? "重连中…" : "连接中…");
  const socket = new WebSocket(`ws://${DEFAULT_HOST}:${DEFAULT_PORT}`);
  ws = socket;

  socket.onopen = () => {
    send({ type: "hello", token, client: "sidepanel" });
  };
  socket.onmessage = (e) => {
    if (typeof e.data === "string") handleServerMessage(e.data);
  };
  socket.onclose = () => {
    if (ws === socket) ws = null;
    closeBlocks();
    if (suppressReconnect) return;
    setStatus("retry", "重连中…");
    const delay = Math.min(15_000, 1000 * 2 ** reconnectAttempt);
    reconnectAttempt += 1;
    setTimeout(connect, delay);
  };
  socket.onerror = () => {
    try {
      socket.close();
    } catch {
      /* 忽略 */
    }
  };
}

// ── 设置界面与输入区 ───────────────────────────────────────────────

function showSetup(error?: string): void {
  setupEl.hidden = false;
  setupErr.textContent = error ?? "";
  tokenInput.value = token;
  setStatus("off", "未连接");
}

setupSave.onclick = () => {
  const t = tokenInput.value.trim();
  if (!t) {
    setupErr.textContent = "请输入 token";
    return;
  }
  token = t;
  void chrome.storage.local.set({ [TOKEN_KEY]: t });
  setupEl.hidden = true;
  reconnectAttempt = 0;
  connect();
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

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(TOKEN_KEY);
  const saved = stored[TOKEN_KEY];
  token = typeof saved === "string" ? saved : "";
  if (!token) {
    showSetup();
    return;
  }
  connect();
}

void init();
