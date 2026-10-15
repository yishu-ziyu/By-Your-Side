/**
 * 一句话没送达，用户点气泡上的「重试」：还是原来那一个气泡，「未送达」去掉、得到回答；重开侧栏后也只有这一个气泡。
 *   npx tsx scripts/acceptance/real-path/undelivered-retry.mts --headless
 * 脚本模型，只装扩展。「没送达」的造法：扩展内 agent 的 offscreen 文档一出现就关掉（反复崩溃），
 * 这期间从侧栏页再开一条面板端口发出这句。侧栏自己的发送在断线时会把草稿退回输入框，碰不到后台转发失败那一步，
 * 所以借第二条端口走同一个后台入口；被测的记录、标记、重试、回放都是真的。
 * 失败方式：点了「重试」多出第二个同样的气泡；原气泡还挂着「未送达」；重开侧栏后变成两个气泡，或旧的那个又标回未送达。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-undelivered-retry`);

await mkdir(artifacts, { recursive: true });

const ASK = "未送达重试验收：海獭用什么敲开贝壳？";

const ANSWER = "海獭用石头敲开贝壳。";

const model = await startScriptedModel([{ match: ASK, steps: [{ text: ANSWER }] }]);

const rp = await launchRealPath();

const evidence: Record<string, unknown> = {};

let error: string | null = null;

/** 侧栏里写着这句话的用户气泡：有几个、各自有没有「未送达」，以及最后一段回答。 */
const BUBBLES = `(() => {
  const all = [...document.querySelectorAll(".msg.user")].filter((m) => (m.querySelector(".user-msg-text")?.textContent ?? m.textContent ?? "").includes(${JSON.stringify(ASK)}));
  return {
    count: all.length,
    marked: all.map((m) => m.classList.contains("undelivered") || !!m.querySelector(".delivery-tag")),
    retryButtons: all.map((m) => !!m.querySelector("[data-retry]")),
    answered: (document.querySelector("#messages")?.textContent ?? "").includes(${JSON.stringify(ANSWER)}),
  };
})()`;

type Bubbles = { count: number; marked: boolean[]; retryButtons: boolean[]; answered: boolean };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 400, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await sleep(1000);

  // 扩展内 agent 反复崩溃，直到下面放开。
  let crashing = true;
  let crashes = 0;
  const crashLoop = (async () => {
    while (crashing) {
      const doc = (await rp.targets()).find((t) => t.url === `chrome-extension://${rp.extensionId}/inproc.html`);
      if (doc && (await rp.cdp.send("Target.closeTarget", { targetId: doc.targetId }).then(() => true, () => false))) crashes++;
      await sleep(50);
    }
  })();

  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on") === false`)) || undefined, 15_000, "侧栏显示断开");
  await rp.evaluate(panel, `(() => { window.__extraPort = chrome.runtime.connect({ name: "sideagent-panel" }); window.__extraPort.postMessage({ kind: "client", msg: { type: "user_message", text: ${JSON.stringify(ASK)} } }); return true; })()`);
  const before = await until(async () => {
    const state = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: BUBBLES 只返回这个形状。
    return state.retryButtons.some(Boolean) ? state : undefined;
  }, 15_000, "气泡标上未送达");
  await sleep(300);
  await rp.screenshot(panel, join(artifacts, "1-undelivered.png"));
  evidence.before = before;
  evidence.crashes = crashes;

  crashing = false;
  await crashLoop;
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#status-dot")?.classList.contains("on") === true`)) || undefined, 45_000, "连接恢复");
  await sleep(1000);

  const requestsBefore = model.requests.filter((r) => r.rule === ASK).length;
  await rp.click(panel, ".msg.user [data-retry]");
  const after = await until(async () => {
    const state = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
    return state.answered ? state : undefined;
  }, 30_000, "重试后得到回答");
  await sleep(1500);
  const settled = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "2-after-retry.png"));
  evidence.after = after;
  evidence.settled = settled;
  evidence.modelRequests = model.requests.filter((r) => r.rule === ASK).length - requestsBefore;

  await rp.cdp.send("Page.reload", {}, panel);
  const reopened = await until(async () => {
    const state = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
    return state.answered ? state : undefined;
  }, 30_000, "重开侧栏后回放出这一轮");
  await sleep(1000);
  const reopenedSettled = await rp.evaluate(panel, BUBBLES) as Bubbles; // SAFETY: 同上。
  await rp.screenshot(panel, join(artifacts, "3-reopened.png"));
  evidence.reopened = reopenedSettled;

  assert.deepEqual({ count: before.count, marked: before.marked }, { count: 1, marked: [true] }, `重试前：一个气泡，标着未送达：${JSON.stringify(before)}`);
  assert.deepEqual({ count: settled.count, marked: settled.marked, answered: settled.answered }, { count: 1, marked: [false], answered: true }, `重试后：还是一个气泡，未送达去掉，有回答：${JSON.stringify(settled)}`);
  assert.deepEqual({ count: reopenedSettled.count, marked: reopenedSettled.marked, answered: reopened.answered }, { count: 1, marked: [false], answered: true }, `重开侧栏后：一个气泡，没有未送达：${JSON.stringify(reopenedSettled)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
