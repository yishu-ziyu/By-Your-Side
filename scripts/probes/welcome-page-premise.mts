import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchRealPath, requireHeadless, siteAddress, until, sleep, REPO } from "../acceptance/real-path/harness.mts";
import { configureViaSettings } from "../acceptance/real-path/inproc-config.mts";
import { startScriptedModel } from "../acceptance/real-path/scripted-model.mts";
requireHeadless();
const fixtures = [
  { name: "供应商列表", html: Array.from({ length: 10 }, (_, i) => `<div class="vendor"><h2>供应商 ${i + 1}</h2><span>设备供应 · 北京 · 联系方式</span></div>`).join("") },
  { name: "招聘职位", html: Array.from({ length: 8 }, (_, i) => `<div class="job"><h2>产品经理 ${i + 1}</h2><span>上海 · 经验三年以上 · 查看详情</span></div>`).join("") },
  { name: "Why evaluations matter", html: Array.from({ length: 4 }, () => `<p>${"An evaluation connects the expected outcome with observed behavior. ".repeat(4)}</p>`).join("") },
];
const site = createServer((req, res) => {
  const fixture = fixtures[Number(req.url?.slice(1))] ?? fixtures[0]!;
  res.writeHead(200, { "content-type": "text/html;charset=utf-8" }).end(`<title>${fixture.name}</title><h1>${fixture.name}</h1>${fixture.html}`);
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const out = join(REPO, "out/acceptance/session-recovery/welcome-premise");
await mkdir(out, { recursive: true });
const model = await startScriptedModel([]);
const rp = await launchRealPath();
const evidence = [];
try {
  const tab = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(tab.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/0` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const config = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "fixture", credential: { type: "api_key", key: "local-fixture" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: config.settingsTargetId });
  for (const [i, fixture] of fixtures.entries()) {
    await rp.cdp.send("Page.navigate", { url: `${origin}/${i}` }, work);
    await until(async () => await rp.evaluate(work, `document.title === ${JSON.stringify(fixture.name)}`) || undefined, 10_000, "fixture loaded");
    await sleep(700);
    const labels = await rp.evaluate(panel, '[...document.querySelectorAll("#starter-actions button")].map(b=>b.textContent)');
    const content = await rp.evaluate(work, "document.body.innerText");
    await rp.screenshot(panel, join(out, `${i}.png`));
    await writeFile(join(out, `${i}.html`), String(await rp.evaluate(panel, "document.documentElement.outerHTML")));
    evidence.push({ source: `${origin}/${i}`, title: fixture.name, labels, content });
  }
  await writeFile(join(out, "result.json"), JSON.stringify({ dependency: "real isolated extension; controlled HTML pages; local scripted model", evidence }, null, 2));
  console.log(JSON.stringify({ out, evidence: evidence.map(({ title, labels }) => ({ title, labels })) }));
} finally {
  await rp.close(); await rp.remove(); await model.close(); site.closeAllConnections(); site.close();
}
