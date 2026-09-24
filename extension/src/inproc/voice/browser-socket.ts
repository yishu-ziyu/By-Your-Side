import { REALTIME_VOICE_MODEL } from "@sideagent/agent/browser-core";

const ENDPOINT = `wss://api.stepfun.com/v1/realtime?model=${REALTIME_VOICE_MODEL}`;

/** 浏览器 WebSocket 到语音会话所需 ws 子集的适配。鉴权头由 background 安装。 */
export class BrowserSocket {
  private readonly socket = new WebSocket(ENDPOINT);

  get readyState(): number { return this.socket.readyState; }

  on(event: "message" | "error" | "close", listener: (...args: never[]) => void): void {
    // SAFETY: 下面三个分支分别按 ws 的 message/error/close 回调约定传参，调用方按事件名注册对应签名。
    const call = listener as (...args: unknown[]) => void;

    if (event === "message") this.socket.addEventListener("message", e => call(String(e.data)));
    else if (event === "error") this.socket.addEventListener("error", () => call(new Error("语音服务连接出错")));
    else this.socket.addEventListener("close", e => call(e.code, e.reason));
  }

  send(data: string): void { this.socket.send(data); }
  close(code?: number, reason?: string): void { this.socket.close(code, reason); }
}
