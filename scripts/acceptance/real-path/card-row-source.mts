/**
 * 卡片行回原页。
 *   npx tsx scripts/acceptance/real-path/card-row-source.mts --headless
 * 开三个本机商店页（价格都写在普通 span 里；第三页同一个价写了两处），脚本模型写一张比价卡，三行各带 tab，另有一行算出来的差价。
 * 看前两行可点（京东那一行是“标价 + 运费”的算式，圈标价）、第三行和没写 tab 的差价不可点；点天猫那一行，前台换成天猫页、页面上出现圈画；重开侧栏后照样可点。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-card-row-source`);

await mkdir(artifacts, { recursive: true });

const TASK = "这三家哪家到手最便宜";

const shop = (name: string, body: string) => `<!doctype html><meta charset="utf-8"><title>${name}</title><div class="sku"><h1>${name} AirPods Pro 3</h1>${body}<div class="spacer" style="height:1600px"></div><div class="foot">${name} 版权所有</div></div>`;

const PAGES: Record<string, string> = {
  "/jd": shop("京东", `<div class="price"><span class="sym">¥</span><span class="num">2,399</span></div><div>次日达</div>`),
  "/tmall": shop("天猫", `<div class="spacer" style="height:900px"></div><div class="price"><span>¥2,459</span><em>包邮</em></div>`),
  "/dup": shop("另一家", `<div class="price"><span>¥2,599</span></div><div class="side">到手价 ¥2,599</div>`),
  "/mail": `<!doctype html><meta charset="utf-8"><title>邮箱</title><div class="inbox">账户余额 ¥8,888</div>`,
};

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGES[req.url ?? ""] ?? "<!doctype html><title>空</title>"));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const rules: Rule[] = [{ match: TASK, steps: [{ text: "", chunkDelayMs: 30 }] }];

/** 真读过的页面才会进回答的出处清单，行只连得到清单里的页：脚本模型先把三页都读一遍。 */
const readAll = (tabs: Record<string, number>) => Object.values(tabs).map(tabId => ({ tool: { name: "snapshot", args: { tabId } } }));

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const ROWS = `[...document.querySelectorAll("#messages .gen-card .gc-stat")].map(s => ({ label: s.querySelector(".k span")?.textContent, linked: s.classList.contains("gc-linked") }))`;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/jd` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  // 另外两页在后台开，不抢前台。
  await rp.evaluate(panel, `Promise.all(["/tmall", "/dup", "/mail"].map(p => chrome.tabs.create({ url: ${JSON.stringify(origin)} + p, active: false }))).then(() => true)`);
  // SAFETY: 表达式返回 {jd, tmall, dup} 三个标签页编号。
  const tabs = await until(async () => {
    const ids = await rp.evaluate(panel, `chrome.tabs.query({}).then(ts => { const id = p => ts.find(t => (t.url || "").endsWith(p) && t.status === "complete")?.id; return { jd: id("/jd"), tmall: id("/tmall"), dup: id("/dup"), mail: id("/mail") }; })`) as Record<string, number | undefined>;
    return ids.jd && ids.tmall && ids.dup && ids.mail ? ids as Record<string, number> : undefined;
  }, 15_000, "三个商店页");
  // 邮箱页这一轮没读过：模型被带偏写了它的编号，侧栏也不该去那一页。
  rules[0]!.steps.unshift(...readAll({ jd: tabs.jd!, tmall: tabs.tmall!, dup: tabs.dup! }));
  (rules[0]!.steps.at(-1) as { text: string }).text = `京东最便宜。
<card title="AirPods Pro 3 到手价">
<stat label="京东" value="=2399+0" unit="¥" note="次日达，运费 0" tab="${tabs.jd}" tag="最低" />
<stat label="天猫" value="2459" unit="¥" note="包邮" tab="${tabs.tmall}" />
<stat label="另一家" value="2599" unit="¥" tab="${tabs.dup}" />
<stat label="比天猫省" value="=2459-2399" unit="¥" />
<stat label="邮箱" value="8888" unit="¥" tab="${tabs.mail}" />
</card>`;

  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `!!document.querySelector("#messages .msg.assistant .answer-actions") && !!document.querySelector("#messages .gen-card[data-gc-card]") && !document.querySelector("#messages .msg.assistant.streaming")`) || undefined, 60_000, "回答写完");

  // R1、R3：价格在普通 span 里也找得到；同一个价写了两处的那一行、算出来的那一行不可点。
  const rows = await until(async () => { const r = await rp.evaluate(panel, ROWS) as Array<{ label: string; linked: boolean }>; return r.filter(x => x.linked).length >= 2 ? r : undefined; }, 15_000, "可点的行").catch(async () => await rp.evaluate(panel, ROWS) as Array<{ label: string; linked: boolean }>);
  evidence.rows = rows;
  await sleep(1_000);
  await rp.screenshot(panel, join(artifacts, "1-linked.png"));
  assert.deepEqual(rows, [{ label: "京东", linked: true }, { label: "天猫", linked: true }, { label: "另一家", linked: false }, { label: "比天猫省", linked: false }, { label: "邮箱", linked: false }], `R1: only rows with a unique page number are clickable, 天猫那一行不可点 if missing: ${JSON.stringify(rows)}`);

  // R2：前台是京东页，点天猫那一行 → 前台换成天猫页，天猫页上出现圈画。
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.id === ${tabs.jd})`) || undefined, 5_000, "京东页在前台");
  await rp.evaluate(panel, `document.querySelectorAll("#messages .gen-card .gc-stat")[1].scrollIntoView({ block: "center" }), true`);
  await sleep(100);
  await rp.click(panel, "#messages .gen-card .gc-stat:nth-child(2)");
  await until(async () => await rp.evaluate(panel, `chrome.tabs.query({ active: true, lastFocusedWindow: true }).then(([t]) => t?.id === ${tabs.tmall})`) || undefined, 5_000, "R2: 天猫页到前台");
  const tmallTarget = (await rp.targets()).find(t => t.type === "page" && t.url.endsWith("/tmall"))!;
  const tmall = await rp.attach(tmallTarget.targetId);
  const circled = await until(async () => await rp.evaluate(tmall, `!!document.querySelector('[data-sideagent-overlay="sonar"]')`) || undefined, 5_000, "R2: 天猫页上的圈画").catch(() => false);
  // 价格在页面下面，圈之前要滚过去。
  const scrolled = await rp.evaluate(tmall, `scrollY > 300`);
  evidence.reveal = { circled, scrolled };
  await rp.screenshot(tmall, join(artifacts, "2-tmall-circled.png"));
  assert.ok(circled, "R2: the number is circled on the 天猫 page");
  assert.ok(scrolled, "R2: the 天猫 page scrolled to the price");

  // 重开侧栏：回放出来的卡片照样可点。
  await rp.cdp.send("Page.reload", {}, panel);
  const replay = await until(async () => { const r = await rp.evaluate(panel, ROWS).catch(() => []) as Array<{ label: string; linked: boolean }>; return r.filter(x => x.linked).length >= 2 ? r : undefined; }, 30_000, "重开后可点").catch(() => null);
  evidence.replay = replay;
  assert.ok(replay, "reopen: rows are clickable again");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
