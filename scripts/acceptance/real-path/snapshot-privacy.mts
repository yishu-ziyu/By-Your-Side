/**
 * 读页面不能把卡号、安全码、PIN 交给模型（docs/evals/20261010-snapshot-privacy.md）。只装扩展、隔离构建、本机脚本模型、本机练习页。
 *   npx tsx scripts/acceptance/real-path/snapshot-privacy.mts --headless
 *   a) 页面上已填好 cc-number、cc-csc、name=card_number、name=pin、一个密码栏和一个普通栏。助手读页（snapshot），
 *      点「显示」把密码栏变成 type=text，再读一次页：模型收到的请求里没有任何敏感值，有普通值；卡号那一行仍写明「已填」。
 *   b) 助手用 read_element 读 name=card_number 那一栏：模型收到的请求里没有它的值。
 * 失败方式：exec/snapshot.ts 的 readSecretFields 返回空集合，a 失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-snapshot-privacy`);

await mkdir(artifacts, { recursive: true });

const SECRET = { ccNumber: "4242424242424242", csc: "9081", cardNumber: "5555444433331111", pin: "8642", toggled: "ZQtoggle7731" };
const PLAIN = "PLAINZQ7777";

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pay</title></head><body><main>
<label>Card <input id="a" autocomplete="cc-number" value="${SECRET.ccNumber}"></label><br>
<label>Security <input id="c" autocomplete="cc-csc" value="${SECRET.csc}"></label><br>
<label>Field X <input id="d" name="card_number" value="${SECRET.cardNumber}"></label><br>
<label>Field Y <input id="e" name="pin" value="${SECRET.pin}"></label><br>
<label>Field Z <input id="t" type="password" value="${SECRET.toggled}"></label> <button id="show" onclick="document.getElementById('t').type='text'">Show</button><br>
<label>Note <input id="f" value="${PLAIN}"></label>
</main></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

const ASK = "读页隐私：读一下这页，显示密码后再读一次，再读字段 X。";
const DONE = "读页隐私读完了。";

/** 模型收到的全部请求原文，和其中每条工具结果。 */
const requests: string[] = [];
const toolTexts: string[] = [];

const model = await startScriptedModel([
  { match: ASK, steps: [
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "click", args: { target: "#show" } } },
    { tool: { name: "snapshot", args: {} } },
    { tool: { name: "read_element", args: { target: "#d" } } },
    { text: DONE },
  ] },
], undefined, payload => {
  requests.push(JSON.stringify(payload));

  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    if (m.role === "tool" && !toolTexts.includes(text)) toolTexts.push(text);
  }
});

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `${model.baseUrl}` },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
  };

  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""')).includes(DONE) || undefined, 60_000, "answer", 100);
  await rp.screenshot(panel, join(artifacts, "sidebar.png"));

  const all = requests.join("\n");
  const snapshots = toolTexts.filter(t => /textbox "Note"/.test(t));
  const reads = toolTexts.filter(t => t.includes('"name":"card_number"'));
  evidence.snapshots = snapshots;
  evidence.reads = reads;
  await writeFile(join(artifacts, "model-requests.json"), all);

  // 不空判：两次快照、一次 read_element 的结果都进了模型请求，普通值照常可见。
  assert.ok(snapshots.length >= 2, `two snapshot results reached the model: ${JSON.stringify(toolTexts)}`);
  assert.ok(reads.length >= 1, `the read_element result reached the model: ${JSON.stringify(toolTexts)}`);
  assert.ok(all.includes(PLAIN), "a: the plain field value reaches the model");

  // a) 敏感值哪一次都没有；卡号行和切成明文的密码行写明已填。
  for (const [key, value] of Object.entries(SECRET)) assert.ok(!all.includes(value), `a/b: ${key} value is not in any model request`);

  assert.ok(snapshots.every(t => /textbox "Field X"[^\n]*value=<filled, hidden>/.test(t)), "a: the card line says it is filled");
  assert.ok(/textbox "Field Z"[^\n]*value=<filled, hidden>/.test(snapshots.at(-1)!), "a: the toggled password line says it is filled");

  // b) read_element 的结果里有这一栏，但不是它的值。
  assert.ok(reads.some(t => t.includes("16 chars")), `b: read_element reports only the length: ${JSON.stringify(reads)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice page", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
