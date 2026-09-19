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
  const executionErrors: unknown[] = [], dispatcher = new TaskDispatcher(), dispatch = dispatcher.dispatch.bind(dispatcher);
  vi.spyOn(dispatcher, "dispatch").mockImplementation((request, title, execute, options) => dispatch(request, title, async () => {
    try { return await execute(); } catch (error) { executionErrors.push(error); throw error; }
  }, options));
  const manager = new ConversationManager(async (id, emit) => {
    const raw: any = { model: { provider: "test", id: "scripted" }, isStreaming: false, agent: { state: { tools: [], messages: [] } },
      prompt: prompts, sendCustomMessage: vi.fn(async () => {}), abort: vi.fn(async () => {}),
      clearQueue: () => ({ steering: [], followUp: [] }), sessionManager: { appendCustomEntry: vi.fn(), getBranch: () => [] },
      subscribe: (listener: (event: unknown) => void) => { sdkEvent = listener; return () => {}; },
      getActiveToolNames: () => raw.agent.state.tools.map((tool: any) => tool.name) };
    wrapper = new (BrowserAgentSession as any)(raw, null, { emit: (event: any) => emit({ type: "agent_event", event }), setStatus: (state: any) => emit({ type: "status", state }) }, null, null, undefined, null, page.rpc);
    Object.assign(wrapper, { skillStore: store, explicitDelivery: true, modeState: { value: "act" } });
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
    sdkEvent: (event: unknown) => sdkEvent(event), tool: (name: string) => registeredTools.find(tool => tool.name === name) };
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
  expect(await h.store.list()).toEqual([]);
});
