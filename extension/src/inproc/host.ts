/**
 * 实验：agent 循环跑在扩展的 offscreen 文档里，替代本机伴随进程。
 *
 * 对 background 讲同一套 ClientMessage / ServerMessage 协议，所以侧栏、工具执行、控制闸门都不改；
 * 只覆盖最小路径：hello、会话列表、user_message、abort、tool_result、set_model。
 * offscreen 文档只有 chrome.runtime 可用：模型配置由 background 在连上后随 inproc_config 发来。
 */
import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import type { AgentUiEvent, ClientMessage, ConversationSummary, ModelOption, ServerMessage, ToolName } from "../../../shared/protocol.js";
import type { TaskActionRequest, TaskReceipt } from "../../../shared/task-actions.js";
import { PROTOCOL_VERSION, STORAGE_SCHEMA_VERSION } from "../../../shared/protocol.js";
import type { TaskProgressSnapshot } from "../../../shared/voice.js";
import type { createModelRuntime } from "./model-runtime.js";
import { INPROC_KEEPALIVE_MS, INPROC_PORT_NAME, type InprocModelConfig, type StoredCredentials } from "./shared.js";
import { createVoiceHost } from "./voice/voice-host.js";

/** 工具调用参数与回执数据沿用协议里的定义；具体形状由扩展执行器按工具名约定。 */
export type ToolCallParams = Extract<ServerMessage, { type: "tool_call" }>["params"];

export type ToolResultData = Extract<ClientMessage, { type: "tool_result" }>["data"];

/** background 经端口发来的消息：侧栏协议，加上两条只在扩展内 agent 用的配置消息。 */
type InprocInbound = ClientMessage | { type: "inproc_config"; config: InprocModelConfig | null; credentials: StoredCredentials } | { type: "inproc_voice"; configured: boolean };

/** 宿主能力由入口注入（见 main.ts）：模型运行时与 offscreen 端口监听。测试用同一接口换成本地脚本模型与假端口。 */
export interface InprocHostDeps {
  createRuntime: typeof createModelRuntime;
  onConnect: (listener: (port: chrome.runtime.Port) => void) => void;
}

const TOOL_TIMEOUT_MS = 90_000;

const SYSTEM_PROMPT = `You are By Your Side, an assistant that operates the user's Chrome browser through tools.
- Call snapshot first to read the current page. Elements in the snapshot carry refs like @12; pass a ref as target.
- To show the user something on the page ("圈出", "指给我看"), call mark with the element's ref. Do not click unless asked.
- After the tools succeed, reply in one or two short sentences in the user's language. Do not claim results you did not observe.`;

export function startInprocHost(deps: InprocHostDeps): void {
  /** 实验只维护一个会话：沿用侧栏发来的会话编号，回给它。 */
  let conversationId = "inproc";

  // offscreen 文档不能直接写 chrome.storage：刷新后的令牌交给 background 落盘。
  const runtime = deps.createRuntime((providerId, credential) => { port?.postMessage({ type: "inproc_credential", providerId, credential: credential ?? null }); });

  let config: InprocModelConfig | null = null;

  /** background 已为 StepFun 装好鉴权头规则；密钥本身不进 offscreen 文档。 */
  let voiceConfigured = false;

  let port: chrome.runtime.Port | null = null;

  let agent: Agent | null = null;

  let seq = 0;

  const pendingTools = new Map<string, { resolve: (data: ToolResultData) => void; reject: (error: Error & { executionFact?: string }) => void; timer: ReturnType<typeof setTimeout> }>();

  const summary: ConversationSummary = { id: conversationId, title: "扩展内 agent", createdAt: Date.now(), updatedAt: Date.now(), state: "idle", mode: "act" };

  function send(message: ServerMessage): void {
    const framed = { conversationId, ...message };
    port?.postMessage(framed);

    // 语音会话要看到任务进展（交付、状态），才能在任务结束时开口。
    if (message.type !== "voice") voice.observe(framed);
  }

  function emit(event: AgentUiEvent): void {
    send({ type: "agent_event", event });
  }

  function setState(state: ConversationSummary["state"]): void {
    summary.state = state;
    summary.updatedAt = Date.now();
    send({ type: "status", state });
    send({ type: "conversation_updated", conversation: { ...summary } });
  }

  /** 转给 background 执行，等它回 tool_result；执行与闸门全部沿用现有扩展逻辑。 */
  function callBrowser(name: ToolName, params: ToolCallParams, signal?: AbortSignal): Promise<ToolResultData> {
    const id = `inproc-${Date.now()}-${++seq}`;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingTools.delete(id); reject(new Error(`${name} 超时`)); }, TOOL_TIMEOUT_MS);
      pendingTools.set(id, { resolve, reject, timer });
      signal?.addEventListener("abort", () => { clearTimeout(timer); pendingTools.delete(id); reject(new Error("已停止")); }, { once: true });
      send({ type: "tool_call", id, name, params });
    });
  }

  function browserTool(name: ToolName, description: string, parameters: ReturnType<typeof Type.Object>, format: (data: any) => string): AgentTool {
    return {
      name, label: name, description, parameters,
      execute: async (_id, params, signal) => {
        // SAFETY: pi-agent-core 按上面的 TypeBox 参数表校验过 params，它是普通对象。
        const data = await callBrowser(name, params as ToolCallParams, signal);

        return { content: [{ type: "text", text: format(data) }], details: data };
      },
    };
  }

  const optionalTab = { tabId: Type.Optional(Type.Number({ description: "Tab id; omit for the current working tab." })) };

  const TOOLS: AgentTool[] = [
    browserTool("snapshot", "Read the current page as text with element refs (@N).", Type.Object(optionalTab), (d) => String(d?.text ?? "")),
    browserTool("mark", "Circle an element on the page so the user can see it. Does not click.", Type.Object({ ...optionalTab, target: Type.String({ description: "Element ref like @12" }), label: Type.Optional(Type.String()) }), () => "Marked."),
    browserTool("click", "Click an element.", Type.Object({ ...optionalTab, target: Type.String({ description: "Element ref like @12" }) }), () => "Clicked."),
    browserTool("navigate", "Open a URL in the working tab.", Type.Object({ ...optionalTab, url: Type.String() }), (d) => `Opened ${d?.url ?? ""} — ${d?.title ?? ""}`),
    browserTool("list_tabs", "List open tabs.", Type.Object({}), (d) => (d?.tabs ?? []).map((t: any) => `[${t.id}] ${t.title} — ${t.url}`).join("\n") || "No tabs."),
  ];

  function forward(event: AgentEvent): void {
    if (event.type === "agent_start") emit({ kind: "agent_start" });
    else if (event.type === "turn_start") emit({ kind: "turn_start" });
    else if (event.type === "turn_end") emit({ kind: "turn_end" });
    else if (event.type === "agent_end") emit({ kind: "agent_end" });
    else if (event.type === "message_update") {
      const e = event.assistantMessageEvent;

      if (e.type === "text_delta") emit({ kind: "text_delta", delta: e.delta });
      else if (e.type === "thinking_delta") emit({ kind: "thinking_delta", delta: e.delta });
    } else if (event.type === "tool_execution_start") emit({ kind: "tool_start", toolCallId: event.toolCallId, name: event.toolName, params: event.args ?? {} });
    else if (event.type === "tool_execution_end") {
      const text = (event.result?.content ?? []).map((c: { text?: string }) => c.text ?? "").join("").slice(0, 2000);
      emit({ kind: "tool_end", toolCallId: event.toolCallId, name: event.toolName, isError: event.isError, resultText: text });
    }
  }

  async function runPrompt(text: string): Promise<void> {
    if (agent?.state.isStreaming) {
      agent.steer({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });

      return;
    }

    setState("running");

    try {
      const model = runtime.resolveModel(config);

      if (!agent) {
        agent = new Agent({
          sessionId: runtime.sessionId,
          streamFn: (m, c, o) => runtime.models.streamSimple(m, c, { ...o, headers: { ...o?.headers, ...runtime.headersFor(m) } }),
          initialState: { systemPrompt: SYSTEM_PROMPT, model, tools: TOOLS },
        });
        agent.subscribe((event) => forward(event));
      } else agent.state.model = model;

      await agent.prompt(text);
      const failure = agent.state.errorMessage;

      if (failure) emit({ kind: "error", message: failure });
    } catch (error) {
      emit({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setState("idle");
    }
  }

  /** 侧栏发任务走 task_action：先回执「已接收」，再开跑；和本机伴随进程的回执同形。 */
  function receipt(request: TaskActionRequest, status: TaskReceipt["status"], message: string): void {
    const value: TaskReceipt = {
      requestId: request.requestId, conversationId, source: request.source, action: request.action, runId: summary.runId ?? null,
      text: request.text ?? "", targetTitle: request.context?.title ?? summary.title, status, message, updatedAt: Date.now(),
    };

    emit({ kind: "notice", message, receipt: value });
  }

  function onTaskAction(request: TaskActionRequest): void {
    if (request.action === "start" || request.action === "steer") {
      if (request.action === "start" && !agent?.state.isStreaming) summary.runId = `run-${Date.now()}`;
      receipt(request, "accepted", request.action === "start" ? "已开始" : "已补充到当前任务");
      void runPrompt(request.text ?? "");
    } else if (request.action === "abort") {
      agent?.abort();
      receipt(request, "applied", "已停止");
    } else receipt(request, "rejected", "扩展内 agent 实验版还不支持这个操作");
  }

  function taskSnapshot(): TaskProgressSnapshot {
    const running = summary.state === "running";

    return {
      conversationId, observedAt: Date.now(), state: running ? "running" : "idle", goal: null, startedAt: null,
      runId: summary.runId ?? null, active: [], lastAction: null, successVerified: false,
    };
  }

  const voice = createVoiceHost({
    conversationId: () => conversationId,
    snapshot: taskSnapshot,
    send,
    callBrowser,
    voiceConfigured: () => voiceConfigured,
    dispatchText: (text) => {
      if (!agent?.state.isStreaming) summary.runId = `run-${Date.now()}`;
      void runPrompt(text);
    },
  });

  function modelOptions(): ModelOption[] {
    if (!config) return [];

    return [{ id: `${config.provider}/${config.modelId}`, provider: config.provider, modelId: config.modelId, name: config.modelId }];
  }

  /** 端口只接受本扩展 background 的连接（见文件末尾的 onConnect），发送方可信。 */
  function onClientMessage(msg: InprocInbound): void {
    if ("conversationId" in msg && msg.conversationId && msg.conversationId !== conversationId) {
      conversationId = msg.conversationId;
      summary.id = conversationId;
    }

    switch (msg.type) {
      case "inproc_config":
        config = msg.config;
        void runtime.credentials.load(msg.credentials ?? {});
        break;
      case "inproc_voice":
        voiceConfigured = msg.configured;
        break;
      case "voice":
        void voice.handle(msg);
        break;
      case "hello":
        send({ type: "hello_ok", version: PROTOCOL_VERSION, model: config ? `${config.provider}/${config.modelId}` : undefined, models: modelOptions(), hostVersion: "inproc-exp", extensionVersion: "0.1.0", storageSchema: STORAGE_SCHEMA_VERSION });
        send({ type: "conversation_list", conversations: [{ ...summary }] });
        break;
      case "conversation_list":
        send({ type: "conversation_list", requestId: msg.requestId, conversations: [{ ...summary }] });
        break;
      case "user_message":
      case "steer":
        void runPrompt(msg.text);
        break;
      case "abort":
        agent?.abort();
        break;
      case "task_action":
        onTaskAction(msg.request);
        break;
      case "tool_result": {
        const pending = pendingTools.get(msg.id);

        if (!pending) break;
        clearTimeout(pending.timer);
        pendingTools.delete(msg.id);

        if (msg.ok) pending.resolve(msg.data);
        else pending.reject(Object.assign(new Error(msg.error ?? "工具执行失败"), { executionFact: msg.executionFact ?? "unknown" }));
        break;
      }

      default:
        // 实验范围外的消息（记忆、技能、语音……）静默忽略。
        break;
    }
  }

  setInterval(() => port?.postMessage({ type: "inproc_keepalive" }), INPROC_KEEPALIVE_MS);

  deps.onConnect((next) => {
    if (next.name !== INPROC_PORT_NAME) return;
    port = next;
    next.onMessage.addListener(onClientMessage);
    next.onDisconnect.addListener(() => { if (port === next) port = null; });
  });
}
