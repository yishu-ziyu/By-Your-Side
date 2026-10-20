/** Real Realtime 3 dictation in an isolated extension; no ASR mocks.
 * npx tsx scripts/acceptance/real-path/dictation-realtime.mts --headless
 * --headed keeps the isolated browser in the background.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-dictation-realtime`);
await mkdir(out, { recursive: true });
const phrase = "请帮我整理这篇文章的三个重点。";
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 500]]${phrase}[[slnc 500]]`]);
const speechMs = Math.ceil((await readFile(wav)).length / 48);
const key = (await readFile(join(homedir(), ".sideagent/stepfun-api.key"), "utf8")).trim();
const model = await startScriptedModel([{ match: "*", steps: [{ text: "本次不应发送消息" }] }]);
const rp = await launchRealPath({ microphoneWav: wav, headed: process.argv.includes("--headed"), chromeArgs: ["--autoplay-policy=no-user-gesture-required"] });
const checked: string[] = [];
const events: Array<Record<string, unknown>> = [];
const sockets = new Set<string>();
const started = Date.now();
let settings = "", panel = "", error: string | null = null;
let finalTranscript = "";
const clean = (text: string) => text.replaceAll(key, "[REDACTED]");
const normalize = (text: string) => text.replace(/[\p{P}\p{Z}\s]/gu, "").replaceAll("三个", "3个");
const observe = async (session: string) => {
  await rp.cdp.send("Network.enable", {}, session);
};
rp.cdp.onEvent("Network.webSocketCreated", message => {
  if (String(message.params.url).includes("dictation=")) { sockets.add(message.params.requestId); events.push({ atMs: Date.now() - started, direction: "transport", socket: message.params.requestId, type: "created" }); }
});
for (const [method, direction] of [["Network.webSocketFrameSent", "client"], ["Network.webSocketFrameReceived", "server"]]) rp.cdp.onEvent(method, message => {
  if (!sockets.has(message.params.requestId)) return;
  try {
    const e = JSON.parse(message.params.response.payloadData);
    const entry: Record<string, unknown> = { atMs: Date.now() - started, direction, socket: message.params.requestId, type: e.type };
    if (e.type === "session.update" || e.type === "session.updated") entry.session = { modalities: e.session?.modalities, turn_detection: e.session?.turn_detection, instructionsPresent: "instructions" in (e.session ?? {}) };
    if (typeof e.delta === "string") { if (e.type?.startsWith("response.audio.") && !e.type.includes("transcript")) entry.audioBytes = Buffer.from(e.delta, "base64").length; else entry.delta = clean(e.delta); }
    if (typeof e.transcript === "string") entry.transcript = clean(e.transcript);
    if (e.type === "error") entry.errorCode = e.error?.code ?? null;
    if (e.type?.endsWith("transcription.delta")) entry.fields = Object.keys(e);
    if (e.type !== "input_audio_buffer.append") events.push(entry);
  } catch { events.push({ type: "invalid-frame", direction }); }
});
rp.cdp.onEvent("Network.webSocketClosed", message => { if (sockets.has(message.params.requestId)) events.push({ atMs: Date.now() - started, socket: message.params.requestId, direction: "transport", type: "closed" }); });
const click = async (session: string, selector: string) => {
  await rp.evaluate(session, `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'center'})`);
  assert.ok(await rp.evaluate(session, `document.querySelector(${JSON.stringify(selector)}).checkVisibility()`), `不可见 ${selector}`);
  await rp.click(session, selector);
};
const fill = async (session: string, selector: string, value: string) => {
  await click(session, selector); await rp.evaluate(session, `document.querySelector(${JSON.stringify(selector)}).select()`); await rp.typeText(session, value);
};
const select = async (selector: string, value: string) => {
  await click(settings, selector);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, settings);
  await rp.evaluate(settings, `(() => { const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true})); })()`);
  await sleep(120);
};
const status = () => rp.evaluate(settings, `document.querySelector('#dictation-status').textContent`);
const draft = (session = panel) => rp.evaluate(session, "document.querySelector('#input').value");
const save = async () => { await click(settings, "#dictation-save"); await until(async () => String(await status()).startsWith("已保存") || undefined, 5000, "听写设置保存"); };
const start = async () => {
  await click(panel, "#dictate-btn");
  await until(async () => await rp.evaluate(panel, `document.querySelector('.dictation-hint')?.textContent === '实时转文字' && document.querySelector('#composer').classList.contains('dictating')`) || undefined, 30000, "Realtime 3 录音启动");
};
try {
  await rp.cdp.send("Target.createTarget", { url: "https://example.com", background: true });
  const target = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html#voice`, background: true });
  settings = await rp.attach(target.targetId);
  await until(async () => await rp.evaluate(settings, "!!document.querySelector('#dictation-provider')") || undefined, 15000, "听写设置页");
  await observe(settings);
  await rp.evaluate(settings, `chrome.storage.local.set({inproc_voice_key:${JSON.stringify(key)},inproc_model_config:{provider:'custom',modelId:'dictation-check',baseUrl:${JSON.stringify(model.baseUrl)}},'inproc_cred:custom':{type:'api_key',key:'local-only',env:{SIDEAGENT_CUSTOM_ENDPOINT:${JSON.stringify(model.baseUrl)}}}})`);
  await rp.cdp.send("Page.reload", {}, settings);
  await until(async () => await rp.evaluate(settings, "document.querySelector('#dictation-key-source-note')?.textContent.includes('语音对话')") || undefined, 10000, "已配置凭据来源");
  await select("#dictation-provider", "stepfun-realtime");
  await fill(settings, "#dictation-key", "invalid-realtime-key");
  await click(settings, "#dictation-test");
  await until(async () => await rp.evaluate(settings, "document.querySelector('#dictation-status').dataset.tone === 'err'") || undefined, 20000, "无效 Realtime 3 密钥被拒绝");
  checked.push("真实 Realtime 3 拒绝无效凭据");
  await fill(settings, "#dictation-key", key);
  await click(settings, "#dictation-test");
  await until(async () => await rp.evaluate(settings, "!document.querySelector('#dictation-test').disabled") || undefined, 20000, "单独凭据真实连接测试");
  assert.match(String(await status()), /连接成功/);
  await save();
  checked.push("单独填写的 Realtime 3 凭据可测试和保存");
  await select("#dictation-key-source", "voice");
  assert.equal(await rp.evaluate(settings, "document.querySelector('#dictation-key-row').hidden"), true);
  await click(settings, "#dictation-test");
  await until(async () => await rp.evaluate(settings, "!document.querySelector('#dictation-test').disabled") || undefined, 20000, "真实 Realtime 3 连接测试");
  assert.match(String(await status()), /连接成功/);
  await save();
  assert.equal(await rp.evaluate(settings, `chrome.storage.local.get('inproc_voice_key').then(s=>s.inproc_voice_key === ${JSON.stringify(key)})`), true, "未改右侧语音凭据");
  await rp.screenshot(settings, join(out, "01-realtime-settings.png"));
  await rp.cdp.send("Page.reload", {}, settings);
  await until(async () => await rp.evaluate(settings, "document.querySelector('#dictation-provider')?.value === 'stepfun-realtime' && document.querySelector('#dictation-key-source')?.value === 'voice'") || undefined, 15000, "重开设置保留服务与凭据来源");
  checked.push("显式沿用语音对话凭据、真实连接测试、保存与重开");
  const panelId = await rp.openSidePanel(); panel = await rp.attach(panelId); await observe(panel);
  await until(async () => await rp.evaluate(panel, "!!document.querySelector('#dictate-btn')") || undefined, 15000, "真侧栏");
  await fill(panel, "#input", "原草稿：");
  await start();
  await until(async () => await rp.evaluate(panel, "document.querySelector('.dictation-interim').textContent.length > 0") || undefined, 15000, "边说边出字");
  await rp.screenshot(panel, join(out, "02-live-text.png"));
  await sleep(speechMs);
  const liveText = await rp.evaluate(panel, "document.querySelector('.dictation-interim').textContent");
  assert.ok(normalize(String(liveText)).length <= normalize(phrase).length + 2, "实时文字应是当前整句，不能拼接重复前缀");
  await rp.screenshot(panel, join(out, "02-live-text.png"));
  assert.equal(await draft(), "原草稿：", "确认前不改变草稿");
  await click(panel, ".dictation-ok");
  await until(async () => await rp.evaluate(panel, "!document.querySelector('#dictate-btn').disabled") || undefined, 20000, "最终转写写入草稿");
  finalTranscript = String(await draft()).slice("原草稿：".length);
  assert.equal(normalize(finalTranscript), normalize(phrase), `完整内容匹配，仅允许数字与标点规范化：${finalTranscript}`);
  assert.equal(await rp.evaluate(panel, "document.querySelectorAll('.msg.user').length"), 0, "确认不发送");
  await rp.screenshot(panel, join(out, "03-confirmed-draft.png"));
  checked.push("真实合成中文音频、增量文字、准确最终转写、确认进草稿且不发送");
  const confirmed = await draft();
  const helperTarget = await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html`, newWindow: true, background: true });
  const helper = await rp.attach(helperTarget.targetId);
  await until(async () => await rp.evaluate(helper, "document.readyState === 'complete'") || undefined, 10000, "第二窗口");
  const windowId = await rp.evaluate(helper, "chrome.windows.getCurrent().then(w=>w.id)");
  await rp.evaluate(helper, `chrome.sidePanel.open({windowId:${windowId}})`, { userGesture: true });
  const secondTarget = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === `chrome-extension://${rp.extensionId}/sidepanel.html` && t.targetId !== panelId), 10000, "第二个真实侧栏");
  const second = await rp.attach(secondTarget.targetId); await observe(second);
  await until(async () => await rp.evaluate(second, "!!document.querySelector('#dictate-btn')") || undefined, 10000, "第二侧栏麦克风");
  await start();
  await click(second, "#dictate-btn");
  await until(async () => await rp.evaluate(second, "document.body.innerText.includes('另一个窗口正在听写')") || undefined, 5000, "跨窗口互斥提示");
  assert.equal(await rp.evaluate(second, "document.querySelector('#composer').classList.contains('dictating')"), false);
  await click(panel, ".dictation-cancel");
  assert.equal(await draft(), confirmed);
  await rp.evaluate(settings, `chrome.windows.remove(${windowId})`);
  checked.push("两个真实窗口同时开侧栏，第二个不能抢录音，第一份草稿保留");
  await start();
  await sleep(600);
  await click(panel, ".dictation-cancel");
  await sleep(500);
  assert.equal(await draft(), confirmed, "取消恢复原草稿");
  checked.push("真实录音取消恢复原草稿");
  await start(); await sleep(600);
  await click(panel, ".dictation-ok");
  assert.equal(await rp.evaluate(panel, "document.querySelector('#dictate-btn').disabled"), true);
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, panel);
  await until(async () => await rp.evaluate(panel, "!document.querySelector('#dictate-btn').disabled") || undefined, 5000, "取消待返回转写");
  await sleep(800); assert.equal(await draft(), confirmed);
  checked.push("确认后等待转写时取消，迟到结果不改变草稿");
  await start();
  await click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, "!document.querySelector('#composer').classList.contains('dictating') && document.querySelector('#input').value === ''") || undefined, 10000, "切会话取消且无旧文字");
  await sleep(800);
  assert.equal(await draft(), "", "迟到事件不能污染新会话");
  checked.push("切会话取消、迟到结果不污染新会话");
  await fill(panel, "#input", "重开保留的草稿");
  await rp.cdp.send("Target.closeTarget", { targetId: panelId });
  panel = await rp.attach(await rp.openSidePanel()); await observe(panel);
  await until(async () => await draft() === "重开保留的草稿" || undefined, 15000, "重开侧栏恢复草稿");
  checked.push("关闭并重开真实侧栏恢复草稿");
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, settings);
  await rp.screenshot(settings, join(out, "04-dark-reduced.png"));
  await until(async () => await rp.evaluate(settings, "chrome.declarativeNetRequest.getSessionRules().then(r=>r.every(x=>x.id<100000))") || undefined, 5000, "临时鉴权规则已清理");
  assert.equal(events.filter(e => e.direction === "client" && e.type === "response.create").length, 0);
  assert.equal(events.filter(e => e.direction === "server" && String(e.type).startsWith("response.")).length, 0, "服务器无任何回复事件");
  assert.ok(events.some(e => e.type === "conversation.item.input_audio_transcription.completed"));
  checked.push("服务器无 response.*、客户端无 response.create、鉴权规则清理");
} catch (cause) {
  error = clean(cause instanceof Error ? cause.stack ?? cause.message : String(cause));
  if (settings) await rp.screenshot(settings, join(out, "failure-settings.png")).catch(() => {});
  if (panel) await rp.screenshot(panel, join(out, "failure-panel.png")).catch(() => {});
} finally {
  await rp.close(); await rp.remove(); await model.close();
  await writeFile(join(out, "events.jsonl"), events.map(e => JSON.stringify(e)).join("\n"));
  await writeFile(join(out, "result.json"), JSON.stringify({ ok: !error, checked, error, phrase, finalTranscript, realAsr: true, audio: "macOS Tingting synthetic Chinese WAV via Chrome fake microphone", scriptedModel: "initialization only; no chat request expected", responseEvents: events.filter(e => e.direction === "server" && String(e.type).startsWith("response.")), billingConclusion: "Not measured", boundaries: ["真人麦克风未验", "Step Plan 与硅基流动成功识别仍受凭据权限限制"] }, null, 2));
}
console.log(JSON.stringify({ ok: !error, out, checked, finalTranscript, error }, null, 2));
if (error) process.exitCode = 1;
