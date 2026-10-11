// 小实验：目标核对拿到前一轮读的会议室一览后，对的预订判 done、错的预订仍判 continue（docs/evals/20261011-goal-check-earlier-reads.md）。
// 真实 gpt-6-luna，凭据取自 ~/.pi/agent/auth.json。用法：npx tsx scripts/probes/goal-check-earlier-reads.mts [次数]
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "../../node_modules/@earendil-works/pi-ai/dist/index.js";
import { builtinModels } from "../../node_modules/@earendil-works/pi-ai/dist/providers/all.js";
import { checkGoal } from "../../agent/src/goal-check.ts";

const login = JSON.parse(await readFile(join(homedir(), ".pi/agent/auth.json"), "utf8"))["openai-codex"];
const credentials = new InMemoryCredentialStore();
await credentials.modify("openai-codex", async () => ({ type: "oauth", access: login.access, refresh: login.refresh, expires: login.expires, accountId: login.accountId }) as never);
const models = builtinModels({ credentials });
const model = models.getModel("openai-codex", "gpt-6-luna")!;
const rooms = "会议室一览\n会议室 人数 投影仪 备注\n青松 10 人 无\n白桦 6 人 有\n红枫 12 人 有 10 月 12 日 15:00 已被订\n银杏 8 人 无\n金桂 9 人 有";
const goal = ["帮我订 10 月 12 日 15:00 能坐 8 人以上的会议室，主题写周会。", "要带投影仪的。"];
const booked = (room: string) => ({ title: "我的预订", url: "http://127.0.0.1/mine", text: `RootWebArea "我的预订"\n  [ref=3] heading "我的预订" level=1\n  [ref=5] text: 编号 2：10 月 12 日 15:00 ${room}「周会」\n  [ref=6] button "取消编号 2"\n  [ref=8] link "去预订"` });
const cases = [
  { name: "对的预订·改前（只有这一轮的工具结果）", want: "done", page: booked("金桂"), reply: "已改订金桂会议室：10 月 12 日 15:00，可坐 9 人，有投影仪，主题「周会」；原来的银杏已取消。", observations: [{ tool: "browser_run", text: "{\"value\":\"预订成功，编号 2\"}" }] },
  { name: "对的预订·改后（加上前一轮读的会议室一览）", want: "done", page: booked("金桂"), reply: "已改订金桂会议室：10 月 12 日 15:00，可坐 9 人，有投影仪，主题「周会」；原来的银杏已取消。", observations: [{ tool: "page_at_start", text: rooms, earlier: true }, { tool: "browser_run", text: "{\"value\":\"预订成功，编号 2\"}" }] },
  { name: "错的预订·改后（银杏没有投影仪，回答却说有）", want: "continue", page: booked("银杏"), reply: "已改订银杏会议室：10 月 12 日 15:00，可坐 8 人，有投影仪，主题「周会」。", observations: [{ tool: "page_at_start", text: rooms, earlier: true }, { tool: "browser_run", text: "{\"value\":\"预订成功，编号 2\"}" }] },
];
const times = Number(process.argv[2] ?? 3);
let pass = true;
for (const c of cases) {
  const got: string[] = [];
  for (let i = 0; i < times; i++) {
    const v = await checkGoal({ models }, model, { goal, goalPage: { title: "会议室一览", url: "http://127.0.0.1/rooms" }, lastReply: c.reply, page: c.page, observations: c.observations }, AbortSignal.timeout(30_000)).catch(e => ({ status: `error:${String(e).slice(0, 60)}` }));
    got.push(v.status + ("remaining" in v && v.status !== c.want ? `(${(v as { remaining?: string | null; correction?: string }).remaining}｜${((v as { correction?: string }).correction ?? "").slice(0, 120)})` : ""));
  }
  console.log(`${c.name}\t期望 ${c.want}\t实得 ${got.join(" ")}`);
  if (!c.name.includes("改前") && got.some(g => !g.startsWith(c.want))) pass = false;
}
process.exitCode = pass ? 0 : 1;
