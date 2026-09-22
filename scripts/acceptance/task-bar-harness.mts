/**
 * T03 任务条验收共用装置（无头、隔离、串行；不碰用户日常 Chrome 与扩展）。
 *
 * 组成与边界（证据文档里必须照抄这一段）：
 * - host：真实 `ConversationManager` + 真实 `projectTaskView` 投影 + 真实 WS 下发；
 *   runtime 是脚本桩（不调用模型），用于按需驱动真实状态机的进度事件。
 * - panel：`extension/dist` 真实构建加载进隔离无头 Chrome，打开真实 `sidepanel.html`，
 *   经 background 生产链路（chrome.runtime Port）收消息；材料/控制按钮都是真实界面元素。
 * - controlled 模式：WS 端只回受控回执（可延迟），用于测「点击→本地反馈」；
 *   这条路径不经过 manager，证据里要写清。
 *
 * 页面上注入的探针只读 DOM 与消息到达时刻，不改产品逻辑：
 * - `__tbProbe.views[]`：task_view 到达面板监听器的时刻 / DOM 改动时刻 / 下一帧时刻；
 * - `__tbProbe.clicks[]`：点发送按钮的时刻与下一帧时的任务条文案。
 */
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer, WebSocket } from "ws";
import { ConversationManager } from "../../agent/src/conversation-manager.js";
import { PROTOCOL_VERSION, DEFAULT_PORT } from "../../shared/protocol.js";
import { launchIsolatedExtension, sleep, until, type IsolatedExtension } from "./isolated-extension.mts";
import { createCdp } from "./cdp.mjs";

export const PANEL_SELECTORS = {
  input: "#input",
  send: "#send-btn",
  takeover: "#takeover-btn",
  root: "#task-bar-root",
  bar: ".task-bar",
  status: ".tb-status",
  goal: ".tb-goal",
  waiting: ".tb-waiting",
  page: ".tb-page",
  matStatus: ".tb-mat-status",
  materials: ".tb-materials",
  control: ".tb-control",
} as const;

/** 只读探针：不参与渲染，只在真实事件/真实 DOM 改动上打时间戳。 */
const PROBE_SOURCE = `(() => {
  const probe = globalThis.__tbProbe = { views: [], clicks: [], observerReady: false, connected: 0 };
  const patch = () => {
    const runtime = globalThis.chrome && globalThis.chrome.runtime;
    if (!runtime || typeof runtime.connect !== 'function') { setTimeout(patch, 0); return; }
    const connect = runtime.connect.bind(runtime);
    runtime.connect = (...args) => {
      probe.connected += 1;
      const port = connect(...args);
      const post = port.postMessage.bind(port);
      port.postMessage = (msg) => {
        try {
          probe.outgoing = probe.outgoing || [];
          probe.outgoing.push({ at: performance.now(), kind: msg && msg.kind, type: msg && msg.msg && msg.msg.type });
        } catch (e) { probe.probeError = String(e); }
        return post(msg);
      };
      const event = port.onMessage;
      const add = event.addListener.bind(event);
      event.addListener = (fn) => add((msg) => {
        try {
          if (msg && msg.kind === 'server' && msg.msg && msg.msg.type === 'task_view' && globalThis.__tbProbe.observing) {
            const v = msg.msg.view || {};
            probe.views.push({ receivedAt: performance.now(), conversationId: v.conversationId, state: v.state, goal: v.goal, page: v.page, renderedAt: null, frameAt: null });
          }
        } catch (e) { probe.probeError = String(e); }
        return fn(msg);
      });
      return port;
    };
  };
  patch();
  const attachObserver = () => {
    const root = document.getElementById('task-bar-root');
    if (!root) { requestAnimationFrame(attachObserver); return; }
    new MutationObserver(() => {
      const now = performance.now();
      const pending = probe.views.filter((v) => v.renderedAt === null);
      if (!pending.length) return;
      for (const v of pending) v.renderedAt = now;
      requestAnimationFrame(() => {
        const frame = performance.now();
        for (const v of pending) if (v.frameAt === null) v.frameAt = frame;
      });
    }).observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    probe.observerReady = true;
  };
  attachObserver();
  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('#send-btn');
    probe.allClicks = probe.allClicks || [];
    if (probe.allClicks.length < 300) {
      const hit = document.elementFromPoint(e.clientX, e.clientY);
      probe.allClicks.push({ at: Math.round(performance.now() * 10) / 10, onSend: !!btn, target: e.target && (e.target.id || e.target.className || e.target.tagName), hit: hit && (hit.id || hit.className || hit.tagName) });
    }
    if (!btn) return;
    const root = document.getElementById('task-bar-root');
    const sample = { at: performance.now(), wall: Date.now(), renderedAt: null, frameAt: null, statusText: null, barHidden: null };
    probe.clicks.push(sample);
    let settled = false;
    const snapshot = () => {
      const status = root && root.querySelector('.tb-mat-status');
      sample.statusText = status ? status.textContent : null;
      const bar = root && root.querySelector('.task-bar');
      sample.barHidden = bar ? !!bar.hidden : null;
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      requestAnimationFrame(() => { sample.frameAt = performance.now(); snapshot(); });
    };
    if (root) {
      // 下一帧出现的是「这次点击真的改过的界面」：先等任务条的 DOM 改动，再取它之后的第一帧。
      const observer = new MutationObserver(() => { sample.renderedAt = performance.now(); observer.disconnect(); settle(); });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
      requestAnimationFrame(() => setTimeout(() => { observer.disconnect(); settle(); }, 0));
    } else {
      settle();
    }
  }, true);
})();`;

export interface StubRuntime {
  emit(message: Record<string, unknown>): void;
}

export interface HarnessOptions {
  /** true：WS 只回受控回执（受控服务响应延迟），不接真实 manager。 */
  controlled?: boolean;
  /** 受控模式下回执延迟（毫秒）。 */
  receiptDelayMs?: number;
  outDir?: string;
}

export interface TaskBarHarness {
  iso: IsolatedExtension;
  panelTarget: string;
  outDir: string;
  /** 面板页未捕获异常/错误日志（产品启动期错误会直接导致不连后台）。 */
  pageErrors: string[];
  panel(expression: string, timeoutMs?: number): Promise<any>;
  screenshot(file: string): Promise<void>;
  click(selector: string): Promise<void>;
  clickPoint(selector: string): Promise<{ x: number; y: number }>;
  key(key: string, code?: string): Promise<void>;
  setViewport(width: number, height: number): Promise<void>;
  setReducedMotion(value: "reduce" | "no-preference"): Promise<void>;
  setInput(text: string): Promise<void>;
  /** 受控模式：脚本回应过的 task_action 请求。 */
  receivedRequests: { requestId: string; action: string; text: string; context: unknown; attachments: string[]; at: number }[];
  /** 受控模式：等下一次 task_action 到达服务端。 */
  nextRequest(): Promise<TaskBarHarness["receivedRequests"][number]>;
  /** 受控模式：手工发一张真实结构校验通过的任务回执（accepted 等）。 */
  sendReceipt(requestId: string, status: "accepted" | "rejected" | "failed" | "unknown", message: string, runId?: string): void;
  /** 受控模式：脚本下发一份 task_view（结构必须过 isTaskView；用于界面态检查）。 */
  sendTaskView(view: Record<string, unknown>): void;
  /** 受控模式：下发一份真实结构的状态消息（面板运行指示用）。 */
  sendStatus(state: "idle" | "running" | "user"): void;
  /** 真实 manager 模式下驱动真实状态机事件（runtime 桩把事件交给 manager 的观察链路）。 */
  emitRuntime(message: Record<string, unknown>): void;
  /** 受控模式：收到的接管请求（requestId 由 background 生成）。 */
  takeoverRequests: string[];
  /** 受控模式：按真实结构回一张控制结果。 */
  ackTakeover(requestId: string, ok?: boolean): void;
  /** 服务端每次下发 task_view 的时刻（performance/wall）与视图身份。 */
  viewsSent: { at: number; wall: number; goal: string | null; state: string; conversationId: string }[];
  /** WS 双向消息流水（只记类型与时刻，便于定位握手/转发缺口）。 */
  transcript: { at: number; dir: "in" | "out"; type: string; detail?: string }[];
  close(): Promise<void>;
}

function stubRuntimeFactory(onEmit: (conversationId: string, message: Record<string, unknown>) => void) {
  return async (id: string, emit: (message: unknown) => void) => {
    const session = new Proxy(
      {
        modelName: () => "acceptance/stub",
        availableModels: async () => [],
        available: true,
        isHeld: () => false,
        isStreaming: () => false,
        hasFinding: () => false,
        abort: () => {},
        startTask: () => {},
      } as Record<string, unknown>,
      {
        get(target, prop) {
          if (typeof prop === "string" && prop in target) return target[prop];

          if (typeof prop === "symbol") return undefined;

          return () => undefined;
        },
      },
    );

    const runtime = {
      session,
      consent: { list: () => [], cancelAll: () => {} },
      fleet: { teamView: () => null, isGroupHeld: () => false, list: () => [], reset: () => {}, abortTeam: () => {}, reviseSharedRequirement: async () => null },
      rpc: { rejectAll: () => {} },
      handleMessage: () => {},
      dispose: () => {},
    };

    onEmit(id, (message: Record<string, unknown>) => emit(message));

    return runtime as never;
  };
}

export async function startTaskBarHarness(options: HarnessOptions = {}): Promise<TaskBarHarness> {
  const outDir = options.outDir ?? await mkdtemp(join(tmpdir(), "task-bar-"));
  await mkdir(outDir, { recursive: true });
  const controlled = options.controlled === true;
  const receiptDelayMs = options.receiptDelayMs ?? 700;
  const token = randomUUID();
  const storeDir = join(outDir, "host-store");

  const receivedRequests: TaskBarHarness["receivedRequests"] = [];
  const takeoverRequests: string[] = [];
  let consumedRequests = 0;
  const transcript: { at: number; dir: "in" | "out"; type: string; detail?: string }[] = [];
  const viewsSent: TaskBarHarness["viewsSent"] = [];
  const requestWaiters: ((value: TaskBarHarness["receivedRequests"][number]) => void)[] = [];
  const emitters = new Map<string, (message: Record<string, unknown>) => void>();
  let manager: ConversationManager | undefined;
  let socket: WebSocket | undefined;

  const conversationSummary = () => ({
    id: "default",
    title: "新会话",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    state: "idle",
    mode: "act",
    runId: null,
  });

  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });

  const managerEmit = (message: Record<string, unknown>) => {
    if (message.type === "task_view") {
      const view = message.view as Record<string, unknown>;
      viewsSent.push({ at: Date.now(), wall: Date.now(), goal: (view.goal as string | null) ?? null, state: String(view.state), conversationId: String(view.conversationId) });
    }

    transcript.push({ at: Date.now(), dir: "out", type: String(message.type) });

    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  if (!controlled) {
    manager = new ConversationManager(stubRuntimeFactory((id, emit) => emitters.set(id, emit)) as never, (message) => managerEmit(message as Record<string, unknown>));
    await manager.ensureDefault();
  }

  wss.on("connection", (client) => {
    client.on("message", async (raw) => {
      let message: Record<string, any>;

      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }

      transcript.push({ at: Date.now(), dir: "in", type: String(message.type ?? "?") });

      if (message.type === "hello") {
        if (message.token !== token) { transcript.push({ at: Date.now(), dir: "out", type: "hello_rejected" }); client.close();

 return; }

        socket = client;
        transcript.push({ at: Date.now(), dir: "out", type: "hello_ok" });
        client.send(JSON.stringify({ type: "hello_ok", version: PROTOCOL_VERSION, model: "acceptance/stub", models: [] }));
        client.send(JSON.stringify({ type: "conversation_list", conversations: manager ? manager.list() : [conversationSummary()] }));

        if (manager) manager.replayState((m) => client.send(JSON.stringify(m)));
        client.send(JSON.stringify({ type: "status", conversationId: "default", state: "idle" }));

        return;
      }

      if (message.type === "conversation_list" && !manager) {
        client.send(JSON.stringify({ type: "conversation_list", conversations: [conversationSummary()] }));

        return;
      }

      if (socket !== client) return;

      if (controlled) {
        if (message.type === "takeover" && typeof message.requestId === "string") {
          takeoverRequests.push(message.requestId);
        }

        if (message.type === "task_action" && message.request?.action) {
          const entry = {
            requestId: String(message.request.requestId),
            action: String(message.request.action),
            text: String(message.request.text ?? ""),
            context: message.request.context ?? null,
            attachments: (message.request.attachments ?? []).map((att: Record<string, unknown>) => String(att?.name ?? att?.id ?? "?")),
            at: Date.now(),
          };

          receivedRequests.push(entry);
          const waiter = requestWaiters.shift();

          if (waiter) { consumedRequests += 1; waiter(entry); }
        }

        return;
      }

      void manager?.handleMessage(message as never).catch(() => {});
    });
    client.on("close", () => { if (socket === client) socket = undefined; });
  });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  const port = (wss.address() as { port: number }).port;

  const iso = await launchIsolatedExtension();
  // background 连的是 ws://127.0.0.1:${DEFAULT_PORT}；只把这一个地址映射到本次验收端口。
  await iso.swEval(`(() => {
    const Original = globalThis.WebSocket;
    globalThis.WebSocket = class extends Original {
      constructor(url, protocols) {
        super(url === 'ws://127.0.0.1:${DEFAULT_PORT}' ? 'ws://127.0.0.1:${port}' : url, protocols);
      }
    };
  })()`);
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const extensionId = (await iso.swEval("chrome.runtime.id")) as string;

  const debugPort = (await readFile(join(iso.outDir, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]!;
  const version = (await fetch(`http://127.0.0.1:${debugPort}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
  const cdp = createCdp(version.webSocketDebuggerUrl);
  await cdp.ready();

  const created = await cdp.send("Target.createTarget", { url: "about:blank" });
  const panelTarget = created.targetId as string;
  const session = await cdp.attachSession(panelTarget);
  await cdp.send("Runtime.enable", {}, session);
  await cdp.send("Page.enable", {}, session);
  const pageErrors: string[] = [];
  cdp.onEvent("Runtime.exceptionThrown", (event: any) => pageErrors.push(String(event.params?.exceptionDetails?.exception?.description ?? event.params?.exceptionDetails?.text ?? "exception")));
  cdp.onEvent("Log.entryAdded", (event: any) => pageErrors.push(`log:${event.params?.entry?.text ?? ""}`));
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE_SOURCE }, session);

  const panel = async (expression: string, timeoutMs = 60_000): Promise<any> => {
    const r = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }, session, timeoutMs);

    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);

    return r.result?.value;
  };

  await cdp.send("Page.navigate", { url: `chrome-extension://${extensionId}/sidepanel.html` }, session);
  // 固定视口：headless 默认窗口很小（高 ~413px），会把底部的发送按钮挤出可视区；
  // 400×900 跟真实侧栏比例接近，也保证每次采样尺寸一致。
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 900, deviceScaleFactor: 1, mobile: false }, session);
  await until(async () => (await panel(`!!document.querySelector(${JSON.stringify(PANEL_SELECTORS.input)})`)) || undefined, 15_000, "面板输入框");
  await panel("window.__tbProbeProbePort=chrome.runtime.connect({name:'sideagent-panel'});window.__tbProbeProbePort.postMessage({kind:'retry'});");
  await panel("globalThis.__tbProbe.observing = false;");
  await until(() => socket?.readyState === WebSocket.OPEN || undefined, 20_000, "background 与验收服务连通");
  // 等面板自己也进入可发送状态：连上了、会话也定了（否则点击会被面板自己拦住）。
  await until(async () => (await panel("(() => { const b = document.querySelector('#conversation-new'); return document.querySelector('#status-text')?.textContent === '已连接' && !!b && b.disabled === false; })()")) || undefined, 20_000, "面板已连接且会话就绪");

  const clickPoint = async (selector: string): Promise<{ x: number; y: number }> => {
    const point = await panel(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); if (!r.width || !r.height) throw new Error('not visible ' + ${JSON.stringify(selector)}); if (r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) throw new Error('outside viewport ' + ${JSON.stringify(selector)} + ' ' + JSON.stringify({ top: r.top, bottom: r.bottom, innerHeight })); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);

    return point as { x: number; y: number };
  };

  const click = async (selector: string): Promise<void> => {
    const point = await clickPoint(selector);
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point }, session);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point }, session);
  };

  const screenshot = async (file: string): Promise<void> => {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, session);
    await writeFile(file, Buffer.from(shot.data as string, "base64"));
  };

  const key = async (k: string, code = ""): Promise<void> => {
    const common = { key: k, code: code || k, windowsVirtualKeyCode: k === "Tab" ? 9 : k === "Enter" ? 13 : undefined, text: k === "Enter" ? "\r" : undefined };
    await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", ...common }, session);
    await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...common }, session);
  };

  const setViewport = async (width: number, height: number): Promise<void> => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, session);
    await sleep(50);
  };

  const setReducedMotion = async (value: "reduce" | "no-preference"): Promise<void> => {
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value }] }, session);
  };

  const setInput = async (text: string): Promise<void> => {
    await panel(`(() => { const i = document.querySelector('#input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  };

  return {
    iso,
    panelTarget,
    outDir,
    pageErrors,
    panel,
    screenshot,
    click,
    clickPoint,
    key,
    setViewport,
    setReducedMotion,
    setInput,
    receivedRequests,
    nextRequest: () => {
      // 点击→上行可能在 nextRequest 注册之前就到达了：先看未消费的。
      const ready = receivedRequests[consumedRequests];

      if (ready) {
        consumedRequests += 1;

        return Promise.resolve(ready);
      }

      return new Promise((resolve) => requestWaiters.push(resolve));
    },
    sendReceipt: (requestId, status, message, runId) => {
      const receipt = {
        requestId,
        conversationId: "default",
        source: "text",
        action: "start",
        runId: status === "accepted" ? (runId ?? `run-${requestId}`) : null,
        text: "",
        targetTitle: "新会话",
        status,
        message,
        updatedAt: Date.now(),
      };

      const envelope = { type: "agent_event", conversationId: "default", event: { kind: "notice", receipt } };
      viewsSent.push({ at: Date.now(), wall: Date.now(), goal: null, state: `receipt:${status}`, conversationId: "default" });
      socket?.send(JSON.stringify(envelope));
    },
    sendStatus: (state: "idle" | "running" | "user") => {
      // 真实结构的下行状态：让面板自己的运行指示与任务条同步（受控服务模拟）。
      transcript.push({ at: Date.now(), dir: "out", type: `status:${state}` });
      socket?.send(JSON.stringify({ type: "status", conversationId: "default", state }));
    },
    sendTaskView: (view) => {
      viewsSent.push({ at: Date.now(), wall: Date.now(), goal: (view.goal as string | null) ?? null, state: String(view.state), conversationId: String(view.conversationId) });
      socket?.send(JSON.stringify({ type: "task_view", conversationId: String(view.conversationId), view }));
    },
    emitRuntime: (message) => {
      const emit = emitters.get("default");

      if (!emit) throw new Error("stub runtime 尚未创建（先让 manager 建 default 会话）");
      emit(message);
    },
    viewsSent,
    transcript,
    takeoverRequests,
    ackTakeover: (requestId: string, ok = true) => {
      // 受控服务按真实结构回控制结果，让面板/background 的真实控制流程收敛。
      transcript.push({ at: Date.now(), dir: "out", type: `control_result:${ok ? "ok" : "fail"}` });
      socket?.send(JSON.stringify({ type: "control_result", conversationId: "default", requestId, action: "takeover", ok, state: ok ? "user" : "running" }));
    },
    close: async () => {
      try { await iso.close(); } catch { /* 已关 */ }

      for (const client of wss.clients) client.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      manager?.dispose();
      await cdp.close().catch(() => {});
    },
  };
}

export { sleep, until };
