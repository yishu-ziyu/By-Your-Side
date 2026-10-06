// 临时探针：模型想 15 秒只回一句话，看等待期间侧栏有什么。
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "../../../acceptance/real-path/harness.mts";
import { startScriptedModel } from "../../../acceptance/real-path/scripted-model.mts";

requireHeadless();

const model = await startScriptedModel([{ match: "想一想", steps: [{ text: "想好了。", delayMs: 15_000 }] }]);

const rp = await launchRealPath();

try {
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#send-btn")?.disabled===false`) || undefined, 60_000, "侧栏就绪");
  await rp.evaluate(panel, `(() => { window.__ev = []; return true; })()`);
  await rp.click(panel, "#input"); await rp.typeText(panel, "想一想"); await rp.pressEnter(panel);
  console.log(await (async () => { await sleep(3000);

 return rp.evaluate(panel, "JSON.stringify(globalThis.__evlog)"); })());

  for (const t of [1500, 5000]) { await sleep(t); console.log(t, await rp.evaluate(panel, `JSON.stringify([...document.querySelectorAll("#messages > *")].map(e => e.tagName + "." + e.className + (e.hidden ? "[hidden]" : "") + " | " + e.innerText.replace(/\\s+/g," ").slice(0,60)))`)); }

  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 0, height: 0, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(500); await rp.screenshot(panel, join(REPO, "out/design-check/58/wait.png"));
} finally { await rp.close().catch(() => undefined); await model.close(); }
