/**
 * 先列失败：文件只传长度；此前数据不传；答复前段被裁掉；纠错理由丢失。
 * 判据是发给外部核对模型的数据与返回的纠错信息，不依赖提示词字面文本。
 */
import { expect, it } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { checkGoal } from "../src/goal-check.js";
import type { SideCallHost } from "../src/side-judgment.js";

const model: Model<"openai-completions"> = {
  id: "probe", name: "probe", api: "openai-completions", provider: "probe", baseUrl: "http://127.0.0.1",
  reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64_000, maxTokens: 2048,
};

function host(verdict: { status: string; remaining?: string; correction?: string }, received: string[]): SideCallHost {
  return { models: { completeSimple: async (_model, context) => {
    received.push(String(context.messages[0]?.content ?? ""));

    return { role: "assistant", content: [{ type: "text", text: JSON.stringify(verdict) }], api: model.api,
      provider: model.provider, model: model.id, stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } satisfies AssistantMessage;
  } } };
}

it("核对拿到此前取数、文件全文与答复前段，不能把文件存在当作内容正确", async () => {
  const received: string[] = [];

  const input = { goal: ["把 2026-09-29 的数据导出成 CSV，保留日期"], page: null,
    lastReply: "首段：合计 34。" + "普通说明。".repeat(400),
    files: [{ filename: "data.csv", chars: 27, lines: 2, savedAt: 0, content: "date,total\n2026-09-30,34\n" }],
    observations: [{ tool: "browser_run", text: "页面实际日期 2026-09-30；分项 22、4、5、2" }],
  };

  await checkGoal(host({ status: "done" }, received), model, input, new AbortController().signal);
  const payload = JSON.parse(received[0]!);
  expect(payload.files[0].content).toBe("date,total\n2026-09-30,34\n");
  expect(payload.observations).toEqual(input.observations);
  expect(payload.lastReply).toBe(input.lastReply);
});

it("具体纠错理由保留给主模型，不能只剩一句含糊的还差什么", async () => {
  const reason = "请求的是 2026-09-29，文件中的日期为 2026-09-30；22+4+5+2=33，合计写成34。";

  const verdict = await checkGoal(host({ status: "continue", remaining: "核对日期与合计", correction: reason }, []), model,
    { goal: ["导出指定日期的统计表"], lastReply: "已导出。", page: null }, new AbortController().signal);

  expect(verdict).toMatchObject({ status: "continue", remaining: "核对日期与合计", correction: reason });
});

it("CSV 把换行写成字面转义时要求修正文件，不接受模型的 done", async () => {
  const content = String.raw`类别,数量\n省,22\n直辖市,4\n自治区,5\n特别行政区,2\n合计,33\n`;

  const verdict = await checkGoal(host({ status: "done" }, []), model,
    { goal: ["导出 CSV 表格"], lastReply: "已导出。", page: null,
      files: [{ filename: "sum.csv", chars: content.length, lines: 1, savedAt: 0, content }] }, new AbortController().signal);

  expect(verdict.status).toBe("continue");
  expect(verdict.correction).toContain("实际换行");
});

it("用户明确要转义文本时保留原文件，不擅自改成多行", async () => {
  const content = String.raw`类别,数量\n省,22\n直辖市,4\n合计,26\n`;

  const verdict = await checkGoal(host({ status: "done" }, []), model,
    { goal: ["导出用字面转义表示换行的 CSV 示例"], lastReply: "已导出。", page: null,
      files: [{ filename: "example.csv", chars: content.length, lines: 1, savedAt: 0, content }] }, new AbortController().signal);

  expect(verdict.status).toBe("done");
});
