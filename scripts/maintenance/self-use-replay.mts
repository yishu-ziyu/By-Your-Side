import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, sleep, until, watchInproc } from "../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "../acceptance/real-path/inproc-config.mts";
import { type Row, attribute, checkState, missedOf, ok, outcome, poolOf, recordsOf, turnRuns } from "./replay-row.mts";

import { observeTurn, type TurnSnapshot } from "./replay-panel.mts";

const outDir = join(REPO, "out/self-use");
const poolFile = process.argv.find(a => a.startsWith("--pool="))?.slice(7) ?? join(outDir, "pool.json");

if (!existsSync(poolFile)) {
  console.error(`没有任务池：${poolFile}。格式见本文件开头。`);
  process.exit(1);
}

const limitArg = process.argv.indexOf("--limit");
const only = process.argv.find(a => a.startsWith("--only="))?.slice(7).split(",").map(Number);
const label = process.argv.find(a => a.startsWith("--label="))?.slice(8);
const pool = poolOf(JSON.parse(readFileSync(poolFile, "utf8"))).filter(t => !only || only.includes(t.n)).slice(0, limitArg > 0 ? Number(process.argv[limitArg + 1]) : undefined);
const EFFORT = process.argv.find(a => a.startsWith("--effort="))?.slice(9) ?? "high";
if (!["low", "high"].includes(EFFORT)) throw new Error("回放 --effort 只支持 low 或 high");
const mainName = process.argv.find(a => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL;
const minimaxPi = process.argv.includes("--minimax-pi");
if (minimaxPi && !mainName.startsWith("minimax-cn/")) throw new Error("--minimax-pi 需要指定 minimax-cn 主模型");
const explicitFast = process.argv.find(a => a.startsWith("--fast-model="))?.slice(13);
const fastName = explicitFast ?? (minimaxPi ? mainName : DEFAULT_TEST_MODEL);
async function replayPlan(name: string) {
  if (!minimaxPi) return loadModelPlan(name);
  if (!name.startsWith("minimax-cn/")) throw new Error("--minimax-pi 只读取 MiniMax 订阅");
  const key = spawnSync("jq", ["-er", '.["minimax-cn"].key | strings | select(length > 0)', join(homedir(), ".pi/agent/auth.json")], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (key.status !== 0 || !key.stdout.trim()) throw new Error("无法从 Pi 读取 MiniMax 订阅");
  return { providerId: "minimax-cn", modelId: name.slice("minimax-cn/".length), credential: { type: "api_key", key: key.stdout.trim() } };
}
const main = await replayPlan(mainName);
if (main.credential.type === "oauth") main.credential.refresh = "";
const mainItems = modelStorageItems(main);
const MODEL = { provider: main.providerId, modelId: main.modelId };
const fast = await (fastName === mainName ? Promise.resolve(main) : replayPlan(fastName)).then(plan => {
  if (plan.credential.type === "oauth") plan.credential.refresh = "";
  const items = modelStorageItems(plan);
  return { name: fastName, items: { inproc_fast_model_config: items.inproc_model_config, [`inproc_cred:${plan.providerId}`]: items[`inproc_cred:${plan.providerId}`] } };
}).catch((error: unknown) => {
  if (explicitFast || minimaxPi) throw error;
  return { name: `${mainName}（快速模型不可用）`, items: { inproc_fast_model_config: MODEL } };
});
const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}${label ? `-${label}` : ""}`;
const shots = join(outDir, day);

await mkdir(shots, { recursive: true });

const rp = await launchRealPath({ dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? join(REPO, "extension/dist"), recordFps: 10 });
const rows: Row[] = [];
const unavailable: Array<{ n: number; reason: string }> = [];
let minimaxTraffic: { requests: number; httpErrors: number; networkFailures: number; unfinished: number } | null = null;
const rowRuns: Set<string>[] = [];
const allLines: string[] = [];
let lastTraceKey = 0;
async function newTraceLines(panel: string): Promise<string[]> {
  const result = await rp.evaluate(panel, `new Promise((resolve,reject) => {
    const req = indexedDB.open("sideagent-diagnostics");
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("trace-lines")) { db.close(); resolve({lines: [], last: ${lastTraceKey}}); return; }
      const tx = db.transaction("trace-lines");
      const store = tx.objectStore("trace-lines");
      const range = IDBKeyRange.lowerBound(${lastTraceKey}, true);
      const rows = store.getAll(range);
      const key = store.openKeyCursor(range, "prev");
      let last = ${lastTraceKey};
      key.onsuccess = () => { if (key.result) last = key.result.primaryKey; };
      tx.oncomplete = () => { db.close(); resolve({lines: rows.result.map(row => row.line), last}); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  })`) as { lines: string[]; last: number };
  lastTraceKey = result.last;
  allLines.push(...result.lines);
  return result.lines;
}
const promptExpression = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-prompts')){db.close();resolve([]);return}const tx=db.transaction('trace-prompts');const q=tx.objectStore('trace-prompts').getAll();q.onsuccess=()=>resolve(q.result);tx.oncomplete=()=>db.close()}})`;
const savePrompts = async (panel: string) => {
  const values = await rp.evaluate(panel, promptExpression).catch(() => []) as unknown;
  if (!Array.isArray(values)) return;
  await mkdir(join(shots, "prompts"), { recursive: true });
  for (const value of values) {
    if (!value || typeof value !== "object" || !("hash" in value) || typeof value.hash !== "string" || !/^[a-f0-9]{64}$/.test(value.hash) || !("text" in value) || typeof value.text !== "string") continue;
    await writeFile(join(shots, "prompts", `${value.hash}.txt`), value.text, { mode: 0o600 }).catch(() => {});
  }
};
const load = () => Math.round(loadavg()[0] * 10) / 10;


try {
  const panel = await rp.attach(await rp.openSidePanel());
  const selectors = [...new Set(pool.flatMap(task => Object.values(task.expect).flatMap(rule => (rule.pageSelectorCounts ?? []).map(item => item.selector))))];
  await rp.evaluate(panel, `${JSON.stringify(selectors)}.forEach(selector => document.createDocumentFragment().querySelectorAll(selector))`);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...fast.items, ...mainItems, sideagent_self_use: { until: Date.now() + 6 * 3600_000 } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  await rp.evaluate(panel, `localStorage.setItem("sideagent.thinkingLevels", ${JSON.stringify(JSON.stringify({ [`${MODEL.provider}/${MODEL.modelId}`]: EFFORT }))}); setTimeout(() => location.reload(), 0); true`);
  await sleep(1500);
  await until(async () => await rp.evaluate(panel, ready).catch(() => false) || undefined, 60_000, "侧栏重开就绪");
  const work = (await rp.targets()).find(t => t.url === "about:blank")!;
  const workSession = await rp.attach(work.targetId);
  const traffic = MODEL.provider === "minimax-cn" && fastName.startsWith("minimax-cn/") ? await watchInproc(rp, rp.extensionId) : null;

  for (const task of pool) {
    await rp.cdp.send("Page.navigate", { url: task.url }, workSession).catch(() => {});
    if (task.readyText) {
      const readyPage = `location.origin === ${JSON.stringify(new URL(task.url).origin)} && document.body?.innerText.includes(${JSON.stringify(task.readyText)})`;
      const observed = await until(async () => await rp.evaluate(workSession, readyPage).catch(() => false) || undefined, 30_000, "任务起始页面就绪").catch(() => false);
      if (!observed) {
        const reason = "起始网页未显示登记的内容";
        unavailable.push({ n: task.n, reason });
        console.log(`${task.n} 未跑：${reason}`);
        continue;
      }
    }
    await rp.cdp.send("Page.bringToFront", {}, workSession).catch(() => {});
    await rp.click(panel, "#conversation-new");
    await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪");

    for (const [index, say] of task.say.entries()) {
      const k = index + 1;
      const rule = task.expect[String(k)]!;
      const loadStart = load();
      const lines: string[] = [];
      let finished = true;
      let error: string | null = null;
      let firstIdle = 0;
      let correctAt: number | null = null;
      let matchedAnswerMs: number | null = null;
      let missed: string[] = [];
      const readPanel = () => rp.evaluate(panel, "window.__bysReplayTurn.read()") as Promise<TurnSnapshot>;
      const validate = async (seen: TurnSnapshot) => {
        const pageChecks = rule.pageSelectorCounts ?? [];
        const needsPage = !!rule.page?.length || !!pageChecks.length;
        const [page, tabs] = await Promise.all([
          needsPage ? rp.evaluate(workSession, `({ text: ${rule.page?.length ? "document.body?.innerText ?? ''" : "''"}, counts: ${JSON.stringify(pageChecks.map(item => item.selector))}.map(selector => document.querySelectorAll(selector).length) })`) as Promise<{ text: string; counts: number[] }> : { text: "", counts: [] },
          rule.tab?.length ? rp.targets().then(targets => targets.filter(t => t.type === "page").map(t => t.url)) : [],
        ]);
        missed = missedOf(rule, { answer: seen.answer, page: page.text, pageCounts: page.counts, tabs, replyHas: seen.has });
        if (missed.length || seen.answerReadyMs === null || seen.error || seen.paused || seen.cardFailed) {
          correctAt = null;
        } else if (correctAt === null || matchedAnswerMs !== seen.answerReadyMs) {
          correctAt = needsPage || rule.tab?.length ? (await readPanel()).elapsedMs : seen.answerReadyMs;
        }
        matchedAnswerMs = seen.answerReadyMs;
      };

      await rp.click(panel, "#input");
      await rp.typeText(panel, say);
      await rp.evaluate(panel, observeTurn(say, rule.replyHas ?? []));
      await newTraceLines(panel);
      await rp.pressEnter(panel);
      try {
        await until(async () => {
          const seen = await readPanel();
          return seen.sent && (seen.running || seen.paused || seen.answerReadyMs !== null || seen.error) || undefined;
        }, 30_000, "开始或直接回答");
        const idle = await until(async () => {
          const seen = await readPanel();
          return seen.paused || seen.idle ? seen : undefined;
        }, 300_000, "这一轮结束", 250);
        firstIdle = idle.elapsedMs;
        await validate(idle);
        if (!idle.paused) {
          let quietAt: number | null = null;
          const records: ReturnType<typeof recordsOf> = [];
          await until(async () => {
            const seen = await readPanel();
            if (seen.paused) return true;
            if (!seen.idle || seen.checking) { quietAt = null; correctAt = null; return undefined; }
            const fresh = await newTraceLines(panel);
            lines.push(...fresh);
            records.push(...recordsOf(fresh));
            const check = checkState(records, turnRuns(records, say));
            if (check === "truncated") { error = "诊断记录写满，核对结论无法确认"; return true; }
            if (check === "pending" || (seen.answer && seen.answerReadyMs === null)) { quietAt = null; return undefined; }
            quietAt ??= Date.now();
            return Date.now() - quietAt >= 2000 || undefined;
          }, 300_000, "核对和续做结束", 500);
        }
      } catch (cause) {
        error = String(cause).slice(0, 200);
        finished = false;
      }
      const seen = await readPanel();
      await validate(seen);
      const verifiedMs = (await readPanel()).elapsedMs;
      if (seen.paused) finished = false;
      if (!firstIdle) firstIdle = seen.pauseMs ?? seen.elapsedMs;
      const secs = Math.round(firstIdle / 1000);
      const checkSecs = Math.max(0, Math.round((verifiedMs - firstIdle) / 1000));
      lines.push(...await newTraceLines(panel));
      rowRuns.push(turnRuns(recordsOf(lines), say));
      const row: Row = { n: task.n, k, say, secs, checkSecs, totalSecs: secs + checkSecs, calls: 0, load: [loadStart, load()], finished, error: error ?? seen.error, cardSaysFailed: seen.cardFailed, changedGoal: false, verdict: null, expect: missed.length ? "fail" : "pass", missed, answer: seen.answer,
        timing: { firstFeedbackMs: seen.firstFeedbackMs, finalAnswerMs: seen.answerReadyMs, correctCompletionMs: correctAt, verifiedMs, pauseMs: seen.pauseMs } };
      rows.push(row);
      await rp.evaluate(panel, "window.__bysReplayTurn.dispose()");
      await writeFile(join(shots, `${task.n}-${k}.trace.jsonl`), lines.map(line => `${line.trimEnd()}\n`).join(""));
      await savePrompts(panel);
      await rp.screenshot(panel, join(shots, `${task.n}-${k}.png`)).catch(() => {});
      console.log(`${task.n}-${k} ${finished ? "完成" : "没完成"} ${rows.at(-1)!.totalSecs}s`);

      if (!finished) break;
    }
  }
  await newTraceLines(panel);
  if (traffic) {
    const calls = traffic.requestsBetween(0).filter(request => {
      const url = new URL(request.url);
      return request.method === "POST" && url.origin === "https://api.minimaxi.com" && url.pathname === "/anthropic/v1/messages";
    });
    minimaxTraffic = {
      requests: calls.length,
      httpErrors: calls.filter(call => call.status !== null && call.status >= 400).length,
      networkFailures: calls.filter(call => !!call.failed).length,
      unfinished: calls.filter(call => call.endMs === null).length,
    };
  }
} finally {
  await rp.close(); await rp.remove();
}

attribute(rows, rowRuns, allLines, pool);

for (const row of rows) if (row.timing && !ok(row)) row.timing.correctCompletionMs = null;
const done = rows.filter(ok);
function latencyOf(values: Array<number | null | undefined>) {
  const times = values.filter((v): v is number => typeof v === "number").sort((a,b) => a - b);
  return {
    count: times.length,
    p50Ms: times.length ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2 : null,
    p95Ms: times[Math.ceil(times.length * 0.95) - 1] ?? null,
  };
}
const plannedTurns = pool.reduce((count, t) => count + t.say.length, 0);
const firstFeedback = latencyOf(rows.map(r => r.timing?.firstFeedbackMs));
const correctCompletion = latencyOf(done.map(r => r.timing?.correctCompletionMs));
const maxLoad = Math.max(0, ...rows.flatMap(r => r.load));
const role = process.env.SIDEAGENT_BUILD_ROLE ?? (!process.env.SIDEAGENT_ACCEPTANCE_DIST ? "daily" : undefined);
await writeFile(join(outDir, `${day}.json`), JSON.stringify({ day, model: MODEL, effort: EFFORT, fastModel: fast.name, plannedTurns, unavailable, firstFeedback, correctCompletion, minimaxTraffic, ...(role ? { role } : {}), rows }, null, 2));
await writeFile(join(outDir, `${day}.md`), [
  `# 自用回放 ${day}`,
  ``,
  `主模型 ${MODEL.provider}/${MODEL.modelId}（起始档 ${EFFORT}），快速模型 ${fast.name}。`,
  ``,
  `计划 ${plannedTurns} 句，执行 ${rows.length} 句，正确完成 ${done.length} 句。正确完成耗时（${correctCompletion.count} 句）的 P50 ${correctCompletion.p50Ms ?? "未测"} 毫秒，P95 ${correctCompletion.p95Ms ?? "未测"} 毫秒。截图和每句的诊断记录在 out/self-use/${day}/。`,
  `首个可见反馈（${firstFeedback.count} 句）的 P50 ${firstFeedback.p50Ms ?? "未测"} 毫秒，P95 ${firstFeedback.p95Ms ?? "未测"} 毫秒。正确完成耗时取最终回答就绪时刻；有页面或标签页断言时取首次同时核验结果的时间上界。`,
  ...(minimaxTraffic ? [`隔离回放期间共向 MiniMax 发送 ${minimaxTraffic.requests} 次模型请求，HTTP 错误 ${minimaxTraffic.httpErrors} 次，网络失败或取消 ${minimaxTraffic.networkFailures} 次，采样结束时在途 ${minimaxTraffic.unfinished} 次。`] : []),
  ...(maxLoad > 20 ? [``, `机器 1 分钟负载最高 ${maxLoad}，超过 20：这一晚的用时不能和别的晚上比。`] : []),
  ``,
  `| # | 原话 | 用时 | 核对后 | 往返 | 负载 | 核对 | 结果 | 回答开头 |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...rows.map(r => `| ${r.n} | ${r.say.replace(/\|/g, "\\|").slice(0, 40)} | ${r.secs}s | +${r.checkSecs}s | ${r.calls} | ${r.load.join("→")} | ${r.verdict ?? "-"} | ${outcome(r)} | ${r.answer.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 60)} |`),
].join("\n") + "\n");
console.log(`报告：${join(outDir, `${day}.md`)}`);
