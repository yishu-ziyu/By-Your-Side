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
import { click, fill, pressKey, scroll, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";

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
};

// ── 面板端口管理 ───────────────────────────────────────────────────

const panels = new Set<chrome.runtime.Port>();

/** 缓存的连接上下文，用于面板重开后的状态同步。 */
let lastConn: { state: ConnState; transport?: TransportKind; detail?: string } = { state: "connecting" };
let lastHelloOk: { version: number; model?: string } | null = null;
let lastStatus: "idle" | "running" = "idle";

function broadcast(msg: BgToPanel): void {
  for (const panel of panels) {
    try {
      panel.postMessage(msg);
    } catch {
      /* 面板刚好断开 */
    }
  }
}

// ── 上行连接 ───────────────────────────────────────────────────────

const uplink = new Uplink({
  onServerMessage(msg) {
    if (msg.type === "hello_ok") {
      lastHelloOk = { version: msg.version, model: msg.model };
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
    if (state !== "connected") lastHelloOk = null;
    broadcast({ kind: "conn", state, transport, detail });
  },
});

async function executeToolCall(id: string, name: ToolName, params: Record<string, unknown>): Promise<void> {
  let result: Extract<ClientMessage, { type: "tool_result" }>;
  try {
    const handler = handlers[name];
    if (!handler) throw new Error(`未知工具: ${String(name)}`);
    const data = await handler(params);
    result = { type: "tool_result", id, ok: true, data };
  } catch (e) {
    result = { type: "tool_result", id, ok: false, error: oneLine(e) };
  }
  uplink.sendClientMessage(result);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  panels.add(port);

  // 新面板接入：同步连接状态 + 缓存的会话上下文
  port.postMessage({ kind: "conn", ...lastConn } satisfies BgToPanel);
  if (lastConn.state === "connected" && lastHelloOk) {
    port.postMessage({
      kind: "server",
      msg: { type: "hello_ok", version: lastHelloOk.version ?? PROTOCOL_VERSION, model: lastHelloOk.model },
    } satisfies BgToPanel);
    port.postMessage({ kind: "server", msg: { type: "status", state: lastStatus } } satisfies BgToPanel);
  }

  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as PanelToBg;
    if (!msg || typeof msg !== "object" || typeof msg.kind !== "string") return;
    switch (msg.kind) {
      case "client":
        uplink.sendClientMessage(msg.msg);
        break;
      case "sync": {
        port.postMessage({ kind: "conn", ...lastConn } satisfies BgToPanel);
        if (lastHelloOk) {
          port.postMessage({
            kind: "server",
            msg: { type: "hello_ok", version: lastHelloOk.version, model: lastHelloOk.model },
          } satisfies BgToPanel);
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
