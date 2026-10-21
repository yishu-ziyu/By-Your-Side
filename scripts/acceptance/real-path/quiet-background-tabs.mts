/**
 * 助手在后台开的、在后台出声的标签页先静音，用户切过去时恢复声音；开在眼前的页不静音。
 * 只装扩展、隔离构建、本机脚本模型；练习页一打开就用 WebAudio 出声（Chrome 带 --autoplay-policy=no-user-gesture-required）。
 *   npx tsx scripts/acceptance/real-path/quiet-background-tabs.mts --headless
 *   a) 助手用 tabs open 在后台开声音页：这一页是静音的。
 *   d) 扩展重载后（更新时也一样），这一页仍是静音的。
 *   b) 用户切到这一页：静音取消。
 *   c) 助手用 tabs show 开的页在眼前：不静音。
 * 「后台的工作页开始出声就静音」靠 Chrome 的 audible 状态，无头 Chrome 没有声音输出、不会报 audible，这一条在日常 Chrome 里核对。
 * 失败方式：去掉 openTab 里的 quietOpenedTab，a 失败；启动时不重新静音，d 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-quiet-background-tabs`);

await mkdir(out, { recursive: true });

const SOUND = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>声音页</title><body><h1>声音页</h1><script>
const ctx = new AudioContext(); const osc = ctx.createOscillator(); const gain = ctx.createGain(); gain.gain.value = 0.2; osc.connect(gain).connect(ctx.destination); osc.start(); ctx.resume();
</script></body></html>`;
const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url?.startsWith("/sound") ? SOUND : `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>安静页</title><body><h1>安静页</h1></body></html>`);
});
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const OPEN = "静音测试一：去声音页看看";
const SHOW = "静音测试二：打开安静页";

const model = await startScriptedModel([
  { match: OPEN, steps: [{ tool: { name: "tabs", args: { action: "open", url: `${origin}/sound?a` } } }, { text: "声音页已在后台打开。" }] },
  { match: SHOW, steps: [{ tool: { name: "tabs", args: { action: "show", url: `${origin}/quiet` } } }, { text: "安静页已经在你眼前。" }] },
]);

const rp = await launchRealPath({ chromeArgs: ["--autoplay-policy=no-user-gesture-required"] });
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  let panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(() => true)`);
  const ready = 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")';
  await until(async () => await rp.evaluate(panel, ready), 60_000, "侧栏就绪");
  const tabState = (match: string) => rp.evaluate(panel, `chrome.tabs.query({}).then(ts => { const t = ts.find(t => (t.url ?? "").includes(${JSON.stringify(match)})); return t ? { id: t.id, active: t.active, muted: !!t.mutedInfo?.muted, audible: !!t.audible } : null; })`) as Promise<{ id: number; active: boolean; muted: boolean; audible: boolean } | null>;
  const say = async (text: string, done: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes(${JSON.stringify(done)}))`) || undefined, 60_000, `回答：${done}`);
    await until(async () => await rp.evaluate(panel, ready), 60_000, "这一轮结束");
  };

  await say(OPEN, "声音页已在后台打开");
  const opened = await until(async () => { const t = await tabState("/sound?a"); return t && t.muted ? t : null; }, 10_000, "后台声音页静音").catch(async () => await tabState("/sound?a"));
  check("a 助手在后台开的声音页是静音的", !!opened && !opened.active && opened.muted, opened as Json);

  // Chrome 重载扩展时会撤销扩展做过的静音。
  await rp.evaluate(panel, `setTimeout(() => chrome.runtime.reload(), 100), true`).catch(() => {});
  await sleep(4_000);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => await rp.evaluate(panel, ready), 60_000, "重载后侧栏就绪");
  const reloaded = await until(async () => { const t = await tabState("/sound?a"); return t && t.muted ? t : null; }, 10_000, "重载后仍静音").catch(async () => await tabState("/sound?a"));
  check("d 扩展重载后，后台声音页仍是静音的", !!reloaded && !reloaded.active && reloaded.muted, reloaded as Json);

  await rp.evaluate(panel, `chrome.tabs.update(${opened?.id ?? 0}, { active: true }).then(() => true)`);
  const switched = await until(async () => { const t = await tabState("/sound?a"); return t && !t.muted ? t : null; }, 10_000, "切过去后取消静音").catch(async () => await tabState("/sound?a"));
  check("b 用户切到这一页后声音恢复", !!switched && switched.active && !switched.muted, switched as Json);

  await say(SHOW, "安静页已经在你眼前");
  const shown = await tabState("/quiet");
  check("c 开在眼前的页不静音", !!shown && shown.active && !shown.muted, shown as Json);

} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.length > 0 && checks.every(c => c.pass) ? "PASS" : "FAIL", checks }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.length === 0 || checks.some(c => !c.pass)) process.exitCode = 1;
