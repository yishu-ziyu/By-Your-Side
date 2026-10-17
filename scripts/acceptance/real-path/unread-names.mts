/**
 * 回答列出的人名在这次读到的内容里都找不到，就不算做完：助手要回去读到名字所在的原文（PDF 只读了前几页就编出 25 个作者名）。
 * 只装扩展、隔离构建、本机脚本模型；本机转发服务把每次核对请求都改写成脚本结论「做完」，所以拦下编造只能靠宿主。
 *   npx tsx scripts/acceptance/real-path/unread-names.mts --headless
 * 网页正文开头只有目录，作者名单在约 9,000 字之后（超出交给核对模型的截断长度）。
 * 助手先读页，再答出 4 个页面上没有的名字；核对催一次后，助手读作者名单，答出页面上真有的 4 个名字。
 * 判据：第一轮之后过程行出现「核对发现：回答里的 4 个名字…」；最后显示的回答是真名单、不再单独显示编造的名单；
 * 一共只核对两次（真名单在截断之外也不误拦，没有来回打转）。
 * 失败方式：去掉宿主的名字检查，第一份编造的回答直接判做完，没有「核对发现」。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-unread-names`);

await mkdir(artifacts, { recursive: true });

const TASK = "这份报告的作者都有谁？";

const FAKE = "报告作者有：Eleanor Kinney、Samantha Campbell、Sanjay Ramaswamy、Colin Duarte。";

const REAL = "更正：作者名单页列出 Derek DeBellis、Kevin M. Storer、Amanda Lewis、Benjamin Good。";

const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";

const model = await startScriptedModel([
  { match: TASK, steps: [{ tool: { name: "snapshot", args: {} } }, { text: FAKE }] },
  { match: "[GOAL CHECK]", steps: [{ tool: { name: "read_element", args: { target: "#authors" } } }, { text: REAL }] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
]);

let checks = 0;

const proxy = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  let forward = body;

  if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
    checks += 1;
    const original: unknown = JSON.parse(body);
    forward = JSON.stringify({ ...(typeof original === "object" && original ? original : {}), messages: [{ role: "user", content: "GOAL-CHECK-DONE" }] });
  }

  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? forward : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

const filler = Array.from({ length: 60 }, (_, i) => `<p>第 ${i + 1} 节：本节讨论软件交付表现与团队实践之间的关系，样本来自全球数千名从业者的调查回答。</p>`).join("");

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>2024 年度报告</title></head><body>
<h1>2024 年度报告</h1><p>目录：引言 …… 3；方法 …… 70；作者 …… 87</p>${filler}
<section id="authors"><h2>作者</h2><p>Derek DeBellis</p><p>Kevin M. Storer</p><p>Amanda Lewis</p><p>Benjamin Good</p></section></body></html>`);
});

await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

const SAMPLE_JS = `(() => {
  const m = document.querySelector("#messages");
  const vis = el => el.getClientRects().length > 0;
  const outside = m.cloneNode(true);
  outside.querySelectorAll("details.run-steps").forEach(n => n.remove());
  return {
    fix: [...m.querySelectorAll("details.run-steps > summary > .run-meta")].map(el => el.textContent.trim()).filter(t => t.startsWith("核对发现")),
    answers: [...m.querySelectorAll(".msg.assistant[data-delivery-id]")].filter(vis).map(el => el.textContent.trim()),
    outside: outside.textContent,
  };
})()`;

type Sample = { fix: string[]; answers: string[]; outside: string };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/report` }, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);

  const seenFix = new Set<string>();
  const final = await until(async () => {
    const sample = await rp.evaluate(panel, SAMPLE_JS) as Sample;
    sample.fix.forEach(text => seenFix.add(text.split(" · ")[0]!));
    return checks >= 2 && sample.answers.some(text => text.includes("Derek DeBellis")) ? sample : undefined;
  }, 90_000, "续做后交付真名单并核对第二次");
  // 再等一会，确认不会出现第三次核对。
  await sleep(4_000);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  const settled = await rp.evaluate(panel, SAMPLE_JS) as Sample;

  Object.assign(evidence, { checks, fix: [...seenFix], answers: settled.answers, fakeOutsideProcess: settled.outside.includes("Eleanor Kinney") });
  assert.ok([...seenFix].some(text => text.startsWith("核对发现：回答里的 4 个名字")), `the process line says the 4 names were not read: ${JSON.stringify([...seenFix])}`);
  assert.ok(final.answers.at(-1)?.includes("Derek DeBellis"), `the last answer is the real list: ${JSON.stringify(final.answers)}`);
  assert.equal(settled.outside.includes("Eleanor Kinney"), false, "the fabricated list is no longer shown outside the folded process");
  assert.equal(checks, 2, `two goal checks only: the real list beyond the checker's cut is not flagged (${checks})`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  proxy.closeAllConnections();
  proxy.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
