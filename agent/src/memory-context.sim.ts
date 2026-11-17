import assert from "node:assert/strict";
import { test } from "node:test";
import { selectMemoryContext } from "./memory-context.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import type { MemoryEntry } from "../../shared/memory.js";

const now = 1_800_000_000_000;
const task = (id: string, changes: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry => ({
  id, conversationId: `c_${id}`, goal: "Kyoto rail itinerary", revisions: [], hosts: ["travel.example"],
  outcome: "complete", summary: "Compared train routes", done: "Route saved", unfinished: [], startedAt: now - 1000, endedAt: now, ...changes,
});
const select = (tasks: TaskHistoryEntry[], text = "Kyoto itinerary options", extra: object = {}) => selectMemoryContext({ entries: [], tasks, hostname: "rail.example", text, now, ...extra });

 test("历史任务：同站相关任务可用，跨站无关任务不进入上下文", () => {
  assert.deepEqual(select([task("same", { hosts: ["rail.example"] }), task("unrelated", { goal: "Birthday cake recipe" })]).tasks.map(x => x.task.id), ["same"]);
});

test("历史任务：跨站同主题任务进入上下文", () => {
  assert.deepEqual(select([task("kyoto")]).tasks.map(x => x.task.id), ["kyoto"]);
});

test("历史任务：过期和当前站禁用优先于追问、字面和语义命中", async () => {
  const { taskFingerprint } = await import("./semantic-index.js");
  const tasks = [task("expired", { validity: { end: now - 1 } }), task("hidden", { notOnHosts: ["rail.example"] }), task("future", { validity: { start: now + 1 } })];
  const semanticTasks = tasks.map(t => ({ id: t.id, fingerprint: taskFingerprint(t), score: 0.99 }));
  assert.deepEqual(select(tasks, "之前 Kyoto itinerary", { semanticTasks }).tasks, []);
});

test("历史任务：语义命中支持换词，旧内容或旧权限指纹无效", async () => {
  const { taskFingerprint } = await import("./semantic-index.js");
  const original = task("semantic");
  const semanticTasks = [{ id: original.id, fingerprint: taskFingerprint(original), score: 0.94 }];
  assert.deepEqual(select([original], "日本古都交通安排", { semanticTasks }).tasks.map(x => x.task.id), ["semantic"]);
  for (const changed of [task("semantic", { summary: "Different result" }), task("semantic", { notOnHosts: ["private.example"] }), task("semantic", { validity: { end: now + 10 } }), task("semantic", { hosts: ["other.example"] })]) {
    assert.notEqual(taskFingerprint(changed), taskFingerprint(original));
    assert.deepEqual(select([changed], "日本古都交通安排", { semanticTasks }).tasks.filter(item => item.rule === "related"), []);
  }
});

test("历史任务：跨站最多两条且不超过 1800 字符", () => {
  const selected = select([task("one"), task("two"), task("three")]);
  assert.equal(selected.tasks.length, 2);
  assert.ok(selected.totalChars <= 1800);
  const long = select([task("long-one", { goal: "Kyoto " + "x".repeat(900) }), task("long-two", { goal: "Kyoto " + "y".repeat(900) })]);
  assert.equal(long.tasks.length, 1);
  assert.ok(long.totalChars <= 1800);
});

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const memory: MemoryEntry = { id: "experience", factId: "experience", version: 1, text: "Rail experience", scope: { kind: "all" }, sourceConversationId: "c_exp", createdAt: now, updatedAt: now, kind: "method", useCount: 0, status: "active", formatVersion: 3, experience: { runId: "run_exp", evidence: ["route checked"] } };

test("语义索引：冷启动不阻塞，历史同步保留经验，self-use 不写索引", async () => {
  const { BackgroundSemanticIndex } = await import("./semantic-index.js");
  let release!: () => void;
  let readOnly = false;
  const built: Array<Array<{ kind: string }>> = [];
  const index = new BackgroundSemanticIndex({
    warmup: () => new Promise<void>(resolve => { release = resolve; }),
    replace: async documents => { built.push(documents); }, recall: async () => [],
  }, () => readOnly);
  await index.sync([memory], [task("trip")]);
  assert.equal(built.length, 0);
  release(); await flush();
  assert.deepEqual(built[0]!.map(x => x.kind).sort(), ["memory", "task"]);
  await index.sync([memory]); await flush();
  assert.equal(built.length, 1);
  readOnly = true;
  await index.sync([memory], [task("changed")]); await flush();
  assert.equal(built.length, 1);
});

test("语义索引：后台初始化失败已处理，后续同步可恢复", async () => {
  const { BackgroundSemanticIndex } = await import("./semantic-index.js");
  let attempts = 0;
  let builds = 0;
  const index = new BackgroundSemanticIndex({ warmup: async () => { if (++attempts === 1) throw new Error("offline"); }, replace: async () => { builds++; }, recall: async () => [] });
  await index.sync([], [task("retry")]); await flush();
  assert.equal(builds, 0);
  await index.sync([], [task("retry")]); await flush();
  assert.equal(builds, 1);
});

test("语义检索：sync 和 select 共用 1500ms 上限，超时后返回空候选", async () => {
  const { retrieveSemantic } = await import("./semantic-index.js");
  let time = 0;
  let timeout: (() => void) | undefined;
  let delay = 0;
  let releaseSync!: () => void;
  let selects = 0;
  const clock = { now: () => time, setTimeout: (fn: () => void, ms: number) => { timeout = fn; delay = ms; return 1; }, clearTimeout: (_id: unknown) => { timeout = undefined; } };
  const pending = retrieveSemantic({ sync: () => new Promise<void>(resolve => { releaseSync = resolve; }), select: async () => { selects++; return new Promise<never>(() => {}); } }, [], [], { text: "Kyoto" }, clock);
  await flush();
  assert.equal(delay, 1500);
  time = 1000; releaseSync(); await flush();
  assert.equal(selects, 1);
  time = 1500; timeout!();
  assert.deepEqual(await pending, []);
  assert.equal(time, 1500);
});
