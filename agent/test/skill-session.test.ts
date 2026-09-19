import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("../src/run-trace.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/run-trace.js")>(),
  RunTrace: class { begin() {} record() {} event() {} },
}));
import { BrowserAgentSession } from "../src/session.js";
import { ConversationManager } from "../src/conversation-manager.js";
import { TaskDispatcher } from "../src/task-dispatcher.js";
import { SkillStore } from "../src/skill-store.js";
import { createBrowserTools } from "../src/tools.js";
import { createSendUserMessageTool } from "../src/user-delivery.js";
import type { ServerMessage } from "../../shared/protocol.js";
import { learningFixture, skillPage } from "./fixtures/skill-evidence.js";
import { skillBrowser } from "./fixtures/skill-browser.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "bys-skill-session-"));
  const store = new SkillStore(root), candidate = learningFixture().candidate();
  await store.put(candidate.skill);
  const page = skillBrowser(), messages: ServerMessage[] = [], prompts = vi.fn(async () => {});
  let wrapper: BrowserAgentSession;
  let sdkEvent: (event: unknown) => void = () => {};
  let registeredTools: any[] = [];
  const appendCustomEntry = vi.fn();
  const executionErrors: unknown[] = [], dispatcher = new TaskDispatcher(), dispatch = dispatcher.dispatch.bind(dispatcher);
  vi.spyOn(dispatcher, "dispatch").mockImplementation((request, title, execute, options) => dispatch(request, title, async () => {
    try { return await execute(); } catch (error) { executionErrors.push(error); throw error; }
  }, options));
  const manager = new ConversationManager(async (id, emit) => {
    const raw: any = { model: { provider: "test", id: "scripted" }, isStreaming: false, agent: { state: { tools: [], messages: [] } },
      prompt: prompts, sendCustomMessage: vi.fn(async () => {}), abort: vi.fn(async () => {}),
      clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { appendCustomEntry, getBranch: () => [] },
      subscribe: (listener: (event: unknown) => void) => { sdkEvent = listener; return () => {}; },
      getActiveToolNames: () => raw.agent.state.tools.map((tool: any) => tool.name) };
    wrapper = new (BrowserAgentSession as any)(raw, null, { emit: (event: any) => emit({ type: "agent_event", event }), setStatus: (state: any) => emit({ type: "status", state }) }, null, null, undefined, null, page.rpc);
    Object.assign(wrapper, { skillStore: store, explicitDelivery: true, modeState: { value: "act" } });
    // 生产默认走 TypeSafe 判断；测试注入确定判断，具体判断质量由 scripts/acceptance 的真实实验覆盖。
    wrapper.setDeliverableJudge(async () => 1);
    raw.agent.state.tools = [
      ...createBrowserTools(page.rpc, undefined, undefined, undefined, {
        epoch: () => wrapper.executionEpoch(), canWrite: callId => wrapper.canWriteCurrentInput(callId),
        assertCall: (name, params, callId) => wrapper.assertTaskResultExecution(name, params, callId), onStep: step => wrapper.observeProgramStep(step),
        learning: { active: () => wrapper.isLearningSkillRun(), observe: event => wrapper.observeSkillEvidence(event) },
      }),
      createSendUserMessageTool({ conversationId: id, getRunId: () => manager.getTaskProgress(id)?.runId ?? null,
        getNextStep: () => manager.getTaskProgress(id)?.nextStep ?? null, emit: event => emit({ type: "agent_event", event }) }),
    ];
    registeredTools = raw.agent.state.tools;
    (wrapper as any).subscribeEvents();
    return { session: wrapper, rpc: page.rpc, fleet: { reset: vi.fn(), list: () => [], get: () => undefined, teamView: () => null,
      isGroupHeld: () => false, abortTeam: vi.fn(), reviseSharedRequirement: vi.fn(async () => ({ notified: [], queued: [], skipped: [], failed: [] })) },
      handleMessage: vi.fn(), dispose: vi.fn() } as never;
  }, message => messages.push(message), undefined, undefined, store, dispatcher);
  cleanup.push(async () => { manager.dispose(); await rm(root, { force: true, recursive: true }); });
  await manager.ensureDefault();
  return { manager, store, candidate, page, messages, prompts, wrapper: wrapper!, executionErrors,
    appendCustomEntry, sdkEvent: (event: unknown) => sdkEvent(event), tool: (name: string) => registeredTools.find(tool => tool.name === name) };
}

it("manual parameterized replay starts a new durable task after an earlier run, using its observed identity", async () => {
  const h = await harness();
  const first = await h.manager.dispatchTaskAction({ requestId: "first", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」", context: skillPage });
  expect(first.status, h.executionErrors.map(error => String(error)).join("; ")).toBe("accepted");
  await vi.waitFor(() => expect(h.messages.some(message => message.type === "agent_event" && message.event.kind === "user_delivery")).toBe(true));
  await vi.waitFor(() => expect(h.wrapper.isStreaming()).toBe(false));
  const oldRun = h.manager.getTaskProgress("default")!.runId;
  await h.manager.handleMessage({ type: "skill_run", conversationId: "default", requestId: "manual", id: h.candidate.skill.id,
    expectedVersion: 1, inputs: { 客户名: "王五", 地区: "杭州" } });
  await vi.waitFor(() => expect(h.wrapper.isStreaming()).toBe(false));
  const receipt = h.messages.find(message => message.type === "skill_result" && message.requestId === "manual");
  expect(receipt).toMatchObject({ ok: true, run: { ok: true } });
  expect(h.manager.getTaskProgress("default")!.runId).not.toBe(oldRun);
  expect(h.page.output.textContent).toBe("王五 / 杭州");
  expect(h.prompts).not.toHaveBeenCalled();
  expect((await h.store.get(h.candidate.skill.id))!.inputs).toEqual({ 客户名: "", 地区: "" });
});

it("manual invalid inputs and version never query or write the browser", async () => {
  const h = await harness();
  for (const [requestId, payload] of [["bad-key", { inputs: { typo: "x" } }], ["bad-version", { expectedVersion: 4, inputs: { 客户名: "王五", 地区: "杭州" } }]] as const) {
    await h.manager.handleMessage({ type: "skill_run", requestId, id: h.candidate.skill.id, ...payload });
    expect(h.messages.find(message => message.type === "skill_result" && message.requestId === requestId)).toMatchObject({ ok: false });
  }
  expect(h.page.rpc.call).not.toHaveBeenCalled(); expect(h.prompts).not.toHaveBeenCalled();
});

it.each([true, false])("an old output certificate cannot bypass current coverage (learned=$learned)", async learned => {
  const h = await harness();
  const template = "搜索「{{客户名}}」，地区「{{地区}}」，找到之后告诉我结果";
  const legacy = { ...h.candidate.skill, requestTemplate: template, intent: template, sourceRunId: learned ? h.candidate.sourceRunId : undefined,
    learnedOutputContractVersion: undefined, learnedOutputChecked: true };
  await h.store.put(legacy);
  await h.manager.dispatchTaskAction({ requestId: "legacy-output", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」，找到之后告诉我结果", context: skillPage });
  await vi.waitFor(() => expect(h.prompts).toHaveBeenCalledOnce());
  expect(h.page.writes).toHaveLength(0);
});

it("this run's materials reach the page but never appear in any public event or panel history", async () => {
  const h = await harness();
  const canary = "CANARY7f3a9b2cd41d";
  await h.manager.handleMessage({ type: "skill_run", conversationId: "default", requestId: "canary-run", id: h.candidate.skill.id,
    expectedVersion: 1, inputs: { 客户名: canary, 地区: "深圳" } });
  await vi.waitFor(() => expect(h.messages.some(message => message.type === "skill_result" && message.requestId === "canary-run")).toBe(true));
  // 执行参数仍然把真实材料送进页面。
  expect(h.page.query.value).toBe(canary);
  expect(h.page.output.textContent).toBe(`${canary} / 深圳`);
  const { createHash } = await import("node:crypto");
  const realHash = createHash("sha256").update(canary).digest("hex");
  expect(h.manager.getTaskProgress("default")?.results?.some(item => item.tool === "fill" && item.evidence?.valueHash === realHash)).toBe(true);
  // 对外事件（面板据此渲染工具详情并落盘历史）不得携带运行代码或材料原文。
  const publicEvents = JSON.stringify(h.messages);
  expect(publicEvents).not.toContain(canary);
  const browserRunStart = h.messages.filter(message => message.type === "agent_event" && message.event.kind === "tool_start"
    && message.event.name === "browser_run").map(message => (message as Extract<ServerMessage, { type: "agent_event" }>).event);
  expect(browserRunStart).toHaveLength(1);
  expect(JSON.stringify(browserRunStart[0])).toContain("内置技能程序已隐藏");
});

it("a failure that carries the material back stays material-free in every public event and in the durable checkpoint", async () => {
  const h = await harness();
  const canary = "CANARY9c1f40ab77e2";
  const original = h.page.rpc.call.getMockImplementation()!;
  // 真实 RPC 失败会把材料写进错误文本（这里就是那个反例）：公开与落盘的错误同样不能带原文。
  h.page.rpc.call.mockImplementation(async (...args: unknown[]) => {
    const params = args[1] as Record<string, unknown>;
    if (args[0] === "read_element" && (params.expect as { contains?: string } | undefined)?.contains === canary) {
      throw new Error(`结果条件不成立：页面上没有找到包含 ${canary} 的结果`);
    }
    return (original as (...a: unknown[]) => Promise<unknown>)(...args);
  });
  await h.manager.handleMessage({ type: "skill_run", conversationId: "default", requestId: "canary-error", id: h.candidate.skill.id,
    expectedVersion: 1, inputs: { 客户名: canary, 地区: "深圳" } });
  await vi.waitFor(() => expect(h.messages.some(message => message.type === "skill_result" && message.requestId === "canary-error")).toBe(true));
  const receipt = h.messages.find(message => message.type === "skill_result" && message.requestId === "canary-error")!;
  expect(receipt).toMatchObject({ ok: true, run: { ok: false } });
  // 页面确实拿到了材料，失败事实也留下来了；只是原文没有出去。
  expect(h.page.query.value).toBe(canary);
  expect(JSON.stringify(h.messages)).not.toContain(canary);
  expect(h.messages.some(message => message.type === "agent_event" && message.event.kind === "user_delivery"
    && message.event.delivery.text.includes("没有确认完成"))).toBe(true);
  // 结果账本会收到只读读数（tool_observation 不下发侧栏），这里确认落盘的持久化快照同样不含原文。
  expect(JSON.stringify(h.appendCustomEntry.mock.calls)).not.toContain(canary);
});

it("does not learn the remaining tail of a steered skill as if it were the complete original workflow", async () => {
  const h = await harness();
  let steering: Promise<unknown> | undefined;
  h.page.state.afterFill = () => {
    h.page.state.afterFill = () => {};
    steering = h.wrapper.steerCurrentTask("地区改为重庆，客户名不变。", skillPage);
  };
  expect((await h.manager.dispatchTaskAction({ requestId: "steer-learning", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」", context: skillPage })).status).toBe("accepted");
  await vi.waitFor(() => expect(steering).toBeDefined());
  await steering;
  expect(h.page.writes).toHaveLength(1);
  expect(h.wrapper.isLearningSkillRun()).toBe(false);
  expect(h.prompts).toHaveBeenCalledOnce();
});

it("keeps cancellation ownership while an empty skill lookup hands off to the existing display fast path", async () => {
  const previous = process.env.SIDEAGENT_DISPLAY_FASTPATH;
  process.env.SIDEAGENT_DISPLAY_FASTPATH = "1";
  const h = await harness(); await h.store.forget(h.candidate.skill.id);
  const call = h.page.rpc.call.getMockImplementation()!;
  let release: (() => void) | undefined;
  h.page.rpc.call.mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "snapshot" && !release) await new Promise<void>(resolve => { release = resolve; });
    return (call as (...args: unknown[]) => Promise<unknown>)(...args);
  });
  try {
    await h.manager.dispatchTaskAction({ requestId: "display-handoff", conversationId: "default", source: "text", action: "start", expectedRunId: null,
      text: "显示译文", context: skillPage });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(h.wrapper.isStreaming()).toBe(true);
    h.wrapper.abort(); release!();
    await vi.waitFor(() => expect(h.wrapper.isStreaming()).toBe(false));
    expect(h.page.writes).toHaveLength(0); expect(h.prompts).not.toHaveBeenCalled();
  } finally {
    release?.();
    if (previous === undefined) delete process.env.SIDEAGENT_DISPLAY_FASTPATH; else process.env.SIDEAGENT_DISPLAY_FASTPATH = previous;
  }
});

it.each(["delivered", "superseded"] as const)("keeps verified learning bound to the late final delivery: %s", async state => {
  const h = await harness(); await h.store.forget(h.candidate.skill.id);
  let deliver!: (text: string) => void;
  vi.spyOn(h.wrapper, "composeUserDelivery").mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  expect((await h.manager.dispatchTaskAction({ requestId: "late", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」", context: skillPage })).status).toBe("accepted");
  await vi.waitFor(() => expect(h.prompts).toHaveBeenCalledOnce());
  await h.tool("browser_run").execute("real-program", { code: 'await browser.fill({target:"@1",value:"李四"}); await browser.fill({target:"@2",value:"深圳"}); await browser.click({target:"@3"}); return await browser.read_element({target:"@4",expect:{property:"textContent",contains:"李四"}});' });
  h.sdkEvent({ type: "agent_end", messages: [] });
  await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
  expect(await h.store.listCandidates()).toEqual([]);
  const originalRun = h.manager.getTaskProgress("default")!.runId;
  if (state === "superseded") {
    expect((await h.manager.dispatchTaskAction({ requestId: "replacement", conversationId: "default", source: "text", action: "start", expectedRunId: originalRun ?? null,
      text: "读一下标题，不要进行查询", context: skillPage })).status).toBe("accepted");
  }
  deliver("已核对结果中的李四和深圳。");
  if (state === "superseded") {
    await h.wrapper.completeSkillLearning(originalRun!);
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(await h.store.listCandidates()).toEqual([]); return;
  }
  await vi.waitFor(async () => expect(await h.store.listCandidates()).toHaveLength(1));
  const candidate = (await h.store.listCandidates())[0]!;
  expect(candidate.sourceRunId).toBe(h.manager.getTaskProgress("default")!.runId);
  expect(candidate.skill.inputs).toEqual({ 客户名: "", 地区: "" });
  // 只有"做法覆盖整条要求"被确认后，学习候选才带可自动复用的资格。
  expect(candidate.skill.learnedOutputContractVersion).toBe(1);
  expect(await h.store.list()).toEqual([]);
});

it.each([
  { score: .2, notice: "没有生成可自动复用的做法" },
  { score: 2, notice: "完整性暂时无法核验" },
  { score: -.1, notice: "完整性暂时无法核验" },
  { score: null, notice: "完整性暂时无法核验" },
])("learning never certifies a rejected, invalid or unavailable judgment: $score", async ({ score, notice }) => {
  const h = await harness(); await h.store.forget(h.candidate.skill.id);
  let deliver!: (text: string) => void;
  vi.spyOn(h.wrapper, "composeUserDelivery").mockImplementation(() => new Promise(resolve => { deliver = resolve; }));
  expect((await h.manager.dispatchTaskAction({ requestId: "extra-requirement", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」，并告诉我会员等级", context: skillPage })).status).toBe("accepted");
  await vi.waitFor(() => expect(h.prompts).toHaveBeenCalledOnce());
  await h.tool("browser_run").execute("real-program", { code: 'await browser.fill({target:"@1",value:"李四"}); await browser.fill({target:"@2",value:"深圳"}); await browser.click({target:"@3"}); return await browser.read_element({target:"@4",expect:{property:"textContent",contains:"李四"}});' });
  h.sdkEvent({ type: "agent_end", messages: [] });
  await vi.waitFor(() => expect(deliver).toBeTypeOf("function"));
  // 判断：这条要求里"告诉我会员等级"不在做法的交付范围内。
  h.wrapper.setDeliverableJudge(async () => { if (score === null) throw new Error("service unavailable"); return score; });
  deliver("已核对结果中的李四和深圳。");
  await vi.waitFor(() => expect(h.messages.some(message => message.type === "agent_event" && message.event.kind === "notice"
    && message.event.message.includes(notice))).toBe(true));
  expect(await h.store.listCandidates()).toEqual([]);
  expect(await h.store.list()).toEqual([]);
});

const taskViews = (messages: ServerMessage[]) => messages.filter((message): message is Extract<ServerMessage, { type: "task_view" }> => message.type === "task_view").map(message => message.view);

it("T02 任务视图：自动技能回放期间沿用真实任务身份与页面，结束后只读收敛为 idle", async () => {
  const h = await harness();
  expect((await h.manager.dispatchTaskAction({ requestId: "view-auto", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」", context: skillPage })).status).toBe("accepted");
  const runId = h.manager.getTaskProgress("default")!.runId;
  await vi.waitFor(() => expect(taskViews(h.messages).some(view => view.runId === runId && view.state === "running")).toBe(true));
  await vi.waitFor(() => expect(taskViews(h.messages).at(-1)?.state).toBe("idle"));
  const last = taskViews(h.messages).at(-1)!;
  // 视图绑定的是任务自己的页面与 run，而不是当前选中的 tab 或另起一个幽灵 run。
  expect(last).toMatchObject({ runId, state: "idle", page: { tabId: skillPage.tabId }, latestDelivery: { kind: "finding" } });
  // 真实写入进入账本且不升级状态；没有未完成项残留，也没有模型介入。
  expect(last.results.map(result => result.status)).toEqual(["satisfied", "satisfied", "satisfied"]);
  expect(last.outstanding).toEqual([]);
  expect(h.prompts).not.toHaveBeenCalled();
});

it("T02 任务视图：手动技能回放同样回到 idle 且零模型调用", async () => {
  const h = await harness();
  await h.manager.dispatchTaskAction({ requestId: "view-warm", conversationId: "default", source: "text", action: "start", expectedRunId: null,
    text: "搜索「李四」，地区「深圳」", context: skillPage });
  await vi.waitFor(() => expect(taskViews(h.messages).at(-1)?.state).toBe("idle"));
  const previousRun = h.manager.getTaskProgress("default")!.runId;
  await h.manager.handleMessage({ type: "skill_run", conversationId: "default", requestId: "manual-view", id: h.candidate.skill.id,
    expectedVersion: 1, inputs: { 客户名: "王五", 地区: "杭州" } });
  await vi.waitFor(() => expect(h.messages.some(message => message.type === "skill_result" && message.requestId === "manual-view")).toBe(true));
  const manualRun = h.manager.getTaskProgress("default")!.runId;
  expect(manualRun).not.toBe(previousRun);
  const manualViews = taskViews(h.messages).filter(view => view.runId === manualRun);
  expect(manualViews.some(view => view.state === "running")).toBe(true);
  await vi.waitFor(() => expect(taskViews(h.messages).filter(view => view.runId === manualRun).at(-1)?.state).toBe("idle"));
  expect(taskViews(h.messages).filter(view => view.runId === manualRun).at(-1)).toMatchObject({ state: "idle", page: { tabId: skillPage.tabId } });
  expect(h.page.output.textContent).toBe("王五 / 杭州");
  expect(h.prompts).not.toHaveBeenCalled();
});
