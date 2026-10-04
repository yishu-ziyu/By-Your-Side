/**
 * 记忆加固（docs/evals/20261001-memory-hardening.md H2、H4 服务端、H6）：同一件事一个编号、写入前检查、整份版本号。
 *
 * 可能出错的方式（先列出，再写代码）：
 * 1. 一次写入后同一件事出现两个生效值，仍被落盘。
 * 2. replacedBy 指向不存在的条目、或指向另一件事的条目，仍被落盘。
 * 3. replacedBy 成环，仍被落盘。
 * 4. 写入被拒时原文件已被部分或整份改写。
 * 5. a→b→c 后撤销、删中间一条历史、再撤销、聊天里忘掉：某一步出现两个生效值，或忘掉后有残留。
 * 6. 格式 2 升级：替换链被拆散、同一条链编号不同、不相干的事被并成一件、原字段被改动。
 * 7. 格式 2 的独立条目没有用自己的编号。
 * 8. 升级后第一次写入没写成格式 3，或丢了编号。
 * 9. 未来格式（4）被一次写入整份覆盖，或写入悄悄成功。
 * 10. 版本号不随每次写入加 1、不落盘、或面板的回执里没有。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "./fixtures/file-document.js";
import { ConversationManager } from "../src/conversation-manager.js";
import type { MemoryDecision } from "../src/memory-decision.js";
import type { MemoryEntry } from "../../shared/memory.js";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

const all = { kind: "all" } as const;

const T = Date.UTC(2026, 8, 25, 8, 0, 0);

async function dir() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-memory-hardening-")); roots.push(root);

  return root;
}

const storeAt = (root: string) => new MemoryStore(new FileDocument(root, MEMORY_STORE_FILE));

const fileText = (root: string) => readFile(join(root, MEMORY_STORE_FILE), "utf8");

/** 格式 2 的条目，字段按 HEAD（74e5d18）shared/memory.ts 手写。 */
function v2(o: { id: string; text: string; createdAt: number; status?: string; replacedBy?: string; kind?: string; version?: number; extra?: Partial<Pick<MemoryEntry, "experience" | "date" | "validity">> }) {
  return {
    id: o.id, version: o.version ?? 1, text: o.text, scope: { kind: "all" }, sourceConversationId: "conv-a",
    createdAt: o.createdAt, updatedAt: o.createdAt, kind: o.kind ?? "profile", sourceQuote: o.text,
    useCount: 0, status: o.status ?? "active", formatVersion: 2, ...o.extra,
    // 缺省时为 undefined，JSON 里不出现，和真实文件一致。
    replacedBy: o.replacedBy,
  };
}

/** 格式 3 的条目（带 factId）。 */
function v3(o: { id: string; factId: string; createdAt?: number; status?: string; replacedBy?: string }) {
  return {
    id: o.id, factId: o.factId, version: 1, text: `记忆 ${o.id}`, scope: { kind: "all" }, sourceConversationId: "conv-a",
    createdAt: o.createdAt ?? T, updatedAt: o.createdAt ?? T, kind: "profile", useCount: 0, status: o.status ?? "active", formatVersion: 3,
    replacedBy: o.replacedBy,
  };
}

const doc3 = (entries: unknown[], rev = 5) => JSON.stringify({ format: 3, rev, entries, forgottenExperiences: [] }) + "\n";

const said = (text: string) => text;

async function replace(store: MemoryStore, target: MemoryEntry, email: string): Promise<MemoryEntry> {
  const quote = said(`我的邮箱改成 ${email} 了`);
  const d: MemoryDecision = { action: "update", text: `用户的邮箱是 ${email}`, evidence: quote, scope: all, targets: [{ id: target.id, version: target.version }], taskRequested: false, about: { longTerm: true, date: null, onlyThisTask: false, explicitRequest: false, dateIsTheTask: false } };

  return (await store.applyDecision(d, quote, "conv-a", () => true))[0]!;
}

/** 每件事至多一个生效值；按 factId 分组，同时按「邮箱」文字分组做独立核对。 */
async function assertOneActivePerFact(store: MemoryStore) {
  const entries = await store.list();

  for (const e of entries) expect(e.factId).toEqual(expect.any(String));
  const active = entries.filter(e => e.status === "active");
  expect(new Set(active.map(e => e.factId)).size).toBe(active.length);
  expect(active.filter(e => e.text.includes("邮箱")).length).toBeLessThanOrEqual(1);
}

describe("invariants are checked before every write", () => {
  const violations: Array<[string, unknown[]]> = [
    ["two active values for one fact", [v3({ id: "a", factId: "f" }), v3({ id: "b", factId: "f" })]],
    ["replacedBy points to a missing entry", [v3({ id: "a", factId: "f", status: "replaced", replacedBy: "gone" })]],
    ["replacedBy points to another fact", [v3({ id: "a", factId: "f", status: "replaced", replacedBy: "b" }), v3({ id: "b", factId: "g" })]],
    ["replacedBy forms a cycle", [v3({ id: "a", factId: "f", status: "replaced", replacedBy: "b" }), v3({ id: "b", factId: "f", status: "replaced", replacedBy: "a" })]],
  ];

  for (const [name, entries] of violations) {
    it(`rejects a write when ${name} and leaves the file byte-for-byte unchanged`, async () => {
      const root = await dir();
      const before = doc3(entries);
      await writeFile(join(root, MEMORY_STORE_FILE), before);
      await expect(storeAt(root).create({ text: "摘要用三条要点", scope: all, sourceConversationId: "conv-a" })).rejects.toThrow(/invariant/i);
      expect(await fileText(root)).toBe(before);
    });
  }

  it("accepts a write on a consistent format-3 document (control)", async () => {
    const root = await dir();
    await writeFile(join(root, MEMORY_STORE_FILE), doc3([v3({ id: "a", factId: "a", status: "replaced", replacedBy: "b" }), v3({ id: "b", factId: "a" })]));
    const created = await storeAt(root).create({ text: "摘要用三条要点", scope: all, sourceConversationId: "conv-a" });
    expect(created.factId).toBe(created.id);
    expect((await storeAt(root).list()).map(e => e.id).sort()).toEqual(["a", "b", created.id].sort());
  });
});

describe("one fact, one active value (H2)", () => {
  it("a→b→c then undo, delete a middle row, undo again, chat forget keeps ≤1 active and finally removes the fact", async () => {
    const store = storeAt(await dir());
    const a = await store.create({ text: "用户的邮箱是 a@example.test", scope: all, sourceConversationId: "conv-a" });
    const b = await replace(store, a, "b@example.test");
    const c = await replace(store, b, "c@example.test");
    const other = await store.create({ text: "摘要用三条要点", scope: all, sourceConversationId: "conv-a" });
    const byId = async (id: string) => (await store.list()).find(e => e.id === id)!;

    // 同一件事所有版本共用一个编号（最早那条的 id）；不相干的事用自己的。
    expect([a, b, c].map(e => e.factId)).toEqual([a.id, a.id, a.id]);
    expect(other.factId).toBe(other.id);
    await assertOneActivePerFact(store);

    await store.restore({ id: a.id, expectedVersion: (await byId(a.id)).version });
    await assertOneActivePerFact(store);
    expect((await byId(a.id)).status).toBe("active");

    await store.forget({ id: b.id, expectedVersion: (await byId(b.id)).version });
    await assertOneActivePerFact(store);

    await store.restore({ id: c.id, expectedVersion: (await byId(c.id)).version });
    await assertOneActivePerFact(store);
    expect((await byId(c.id)).status).toBe("active");

    const quote = "忘掉我的邮箱";
    const current = await byId(c.id);
    await store.applyDecision({ action: "forget", text: "", evidence: quote, scope: all, targets: [{ id: current.id, version: current.version }], taskRequested: false }, quote, "conv-a", () => true);
    await assertOneActivePerFact(store);
    expect((await store.list()).map(e => e.id)).toEqual([other.id]);
  });
});

describe("format 2 → 3 migration (H6)", () => {
  // 资料：邮箱链 a→b→c；撤销过的电话（较早的 p 恢复生效，较新的 q 失效并指向 p）；独立的名字。
  // 过往做法一条（带纠正证据）；做过的事一条（带日子和有效期）。
  const ENTRIES = [
    v2({ id: "fmt2-email-a", text: "用户的邮箱是 a@example.test", createdAt: T, status: "replaced", replacedBy: "fmt2-email-b", version: 2 }),
    v2({ id: "fmt2-email-b", text: "用户的邮箱是 b@example.test", createdAt: T + 1000, status: "replaced", replacedBy: "fmt2-email-c", version: 2 }),
    v2({ id: "fmt2-email-c", text: "用户的邮箱是 c@example.test", createdAt: T + 2000 }),
    v2({ id: "fmt2-phone-q", text: "手机：13900002222", createdAt: T + 4000, status: "invalid", replacedBy: "fmt2-phone-p", version: 2 }),
    v2({ id: "fmt2-phone-p", text: "手机：13800001111", createdAt: T + 3000, version: 3 }),
    v2({ id: "fmt2-name", text: "名字：马浩轩", createdAt: T + 5000 }),
    v2({ id: "fmt2-exp", text: "下单前先勾选发票", createdAt: T + 6000, kind: "method", extra: { experience: { runId: "run-exp-1", evidence: ["feedback-1：要先勾发票"], topic: "下单 发票" } } }),
    v2({ id: "fmt2-trip", text: "10 月 3 日去杭州", createdAt: T + 7000, kind: "past", extra: { date: "2026-10-03", validity: { end: T + 30 * 86_400_000 } } }),
  ];

  const FILE = JSON.stringify({ format: 2, entries: ENTRIES, forgottenExperiences: ["run-forgotten-9"] }) + "\n";

  const EXPECTED_FACT = {
    "fmt2-email-a": "fmt2-email-a", "fmt2-email-b": "fmt2-email-a", "fmt2-email-c": "fmt2-email-a",
    "fmt2-phone-q": "fmt2-phone-p", "fmt2-phone-p": "fmt2-phone-p",
    "fmt2-name": "fmt2-name", "fmt2-exp": "fmt2-exp", "fmt2-trip": "fmt2-trip",
  };

  const expectedFact = new Map(Object.entries(EXPECTED_FACT));

  it("reads every entry unchanged, keeps replacement links and gives each chain one shared factId", async () => {
    const root = await dir();
    await writeFile(join(root, MEMORY_STORE_FILE), FILE);
    const listed = await storeAt(root).list();
    expect(listed.map(e => e.id).sort()).toEqual(ENTRIES.map(e => e.id).sort());

    for (const old of ENTRIES) {
      const now = listed.find(e => e.id === old.id)!;
      // 按文件里实际存的字段比（undefined 不落盘）。
      const { formatVersion: _old, ...rest } = JSON.parse(JSON.stringify(old));
      expect(now).toMatchObject(rest);
      expect(now.replacedBy).toBe(old.replacedBy);
      expect(now.factId).toBe(expectedFact.get(old.id));
    }
  });

  it("writes format 3 with factIds on the first write and keeps the forgotten-correction list", async () => {
    const root = await dir();
    await writeFile(join(root, MEMORY_STORE_FILE), FILE);
    const store = storeAt(root);
    const name = (await store.list()).find(e => e.id === "fmt2-name")!;
    await store.update({ id: name.id, expectedVersion: name.version, text: "名字：马浩轩（Yishu）", scope: all });
    const file = JSON.parse(await fileText(root));
    expect(file.format).toBe(3);
    expect(file.rev).toBe(1);
    expect(Object.fromEntries(file.entries.map((e: MemoryEntry) => [e.id, e.factId]))).toEqual(EXPECTED_FACT);
    expect(file.entries.every((e: MemoryEntry) => e.formatVersion === 3)).toBe(true);
    expect(file.forgottenExperiences).toEqual(["run-forgotten-9"]);
    // 升级后的链照常可用：恢复最早的邮箱，仍只有一个生效值。
    const a = (await store.list()).find(e => e.id === "fmt2-email-a")!;
    await store.restore({ id: a.id, expectedVersion: a.version });
    await assertOneActivePerFact(store);
  });
});

describe("migration repairs old data that already breaks the rules", () => {
  // 每种坏数据各一份格式 2 文件；期望值按修复规则手算。
  const cases: Array<{ name: string; entries: ReturnType<typeof v2>[]; expected: Array<[string, string, string, string | undefined]> }> = [
    {
      // d1 指向已不存在的条目：去掉链接，d1 改为失效（不把旧值重新带给助手）；d0 仍被 d1 替换。
      name: "a link to a missing entry",
      entries: [
        v2({ id: "d0", text: "用户的邮箱是 a@example.test", createdAt: T, status: "replaced", replacedBy: "d1" }),
        v2({ id: "d1", text: "用户的邮箱是 b@example.test", createdAt: T + 1000, status: "replaced", replacedBy: "gone" }),
      ],
      expected: [["d0", "d0", "replaced", "d1"], ["d1", "d0", "invalid", undefined]],
    },
    {
      // c1 ↔ c2 成环：在最早的 c1 处断开，c1 改为失效；c2 仍被 c1 替换；都不生效。
      name: "a replacement cycle",
      entries: [
        v2({ id: "c1", text: "用户的邮箱是 a@example.test", createdAt: T, status: "replaced", replacedBy: "c2" }),
        v2({ id: "c2", text: "用户的邮箱是 b@example.test", createdAt: T + 1000, status: "replaced", replacedBy: "c1" }),
      ],
      expected: [["c1", "c1", "invalid", undefined], ["c2", "c1", "replaced", "c1"]],
    },
    {
      // a1→a2，a3→a1：一件事两个生效值 a2、a3 → 留最近修改的 a3，a2 改为被 a3 替换。
      name: "two active values for one fact",
      entries: [
        v2({ id: "a1", text: "用户的邮箱是 a@example.test", createdAt: T, status: "replaced", replacedBy: "a2" }),
        v2({ id: "a2", text: "用户的邮箱是 b@example.test", createdAt: T + 1000 }),
        { ...v2({ id: "a3", text: "用户的邮箱是 c@example.test", createdAt: T + 2000, replacedBy: "a1" }), updatedAt: T + 9000 },
      ],
      expected: [["a1", "a1", "replaced", "a2"], ["a2", "a1", "replaced", "a3"], ["a3", "a1", "active", undefined]],
    },
  ];

  for (const { name, entries, expected } of cases) {
    it(`repairs ${name} on read, keeps every entry, and later writes succeed`, async () => {
      const root = await dir();
      const other = v2({ id: "plain", text: "摘要用三条要点", createdAt: T + 5000 });
      await writeFile(join(root, MEMORY_STORE_FILE), JSON.stringify({ format: 2, entries: [...entries, other] }) + "\n");
      const store = storeAt(root);
      const listed = await store.list();
      expect(listed.map(e => e.id).sort()).toEqual([...entries.map(e => e.id), "plain"].sort());
      expect(listed.filter(e => e.id !== "plain").map(e => [e.id, e.factId, e.status, e.replacedBy]).sort()).toEqual(expected);

      for (const e of listed) expect(e.text).toBe([...entries, other].find(o => o.id === e.id)!.text);
      await assertOneActivePerFact(store);
      await store.create({ text: "会议用中文", scope: all, sourceConversationId: "conv-a" });
      const active = listed.find(e => e.status === "active" && e.id !== "plain");

      // 有生效值就改它；没有就由用户从历史里恢复最新的一条。
      if (active) await store.update({ id: active.id, expectedVersion: active.version, text: "用户的邮箱是 z@example.test", scope: all });
      else {
        const newest = listed.filter(e => e.id !== "plain").reduce((max, e) => (e.createdAt > max.createdAt ? e : max));

        await store.restore({ id: newest.id, expectedVersion: newest.version });
      }

      expect((await store.list())).toHaveLength(entries.length + 2);
      await assertOneActivePerFact(store);
      expect(JSON.parse(await fileText(root)).format).toBe(3);
    });
  }
});

describe("unknown newer format is read-only", () => {
  it("rejects writes with a clear error and never overwrites the file", async () => {
    const root = await dir();
    const future = JSON.stringify({ format: 4, rev: 9, entries: [{ ...v3({ id: "a", factId: "a" }), formatVersion: 4, futureField: { x: 1 } }, { id: "b", formatVersion: 4, somethingElse: true }], somethingNew: true }) + "\n";
    await writeFile(join(root, MEMORY_STORE_FILE), future);
    const store = storeAt(root);
    await expect(store.create({ text: "摘要用三条要点", scope: all, sourceConversationId: "conv-a" })).rejects.toThrow(/newer|read-only/i);
    await expect(store.forget({ id: "a", expectedVersion: 1 })).rejects.toThrow(/newer|read-only/i);
    expect(await fileText(root)).toBe(future);
    // 能显示的条目照常列出（面板需要的字段齐全）；字段不全的跳过。
    expect((await store.list()).map(e => [e.id, e.text, e.status])).toEqual([["a", "记忆 a", "active"]]);
    expect(await fileText(root)).toBe(future);
  });
});

describe("document revision", () => {
  it("starts at 0, increments on every successful write, persists, and is unchanged by a rejected write", async () => {
    const root = await dir();
    const store = storeAt(root);
    expect(await store.currentRev()).toBe(0);
    const a = await store.create({ text: "用户的邮箱是 a@example.test", scope: all, sourceConversationId: "conv-a" });
    expect(await store.currentRev()).toBe(1);
    const updated = await store.update({ id: a.id, expectedVersion: a.version, text: "用户的邮箱是 a2@example.test", scope: all });
    expect(await store.currentRev()).toBe(2);
    await expect(store.update({ id: a.id, expectedVersion: a.version, text: "x", scope: all })).rejects.toThrow(/version conflict/);
    expect(await store.currentRev()).toBe(2);
    await store.forget({ id: updated.id, expectedVersion: updated.version });
    expect(await storeAt(root).currentRev()).toBe(3);
    expect(JSON.parse(await fileText(root)).rev).toBe(3);
  });

  it("returns rev on every memory_result from the panel handlers", async () => {
    const root = await dir();
    const memoryStore = storeAt(root);
    const emitted: ServerMessage[] = [];

    const runtime = {
      session: { modelName: () => "test/model", availableModels: async () => [], abort: vi.fn(), isHeld: () => false, isStreaming: () => false },
      control: { teamView: () => null, list: () => [], isGroupHeld: () => false, abortTeam: vi.fn() },
      rpc: { rejectAll: vi.fn() },
      handleMessage: vi.fn((_message: ClientMessage) => {}),
      dispose: vi.fn(),
    };

    // SAFETY: 只走记忆请求，这些处理不碰会话运行时；与 memory-manager.test.ts 的桩相同。
    const manager = new ConversationManager(async () => runtime as any, (message) => emitted.push(message), undefined, memoryStore);
    await manager.ensureDefault();
    const a = await memoryStore.create({ text: "用户的邮箱是 a@example.test", scope: all, sourceConversationId: "default" });
    const b = await replace(memoryStore, a, "b@example.test");
    const last = () => emitted.at(-1);

    await manager.handleMessage({ type: "memory_list", conversationId: "default", requestId: "l" });
    expect(last()).toMatchObject({ action: "list", ok: true, rev: 2 });
    await manager.handleMessage({ type: "memory_update", conversationId: "default", requestId: "u", id: b.id, expectedVersion: b.version, text: "用户的邮箱是 b2@example.test", scope: all });
    expect(last()).toMatchObject({ action: "update", ok: true, rev: 3 });
    const aNow = (await memoryStore.list()).find(e => e.id === a.id)!;
    await manager.handleMessage({ type: "memory_restore", conversationId: "default", requestId: "r", id: a.id, expectedVersion: aNow.version });
    expect(last()).toMatchObject({ action: "restore", ok: true, rev: 4 });
    await manager.handleMessage({ type: "memory_forget", conversationId: "default", requestId: "stale", id: a.id, expectedVersion: aNow.version });
    expect(last()).toMatchObject({ action: "forget", ok: false, rev: 4 });
    await manager.handleMessage({ type: "memory_forget", conversationId: "default", requestId: "f", id: a.id, expectedVersion: aNow.version + 1 });
    expect(last()).toMatchObject({ action: "forget", ok: true, rev: 5 });
  });
});
