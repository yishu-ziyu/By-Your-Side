/** 同一事实的历史链：撤销（恢复）只留一个生效值；忘记整条事实不留可恢复的旧值。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { FileDocument } from "../src/document-file.js";
import type { MemoryDecision } from "../src/memory-decision.js";
import type { MemoryEntry } from "../../shared/memory.js";

const roots: string[] = [];

const all = { kind: "all" } as const;

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-memory-history-")); roots.push(root);

  return new MemoryStore(new FileDocument(root, MEMORY_STORE_FILE));
}

const ok = () => true;

async function replace(store: MemoryStore, target: MemoryEntry, email: string): Promise<MemoryEntry> {
  const said = `我的邮箱改成 ${email} 了`;
  const d: MemoryDecision = { action: "update", text: `用户的邮箱是 ${email}`, evidence: said, scope: all, targets: [{ id: target.id, version: target.version }], taskRequested: false };

  return (await store.applyDecision(d, said, "conv-a", ok))[0]!;
}

/** a → b → c：用户先后说了三个邮箱。 */
async function chain(store: MemoryStore) {
  const a = await store.create({ text: "用户的邮箱是 a@example.test", scope: all, sourceConversationId: "conv-a" });
  const b = await replace(store, a, "b@example.test");
  const c = await replace(store, b, "c@example.test");
  const other = await store.create({ text: "摘要用三条要点", scope: all, sourceConversationId: "conv-a" });

  return { a, b, c, other };
}

const byId = async (store: MemoryStore, id: string) => (await store.list()).find(e => e.id === id);

const activeEmails = async (store: MemoryStore) => (await store.list()).filter(e => e.status === "active" && e.text.includes("邮箱")).map(e => e.text);

describe("memory history chain", () => {
  it("restoring the oldest value of a chain leaves it as the only active value", async () => {
    const store = await fixture();
    const { a } = await chain(store);
    const current = (await byId(store, a.id))!;
    expect(current.status).toBe("replaced");
    await store.restore({ id: a.id, expectedVersion: current.version });
    expect(await activeEmails(store)).toEqual(["用户的邮箱是 a@example.test"]);
    expect((await store.list()).filter(e => e.text.includes("邮箱"))).toHaveLength(3);
  });

  it("an undone (invalid) value can be restored, making the undo two-way", async () => {
    const store = await fixture();
    const { a, c } = await chain(store);
    await store.restore({ id: a.id, expectedVersion: (await byId(store, a.id))!.version });
    const undone = (await byId(store, c.id))!;
    expect(undone.status).toBe("invalid");
    await store.restore({ id: c.id, expectedVersion: undone.version });
    expect(await activeEmails(store)).toEqual(["用户的邮箱是 c@example.test"]);
    expect((await byId(store, a.id))!.status).toBe("invalid");
    // 再撤回去一次仍然只有一个生效值。
    await store.restore({ id: a.id, expectedVersion: (await byId(store, a.id))!.version });
    expect(await activeEmails(store)).toEqual(["用户的邮箱是 a@example.test"]);
  });

  it("restoring the middle value after an earlier undo still leaves one active value", async () => {
    const store = await fixture();
    const { a, b } = await chain(store);
    await store.restore({ id: a.id, expectedVersion: (await byId(store, a.id))!.version });
    await store.restore({ id: b.id, expectedVersion: (await byId(store, b.id))!.version });
    expect(await activeEmails(store)).toEqual(["用户的邮箱是 b@example.test"]);
  });

  it("rejects a restore with a stale version and changes nothing", async () => {
    const store = await fixture();
    const { a } = await chain(store);
    const before = await store.list();
    await expect(store.restore({ id: a.id, expectedVersion: a.version })).rejects.toThrow(/version conflict/);
    expect(await store.list()).toEqual(before);
  });

  it("rejects restoring a value that is already active", async () => {
    const store = await fixture();
    const { c } = await chain(store);
    await expect(store.restore({ id: c.id, expectedVersion: c.version })).rejects.toThrow();
  });

  it("panel forget on the active value removes every older version of that fact", async () => {
    const store = await fixture();
    const { c, other } = await chain(store);
    await store.forget({ id: c.id, expectedVersion: c.version });
    expect(await store.list()).toEqual([other]);
  });

  it("panel forget after an undo removes the whole chain, including the undone value", async () => {
    const store = await fixture();
    const { a, other } = await chain(store);
    await store.restore({ id: a.id, expectedVersion: (await byId(store, a.id))!.version });
    const restored = (await byId(store, a.id))!;
    await store.forget({ id: restored.id, expectedVersion: restored.version });
    expect(await store.list()).toEqual([other]);
  });

  it("chat forget removes the whole chain", async () => {
    const store = await fixture();
    const { c, other } = await chain(store);
    const said = "忘掉我的邮箱";
    const d: MemoryDecision = { action: "forget", text: "", evidence: said, scope: all, targets: [{ id: c.id, version: c.version }], taskRequested: false };
    await store.applyDecision(d, said, "conv-a", ok);
    expect(await store.list()).toEqual([other]);
  });

  it("deleting one history row removes only that row and keeps the chain restorable", async () => {
    const store = await fixture();
    const { a, b, c, other } = await chain(store);
    const middle = (await byId(store, b.id))!;
    await store.forget({ id: middle.id, expectedVersion: middle.version });
    const left = await store.list();
    expect(left.map(e => e.id).sort()).toEqual([a.id, c.id, other.id].sort());
    // 删掉中间一条后，恢复最早的值仍只留一个生效值。
    await store.restore({ id: a.id, expectedVersion: (await byId(store, a.id))!.version });
    expect(await activeEmails(store)).toEqual(["用户的邮箱是 a@example.test"]);
    // 之后忘记这条事实仍整条清掉。
    const restored = (await byId(store, a.id))!;
    await store.forget({ id: restored.id, expectedVersion: restored.version });
    expect(await store.list()).toEqual([other]);
  });

  it("rejects a forget with a stale version and changes nothing", async () => {
    const store = await fixture();
    const { a } = await chain(store);
    const before = await store.list();
    await expect(store.forget({ id: a.id, expectedVersion: a.version })).rejects.toThrow(/version conflict/);
    expect(await store.list()).toEqual(before);
  });
});
