/**
 * 每晚的自用回放：把用户自己说过的任务（out/self-use/pool.json）在隔离的无头 Chrome 里用真扩展、真模型重做一遍，
 * 写一份报告（out/self-use/<日期>.json 和 .md）：每条用时、有没有出错、卡片和回答对不对得上、回答开头。
 * 不碰用户的日常浏览器和记忆；模型密钥（~/.pi/agent/auth.json 的 minimax-cn）只在运行时读，不打印、不落盘。
 *   npx tsx scripts/maintenance/self-use-replay.mts [--limit N]
 * 任务池是用户的原话，只放在本机 out/ 下，不进仓库。格式：[{ "n": 1, "url": "https://…", "say": ["第一句", "接着说的第二句"] }]
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, until } from "../acceptance/real-path/harness.mts";

type PoolTask = { n: number; url: string; say: string[] };
type Row = { n: number; say: string; secs: number; finished: boolean; error: string | null; cardSaysFailed: boolean; answer: string };

const outDir = join(REPO, "out/self-use");
const poolFile = join(outDir, "pool.json");

if (!existsSync(poolFile)) {
  console.error(`没有任务池：${poolFile}。格式见本文件开头。`);
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const pool = (JSON.parse(readFileSync(poolFile, "utf8")) as PoolTask[]).slice(0, limitArg > 0 ? Number(process.argv[limitArg + 1]) : undefined);
const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Object.getOwnPropertyDescriptor(value, name)?.value : undefined);
const key = field(field(JSON.parse(readFileSync(join(homedir(), ".pi/agent/auth.json"), "utf8")), "minimax-cn"), "key");

if (typeof key !== "string" || !key) throw new Error("~/.pi/agent/auth.json 里没有 minimax-cn 的密钥");
const MODEL = { provider: "minimax-cn", modelId: "MiniMax-M3.1-Flash-Preview" };
const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const shots = join(outDir, day);

await mkdir(shots, { recursive: true });

// 用日常扩展同一份构建（不现场构建，不动 extension/dist）。
const rp = await launchRealPath({ dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? join(REPO, "extension/dist") });
const rows: Row[] = [];

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: MODEL, inproc_fast_model_config: MODEL, sideagent_self_use: { until: Date.now() + 6 * 3600_000 } })}).then(() => true)`);
  await rp.evaluate(panel, `chrome.storage.local.set({["inproc_cred:" + ${JSON.stringify(MODEL.provider)}]: {type: "api_key", key: ${JSON.stringify(key)}}}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const work = (await rp.targets()).find(t => t.url === "about:blank")!;
  const workSession = await rp.attach(work.targetId);

  for (const task of pool) {
    await rp.cdp.send("Page.navigate", { url: task.url }, workSession).catch(() => {});
    await rp.cdp.send("Page.bringToFront", {}, workSession).catch(() => {});
    await rp.click(panel, "#conversation-new");
    await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪").catch(() => {});

    for (const say of task.say) {
      const start = Date.now();
      let finished = true;
      let error: string | null = null;

      try {
        await rp.click(panel, "#input");
        await rp.typeText(panel, say);
        await rp.pressEnter(panel);
        await until(async () => await rp.evaluate(panel, `document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 30_000, "开始").catch(() => {});
        await until(async () => await rp.evaluate(panel, ready), 300_000, "这一轮结束", 1_000);
      } catch (e) {
        finished = false;
        error = String(e).slice(0, 200);
      }

      const seen = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); const err = [...document.querySelectorAll(".msg.error")].at(-1); const card = [...document.querySelectorAll(".ai-task-card")].at(-1); return { answer: (a?.innerText ?? "").slice(0, 300), error: err?.innerText?.slice(0, 200) ?? null, cardFailed: /没做成/.test(card?.innerText ?? "") }; })()`).catch(() => ({ answer: "", error: "读不到侧栏", cardFailed: false })) as { answer: string; error: string | null; cardFailed: boolean };
      rows.push({ n: task.n, say, secs: Math.round((Date.now() - start) / 1000), finished, error: error ?? seen.error, cardSaysFailed: seen.cardFailed, answer: seen.answer });
      await rp.screenshot(panel, join(shots, `${task.n}-${task.say.indexOf(say) + 1}.png`)).catch(() => {});
      console.log(`${task.n} ${finished ? "完成" : "没完成"} ${rows.at(-1)!.secs}s ${say.slice(0, 30)}`);

      // 上一句没做完就不接着说：后一句是接着前一句说的。
      if (!finished) break;
    }
  }
} finally {
  await rp.close(); await rp.remove();
}

const done = rows.filter(r => r.finished && !r.error && !r.cardSaysFailed && r.answer.trim());
const median = [...rows].map(r => r.secs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;
await writeFile(join(outDir, `${day}.json`), JSON.stringify({ day, model: MODEL, rows }, null, 2));
await writeFile(join(outDir, `${day}.md`), [
  `# 自用回放 ${day}`,
  ``,
  `${rows.length} 句，顺利完成 ${done.length} 句（按完成、没报错、卡片没写「没做成」、有回答算），用时中位数 ${median} 秒。截图在 out/self-use/${day}/。`,
  ``,
  `| # | 原话 | 用时 | 结果 | 回答开头 |`,
  `|---|---|---|---|---|`,
  ...rows.map(r => `| ${r.n} | ${r.say.replace(/\|/g, "\\|").slice(0, 40)} | ${r.secs}s | ${!r.finished ? "没完成" : r.error ? `报错：${r.error.slice(0, 40)}` : r.cardSaysFailed ? "卡片写没做成" : "完成"} | ${r.answer.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 60)} |`),
].join("\n") + "\n");
console.log(`报告：${join(outDir, `${day}.md`)}`);
