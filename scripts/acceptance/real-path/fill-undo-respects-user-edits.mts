import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-undo-respects-user-edits`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>资料填写</title></head><body>
<form id="form"><label>姓名 <input id="name" name="name"></label></form>
</body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const tool = (name: string, args: Record<string, string>) => ({ tool: { name, args } });
const ASK = { fill: "请填姓名为测试用户A。", undo: "请撤回上一次填写。" };
const DONE = { fill: "姓名填好了。", undo: "这次没改页面上的姓名。" };

const toolTexts: string[] = [];
const model = await startScriptedModel([
  { match: ASK.fill, steps: [tool("fill", { target: "#name", value: "测试用户A" }), { text: DONE.fill }] },
  { match: ASK.undo, steps: [tool("fill", { target: "#name", value: "" }), { text: DONE.undo }] },
], undefined, payload => {
  for (const message of payload.messages ?? []) {
    if (message.role !== "tool") continue;
    const text = Array.isArray(message.content) ? message.content.map(part => part.text ?? "").join("") : message.content ?? "";
    if (text) toolTexts.push(text);
  }
});

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const settled = () => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "turn settled", 100);
  const answerOf = (done: string) => `[...document.querySelectorAll("#messages .msg.assistant")].find(m => m.textContent.includes(${JSON.stringify(done)}))`;
  const cardOf = (a: string) => `(() => { for (let n = ${a}?.previousElementSibling; n && !n.matches(".msg.user"); n = n.previousElementSibling) if (n.matches("details.plan-card")) return n; return null; })()`;
  const seen = async (done: string) => await rp.evaluate(panel, `(() => { const a = ${answerOf(done)}; const card = ${cardOf("a")}; const u = card?.querySelector(".plan-undo");
    const line = card?.nextElementSibling?.matches(".fill-undo-result") ? card.nextElementSibling : a?.querySelector(".fill-undo-result");
    return { hasUndo: !!u, button: u ? u.textContent : "", disabled: u ? u.disabled : false, result: line?.textContent ?? "", chat: document.querySelector("#messages")?.innerText ?? "" }; })()`) as { hasUndo: boolean; button: string; disabled: boolean; result: string; chat: string };
  const page = (expr: string) => rp.evaluate(work, expr);

  async function run(key: keyof typeof ASK): Promise<void> {
    await settled();
    await rp.click(panel, "#input");
    await rp.typeText(panel, ASK[key]);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `!!${answerOf(DONE[key])}?.querySelector(".answer-actions")`) || undefined, 60_000, `case ${key} answer`, 100);
    await settled();
  }

  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
  await run("fill");
  const ready = await until(async () => { const s = await seen(DONE.fill); return s.button === "恢复这 1 处填写" ? s : undefined; }, 15_000, "restore button ready", 100);
  evidence.ready = ready;
  evidence.nameAfterFill = await page(`document.getElementById("name").value`);
  assert.equal(evidence.nameAfterFill, "测试用户A", "先填上测试用户A");

  evidence.nameAfterUserEdit = await page(`(() => {
    const el = document.getElementById("name");
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    desc.set.call(el, "用户新改值");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);
  assert.equal(evidence.nameAfterUserEdit, "用户新改值", "用户把姓名改成用户新改值");

  await run("undo");
  evidence.nameAfterUndo = await page(`document.getElementById("name").value`);
  const afterUndo = await seen(DONE.undo);
  evidence.afterUndo = afterUndo;
  await rp.screenshot(panel, join(artifacts, "sidebar-after-refused-fill.png"));
  await rp.screenshot(work, join(artifacts, "page-after-refused-fill.png"));

  assert.equal(evidence.nameAfterUndo, "用户新改值", "聊天撤回用填写写回空白时，不能覆盖用户后来改的字");
  evidence.toolTexts = toolTexts;
  assert.ok(toolTexts.some(text => /被改过|写入未生效/.test(text)), `模型应看到字段被改过的拒绝原因 ${JSON.stringify(toolTexts)}`);
  assert.match(afterUndo.chat, /你后来改过|被改过|写入未生效|没做成/, `侧栏应标出这次填写没做成 ${JSON.stringify(afterUndo.chat.slice(-400))}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
