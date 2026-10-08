/** PTT 念结果：真实 MiniMax 无效订阅凭据失败 + 设置关闭朗读。
 * npx tsx scripts/acceptance/real-path/ptt-faults.mts --headless
 * Step Plan 听写仍走真实套餐；只替换任务模型。MiniMax 请求不拦截、不伪造回复。
 * 不验正常听写、音色、45秒半开超时或过期回调；这两轮只为进入真实 PTT 念结果路径。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";
import { PTT_SPEECH_KEY, PTT_SPEAK_RESULT } from "../../../extension/src/shared/ptt.js";

requireHeadless();
const planKey = (await readFile(join(homedir(), ".sideagent", "step-plan.key"), "utf8").catch(() => "")).trim();
if (!planKey || process.platform !== "darwin") {
  console.log(JSON.stringify({ status: "BLOCKED", reason: !planKey ? "缺少已有 Step Plan 听写凭据" : "本脚本需要已有 macOS say 麦克风夹具" }));
  process.exit(2);
}
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-ptt-faults`);
await mkdir(out, { recursive: true });
const spoken = "把这三家公司整理成一张表，按营收排一下。";
const answer = "已经按营收排好了表，Lumen 最高。其余两家也已整理。";
const firstSentence = "已经按营收排好了表，Lumen 最高。";
const wav = join(out, "microphone.wav");
execFileSync("say", ["-v", "Tingting", "-o", wav, "--data-format=LEI16@24000", `[[slnc 200]]${spoken}[[slnc 600]]`]);
const speechMs = Math.round(((await readFile(wav)).length - 44) / 48_000 * 1000);
const model = await startScriptedModel([{ match: "整理成一张表", steps: [{ text: answer }] }]);
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end("<!doctype html><title>三家候选供应商</title><h1>Lumen、Harbor、Kite</h1>"));
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const rp = await launchRealPath({ microphoneWav: wav });
const requests: Array<{ id: string; url: string; model?: string; text?: string }> = [];
const responses: Array<{ id: string; status: number }> = [];
const sockets: string[] = [];
const evidence: Record<string, unknown> = {};
let error: string | null = null;
const capsule = (work: string) => rp.evaluate(work, `(() => { const h = document.querySelector('[data-sideagent-overlay="ptt-capsule"]'); return h ? {phase:h.dataset.phase,speaking:h.dataset.speaking==='true'} : null; })()`);
const panelState = (panel: string) => rp.evaluate(panel, `({users:[...document.querySelectorAll('#messages .msg.user .user-msg-text')].map(m=>m.textContent.trim()),answers:[...document.querySelectorAll('#messages .msg.assistant')].map(m=>m.textContent),notices:[...document.querySelectorAll('#messages .msg.notice,#messages .msg.error')].map(m=>m.textContent).filter(t=>t.startsWith('结果没念出来：'))})`);
type DomNode = { nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };
async function capsuleDetail(work: string): Promise<string | null> {
  const { root } = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work) as { root: DomNode };
  const all = (n: DomNode): DomNode[] => [n, ...[...(n.children ?? []), ...(n.shadowRoots ?? [])].flatMap(all)];
  const host = all(root).find(n => n.attributes?.some((v, i, a) => v === "data-sideagent-overlay" && a[i + 1] === "ptt-capsule"));
  const detail = host && all(host).find(n => n.attributes?.some((v, i, a) => v === "class" && a[i + 1]?.split(/\s+/).includes("detail")));
  return detail ? all(detail).filter(n => n.nodeName === "#text").map(n => n.nodeValue ?? "").join("") : null;
}
async function hold(work: string) {
  await rp.cdp.send("Page.bringToFront", {}, work);
  const key = { key: "Alt", code: "AltRight", windowsVirtualKeyCode: 18, location: 2 };
  const start = Date.now();
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key }, work);
  while (Date.now() - start < speechMs + 400) {
    await sleep(100);
    await rp.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", autoRepeat: true, ...key }, work);
  }
  await rp.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key }, work);
}
try {
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "练习页");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/suppliers` }, work);
  const doc = await until(async () => (await rp.targets()).find(t => t.url.endsWith("/inproc.html")), 30_000, "离屏文档");
  const inproc = await rp.attach(doc.targetId);
  rp.cdp.onEvent("Network.requestWillBeSent", (m: { sessionId?: string; params?: { requestId: string; request: { url: string; postData?: string } } }) => {
    if (m.sessionId !== inproc || !m.params?.request.url.includes("minimax")) return;
    const body = JSON.parse(m.params.request.postData ?? "{}") as { model?: string; text?: string };
    requests.push({ id: m.params.requestId, url: m.params.request.url, model: body.model, text: body.text });
  });
  rp.cdp.onEvent("Network.responseReceived", (m: { sessionId?: string; params?: { requestId: string; response: { status: number; url: string } } }) => {
    if (m.sessionId === inproc && m.params?.response.url.includes("minimax")) responses.push({ id: m.params.requestId, status: m.params.response.status });
  });
  rp.cdp.onEvent("Network.webSocketCreated", (m: { sessionId?: string; params?: { url?: string } }) => { if (m.sessionId === inproc && m.params?.url) sockets.push(m.params.url); });
  await rp.cdp.send("Network.enable", {}, inproc);
  const settingsId = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html` })).targetId;
  const settings = await rp.attach(settingsId);
  await until(async () => await rp.evaluate(settings, "!!document.querySelector('#speech-key') && !!chrome.storage?.local") || undefined, 15_000, "设置页");
  const config = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" }, inproc_voice_key: planKey };
  await rp.evaluate(settings, `chrome.storage.local.set(${JSON.stringify(config)}).then(()=>true)`);
  await sleep(700);
  // 故意无效，但订阅格式正确：必须送到真实 MiniMax，由服务商拒绝，而不是本地格式拒绝。
  await rp.evaluate(settings, 'document.querySelector("#speech-key").scrollIntoView({block:"center"});true');
  await rp.click(settings, "#speech-key");
  await rp.typeText(settings, "sk-cp-intentionally-invalid-ptt-acceptance");
  await rp.click(settings, "#speech-save");
  await until(async () => await rp.evaluate(settings, `chrome.storage.local.get(${JSON.stringify(PTT_SPEECH_KEY)}).then(s=>!!s[${JSON.stringify(PTT_SPEECH_KEY)}])`) || undefined, 5000, "无效订阅格式key已保存");
  if (!await rp.evaluate(settings, "document.querySelector('#ptt-speak').checked")) await rp.click(settings, "#ptt-speak");
  await sleep(1500);
  await hold(work);
  const failed = await until(async () => {
    const r = JSON.parse(String(await rp.evaluate(inproc, "document.documentElement.dataset.pttSpeech ?? 'null'")));
    return r?.ok === false && r.reason === "failed" ? r : undefined;
  }, 90_000, "真实 MiniMax 拒绝后失败回执", 100);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, "https://api.minimaxi.com/v1/t2a_v2");
  assert.equal(requests[0]!.model, "speech-2.8-hd");
  assert.equal(requests[0]!.text, firstSentence);
  const response = responses.find(r => r.id === requests[0]!.id);
  assert.ok(response, "收到真实服务商HTTP回应，不能以本机断线冒充key拒绝");
  const raw = await rp.cdp.send("Network.getResponseBody", { requestId: response.id }, inproc) as { body: string; base64Encoded: boolean };
  assert.equal(raw.base64Encoded, false);
  const provider = JSON.parse(raw.body) as { base_resp?: { status_code?: number; status_msg?: string } };
  if (response.status === 200) {
    assert.ok(provider.base_resp?.status_code, "HTTP成功但业务拒绝的非SSE JSON错误");
    assert.match(provider.base_resp?.status_msg ?? "", /auth|key|token|credential|鉴权|认证|密钥/i, "拒绝原因确实是凭据，不把额度或代理失败算通过");
    assert.ok(provider.base_resp?.status_msg && failed.message.includes(provider.base_resp.status_msg), "真实JSON错误原因没有被吞掉");
  } else {
    assert.ok(response.status === 401 || response.status === 403, "服务商确实拒绝凭据，不把限流或网络失败算通过");
    assert.ok(failed.message.includes(`HTTP ${response.status}`), "如实报告真实HTTP错误");
  }
  await until(async () => (await capsule(work))?.speaking === false || undefined, 5000, "失败后不再在说");
  assert.equal((await capsule(work))?.phase, "done");
  assert.equal(await capsuleDetail(work), firstSentence, "朗读失败不替换或丢失胶囊结果");
  evidence.failure = { reply: failed, response, provider, capsule: await capsule(work) };
  await rp.screenshot(work, join(out, "1-failed-capsule.png"));
  const panelId = await rp.openSidePanel();
  const panel = await rp.attach(panelId);
  const first = await until(async () => { const s = await panelState(panel); return s.notices.some((n: string) => n.includes(failed.message)) ? s : undefined; }, 15_000, "对话保留具体朗读错误原因");
  evidence.firstPanel = first;
  await rp.screenshot(panel, join(out, "2-error-reason.png"));
  await rp.cdp.send("Target.closeTarget", { targetId: panelId });

  // 真设置开关关闭后重走PTT：无MiniMax请求、结果仍在、没有新朗读错误。
  await rp.cdp.send("Page.bringToFront", {}, settings);
  await rp.evaluate(settings, 'document.querySelector("#ptt-speak").scrollIntoView({block:"center"});true');
  assert.equal(await rp.evaluate(settings, "document.querySelector('#ptt-speak').checked"), true);
  await rp.click(settings, "#ptt-speak");
  await until(async () => await rp.evaluate(settings, `chrome.storage.local.get(${JSON.stringify(PTT_SPEAK_RESULT)}).then(s=>s[${JSON.stringify(PTT_SPEAK_RESULT)}]===false)`) || undefined, 5000, "设置关闭朗读已保存");
  await sleep(1000);
  await hold(work);
  await until(async () => (await capsule(work))?.phase === "done" || undefined, 70_000, "关闭朗读仍显示任务结果", 100);
  await sleep(1500);
  assert.equal(requests.length, 1, "关掉朗读后不请求MiniMax");
  assert.equal((await capsule(work))?.speaking, false);
  assert.equal(await capsuleDetail(work), firstSentence);
  const nextPanel = await rp.attach(await rp.openSidePanel());
  const second = await until(async () => { const s = await panelState(nextPanel); return s.users.length === 2 && s.answers.length === 2 ? s : undefined; }, 15_000, "第二轮结果进对话");
  assert.equal(second.notices.length, first.notices.length, "关闭朗读不增加错误提示");
  evidence.disabled = { panel: second, capsule: await capsule(work) };
  await rp.screenshot(nextPanel, join(out, "3-disabled.png"));
  assert.ok(sockets.length > 0 && sockets.every(url => url.startsWith("wss://api.stepfun.com/step_plan/v1/realtime")), "听写仍只走Step Plan套餐");
} catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", error, evidence, requests, responses, sockets, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
