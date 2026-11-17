import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const ANSWER = "页面标题已核对完成，这是交付给用户的最终回答。";
let sawGoalCheck = false;

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=\"utf-8\"><title>核对窗口练习</title><main><p>商品价格：99 元</p></main>");
});
await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }), delayMs: 15_000 }] },
  { match: "Check the browser assistant's final answer", steps: [{ text: JSON.stringify({ problems: [] }) }] },
  { match: "核对窗口测试", steps: [{ tool: { name: "snapshot", args: {} } }, { text: ANSWER }] },
  { match: "第二句问候", steps: [{ text: "收到，可以继续新的对话。" }] },
], undefined, (payload) => {
  if (JSON.stringify(payload.messages ?? []).includes('"goalPage"')) sawGoalCheck = true;
});

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-checking-reload-settle`);
await mkdir(out, { recursive: true });
const rp = await launchRealPath();

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");

  await rp.click(panel, "#input");
  await rp.typeText(panel, "核对窗口测试");
  await rp.pressEnter(panel);

  await until(async () => (sawGoalCheck && await rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes(${JSON.stringify(ANSWER)}) ?? false`)) || undefined, 30_000, "进入核对窗口并渲染回答");
  await sleep(500);
  await rp.screenshot(panel, join(out, "before-reload.png"));

  await rp.evaluate(panel, "chrome.runtime.reload()").catch(() => {});
  await sleep(4_000);
  panel = await rp.attach(await rp.openSidePanel());
  await until(() => rp.evaluate(panel, idle), 60_000, "重载后侧栏恢复就绪");
  await sleep(1_500);
  await rp.screenshot(panel, join(out, "after-reload.png"));

  const state = await rp.evaluate(panel, `({
    text: document.querySelector("#messages")?.innerText ?? "",
    resumeVisible: (() => { const r = document.querySelector("#resume-entry-root"); return !!r && !r.hidden && !!r.querySelector(".resume-action"); })(),
    stopping: !!document.querySelector("#send-btn")?.classList.contains("stopping"),
  })`) as { text: string; resumeVisible: boolean; stopping: boolean };

  await writeFile(join(out, "result.json"), JSON.stringify(state, null, 2));
  assert.ok(state.text.includes(ANSWER), "重载后应保留已交付的回答");
  assert.equal(state.resumeVisible, false, "核对窗口重载后不应误显继续原任务入口");
  assert.equal(state.stopping, false, "重载后不应卡在停止中状态");
  assert.equal(state.text.includes("任务中断"), false, "重载后不应误报任务中断");

  await rp.click(panel, "#input");
  await rp.typeText(panel, "第二句问候");
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes("可以继续新的对话") ?? false`), 20_000, "重载后正常续聊");
  console.log("PASS checking-reload-settle");
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}
