import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-mini-apps-setting`);

await mkdir(out, { recursive: true });

const ON = "小程序核对一：算一下房贷";
const OFF = "小程序核对二：再算一下房贷";
const GUIDE = "Interactive answers: choose the form";
const seen: Record<string, boolean> = {};
const textOf = (content: unknown): string => typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : "";
const model = await startScriptedModel([
  { match: ON, steps: [{ text: "第一问答完了。" }] },
  { match: OFF, steps: [{ text: "第二问答完了。" }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  const texts = (payload.messages ?? []).map(m => textOf(m.content));

  for (const ask of [ON, OFF]) {
    const at = texts.findLastIndex(text => text.includes(ask));

    if (at >= 0 && !(ask in seen)) seen[ask] = texts.slice(Math.max(0, at - 2), at + 2).some(text => text.includes(GUIDE));
  }
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const say = async (text: string, done: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  };

  await rp.evaluate(panel, `chrome.storage.local.set({ sideagent_mini_apps: true }).then(() => true)`);
  await sleep(1_000);
  await say(ON, "第一问答完了");
  check("a 打开小程序后，本轮上下文带小程序说明", seen[ON] === true, { guide: seen[ON] ?? null });

  await rp.evaluate(panel, `chrome.storage.local.set({ sideagent_mini_apps: false }).then(() => true)`);
  await sleep(1_000);
  await say(OFF, "第二问答完了");
  check("b 关掉后，本轮上下文不带小程序说明", seen[OFF] === false, { guide: seen[OFF] ?? null });
  await rp.screenshot(panel, join(out, "panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
