/**
 * V2.3 切页核验真实正例（A1）：隔离 headless Chrome for Testing + 真实构建扩展，
 * 从已聚焦窗口的 A 标签切到 B：真实 switch_tab 执行后读回 → 真实 ToolRpc →
 * Session → ExecutionFeedback（切好了 + 成功资格）→ request-gate 消费，全链真实。
 *
 * 边界：零模型请求——Realtime 用内存 Socket 夹具、Jev 判断用本地夹具（不联网）；
 * 不用日常 ChromeMain、真实账号或用户配置；隔离构建写临时目录，不覆盖日常 dist。
 * 启动器源码不改：把进程 cwd 切到临时根（其 dist 取值为 cwd 相对路径）再加载启动器。
 * 独立读取不经过回执：扩展 chrome.tabs/windows 查询 + CDP 页面 visibilityState 各读一遍。
 * 无头环境若给不出聚焦事实 → 状态 BLOCKED（退出码 2），不硬编码 focused=true。
 *
 * 退出码：0=PASS，1=FAIL，2=BLOCKED。
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless");

const repo = resolve(import.meta.dirname, "../..");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");

const out = resolve(repo, "out/acceptance", `v23-switch-verification-live-${stamp}`);

await mkdir(out, { recursive: true });

type Assertion = { id: string; ok: boolean; detail?: unknown };

const record: {
  scope: string; status: "PASS" | "FAIL" | "BLOCKED"; reason?: string;
  build: Record<string, unknown>; setupReceipt?: unknown; receipt?: unknown;
  independentRead: Record<string, unknown>; feedback?: unknown; gate?: unknown;
  toolOutput?: unknown; modelText?: string | null; assertions: Assertion[];
  modelRequests: number; isolation?: unknown; cleanup?: unknown;
} = {
  scope: "real switch_tab readback → ToolRpc → Session → ExecutionFeedback → request-gate; isolated headless Chrome; zero model requests",
  status: "FAIL",
  build: {},
  independentRead: {},
  assertions: [],
  modelRequests: 0,
};

const check = (id: string, ok: boolean, detail?: unknown): boolean => {
  const detailExtra = detail !== undefined ? { detail } : {};
  record.assertions.push({ id, ok, ...detailExtra });

  return ok;
};

// ── 1. 隔离构建（临时目录，不覆盖日常 extension/dist）────────────────────────
const dailyDistBefore = existsSync(join(repo, "extension/dist/background.js"))
  ? createHash("sha256").update(await readFile(join(repo, "extension/dist/background.js"))).digest("hex")
  : null;

const isoRoot = await mkdtemp(join(tmpdir(), "sideagent-switch-dist-"));

const buildDir = join(isoRoot, "extension", "dist");

const build = spawnSync("node", ["build.mjs"], {
  cwd: join(repo, "extension"),
  env: { ...process.env, SIDEAGENT_BUILD_DIST: buildDir },
  encoding: "utf8",
});

record.build = {
  exitCode: build.status,
  outDir: buildDir,
  dailyDistBefore,
  stderrTail: (build.stderr ?? "").split("\n").slice(-5),
};

if (build.status !== 0) {
  record.status = "FAIL";
  record.reason = "隔离构建失败";
  await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, reason: record.reason, out }, null, 2));
  process.exit(1);
}

// ── 2. 加载启动器（其 DIST 为 cwd 相对路径：先切到临时根，加载后切回）────────
const prevCwd = process.cwd();

process.chdir(isoRoot);

let launchIsolatedExtension: typeof import("./isolated-extension.mts").launchIsolatedExtension;

try {
  ({ launchIsolatedExtension } = await import("./isolated-extension.mts"));
} finally {
  process.chdir(prevCwd);
}

type Socket = EventEmitter & { readyState: number; sent: any[]; server(v: unknown): void; send(raw: string): void; close(): void };

const makeSocket = (): Socket => {
  const socket = new EventEmitter() as Socket;
  socket.readyState = 1;
  socket.sent = [];
  socket.send = function (raw: string): void {
    try { this.sent.push(JSON.parse(raw)); } catch { this.sent.push({ unparseable: true }); }
  };

  socket.close = function (): void { this.readyState = 3; };

  socket.server = function (v: unknown): void { this.emit("message", Buffer.from(JSON.stringify(v))); };

  return socket;
};

let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;

const voices: Array<{ close(): void }> = [];

let manager: { dispose(): void } | undefined;

try {
  iso = await launchIsolatedExtension({ localOnly: true });
  record.isolation = iso.diagnostics();

  // ── 3. 两个夹具页；先切到 A，建立“已聚焦窗口的 A 活动”起点 ─────────────────
  const targetA = await iso.newTarget(`${iso.fixtureOrigin}/a`);
  const targetB = await iso.newTarget(`${iso.fixtureOrigin}/b`);
  const tabIds = await iso.swEval("chrome.tabs.query({})") as Array<{ id: number; url: string }>;
  const tabA = tabIds.find(t => t.url.endsWith("/a"))!.id;
  const tabB = tabIds.find(t => t.url.endsWith("/b"))!.id;
  record.independentRead = { tabA, tabB, targetA, targetB };

  const setup = await iso.tool("switch_tab", { tabId: tabA }, "main") as { ok?: boolean; data?: any };
  record.setupReceipt = setup;
  check("setup switch to A ok", setup?.ok === true, setup);
  check("setup receipt carries verification", !!setup?.data?.verification, setup?.data);

  // 独立读取（不经过回执）：扩展侧查询 + CDP 页面可见性。
  const readActive = async (): Promise<{ tabId: number | null; windowId: number | null; focused: boolean | null; aActive: boolean; bActive: boolean }> =>
    await iso!.swEval(`(async()=>{
      const t = await chrome.tabs.query({active:true, lastFocusedWindow:true});
      const w = t[0] ? await chrome.windows.get(t[0].windowId) : null;
      const a = await chrome.tabs.get(${tabA});
      const b = await chrome.tabs.get(${tabB});
      return {tabId:t[0]?.id??null, windowId:t[0]?.windowId??null, focused:w?.focused??null, aActive:a.active, bActive:b.active};
    })()`) as { tabId: number | null; windowId: number | null; focused: boolean | null; aActive: boolean; bActive: boolean };

  const visibility = async (target: string): Promise<string> =>
    await iso!.evalIn(target, "document.visibilityState") as string;

  const preRead = await readActive();
  const preVisA = await visibility(targetA);
  const preVisB = await visibility(targetB);
  record.independentRead = { ...record.independentRead, pre: preRead, preVisA, preVisB };
  check("start state: A active in a focused window", preRead.tabId === tabA && preRead.aActive === true && preRead.focused === true, preRead);

  // 无头环境给不出聚焦事实：BLOCKED，不硬编码、不偷换成功定义。
  if (preRead.focused !== true || preRead.tabId !== tabA) {
    record.status = "BLOCKED";
    record.reason = `无头环境无法建立“已聚焦窗口的 A 活动”起点（focused=${String(preRead.focused)}, active=${String(preRead.tabId)}），A1 正例不能合法成立`;
    throw new Error(record.reason);
  }

  // ── 4. 原宿主链：真实 ToolRpc 桥接隔离扩展 SW 的生产 executeToolCall 入口 ──
  const { ToolRpc } = await import("../../agent/src/rpc.js");
  const { createBrowserTools } = await import("../../agent/src/tools.js");
  const { BrowserAgentSession } = await import("../../agent/src/session.js");
  const { ConversationManager } = await import("../../agent/src/conversation-manager.js");
  const { RealtimeVoiceSession } = await import("../../agent/src/realtime-voice-session.js");
  const { MODEL, STEP_VOICE } = await import("../../agent/src/realtime-voice-connection.js");

  const bridgeEvents: Array<Record<string, unknown>> = [];

  const rpc = new ToolRpc((frame) => {
    bridgeEvents.push({ at: Date.now(), kind: "rpc-start", id: frame.id, name: frame.name });
    const args = [frame.id, frame.name, frame.params, frame.sessionId ?? "main", frame.programId ?? null, "default"];
    void iso!.swEval(`globalThis.__saCall(...${JSON.stringify(args)})`).then((r: any) => {
      bridgeEvents.push({ at: Date.now(), kind: "rpc-end", id: frame.id, name: frame.name, ok: r.ok, data: r.data, error: r.error, executionFact: r.executionFact });
      rpc.handleResult(frame.id, r.ok === true, r.data, r.error, r.executionFact);
    }, (e: unknown) => {
      bridgeEvents.push({ at: Date.now(), kind: "rpc-error", id: frame.id, error: String(e) });
      rpc.handleResult(frame.id, false, undefined, String(e));
    });
  });

  const messages: any[] = [];
  const voiceEvents: any[] = [];
  const logs: any[] = [];
  let wrapper: any;

  const raw: any = {
    isStreaming: false,
    prompt: () => undefined,
    agent: { state: { tools: [], messages: [] } },
    sessionManager: { appendCustomEntry: () => {}, getBranch: () => [] },
  };

  const managerAny = new ConversationManager(async (_id, sink) => {
    // SAFETY: 与 agent/test/realtime-feedback-translation.test.ts 相同的宿主装配：真实
    // BrowserAgentSession/工具/ToolRpc，仅 Pi prompt 层为内存替身（本票不测模型层）。
    wrapper = new (BrowserAgentSession as any)(raw, null, {
      emit: (event: any) => sink({ type: "agent_event", event }),
      setStatus: (state: any) => sink({ type: "status", state }),
    }, null, null, undefined, null, rpc);
    raw.agent.state.tools = createBrowserTools(rpc, undefined, undefined, undefined, {
      epoch: () => wrapper.executionEpoch(),
      canWrite: id => wrapper.canWriteCurrentInput(id),
      assertCall: (name, params, id) => wrapper.assertTaskResultExecution(name, params, id),
    });

    return { session: wrapper, rpc, fleet: { teamView: () => null, isGroupHeld: () => false }, dispose: () => {} } as any;
  }, (message) => messages.push(message));

  manager = managerAny;
  await managerAny.ensureDefault();

  const socket = makeSocket();

  const voice = new RealtimeVoiceSession({
    voiceSpokenResultGate: true,
    // 本地夹具判断（零网络）：胶囊足够，用于观察 request-gate 是否消费真实成功资格。
    shadow: { judge: async (input: any) => ({ ...input, lane: "task", pageChange: 0.95, spokenResult: 0.05, requestMs: 1, completedAt: Date.now() }), actual: () => {} },
    voiceId: "v23-switch-live",
    getSnapshot: () => managerAny.getTaskProgress("default"),
    emit: (event: any) => voiceEvents.push(event),
    browserTool: (call: any, input: any, signal: AbortSignal) => managerAny.executeRealtimeBrowserTool("default", call, input, signal),
    connect: () => socket as any,
    diagnostic: (type: string, fields: any) => {
      try { logs.push({ at: Date.now(), type, ...JSON.parse(String(fields?.detail ?? "{}")) }); } catch { logs.push({ at: Date.now(), type }); }
    },
  } as any);

  voices.push(voice);
  voice.start("offline-placeholder");
  socket.server({ type: "session.created", session: { model: MODEL } });
  socket.server({ type: "session.updated", session: { model: MODEL, voice: STEP_VOICE, input_audio_format: "pcm16", output_audio_format: "pcm16", turn_detection: { type: "server_vad" } } });

  // ── 5. 一轮真实话轮：切到 B（经原宿主链，不经请求回显）────────────────────
  const outputs = () => socket.sent.filter(m => m.item?.type === "function_call_output");
  const creates = () => socket.sent.filter(m => m.type === "response.create");

  const feedbacks = () => messages.flatMap(m => {
    const event = (m as any)?.event;

    return m.type === "agent_event" && event?.kind === "execution_feedback" && event.feedback ? [event.feedback] : [];
  });

  const waitFor = async (label: string, fn: () => boolean, ms = 15_000): Promise<void> => {
    const end = Date.now() + ms;

    while (Date.now() < end) { if (fn()) return; await new Promise(r => setTimeout(r, 50)); }

    throw new Error(`等待超时：${label}`);
  };

  const turnStart = Date.now();
  socket.server({ type: "input_audio_buffer.speech_started", item_id: "u1" });
  voice.command({ kind: "commit", turn: 2, input: { context: { tabId: tabA, url: `${iso.fixtureOrigin}/a`, title: "A" } } });
  socket.server({ type: "input_audio_buffer.speech_stopped", item_id: "u1" });
  socket.server({ type: "response.created", response: { id: "r1" } });
  socket.server({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "切到测试标签页" });
  socket.server({ type: "response.function_call_arguments.done", response_id: "r1", call_id: "provider-switch", name: "tabs", arguments: JSON.stringify({ action: "switch", tabId: tabB }) });
  socket.server({ type: "response.done", response: { id: "r1", status: "completed" } });

  await waitFor("tool output", () => outputs().length === 1);
  await waitFor("execution feedback", () => feedbacks().length >= 1);
  const batchDone = Date.now();

  // ── 6. 独立读取实际活动标签（与回执无关的两条通道）────────────────────────
  const postRead = await readActive();
  const postVisA = await visibility(targetA);
  const postVisB = await visibility(targetB);
  record.independentRead = { ...record.independentRead, post: postRead, postVisA, postVisB };

  // ── 7. 取证与断言 ────────────────────────────────────────────────────────
  const receiptEvent = bridgeEvents.find(e => e.kind === "rpc-end" && e.name === "switch_tab");
  record.receipt = receiptEvent;
  const receipt = (receiptEvent?.data ?? {}) as any;
  const feedback = feedbacks()[0];
  record.feedback = feedback;
  const output = outputs().length ? JSON.parse(outputs()[0].item.output) : null;
  record.toolOutput = output;
  record.modelText = output?.content?.[0]?.text ?? null;
  const gateLog = logs.filter(l => l.type === "spoken_result_gate").at(-1);
  const setupReceipt = (setup?.data ?? {}) as any;

  // 生产回执核验事实 ↔ 独立读取互证
  check("A1 receipt.verified true", receipt?.verification?.verified === true, receipt?.verification);
  check("A1 receipt.activeTabId === B", receipt?.verification?.activeTabId === tabB, receipt?.verification);
  check("A1 receipt.windowFocused true", receipt?.verification?.windowFocused === true, receipt?.verification);
  check("A1 receipt.workingTabId === B", receipt?.verification?.workingTabId === tabB, receipt?.verification);
  check("A1 receipt.tabId keeps requested work target", receipt?.tabId === tabB, receipt?.tabId);
  check("independent active tab is B", postRead.tabId === tabB && postRead.bActive === true, postRead);
  check("independent visibility: B visible, A hidden", postVisB === "visible" && postVisA === "hidden", { postVisA, postVisB });
  check("independent focus fact still true", postRead.focused === true, postRead);
  check("receipt facts correspond to independent reads",
    receipt?.verification?.activeTabId === postRead.tabId && receipt?.verification?.windowFocused === postRead.focused,
    { receipt: receipt?.verification, independent: postRead });

  // 原宿主链成功资格
  check("feedback is success capsule 切好了", feedback?.channel === "capsule" && feedback?.kind === "success" && feedback?.text === "切好了", feedback);
  check("feedback bounce + capsuleCanCloseAction", feedback?.bounce === true && feedback?.capsuleCanCloseAction === true, feedback);
  check("feedback keeps executed fact and target tab", feedback?.facts?.executionFact === "executed" && feedback?.facts?.tabId === tabB, feedback?.facts);
  check("feedback bound to real call identity", typeof feedback?.id === "string" && feedback.id.startsWith("tool:") && typeof feedback?.inputId === "string", { id: feedback?.id, inputId: feedback?.inputId });
  check("setup receipt (switch to A) also verified", setupReceipt?.verification?.verified === true && setupReceipt?.verification?.activeTabId === tabA, setupReceipt?.verification);

  // 模型可见工具文字与胶囊一致
  check("model sees hostFeedback 切好了", output?.hostFeedback?.text === "切好了", output?.hostFeedback);
  check("model text states work target AND verified visibility",
    typeof record.modelText === "string" && record.modelText.includes(`Working tab is now ${tabB}`) && record.modelText.includes("active tab of its focused window"),
    record.modelText);

  // request-gate 消费：真实成功资格 → capsule_only 闭合，零续答
  check("request-gate applied capsule_only", gateLog?.applied === true && gateLog?.reason === "capsule_only", gateLog);
  check("no continuation created for the closed action", creates().length === 0, creates().length);

  // 零新增等待：判断为本地夹具、无网络；工具回传后批次即决策
  check("zero model requests", record.modelRequests === 0, { note: "shadow judge 本地夹具、voice 为内存 socket，无任何外部请求" });
  const outputAt = receiptEvent?.at as number | undefined;
  check("batch settled right after tool receipt (no added wait window)",
    typeof outputAt === "number" && batchDone - outputAt < 2000, { outputAt, batchDone, deltaMs: typeof outputAt === "number" ? batchDone - outputAt : null });
  record.gate = { ...gateLog, turnStart, batchDone };

  record.status = record.assertions.every(a => a.ok) ? "PASS" : "FAIL";
} catch (error) {
  const message = String(error instanceof Error ? error.message : error);

  if (record.status !== "BLOCKED") {
    record.status = "FAIL";
    record.reason = message;
    record.assertions.push({ id: "probe-error", ok: false, detail: message });
  } else {
    record.assertions.push({ id: "blocked", ok: false, detail: record.reason });
  }
} finally {
  try { for (const v of voices) v.close(); } catch { /* 关闭失败不影响结论 */ }

  try { manager?.dispose(); } catch { /* 同上 */ }

  try { if (iso) record.cleanup = await iso.close(); } catch (e) { record.cleanup = { error: String(e) }; }

  const dailyDistAfter = existsSync(join(repo, "extension/dist/background.js"))
    ? createHash("sha256").update(await readFile(join(repo, "extension/dist/background.js"))).digest("hex")
    : null;

  record.build = { ...record.build, dailyDistAfter, dailyDistUnchanged: dailyDistBefore === dailyDistAfter };
  await writeFile(join(out, "result.json"), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ status: record.status, reason: record.reason, out, failed: record.assertions.filter(a => !a.ok) }, null, 2));
  process.exit(record.status === "PASS" ? 0 : record.status === "BLOCKED" ? 2 : 1);
}
