/**
 * 回答下方「用了 N 条记忆」与「这里别用 / 忘掉」（docs/evals/20261006-memory-used-line.md）。
 * 只看对外结果：发给助手的系统提示里有没有这条、给侧栏的事件里列了哪几条、存储里条目还在不在。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { TASK_HISTORY_FILE, TaskHistoryStore } from "../src/task-history.js";
import { FileDocument } from "./fixtures/file-document.js";
import type { AgentUiEvent } from "../../shared/protocol.js";
import { parseClientMessage, parseServerMessage } from "../../shared/protocol.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const A = "https://shop-a.test/item";

const B = "https://shop-b.test/item";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-memory-used-line-")); roots.push(root);
  const store = new MemoryStore(new FileDocument(root, MEMORY_STORE_FILE));
  const history = new TaskHistoryStore(new FileDocument(root, TASK_HISTORY_FILE));
  const events: AgentUiEvent[] = [];
  const runtime = new MemoryRuntime(store, "conversation-a", event => events.push(event), undefined, { history });
  let handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>;
  // SAFETY: 测试只用到 on("before_agent_start")，替身只实现这一个方法。
  runtime.extension()({ on: (name: string, fn: typeof handler) => { if (name === "before_agent_start") handler = fn; } } as never);

  /** 一轮：返回发给助手的系统提示（没带记忆时是原样）和这一轮给侧栏的「用了」事件。 */
  const turn = async (text: string, url: string) => {
    const mark = events.length;
    runtime.beginUserTurn(text, { tabId: 1, title: "page", url });
    const prompt = (await handler({ systemPrompt: "BASE" }))?.systemPrompt ?? "BASE";
    const used = events.slice(mark).filter((e): e is Extract<AgentUiEvent, { kind: "memory" }> => e.kind === "memory" && e.action === "used");

    return { prompt, used };
  };

  return { store, history, turn };
}

const task = (patch: Partial<TaskHistoryEntry> = {}): TaskHistoryEntry => ({
  id: "run-1", conversationId: "conversation-a", goal: "在 A 店订阅到货提醒 TASK-777", revisions: [], hosts: ["shop-a.test"],
  outcome: "complete", summary: "已订阅 A 店到货提醒 SUMMARY-777", unfinished: [], startedAt: 1, endedAt: Date.now() - 60_000, ...patch,
});

describe("用了 N 条记忆", () => {
  it("没有记忆：不改系统提示，也不发「用了」事件", async () => {
    const f = await fixture();
    const t = await f.turn("帮我看看这页", A);
    expect(t.prompt).toBe("BASE");
    expect(t.used).toEqual([]);
  });

  it("带了两条记忆和一条过往任务：事件里正好列出这三条，且都在系统提示里", async () => {
    const f = await fixture();
    const email = await f.store.create({ text: "邮箱：lin@example.test", scope: { kind: "all" }, sourceConversationId: "c" });
    const lang = await f.store.create({ text: "回复用中文", scope: { kind: "all" }, sourceConversationId: "c" });
    await f.history.record(task());
    const t = await f.turn("帮我看看这页", A);
    expect(t.prompt).toContain("lin@example.test");
    expect(t.prompt).toContain("回复用中文");
    expect(t.prompt).toContain("TASK-777");
    expect(t.used).toHaveLength(1);
    expect(t.used[0]!.entries.map(e => e.id).sort()).toEqual([email.id, lang.id].sort());
    expect(t.used[0]!.tasks?.map(x => x.id)).toEqual(["run-1"]);
    expect(t.used[0]!.tasks?.[0]!.summary).toBe("已订阅 A 店到货提醒 SUMMARY-777");
    expect(t.used[0]!.hostname).toBe("shop-a.test");
  });
});

describe("这里别用", () => {
  it("同一网站下一轮不带，别的网站照样带；条目没被删", async () => {
    const f = await fixture();
    const email = await f.store.create({ text: "邮箱：lin@example.test", scope: { kind: "all" }, sourceConversationId: "c" });
    const marked = await f.store.setNotHere({ id: email.id, expectedVersion: email.version, hostname: "shop-a.test", off: true });
    expect(marked.notOnHosts).toEqual(["shop-a.test"]);

    const here = await f.turn("帮我填邮箱", A);
    expect(here.prompt).not.toContain("lin@example.test");
    expect(here.used).toEqual([]);
    // 助手主动「查记忆」在这个网站也查不到它。
    expect(await f.store.select({ text: "邮箱", url: A })).toEqual([]);

    const there = await f.turn("帮我填邮箱", B);
    expect(there.prompt).toContain("lin@example.test");
    expect(there.used[0]!.entries.map(e => e.id)).toEqual([email.id]);

    expect((await f.store.list()).map(e => e.id)).toEqual([email.id]);
  });

  it("恢复后同一网站又带上", async () => {
    const f = await fixture();
    const email = await f.store.create({ text: "邮箱：lin@example.test", scope: { kind: "all" }, sourceConversationId: "c" });
    await f.store.setNotHere({ id: email.id, expectedVersion: email.version, hostname: "shop-a.test", off: true });
    const restored = await f.store.setNotHere({ id: email.id, expectedVersion: email.version, hostname: "shop-a.test", off: false });
    expect(restored.notOnHosts).toBeUndefined();
    expect((await f.turn("帮我填邮箱", A)).prompt).toContain("lin@example.test");
  });

  it("过往任务也能在这个网站别用，别的网站问起时照样带", async () => {
    const f = await fixture();
    await f.history.record(task({ hosts: ["shop-a.test", "shop-b.test"] }));
    await f.history.setNotHere("run-1", "shop-a.test", true);
    expect((await f.turn("帮我看看这页", A)).prompt).not.toContain("TASK-777");
    expect((await f.turn("帮我看看这页", B)).prompt).toContain("TASK-777");
    expect((await f.history.list()).map(x => x.id)).toEqual(["run-1"]);
  });
});

describe("忘掉与撤销", () => {
  it("忘掉后下一轮不带；撤销后原样回来（连同被替换的旧值），再下一轮又带上", async () => {
    const f = await fixture();
    const email = await f.store.create({ text: "邮箱：lin@example.test", scope: { kind: "all" }, sourceConversationId: "c" });
    const removed = await f.store.forget({ id: email.id, expectedVersion: email.version });
    expect(removed.map(e => e.id)).toEqual([email.id]);
    expect((await f.turn("帮我填邮箱", A)).prompt).not.toContain("lin@example.test");

    const back = await f.store.unforget(removed);
    expect(back.map(e => [e.id, e.text, e.status])).toEqual([[email.id, "邮箱：lin@example.test", "active"]]);
    expect((await f.turn("帮我填邮箱", A)).prompt).toContain("lin@example.test");
    // 同一份快照不能恢复第二次（会出现两个生效值）。
    await expect(f.store.unforget(removed)).rejects.toThrow();
  });

  it("过往任务忘掉后不带，撤销后又带", async () => {
    const f = await fixture();
    const t = task();
    await f.history.record(t);
    await f.history.forget(t.id);
    expect((await f.turn("帮我看看这页", A)).prompt).not.toContain("TASK-777");
    await f.history.record(t);
    expect((await f.turn("帮我看看这页", A)).prompt).toContain("TASK-777");
  });
});

describe("传输", () => {
  it("接受「这里别用」「撤销忘掉」两种请求，拒绝坏网址", () => {
    const site = { type: "memory_site", requestId: "r", id: "m-1", expectedVersion: 1, hostname: "shop-a.test", off: true };
    expect(parseClientMessage(JSON.stringify(site))).toEqual(site);
    expect(parseClientMessage(JSON.stringify({ ...site, hostname: "https://shop-a.test/x" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...site, off: "yes" }))).toBeNull();
    const taskSite = { type: "task_history_site", requestId: "r", id: "run-1", hostname: "shop-a.test", off: false };
    expect(parseClientMessage(JSON.stringify(taskSite))).toEqual(taskSite);
    const restore = { type: "task_history_restore", requestId: "r", task: task() };
    expect(parseClientMessage(JSON.stringify(restore))).toEqual(restore);
    expect(parseClientMessage(JSON.stringify({ ...restore, task: { id: "x" } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "memory_unforget", requestId: "r", entries: [] }))).toBeNull();
  });

  it("「用了」事件可带过往任务与网站；坏的任务条目被拒", () => {
    const event = { kind: "memory", action: "used", entries: [], tasks: [task()], hostname: "shop-a.test" };
    expect(parseServerMessage(JSON.stringify({ type: "agent_event", event }))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "agent_event", event: { ...event, tasks: [{ id: "x" }] } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "agent_event", event: { ...event, hostname: "a b" } }))).toBeNull();
  });
});
