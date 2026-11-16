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

const LATER = ["在 Docs 里搜 guide", "读完 README 回到项目首页"];

const model = await startScriptedModel([
  { match: "\"known\":", steps: [{ text: JSON.stringify({ habits: [{ key: "demo:readme-docs-install", habit: HABIT, hosts: [HOST], days: [YESTERDAY, TODAY], times: 3 }, ...LATER.map((habit, i) => ({ key: `demo:later-${i}`, habit, hosts: [HOST], days: [YESTERDAY, TODAY], times: 2 }))] }) }] },
]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${siteAddress(site).port}`, "--no-proxy-server"] });

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let panel = "";

const inductions = () => model.requests.filter(r => r.rule === "\"known\":").length;

const cards = async () => Number(await rp.evaluate(panel, "document.querySelectorAll('[data-memory-ask]').length"));

const openCards = async () => Number(await rp.evaluate(panel, `document.querySelectorAll('[data-memory-ask][data-state="open"]').length`));

const panelReady = 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false';

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
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false') || undefined, 60_000, "sidebar ready");
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => (await rp.evaluate(ext, `document.readyState === "complete"`)) || undefined, 10_000, "extension page");
  const storage = (key: string) => rp.evaluate(ext, `chrome.storage.local.get(${JSON.stringify(key)}).then(s => s[${JSON.stringify(key)}] ?? null)`);

  evidence.stage = "today";
  await rp.cdp.send("Page.navigate", { url: `http://${HOST}/?again` }, work);
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
  await sleep(2500);
  evidence.cardsAfterInduction = await cards();
  assert.equal(evidence.cardsAfterInduction, 1, "three habits found at once still ask one thing");
  const waiting = String(await rp.evaluate(panel, `document.querySelector('[data-memory-group="seen"]')?.textContent ?? ""`));
  assert.ok(LATER.every(habit => waiting.includes(habit)), "the ones not asked stay in the seen list");
  assert.ok(String(evidence.cardEvidence).includes("来自你自己的浏览"), "the card says where it came from");

  evidence.stage = "remember";
  await rp.click(panel, '[data-memory-ask] [data-memory-ask-answer="remember"]');
  await until(async () => await rp.evaluate(panel, `document.querySelector("[data-memory-ask]")?.dataset.state === "remembered"`) || undefined, 15_000, "card shows remembered");
  await rp.screenshot(panel, join(artifacts, "habit-remembered.png"));
  const memories = await rp.evaluate(ext, `new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onerror = () => rej(r.error);
    r.onsuccess = () => { const q = r.result.transaction("kv").objectStore("kv").get("memories"); q.onsuccess = () => res(JSON.parse(q.result ?? "null")); q.onerror = () => rej(q.error); }; })`) as { entries?: Array<{ text: string; kind: string; status: string; scope: { kind: string; hostname?: string } }> } | null;
  const saved = (memories?.entries ?? []).filter(e => e.status === "active").map(e => ({ text: e.text, kind: e.kind, scope: e.scope }));
  evidence.memory = saved;
  assert.deepEqual(saved, [{ text: HABIT, kind: "method", scope: { kind: "site", hostname: HOST } }], "remember stores the habit as a site method");
  const induceAgain = async (n: number, patch: string) => {
    await rp.evaluate(ext, `chrome.storage.local.get("sideagent_browse_log").then(s => { const log = s.sideagent_browse_log; log.lastAt = 0; log.since = 4; ${patch} return chrome.storage.local.set({ sideagent_browse_log: log }); }).then(() => true)`);
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(work, "#q");
    await rp.typeText(work, " more");
    await rp.pressEnter(work);
    await until(async () => inductions() >= n || undefined, 30_000, `induction ${n}`);
  };

  evidence.stage = "same day";
  await induceAgain(3, "");
  await sleep(3000);
  evidence.openSameDay = await openCards();
  assert.equal(evidence.openSameDay, 0, "a second habit is not asked on the same day");

  evidence.stage = "next day";
  await induceAgain(4, "log.askedAt = 0;");
  await until(async () => await openCards() === 1 || undefined, 20_000, "next habit asked a day later");
  evidence.nextCardText = String(await rp.evaluate(panel, `document.querySelector('[data-memory-ask][data-state="open"] .memory-ask-line')?.textContent ?? ""`));
  assert.ok(LATER.some(habit => evidence.nextCardText === `你好像每次都这样做：${habit}。要我记住吗？`), "the next card asks one of the waiting habits");

  evidence.stage = "reopen";
  await rp.cdp.send("Page.reload", {}, panel);
  await until(async () => await rp.evaluate(panel, panelReady) || undefined, 60_000, "sidebar ready after reopen");
  await until(async () => await cards() > 0 || undefined, 20_000, "answered card replayed");
  await sleep(1500);
  await rp.screenshot(panel, join(artifacts, "reopened.png"));
  evidence.openAfterReopen = await openCards();
  assert.equal(evidence.openAfterReopen, 0, "an unanswered habit question is not waiting when the panel opens");
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
