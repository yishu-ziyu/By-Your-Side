/**
 * 侧栏「做了 N 件事」里每一步都有自己的图标，不再有的只是一个点（docs/evals/20261007-reinject-and-step-icons.md R2）。
 *   npx tsx scripts/acceptance/real-path/step-icons.mts --headless
 * 脚本模型依次调用打开页面、执行脚本、连续操作、悬停、按键、标注、点击，再回一句话；展开过程，截图并读出每一步的图标种类。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-step-icons`);

await mkdir(artifacts, { recursive: true });

const TASK = "把这页的几种操作都走一遍";

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>步骤图标</title><h1>步骤图标</h1><button id="go">打开 Google DeepMind</button>`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const model = await startScriptedModel([{ match: TASK, steps: [
  { tool: { name: "navigate", args: { url: `${origin}/next` } } },
  { tool: { name: "js", args: { code: "document.title" } } },
  { tool: { name: "browser_run", args: { label: "查找 EmbeddingGemma 2 的 X 帖文", code: "return 1;" } } },
  { tool: { name: "hover", args: { target: "h1", label: "标题" } } },
  { tool: { name: "press_key", args: { key: "Escape" } } },
  { tool: { name: "mark", args: { target: "h1", label: "标题" } } },
  { tool: { name: "click", args: { target: "#go", label: "打开 Google DeepMind" } } },
  { text: "都走了一遍。" },
] }]);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: { kinds?: string[]; rows?: string[] } = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/start` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, TASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(m => m.textContent.includes("都走了一遍"))`) || undefined, 90_000, "answer");
  await sleep(1_500);
  // 展开「做了 N 件事」。
  await rp.evaluate(panel, `(() => { const t = [...document.querySelectorAll("#messages button, #messages summary")].find(b => /^做了 \\d+ 件事/.test(b.textContent.trim())); t?.click(); return !!t; })()`);
  await sleep(600);
  // SAFETY: 表达式返回字符串数组。
  evidence.kinds = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip:not(.prep)")].map(c => c.dataset.kind)`) as string[];
  evidence.rows = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip:not(.prep)")].map(c => c.textContent.trim().slice(0, 30))`) as string[];
  await rp.screenshot(panel, join(artifacts, "steps.png"));
  assert.ok(evidence.kinds.length >= 6, `R2: steps rendered ${JSON.stringify(evidence.kinds)}`);
  assert.ok(!evidence.kinds.includes("other"), `R2: every step has its own icon ${JSON.stringify(evidence.kinds)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
