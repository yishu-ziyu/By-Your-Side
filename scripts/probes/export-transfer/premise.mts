/**
 * 前提小实验（docs/evals/20261008-export-transfer-ab.md）：种进隔离记忆的 scope=all 做事方法，会出现在发给模型的请求原文里；
 * 不种时不出现。请求原文取自扩展 offscreen 的 Network.getRequestPostData。
 *   npx tsx scripts/probes/export-transfer/premise.mts --headless [--model=provider/id]
 */
import { createServer } from "node:http";
import { launchRealPath, requireHeadless, siteAddress, sleep, until } from "../../acceptance/real-path/harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "../../acceptance/real-path/inproc-config.mts";
import { KNOWLEDGE, captureModelBodies, seedKnowledge } from "./shared.mts";

requireHeadless();
const plan = await loadModelPlan(process.argv.find((a) => a.startsWith("--model="))?.slice(8) ?? DEFAULT_TEST_MODEL);
const site = createServer((_, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><meta charset=utf-8><title>客户列表</title><h1>客户列表</h1>"));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));
const rp = await launchRealPath();
const idle = `document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running") && !document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")`;
const result: Record<string, boolean | number> = {};

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled === false`)) || undefined, 60_000, "侧栏就绪");
  if (plan.credential.type === "api_key") await configureViaSettings(rp, panel, plan);
  else await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await sleep(3000);
  const bodies = await captureModelBodies(rp);

  for (const withKnowledge of [false, true]) {
    await seedKnowledge(rp, withKnowledge ? KNOWLEDGE : null);
    const tab = (await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${siteAddress(site).port}/` })).targetId as string;
    await rp.cdp.send("Target.activateTarget", { targetId: tab });
    await sleep(1000);
    await rp.click(panel, "#conversation-new");
    await until(async () => (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && ${idle}`)) || undefined, 60_000, "新对话");
    const mark = bodies.list.length;
    await rp.click(panel, "#input"); await rp.typeText(panel, "这页的标题是什么？一句话回答。"); await rp.pressEnter(panel);
    await sleep(1500);
    await until(async () => (await rp.evaluate(panel, idle)) || undefined, 120_000, "回答完", 500);
    await sleep(1500);
    const mine = (await bodies.texts()).slice(mark).filter((b) => b.includes("这页的标题"));
    result[withKnowledge ? "withRequests" : "withoutRequests"] = mine.length;
    result[withKnowledge ? "withHasKnowledge" : "withoutHasKnowledge"] = mine.some((b) => b.includes(KNOWLEDGE));
  }
} finally {
  await rp.close(); await rp.remove(); site.close();
}

const ok = result.withRequests! > 0 && result.withoutRequests! > 0 && result.withHasKnowledge === true && result.withoutHasKnowledge === false;
console.log(JSON.stringify({ status: ok ? "PASS" : "FAIL", model: `${plan.providerId}/${plan.modelId}`, ...result }));
if (!ok) process.exitCode = 1;
