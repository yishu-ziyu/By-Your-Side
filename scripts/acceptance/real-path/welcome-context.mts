/** #104：真实扩展的欢迎页跟着网页变，只填草稿、不覆盖、不发任务。 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";
requireHeadless();
const fixtures = [
  { title: "供应商列表", html: '<h1>供应商列表</h1>' + Array.from({ length: 10 }, (_, i) => `<div><h2>供应商${i}</h2><span>北京 · 设备供应</span></div>`).join(""), expected: ["整理供应商", "对比供应商", "概括这一页"] },
  { title: "招聘职位", html: '<h1>招聘职位</h1>' + Array.from({ length: 8 }, (_, i) => `<div><h2>产品经理${i}</h2><span>上海 · 三年以上经验</span></div>`).join(""), expected: ["整理招聘职位", "比较职位要求", "概括这一页"] },
  { title: "Why evaluations matter", html: '<h1>Why evaluations matter</h1>' + '<p>An evaluation connects expected outcomes with observed behavior. Define the expected outcome before measuring the result.</p>'.repeat(4), expected: ["翻译成中文", "提炼文章要点", "概括这一页"] },
];
let mutations = 0;
const site = createServer((req, res) => {
  if (req.method !== "GET") mutations++;
  if (req.url === "/slow") {
    res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end('<title>等待页</title><script>const end=Date.now()+2200;while(Date.now()<end){}</script><div>暂时没有可识别的内容</div>');
    return;
  }
  const c = fixtures[Number(req.url?.slice(1))] ?? fixtures[0]!;
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<title>${c.title}</title>${c.html}`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-welcome-context`);
await mkdir(out, { recursive: true });
const model = await startScriptedModel([]), rp = await launchRealPath();
const evidence: unknown[] = [];
let error: string | null = null;
try {
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/0` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const config = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: config.settingsTargetId });
  const read = () => rp.evaluate(panel, '({labels:[...document.querySelectorAll("#starter-actions button")].map(b=>b.textContent),draft:document.querySelector("#input").value,users:document.querySelectorAll(".msg.user").length})');
  const requestsBefore = model.requests.length;
  for (const [i, c] of fixtures.entries()) {
    await rp.cdp.send("Page.navigate", { url: `${origin}/${i}` }, work);
    await until(async () => await rp.evaluate(work, `document.title===${JSON.stringify(c.title)}`) || undefined, 10_000, "fixture loaded");
    await sleep(700);
    const state = await read(); evidence.push({ title: c.title, state });
    await rp.screenshot(panel, join(out, `${i}.png`));
    assert.deepEqual(state.labels, c.expected, "page-specific suggestions match the approved preview, summary stays last");
    if (i === 0) {
      await rp.click(panel, "#starter-actions button:first-child");
      const drafted = await read();
      assert.equal(drafted.draft, "把当前页面的供应商和已显示的联系方式整理成表格。");
      assert.equal(drafted.users, 0, "suggestion only drafts the request");
    } else assert.equal(state.draft, "把当前页面的供应商和已显示的联系方式整理成表格。", "page changes preserve the existing draft");
  }
  // 真正切换标签页，而不是只在同一页导航。
  const { targetId } = await rp.cdp.send("Target.createTarget", { url: `${origin}/1` }) as { targetId: string };
  const second = await rp.attach(targetId); await rp.cdp.send("Page.bringToFront", {}, second);
  await until(async () => { const s = await read(); return s.labels[0] === "整理招聘职位" ? s : undefined; }, 5000, "new active tab updates suggestions");
  await rp.click(panel, "#starter-actions button:first-child");
  assert.equal((await read()).draft, "把当前页面的供应商和已显示的联系方式整理成表格。", "clicking another suggestion preserves a nonempty draft");
  // 真实页面主线程忙，结构探测排队；侧栏不能跟着等，也不能采用晚到的旧结果。
  const started = Date.now();
  const navigating = rp.cdp.send("Page.navigate", { url: `${origin}/slow` }, second);
  await until(async () => { const s = await read(); return s.labels.length === 1 && s.labels[0] === "概括这一页" ? s : undefined; }, 1900, "slow renderer falls back within the page-probe budget", 30);
  const fallbackMs = Date.now() - started; await navigating; await sleep(2400);
  assert.deepEqual((await read()).labels, ["概括这一页"], "late probes do not restore old suggestions");
  evidence.push({ slowRendererFallbackMs: fallbackMs });
  await rp.cdp.send("Page.navigate", { url: "chrome://version/" }, second);
  await until(async () => { const s = await read(); return s.labels.length === 1 && s.labels[0] === "概括这一页" ? s : undefined; }, 3000, "restricted page falls back without waiting for a model");
  assert.equal(model.requests.length, requestsBefore, "generating and drafting suggestions calls no model");
  assert.equal(mutations, 0, "no page writes or task requests");
  evidence.push({ final: await read(), modelRequestsAdded: model.requests.length - requestsBefore, mutations });
} catch (caught) { error = caught instanceof Error ? caught.stack ?? caught.message : String(caught); }
finally {
  await writeFile(join(out, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", out, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
