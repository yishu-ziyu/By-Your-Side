/**
 * 同一件事在 3 个不同对话里做过，侧栏才问「你好像总是…，要我记住吗？」；点「记住」才存。
 * 只装扩展、隔离构建、本机脚本模型；只有模型回复是脚本（习惯判断答固定的 key）。
 *   npx tsx scripts/acceptance/real-path/habit-ask.mts --headless
 * 失败方式：第 1、2 次就问；第 3 次不问；卡片文字不是那句做法；点「记住」后记忆里没有这条做法。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-habit-ask`);

await mkdir(artifacts, { recursive: true });

let saves = 0;

const site = createServer((req, res) => {
  if (req.url === "/save") { saves++; res.writeHead(204).end();

 return; }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>视频页</title><h1>一段视频</h1><button id="save" onclick="fetch('/save')">提取字幕并保存</button>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const HOST = "bili.example";

const GOAL = "提取字幕并保存";

const HABIT = "在 B 站提取字幕并保存";

// 习惯判断的输入是 JSON，带 "hosts" 字段；主任务的话里没有。这条放前面，先于任务规则匹配。
const model = await startScriptedModel([
  { match: "\"hosts\":", steps: [{ text: JSON.stringify({ key: "bilibili:subtitle-save", habit: HABIT }) }] },
  { match: GOAL, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "#save" } } },
    { text: "字幕已保存。" },
  ] },
]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

let error: string | null = null;

/** 写进 result.json 的证据。 */
type Evidence = { stage?: string; cardsAfter?: number[]; cardText?: string; memory?: unknown; habits?: unknown; saves?: number };

const evidence: Evidence = { cardsAfter: [] };

let panel = "";

const habitRequests = () => model.requests.filter(r => r.rule === "\"hosts\":").length;

const cards = async () => Number(await rp.evaluate(panel, "document.querySelectorAll('[data-memory-ask]').length"));

const settled = 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false';

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://${HOST}/` }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await rp.cdp.send("Page.bringToFront", {}, work);
  await sleep(3000);
  await until(async () => await rp.evaluate(panel, settled) || undefined, 60_000, "sidebar ready");

  for (let n = 1; n <= 3; n++) {
    evidence.stage = `task ${n}`;

    // 每次都在一个新对话里做同一件事。
    if (n > 1) {
      await rp.click(panel, "#conversation-new");
      await sleep(500);
      await until(async () => await rp.evaluate(panel, `${settled} && !document.querySelector("#messages .msg.user")`) || undefined, 30_000, `new conversation ${n}`);
    }

    await rp.click(panel, "#input");
    await rp.typeText(panel, `帮我把这个视频${GOAL}（第 ${n} 个视频）`);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("字幕已保存。") && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 90_000, `task ${n} finished`);
    await until(async () => habitRequests() >= n || undefined, 30_000, `habit judgment ${n}`);

    if (n < 3) {
      await sleep(2500);
      evidence.cardsAfter!.push(await cards());
      assert.equal(await cards(), 0, `no ask card after task ${n}`);
    }
  }

  evidence.saves = saves;
  assert.equal(saves, 3, "each task really clicked save on the page");

  // 第 3 个对话：问一次，文字是「你好像总是<做法>，要我记住吗？」。
  evidence.stage = "ask";
  await until(async () => await cards() > 0 || undefined, 20_000, "ask card after task 3");
  evidence.cardsAfter!.push(await cards());
  evidence.cardText = String(await rp.evaluate(panel, `document.querySelector("[data-memory-ask] .memory-ask-line")?.textContent ?? ""`));
  await rp.evaluate(panel, `document.querySelector("[data-memory-ask]").scrollIntoView({block:"center"}); true`);
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, "habit-ask-card.png"));
  assert.equal(evidence.cardText, `你好像总是${HABIT}，要我记住吗？`);

  // 点「记住」才存：存成一条这个网站的做法。
  evidence.stage = "remember";
  await rp.click(panel, '[data-memory-ask] [data-memory-ask-answer="remember"]');
  await until(async () => await rp.evaluate(panel, `document.querySelector("[data-memory-ask]")?.dataset.state === "remembered"`) || undefined, 15_000, "card shows remembered");
  await rp.screenshot(panel, join(artifacts, "habit-remembered.png"));
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "extension page");

  const read = (key: string) => rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get(${JSON.stringify(key)}); q.onsuccess = () => res(JSON.parse(q.result ?? "null")); q.onerror = () => rej(q.error); }; })`);

  // SAFETY: memories 文档是 {entries:[MemoryEntry]}，这里只取比对要用的字段。
  const memories = await read("memories") as { entries?: Array<{ text: string; kind: string; status: string; scope: { kind: string; hostname?: string } }> } | null;
  const saved = (memories?.entries ?? []).filter(e => e.status === "active").map(e => ({ text: e.text, kind: e.kind, scope: e.scope }));
  evidence.memory = saved;
  evidence.habits = await read("habits");
  assert.deepEqual(saved, [{ text: HABIT, kind: "method", scope: { kind: "site", hostname: HOST } }], "remember stores exactly that habit as a site method");
  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
