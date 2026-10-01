/**
 * 记忆底座（docs/evals/20261001-memory-foundation.md 完成标准 2）：升级前的真实旧格式数据自动转换且不丢。
 *
 * 样本按升级前（0c7152b）shared/memory.ts 与 shared/task-history.ts 的格式逐字段手写：
 * 资料 5 条（其中 1 条网站范围、1 条来自纠正的做法、1 条被用户改过 version 2），过往任务 3 条（1 条缺 page）。
 *
 * 可能出错的方式（先列出，再写转换代码）：
 * 1. 旧文件（format 1）被当成损坏，整份记忆读不出来。
 * 2. 转换改动了原有字段：id、version、text、scope、来源会话、创建/修改时间、纠正证据。
 * 3. 种类推断错：普通资料没成「关于你」，纠正做法没成「做事的方法」。
 * 4. 默认值错：状态不是「生效」或带上了有效期，导致旧记忆不再带给助手。
 * 5. 转换后第一次写入丢条目、丢「已忘记的纠正」清单（被忘记的做法会被后台任务重新写回）。
 * 6. 旧过往任务被丢弃，或不能再查、不能再删。
 * 7. 真损坏的数据被悄悄吞掉（应仍报损坏，不当作空记忆覆盖）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEMORY_STORE_FILE, MemoryStore } from "../src/memory-store.js";
import { TASK_HISTORY_FILE, TaskHistoryStore } from "../src/task-history.js";
import { FileDocument } from "../src/document-file.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const T = Date.UTC(2026, 8, 20, 8, 0, 0);

const OLD_ENTRIES = [
  { id: "m-email", version: 1, text: "邮箱：yishu.test@gmail.com", scope: { kind: "all" }, sourceConversationId: "conv-a", createdAt: T, updatedAt: T },
  { id: "m-name", version: 2, text: "名字：马浩轩", scope: { kind: "all" }, sourceConversationId: "conv-a", createdAt: T, updatedAt: T + 60_000 },
  { id: "m-phone", version: 1, text: "手机：13800001111", scope: { kind: "all" }, sourceConversationId: "conv-b", createdAt: T + 1000, updatedAt: T + 1000 },
  { id: "m-crm", version: 1, text: "导出报表时选「全部」", scope: { kind: "site", hostname: "crm.example.com" }, sourceConversationId: "conv-b", createdAt: T + 2000, updatedAt: T + 2000 },
  { id: "m-exp", version: 1, text: "在 shop.example.com 下单前先勾选发票", scope: { kind: "site", hostname: "shop.example.com" }, sourceConversationId: "conv-c", createdAt: T + 3000, updatedAt: T + 3000,
    experience: { runId: "run-exp-1", evidence: ["feedback-1：要先勾发票", "observation-2：发票选项在结算页"], topic: "下单 发票" } },
];

const OLD_MEMORY_FILE = JSON.stringify({ format: 1, entries: OLD_ENTRIES, forgottenExperiences: ["run-forgotten-9"] }) + "\n";

const OLD_TASKS = [
  { id: "run-1", conversationId: "conv-a", goal: "订阅 Marianne 的邮件", page: "Marianne Beaulieu — Official Site", revisions: [], hosts: ["news.marianne.test"], outcome: "complete", summary: "已订阅并确认。", unfinished: [], startedAt: T, endedAt: T + 5000 },
  { id: "run-2", conversationId: "conv-b", goal: "把报表导出成 CSV", revisions: ["只要九月的"], hosts: ["crm.example.com"], outcome: "partial", summary: "导出了一半。", unfinished: ["下载九月的报表"], startedAt: null, endedAt: T + 6000 },
  { id: "run-3", conversationId: "conv-c", goal: "填报销单", revisions: [], hosts: [], outcome: "stopped", summary: "", unfinished: [], startedAt: T, endedAt: T + 7000 },
];

const OLD_TASK_FILE = JSON.stringify({ format: 1, tasks: OLD_TASKS }) + "\n";

async function oldData() {
  const dir = await mkdtemp(join(tmpdir(), "sideagent-memory-migration-"));
  roots.push(dir);
  await writeFile(join(dir, MEMORY_STORE_FILE), OLD_MEMORY_FILE);
  await writeFile(join(dir, TASK_HISTORY_FILE), OLD_TASK_FILE);

  return { dir, memory: new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)), tasks: new TaskHistoryStore(new FileDocument(dir, TASK_HISTORY_FILE)) };
}

describe("memory foundation: old-format data converts without loss", () => {
  it("reads every old entry with its original fields and fills the documented defaults", async () => {
    const { memory } = await oldData();
    const listed = await memory.list();
    expect(listed.map(e => e.id).sort()).toEqual(OLD_ENTRIES.map(e => e.id).sort());

    for (const old of OLD_ENTRIES) {
      const now = listed.find(e => e.id === old.id)!;
      expect(now).toMatchObject(old);
      expect(now.status).toBe("active");
      expect(now.validity).toBeUndefined();
      expect(now.useCount).toBe(0);
      expect(now.formatVersion).toBe(3);
      expect(now.factId).toBe(old.id);
    }

    expect(listed.find(e => e.id === "m-exp")!.kind).toBe("method");

    for (const id of ["m-email", "m-name", "m-phone", "m-crm"]) expect(listed.find(e => e.id === id)!.kind).toBe("profile");
  });

  it("keeps every entry and the forgotten-correction list across the first write", async () => {
    const { dir, memory } = await oldData();
    await memory.forget({ id: "m-phone", expectedVersion: 1 });
    const file = JSON.parse(await readFile(join(dir, MEMORY_STORE_FILE), "utf8"));
    expect(file.format).toBe(3);
    expect(file.entries.map((e: { id: string }) => e.id).sort()).toEqual(["m-crm", "m-email", "m-exp", "m-name"]);
    expect(file.forgottenExperiences).toEqual(["run-forgotten-9"]);
    // 被忘记的纠正不会被后台重新写回。
    expect(await new MemoryStore(new FileDocument(dir, MEMORY_STORE_FILE)).createExperience({ runId: "run-forgotten-9", text: "x", scope: { kind: "all" }, sourceConversationId: "conv-z", evidence: ["e"] })).toBeNull();
  });

  it("still reports a genuinely corrupt store instead of treating it as empty", async () => {
    const { dir, memory } = await oldData();
    await writeFile(join(dir, MEMORY_STORE_FILE), JSON.stringify({ format: 1, entries: [{ ...OLD_ENTRIES[0], text: "" }] }));
    await expect(memory.list()).rejects.toThrow(/corrupt/);
  });

  it("keeps old past tasks readable, searchable and deletable", async () => {
    const { tasks } = await oldData();
    const listed = await tasks.list();
    expect(listed.map(t => t.id)).toEqual(["run-3", "run-2", "run-1"]);
    expect(listed.find(t => t.id === "run-1")).toMatchObject(OLD_TASKS[0]!);
    expect((await tasks.search({ hostname: "crm.example.com" })).map(t => t.id)).toEqual(["run-2"]);
    expect((await tasks.forget("run-2")).map(t => t.id).sort()).toEqual(["run-1", "run-3"]);
  });
});
