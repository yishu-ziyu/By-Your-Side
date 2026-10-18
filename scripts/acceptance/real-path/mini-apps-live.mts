/**
 * 小实验（不是验收）：真模型写出的小程序放进真沙箱，会不会报错、空白。
 *   npx tsx scripts/acceptance/real-path/mini-apps-live.mts --headless <rows.json>
 * rows.json 是 tmp/genui/run.mts 的输出；每个带 <app> 的回答由脚本模型原样放出，读侧栏小程序下面那一行。
 */
import { readFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();
const rows = JSON.parse(await readFile(process.argv.find(a => a.endsWith(".json"))!, "utf8")) as Array<{ id: string; rep: number; text: string }>;
const apps = rows.filter(r => /<app\b[\s\S]*<\/app>/.test(r.text));
const out = join(REPO, "out/mini-apps-live");
await mkdir(out, { recursive: true });
const rules: Rule[] = apps.map((r, i) => ({ match: `第${i}个`, steps: [{ text: r.text }] }));
const model = await startScriptedModel(rules);
const rp = await launchRealPath();
const results: unknown[] = [];
try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ sideagent_mini_apps: true, inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  for (const [i, r] of apps.entries()) {
    await rp.click(panel, "#input");
    await rp.typeText(panel, `第${i}个`);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.assistant .answer-actions").length > ${i} && !document.querySelector("#messages .msg.assistant.streaming")`) || undefined, 60_000, `第${i}个`);
    await sleep(2_500);
    const s = await rp.evaluate(panel, `(() => { const a = [...document.querySelectorAll("#messages .gc-app")].at(-1); a?.scrollIntoView({ block: "start" }); const b = a?.querySelector(".gc-app-bar"); return { frame: !!a?.querySelector("iframe"), height: Math.round(a?.querySelector("iframe")?.getBoundingClientRect().height ?? 0), bar: b && !b.hidden ? b.textContent : null }; })()`);
    await sleep(300);
    await rp.screenshot(panel, join(out, `${r.id}-${r.rep}.png`));
    results.push({ id: r.id, rep: r.rep, ...s as object });
    console.log(JSON.stringify(results.at(-1)));
  }
} catch (e) { console.log("FAILED", String(e)); const t = (await rp.targets()).find(t => t.url.includes("sidepanel.html")); if (t) { const p = await rp.attach(t.targetId); console.log(JSON.stringify(await rp.evaluate(p, `({ text: document.querySelector("#messages")?.innerText.slice(-600), errs: window.__errs })`).catch(String))); await rp.screenshot(p, join(out, "failed.png")).catch(() => {}); } } finally { await rp.close(); await rp.remove(); await model.close(); }
