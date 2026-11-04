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

  assert.ok(snapshots.length >= 2, `two snapshot results reached the model: ${JSON.stringify(toolTexts)}`);
  assert.ok(reads.length >= 1, `the read_element result reached the model: ${JSON.stringify(toolTexts)}`);
  assert.ok(all.includes(PLAIN), "a: the plain field value reaches the model");

  for (const [key, value] of Object.entries(SECRET)) assert.ok(!all.includes(value), `a/b: ${key} value is not in any model request`);

  assert.ok(snapshots.every(t => /textbox "Field X"[^\n]*value=<filled, hidden>/.test(t)), "a: the card line says it is filled");
  assert.ok(/textbox "Field Z"[^\n]*value=<filled, hidden>/.test(snapshots.at(-1)!), "a: the toggled password line says it is filled");

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
