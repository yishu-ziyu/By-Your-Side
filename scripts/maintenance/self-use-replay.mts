/**
 * 每晚的自用回放：把用户自己说过的任务（out/self-use/pool.json）在隔离的无头 Chrome 里用真扩展、真模型重做一遍，
 * 写一份报告（out/self-use/<日期>.json 和 .md）：每条用时（到第一次回答写完）、之后核对和续做又用了多久、到最终交付的总用时、模型往返、开始与结束时的机器负载、有没有出错、卡片和回答对不对得上、结果断言、回答开头；
 * 核对结论、续做和模型往返按这一句自己开的 runId 从整份记录里归：核对晚到、落进下一句那段记录时，也算回原句。
 * 每句的诊断记录另存为 <日期>/<n>-<第几句>.trace.jsonl，没做好的那句可以直接读出卡在哪。
 * 主模型和快速模型（翻译、核对、起名等）都用 ChatGPT 登录的 gpt-6-luna，思考起始档用高档；--model=<服务商/模型> 换主模型（如照日常用 minimax-cn/MiniMax-M3.1-Flash-Preview）。快速模型拿不到登录时退回主模型，报告开头写明。
 * 不碰用户的日常浏览器和记忆；模型凭据只在运行时读，不打印、不落盘；ChatGPT 登录只交访问令牌，不交刷新令牌。
 *   npx tsx scripts/maintenance/self-use-replay.mts [--limit N] [--only=1,5] [--label=名字] [--pool=另一份任务池]
 * --label 把报告写成 <日期>-<名字>，改前改后对照时不覆盖当晚的报告；对照的那份构建用 SIDEAGENT_ACCEPTANCE_DIST 指定。
 * 任务池是用户的原话，只放在本机 out/ 下，不进仓库。格式：[{ "n": 1, "url": "https://…", "say": ["第一句", "接着说的第二句"], "onPage": [2], "expect": { "1": { "answer": ["57\\.1%"] } } }]
 * onPage 标出哪几句（从 1 数）指的是当时页面上的东西：这几句的动作落在别的页、或用了用户原话里没有的搜索词，记「换了目标」，不算完成。
 * expect 是每句的结果断言（见 replay-row.mts）：流程跑完、有回答不等于答对，登记了断言的句子要断言也过才算做成。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, sleep, until } from "../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "../acceptance/real-path/inproc-config.mts";
import { type Row, attribute, missedOf, ok, outcome, poolOf } from "./replay-row.mts";

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
// 主模型默认和快速模型同一家，回放不受两家服务各自波动的影响。
const main = await loadModelPlan(process.argv.find(a => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL);
if (main.credential.type === "oauth") main.credential.refresh = "";
const mainItems = modelStorageItems(main);
const MODEL = { provider: main.providerId, modelId: main.modelId };
// 日常 10-20 至 10-23 的主模型请求八成在高档：侧栏模型菜单里选的起始档存在侧栏的 localStorage。
const EFFORT = "high";
// 快速模型照日常扩展配；拿不到登录就退回主模型，并写进报告，免得把配置差异当成产品变慢。
const fast = await loadModelPlan(DEFAULT_TEST_MODEL).then(plan => {
  if (plan.credential.type === "oauth") plan.credential.refresh = "";
  const items = modelStorageItems(plan);
  return { name: DEFAULT_TEST_MODEL, items: { inproc_fast_model_config: items.inproc_model_config, [`inproc_cred:${plan.providerId}`]: items[`inproc_cred:${plan.providerId}`] } };
}).catch((error: unknown) => ({ name: `${MODEL.provider}/${MODEL.modelId}（${String(error).slice(0, 80)}）`, items: { inproc_fast_model_config: MODEL } }));
const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}${label ? `-${label}` : ""}`;
const shots = join(outDir, day);

await mkdir(shots, { recursive: true });

// 用日常扩展同一份构建（不现场构建，不动 extension/dist）。整轮回放要录二三十分钟，录屏每条画面每秒存 10 帧就够看清过程。
const rp = await launchRealPath({ dist: process.env.SIDEAGENT_ACCEPTANCE_DIST ?? join(REPO, "extension/dist"), recordFps: 10 });
const rows: Row[] = [];
/** 每句自己开的 runId，和它在 rows 里同一位置；收尾时按它从整份记录里归核对、续做和往返。 */
const rowRuns: Set<unknown>[] = [];
const allLines: string[] = [];
const traceExpression = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>x.line));tx.oncomplete=()=>db.close()}})`;
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
let traceSeen = 0;

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...fast.items, ...mainItems, sideagent_self_use: { until: Date.now() + 6 * 3600_000 } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  // 起始档存在侧栏的 localStorage、侧栏连上时交给宿主：写好后重开侧栏。
  await rp.evaluate(panel, `localStorage.setItem("sideagent.thinkingLevels", ${JSON.stringify(JSON.stringify({ [`${MODEL.provider}/${MODEL.modelId}`]: EFFORT }))}); setTimeout(() => location.reload(), 0); true`);
  await sleep(1500);
  await until(async () => await rp.evaluate(panel, ready).catch(() => false) || undefined, 60_000, "侧栏重开就绪");
  const work = (await rp.targets()).find(t => t.url === "about:blank")!;
  const workSession = await rp.attach(work.targetId);

  for (const task of pool) {
    await rp.cdp.send("Page.navigate", { url: task.url }, workSession).catch(() => {});
    await rp.cdp.send("Page.bringToFront", {}, workSession).catch(() => {});
    await rp.click(panel, "#conversation-new");
    await until(async () => await rp.evaluate(panel, ready), 60_000, "新对话就绪").catch(() => {});

    for (const say of task.say) {
      const start = Date.now();
      const loadStart = load();
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

      const answered = Date.now();
      // 回答写完后还在核对，判「继续」时助手会接着做：既不在跑、也不在核对、连着 3 秒都这样，而且诊断记录里每次核对都有了结论，这一句才算做完。
      // 回答等不到核对、先放出来以后，侧栏不再显示「核对中」，快速模型还要几秒才判完：只看侧栏会在结论之前收工，最后一句的结论和它引出的续做都会漏掉。
      // 核对开始、结束各有一条 goal_check_span，按 runId 配对：上一句晚到的结束不能抵掉这一句的开始。
      // 更早的构建没有它，退回按 goal_check_input 配结论数。记录写满（trace_limit）后结束标记会被丢掉，不再等。
      const verdictsPending = async (): Promise<"pending" | "done" | "truncated"> => {
        const open = new Map<unknown, number>();
        let inputs = 0;
        let truncated = false;

        for (const line of (await rp.evaluate(panel, traceExpression).catch(() => []) as string[]).slice(traceSeen)) {
          if (line.includes('"type":"trace_limit"')) truncated = true;
          if (!line.includes('"type":"goal_check')) continue;
          let record: { type?: unknown; runId?: unknown; data?: { phase?: unknown } };
          try { record = JSON.parse(line); } catch { continue; }
          if (record.type === "goal_check_span" && record.data?.phase === "start") open.set(record.runId, (open.get(record.runId) ?? 0) + 1);
          else if (record.type === "goal_check_span" && open.get(record.runId)) open.set(record.runId, open.get(record.runId)! - 1);
          else if (record.type === "goal_check_input") inputs += 1;
          else if (record.type === "goal_check" && inputs) inputs -= 1;
        }

        const pending = [...open.values()].some(n => n > 0) || inputs > 0;
        return pending && truncated ? "truncated" : pending ? "pending" : "done";
      };
      let calm = 0;
      let unsettled: string | null = null;
      await until(async () => {
        calm = await rp.evaluate(panel, ready) && !(await rp.evaluate(panel, `document.body.innerText.includes("核对中")`)) ? calm + 1 : 0;
        if (calm < 3) return undefined;
        const state = await verdictsPending();
        if (state === "truncated") unsettled = "诊断记录写满，核对结论无法确认";
        return state !== "pending" || undefined;
      }, 300_000, "核对和续做结束", 1_000).catch(() => { unsettled = "等核对结论超时，结论无法确认"; });
      const seen = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll(".msg.assistant")].at(-1); const err = [...document.querySelectorAll(".msg.error")].at(-1); const card = [...document.querySelectorAll(".ai-task-card")].at(-1); return { answer: a?.innerText ?? "", error: err?.innerText?.slice(0, 200) ?? null, cardFailed: /有 \\d+ 步没做成|还没做成/.test(card?.innerText ?? "") }; })()`).catch(() => ({ answer: "", error: "读不到侧栏", cardFailed: false })) as { answer: string; error: string | null; cardFailed: boolean };
      const lines = (await rp.evaluate(panel, traceExpression).catch(() => []) as string[]).slice(traceSeen);
      traceSeen += lines.length;
      allLines.push(...lines);
      await writeFile(join(shots, `${task.n}-${task.say.indexOf(say) + 1}.trace.jsonl`), lines.map(line => `${line.trimEnd()}\n`).join("")).catch(() => {});
      await savePrompts(panel);
      rowRuns.push(new Set(lines.flatMap(line => { try { const r = JSON.parse(line) as { type?: unknown; runId?: unknown }; return r.type === "run_start" ? [r.runId] : []; } catch { return []; } })));
      const rule = task.expect?.[String(task.say.indexOf(say) + 1)];
      const missed = rule ? missedOf(rule, {
        answer: seen.answer,
        page: String(await rp.evaluate(workSession, "document.body?.innerText ?? ''").catch(() => "")),
        tabs: (await rp.targets()).filter(t => t.type === "page").map(t => t.url),
      }) : [];
      const secs = Math.round((answered - start) / 1000);
      const checkSecs = Math.round((Date.now() - answered) / 1000);
      rows.push({ n: task.n, say, secs, checkSecs, totalSecs: secs + checkSecs, calls: 0, load: [loadStart, load()], finished, error: error ?? unsettled ?? seen.error, cardSaysFailed: seen.cardFailed, changedGoal: false, verdict: null, expect: rule ? (missed.length ? "fail" : "pass") : null, missed, answer: seen.answer });
      await rp.screenshot(panel, join(shots, `${task.n}-${task.say.indexOf(say) + 1}.png`)).catch(() => {});
      console.log(`${task.n} ${finished ? "完成" : "没完成"} ${rows.at(-1)!.totalSecs}s ${say.slice(0, 30)}`);

      // 上一句没做完就不接着说：后一句是接着前一句说的。
      if (!finished) break;
    }
  }
} finally {
  await rp.close(); await rp.remove();
}

attribute(rows, rowRuns, allLines, pool);

const done = rows.filter(ok);
const median = [...rows].map(r => r.totalSecs).sort((a, b) => a - b)[Math.floor(rows.length / 2)] ?? 0;
const maxLoad = Math.max(0, ...rows.flatMap(r => r.load));
const role = process.env.SIDEAGENT_BUILD_ROLE ?? (!process.env.SIDEAGENT_ACCEPTANCE_DIST ? "daily" : undefined);
await writeFile(join(outDir, `${day}.json`), JSON.stringify({ day, model: MODEL, fastModel: fast.name, ...(role ? { role } : {}), rows }, null, 2));
await writeFile(join(outDir, `${day}.md`), [
  `# 自用回放 ${day}`,
  ``,
  `主模型 ${MODEL.provider}/${MODEL.modelId}（起始档 ${EFFORT}），快速模型 ${fast.name}。`,
  ``,
  `${rows.length} 句，顺利完成 ${done.length} 句（按完成、没报错、卡片没写「没做成」、没换目标、有回答、结果断言没落空算），到最终交付的用时中位数 ${median} 秒。截图和每句的诊断记录在 out/self-use/${day}/。`,
  ...(maxLoad > 20 ? [``, `机器 1 分钟负载最高 ${maxLoad}，超过 20：这一晚的用时不能和别的晚上比。`] : []),
  ``,
  `| # | 原话 | 用时 | 核对后 | 往返 | 负载 | 核对 | 结果 | 回答开头 |`,
  `|---|---|---|---|---|---|---|---|---|`,
  ...rows.map(r => `| ${r.n} | ${r.say.replace(/\|/g, "\\|").slice(0, 40)} | ${r.secs}s | +${r.checkSecs}s | ${r.calls} | ${r.load.join("→")} | ${r.verdict ?? "-"} | ${outcome(r)} | ${r.answer.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 60)} |`),
].join("\n") + "\n");
console.log(`报告：${join(outDir, `${day}.md`)}`);
