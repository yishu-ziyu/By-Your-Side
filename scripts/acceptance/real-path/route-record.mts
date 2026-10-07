/**
 * 在网站上做成一件事后记下这次的做法（YIS-94，docs/evals/20261007-route-record.md）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/route-record.mts --headless [--model=provider/id]
 * 失败方式：订好了却没记做法；做法里存了一次性编号、认不出「哪个选择」；这次说的值没标出来；回答下面没有那一行；
 *   「不用记」只改了字、记忆库里还在，撤销没放回；做到一半被停下也存了做法。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-route-record`);

await mkdir(artifacts, { recursive: true });

const bookings: string[] = [];

const ROOMS = [["青松", "3F-A", "8 人 · 投影"], ["白桦", "3F-B", "12 人 · 白板"], ["银杏", "5F", "30 人 · 视频会议"]];

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
<section aria-label="会议室"><div class="rooms">${ROOMS.map(([n, f, d]) => `<div class="room"><h3>${n}</h3><p>${f} · ${d}</p><button type="button" onclick="pick(this,'${n}')">选择</button></div>`).join("")}</div></section>
<label>会议主题 <input id="topic" placeholder="例如：项目周会"></label>
<button id="submit" type="button" onclick="book()">预订</button> <span id="ok" role="status"></span>
<script>let room="";function pick(b,n){room=n;document.querySelectorAll('.room').forEach(r=>r.classList.remove('picked'));b.closest('.room').classList.add('picked');}
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

// SAFETY: 页面脚本返回字符串。
const routeLine = () => rp.evaluate(panel, `[...document.querySelectorAll(".route-line")].at(-1)?.innerText ?? ""`) as Promise<string>;

let workTarget = "";

try {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "默认会话建好");

  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  workTarget = (await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${siteAddress(site).port}/` })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: workTarget });
  work = await rp.attach(workTarget);
  await sleep(1000);

  // R1：做成一件事，做法记下来。
  const started = Date.now();
  await send("在当前网页订会议室：10 月 9 日（周四）15:00–16:00，青松，主题写周会。直接点预订。");
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 180_000, "订会议室", 500);
  evidence.seconds = Math.round((Date.now() - started) / 1000);
  evidence.bookings = [...bookings];
  assert.equal(bookings.length, 1, "网页收到一次预订");
  assert.match(bookings[0]!, /青松/, "订的是青松");

  const line = await until(async () => (await routeLine()) || undefined, 30_000, "回答下面「记下了这次的做法」");
  evidence.line = line;
  assert.match(line, /记下了这次的做法/, "回答下面写记下了");
  await rp.evaluate(panel, `[...document.querySelectorAll(".route-line .memory-used-toggle")].at(-1).click(), true`);
  await sleep(400);
  evidence.expanded = await routeLine();
  await rp.screenshot(panel, join(artifacts, "route-line.png"));

  const firstTask = async () => (await tasks()).find((t) => t.goal.includes("青松"));
  const saved = await firstTask();
  evidence.route = saved?.route ?? null;
  assert.ok(saved?.route, "过往任务里有做法");
  const steps = saved.route.steps;
  const pickRoom = steps.find((s) => s.action === "click" && s.target?.name === "选择");
  assert.ok(pickRoom, "做法里有「选择」会议室这一步");
  assert.equal(pickRoom.target!.box, "青松", "这一步认得出是青松那张卡片里的「选择」");
  assert.ok(steps.some((s) => s.value?.includes("周会") && s.valueFrom === "said"), "主题「周会」标成这次说的");
  assert.ok(!JSON.stringify(steps).match(/"@\d+"/), "做法里没有一次性编号");

  // R4：「不用记」删掉，撤销放回。
  await rp.evaluate(panel, `[...document.querySelectorAll('.route-line [data-route-action="decline"]')].at(-1).click(), true`);
  await until(async () => (await routeLine()).includes("没有记下") || undefined, 10_000, "「不用记」后那一行改过来");
  evidence.declined = { line: await routeLine(), route: (await firstTask())?.route ?? null };
  assert.equal((await firstTask())?.route, undefined, "「不用记」后过往任务里没有做法");
  await rp.evaluate(panel, `[...document.querySelectorAll('.route-line [data-route-action="undo"]')].at(-1).click(), true`);
  await until(async () => (await routeLine()).includes("记下了") || undefined, 10_000, "撤销后那一行改回来");
  assert.equal((await firstTask())?.route?.steps.length, steps.length, "撤销后做法放回");
  await rp.screenshot(panel, join(artifacts, "route-undo.png"));

  // R2：做到一半被停下，不存做法。
  await rp.evaluate(work, `location.reload(), true`);
  await sleep(1500);
  await send("在当前网页再订一个会议室：10 月 16 日（周四）14:00–15:00，白桦，主题写复盘。直接点预订。");
  await until(async () => (await rp.evaluate(work, `date.value !== "" || time.value !== ""`)) || undefined, 120_000, "开始动手");
  await rp.click(panel, "#send-btn");
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 60_000, "停下");
  await sleep(3000);
  const stopped = (await tasks()).find((t) => t.goal.includes("白桦"));
  evidence.stopped = stopped ? { outcome: stopped.outcome, route: stopped.route ?? null } : null;
  assert.equal(bookings.length, 1, "停下后没有第二次预订");
  assert.ok(!stopped?.route, "被停下的任务没有做法");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
  evidence.panelText = panel ? await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.slice(-1500)`).catch(() => null) : null;
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
