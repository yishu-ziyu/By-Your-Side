/**
 * SideAgent 伴随进程入口：
 * WS 服务端（127.0.0.1:7758）⇆ 扩展 side panel；内嵌 Pi SDK 会话。
 * 日志走 stderr；端口/token/使用指引打印到 stdout。
 */
import { randomBytes } from "node:crypto";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  PROTOCOL_VERSION,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/protocol.js";
import { ToolRpc } from "./rpc.js";
import { BrowserAgentSession } from "./session.js";

function parseCliArgs(argv: string[]): { port: number; token?: string; model?: string; proxy?: string } {
  let port = DEFAULT_PORT;
  let token: string | undefined;
  let model: string | undefined;
  let proxy: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [flag, inline] = arg.split("=", 2);
    const value = inline ?? argv[++i];
    if (flag === "--port") {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new Error(`--port 无效：${value}`);
      port = n;
    } else if (flag === "--token") {
      if (!value) throw new Error("--token 不能为空");
      token = value;
    } else if (flag === "--model") {
      if (!value) throw new Error("--model 不能为空（格式：provider/id，如 kimi-coding/k3）");
      model = value;
    } else if (flag === "--proxy") {
      if (!value || !/^https?:\/\//.test(value)) {
        throw new Error("--proxy 无效：需要 http(s)://host:port 形式（如 http://127.0.0.1:7897）");
      }
      proxy = value;
    }
  }
  return { port, token, model, proxy };
}

async function main(): Promise<void> {
  const { port, token: cliToken, model: modelPattern, proxy } = parseCliArgs(process.argv.slice(2));
  const token = cliToken ?? randomBytes(16).toString("hex");

  // pi-ai 的 LLM 请求走 globalThis.fetch（undici 全局 dispatcher），默认直连、不看系统代理。
  // 只有用户显式传 --proxy 时才挂 ProxyAgent（openai-codex 等需代理的 provider 场景）。
  // 不要默认读取代理环境变量：挂全局 dispatcher 会干扰部分 provider（如 kimi-coding）的传输。
  if (proxy) {
    setGlobalDispatcher(new ProxyAgent(proxy));
  }

  const rpc = new ToolRpc();
  let current: WebSocket | null = null;

  const sendTo = (ws: WebSocket, msg: ServerMessage): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };
  const sendCurrent = (msg: ServerMessage): void => {
    if (current) sendTo(current, msg);
  };

  const session = await BrowserAgentSession.create(
    rpc,
    {
      emit: (event) => sendCurrent({ type: "agent_event", event }),
      setStatus: (state) => sendCurrent({ type: "status", state }),
    },
    { modelPattern },
  );
  if (!session.available) {
    log("模型凭据未配置，会话暂不可用（连接面板后会收到设置指引）");
  }

  const wss = new WebSocketServer({ host: DEFAULT_HOST, port });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", resolve);
    wss.once("error", reject);
  });

  const adoptClient = (ws: WebSocket): void => {
    if (current && current !== ws) {
      sendTo(current, {
        type: "agent_event",
        event: { kind: "notice", message: "新的面板连接已接管，本连接关闭" },
      });
      current.close();
    }
    current = ws;
    rpc.setSend((frame) => sendTo(ws, frame));
  };

  const checkHello = (msg: ClientMessage, origin: string | undefined): string | null => {
    if (!origin || !origin.startsWith("chrome-extension://")) {
      return "Origin 校验失败：仅允许 chrome-extension:// 来源";
    }
    if (msg.type !== "hello" || msg.client !== "sidepanel") {
      return "首帧必须是 hello{token, client:\"sidepanel\"}";
    }
    if (msg.token !== token) {
      return "token 不匹配";
    }
    return null;
  };

  wss.on("connection", (ws, req) => {
    const origin = req.headers.origin;
    let authed = false;
    const helloTimer = setTimeout(() => {
      if (!authed) ws.close();
    }, 10_000);

    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (!authed) {
        clearTimeout(helloTimer);
        const error = checkHello(msg, origin);
        if (error) {
          sendTo(ws, { type: "hello_error", error });
          ws.close();
          return;
        }
        authed = true;
        adoptClient(ws);
        sendTo(ws, { type: "hello_ok", version: PROTOCOL_VERSION, model: session.modelName() });
        log(`面板已连接（origin: ${origin}）`);
        return;
      }
      switch (msg.type) {
        case "user_message":
          session.sendUserMessage(msg.text);
          break;
        case "steer":
          session.steer(msg.text);
          break;
        case "abort":
          session.abort();
          break;
        case "tool_result":
          rpc.handleResult(msg.id, msg.ok, msg.data, msg.error);
          break;
        default:
          break;
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (ws === current) {
        current = null;
        rpc.setSend(null); // reject 所有 pending 工具调用
        if (session.isStreaming()) session.abort();
        log("面板已断开");
      }
    });

    ws.on("error", () => ws.close());
  });

  console.log(
    [
      "SideAgent 伴随进程已启动",
      `  WebSocket: ws://${DEFAULT_HOST}:${port}`,
      `  Token:     ${token}`,
      `  Model:     ${session.modelName() ?? "未配置"}`,
      `  Proxy:     ${proxy ?? "无（直连）"}`,
      "",
      "使用方式：",
      "  1. 在 Chrome 加载 SideAgent 扩展（chrome://extensions → 加载已解压的扩展程序 → 选择 extension/dist/）",
      "  2. 打开侧边栏面板，在首次设置中粘贴上面的 Token",
      "  3. 保持本进程运行；按 Ctrl+C 退出",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("正在退出…");
    session.dispose();
    for (const client of wss.clients) client.close();
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function log(message: string): void {
  console.error(`[sideagent] ${message}`);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
