/**
 * 每轮复盘的离线评测：用本机诊断记录整理出的真实原话（out/turn-review/set.jsonl，由 build-set.py 生成，不进仓库），
 * 逐句调用模型判断，与 out/turn-review/labels.json 里的人工标注比对，报抓到率和误报。
 *
 *   npx tsx scripts/eval/turn-review.mts [--model claude-haiku-5-5]
 *
 * 用 Command Code 的 Anthropic 接口；密钥运行时从 ~/.commandcode/auth.json 读，不打印、不落盘。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseTurnReview, TURN_REVIEW_PROMPT, turnReviewInput, type TurnReviewInput } from "../../agent/src/memory-review.ts";

const MAIN = "/Users/mahaoxuan/Desktop/AI-products/By-Your-Side/out/turn-review";
const model = process.argv.includes("--model") ? process.argv[process.argv.indexOf("--model") + 1]! : "claude-haiku-5-5";
const auth: unknown = JSON.parse(readFileSync(join(homedir(), ".commandcode/auth.json"), "utf8"));
const key = typeof auth === "object" && auth && "apiKey" in auth && typeof auth.apiKey === "string" ? auth.apiKey : "";

if (!key) throw new Error("~/.commandcode/auth.json 里没有 apiKey");

type Row = TurnReviewInput & { id: string };
const rows: Row[] = readFileSync(join(MAIN, "set.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
const labels: { positive: number[]; optional: number[] } = JSON.parse(readFileSync(join(MAIN, "labels.json"), "utf8"));

async function judge(row: Row): Promise<{ raw: string; ms: number }> {
  const started = Date.now();
  const response = await fetch("https://api.commandcode.ai/provider/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 1200, system: TURN_REVIEW_PROMPT, messages: [{ role: "user", content: turnReviewInput(row) }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const body: unknown = await response.json();

  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`);
  const content = typeof body === "object" && body && "content" in body && Array.isArray(body.content) ? body.content : [];
  const text = content.map((part: unknown) => (typeof part === "object" && part && "text" in part && typeof part.text === "string" ? part.text : "")).join("");

  return { raw: text.replace(/^```(?:json)?\s*|\s*```$/g, ""), ms: Date.now() - started };
}

const results: Array<Record<string, unknown>> = [];
const queue = rows.map((row, index) => ({ row, index }));
await Promise.all(Array.from({ length: 2 }, async () => {
  for (let item = queue.shift(); item; item = queue.shift()) {
    try {
      let attempt = 0, done: { raw: string; ms: number } | null = null;
      // 并发时 Command Code 偶发 403 / 断连：同一句最多再试 3 次，仍失败才记错误。
      while (!done) {
        try { done = await judge(item.row); } catch (error) { if (++attempt > 3) throw error; await new Promise(r => setTimeout(r, 1500 * attempt)); }
      }
      const { raw, ms } = done;
      results[item.index] = { index: item.index, ms, review: parseTurnReview(raw, item.row.userMessage), raw };
    } catch (error) {
      results[item.index] = { index: item.index, error: String(error) };
    }
  }
}));

const hit = (r: Record<string, unknown>) => typeof r.review === "object" && r.review !== null && "feedback" in r.review && r.review.feedback !== "none";
const positives = new Set(labels.positive), optional = new Set(labels.optional);
const caught = labels.positive.filter(i => hit(results[i]!));
const falseAlarms = results.filter(r => hit(r) && !positives.has(Number(r.index)) && !optional.has(Number(r.index)));
const errors = results.filter(r => r.error);
const ms = results.flatMap(r => (typeof r.ms === "number" ? [r.ms] : [])).sort((a, b) => a - b);
const summary = {
  model, total: rows.length, errors: errors.length,
  recall: `${caught.length}/${labels.positive.length}`, missed: labels.positive.filter(i => !hit(results[i]!)).map(i => rows[i]!.userMessage),
  falseAlarms: falseAlarms.length, falseAlarmRate: `${(100 * falseAlarms.length / (rows.length - positives.size - optional.size)).toFixed(1)}%`,
  falseAlarmTexts: falseAlarms.map(r => ({ text: rows[Number(r.index)]!.userMessage.slice(0, 60), review: r.review })),
  positives: labels.positive.map(i => ({ text: rows[i]!.userMessage.slice(0, 40), review: results[i]!.review })),
  optional: labels.optional.map(i => ({ text: rows[i]!.userMessage.slice(0, 40), review: results[i]!.review })),
  medianMs: ms[Math.floor(ms.length / 2)], p90Ms: ms[Math.floor(ms.length * 0.9)],
};
const file = join(MAIN, `result-${model}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(file, JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary, null, 2));
console.log("详细结果：", file);
