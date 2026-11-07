import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-security-fetch`);
await mkdir(out, { recursive: true });
const received: Array<{ path: string; body: string; tag: string }> = [];
const site = createServer(async (req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.setEncoding("utf8"); for await (const part of req) body += part;
    received.push({ path: req.url ?? "", body, tag: String(req.headers["x-test-tag"] ?? "") });
    if (req.url === "/find/redirect") { res.writeHead(307, { location: "/other" }).end(); return; }
    res.end("已保存测试内容");
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>请求确认练习页</title><main>只操作测试数据</main>");
});
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const port = siteAddress(site).port;
const origin = `http://public.security.test:${port}`;
const scenarios = [
  { name: "搜索伪装", path: "/transfer/find", choice: "yes", expected: 1 },
  { name: "保存伪装", path: "/save", choice: "no", expected: 0 },
  { name: "查询伪装", path: "/graphql", choice: "yes", expected: 1 },
  { name: "转向不沿用授权", path: "/find/redirect", choice: "yes", expected: 1 },
] as const;
const model = await startScriptedModel(scenarios.map(s => ({
  match: `安全验收 ${s.name}`,
  steps: [
    { tool: { name: "fetch", args: { url: `${origin}${s.path}`, method: "POST", headers: { "x-test-tag": encodeURIComponent(s.name) }, body: JSON.stringify({ query: "{ viewer { id } }", text: s.name }) } } },
    { text: `${s.name}检查结束。` },
  ],
})));
const rp = await launchRealPath({ chromeArgs: ["--host-resolver-rules=MAP public.security.test 127.0.0.1", "--no-proxy-server"] });
const checks: Array<{ name: string; pass: boolean; detail: unknown }> = [];
let panel = "";
try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  const idle = 'document.querySelector("#send-btn")?.disabled === false && document.querySelector("#conversation-new")?.disabled === false && !document.querySelector("#send-btn")?.classList.contains("stopping") && !document.querySelector(".msg.assistant.streaming")';
  await until(() => rp.evaluate(panel, idle), 60_000, "侧栏就绪");
  for (const scenario of scenarios) {
    await until(() => rp.evaluate(panel, idle), 10_000, "上一轮结束");
    const before = received.length;
    await rp.click(panel, "#input");
    await rp.typeText(panel, `安全验收 ${scenario.name}`);
    await rp.pressEnter(panel);
    const state = await until(async () => await rp.evaluate(panel, `document.querySelector(".send-confirm[data-state=open]") ? "confirm" : document.querySelector("#messages")?.innerText.includes(${JSON.stringify(`${scenario.name}检查结束`)}) ? "done" : null`), 30_000, "确认或任务结束");
    const pre = received.slice(before);
    checks.push({ name: `${scenario.name}确认前未发出`, pass: state === "confirm" && pre.length === 0, detail: { state, pre } });
    if (state === "confirm") {
      const copy = String(await rp.evaluate(panel, 'document.querySelector(".send-confirm[data-state=open]")?.innerText'));
      checks.push({ name: `${scenario.name}不假称只读`, pass: !copy.includes("不会发布或修改"), detail: copy });
      await rp.screenshot(panel, join(out, `${scenario.name}-confirm.png`));
      await until(() => rp.evaluate(panel, `(() => { const b=document.querySelector(".send-confirm[data-state=open] .send-confirm-${scenario.choice}"); return b && !b.disabled && !b.hasAttribute("data-arming"); })()`), 10_000, "按钮可点击");
      await rp.click(panel, `.send-confirm[data-state=open] .send-confirm-${scenario.choice}`);
    }
    await until(() => rp.evaluate(panel, `document.querySelector("#messages")?.innerText.includes(${JSON.stringify(`${scenario.name}检查结束`)})`), 30_000, "任务结束");
    await sleep(300);
    const posts = received.slice(before);
    checks.push({ name: `${scenario.name}只执行授权请求`, pass: posts.length === scenario.expected && posts.every(p => p.path === scenario.path && p.tag === encodeURIComponent(scenario.name) && JSON.parse(p.body).text === scenario.name), detail: posts });
    await rp.screenshot(panel, join(out, `${scenario.name}-result.png`));
  }
} catch (error) {
  checks.push({ name: "执行流程", pass: false, detail: { error: String(error), panel: panel ? await rp.evaluate(panel, 'document.querySelector("#messages")?.innerText.slice(-1800)').catch(() => "") : "" } });
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
await writeFile(join(out, "result.json"), JSON.stringify({ checks, dependency: "真实隔离扩展、本机网站、脚本模型；测试域名只解析到本机测试服务" }, null, 2));
console.log(JSON.stringify({ out, checks }, null, 2));
assert.ok(checks.length >= scenarios.length * 2 && checks.every(c => c.pass), "请求确认安全验收未通过");
