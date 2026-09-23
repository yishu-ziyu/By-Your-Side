/**
 * 扩展内语音：原样复用 agent 的 VoiceService / RealtimeVoiceSession / RealtimeVoiceConnection，
 * 只换掉三样本机依赖：
 * - WebSocket：用浏览器的；StepFun 要的 Authorization 头由 background 的 declarativeNetRequest 规则补上，
 *   offscreen 文档自己不持有语音密钥。
 * - 浏览器工具：转给 background 执行，闸门与执行事实沿用现有逻辑。
 * - 密钥读取：只检查"语音已配置"，不读本机文件。
 */
import { RealtimeVoiceSession } from "../../../../agent/src/realtime-voice-session.js";
import { MODEL } from "../../../../agent/src/realtime-voice-connection.js";
import { realtimeBrowserError, type RealtimeBrowserCall } from "../../../../agent/src/realtime-browser-tools.js";
import { readVoicePage } from "../../../../agent/src/voice-page-reader.js";
import { VoiceService } from "../../../../agent/src/voice-service.js";
import type { ServerMessage, ToolExecutionFact, ToolName } from "../../../../shared/protocol.js";
import type { ToolCallParams, ToolResultData } from "../host.js";
import type { TaskProgressSnapshot, VoiceClientMessage } from "../../../../shared/voice.js";

const ENDPOINT = `wss://api.stepfun.com/v1/realtime?model=${MODEL}`;

/** 把浏览器 WebSocket 包成语音连接用到的那几个 ws 接口：on(message/error/close)、send、close、readyState。 */
class BrowserSocket {
  private readonly socket = new WebSocket(ENDPOINT);

  get readyState(): number {
    return this.socket.readyState;
  }

  on(event: "message" | "error" | "close", listener: (...args: never[]) => void): void {
    // SAFETY: 下面每个分支只按 ws 对该事件承诺的参数调用 listener。
    const call = listener as (...args: unknown[]) => void;

    if (event === "message") this.socket.addEventListener("message", (e) => call(String(e.data)));
    else if (event === "error") this.socket.addEventListener("error", () => call(new Error("语音服务连接出错")));
    else this.socket.addEventListener("close", (e) => call(e.code, e.reason));
  }

  send(data: string): void {
    this.socket.send(data);
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }
}

export interface VoiceHostDeps {
  conversationId: () => string;
  snapshot: () => TaskProgressSnapshot;
  send: (message: ServerMessage) => void;
  callBrowser: (name: ToolName, params: ToolCallParams, signal?: AbortSignal) => Promise<ToolResultData>;
  voiceConfigured: () => boolean;
  /** 语音把需要多步的请求交给文字任务。 */
  dispatchText: (text: string) => void;
}

const TAB_ACTIONS = new Map<string, ToolName>([["list", "list_tabs"], ["active", "get_active_tab"], ["open", "open_tab"], ["switch", "switch_tab"], ["close", "close_tab"]]);

export function createVoiceHost(deps: VoiceHostDeps) {
  /** 语音直连工具：tabs 是 agent 侧的组合工具，这里拆回扩展 RPC；其余同名直通。 */
  const runBrowserTool = async (call: RealtimeBrowserCall, signal: AbortSignal) => {
    // SAFETY: 语音工具清单由正式浏览器工具导出，tabs 之外的名字都是 ToolName。
    let name = call.name as ToolName;
    let params = call.args;

    if (call.name === "tabs") {
      const { action, ...rest } = call.args;
      const mapped = TAB_ACTIONS.get(String(action));

      if (!mapped) throw realtimeBrowserError(`tabs 不支持 ${String(action)}，未执行。`, "not_executed");
      name = mapped;
      params = rest;
    } else if (call.name === "page_translation" || call.name === "judge_browser_action") {
      throw realtimeBrowserError(`扩展内语音实验版还不支持 ${call.name}，未执行。`, "not_executed");
    }

    try {
      return { ok: true, executionFact: "executed", data: await deps.callBrowser(name, params, signal) };
    } catch (error) {
      const fact: ToolExecutionFact = error instanceof Error && "executionFact" in error && (error.executionFact === "not_executed" || error.executionFact === "executed") ? error.executionFact : "unknown";
      throw realtimeBrowserError(error, fact);
    }
  };

  const service = new VoiceService(
    () => deps.snapshot(),
    (message) => deps.send(message),
    async () => {
      if (!deps.voiceConfigured()) throw new Error("语音密钥未配置");

      return "injected-by-extension";
    },
    (voiceDeps) => new RealtimeVoiceSession({
      ...voiceDeps,
      // SAFETY: BrowserSocket 实现了语音连接用到的 ws 子集（on、send、close、readyState），见上方类定义。
      connect: () => new BrowserSocket() as never,
    }),
    undefined,
    undefined,
    (event, fields) => console.debug("[voice]", event, fields),
    () => [],
    undefined,
    undefined,
    () => false,
    async (_id, input) => readVoicePage({
      // SAFETY: readVoicePage 只调用 snapshot / read_element 这类 ToolName，参数是普通对象。
      call: (name, params) => deps.callBrowser(name as ToolName, params as ToolCallParams),
    }, input),
    async (request) => {
      deps.dispatchText(request.text ?? "");

      return { ok: true, status: "accepted", message: "已交给文字任务" };
    },
    async (_id, call, _input, signal) => runBrowserTool(call, signal),
  );

  return {
    handle: (message: VoiceClientMessage) => service.handle(deps.conversationId(), message),
    observe: (message: ServerMessage) => service.observe(message),
  };
}
