/** 实时语音设置：默认RT3、套餐选择持久、下一次开启才换、非法值不开连接。
 * npx tsx scripts/acceptance/real-path/voice-plan-settings.mts --headless
 * 用故意无效key观察真实WebSocket握手地址；不把凭据可用、闲聊或动作分流算通过。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-voice-plan-settings`);
await mkdir(out, { recursive: true });
const wav = join(out, "silence.wav");
const audio = Buffer.alloc(44 + 24_000 * 2 * 4);
audio.write("RIFF", 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write("WAVEfmt ", 8);
audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
audio.writeUInt32LE(24_000, 24); audio.writeUInt32LE(48_000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
audio.write("data", 36); audio.writeUInt32LE(audio.length - 44, 40);
await writeFile(wav, audio);
const model = await startScriptedModel([]);
const rp = await launchRealPath({ microphoneWav: wav });
const sockets: string[] = [];
const evidence: Record<string, unknown> = {};
let error: string | null = null;
const RT3 = "stepaudio-3-realtime-preview", PLAN = "stepaudio-2.5-realtime";
try {
  const panel = await rp.attach(await rp.openSidePanel());
  const config = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  const settings = await rp.attach(config.settingsTargetId);
  await until(async () => await rp.evaluate(settings, "!!document.querySelector('#voice-model-list')") || undefined, 15_000, "语音模型选项");
  const chosen = () => rp.evaluate(settings, "document.querySelector('#voice-model-list [aria-checked=true]')?.dataset.model ?? null");
  const pickModel = async (value: string) => {
    const selector = `#voice-model-list [data-model="${value}"]`;
    await rp.evaluate(settings, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
    await rp.click(settings, selector);
  };
  const endVoice = async () => {
    const phase = await rp.evaluate(panel, "document.querySelector('.voice-progress')?.dataset.state");
    // error 的「结束」按钮实际叫「重试」；失败已停，不要误点成新开启。
    if (phase !== 'error' && phase !== 'idle') await rp.click(panel, '.voice-end');
  };
  assert.equal(await chosen(), RT3, "首次设置保持默认按量Realtime3");
  await rp.evaluate(settings, "document.querySelector('#voice-key').scrollIntoView({block:'center'})");
  await rp.click(settings, "#voice-key");
  await rp.typeText(settings, "invalid-voice-key-settings-acceptance");
  await rp.click(settings, "#voice-save");
  const doc = await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "offscreen");
  const inproc = await rp.attach(doc.targetId);
  rp.cdp.onEvent("Network.webSocketCreated", (m: { sessionId?: string; params?: { url?: string } }) => { if (m.sessionId === inproc && m.params?.url) sockets.push(m.params.url); });
  await rp.cdp.send("Network.enable", {}, inproc);
  await sleep(1500);
  await rp.click(panel, ".voice-start");
  await until(async () => sockets.length > 0 || undefined, 15_000, "默认RT3连接地址");
  assert.ok(sockets.every(url => url === `wss://api.stepfun.com/v1/realtime?model=${RT3}`));
  await pickModel(PLAN);
  await until(async () => await chosen() === PLAN || undefined, 5000, "套餐选择已保存");
  await sleep(500);
  assert.ok(sockets.every(url => !url.includes("/step_plan/")), "设置切换不立刻开套餐连接");
  await endVoice();
  await rp.cdp.send("Page.reload", {}, settings);
  await until(async () => await chosen() === PLAN || undefined, 15_000, "重开设置保留套餐选择");
  const beforePlan = sockets.length;
  await rp.click(panel, ".voice-start");
  await until(async () => sockets.length > beforePlan || undefined, 15_000, "下一次开启套餐语音");
  assert.ok(sockets.slice(beforePlan).every(url => url === `wss://api.stepfun.com/step_plan/v1/realtime?model=${PLAN}`), "套餐不回退按量接口");
  evidence.plan = { selected: await chosen(), sockets: [...sockets] };
  await rp.screenshot(settings, join(out, "1-plan-selected.png"));
  await endVoice();
  // 存储边界：坏值不是默认值，不应该偷偷开启按量会话。
  await rp.evaluate(settings, "chrome.storage.local.set({inproc_voice_model:'unsupported-model'}).then(()=>true)");
  await until(async () => await chosen() === null || undefined, 5000, "设置提示无效选择，不显示默认已选");
  const beforeInvalid = sockets.length;
  await sleep(500);
  await rp.click(panel, ".voice-start");
  const invalid = await until(async () => await rp.evaluate(panel, "(() => { const e=document.querySelector('.voice-state-detail');return e?.textContent.includes('语音模型设置无效') && e.checkVisibility() && e.getBoundingClientRect().height>0; })()") || undefined, 10_000, "无效模型原因真实可见，隐藏DOM文字不算通过");
  await sleep(500);
  assert.equal(sockets.length, beforeInvalid, "无效模型没有任何新语音连接");
  evidence.invalid = invalid;
  await rp.screenshot(panel, join(out, "2-invalid-model.png"));
  await pickModel(RT3);
  await until(async () => await chosen() === RT3 || undefined, 5000, "用户明确改回RT3");
  await rp.cdp.send("Page.reload", {}, settings);
  await until(async () => await chosen() === RT3 || undefined, 15_000, "重开保留显式RT3");
  evidence.restored = await chosen();
} catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, sockets }, null, 2));
  await rp.close(); await rp.remove(); await model.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
