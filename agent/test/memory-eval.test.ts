/** 独立校验合同：实现者不得放宽断言；见 docs/evals/20260908-cross-session-memory.md。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../src/memory-store.js";

const roots: string[] = [];
const all = { kind: "all" } as const;
const site = { kind: "site", hostname: "research.example" } as const;
const query = { text: "整理会议摘要：讨论搜索改版与下周成本确认。", url: "https://research.example/notes" };
const seed = { text: "会议摘要请用三条要点。", scope: all, sourceConversationId: "eval-conversation-a" };
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "sideagent-memory-eval-"));
  roots.push(dir);
  return { dir, store: new MemoryStore(dir) };
}
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe("independent cross-session memory contract", () => {
  it("persists accurate content, scope, source and version for a different store instance", async () => {
    const { dir, store } = await fixture();
    const saved = await store.create(seed);
    expect(saved).toMatchObject(seed);
    expect(saved.id).toEqual(expect.any(String));
    expect(saved.id.length).toBeGreaterThan(0);
    expect(Number.isInteger(saved.version) && saved.version > 0).toBe(true);
    expect(Number.isFinite(saved.createdAt) && Number.isFinite(saved.updatedAt)).toBe(true);
    expect(await new MemoryStore(dir).list()).toEqual([saved]);
    expect(await new MemoryStore(dir).select(query)).toEqual([saved]);
  });

  it("keeps management global while site scope restricts relevant retrieval to the exact hostname", async () => {
    const { store } = await fixture();
    const saved = await store.create({ ...seed, scope: site });
    expect(await store.list()).toEqual([saved]);
    for (const url of ["https://research.example/elsewhere", "http://research.example:8080/notes"]) {
      expect(await store.select({ ...query, url })).toEqual([saved]);
    }
    for (const url of [undefined, "https://travel.example", "https://sub.research.example", "https://research.example.evil.test", "https://research-example"]) {
      expect(await store.select({ ...query, url })).toEqual([]);
    }
    expect(await store.select({ ...query, text: "比较雨伞和雨衣，准备出行清单。" })).toEqual([]);
  });

  it("selects all-conversation memory across sites and without a page only for relevant tasks", async () => {
    const { store } = await fixture();
    const saved = await store.create(seed);
    expect(await store.select({ ...query, url: "https://travel.example" })).toEqual([saved]);
    expect(await store.select({ text: query.text })).toEqual([saved]);
    expect(await store.select({ text: "计算 13 乘以 17。" })).toEqual([]);
  });

  it("does not share another personal/browser store or accept its record ID", async () => {
    const first = await fixture(), second = await fixture();
    const saved = await first.store.create(seed);
    expect(await second.store.list()).toEqual([]);
    expect(await second.store.select(query)).toEqual([]);
    await expect(second.store.update({ id: saved.id, expectedVersion: saved.version, text: "会议摘要请用一段话。", scope: all })).rejects.toThrow();
    await expect(second.store.forget({ id: saved.id, expectedVersion: saved.version })).rejects.toThrow();
    expect(await first.store.list()).toEqual([saved]);
  });

  it("updates by CAS and invalidates an already selected old version before injection", async () => {
    const { dir, store } = await fixture();
    const saved = await store.create(seed);
    const selected = await store.select(query);
    const changed = await new MemoryStore(dir).update({ id: saved.id, expectedVersion: saved.version, text: "会议摘要请用一段话。", scope: all });
    expect(changed.version).toBeGreaterThan(saved.version);
    expect(changed.id).toBe(saved.id);
    expect(changed.sourceConversationId).toBe(saved.sourceConversationId);
    expect(await store.resolveSelected(selected.map(({ id, version }) => ({ id, version })), query)).toEqual([]);
    expect(await store.select(query)).toEqual([changed]);
    await expect(store.update({ id: saved.id, expectedVersion: saved.version, text: seed.text, scope: all })).rejects.toThrow();
    expect(await new MemoryStore(dir).list()).toEqual([changed]);
  });

  it("forget invalidates pending selection and rejects stale updates after reopening", async () => {
    const { dir, store } = await fixture();
    const saved = await store.create(seed);
    const selection = await store.select(query);
    await new MemoryStore(dir).forget({ id: saved.id, expectedVersion: saved.version });
    expect(await store.resolveSelected(selection.map(({ id, version }) => ({ id, version })), query)).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await new MemoryStore(dir).select(query)).toEqual([]);
    await expect(store.update({ id: saved.id, expectedVersion: saved.version, text: "会议摘要请用一段话。", scope: all })).rejects.toThrow();
    expect(await new MemoryStore(dir).list()).toEqual([]);
  });

  it("rechecks the current page scope when resolving an otherwise valid selection", async () => {
    const { store } = await fixture();
    const saved = await store.create({ ...seed, scope: site });
    expect(await store.resolveSelected([{ id: saved.id, version: saved.version }], { ...query, url: "https://travel.example" })).toEqual([]);
    expect(await store.resolveSelected([{ id: saved.id, version: saved.version }], query)).toEqual([saved]);
  });

  it("retains every acknowledged concurrent create across two instances of one directory", async () => {
    const { dir, store } = await fixture();
    const other = new MemoryStore(dir);
    const saved = await Promise.all(Array.from({ length: 20 }, (_, n) => (n % 2 ? other : store).create({ ...seed, text: `会议摘要偏好 ${n}：采用三条要点。`, sourceConversationId: `eval-${n}` })));
    const read = await new MemoryStore(dir).list();
    expect(new Set(saved.map((entry) => entry.id)).size).toBe(20);
    expect(read.map((entry) => entry.id).sort()).toEqual(saved.map((entry) => entry.id).sort());
    expect(read).toEqual(expect.arrayContaining(saved));
  });

  it("allows only one update to commit against the same version", async () => {
    const { dir, store } = await fixture();
    const saved = await store.create(seed);
    const settled = await Promise.allSettled([store, new MemoryStore(dir)].map((instance, n) => instance.update({ id: saved.id, expectedVersion: saved.version, text: `会议摘要请用${n ? "一段话" : "两条要点"}。`, scope: all })));
    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
    const committed = settled.find((result) => result.status === "fulfilled");
    if (committed?.status !== "fulfilled") throw new Error("missing committed update");
    expect(await new MemoryStore(dir).list()).toEqual([committed.value]);
  });

  it("rejects malformed writes without changing acknowledged data", async () => {
    const { store } = await fixture();
    const saved = await store.create(seed);
    for (const invalid of [{ ...seed, text: "   " }, { ...seed, text: 42 }, { ...seed, scope: { kind: "site", hostname: "" } }, { ...seed, scope: { kind: "unknown" } }, { ...seed, sourceConversationId: 42 }]) {
      await expect(store.create(invalid as never)).rejects.toThrow();
    }
    await expect(store.update({ id: saved.id, expectedVersion: "1", text: seed.text, scope: all } as never)).rejects.toThrow();
    await expect(store.forget({ id: saved.id, expectedVersion: -1 })).rejects.toThrow();
    expect(await store.list()).toEqual([saved]);
  });

  it("reports an unusable storage path as failure instead of acknowledging a save", async () => {
    const { dir } = await fixture();
    const blocked = join(dir, "file-not-directory");
    await writeFile(blocked, "fixture");
    await expect(Promise.resolve().then(() => new MemoryStore(blocked).create(seed))).rejects.toThrow();
  });
});
