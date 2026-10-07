/**
 * 新开对话后接着在同一个标签页上动手（YIS-101，docs/evals/20261007-same-tab-new-conversation.md）。真实模型，只装扩展，无头。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/same-tab-new-conversation.mts --headless [--model=provider/id] [--rounds=N]
 * 每一轮：对话一在这页订一间；不换页、新开对话二，再订一间。
 * 失败方式：对话二第一步被「该页正在由其他会话使用」拦下；拦下后模型不敢重做、回答没做成；订少了或多订；订错日期、时间、会议室或主题。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const rounds = Number(process.argv.find((arg) => arg.startsWith("--rounds="))?.slice("--rounds=".length) ?? 1);

const plan = await loadModelPlan(modelArg);

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-same-tab-new-conversation`);

await mkdir(artifacts, { recursive: true });

const bookings: string[] = [];

const site = createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => { bookings.push(body); res.writeHead(200, { "content-type": "application/json" }).end("{}"); });

    return;
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><meta charset="utf-8"><title>会议室预订</title>
<style>body{font:15px system-ui;margin:32px;max-width:760px} label{display:block;margin:12px 0} select,input{font:15px system-ui;padding:6px 8px} #ok{color:green}</style>
<h1>会议室预订</h1>
<label>日期 <select id="date"><option value="">选择日期</option><option>10 月 8 日（周四）</option><option>10 月 15 日（周四）</option></select></label>
<label>时间 <select id="time"><option value="">选择时间</option><option>14:00–15:00</option><option>15:00–16:00</option></select></label>
<label>会议室 <select id="room"><option value="">选择会议室</option><option>青松</option><option>白桦</option></select></label>
<label>会议主题 <input id="topic" placeholder="例如：项目周会"></label>
<button id="submit" type="button" onclick="book()">预订</button> <span id="ok" role="status"></span>
<script>async function book(){const d={date:date.value,time:time.value,room:room.value,topic:topic.value};if(!d.date||!d.time||!d.room||!d.topic){ok.textContent='请填完日期、时间、会议室和主题';return;}
await fetch('/book',{method:'POST',body:JSON.stringify(d)});ok.textContent='预订成功：'+d.date+' '+d.time+' '+d.room+'，主题「'+d.topic+'」';}</script>`);
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let work = "";

const runs: JsonRecord[] = [];

const evidence: JsonRecord = { model: modelArg, rounds, runs };

const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;

/** 新开一个对话，说一句，等做完；查这次恰好多出一张对的订单。 */
const ask = async (name: string, want: { date: string; time: string; room: string; topic: string }) => {
  await rp.click(panel, "#conversation-new");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, `${name}：新对话`);
  const before = bookings.length;
  const started = Date.now();
  await rp.click(panel, "#input");
  await rp.typeText(panel, `在当前网页订会议室：${want.date} ${want.time}，${want.room}，主题写${want.topic}。直接点预订。`);
  await rp.pressEnter(panel);
  await sleep(1500);
  await until(async () => (await rp.evaluate(panel, idle)) || undefined, 240_000, name, 500);
  await sleep(2000);
  const made = bookings.slice(before);
  // SAFETY: 页面脚本返回字符串。
  const reply = await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].at(-1)?.innerText.slice(0, 300) ?? ""`) as string;
  // 侧栏这一轮的步骤和回答里不该出现「其他会话」：被拦后靠模型绕过去也算失败。
  // SAFETY: 页面脚本返回字符串。
  const shown = await rp.evaluate(panel, `[...document.querySelectorAll(".msg")].slice(-6).map((m) => m.textContent).join("\\n")`) as string;
  const blocked = shown.includes("其他会话");
  const ok = !blocked && made.length === 1 && JSON.stringify(JSON.parse(made[0]!)) === JSON.stringify(want);
  runs.push({ name, seconds: Math.round((Date.now() - started) / 1000), made, reply, blocked, ok });
  assert.ok(ok, `${name}：应恰好订对一次，实际 ${JSON.stringify(made)}；回答：${reply}`);
};

try {
  const base = `http://127.0.0.1:${siteAddress(site).port}/`;
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: base })).targetId as string;
  await rp.cdp.send("Target.activateTarget", { targetId: target });
  work = await rp.attach(target);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");

  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);

  await sleep(3000);
  await rp.cdp.send("Target.activateTarget", { targetId: target });

  for (let round = 1; round <= rounds; round++) {
    await ask(`第 ${round} 轮 对话一`, { date: "10 月 8 日（周四）", time: "15:00–16:00", room: "青松", topic: "周会" });
    await ask(`第 ${round} 轮 对话二（同一页）`, { date: "10 月 15 日（周四）", time: "14:00–15:00", room: "白桦", topic: "复盘" });
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (work) await rp.screenshot(work, join(artifacts, "failure-page.png")).catch(() => undefined);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure-panel.png")).catch(() => undefined);
} finally {
  evidence.bookings = [...bookings];
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
