/**
 * SideAgent 桥接协议（扩展 side panel ⇆ 本地伴随进程）。
 * 传输：WebSocket，JSON 文本帧，一帧一条消息。
 * 服务端 = 伴随进程（agent 包），客户端 = side panel 页面。
 * 本文件是两侧共用的唯一权威定义；修改需两侧同步。
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7758;
export const DEFAULT_HOST = "127.0.0.1";

// ── 客户端（扩展）→ 服务端（伴随进程） ──────────────────────────────

export type ClientMessage =
  | { type: "hello"; token: string; client: "sidepanel" }
  | { type: "user_message"; text: string }
  | { type: "steer"; text: string }
  | { type: "abort" }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; error?: string };

// ── 服务端 → 客户端 ────────────────────────────────────────────────

export type ServerMessage =
  | { type: "hello_ok"; version: number; model?: string }
  | { type: "hello_error"; error: string }
  | { type: "status"; state: "idle" | "running" }
  | { type: "tool_call"; id: string; name: ToolName; params: Record<string, unknown> }
  | { type: "agent_event"; event: AgentUiEvent };

/** 渲染到聊天 UI 的 Agent 事件流（由 Pi SDK 事件映射而来）。 */
export type AgentUiEvent =
  | { kind: "text_delta"; delta: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "tool_start"; toolCallId: string; name: string; params: Record<string, unknown> }
  | { kind: "tool_end"; toolCallId: string; name: string; isError: boolean; resultText: string }
  | { kind: "turn_start" }
  | { kind: "turn_end" }
  | { kind: "agent_start" }
  | { kind: "agent_end" }
  | { kind: "notice"; message: string }
  | { kind: "error"; message: string };

// ── 工具契约 ───────────────────────────────────────────────────────

export const TOOL_NAMES = [
  "list_tabs",
  "open_tab",
  "switch_tab",
  "close_tab",
  "navigate",
  "snapshot",
  "click",
  "fill",
  "type_text",
  "press_key",
  "scroll",
  "js",
  "screenshot",
  "mark",
  "clear_marks",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  /** 是否为 Agent 当前认领的工作标签页 */
  working: boolean;
}

/**
 * 各工具的 params 与成功时 tool_result.data 形状。
 * 失败时 ok=false，error 为人类可读的一行描述。
 *
 * click/fill 的 target 支持四种形式（与 ego 对齐）：
 *   "@N"          — snapshot 输出中的 ref
 *   "loc=css:..." — snapshot 输出中的稳定定位串
 *   其他字符串     — 原始 CSS 选择器
 * click 也可用 point: [x, y] 视口坐标代替 target。
 */
export interface ToolContract {
  list_tabs: { params: Record<string, never>; data: { tabs: TabInfo[] } };
  open_tab: { params: { url?: string }; data: { tabId: number; url: string; title: string } };
  switch_tab: { params: { tabId: number }; data: { tabId: number } };
  close_tab: { params: { tabId?: number }; data: { closed: true } };
  navigate: { params: { url: string; timeout?: number }; data: { url: string; title: string } };
  snapshot: { params: { scope?: "full_page" | "viewport" }; data: { text: string } };
  click: {
    params: { target?: string; point?: [number, number]; label?: string };
    data: { clicked: true };
  };
  fill: { params: { target: string; value: string }; data: { filled: true } };
  type_text: { params: { text: string }; data: { typed: true } };
  press_key: { params: { key: string }; data: { pressed: true } };
  scroll: { params: { dy?: number; toBottom?: boolean }; data: { atBottom: boolean } };
  js: { params: { code: string }; data: { value: unknown } };
  screenshot: {
    params: Record<string, never>;
    data: { imageBase64: string; mediaType: "image/png"; width: number; height: number };
  };
  /** 在元素处画持久标注（描边框+箭头+名牌），锚定文档坐标，滚动不漂移 */
  mark: { params: { target: string; label?: string }; data: { marked: true } };
  /** 清除全部 mark 标注 */
  clear_marks: { params: Record<string, never>; data: { cleared: true } };
}

// ── 编解码守卫 ─────────────────────────────────────────────────────

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (msg && typeof msg === "object" && typeof msg.type === "string") return msg;
    return null;
  } catch {
    return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;
    if (msg && typeof msg === "object" && typeof msg.type === "string") return msg;
    return null;
  } catch {
    return null;
  }
}
