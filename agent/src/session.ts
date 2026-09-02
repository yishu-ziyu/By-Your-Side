/**
 * Pi SDK 会话的创建与包装：
 * - ModelRuntime → createAgentSession（禁用内置工具，仅注册 13 个浏览器工具）
 * - subscribe SDK 事件并映射为协议 AgentUiEvent 吐出
 * - sendUserMessage / steer / abort 均异步不阻塞调用方，错误转成 error 事件
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentToolResult,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import { createBrowserTools } from "./tools.js";
import type { ToolRpc } from "./rpc.js";

const RESULT_TEXT_MAX = 500;

const SETUP_GUIDANCE =
  "Agent 会话不可用：未找到可用的模型凭据。请运行 `npx @earendil-works/pi-coding-agent` 并执行 /login 完成登录，" +
  "或设置 ANTHROPIC_API_KEY / OPENAI_API_KEY 等环境变量后重启伴随进程。";

export interface SessionCallbacks {
  /** 映射后的 UI 事件（对应 WS agent_event 帧的 event 负载）。 */
  emit(event: AgentUiEvent): void;
  /** 运行状态变化（对应 WS status 帧）。 */
  setStatus(state: "idle" | "running"): void;
}

export class BrowserAgentSession {
  private constructor(
    private readonly session: AgentSession | null,
    private readonly initError: string | null,
    private readonly callbacks: SessionCallbacks,
  ) {}

  static async create(
    rpc: ToolRpc,
    callbacks: SessionCallbacks,
    options?: { modelPattern?: string },
  ): Promise<BrowserAgentSession> {
    try {
      const modelRuntime = await ModelRuntime.create();
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true } });
      const resourceLoader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: getAgentDir(),
        settingsManager,
        noExtensions: true,
        systemPromptOverride: () => SYSTEM_PROMPT,
        skillsOverride: () => ({ skills: [], diagnostics: [] }),
        appendSystemPromptOverride: () => [],
      });
      await resourceLoader.reload();
      const createOptions: CreateAgentSessionOptions = {
        modelRuntime,
        noTools: "builtin",
        customTools: createBrowserTools(rpc),
        resourceLoader,
        sessionManager: SessionManager.inMemory(process.cwd()),
        settingsManager,
      };
      if (options?.modelPattern) {
        const slash = options.modelPattern.indexOf("/");
        const resolved = resolveCliModel({
          cliProvider: slash > 0 ? options.modelPattern.slice(0, slash) : undefined,
          cliModel: slash > 0 ? options.modelPattern.slice(slash + 1) : options.modelPattern,
          modelRuntime,
        });
        if (resolved.error || !resolved.model) {
          throw new Error(resolved.error ?? `模型不可用：${options.modelPattern}`);
        }
        if (resolved.warning) console.error(`[sideagent] ${resolved.warning}`);
        createOptions.model = resolved.model;
        if (resolved.thinkingLevel) createOptions.thinkingLevel = resolved.thinkingLevel;
      }
      const { session } = await createAgentSession(createOptions);
      const wrapper = new BrowserAgentSession(session, null, callbacks);
      wrapper.subscribeEvents();
      return wrapper;
    } catch (err) {
      return new BrowserAgentSession(null, err instanceof Error ? err.message : String(err), callbacks);
    }
  }

  get available(): boolean {
    return this.session !== null && this.session.model !== undefined;
  }

  modelName(): string | undefined {
    const model = this.session?.model;
    return model ? `${model.provider}/${model.id}` : undefined;
  }

  isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  /** 空闲时发起新任务；运行中自动转为插话。异步不阻塞，错误捕获为 error 事件。 */
  sendUserMessage(text: string): void {
    const session = this.session;
    if (!session) {
      this.callbacks.emit({ kind: "error", message: this.guidanceMessage() });
      return;
    }
    if (!session.model) {
      this.callbacks.emit({ kind: "error", message: SETUP_GUIDANCE });
      return;
    }
    if (session.isStreaming) {
      this.callbacks.emit({ kind: "notice", message: "运行中，已转为插话" });
      void session.steer(text).catch((err: unknown) => this.emitError(err));
      return;
    }
    void session.prompt(text).catch((err: unknown) => this.emitError(err));
  }

  /** 运行中插话；若空闲则按普通消息处理。 */
  steer(text: string): void {
    const session = this.session;
    if (!session) {
      this.callbacks.emit({ kind: "error", message: this.guidanceMessage() });
      return;
    }
    if (session.isStreaming) {
      void session.steer(text).catch((err: unknown) => this.emitError(err));
    } else {
      this.sendUserMessage(text);
    }
  }

  abort(): void {
    if (!this.session) return;
    void this.session.abort().catch(() => {});
  }

  dispose(): void {
    this.session?.dispose();
  }

  private guidanceMessage(): string {
    return this.initError ? `${SETUP_GUIDANCE}\n（初始化错误：${this.initError}）` : SETUP_GUIDANCE;
  }

  private emitError(err: unknown): void {
    this.callbacks.emit({ kind: "error", message: err instanceof Error ? err.message : String(err) });
  }

  private subscribeEvents(): void {
    const session = this.session;
    if (!session) return;
    const { emit, setStatus } = this.callbacks;
    session.subscribe((event) => {
      switch (event.type) {
        case "message_update": {
          const ev = event.assistantMessageEvent;
          if (ev.type === "text_delta") emit({ kind: "text_delta", delta: ev.delta });
          else if (ev.type === "thinking_delta") emit({ kind: "thinking_delta", delta: ev.delta });
          break;
        }
        case "tool_execution_start":
          emit({
            kind: "tool_start",
            toolCallId: event.toolCallId,
            name: event.toolName,
            params: asParams(event.args),
          });
          break;
        case "tool_execution_end":
          emit({
            kind: "tool_end",
            toolCallId: event.toolCallId,
            name: event.toolName,
            isError: event.isError,
            resultText: firstText(event.result),
          });
          break;
        case "turn_start":
          emit({ kind: "turn_start" });
          break;
        case "turn_end":
          emit({ kind: "turn_end" });
          break;
        case "agent_start":
          setStatus("running");
          emit({ kind: "agent_start" });
          break;
        case "agent_end": {
          // willRetry=true 时自动重试紧随其后，状态保持 running
          if (!event.willRetry) setStatus("idle");
          emit({ kind: "agent_end" });
          if (!event.willRetry) {
            const errText = lastAssistantError(event.messages);
            if (errText) {
              console.error(`[sideagent] 模型请求最终失败：${errText}`);
              emit({ kind: "error", message: `模型请求最终失败：${errText}` });
            } else if (runProducedNothing(event.messages)) {
              // 模型 200 但空响应（实测见于 kimi-coding/k3 被限流时），面板不能装死
              emit({
                kind: "notice",
                message: "模型返回了空响应：可能触发了限流或该模型当前不可用，建议用 --model 换一个模型（如 kimi-coding/kimi-for-coding）后重试",
              });
            }
          }
          break;
        }
        case "compaction_start":
          emit({ kind: "notice", message: "正在压缩上下文…" });
          break;
        case "auto_retry_start":
          emit({ kind: "notice", message: `请求失败，正在重试（${event.attempt}/${event.maxAttempts}）…` });
          break;
        default:
          break;
      }
    });
  }
}

function asParams(args: unknown): Record<string, unknown> {
  return typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
}

export function lastAssistantError(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as { role?: string; errorMessage?: unknown };
    if (m && m.role === "assistant" && typeof m.errorMessage === "string" && m.errorMessage) {
      return m.errorMessage;
    }
  }
  return null;
}

/** 整轮运行没有任何可见输出（无文本、无工具调用）时视为空响应。 */
export function runProducedNothing(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (const raw of messages) {
    const m = raw as { role?: string; content?: unknown; toolCalls?: unknown };
    if (!m || m.role !== "assistant") continue;
    if (Array.isArray(m.toolCalls) && m.toolCalls.length > 0) return false;
    if (Array.isArray(m.content)) {
      for (const c of m.content as Array<{ type?: string; text?: unknown }>) {
        if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) return false;
      }
    }
  }
  return true;
}

function firstText(result: unknown): string {
  if (result && typeof result === "object" && Array.isArray((result as AgentToolResult<unknown>).content)) {
    for (const block of (result as AgentToolResult<unknown>).content) {
      if (block.type === "text") return block.text.slice(0, RESULT_TEXT_MAX);
    }
  }
  return "";
}
