import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-pre-observation-stale`);
await mkdir(out, { recursive: true });
const ask = "请说出当前页面显示的价格。";
const old = "旧价一百元";
const current = "新价二百元";
const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>价格展示</title><main><article><h1>当前价格</h1><p id="price">${old}</p><p>${"这是一条价格信息。".repeat(40)}</p></article></main>`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
let seen = "", chosen = "", sentAt = 0, modelAt = 0;
const model = await startScriptedModel([
  { match: "PREFER_OLD", steps: [{ text: "当前页面显示旧价一百元。" }] },
  { match: "PREFER_NEW", steps: [{ text: "当前页面显示新价二百元。" }] },
], undefined, payload => {
  if (!payload.tools?.length || seen) return;
  const messages = payload.messages ?? [];
  const text = JSON.stringify(messages);
  if (!text.includes(ask)) return;
  modelAt = Date.now();
  seen = text;
  const oldAt = text.indexOf(old), newAt = text.indexOf(current);
  chosen = oldAt >= 0 && (newAt < 0 || oldAt < newAt) ? "PREFER_OLD" : "PREFER_NEW";
  messages.push({ role: "user", content: chosen });
});
const rp = await launchRealPath();
let panel = "", page = "", failed: unknown;
try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 15_000, "工作页");
  page = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, page);
  await until(() => rp.evaluate(page, `document.querySelector("#price")?.textContent === ${JSON.stringify(old)}`), 15_000, "旧页面");
  panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(()=>true)`);
  await until(() => rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`), 60_000, "侧栏就绪");
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  await rp.click(panel, "#input");
  await rp.typeText(panel, ask);
  await sleep(1000);
  await rp.evaluate(page, `document.querySelector("#price").textContent = ${JSON.stringify(current)}; true`);
  sentAt = Date.now();
  await rp.pressEnter(panel);
  await until(async () => seen || undefined, 60_000, "模型收到页面");
  const answer = await until(async () => {
    const text = String(await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].map(m=>m.innerText).join("\\n")`));
    return text.includes(old) || text.includes(current) ? text : undefined;
  }, 30_000, "侧栏显示价格");
  const pageText = String(await rp.evaluate(page, `document.querySelector("#price").textContent`));
  await writeFile(join(out, "result.json"), JSON.stringify({ pageText, oldInModelInput: seen.includes(old), newInModelInput: seen.includes(current), chosen, answer, sendToModelMs: modelAt - sentAt }, null, 2));
  await rp.screenshot(panel, join(out, "answer.png"));
  assert.equal(pageText, current);
  assert.equal(seen.includes(old), false, "当前页面已变，发送给模型的预读正文不能含旧价");
  assert.ok(seen.includes(current), "发送给模型的页面内容应包含新价");
  assert.ok(answer.includes(current), "侧栏回答应显示页面上的新价");
} catch (error) {
  failed = error;
  console.error("FAIL", error);
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}
if (failed) process.exitCode = 1;
else console.log("PASS 当前页面变化后不会带入旧预读");
console.log("证据目录", out);
