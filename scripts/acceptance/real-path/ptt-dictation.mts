/**
 * 按住说话第 1 步（docs/evals/20261007-ptt-dictation.md R1–R3）：只装扩展、隔离构建、全程不开侧栏。
 *   npx tsx scripts/acceptance/real-path/ptt-dictation.mts --headless
 * 麦克风是 macOS say 合成的一句中文（Chrome 假设备，开麦时从头放一遍）；听写连真实的 Step Plan 套餐（stepaudio-2.5-realtime），
 * 助手用本机脚本模型。网页上按住右 ⌥ 说完松开 → 脚本模型收到这句话 → 再打开侧栏，对话里有这句话和回答。
 * 同时记下离屏文档建过的 WebSocket 地址：只能是 /step_plan/v1/realtime（R3）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-dictation`);

await mkdir(artifacts, { recursive: true });

const SPOKEN = "把这三家公司整理成一张表，按营收排一下。";

const ANSWER = "好的，已经按营收排好了。";

const wav = join(artifacts, "microphone.wav");

execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 200]]${SPOKEN}[[slnc 600]]`]);

// 说话时长：WAV 头 44 字节，24kHz 单声道 16 位。
const speechMs = Math.round((((await readFile(wav)).length - 44) / 48_000) * 1000);

const model = await startScriptedModel([{ match: "整理成一张表", steps: [{ text: ANSWER }] }]);

const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>三家候选供应商</title><h1>三家候选供应商</h1><p>Lumen 光子、Harbor 港湾、Kite 风筝。</p><input id="note" placeholder="备注">`));

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8")).trim();

const rp = await launchRealPath({ microphoneWav: wav });

let error: string | null = null;

/** 写进 result.json 的证据。 */
interface Evidence { speechMs?: number; heldMs?: number; sockets: string[]; heard?: string | null; replyAfterReleaseMs?: number; panelUser?: string[]; panelAnswer?: string[] }

const evidence: Evidence = { sockets: [] };

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/suppliers` }, work);

  // 离屏文档（扩展内 agent）是扩展页面：在这里写配置，并记下它建的 WebSocket。
  const inproc = await rp.attach((await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "offscreen document")).targetId);

  const items = {
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" },
    inproc_voice_key: planKey,
  };

  // 配置写在一个临时打开的扩展设置页里（不是侧栏），写完关掉。
  // SAFETY: CDP Target.createTarget 返回 { targetId }。
  const { targetId: settingsTarget } = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` }) as { targetId: string };
  const settings = await rp.attach(settingsTarget);
  await until(async () => await rp.evaluate(settings, "typeof chrome !== 'undefined' && !!chrome.storage?.local"), 15_000, "settings page");
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTarget });
  rp.cdp.onEvent("Network.webSocketCreated", (message: { sessionId?: string; params?: { url?: string } }) => { if (message.sessionId === inproc && message.params?.url) evidence.sockets.push(message.params.url); });
  await rp.cdp.send("Network.enable", {}, inproc);
  await sleep(1_500);

  // 网页上按住右 ⌥ 说话（按说话时长），然后松开。
  await rp.cdp.send("Runtime.evaluate", { expression: "document.body.click(), true" }, work);
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const pressedAt = Date.now();
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);

  while (Date.now() - pressedAt < speechMs + 400) {
    await sleep(100);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, work);
  }

  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
  const releasedAt = Date.now();
  evidence.speechMs = speechMs;
  evidence.heldMs = releasedAt - pressedAt;

  // R1/R2：侧栏没开，脚本模型收到了这句话（作为用户消息交给了助手）。
  await until(async () => model.requests.find(r => r.rule === "整理成一张表"), 30_000, "assistant received the spoken request", 50);
  evidence.replyAfterReleaseMs = Date.now() - releasedAt;
  assert.ok(!(await rp.targets()).some(t => t.url.includes("/sidepanel.html")), "R2: side panel stayed closed");

  // R3：只连了套餐地址。
  assert.ok(evidence.sockets.some(url => url.startsWith("wss://api.stepfun.com/step_plan/v1/realtime")), `R3: dictation used the plan URL ${JSON.stringify(evidence.sockets)}`);
  assert.ok(!evidence.sockets.some(url => url.startsWith("wss://api.stepfun.com/v1/")), `R3: no pay-as-you-go socket ${JSON.stringify(evidence.sockets)}`);

  // 打开侧栏：对话里有这句话和回答。
  const panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(ANSWER)}))`) || undefined, 30_000, "answer in panel");
  // SAFETY: 表达式返回字符串数组。
  evidence.panelUser = await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].map(m => m.textContent.trim())`) as string[];
  evidence.heard = evidence.panelUser.at(-1) ?? null;
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  assert.ok(evidence.heard?.includes("整理成一张表"), `R1: the spoken sentence reached the conversation (${evidence.heard})`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
