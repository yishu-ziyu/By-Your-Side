/**
 * 「要不要记」失败后的补判（验收 20261001-memory-hardening H3/H5，H4 的版本号部分）。
 * 先列会出错的方式，再写实现：
 * 1. 判断请求失败时什么都不留：没有失败记录，这句话从此丢失。
 * 2. 补判成功后又补判一次（再次触发、两处同时触发），同一句话记两条。
 * 3. 判完或放弃后，排队的原话仍留在本机。
 * 4. 用户已经发了新消息（这句作废），失败也排队补判，越过了作废边界。
 * 5. 诊断记录里留着用户原话。
 * 6. 记忆写入后发出的事件不带整份记忆的版本号，面板无法判断手里的列表是否过期。
 * 7. 只在用户发下一条消息时才补判：用户不再说话，这句就永远没记住。
 * 8. 到点补判时这一轮已被停止或接管，仍把用户取消的那句记下。
 * 9. 补判过时：用户之后已改成别的值，补判把它改回旧值。
 * 10. 补判过时：用户之后在对话里或面板上忘掉了这件事，补判又把它记回来。
 * 11. 过时判断误伤：之后没有动记忆的一句话（插话问价格）、「用过」计数也让补判作废。
 * 16. 补判的模型没看出纠正，把旧值再「记下」一次：新旧两个值同时生效。
 * 12. 插话（任务进行中再说一句）把排队的话一并作废。
 * 13. 一轮结束要等补判做完才算结束。
 * 14. 一个对话补判了另一个对话的话，回执出现在错的对话里。
 * 15. 任务正在进行时到点补判，与任务抢用模型；扩展重启后队列里的话没人补判。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "../src/document-file.js";

type MemoryRecordValue = Parameters<NonNullable<MemoryRuntime["onRecord"]>>[1][string];

const roots: string[] = [];

afterEach(async () => { vi.useRealTimers(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

/** 真实读写文件、整套测试并行时会慢：等待上限放宽到 5 秒。 */
const WAIT = { timeout: 5_000 };

const said = "我坐飞机都要靠过道";

const fact = "坐飞机要靠过道的座位";

const saveDecision = JSON.stringify({ action: "save", text: fact, evidence: said, scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: true, onlyThisTask: false, explicitRequest: false, date: null, dateIsTheTask: false } });

async function fixture(seed?: string) {
  const root = await mkdtemp(join(tmpdir(), "sideagent-memory-pending-")); roots.push(root);
  const store = new MemoryStore(new FileDocument(root, MEMORY_STORE_FILE));
  const pendingDoc = new FileDocument(root, "pending-memory.json");

  if (seed) await pendingDoc.write(seed);
  const records: Array<{ type: string; data: Record<string, MemoryRecordValue> }> = [];

  const open = (conversationId: string) => {
    const emit = vi.fn();
    const complete = vi.fn(async (_system: string, _input: string, _signal: AbortSignal) => saveDecision);
    const runtime = new MemoryRuntime(store, conversationId, emit, complete, { auto: true, pending: pendingDoc });
    runtime.onRecord = (type, data) => { records.push({ type, data }); };

    const hooks = new Map<string, (event: { type: string }) => void>();
    // SAFETY: 只截获运行时注册的生命周期处理函数（agent_start / agent_settled）。
    runtime.extension()({ on: (name: string, fn: any) => { hooks.set(name, fn); } } as any);
    const settled = () => hooks.get("agent_settled")!({ type: "agent_settled" });
    const start = () => hooks.get("agent_start")!({ type: "agent_start" });

    return { runtime, emit, complete, settled, start };
  };

  const a = open("conversation-a");
  // SAFETY: 补判队列文档由运行时写成 { items: [...] }；测试只读这几个字段。
  const queued = async () => (JSON.parse((await pendingDoc.read()) ?? "{\"items\":[]}") as { items: Array<{ key: string; text: string; attempts: number }> }).items;
  const decisions = () => records.flatMap(r => (r.type === "memory_decision" ? [r.data] : []));

  return { root, store, pendingDoc, ...a, open, queued, decisions };
}

const about = { longTerm: true, onlyThisTask: false, explicitRequest: false, date: null, dateIsTheTask: false };

const emailA = "我的邮箱是 a@x.com";

/** 按用户原话回答的判断替身：邮箱已有生效值时把 a 判为「更新」（saveAgain 时模拟没看出纠正、仍判「记下」），「忘掉」判为忘记；其余记下。 */
function judge(input: string, saveAgain = false): string {
  // SAFETY: 输入是运行时交给判断的 JSON；只读这两个字段。
  const { userMessage, entries } = JSON.parse(input) as { userMessage: string; entries: Array<{ id: string; version: number; text: string }> };
  const email = entries.find(e => e.text.includes("邮箱"));

  if (userMessage === emailA && email && !saveAgain) return JSON.stringify({ action: "update", text: "邮箱 a@x.com", evidence: "a@x.com", scope: { kind: "all" }, targets: [{ id: email.id, version: email.version }], taskRequested: false, about });

  if (userMessage === emailA) return JSON.stringify({ action: "save", text: "邮箱 a@x.com", evidence: "a@x.com", scope: { kind: "all" }, targets: [], taskRequested: false, about });

  if (userMessage.includes("b@x.com")) return JSON.stringify({ action: "save", text: "邮箱 b@x.com", evidence: "b@x.com", scope: { kind: "all" }, targets: [], taskRequested: false, about });

  if (userMessage === "忘掉我的邮箱") return JSON.stringify({ action: "forget", text: "", evidence: userMessage, scope: { kind: "all" }, targets: email ? [{ id: email.id, version: email.version }] : [], taskRequested: false });

  return saveDecision;
}

const activeTexts = async (store: MemoryStore) => (await store.list()).flatMap(e => (e.status === "active" ? [e.text] : [])).sort();

describe("pending memory judgments", () => {
  it("records a failure without the quote and queues the sentence when the judge errors", async () => {
    const f = await fixture();
    f.complete.mockRejectedValueOnce(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);
    expect(f.decisions()).toContainEqual(expect.objectContaining({ status: "failed", reason: "provider error" }));
    expect((await f.queued())[0]).toMatchObject({ key: expect.stringMatching(/^conversation-a:/), conversationId: "conversation-a", text: said, attempts: 0 });
    expect(await f.store.list()).toEqual([]);
    expect(JSON.stringify(f.decisions())).not.toContain("靠过道");
  });

  it("judges again when the turn ends, saves exactly once, and a second drain does not duplicate", async () => {
    const f = await fixture();
    f.complete.mockRejectedValueOnce(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);
    f.settled(); f.settled();
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    f.settled();
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ action: "saved" })), WAIT);
    const active = (await f.store.list()).filter(e => e.status === "active");
    expect(active.map(e => e.text)).toEqual([fact]);
    expect(await f.queued()).toEqual([]);
    // 补判后原话不再留在补判队列的文档里。
    expect(await f.pendingDoc.read()).not.toContain("靠过道");
    expect(f.complete).toHaveBeenCalledTimes(2);
    expect(f.emit.mock.calls.filter(([e]) => e.action === "saved")).toHaveLength(1);
    expect(JSON.stringify(f.decisions())).not.toContain("靠过道");
    expect(f.decisions()).toContainEqual(expect.objectContaining({ source: "retry", status: "decided", kind: "profile", entryIds: [active[0]!.id] }));
  });

  it("retries after the turn ends on its own, with no further user message", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    f.complete.mockRejectedValueOnce(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(async () => expect((await f.store.list()).map(e => e.text)).toEqual([fact]), WAIT);
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    expect(f.complete).toHaveBeenCalledTimes(2);
  });

  it("does not save a queued sentence after the user stops or takes over", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    f.complete.mockRejectedValueOnce(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);
    f.runtime.invalidateUserTurn();
    // 作废即删原话；之后到点、一轮结束都不再补判。
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    f.settled();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await f.store.list()).toEqual([]);
    expect(await f.queued()).toEqual([]);
    expect(await f.pendingDoc.read()).not.toContain("靠过道");
    expect(f.complete).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry limit and deletes the queued text", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    f.complete.mockRejectedValue(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);

    // 每次补判做完真实读写后才设下一次定时器：等到它出现再拨钟。
    for (let calls = 2; calls <= 4; calls++) {
      await vi.waitFor(async () => { await vi.advanceTimersByTimeAsync(3_600_000); expect(f.complete).toHaveBeenCalledTimes(calls); }, WAIT);
    }

    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(await f.queued()).toEqual([]);
    expect(await f.pendingDoc.read()).not.toContain("靠过道");
    expect(f.complete).toHaveBeenCalledTimes(4); // 第一次判断 + 3 次补判
    expect(f.decisions()).toContainEqual(expect.objectContaining({ source: "retry", status: "gave up" }));
    expect(await f.store.list()).toEqual([]);
  });

  it("does not queue a sentence the user already superseded with a new message", async () => {
    const f = await fixture(); let reject!: (error: Error) => void;
    f.complete.mockImplementationOnce(() => new Promise((_, no) => { reject = no; }));
    f.runtime.beginUserTurn(said);
    await vi.waitFor(() => expect(reject).toBeTypeOf("function"), WAIT);
    f.runtime.beginUserTurn("总结当前网页");
    reject(new Error("aborted"));
    f.settled();
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(await f.queued()).toEqual([]);
    expect(f.decisions().filter(d => d.status === "failed")).toEqual([]);
  });

  it("keeps no quote in a successful decision record", async () => {
    const f = await fixture();
    f.runtime.beginUserTurn(said);
    await vi.waitFor(async () => expect((await f.store.list())).toHaveLength(1), WAIT);
    const [record] = f.decisions();
    expect(record).toMatchObject({ source: "message", status: "decided", kind: "profile", entryIds: [(await f.store.list())[0]!.id] });
    expect(JSON.stringify(record)).not.toContain("靠过道");
    expect(record).not.toHaveProperty("quote");
  });

  it("puts the memory document revision on the saved event", async () => {
    const f = await fixture();
    const before = await f.store.currentRev();
    f.runtime.beginUserTurn(said);
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ action: "saved" })), WAIT);
    const saved = f.emit.mock.calls.map(([e]) => e).find(e => e.action === "saved");
    // 记下这一句正好是一次写入。
    expect(saved.rev).toBe(before + 1);
  });
});

describe("stale retries, interjections and scope", () => {
  /** 第一次判断失败、排进队列。 */
  async function failFirst(f: Awaited<ReturnType<typeof fixture>>, text: string) {
    f.complete.mockImplementation(async (_s, input) => judge(input));
    f.complete.mockRejectedValueOnce(new Error("503 service unavailable"));
    f.runtime.beginUserTurn(text);
    await vi.waitFor(async () => expect(await f.queued()).toHaveLength(1), WAIT);
  }

  it("drops a retry that would change back a value the user corrected afterwards", async () => {
    const f = await fixture();
    await failFirst(f, emailA);
    f.runtime.beginUserTurn("不对，是 b@x.com");
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual(["邮箱 b@x.com"]), WAIT);
    f.settled();
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    expect(f.complete).toHaveBeenCalledTimes(3);
    expect(await activeTexts(f.store)).toEqual(["邮箱 b@x.com"]);
    expect(f.decisions()).toContainEqual(expect.objectContaining({ source: "retry", status: "dropped" }));
  });

  it("drops a retry that would bring back a fact the user forgot in chat afterwards", async () => {
    const f = await fixture();
    await failFirst(f, emailA);
    f.runtime.beginUserTurn("忘掉我的邮箱");
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2), WAIT);
    await new Promise(resolve => setTimeout(resolve, 50));
    f.settled();
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    expect(await f.store.list()).toEqual([]);
  });

  it("drops a retry that would bring back a fact forgotten in the panel afterwards", async () => {
    const f = await fixture();
    const old = await f.store.create({ text: "邮箱 old@x.com", scope: { kind: "all" }, sourceConversationId: "conversation-a" });
    await failFirst(f, emailA);
    await f.store.forget({ id: old.id, expectedVersion: old.version });
    f.settled();
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    expect(await f.store.list()).toEqual([]);
  });

  it("drops a retried plain save of the old value after the user saved a correction", async () => {
    const f = await fixture();
    await failFirst(f, emailA);
    f.complete.mockImplementation(async (_s, input) => judge(input, true));
    f.runtime.beginUserTurn("不对，是 b@x.com");
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual(["邮箱 b@x.com"]), WAIT);
    f.settled();
    await vi.waitFor(async () => expect(await f.queued()).toEqual([]), WAIT);
    expect(f.complete).toHaveBeenCalledTimes(3);
    expect(await activeTexts(f.store)).toEqual(["邮箱 b@x.com"]);
    expect(f.decisions()).toContainEqual(expect.objectContaining({ source: "retry", status: "dropped", action: "save" }));
  });

  it("still saves after a later message that wrote no memory, and after memory was only used", async () => {
    const f = await fixture();
    const other = await f.store.create({ text: "回复用中文", scope: { kind: "all" }, sourceConversationId: "conversation-a" });
    await failFirst(f, said);
    f.runtime.invalidateUserTurn("steer");
    f.runtime.beginUserTurn("顺便看下价格");
    await f.store.markUsed([{ id: other.id, version: other.version }]);
    f.settled();
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual([fact, "回复用中文"].sort()), WAIT);
  });

  it("keeps the queued sentence when the user interjects during the task", async () => {
    const f = await fixture();
    await failFirst(f, said);
    f.runtime.invalidateUserTurn("steer");
    f.settled();
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual([fact]), WAIT);
  });

  it("ends the turn without waiting for the retry", async () => {
    const f = await fixture();
    await failFirst(f, said);
    f.complete.mockImplementation(() => new Promise(() => {}));
    const outcome = await Promise.race([Promise.resolve(f.settled()).then(() => "ended"), new Promise(resolve => setTimeout(() => resolve("waited"), 500))]);
    expect(outcome).toBe("ended");
    await vi.waitFor(() => expect(f.complete).toHaveBeenCalledTimes(2), WAIT);
  });

  it("retries only in its own conversation, so the receipt lands in the right chat", async () => {
    const f = await fixture();
    await failFirst(f, said);
    const b = f.open("conversation-b");
    b.settled();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(b.complete).not.toHaveBeenCalled();
    expect(await f.queued()).toHaveLength(1);
    f.settled();
    await vi.waitFor(() => expect(f.emit).toHaveBeenCalledWith(expect.objectContaining({ action: "saved" })), WAIT);
    expect(b.emit).not.toHaveBeenCalled();
  });

  it("does not retry on the timer while its conversation is running; retries at the turn end", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const f = await fixture();
    f.start();
    await failFirst(f, said);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(f.complete).toHaveBeenCalledTimes(1);
    f.settled();
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual([fact]), WAIT);
  });

  it("retries what was left in the persisted queue when the runtime starts", async () => {
    const item = { key: "conversation-a:m1", conversationId: "conversation-a", text: said, hostname: null, at: Date.now() - 1000, attempts: 0, nextAt: 0, facts: [] };
    const f = await fixture(JSON.stringify({ items: [item], done: [] }));
    await vi.waitFor(async () => expect(await activeTexts(f.store)).toEqual([fact]), WAIT);
    expect(await f.queued()).toEqual([]);
  });
});
