/**
 * background service worker 入口：
 * - 持有到伴随进程的上行连接（native messaging 优先，ws 调试回退，见 uplink.ts）
 * - tool_call 由本层直接执行并回 tool_result（不经过面板，关面板任务也不断）
 * - side panel 经 chrome.runtime Port 接入，只做渲染与用户输入转发
 * 任何异常都收敛为 {ok:false, error}，绝不允许不回。
 */
import type { ClientMessage, ServerMessage, ToolName } from "../../../shared/protocol.js";
import { PROTOCOL_VERSION } from "../../../shared/protocol.js";
import { PANEL_PORT_NAME, type BgToPanel, type ConnState, type PanelToBg, type TransportKind } from "../relay.js";
import { Uplink } from "./uplink.js";
import { closeTab, listTabs, openTab, switchTab } from "./exec/tabs.js";
import { navigate } from "./exec/navigate.js";
import { snapshot } from "./exec/snapshot.js";
import { click, clearMarks, fill, mark, pressKey, scroll, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";
import { consumeTeachUrlChange, getMode, noteMarkDrawn, noteMarksCleared, setMode } from "./mode.js";
import { getWorkingTabId } from "./state.js";

type Handler = (params: any) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  list_tabs: () => listTabs(),
  open_tab: (p) => openTab(p),
  switch_tab: (p) => switchTab(p),
  close_tab: (p) => closeTab(p),
  navigate: (p) => navigate(p),
  snapshot: (p) => snapshot(p),
  click: (p) => click(p),
  fill: (p) => fill(p),
  type_text: (p) => typeText(p),
  press_key: (p) => pressKey(p),
  scroll: (p) => scroll(p),
  js: (p) => evaluateJs(p),
  screenshot: () => screenshot(),
  mark: (p) => mark(p),
  clear_marks: () => clearMarks(),
};

// ── 面板端口管理 ───────────────────────────────────────────────────

const panels = new Set<chrome.runtime.Port>();

/** 缓存的连接上下文，用于面板重开后的状态同步。 */
let lastConn: { state: ConnState; transport?: TransportKind; detail?: string } = { state: "connecting" };
let lastHelloOk: { version: number; model?: string } | null = null;
let lastStatus: "idle" | "running" = "idle";
/** 最近一次模型信息（hello_ok 或 set_model 后的 model_info），面板重开后回放。 */
let lastModelInfo: Extract<ServerMessage, { type: "model_info" }> | null = null;

function broadcast(msg: BgToPanel): void {
  for (const panel of panels) {
    try {
      panel.postMessage(msg);
    } catch {
      /* 面板刚好断开 */
    }
  }
}

/** 把当前模式同步给单个面板（接入与 sync 时调用）。 */
function postMode(port: chrome.runtime.Port): void {
  void getMode().then((mode) => {
    try {
      port.postMessage({ kind: "mode", mode } satisfies BgToPanel);
    } catch {
      /* 面板刚好断开 */
    }
  });
}

// ── 上行连接 ───────────────────────────────────────────────────────

const uplink = new Uplink({
  onServerMessage(msg) {
    if (msg.type === "hello_ok") {
      lastHelloOk = { version: msg.version, model: msg.model };
      if (msg.models) lastModelInfo = { type: "model_info", model: msg.model, models: msg.models };
      // agent 进程（重）连上：补发当前模式，避免 agent 重启丢教学模式状态
      void getMode().then((mode) => uplink.sendClientMessage({ type: "set_mode", mode }));
    } else if (msg.type === "model_info") {
      lastModelInfo = msg;
    } else if (msg.type === "status") {
      lastStatus = msg.state;
    }
    if (msg.type === "tool_call") {
      void executeToolCall(msg.id, msg.name, msg.params);
      return; // tool_call 不转发面板
    }
    broadcast({ kind: "server", msg });
  },
  onConnState(state, transport, detail) {
    lastConn = { state, transport, detail };
    if (state !== "connected") {
      lastHelloOk = null;
      lastModelInfo = null;
    }
    broadcast({ kind: "conn", state, transport, detail });
  },
});

async function executeToolCall(id: string, name: ToolName, params: Record<string, unknown>): Promise<void> {
  let result: Extract<ClientMessage, { type: "tool_result" }>;
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${String(name)}`);
    const data = await handler(params);
    // 教学标注追踪：mark 成功 = 有待完成步骤；clear_marks = 步骤标注已清
    if (name === "mark") noteMarkDrawn();
    else if (name === "clear_marks") noteMarksCleared();
    result = { type: "tool_result", id, ok: true, data };
  } catch (e) {
    result = { type: "tool_result", id, ok: false, error: oneLine(e) };
  }
  uplink.sendClientMessage(result);
}

// 步骤完成自动感知：teach 模式 + 有待完成标注时，working tab 的 URL 变化
// （chrome.tabs.onUpdated 的 changeInfo.url，SPA pushState 也会触发）视为
// 用户可能已完成当前步骤 → 清标注 + 通知 agent。agent 未连接时 sendClientMessage 静默丢弃。
// 必须在 SW 顶层注册，SW 重启后依然生效。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  void (async () => {
    const workingId = await getWorkingTabId();
    if (workingId !== tabId) return;
    const mode = await getMode();
    if (!consumeTeachUrlChange(mode)) return;
    try {
      await clearMarks();
    } catch {
      /* 页面禁止注入等场景静默 */
    }
    uplink.sendClientMessage({ type: "page_event", event: "url_changed", url });
  })();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  panels.add(port);

  // 新面板接入：同步连接状态 + 当前模式 + 缓存的会话上下文
  port.postMessage({ kind: "conn", ...lastConn } satisfies BgToPanel);
  postMode(port);
  if (lastConn.state === "connected" && lastHelloOk) {
    port.postMessage({
      kind: "server",
      msg: { type: "hello_ok", version: lastHelloOk.version ?? PROTOCOL_VERSION, model: lastHelloOk.model },
    } satisfies BgToPanel);
    if (lastModelInfo) {
      port.postMessage({ kind: "server", msg: lastModelInfo } satisfies BgToPanel);
    }
    port.postMessage({ kind: "server", msg: { type: "status", state: lastStatus } } satisfies BgToPanel);
  }

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") return;
    switch (msg.kind) {
      case "client":
        // set_mode 先落本地模式状态（供标注追踪判定），再照常转发给 agent
        if (msg.msg.type === "set_mode") {
          const mode = msg.msg.mode;
          void setMode(mode).then(() => broadcast({ kind: "mode", mode }));
        }
        uplink.sendClientMessage(msg.msg);
        break;
      case "sync": {
        port.postMessage({ kind: "conn", ...lastConn } satisfies BgToPanel);
        postMode(port);
        if (lastHelloOk) {
          port.postMessage({
            kind: "server",
            msg: { type: "hello_ok", version: lastHelloOk.version, model: lastHelloOk.model },
          } satisfies BgToPanel);
          if (lastModelInfo) {
            port.postMessage({ kind: "server", msg: lastModelInfo } satisfies BgToPanel);
          }
          port.postMessage({ kind: "server", msg: { type: "status", state: lastStatus } } satisfies BgToPanel);
        }
        break;
      }
      case "retry":
        uplink.retry();
        break;
    }
  });

  port.onDisconnect.addListener(() => {
    panels.delete(port);
  });
});

uplink.start();

// 点击工具栏图标即打开 side panel
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* 忽略 */
    });
} catch {
  /* API 不可用时忽略 */
}
