/**
 * 用户自己在网页上点、搜，产品记下来；同一件事出现在 2 个不同日子里，侧栏问「你好像每次都这样做：…。要我记住吗？」，点「记住」存成做法。
 * 只装扩展、隔离构建、本机脚本模型；归纳回复是脚本，它谎称前一天也做过，产品要按记录核对日子。
 * 前一天的记录由夹具写进扩展存储（换不了系统日期），今天的每一步都是真实点击和输入。
 *   npx tsx scripts/acceptance/real-path/browsing-habits.mts --headless
 * 失败方式：只有今天的记录就问；记录里出现密码栏的值；「看到的操作」里看不到归纳结果；有了前一天的记录仍不问；点「记住」后没存成做法。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-browsing-habits`);

await mkdir(artifacts, { recursive: true });

const HOST = "docs.example";

const SECRET = "hunter2-should-never-be-saved";

const page = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px sans-serif;padding:24px">${body}</body>`;

const site = createServer((req, res) => {
  const html = req.url?.startsWith("/docs")
    ? page("Docs · demo", `<h1>Docs</h1><label>Search docs <input id="q" type="search"></label><p>结果会出现在这里。</p><label>Password <input id="pw" type="password"></label><button id="other">别处</button>`)
    : page("demo/project · README", `<h1>README</h1><p>一个演示项目。</p><a id="docs" href="/docs">Docs</a>`);
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const day = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

const TODAY = day(0);

const YESTERDAY = day(-1);

const HABIT = "看项目 README 后打开 Docs 搜 install";

// 归纳请求的输入是 JSON，带 "known" 字段。回复谎称昨天也做过：没有昨天的记录时，产品不能信。
const model = await startScriptedModel([
  { match: "\"known\":", steps: [{ text: JSON.stringify({ habits: [{ key: "demo:readme-docs-install", habit: HABIT, hosts: [HOST], days: [YESTERDAY, TODAY], times: 3 }] }) }] },
]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panel = "";

const inductions = () => model.requests.filter(r => r.rule === "\"known\":").length;

const cards = async () => Number(await rp.evaluate(panel, "document.querySelectorAll('[data-memory-ask]').length"));

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false') || undefined, 60_000, "sidebar ready");
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "extension page");
  const storage = (key: string) => rp.evaluate(ext, `chrome.storage.local.get(${JSON.stringify(key)}).then(s => s[${JSON.stringify(key)}] ?? null)`);

  // 今天：用户自己打开项目页 → 点 Docs → 搜 install 回车 → 在密码栏输入后点别处。
  evidence.stage = "today";
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://${HOST}/` }, work);
  await until(async () => await rp.evaluate(work, `!!document.querySelector("#docs")`) || undefined, 10_000, "project page");
  await sleep(1500);
  await rp.click(work, "#docs");
  await until(async () => await rp.evaluate(work, `!!document.querySelector("#q")`) || undefined, 10_000, "docs page");
  await sleep(1500);
  await rp.click(work, "#q");
  await rp.typeText(work, "install");
  await rp.pressEnter(work);
  await rp.click(work, "#pw");
  await rp.typeText(work, SECRET);
  await rp.click(work, "#other");
  await until(async () => inductions() >= 1 || undefined, 30_000, "first induction");
  await until(async () => (await storage("sideagent_browse_found") as unknown[] | null)?.length || undefined, 15_000, "found saved");
  const log = JSON.stringify(await storage("sideagent_browse_log"));
  evidence.todayLog = log;
  assert.ok(log.includes("install") && log.includes("Docs"), "the user's own search and click are recorded");
  assert.ok(!log.includes(SECRET), "the password value is never recorded");

  // 只有今天的记录：模型说昨天也做过，不算，所以不问；「看到的操作」里显示 1 天。
  await sleep(2500);
  evidence.cardsAfterToday = await cards();
  assert.equal(evidence.cardsAfterToday, 0, "one day of evidence does not ask");
  for (let i = 0; i < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); i += 1) { await rp.click(panel, "#header-more"); await sleep(400); }
  await rp.click(panel, "#memory-open");
  const seen = await until(async () => String(await rp.evaluate(panel, `document.querySelector('[data-memory-group="seen"]')?.innerText ?? ""`)).includes(HABIT) ? String(await rp.evaluate(panel, `document.querySelector('[data-memory-group="seen"]').innerText`)) : undefined, 10_000, "seen group shows the habit");
  evidence.seenGroup = seen;
  await rp.evaluate(panel, `document.querySelector('[data-memory-group="seen"]').scrollIntoView({block:"start"}); true`);
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, "seen-operations.png"));
  assert.ok(seen.includes("1 天"), "only the day really in the record counts");
  await rp.click(panel, "#memory-close");

  // 昨天的记录（夹具）+ 今天再搜一次：这次有两天的证据，侧栏问一次。
  evidence.stage = "yesterday";
  const at = Date.now() - 86_400_000;
  await rp.evaluate(ext, `chrome.storage.local.get("sideagent_browse_log").then(s => { const log = s.sideagent_browse_log; const lines = ["10:01 打开 ${HOST}/ 「demo/project · README」", "10:01 在 ${HOST} 点「Docs」 → ${HOST}/docs", "10:02 在 ${HOST} 的「Search docs」输入并回车「install」"];
    log.events = [...lines.map((line, i) => ({ at: ${at} + i, day: ${JSON.stringify(YESTERDAY)}, host: ${JSON.stringify(HOST)}, line })), ...log.events]; log.lastAt = 0; log.since = 4; return chrome.storage.local.set({ sideagent_browse_log: log }); }).then(() => true)`);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(work, "#q");
  await rp.typeText(work, " guide");
  await rp.pressEnter(work);
  await until(async () => inductions() >= 2 || undefined, 30_000, "second induction");
  await until(async () => await cards() > 0 || undefined, 20_000, "ask card after two days");
  evidence.cardText = String(await rp.evaluate(panel, `document.querySelector("[data-memory-ask] .memory-ask-line")?.textContent ?? ""`));
  evidence.cardEvidence = String(await rp.evaluate(panel, `document.querySelector("[data-memory-ask-evidence]")?.innerText ?? ""`));
  await rp.evaluate(panel, `document.querySelector("[data-memory-ask-evidence]")?.setAttribute("open", ""); document.querySelector("[data-memory-ask]").scrollIntoView({block:"center"}); true`);
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, "habit-ask-card.png"));
  assert.equal(evidence.cardText, `你好像每次都这样做：${HABIT}。要我记住吗？`);
  assert.ok(String(evidence.cardEvidence).includes("来自你自己的浏览"), "the card says where it came from");

  // 点「记住」才存：存成这个网站的做法。
  evidence.stage = "remember";
  await rp.click(panel, '[data-memory-ask] [data-memory-ask-answer="remember"]');
  await until(async () => await rp.evaluate(panel, `document.querySelector("[data-memory-ask]")?.dataset.state === "remembered"`) || undefined, 15_000, "card shows remembered");
  await rp.screenshot(panel, join(artifacts, "habit-remembered.png"));
  // SAFETY: memories 文档是 {entries:[MemoryEntry]}，这里只取比对要用的字段。
  const memories = await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => res(JSON.parse(q.result ?? "null")); q.onerror = () => rej(q.error); }; })`) as { entries?: Array<{ text: string; kind: string; status: string; scope: { kind: string; hostname?: string } }> } | null;
  const saved = (memories?.entries ?? []).filter(e => e.status === "active").map(e => ({ text: e.text, kind: e.kind, scope: e.scope }));
  evidence.memory = saved;
  assert.deepEqual(saved, [{ text: HABIT, kind: "method", scope: { kind: "site", hostname: HOST } }], "remember stores the habit as a site method");
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
