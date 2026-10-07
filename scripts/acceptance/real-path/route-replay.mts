/**
 * 同一网站、同一类事照上次的做法走；页面改了就停下交回一步步做（YIS-95，docs/evals/20261007-route-replay.md）；
 * 提交前核对、侧栏「照上次的做法 第 N/M 步」（YIS-96，docs/evals/20261007-route-check.md）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/route-replay.mts --headless [--model=provider/id] [--first=selector]
 * --first=selector：第一次请模型用页面选择器（#date 这类）操作，复现「这样做成的记不下做法」（YIS-103）。
 * 失败方式：第二次没照上次走、还是一步步做；照走时值没换（日期、时间、主题、选哪一间）；页面改了还照点、点错或订错；
 *   停下后模型没接着做完；订了不止一次；「下周四」这种说法核对不过或订错日期；侧栏没写第几步、没留核对和对不上那一行。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, exportDiagnosticsViaSettings, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const selectorFirst = process.argv.includes("--first=selector");

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-route-replay`);

await mkdir(artifacts, { recursive: true });

const bookings: string[] = [];

const ROOMS = [["青松", "3F-A", "8 人 · 投影"], ["白桦", "3F-B", "12 人 · 白板"], ["银杏", "5F", "30 人 · 视频会议"]];

/** ?v=2 是改版后的页面：会议室列表换成表格，按钮改叫「预约此间」。 */
const roomList = (v2: boolean) => v2
  ? `<table><tr><th>会议室</th><th>位置</th><th></th></tr>${ROOMS.map(([n, f, d]) => `<tr><td>${n}</td><td>${f} · ${d}</td><td><button type="button" onclick="pick(this,'${n}')">预约此间</button></td></tr>`).join("")}</table>`
  : `<div class="rooms">${ROOMS.map(([n, f, d]) => `<div class="room"><h3>${n}</h3><p>${f} · ${d}</p><button type="button" onclick="pick(this,'${n}')">选择</button></div>`).join("")}</div>`;

const site = createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { bookings.push(body); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });

    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>会议室预订</title>
<style>body{font:15px system-ui;margin:32px;max-width:760px} label{display:block;margin:12px 0} select,input{font:15px system-ui;padding:6px 8px} .rooms{display:flex;gap:12px;margin:16px 0} .room{border:1px solid #ccc;border-radius:8px;padding:12px;flex:1} .room.picked{border-color:#3370ff;background:#f0f4ff} #ok{color:green}</style>
<h1>会议室预订</h1>
<label>日期 <select id="date"><option value="">选择日期</option><option>10 月 8 日（周四）</option><option>10 月 15 日（周四）</option></select></label>
<label>时间 <select id="time"><option value="">选择时间</option><option>14:00–15:00</option><option>15:00–16:00</option><option>16:00–17:00</option></select></label>
<section aria-label="会议室">${roomList(req.url?.includes("v=2") ?? false)}</section>
<label>会议主题 <input id="topic" placeholder="例如：项目周会"></label>
<button id="submit" type="button" onclick="book()">预订</button> <span id="ok" role="status"></span>
<script>let room="";function pick(b,n){room=n;document.querySelectorAll('.room,tr').forEach(r=>r.classList.remove('picked'));b.closest('.room,tr').classList.add('picked');}
async function book(){const d={date:date.value,time:time.value,room,topic:topic.value};if(!d.date||!d.time||!room||!d.topic){ok.textContent='请填完日期、时间、会议室和主题';return;}
await fetch('/book',{method:'POST',body:JSON.stringify(d)});ok.textContent='预订成功：'+d.date+' '+d.time+' '+room+'，主题「'+d.topic+'」';}</script>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const evidence: JsonRecord = { model: modelArg };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

const send = async (text: string) => {
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await sleep(1500);
};

type Task = { id: string; goal: string; outcome: string; route?: { steps: Array<{ action: string; target?: { role: string; name: string; area: string; box: string }; value?: string; valueFrom?: string; label?: string }> } };

/** 过往任务（扩展 IndexedDB 里的原样记录）。 */
const tasks = async (): Promise<Task[]> => {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");

    // SAFETY: 页面脚本返回 kv 里 tasks 的 JSON 文本。
    const raw = await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
      r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("tasks"); q.onsuccess = () => res(q.result ?? ""); q.onerror = () => rej(q.error); }; })`) as string;

    // SAFETY: tasks 键由扩展写入，形状是 { tasks: TaskHistoryEntry[] }。
    return raw ? (JSON.parse(raw) as { tasks: Task[] }).tasks : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
    await rp.cdp.send("Target.activateTarget", { targetId: workTarget }).catch(() => undefined);
  }
};

let workTarget = "";

type Booking = { date: string; time: string; room: string; topic: string };

// SAFETY: 预订页 POST 的正文由页面脚本按 Booking 的四个字段拼成 JSON。
const booked = (i: number): Booking | null => (bookings[i] ? JSON.parse(bookings[i]!) as Booking : null);

const runs: JsonRecord[] = [];

/** 像第二天再来：新开一个标签页打开网站、新开一个对话，说一句，等做完。 */
const ask = async (name: string, text: string, url: string) => {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  workTarget = (await rp.cdp.send("Target.createTarget", { url })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: workTarget });
  work = await rp.attach(workTarget);
  await sleep(1000);
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, `${name}：新对话`);
  const started = Date.now();
  await send(text);
  // 做的过程中每 150 毫秒记一次侧栏标题和标题下的几行：照走时标题一闪而过。
  const titles = new Set<string>();
  const trail = new Set<string>();
  let finished = false;
  let shot = false;

  const watch = (async () => {
    while (!finished) {
      // SAFETY: 页面脚本返回 [标题, 行…] 字符串数组。
      const seen = await rp.evaluate(panel, `[[...document.querySelectorAll(".run-title")].at(-1)?.innerText ?? "", ...[...document.querySelectorAll(".run-trail .trail-step")].map((row) => row.className.includes("route-miss") ? "↩ " + row.innerText : row.innerText)]`).catch(() => []) as string[];

      if (seen[0]) titles.add(seen[0].replace(/\s+/g, " "));

      for (const row of seen.slice(1)) trail.add(row.replace(/\s+/g, " "));

      // 侧栏正在照走时的样子：出现核对那一行或对不上那一行时截一张。
      if (!shot && seen.slice(1).some((row) => row.includes("核对") || row.startsWith("↩"))) {
        shot = true;
        await rp.screenshot(panel, join(artifacts, `running-${name}.png`)).catch(() => undefined);
      }

      await sleep(150);
    }
  })();

  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 240_000, name, 500);
  finished = true;
  await watch;
  runs.push({ name, text, seconds: Math.round((Date.now() - started) / 1000), titles: [...titles], trail: [...trail] });
  await sleep(2500);
};

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "默认会话建好");

  const base = `http://127.0.0.1:${siteAddress(site).port}/`;

  // 第一次：一步步做，记下做法。
  await ask("第一次", `在当前网页订会议室：10 月 8 日（周四）15:00–16:00，青松，主题写周会。直接点预订。${selectorFirst ? "日期、时间、主题和预订按钮用 #date、#time、#topic、#submit 这些选择器定位。" : ""}`, base);
  assert.deepEqual(booked(0), { date: "10 月 8 日（周四）", time: "15:00–16:00", room: "青松", topic: "周会" }, "第一次订对");
  const first = (await tasks()).find((t) => t.goal.includes("青松"));
  evidence.route = first?.route ?? null;
  assert.ok(first?.route, "第一次记下了做法");

  // R1：同一类事，照上次的做法走，值换成这次的。
  await ask("照上次走", "在当前网页订会议室：10 月 15 日（周四）14:00–15:00，白桦，主题写复盘。直接点预订。", base);
  assert.deepEqual(booked(1), { date: "10 月 15 日（周四）", time: "14:00–15:00", room: "白桦", topic: "复盘" }, "照上次走订对：四个值都是这次的");

  // YIS-96 R2：「下周四」不在页面写法里（期望值按 2026-10-07 周三写：下周四是 10 月 15 日），要做一次核对判断；核对过了才提交。
  await ask("换个说法", "在当前网页订会议室：下周四 15:00–16:00，青松，主题写周会。直接点预订。", base);
  assert.deepEqual(booked(2), { date: "10 月 15 日（周四）", time: "15:00–16:00", room: "青松", topic: "周会" }, "「下周四」订成 10 月 15 日");

  // R2：页面改版，照走停在对不上的那一步，模型接着做完。
  await ask("页面改了", "在当前网页订会议室：10 月 15 日（周四）16:00–17:00，银杏，主题写评审。直接点预订。", `${base}?v=2`);
  assert.deepEqual(booked(3), { date: "10 月 15 日（周四）", time: "16:00–17:00", room: "银杏", topic: "评审" }, "页面改了仍订对");
  assert.equal(bookings.length, 4, "一共只订了四次，没有多订或订错");
  await rp.screenshot(panel, join(artifacts, "panel.png"));

  // 诊断记录：每次请求用没用照走、走了几步、等了几次模型。
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
  const lines = traces.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId?: string; type: string; data?: { text?: string; toolName?: string; isError?: boolean; ok?: boolean; literal?: boolean; elapsedMs?: number; result?: { content?: Array<{ text?: string }> } } });

  for (const run of runs) {
    const runId = lines.find((l) => l.type === "run_start" && l.data?.text?.includes(String(run.text)))?.runId;
    const mine = lines.filter((l) => l.runId === runId);
    run.modelRequests = mine.filter((l) => l.type === "model_request").length;
    run.tools = mine.filter((l) => l.type === "tool_execution_end").map((l) => l.data?.toolName ?? "?");
    run.routeChecks = mine.filter((l) => l.type === "route_check").map((l) => `${l.data?.ok ? "通过" : "没过"}${l.data?.literal ? "（原话直通）" : `（判断 ${l.data?.elapsedMs} ms）`}`);
    // 程序代码在诊断记录里被隐去：用记做法时数下的「按选择器定位的步数」。
    run.bySelector = Math.max(0, ...lines.filter((l) => l.type === "route_verdict" && (l.runId === runId || (l.data as { runId?: string } | undefined)?.runId === runId)).map((l) => Number((l.data as { bySelector?: number } | undefined)?.bySelector ?? 0)));
    run.followRoute = mine.filter((l) => l.type === "tool_execution_end" && l.data?.toolName === "follow_route").map((l) => `${l.data?.isError ? "ERROR " : ""}${l.data?.result?.content?.[0]?.text ?? ""}`.slice(0, 400));
  }

  evidence.runs = runs;
  const followed = (run: JsonRecord | undefined) => String(Array.isArray(run?.followRoute) ? run.followRoute[0] ?? "" : "");
  if (selectorFirst) assert.ok(Number(runs[0]?.bySelector) > 0, "第一次确实有步骤按选择器定位");
  assert.match(followed(runs[1]), /^Followed all/, "第二次照上次的做法走完");
  // 换个说法：照走模型可能把「下周四」算错；核对拦下改正也算对，只要最后订对、没有先订错。
  assert.match(followed(runs[2]), /^Followed all|the check before submitting found/, "换个说法：照上次的做法走完，或被核对拦在提交前");
  assert.match(followed(runs[3]), /Stopped before step 3/, "页面改了：停在第 3 步（会议室按钮）");
  const list = (run: JsonRecord | undefined, key: string) => (Array.isArray(run?.[key]) ? run[key].map(String) : []);
  assert.deepEqual(list(runs[1], "routeChecks"), ["通过（原话直通）"], "值都在原话里：核对直接过");
  assert.match(list(runs[2], "routeChecks").join(), /（判断 \d+ ms）/, "「下周四」：核对问了模型");
  assert.ok(list(runs[1], "titles").some((t) => /^照上次的做法 第 \d\/5 步$/.test(t)), "侧栏标题写「照上次的做法 第 N/5 步」");
  assert.ok(list(runs[1], "trail").some((t) => t.includes("核对过了：和你这次说的一致")), "侧栏留一行「核对过了」");
  assert.ok(list(runs[3], "trail").some((t) => t.startsWith("↩") && t.includes("第 3 步对不上：找不到上次点的「选择」，改为一步步看")), "页面改了：侧栏留一行「第 3 步对不上…」");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
  evidence.panelText = panel ? await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-1500)`).catch(() => null) : null;
  evidence.runs = runs;
  evidence.bookings = [...bookings];

  if (panel) await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence: { runs: evidence.runs, bookings }, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
