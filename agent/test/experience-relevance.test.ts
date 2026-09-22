import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryRuntime } from "../src/memory-runtime.js";
import { isRelevantExperience, isRelevantMemory } from "../src/memory-relevance.js";
import { MemoryStore } from "../src/memory-store.js";

const roots: string[] = [];

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function store() {
  const root = await mkdtemp(join(tmpdir(), "sideagent-experience-relevance-"));
  roots.push(root);

  return new MemoryStore(root);
}

const customerProcedure = "待验证的做法：导出客户名单\n下次参考：进入客户管理，按客户手机号去重，并核对客户总数。";

const site = { kind: "site", hostname: "crm.example" } as const;

describe("procedure matching rule", () => {
  it("requires a shared task object, not only a shared action word", () => {
    const crossObject = [
      ["导出客户名单", "导出本月库存报表"],
      ["删除过期草稿", "删除供应商档案"],
      ["发送周报给团队", "发送退款通知给客户"],
      ["下载月度对账单", "下载图片素材包"],
      ["Export customer list", "Export the monthly inventory report"],
    ] as const;

    for (const [topic, query] of crossObject) expect(isRelevantExperience(topic, query)).toBe(false);
  });

  it("rejects a different action on the same object", () => {
    expect(isRelevantExperience("导出客户名单", "删除客户名单记录")).toBe(false);
    expect(isRelevantExperience("导出客户名单", "把客户名单导出来")).toBe(true);
    expect(isRelevantExperience("导出客户名单", "客户名单")).toBe(true);
  });

  it("keeps the same task in longer, shortened and English wordings", () => {
    expect(isRelevantExperience("导出客户名单", "导出全部客户名单")).toBe(true);
    expect(isRelevantExperience("导出报表", "导出上个月的报表")).toBe(true);
    expect(isRelevantExperience("Export customer list", "Please export the full customer list to CSV")).toBe(true);
  });

  it("rejects an automatic topic without enough task object and keeps preferences permissive", () => {
    expect(isRelevantExperience("导出", "导出本月库存报表")).toBe(false);
    expect(isRelevantExperience("整理数据", "整理文件")).toBe(false);
    expect(isRelevantMemory("导出时用 CSV 格式。", "导出本月库存报表")).toBe(true);
  });
});

async function customerExperience(s: MemoryStore) {
  const entry = await s.createExperience({
    runId: "run-customer",
    topic: "导出客户名单",
    text: customerProcedure,
    scope: site,
    sourceConversationId: "a",
    evidence: ["feedback-1：客户手机号重复了"],
  });

  if (!entry) throw new Error("experience was not created");

  return entry;
}

describe("automatic experience relevance", () => {
  it("does not select an automatic workflow when only the generic action word is shared", async () => {
    const s = await store();
    await customerExperience(s);

    const negatives = [
      { topic: "删除过期草稿", text: "删除供应商档案" },
      { topic: "发送周报给团队", text: "发送退款通知给客户" },
      { topic: "下载月度对账单", text: "下载图片素材包" },
    ];

    expect(await s.select({ text: "导出本月库存报表", url: "https://crm.example/inventory" })).toEqual([]);

    for (const [index, negative] of negatives.entries()) {
      const entry = await s.createExperience({
        runId: `run-negative-${index}`,
        topic: negative.topic,
        text: `待验证的做法：${negative.topic}`,
        scope: site,
        sourceConversationId: "a",
        evidence: [`feedback-${index}：范围不对`],
      });

      expect(entry).not.toBeNull();
      expect(await s.select({ text: negative.text, url: "https://crm.example/work" })).toEqual([]);
    }
  });

  it("does not reuse the same object for a different action", async () => {
    const s = await store();
    await customerExperience(s);
    expect(await s.select({ text: "删除客户名单记录", url: "https://crm.example/customers" })).toEqual([]);
    expect(await s.select({ text: "客户名单导出记录怎么查", url: "https://crm.example/customers" })).not.toEqual([]);
  });

  it("selects the same task again, including short Chinese and English wordings", async () => {
    const s = await store();
    const entry = await customerExperience(s);
    expect(await s.select({ text: "导出全部客户名单", url: "https://crm.example/customers" })).toEqual([entry]);
    expect(await s.select({ text: "把客户名单导出来，并核对数量", url: "https://crm.example/customers" })).toEqual([entry]);
    expect(await s.select({ text: "客户名单", url: "https://crm.example/customers" })).toEqual([entry]);
    expect(await s.select({ text: "导出客户名单", url: "https://crm.example/other" })).toEqual([entry]);
    expect(await s.select({ text: "导出客户名单", url: "https://other.example/customers" })).toEqual([]);

    const short = await s.createExperience({
      runId: "run-report",
      topic: "导出报表",
      text: "待验证的做法：导出报表\n下次参考：先选择月份再导出。",
      scope: { kind: "all" },
      sourceConversationId: "a",
      evidence: ["feedback-2：月份选错了"],
    });

    expect(await s.select({ text: "导出上个月的报表", url: "https://crm.example/customers" })).toEqual([short]);
  });

  it("selects an English wording of the same task", async () => {
    const s = await store();

    const entry = await s.createExperience({
      runId: "run-english",
      topic: "Export customer list",
      text: "待验证的做法：Export customer list\n下次参考：choose all customers before exporting.",
      scope: { kind: "all" },
      sourceConversationId: "a",
      evidence: ["feedback-1：exported only 20 of 200 customers"],
    });

    expect(await s.select({ text: "Please export the full customer list to CSV" })).toEqual([entry]);
    expect(await s.select({ text: "Export the monthly inventory report" })).toEqual([]);
  });

  it("conservatively rejects an automatic workflow that names no task object", async () => {
    const s = await store();
    await s.createExperience({
      runId: "run-vague",
      topic: "导出",
      text: "待验证的做法：导出\n下次参考：先核对范围。",
      scope: { kind: "all" },
      sourceConversationId: "a",
      evidence: ["feedback-1：范围不对"],
    });
    expect(await s.select({ text: "导出本月库存报表" })).toEqual([]);
  });

  it("judges a user-edited entry by its current text, not the old topic", async () => {
    const s = await store();
    const entry = await customerExperience(s);
    const edited = await s.update({ id: entry.id, expectedVersion: entry.version, text: "导出前先让我核对范围", scope: site });
    expect(await s.select({ text: "导出本月库存报表", url: "https://crm.example/inventory" })).toEqual([edited]);

    const renamed = await s.update({ id: edited.id, expectedVersion: edited.version, text: "这个流程需要记下来", scope: site });
    expect(await s.select({ text: "导出客户名单", url: "https://crm.example/customers" })).toEqual([]);
    expect(await s.select({ text: "这个流程需要记下来", url: "https://crm.example/customers" })).toEqual([renamed]);
  });

  it("keeps permissive relevance for explicit preferences", async () => {
    const s = await store();

    const preference = await s.create({
      text: "导出时用 CSV 格式。",
      scope: { kind: "all" },
      sourceConversationId: "a",
    });

    expect(await s.select({ text: "导出本月库存报表" })).toEqual([preference]);
  });

  it("does not inject the customer workflow into a different object through MemoryRuntime", async () => {
    const s = await store();
    await customerExperience(s);
    const runtime = new MemoryRuntime(s, "fixture", () => {});
    let handler: ((event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>) | undefined;
    runtime.extension()({ on: (name: string, fn: typeof handler) => { if (name === "before_agent_start") handler = fn; } } as never);

    if (!handler) throw new Error("before_agent_start handler missing");

    const inject = async (text: string, url: string) => {
      runtime.beginUserTurn(text, { tabId: 1, title: "fixture", url });

      return (await handler!({ systemPrompt: "BASE" }))?.systemPrompt.includes("按客户手机号去重") ?? false;
    };

    expect(await inject("导出本月库存报表", "https://crm.example/inventory")).toBe(false);
    expect(await inject("检查今天的天气", "https://crm.example/weather")).toBe(false);
    expect(await inject("导出客户名单", "https://other.example/customers")).toBe(false);
    expect(await inject("导出全部客户名单", "https://crm.example/customers")).toBe(true);
  });
});
