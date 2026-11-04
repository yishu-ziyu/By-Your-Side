import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, REPO, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-translate-direct`);
await mkdir(out, { recursive: true });
const page = (topic: string) => `<!doctype html><meta charset="utf-8"><title>${topic}</title><h1>${topic}</h1>${Array.from({ length: 20 }, (_, i) => `<p>Paragraph ${i + 1} about ${topic} explains how both people can talk at the same time without waiting for a turn.</p>`).join("")}`;
const site = createServer((q, r) => r.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(page(q.url?.startsWith("/other") ? "Echo cancellation" : "Full duplex voice")));
await new Promise<void>(r => site.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const model = await startScriptedModel([], { delayMs: 800 });
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const WATCH = `(() => { const tr = window.__tr = { t0: performance.now(), done: null }; new MutationObserver(() => { if (tr.done === null && document.querySelector('[data-bys-translation="true"]')) tr.done = performance.now(); }).observe(document.documentElement, { subtree: true, childList: true }); return true; })()`;
const NODES = "document.querySelectorAll('[data-bys-translation]').length";
type Watch = { t0: number; done: number | null };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  const worker = await until(async () => {
    const target = await rp.serviceWorker();
    if (!target) return null;
    const session = await rp.attach(target.targetId);
    return await rp.evaluate(session, `chrome.storage?.local ? chrome.storage.local.set(${JSON.stringify(items)}).then(() => true) : false`).then(ok => ok ? session : null, () => null);
  }, 20000, "扩展后台就绪");
  const translateRequests = () => model.requests.filter(r => r.rule === "translate").length;
  const mainRequests = () => model.requests.filter(r => r.rule !== "translate").length;
  const open = async (url: string) => {
    await rp.cdp.send("Page.navigate", { url }, work);
    await until(async () => (await rp.evaluate(work, "document.readyState === 'complete' && document.querySelectorAll('p').length === 20")) || null, 15000, "练习页载入");
    await rp.cdp.send("Page.bringToFront", {}, work);
  };
  const press = async (): Promise<void> => { await rp.evaluate(work, WATCH); await rp.evaluate(worker, `(chrome.commands.onCommand.dispatch('translate-page'), true)`); };
  const firstTranslation = async (): Promise<number | null> => {
    const end = Date.now() + 8000;
    for (; Date.now() < end; await sleep(100)) {
      const w = await rp.evaluate(work, "window.__tr") as Watch;
      if (w.done !== null) return Math.round(w.done - w.t0);
    }
    return null;
  };
  const settled = () => until(async () => (await rp.evaluate(work, "!document.querySelector('[data-bys-translation=\"pending\"]')")) || null, 30000, "翻译收尾");

  await until(async () => (await rp.evaluate(worker, "chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']}).then(c => c.length > 0)")) || null, 20000, "任务宿主启动");
  await sleep(2000);

  await open(`${origin}/other`);
  await press();
  const dMs = await firstTranslation();
  await settled();
  await rp.screenshot(work, join(out, "d-panel-never-opened.png"));
  check("d 侧栏没开过：1.5 秒内出现第一段译文，主模型请求为 0", dMs !== null && dMs <= 1500 && mainRequests() === 0, { firstTranslationMs: dMs, mainRequests: mainRequests() });

  await rp.attach(await rp.openSidePanel());
  await open(`${origin}/`);
  await press();
  const aMs = await firstTranslation();
  await settled();
  await rp.screenshot(work, join(out, "a-translated.png"));
  check("a 侧栏开着：1.5 秒内出现第一段译文，主模型请求为 0", aMs !== null && aMs <= 1500 && mainRequests() === 0, { firstTranslationMs: aMs, mainRequests: mainRequests() });
  const afterA = translateRequests();

  await press();
  const restored = await until(async () => (await rp.evaluate(work, `${NODES} === 0`)) || null, 8000, "还原").then(() => 0, async () => Number(await rp.evaluate(work, NODES)));
  await rp.screenshot(work, join(out, "b-restored.png"));
  check("b 再按一下：还原，页面没有译文或占位", restored === 0, { translationNodes: restored });

  await press();
  const cMs = await firstTranslation();
  await settled();
  await rp.screenshot(work, join(out, "c-retranslated.png"));
  check("c 第三下：重新译出，翻译请求不增加", cMs !== null && translateRequests() === afterA, { firstTranslationMs: cMs, requestsBefore: afterA, requestsAfter: translateRequests() });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", checks, requests: model.requests, dependency: "real isolated extension, local page; scripted translation model, no main-model rules" }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(r => site.close(() => r()));
}

console.log(JSON.stringify({ status: checks.every(c => c.pass) ? "pass" : "fail", out }));
if (checks.some(c => !c.pass)) process.exitCode = 1;
