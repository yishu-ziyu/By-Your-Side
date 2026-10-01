/**
 * 「结果不确定」查不清就说明并停下，不再原地反复核查（docs/evals/20261001-unknown-lock-scope.md 标准 3）。
 * 来源：2026-10-01 14:24 Drive 上传事故（by-your-side-traces-2026-10-01-14-44-50.jsonl 第 551–669 行）：
 * snapshot → arm_event(filechooser) → 点「新建/上传」→ 点「File upload」→ wait_event 报 INVALID_ARGUMENT（executionFact unknown）
 * → 模型连续 6 次 resolve_unknown_result(auto-5-u6jn, body, 「火线S1E11-13解说字幕.md」)，每次「未知状态保留」，直到原地打转保护叫停。
 *
 * 走生产装配：ConversationManager + createConversationRuntime（扩展里用的会话循环），模型是脚本，扩展一侧用假回执。
 * 脚本模型照事故里的模型行事：宿主账本里还有结果不确定的项，它就去核查那一项，从不自己收手。
 *
 * 失败方式（先列，每条对应下面的断言）：
 * F1 等事件（wait_event）出错仍被记成结果不确定，模型被引去核查一个本不会重复造成后果的步骤；
 * F2 核查一次查不清后，宿主仍让同一项继续核查：核查调用超过 2 次、页面被重复读；
 * F3 第二次核查被拒后本轮没有结束，最后由原地打转保护（no_progress_stop）叫停；
 * F4 收尾没有给用户说明，或说明里没讲哪一步、没讲没有重复执行；
 * F5 收尾时把这一项算作完成（结果项不再是不确定），或把可能已生效的点击重做了一次；
 * F6 第二次核查被拒后宿主不肯交付（交付被扣下、没有 user_delivery）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import type { ModelPort } from "../src/agent-loop.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { createConversationRuntime } from "../src/conversation-runtime.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "../src/document-file.js";
import type { ServerMessage, ToolExecutionFact } from "../../shared/protocol.js";
import type { TaskProgressSnapshot } from "../../shared/voice.js";

const dirs: string[] = [];

const traceDir = mkdtempSync(join(tmpdir(), "bys-check-once-trace-"));

dirs.push(traceDir);

process.env.SIDEAGENT_TRACE_DIR = traceDir;

afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 1_024,
};

function message(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
  return { role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now() };
}

type Call = { name: string; arguments: Extract<AssistantMessage["content"][number], { type: "toolCall" }>["arguments"] };

const FILE = "火线S1E11-13解说字幕.md";

const PAGE = { tabId: 7, title: "My Drive - Google Drive", url: "https://drive.google.com/drive/my-drive" };

const DRIVE_LIST = "My Drive 张修齐.md 考研政治精讲精练.md 新建 File upload";

/**
 * 事故模型：先按脚本走完上传步骤；之后只要宿主账本里还有结果不确定的项就去核查它（事故里它从宿主投影里抄 id），
 * 没有就用一段正文收尾。保险：第 16 步收手，测试以断言失败结束而不是挂死。
 */
function incidentModel(prefix: Call[], snapshot: () => TaskProgressSnapshot | null): ModelPort & { calls: Call[] } {
  const calls: Call[] = [];

  const streamSimple: ModelPort["streamSimple"] = (_model, _context, options) => {
    const stream = createAssistantMessageEventStream();

    if (options?.signal?.aborted) {
      const aborted = message([], "aborted");
      setTimeout(() => stream.push({ type: "error", reason: "aborted", error: aborted }), 0);

      return stream;
    }

    const step = calls.length;
    const results = snapshot()?.results ?? [];
    const unknown = results.find(item => item.status === "unknown" && !item.supersededBy);
    let next: Call | null = prefix[step] ?? null;

    if (!next && unknown && step < 16) next = { name: "resolve_unknown_result", arguments: { id: unknown.id, target: "body", expect: FILE } };

    const reply = next
      ? message([{ type: "toolCall", id: `t${step}`, name: next.name, arguments: next.arguments }], "toolUse")
      : message([{ type: "text", text: "上传到 Drive 这一步我没能确认，列表里没看到这个文件，也没有重复上传。" }], "stop");

    if (next) calls.push(next);
    setTimeout(() => stream.push({ type: "done", reason: reply.stopReason === "stop" ? "stop" : "toolUse", message: reply }), 0);

    return stream;
  };

  // 记忆、目标核对等旁路调用：一律回「做完」，不影响本测试的主循环。
  const completeSimple: ModelPort["completeSimple"] = async () => message([{ type: "text", text: JSON.stringify({ status: "done" }) }], "stop");

  return { calls, getModel: () => model, getAvailable: async () => [model], completeSimple, streamSimple };
}

async function until(probe: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();

  while (!probe()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

type Frame = Extract<ServerMessage, { type: "tool_call" }>;

type Reply = { ok: true; data: unknown; fact?: ToolExecutionFact } | { ok: false; error: string; fact: ToolExecutionFact };

/** 跑一遍事故序列：uncertain 决定哪一步拿到「结果未知」回执。 */
async function replay(prefix: Call[], uncertain: (frame: Frame) => Reply | null) {
  const dir = mkdtempSync(join(tmpdir(), "bys-check-once-"));
  dirs.push(dir);
  const messages: ServerMessage[] = [];
  const frames: Frame[] = [];
  let manager: ConversationManager | null = null;
  const snapshot = () => manager?.getTaskProgress("default") ?? null;
  const models = incidentModel(prefix, snapshot);
  const memoryStore = new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE));
  let rpc: Awaited<ReturnType<typeof createConversationRuntime>>["rpc"] | null = null;

  const reply = (frame: Frame) => {
    const scripted = uncertain(frame);

    if (scripted) {
      if (scripted.ok) rpc!.handleResult(frame.id, true, scripted.data, undefined, scripted.fact ?? "executed");
      else rpc!.handleResult(frame.id, false, undefined, scripted.error, scripted.fact);

      return;
    }

    if (frame.name === "snapshot") rpc!.handleResult(frame.id, true, { text: DRIVE_LIST, tabId: PAGE.tabId, url: PAGE.url }, undefined, "executed");
    else if (frame.name === "read_element") rpc!.handleResult(frame.id, true, { textContent: DRIVE_LIST, tabId: PAGE.tabId }, undefined, "executed");
    else if (frame.name === "arm_event") rpc!.handleResult(frame.id, true, { token: "tok-filechooser-1", type: "filechooser", tabId: PAGE.tabId, timeoutMs: 10000 }, undefined, "executed");
    else if (frame.name === "click") rpc!.handleResult(frame.id, true, { clicked: true }, undefined, "executed");
    else rpc!.handleResult(frame.id, true, {}, undefined, "executed");
  };

  manager = new ConversationManager(async (id, emit) => {
    const runtime = await createConversationRuntime(id, msg => {
      emit(msg);

      if (msg.type === "tool_call") { frames.push(msg); queueMicrotask(() => reply(msg)); }
    }, "probe/probe", { loop: { models, cwd: "/tmp" }, memoryStore });

    rpc = runtime.rpc;

    return runtime;
  }, msg => messages.push(msg), undefined, memoryStore);

  await manager.ensureDefault();
  await manager.handleMessage({ type: "user_message", text: `把字幕 Markdown 文件（${FILE}）存到 Google Drive`, context: PAGE });
  await until(() => messages.some(msg => msg.type === "agent_event" && msg.event.kind === "agent_end"), "the run to end");
  // 交付与诊断记录异步落地。
  await new Promise(resolve => setTimeout(resolve, 100));

  const events = messages.flatMap(msg => (msg.type === "agent_event" ? [msg.event] : []));
  const deliveries = events.flatMap(event => (event.kind === "user_delivery" ? [event.delivery] : []));
  const trace = () => readdirSync(traceDir).map(name => readFileSync(join(traceDir, name), "utf8")).join("");

  return { manager, models, frames, deliveries, events, trace, snapshot, dispose: () => manager!.dispose() };
}

const UPLOAD_STEPS: Call[] = [
  { name: "snapshot", arguments: {} },
  { name: "arm_event", arguments: { type: "filechooser" } },
  { name: "click", arguments: { target: "#new", label: "新建/上传按钮" } },
  { name: "click", arguments: { target: "#upload", label: "File upload" } },
];

describe("10-01 Drive 上传事故重放", () => {
  it("F1 原样重放：wait_event 出错只是没等到事件，不记成结果不确定，模型不去核查，直接说明收尾", async () => {
    const h = await replay([...UPLOAD_STEPS, { name: "wait_event", arguments: { token: "tok-filechooser-1", timeoutMs: 30000 } }],
      frame => (frame.name === "wait_event" ? { ok: false, error: "INVALID_ARGUMENT: event token is timed_out", fact: "unknown" } : null));

    try {
      expect(h.snapshot()?.results?.some(item => item.status === "unknown")).toBe(false);
      expect(h.models.calls.filter(call => call.name === "resolve_unknown_result")).toHaveLength(0);
      expect(h.trace()).not.toContain('"type":"no_progress_stop"');
      // 事故里 wait_event 确实发到了扩展、拿回了错误。
      expect(h.frames.filter(frame => frame.name === "wait_event")).toHaveLength(1);
      expect(h.deliveries).toHaveLength(1);
      expect(h.deliveries[0]!.text.startsWith("上传到 Drive 这一步我没能确认，列表里没看到这个文件，也没有重复上传。")).toBe(true);
    } finally { h.dispose(); }
  }, 40_000);

  it("F2–F6 上传那一下结果不确定：核查一次查不清，第二次被拒并由宿主说明收尾，不重做、不被原地打转保护叫停", async () => {
    const h = await replay(UPLOAD_STEPS,
      frame => (frame.name === "click" && frame.params.target === "#upload" ? { ok: false, error: 'Tool call "click" timed out after 30000ms', fact: "unknown" } : null));

    try {
      const checks = h.models.calls.filter(call => call.name === "resolve_unknown_result");
      // F2：最多 2 次核查调用，页面只为核查读了一次。
      expect(checks.length).toBeGreaterThanOrEqual(1);
      expect(checks.length).toBeLessThanOrEqual(2);
      expect(h.frames.filter(frame => frame.name === "read_element")).toHaveLength(1);
      // F3：不是原地打转保护叫停的，而是宿主的「查不清」收尾。
      await until(() => h.trace().includes('"type":"unconfirmed_result_stop"'), "the unconfirmed_result_stop trace record");
      expect(h.trace()).not.toContain('"type":"no_progress_stop"');
      // F4 / F6：只交付一次，说清哪一步、没有重复执行、没算完成。
      expect(h.deliveries).toHaveLength(1);
      expect(h.deliveries[0]!.text).toBe("「点击「File upload」」这一步的结果查不清：我已经在页面上核查过一次，没找到能证明它完成的证据。我没有重复执行，也没有把它算作完成，请你在页面上看一眼确认。");
      // F5：结果仍是不确定，点击只发出过一次。
      const item = h.snapshot()?.results?.find(result => result.target === "#upload");
      expect(item?.status).toBe("unknown");
      expect(h.frames.filter(frame => frame.name === "click" && frame.params.target === "#upload")).toHaveLength(1);
    } finally { h.dispose(); }
  }, 40_000);
});
