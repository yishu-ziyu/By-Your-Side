/**
 * SideAgent 伴随进程入口。
 * 默认 = native messaging 模式：stdio 帧通道，由 Chrome 拉起，鉴权靠 host manifest 的
 * allowed_origins，无 token；stdout 只写协议帧，日志走 stderr + ~/.sideagent/agent.log。
 * --ws = 调试模式：WS 服务端（127.0.0.1:7758）+ token，便于在终端直接看日志排障。
 * model/proxy 优先级：CLI 参数 > ~/.sideagent/config.json > 内置默认。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { Agent, ProxyAgent, setGlobalDispatcher, type Dispatcher } from "undici";
import { WebSocket, WebSocketServer } from "ws";
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  LEAD_SESSION_ID,
  PROTOCOL_VERSION,
  isLeadSession,
  parseClientMessage,
  type ClientMessage,
  type ServerMessage,
} from "../../shared/protocol.js";
import { loadConfig, resolveConfig, saveConfigModel } from "./config.js";
import { createFleetTools, Fleet } from "./fleet.js";
import { ToolRpc } from "./rpc.js";
import { BrowserAgentSession } from "./session.js";
import { createBrowserTools } from "./tools.js";
import { createStdioTransport } from "./transport/stdio.js";

interface CliArgs {
  ws: boolean;
  port: number;
  token?: string;
  model?: string;
  proxy?: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  let ws = false;
  let port = DEFAULT_PORT;
  let token: string | undefined;
  let model: string | undefined;
  let proxy: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--ws") {
      ws = true;
      continue;
    }
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
  return { ws, port, token, model, proxy };
}

/**
 * 全局代理 dispatcher：回环地址（127.0.0.1/localhost/::1，如 CLIProxyAPI 本地池）直连，
 * 其余 origin 走代理。实测 undici ProxyAgent 经本地代理转发回环地址的流式 POST 会失败
 * （GET /models 正常），池子请求必须绕过代理。
 */
function createProxyDispatcher(proxyUrl: string): Dispatcher {
  const proxyAgent = new ProxyAgent(proxyUrl);
  const directAgent = new Agent();
  return new Agent({
    factory: (origin) => {
      const hostname = typeof origin === "string" ? new URL(origin).hostname : origin.hostname;
      return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" ? directAgent : proxyAgent;
    },
  });
}

// ── 日志 ───────────────────────────────────────────────────────────// stderr 总是可写；stdio 模式下 Chrome 会吞掉 host 的 stderr，所以同时落一份文件。

let logFile: string | null = null;

function enableFileLog(): void {
  try {
    const dir = join(homedir(), ".sideagent");
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, "agent.log");
  } catch {
    /* 忽略 */
  }
}

function log(message: string): void {
  console.error(`[sideagent] ${message}`);
  if (logFile) {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* 忽略 */
    }
  }
}

// ── 传输无关的客户端连接 ───────────────────────────────────────────

interface ClientConn {
  send(msg: ServerMessage): void;
  close(): void;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv.slice(2));
  const { model: modelPattern, proxy } = resolveConfig(cli, loadConfig());

  // pi-ai 的 LLM 请求走 globalThis.fetch（undici 全局 dispatcher），默认直连、不看系统代理。
  // 只有显式配置 proxy 时才挂 ProxyAgent（openai-codex 等需代理的 provider 场景）。
  // 不要默认读取代理环境变量：挂全局 dispatcher 会干扰部分 provider（如 kimi-coding）的传输。
  if (proxy) {
    setGlobalDispatcher(createProxyDispatcher(proxy));
  }
  if (!cli.ws) enableFileLog();

  const rpc = new ToolRpc();
  let current: ClientConn | null = null;
  const sendCurrent = (msg: ServerMessage): void => current?.send(msg);

  const fleet = new Fleet({
    rpc,
    modelPattern,
    sink: {
      emit: (event, sessionId) =>
        sendCurrent({
          type: "agent_event",
          event,
          ...(sessionId && !isLeadSession(sessionId) ? { sessionId } : {}),
        }),
      setStatus: (state, sessionId) =>
        sendCurrent({
          type: "status",
          state,
          ...(sessionId && !isLeadSession(sessionId) ? { sessionId } : {}),
        }),
    },
  });

  const session = await BrowserAgentSession.create(
    rpc,
    {
      emit: (event) => sendCurrent({ type: "agent_event", event }),
      setStatus: (state) => sendCurrent({ type: "status", state }),
    },
    {
      modelPattern,
      customTools: [...createBrowserTools(rpc), ...createFleetTools(fleet, LEAD_SESSION_ID)],
    },
  );
  fleet.attachLead(session);
  if (!session.available) {
    log("模型凭据未配置，会话暂不可用（连接面板后会收到设置指引）");
  }

  /** 认证通过后接管为当前客户端。 */
  const adoptClient = (conn: ClientConn): void => {
    if (current && current !== conn) {
      current.send({
        type: "agent_event",
        event: { kind: "notice", message: "新的面板连接已接管，本连接关闭" },
      });
      current.close();
    }
    current = conn;
    rpc.setSend((frame) => conn.send(frame));
  };

  /** hello_ok 携带当前模型与可选模型列表（面板模型选择器的数据源）。 */
  const sendHelloOk = (conn: ClientConn): void => {
    void session.availableModels().then((models) => {
      conn.send({ type: "hello_ok", version: PROTOCOL_VERSION, model: session.modelName(), models });
    });
  };

  /** 切换会话模型：热切换（见 session.setModel 注释），成功后写回配置文件并广播 model_info。 */
  const handleSetModel = async (model: string): Promise<void> => {
    try {
      await session.setModel(model);
      try {
        saveConfigModel(model);
      } catch (err) {
        log(`模型选择写回配置文件失败：${err instanceof Error ? err.message : String(err)}`);
      }
      const models = await session.availableModels();
      log(`模型已切换：${session.modelName() ?? model}`);
      sendCurrent({ type: "model_info", model: session.modelName() ?? model, models });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`切换模型失败（${model}）：${message}`);
      sendCurrent({ type: "agent_event", event: { kind: "error", message: `切换模型失败：${message}` } });
    }
  };

  /** 当前客户端断开：reject pending 工具调用并中止流式任务。返回是否确为当前客户端。 */
  const onClientGone = (conn: ClientConn): boolean => {
    if (conn !== current) return false;
    current = null;
    rpc.setSend(null);
    if (session.isStreaming()) session.abort();
    fleet.abortAll();
    return true;
  };

  const disposeAll = (): void => {
    fleet.dispose();
    session.dispose();
  };

  const handleMessage = (msg: ClientMessage): void => {
    switch (msg.type) {
      case "user_message":
        if (!session.isStreaming()) fleet.reset();
        // 每条用户消息带一句拆分提醒：MiniMax 等模型会忽略 system 里的并行段，自己把两站串行做完。
        session.sendUserMessage(
          `${msg.text}\n\n[Coordinator: if this request has independent work on two live pages, call spawn_worker for each NOW — before snapshot/navigate/click yourself.]`,
          msg.context,
        );
        break;
      case "steer":
        session.steer(msg.text, msg.context);
        break;
      case "abort":
        session.abort();
        fleet.abortAll();
        break;
      case "set_mode":
        void session.setMode(msg.mode);
        break;
      case "set_model":
        void handleSetModel(msg.model);
        break;
      case "page_event": {
        const target =
          msg.sessionId && fleet.has(msg.sessionId) ? fleet.get(msg.sessionId) : session;
        target?.notifyPageEvent(msg.url);
        break;
      }
      case "tool_result":
        rpc.handleResult(msg.id, msg.ok, msg.data, msg.error);
        break;
      default:
        break;
    }
  };

  if (cli.ws) {
    runWsMode(cli, session, { adoptClient, onClientGone, handleMessage, sendHelloOk, disposeAll, proxy });
  } else {
    runStdioMode(session, { adoptClient, onClientGone, handleMessage, sendHelloOk, disposeAll, proxy });
  }
}

interface ModeHooks {
  adoptClient(conn: ClientConn): void;
  onClientGone(conn: ClientConn): boolean;
  handleMessage(msg: ClientMessage): void;
  sendHelloOk(conn: ClientConn): void;
  disposeAll(): void;
  proxy?: string;
}

// ── native messaging（stdio）模式 ──────────────────────────────────
// 单客户端：Chrome 拉起即连接；通道关闭说明宿主已不在，进程直接退出。

function runStdioMode(
  session: BrowserAgentSession,
  hooks: ModeHooks,
): void {
  const transport = createStdioTransport();
  const conn: ClientConn = {
    send: (msg) => transport.send(JSON.stringify(msg)),
    close: () => shutdown(0),
  };

  let authed = false;
  const helloTimer = setTimeout(() => {
    if (!authed) {
      log("10 秒内未收到 hello，退出");
      shutdown(1);
    }
  }, 10_000);

  transport.onMessage((raw) => {
    const msg = parseClientMessage(raw);
    if (!msg) return;
    if (!authed) {
      clearTimeout(helloTimer);
      // stdio 通道由 allowed_origins 鉴权，只检查客户端身份，token 忽略
      if (msg.type !== "hello" || msg.client !== "sidepanel") {
        conn.send({ type: "hello_error", error: '首帧必须是 hello{client:"sidepanel"}' });
        shutdown(1);
      }
      authed = true;
      hooks.adoptClient(conn);
      hooks.sendHelloOk(conn);
      log("面板已连接（native messaging）");
      return;
    }
    hooks.handleMessage(msg);
  });

  transport.onClose(() => {
    log("stdio 通道关闭，退出");
    shutdown(0);
  });

  let shuttingDown = false;
  function shutdown(code: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(helloTimer);
    hooks.onClientGone(conn);
    hooks.disposeAll();
    log("正在退出…");
    // 等 stdout 缓冲 flush 后退出
    setTimeout(() => process.exit(code), 50).unref();
  }
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));

  log(
    `SideAgent 伴随进程已启动（native messaging 模式）  Model: ${session.modelName() ?? "未配置"}  Proxy: ${hooks.proxy ?? "无（直连）"}`,
  );
}

// ── WS 调试模式 ────────────────────────────────────────────────────

function runWsMode(
  cli: { port: number; token?: string },
  session: BrowserAgentSession,
  hooks: ModeHooks,
): void {
  const { port } = cli;
  const token = cli.token ?? randomBytes(16).toString("hex");

  const wss = new WebSocketServer({ host: DEFAULT_HOST, port });
  wss.on("error", (err) => {
    log(`WS 服务端启动失败：${err.message}`);
    process.exit(1);
  });

  const checkHello = (msg: ClientMessage, origin: string | undefined): string | null => {
    if (!origin || !origin.startsWith("chrome-extension://")) {
      return "Origin 校验失败：仅允许 chrome-extension:// 来源";
    }
    if (msg.type !== "hello" || msg.client !== "sidepanel") {
      return '首帧必须是 hello{token, client:"sidepanel"}';
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

    const conn: ClientConn = {
      send: (msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      },
      close: () => ws.close(),
    };

    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) return;
      if (!authed) {
        clearTimeout(helloTimer);
        const error = checkHello(msg, origin);
        if (error) {
          conn.send({ type: "hello_error", error });
          ws.close();
          return;
        }
        authed = true;
        hooks.adoptClient(conn);
        hooks.sendHelloOk(conn);
        log(`面板已连接（origin: ${origin}）`);
        return;
      }
      hooks.handleMessage(msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (hooks.onClientGone(conn)) {
        log("面板已断开");
      }
    });

    ws.on("error", () => ws.close());
  });

  console.log(
    [
      "SideAgent 伴随进程已启动（WS 调试模式）",
      `  WebSocket: ws://${DEFAULT_HOST}:${port}`,
      `  Token:     ${token}`,
      `  Model:     ${session.modelName() ?? "未配置"}`,
      `  Proxy:     ${hooks.proxy ?? "无（直连）"}`,
      "",
      "使用方式：",
      "  1. 在 Chrome 加载 SideAgent 扩展（chrome://extensions → 加载已解压的扩展程序 → 选择 extension/dist/）",
      "  2. 打开侧边栏面板，首次使用在设置中粘贴上面的 Token",
      "  3. 保持本进程运行；按 Ctrl+C 退出",
    ].join("\n"),
  );

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("正在退出…");
    hooks.disposeAll();
    for (const client of wss.clients) client.close();
    wss.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  log(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
