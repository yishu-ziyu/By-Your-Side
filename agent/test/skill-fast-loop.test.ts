import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SkillStore } from "../src/skill-store.js";
import { trySkillFastLoop } from "../src/skill-fast-loop.js";
import { createBrowserTools } from "../src/tools.js";
import { learningFixture, skillPage } from "./fixtures/skill-evidence.js";
import { skillBrowser } from "./fixtures/skill-browser.js";
import { SkillLearningTrace } from "../src/skill-learning.js";
import { TaskProgress } from "../src/task-progress.js";
import { BrowserAgentSession } from "../src/session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function harness() {
  const root = await mkdtemp(join(tmpdir(), "bys-fast-skill-")); roots.push(root);
  const store = new SkillStore(root), candidate = learningFixture().candidate();
  await store.propose(candidate); await store.saveCandidate(candidate.skill.id, candidate.sourceRunId);
  const page = skillBrowser(), controller = new AbortController(), notice = vi.fn(), judge = vi.fn(async () => { throw new Error("not expected"); });
  const progress = new TaskProgress("default"); progress.request("搜索「李四」，地区「深圳」");
  const session = new (BrowserAgentSession as any)(null, null, { emit: (event: any) => progress.observe({ type: "agent_event", conversationId: "default", event }), setStatus: () => {} }, null, null, 30_000, null, page.rpc);
  session.bindConversationContext(() => progress.snapshot());
  const tools = createBrowserTools(page.rpc, undefined, undefined, undefined, { epoch: () => page.state.epoch, canWrite: () => page.state.writable,
    assertCall: (name, params, id) => session.assertTaskResultExecution(name, params, id), onStep: step => session.observeProgramStep(step) });
  let sequence = 0;
  const execute = vi.fn(async (name: "snapshot" | "browser_run", params: Record<string, unknown>) => {
    const tool = tools.find(tool => tool.name === name)!;
    return tool.execute(`fast-${++sequence}`, params, controller.signal, undefined, {} as never);
  });
  const options = { store, rpc: page.rpc, context: skillPage, request: "搜索「李四」，地区「深圳」", signal: controller.signal,
    current: () => !controller.signal.aborted && page.state.epoch === 0, execute, notice, judge };
  return { store, candidate, page, controller, options, progress };
}

describe("production router → store → registered browser_run → QuickJS → verified outcome", () => {
  it("reuses a saved recipe with new material and no semantic or primary model", async () => {
    const h = await harness();
    const result = await trySkillFastLoop(h.options);
    expect(result).toMatchObject({ kind: "done", outcome: { ok: true, value: { verified: true } } });
    expect(h.page.query.value).toBe("李四"); expect(h.page.region.value).toBe("深圳"); expect(h.page.output.textContent).toBe("李四 / 深圳");
    expect(h.options.judge).not.toHaveBeenCalled(); expect(h.page.writes.map(write => write.name)).toEqual(["fill", "fill", "click"]);
    const fills = h.progress.snapshot().results!.filter(result => result.tool === "fill");
    expect(fills).toHaveLength(2); expect(new Set(fills.map(result => result.target)).size).toBe(2);
    expect(fills.every(result => result.status === "satisfied")).toBe(true);
    expect((await h.store.get(h.candidate.skill.id))!.inputs).toEqual({ 客户名: "", 地区: "" });
  });
  it("exposes one closed execution boundary for exact replay", async () => {
    const h = await harness(), onProgramStart = vi.fn(), onProgramEnd = vi.fn();
    expect(await trySkillFastLoop({ ...h.options, exactOnly: true, onProgramStart, onProgramEnd }))
      .toMatchObject({ kind: "done", outcome: { ok: true } });
    expect(onProgramStart).toHaveBeenCalledTimes(1);
    expect(onProgramEnd).toHaveBeenCalledWith("executed");
    expect(h.options.judge).not.toHaveBeenCalled();
  });
  it("supports the original material as a fresh explicit request", async () => {
    const h = await harness(); expect(await trySkillFastLoop({ ...h.options, request: "搜索「张三」，地区「北京」" })).toMatchObject({ kind: "done", outcome: { ok: true } });
    expect(h.page.output.textContent).toBe("张三 / 北京");
  });
  it("does not let an explicitly selected skill certify an exact task plus an extra requirement", async () => {
    const h = await harness();
    const result = await trySkillFastLoop({
      ...h.options,
      request: "搜索「李四」，地区「深圳」，然后导出结果。",
      exactOnly: true,
      selected: {
        id: h.candidate.skill.id,
        expectedVersion: h.candidate.skill.version,
        inputs: { 客户名: "李四", 地区: "深圳" },
      },
    });
    expect(result).toMatchObject({ kind: "miss" });
    expect(h.page.writes).toEqual([]);
    expect(h.options.execute).not.toHaveBeenCalled();
  });
  it("ambiguous saved skills never touch the page", async () => {
    const h = await harness(); await h.store.put({ ...h.candidate.skill, id: "second-recipe" });
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "miss" }); expect(h.page.writes).toEqual([]); expect(h.options.execute).not.toHaveBeenCalled();
  });
  it("stale skills stay out of automatic replay", async () => {
    const h = await harness(); for (let i = 0; i < 3; i++) await h.store.appendRun(h.candidate.skill.id, { at: i, ok: false, elapsedMs: 1, steps: 1, failedStep: 1 });
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "miss" }); expect(h.page.writes).toEqual([]);
  });
  it("does not run after deletion", async () => {
    const h = await harness(); await h.store.forget(h.candidate.skill.id);
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "miss" }); expect(h.page.writes).toEqual([]);
  });
  it("a page on a different domain fails before any write", async () => {
    const h = await harness(); h.page.state.hostname = "other.example";
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "fallback" }); expect(h.page.writes).toEqual([]);
  });
  it("a missing second target stops after the first correct step; it does not replay", async () => {
    const h = await harness(); h.page.region.attrs["aria-label"] = "changed";
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "fallback" }); expect(h.page.writes).toHaveLength(1); expect(h.page.writes[0]!.value).toBe("李四");
  });
  it("takeover during the program prevents every later write", async () => {
    const h = await harness(); h.page.state.afterFill = () => { h.page.state.epoch++; h.page.state.writable = false; };
    expect(await trySkillFastLoop(h.options)).toEqual({ kind: "stopped" }); expect(h.page.writes).toHaveLength(1);
  });
  it("abort is not a reason to reroute or continue executing", async () => {
    const h = await harness(); h.page.state.afterFill = () => h.controller.abort();
    expect(await trySkillFastLoop(h.options)).toEqual({ kind: "stopped" }); expect(h.page.writes).toHaveLength(1); expect(h.options.judge).not.toHaveBeenCalled();
  });
  it("explicit replay rejects unknown inputs before taking a snapshot", async () => {
    const h = await harness(), onResult = vi.fn();
    expect(await trySkillFastLoop({ ...h.options, selected: { id: h.candidate.skill.id, expectedVersion: 1, inputs: { wrong: "x" }, onResult } })).toMatchObject({ kind: "done", outcome: { ok: false } });
    expect(h.options.execute).not.toHaveBeenCalled(); expect(onResult).toHaveBeenCalledTimes(1);
  });
  it("rechecks version before execution", async () => {
    const h = await harness();
    const original = h.options.execute.getMockImplementation()!;
    h.options.execute.mockImplementation(async (name, params) => {
      const result = await original(name, params);
      if (name === "snapshot") await h.store.put({ ...h.candidate.skill, version: 2 });
      return result;
    });
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "miss" }); expect(h.page.writes).toEqual([]);
  });
  it("history storage failure never causes successful writes to be repeated", async () => {
    const h = await harness(); vi.spyOn(h.store, "appendRun").mockRejectedValue(new Error("disk full"));
    expect(await trySkillFastLoop(h.options)).toMatchObject({ kind: "done", outcome: { ok: true } }); expect(h.page.writes).toHaveLength(3);
  });
  it("an explicitly chosen version changing during preflight cannot silently fall back to the model", async () => {
    const h = await harness(), onResult = vi.fn();
    const execute = h.options.execute.getMockImplementation()!;
    h.options.execute.mockImplementation(async (name, params) => {
      const result = await execute(name, params);
      if (name === "snapshot") await h.store.put({ ...h.candidate.skill, version: 2 });
      return result;
    });
    expect(await trySkillFastLoop({ ...h.options, selected: { id: h.candidate.skill.id, expectedVersion: 1,
      inputs: { 客户名: "李四", 地区: "深圳" }, onResult } })).toMatchObject({ kind: "done", outcome: { ok: false } });
    expect(h.page.writes).toEqual([]); expect(onResult).toHaveBeenCalledTimes(1);
  });
  it("a cancellation during history persistence cannot publish a stale manual success", async () => {
    const h = await harness(), onResult = vi.fn();
    vi.spyOn(h.store, "appendRun").mockImplementation(async () => { h.controller.abort(); });
    expect(await trySkillFastLoop({ ...h.options, selected: { id: h.candidate.skill.id, expectedVersion: 1,
      inputs: { 客户名: "李四", 地区: "深圳" }, onResult } })).toEqual({ kind: "stopped" });
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ ok: false, error: expect.stringContaining("取消") }));
    expect(h.page.writes).toHaveLength(3);
  });
});

it.each(["read_element", "snapshot"] as const)("registered normal tools capture verified results when the model uses %s", async observer => {
  const page = skillBrowser(), trace = new SkillLearningTrace();
  trace.begin("normal-run", "搜索「张三」，地区「北京」", skillPage);
  const tools = createBrowserTools(page.rpc, undefined, undefined, undefined, { epoch: () => 0, canWrite: () => true, learning: trace });
  let id = 0;
  const invoke = (name: string, params: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(`normal-${++id}`, params, undefined, undefined, {} as never);
  await invoke("fill", { target: "@1", value: "张三", tabId: 7 }); await invoke("fill", { target: "@2", value: "北京", tabId: 7 });
  await invoke("click", { target: "@3", tabId: 7 });
  if (observer === "snapshot") await invoke("snapshot", { tabId: 7 });
  else await invoke("read_element", { target: "@4", tabId: 7, expect: { property: "textContent", contains: "张三" } });
  expect(trace.finish("normal-run", true)).toMatchObject({ evidence: { actionCount: 3 }, skill: { inputs: { 客户名: "", 地区: "" } } });
  if (observer === "snapshot") expect(page.rpc.call.mock.calls.some((args: unknown[]) => args[0] === "read_element" && args[2] === 1500)).toBe(true);
});
