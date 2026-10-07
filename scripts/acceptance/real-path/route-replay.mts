/**
 * 同一网站、同一类事照上次的做法走；页面改了就停下交回一步步做（YIS-95，docs/evals/20261007-route-replay.md）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/route-replay.mts --headless [--model=provider/id]
 * 失败方式：第二次没照上次走、还是一步步做；照走时值没换（日期、时间、主题、选哪一间）；页面改了还照点、点错或订错；
 *   停下后模型没接着做完；订了不止一次。
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
<label>日期 <select id="date"><option value="">选择日期</option><option>10 月 9 日（周四）</option><option>10 月 16 日（周四）</option></select></label>
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
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 240_000, name, 500);
  runs.push({ name, text, seconds: Math.round((Date.now() - started) / 1000) });
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
  await ask("第一次", "在当前网页订会议室：10 月 9 日（周四）15:00–16:00，青松，主题写周会。直接点预订。", base);
  assert.deepEqual(booked(0), { date: "10 月 9 日（周四）", time: "15:00–16:00", room: "青松", topic: "周会" }, "第一次订对");
  const first = (await tasks()).find((t) => t.goal.includes("青松"));
  evidence.route = first?.route ?? null;
  assert.ok(first?.route, "第一次记下了做法");

  // R1：同一类事，照上次的做法走，值换成这次的。
  await ask("照上次走", "在当前网页订会议室：10 月 16 日（周四）14:00–15:00，白桦，主题写复盘。直接点预订。", base);
  assert.deepEqual(booked(1), { date: "10 月 16 日（周四）", time: "14:00–15:00", room: "白桦", topic: "复盘" }, "照上次走订对：四个值都是这次的");

  // R2：页面改版，照走停在对不上的那一步，模型接着做完。
  await ask("页面改了", "在当前网页订会议室：10 月 16 日（周四）16:00–17:00，银杏，主题写评审。直接点预订。", `${base}?v=2`);
  assert.deepEqual(booked(2), { date: "10 月 16 日（周四）", time: "16:00–17:00", room: "银杏", topic: "评审" }, "页面改了仍订对");
  assert.equal(bookings.length, 3, "一共只订了三次，没有多订或订错");
  await rp.screenshot(panel, join(artifacts, "panel.png"));

  // 诊断记录：每次请求用没用照走、走了几步、等了几次模型。
  const { traces } = await exportDiagnosticsViaSettings(rp, rp.extensionId, join(artifacts, "downloads"));
  // SAFETY: 诊断记录每行是 { runId, type, data } 的 JSON。
  const lines = traces.split("\n").filter(Boolean).map((line) => JSON.parse(line) as { runId?: string; type: string; data?: { text?: string; toolName?: string; isError?: boolean; result?: { content?: Array<{ text?: string }> } } });

  for (const run of runs) {
    const runId = lines.find((l) => l.type === "run_start" && l.data?.text?.includes(String(run.text)))?.runId;
    const mine = lines.filter((l) => l.runId === runId);
    run.modelRequests = mine.filter((l) => l.type === "model_request").length;
    run.tools = mine.filter((l) => l.type === "tool_execution_end").map((l) => l.data?.toolName ?? "?");
    run.followRoute = mine.filter((l) => l.type === "tool_execution_end" && l.data?.toolName === "follow_route").map((l) => `${l.data?.isError ? "ERROR " : ""}${l.data?.result?.content?.[0]?.text ?? ""}`.slice(0, 400));
  }

  evidence.runs = runs;
  const followed = (run: JsonRecord | undefined) => String(Array.isArray(run?.followRoute) ? run.followRoute[0] ?? "" : "");
  assert.match(followed(runs[1]), /^Followed all/, "第二次照上次的做法走完");
  assert.match(followed(runs[2]), /Stopped before step 3/, "页面改了：停在第 3 步（会议室按钮）");
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
