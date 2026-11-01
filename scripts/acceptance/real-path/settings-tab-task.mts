/** 真实隔离扩展：设置页是当前标签页时在侧栏发一句话，读页面被拒后助手照常回答，侧栏和设置页都不卡死。 */
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, sleep, until, REPO } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `settings-tab-task-${randomUUID()}`);
await mkdir(out, { recursive: true });
const toolMessages: string[] = [];
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: "看看这页", steps: [{ tool: { name: "tabs", args: { action: "list" } } }, { tool: { name: "snapshot", args: {} } }, { tool: { name: "screenshot", args: {} } }, { tool: { name: "js", args: { code: "document.title" } } }, { tool: { name: "read_element", args: { target: "body" } } }, { text: "设置页读不了，已收尾。" }] },
], undefined, payload => { for (const m of payload.messages ?? []) if (m.role === "tool") toolMessages.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content)); });
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let result: Record<string, unknown> = {};
// 渲染进程卡死时 CDP 求值永远不返回，给每次探测一个上限。
const alive = (session: string) => Promise.race([rp!.evaluate(session, "1+1").then(v => v === 2), sleep(5000).then(() => false)]);
try {
  rp = await launchRealPath();
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false';
  await until(() => rp!.evaluate(panel, idle), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.navigate", { url: `chrome-extension://${rp.extensionId}/settings.html#models` }, work);
  await until(() => rp!.evaluate(work, 'document.readyState==="complete"'), 15_000, "设置页就绪");
  await rp.click(panel, "#input"); await rp.typeText(panel, "看看这页"); await rp.pressEnter(panel);
  const answered = await until(() => rp!.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(e=>e.textContent.includes("已收尾"))`), 45_000, "助手回答").then(() => true, () => false);
  await sleep(3000);
  const panelAlive = await alive(panel);
  const settingsAlive = await alive(work);
  if (panelAlive) await rp.screenshot(panel, join(out, "panel.png"));
  result = { answered, panelAlive, settingsAlive, toolMessages, pass: answered && panelAlive && settingsAlive };
  console.log(JSON.stringify({ ...result, toolMessages: toolMessages.map(m => m.slice(0, 200)) }));
  if (!result.pass) process.exitCode = 1;
} catch (error) { result = { pass: false, error: String(error), toolMessages }; console.error(error); process.exitCode = 1; }
finally {
  await writeFile(join(out, "result.json"), JSON.stringify(result, null, 2));
  if (rp) { await rp.close(); await rp.remove(); }
  await model.close();
  console.log(`证据：${out}`);
}
