/**
 * background service worker 入口：
 * - 持有到伴随进程的上行连接（native messaging 优先，ws 调试回退，见 uplink.ts）
 * - tool_call 由本层直接执行并回 tool_result（不经过面板，关面板任务也不断）
 * - side panel 经 chrome.runtime Port 接入，只做渲染与用户输入转发
 * 任何异常都收敛为 {ok:false, error}，绝不允许不回。
 */
import type { ClientMessage, ServerMessage, ToolName } from "../../../shared/protocol.js";
import { LEAD_SESSION_ID, PROTOCOL_VERSION, normalizeSessionId } from "../../../shared/protocol.js";
import { PANEL_PORT_NAME, type BgToPanel, type ConnState, type PanelToBg, type TransportKind } from "../relay.js";
import { Uplink } from "./uplink.js";
import { closeTab, getActiveTab, listTabs, openTab, switchTab } from "./exec/tabs.js";
import { navigate } from "./exec/navigate.js";
import { snapshot } from "./exec/snapshot.js";
import { click, clearMarks, fill, mark, pressKey, scroll, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";
import { consumeTeachUrlChange, getMode, noteMarkDrawn, noteMarksCleared, setMode } from "./mode.js";
import { isMarkActionId, markActionUserText } from "../shared/mark-actions.js";
import { findSessionForTab } from "./state.js";

type Handler = (params: any, sessionId: string) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  list_tabs: (_p, sid) => listTabs(sid),
  get_active_tab: () => getActiveTab(),
  open_tab: (p, sid) => openTab(p, sid),
  switch_tab: (p, sid) => switchTab(p, sid),
  close_tab: (p, sid) => closeTab(p, sid),
  navigate: (p, sid) => navigate(p, sid),
  snapshot: (p, sid) => snapshot(p, sid),
  click: (p, sid) => click(p, sid),
  fill: (p, sid) => fill(p, sid),
  type_text: (p, sid) => typeText(p, sid),
  press_key: (p, sid) => pressKey(p, sid),
  scroll: (p, sid) => scroll(p, sid),
  js: (p, sid) => evaluateJs(p, sid),
  screenshot: (_p, sid) => screenshot({}, sid),
  mark: (p, sid) => mark(p, sid),
  clear_marks: (_p, sid) => clearMarks(sid),
};

// ── 面板端口管理 ───────────────────────────────────────────────────

const panels = new Set<chrome.runtime.Port>();

/** 缓存的连接上下文，用于面板重开后的状态同步。 */
let lastConn: { state: ConnState; transport?: TransportKind; detail?: string } = { state: "connecting" };
let lastHelloOk: { version: number; model?: string } | null = null;
let lastStatus: "idle" | "running" = "idle";
const statusBySession = new Map<string, "idle" | "running">();
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
      const sid = msg.sessionId ?? LEAD_SESSION_ID;
      statusBySession.set(sid, msg.state);
      lastStatus = [...statusBySession.values()].some((s) => s === "running") ? "running" : "idle";
    }
    if (msg.type === "tool_call") {
      void executeToolCall(msg.id, msg.name, msg.params, msg.sessionId);
      return; // tool_call 不转发面板
    }
    broadcast({ kind: "server", msg });
  },
  onConnState(state, transport, detail) {
    lastConn = { state, transport, detail };
    if (state !== "connected") {
      lastHelloOk = null;
      lastModelInfo = null;
      statusBySession.clear();
      lastStatus = "idle";
    }
    broadcast({ kind: "conn", state, transport, detail });
  },
});

async function executeToolCall(
  id: string,
  name: ToolName,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<void> {
  let result: Extract<ClientMessage, { type: "tool_result" }>;
  const sid = normalizeSessionId(sessionId);
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${String(name)}`);
    const data = await handler(params, sid);
    // 教学标注追踪：mark 成功 = 有待完成步骤；clear_marks = 步骤标注已清
    if (name === "mark") noteMarkDrawn();
    else if (name === "clear_marks") noteMarksCleared();
    result = { type: "tool_result", id, ok: true, data };
  } catch (e) {
    result = { type: "tool_result", id, ok: false, error: oneLine(e) };
  }
  uplink.sendClientMessage(result);
}

/**
 * user_message / steer 转发前附上发送那一刻用户正在看的标签页（"这页面"类指代的锚点）。
 * 查询失败或无活动标签时原样发送，不阻塞主流程。
 */
async function attachPageContext<T extends Extract<ClientMessage, { type: "user_message" | "steer" }>>(
  msg: T,
): Promise<T> {
  try {
    const { tab } = await getActiveTab();
    if (!tab) return msg;
    return { ...msg, context: { tabId: tab.id, title: tab.title, url: tab.url } };
  } catch {
    return msg;
  }
}

// 步骤完成自动感知：teach 模式 + 有待完成标注时，working tab 的 URL 变化
// （chrome.tabs.onUpdated 的 changeInfo.url，SPA pushState 也会触发）视为
// 用户可能已完成当前步骤 → 清标注 + 通知 agent。agent 未连接时 sendClientMessage 静默丢弃。
// 必须在 SW 顶层注册，SW 重启后依然生效。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const url = changeInfo.url;
  void (async () => {
    const sid = await findSessionForTab(tabId);
    if (!sid) return;
    const mode = await getMode();
    if (!consumeTeachUrlChange(mode)) return;
    try {
      await clearMarks(sid);
    } catch {
      /* 页面禁止注入等场景静默 */
    }
    uplink.sendClientMessage({
      type: "page_event",
      event: "url_changed",
      url,
      ...(sid !== LEAD_SESSION_ID ? { sessionId: sid } : {}),
    });
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
        // user_message / steer 先附页面上下文再上行（异步，失败时原样发送）
        if (msg.msg.type === "user_message" || msg.msg.type === "steer") {
          void attachPageContext(msg.msg).then((enriched) => uplink.sendClientMessage(enriched));
          break;
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

/** 页面标注框外按钮：点删除/取消 → 与侧栏打「确认」「取消」同一条 user_message。 */
chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  if (!raw || typeof raw !== "object") return;
  const msg = raw as { type?: unknown; action?: unknown };
  if (msg.type !== "mark_action" || !isMarkActionId(msg.action)) return;
  const action = msg.action;
  void (async () => {
    if (action === "cancel") {
      try {
        await clearMarks(LEAD_SESSION_ID);
      } catch {
        /* 没有标注可清 */
      }
    }
    const text = markActionUserText(action);
    const outgoing = await attachPageContext({ type: "user_message", text });
    uplink.sendClientMessage(outgoing);
    sendResponse({ ok: true });
  })();
  return true;
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
