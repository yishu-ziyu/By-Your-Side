// 小实验：插话截断空回复（content 为空的 assistant）留在历史里，gpt-6-luna 仍接受并按插话作答（docs/evals/20261012-steer-cut-before-text.md）。
// 用法：npx tsx scripts/probes/empty-assistant-history.mts
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "../../node_modules/@earendil-works/pi-ai/dist/index.js";
import { builtinModels } from "../../node_modules/@earendil-works/pi-ai/dist/providers/all.js";

const login = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai-codex", async () => ({ type: "oauth", access: login.access, refresh: login.refresh, expires: login.expires, accountId: login.accountId }) as never);
const models = builtinModels({ credentials });
const model = models.getModel("openai-codex", "gpt-6-luna")!;
const now = Date.now();
const empty = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, stopReason: "stop", timestamp: now,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const reply = await models.completeSimple(model, { systemPrompt: "Answer in one short Chinese sentence.", messages: [
  { role: "user", content: [{ type: "text", text: "帮我订 10 月 12 日的会议室。只回答你要订哪天。" }], timestamp: now },
  empty as never,
  { role: "user", content: [{ type: "text", text: "改成 10 月 13 日。" }], timestamp: now + 1 },
] });
const text = reply.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("");
console.log(`stopReason=${reply.stopReason} error=${reply.errorMessage ?? "无"}\n回答：${text}`);
process.exitCode = reply.stopReason !== "error" && text.includes("13") ? 0 : 1;
