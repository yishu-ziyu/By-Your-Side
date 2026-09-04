/**
 * SideAgent 桥接协议（扩展 side panel ⇆ 本地伴随进程）。
 * 传输：WebSocket，JSON 文本帧，一帧一条消息。
 * 服务端 = 伴随进程（agent 包），客户端 = side panel 页面。
 * 本文件是两侧共用的唯一权威定义；修改需两侧同步。
 */

export const PROTOCOL_VERSION = 1;
export const DEFAULT_PORT = 7758;
export const DEFAULT_HOST = "127.0.0.1";
/** Lead / 单会话路径的 sessionId；省略该字段即视为 Lead。 */
export const LEAD_SESSION_ID = "main";

export function isLeadSession(sessionId?: string | null): boolean {
  return sessionId == null || sessionId === "" || sessionId === LEAD_SESSION_ID;
}

export function normalizeSessionId(sessionId?: string | null): string {
  return isLeadSession(sessionId) ? LEAD_SESSION_ID : sessionId!;
}

/** Agent 运行模式：act = 直接操作页面；teach = 教学倾向增强（默认引导用户手动操作，能力不裁剪）。 */
export type AgentMode = "act" | "teach";

// ── 客户端（扩展）→ 服务端（伴随进程） ──────────────────────────────

/** 用户消息附带的页面上下文：发送那一刻用户正在看的标签页（"这页面"类指代的锚点）。 */
export interface PageContext {
  tabId: number;
  title: string;
  url: string;
}

export type ClientMessage =
  | { type: "hello"; token: string; client: "sidepanel" }
  | { type: "user_message"; text: string; context?: PageContext }
  | { type: "steer"; text: string; context?: PageContext }
  | { type: "abort" }
  | { type: "set_mode"; mode: AgentMode }
  | { type: "set_model"; model: string }
  | { type: "page_event"; event: "url_changed"; url: string; sessionId?: string }
  | { type: "tool_result"; id: string; ok: boolean; data?: unknown; error?: string };

// ── 服务端 → 客户端 ────────────────────────────────────────────────

/** 可供选择的模型（已配置凭据的 provider 下），面板按 provider 分组展示。 */
export interface ModelOption {
  /** "provider/modelId" 形式，set_model 的取值 */
  id: string;
  provider: string;
  modelId: string;
  /** 展示名（SDK 目录里的 name） */
  name: string;
}

export type ServerMessage =
  | { type: "hello_ok"; version: number; model?: string; models?: ModelOption[] }
  | { type: "hello_error"; error: string }
  | { type: "model_info"; model?: string; models: ModelOption[] }
  | { type: "status"; state: "idle" | "running"; sessionId?: string }
  | { type: "tool_call"; id: string; name: ToolName; params: Record<string, unknown>; sessionId?: string }
  | { type: "agent_event"; event: AgentUiEvent; sessionId?: string };

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
  "get_active_tab",
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

/** 标注框外的就地确认按钮。id 决定点下去发给 Agent 的文本（confirm→确认，cancel→取消）。 */
export type MarkActionId = "confirm" | "cancel";
export interface MarkAction {
  id: MarkActionId;
  /** 按钮上的短文案，如「删除」「取消」 */
  label: string;
}

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
  /** 用户此刻正盯着的标签页（纯查询，不认领）；无活动标签时 tab 为 null */
  get_active_tab: { params: Record<string, never>; data: { tab: TabInfo | null } };
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
  mark: { params: { target: string; label?: string; actions?: MarkAction[] }; data: { marked: true } };
  /** 清除全部 mark 标注 */
  clear_marks: { params: Record<string, never>; data: { cleared: true } };
}

// ── 编解码守卫 ─────────────────────────────────────────────────────

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const msg = JSON.parse(raw) as ClientMessage;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;
    if (msg.type === "set_mode" && msg.mode !== "teach" && msg.mode !== "act") return null;
    if (msg.type === "set_model" && (typeof msg.model !== "string" || !msg.model)) return null;
    if (msg.type === "page_event") {
      if (msg.event !== "url_changed" || typeof msg.url !== "string") return null;
      if (!validOptionalSessionId(msg.sessionId)) return null;
    }
    if (
      (msg.type === "user_message" || msg.type === "steer") &&
      msg.context !== undefined &&
      !isPageContext(msg.context)
    ) {
      return null;
    }
    return msg;
  } catch {
    return null;
  }
}

function isPageContext(v: unknown): v is PageContext {
  if (typeof v !== "object" || v === null) return false;
  const c = v as PageContext;
  return typeof c.tabId === "number" && typeof c.title === "string" && typeof c.url === "string";
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const msg = JSON.parse(raw) as ServerMessage;
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return null;
    if ("sessionId" in msg && !validOptionalSessionId((msg as { sessionId?: unknown }).sessionId)) return null;
    return msg;
  } catch {
    return null;
  }
}

function validOptionalSessionId(value: unknown): boolean {
  if (value === undefined) return true;
  return typeof value === "string" && value.length > 0 && value.length <= 32;
}
