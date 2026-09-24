import type { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

/**
 * 会话层（session.ts）对底层 agent 循环的全部依赖，按实际访问的成员列出。
 * 本机实现就是 pi-coding-agent 的 AgentSession；扩展里另给一个基于 pi-agent-core Agent 的实现，
 * 这样同一份会话代码能在两处运行。加成员前先确认两边都能提供。
 */
export interface AgentLoop extends Pick<
  AgentSession,
  | "abort" | "clearQueue" | "dispose" | "getActiveToolNames" | "getToolDefinition" | "isStreaming"
  | "model" | "prompt" | "sendCustomMessage" | "sessionId" | "setActiveToolsByName" | "setModel" | "steer" | "subscribe"
> {
  readonly agent: {
    readonly state: Pick<AgentSession["agent"]["state"], "tools" | "messages">;
    waitForIdle(): Promise<void>;
  };
  readonly sessionManager: Pick<SessionManager, "appendCustomEntry" | "getBranch">;
}
