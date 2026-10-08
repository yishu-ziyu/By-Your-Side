/** 完成标准（旧 PTT 念结果验收的两项缺口）：
 * R1 真 PTT + Step Plan 得到结果后，用 Fetch.requestPaused 挂起真实 MiniMax 请求，不伪造回复。
 *    约45秒后必须报告「念结果超时」；胶囊结果保留、speaking=false，对话写具体原因。
 * R2 第二轮合成请求挂起时再次真 PTT 开口，必须 hush 旧句；释放旧请求后，新结果不能被旧结果覆盖或恢复 speaking。
 *    旧请求须有真实取消或真实回应证据；新句用故意无效订阅格式 key 获得真实 MiniMax 拒绝，不假装放出了声音。
 * 边界：模型允许脚本；听写/合成仍是 Step Plan/MiniMax，不换 provider；不验证正常听写、音色或真人听感。
 * npx tsx scripts/acceptance/real-path/ptt-playback-boundaries.mts --headless
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";
import { PTT_SPEECH_KEY, PTT_SPEAK_RESULT } from "../../../extension/src/shared/ptt.js";
requireHeadless();
const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8").catch(() => "")).trim();
if (!planKey || process.platform !== "darwin") {
  console.log(JSON.stringify({ status: "BLOCKED", reason: !planKey ? "缺少现有 Step Plan 凭据" : "需要 macOS say 麦克风夹具" }));
  process.exit(2);
}
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-playback-boundaries`);
await mkdir(out, { recursive: true });
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", "[[slnc 200]]把这三家公司整理成一张表，按营收排一下。[[slnc 600]]"]);
const speechMs = Math.round(((await readFile(wav)).length - 44) / 48_000 * 1000);
const answers = ["超时轮结果已整理好。", "旧轮结果已整理好。", "新轮结果已重新整理好。"];
const rule: Rule = { match: "整理成一张表", steps: [{ text: answers[0]! }] };
const model = await startScriptedModel([rule]);
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><title>三家候选供应商</title><h1>Lumen、Harbor、Kite</h1>"));
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const rp = await launchRealPath({ microphoneWav: wav });
type Paused = { id: string; networkId?: string; at: number; text?: string; model?: string };
const paused: Paused[] = [];
const network: Array<{ id: string; kind: string; status?: number; cancelled?: boolean }> = [];
const sockets: string[] = [];
const pending: Promise<void>[] = [];
const callbackErrors: string[] = [];
const evidence: Record<string, unknown> = {};
let error: string | null = null;
let inproc: string | undefined;
type DomNode = { nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
async function detail(work: string): Promise<string | null> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const all = (n: DomNode): DomNode[] => [n, ...[...(n.children ?? []), ...(n.shadowRoots ?? [])].flatMap(all)];
  const host = all(root).find(n => n.attributes?.some((v, i, a) => v === "data-sideagent-overlay" && a[i + 1] === "ptt-capsule"));
  const d = host && all(host).find(n => n.attributes?.some((v, i, a) => v === "class" && a[i + 1]?.split(/\s+/).includes("detail")));
  return d ? all(d).filter(n => n.nodeName === "#text").map(n => n.nodeValue ?? "").join("") : null;
}
const capsule = (work: string) => rp.evaluate(work, `(() => {const h=document.querySelector('[data-sideagent-overlay="ptt-capsule"]');return h?{phase:h.dataset.phase,speaking:h.dataset.speaking==='true'}:null})()`);
const speechReply = () => rp.evaluate(inproc!, "JSON.parse(document.documentElement.dataset.pttSpeech ?? 'null')");
async function hold(work: string, afterPress?: () => Promise<void>) {
  await rp.cdp.send("Page.bringToFront", {}, work);
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const start = Date.now();
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);
  await afterPress?.();
  while (Date.now() - start < speechMs + 400) {
    await sleep(100);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, work);
  }
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
}
async function release(request: Paused) {
  try { await rp.cdp.send("Fetch.continueRequest", { requestId: request.id }, inproc); return "continued"; }
  catch (caught) { return `continue-error: ${caught instanceof Error ? caught.message : String(caught)}`; }
}
try {
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "练习页");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/suppliers` }, work);
  const doc = await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "离屏文档");
  inproc = await rp.attach(doc.targetId);
  rp.cdp.onEvent("Fetch.requestPaused", (m: { sessionId?: string; params?: { requestId: string; networkId?: string; request: { postData?: string } } }) => {
    if (m.sessionId !== inproc || !m.params) return;
    const body = JSON.parse(m.params.request.postData ?? "{}") as { text?: string; model?: string };
    paused.push({ id: m.params.requestId, networkId: m.params.networkId, at: Date.now(), text: body.text, model: body.model });
    if (paused.length > 2) pending.push(rp.cdp.send("Fetch.continueRequest", { requestId: m.params.requestId }, inproc).then(() => {}, e => { callbackErrors.push(String(e)); }));
  });
  rp.cdp.onEvent("Network.loadingFailed", (m: { sessionId?: string; params?: { requestId: string; canceled?: boolean } }) => { if (m.sessionId === inproc && m.params) network.push({ id: m.params.requestId, kind: "failed", cancelled: m.params.canceled }); });
  rp.cdp.onEvent("Network.responseReceived", (m: { sessionId?: string; params?: { requestId: string; response: { status: number; url: string } } }) => { if (m.sessionId === inproc && m.params?.response.url.includes("minimax")) network.push({ id: m.params.requestId, kind: "response", status: m.params.response.status }); });
  rp.cdp.onEvent("Network.webSocketCreated", (m: { sessionId?: string; params?: { url?: string } }) => { if (m.sessionId === inproc && m.params?.url) sockets.push(m.params.url); });
  await rp.cdp.send("Network.enable", {}, inproc);
  await rp.cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.minimaxi.com/v1/t2a_v2", requestStage: "Request" }] }, inproc);
  const settingsId = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` })).targetId;
  const settings = await rp.attach(settingsId);
  await until(async () => await rp.evaluate(settings, "!!document.querySelector('#speech-key') && !!chrome.storage?.local") || undefined, 15_000, "设置页");
  const config = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" }, inproc_voice_key: planKey, [PTT_SPEAK_RESULT]: true };
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(config)}).then(()=>true)`);
  await sleep(700);
  await rp.evaluate(settings, "document.querySelector('#speech-key').scrollIntoView({block:'center'});true");
  await rp.click(settings, "#speech-key");
  await rp.typeText(settings, "sk-cp-intentionally-invalid-ptt-acceptance");
  await rp.click(settings, "#speech-save");
  await until(async () => await rp.evaluate(settings, `chrome.storage.local.get(${JSON.stringify(PTT_SPEECH_KEY)}).then(s=>!!s[${JSON.stringify(PTT_SPEECH_KEY)}])`) || undefined, 5000, "无效订阅格式key保存");
  await sleep(1500);
  await hold(work);
  const first = await until(async () => paused[0], 70_000, "第一句真实合成请求挂起");
  assert.equal(first.text, answers[0]); assert.equal(first.model, "speech-2.8-hd");
  assert.equal((await capsule(work))?.speaking, true);
  const timeout = await until(async () => { const r = await speechReply(); return r?.message === "念结果超时" ? r : undefined; }, 48_000, "45秒朗读超时", 100);
  const elapsed = Date.now() - first.at;
  assert.ok(elapsed >= 44_000 && elapsed <= 47_000, `45秒上限（调度余量2秒）：${elapsed}`);
  await until(async () => (await capsule(work))?.speaking === false || undefined, 3000, "超时清除在说");
  assert.equal((await capsule(work))?.phase, "done"); assert.equal(await detail(work), answers[0]);
  evidence.timeout = { elapsed, reply: timeout, release: await release(first), capsule: await capsule(work) };
  await rp.screenshot(work, join(out, "1-timeout-result.png"));
  const panelId = await rp.openSidePanel();
  const panel = await rp.attach(panelId);
  await until(async () => await rp.evaluate(panel, "[...document.querySelectorAll('#messages .msg.notice,#messages .msg.error')].some(n=>n.textContent.includes('结果没念出来：念结果超时'))") || undefined, 15_000, "具体超时原因进对话");
  await rp.screenshot(panel, join(out, "2-timeout-notice.png"));
  await rp.cdp.send("Target.closeTarget", { targetId: panelId });

  rule.steps = [{ text: answers[1]! }];
  await hold(work);
  const old = await until(async () => paused[1], 70_000, "旧轮合成请求挂起");
  assert.equal(old.text, answers[1]); assert.equal((await capsule(work))?.speaking, true);
  rule.steps = [{ text: answers[2]! }];
  await hold(work, async () => {
    await until(async () => { const r = await speechReply(); return r?.reason === "hushed" ? r : undefined; }, 3000, "再次PTT开口真实hush旧句", 50);
    evidence.hush = { state: await capsule(work), release: await release(old) };
    assert.notEqual((await capsule(work))?.phase, "done", "旧句回调不能盖回录音态");
  });
  const fresh = await until(async () => paused[2], 70_000, "新轮真实合成请求（自动放行）");
  assert.equal(fresh.text, answers[2]);
  const rejected = await until(async () => { const r = await speechReply(); return r?.reason === "failed" && /auth|key|token|credential|鉴权|认证|密钥|HTTP (401|403)/i.test(r.message ?? "") ? r : undefined; }, 30_000, "新轮真实MiniMax凭据拒绝");
  assert.ok(network.some(n => n.id === fresh.networkId && n.kind === "response"), "新轮拒绝有真实服务商回应");
  await until(async () => network.some(n => n.id === old.networkId && (n.cancelled || n.kind === "response")) || undefined, 5000, "旧请求真实取消或回应证据");
  const observations = [];
  for (let i = 0; i < 12; i++) {
    const state = await capsule(work), text = await detail(work);
    observations.push({ state, text });
    assert.equal(state?.phase, "done"); assert.equal(state?.speaking, false); assert.equal(text, answers[2]);
    await sleep(250);
  }
  evidence.stale = { reply: rejected, observations };
  await rp.screenshot(work, join(out, "3-new-result-not-overwritten.png"));
  assert.equal(paused.length, 3); assert.deepEqual(callbackErrors, []);
  assert.ok(sockets.length > 0 && sockets.every(url => url.startsWith("wss://api.stepfun.com/step_plan/v1/realtime")), "听写只走真实套餐端点");
} catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
finally {
  await Promise.all(pending);
  if (inproc) await rp.cdp.send("Fetch.disable", {}, inproc).catch(() => {});
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, paused, network, sockets, callbackErrors, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
