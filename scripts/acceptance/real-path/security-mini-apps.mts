import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-security-mini-apps`);
await mkdir(out, { recursive: true });
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<title>工具授权练习页</title><main>原页面</main>"));
await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const tool = `<app title="授权测试">
<button id="ask">准备消息</button><button id="open">准备网页</button>
<script>
let tries=0;
const timer=setInterval(()=>{if(++tries>6){clearInterval(timer);return}bys.send("不应自动发送");parent.postMessage({miniApp:"open",url:${JSON.stringify(`${origin}/unrequested`)}},"*")},100);
document.querySelector("#ask").onclick=()=>{bys.send("我核对过这条工具消息");setTimeout(()=>bys.send("不应替换原消息"),20)};
document.querySelector("#open").onclick=()=>parent.postMessage({miniApp:"open",url:${JSON.stringify(`${origin}/requested`)}},"*");
</script></app>`;
const model = await startScriptedModel([
  { match: "安全工具验收", steps: [{ text: tool }] },
  { match: "我核对过这条工具消息", steps: [{ text: "收到，只有这条消息被发送。" }] },
  { match: "不应", steps: [{ text: "发生了未经授权的发送。" }] },
]);
const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
let panel = "";
const check = (name: string, pass: boolean, detail?: unknown) => { checks.push({ name, pass, detail }); assert.ok(pass, name); };
try {
  const workTarget = (await rp.targets()).find(t => t.url === "about:blank")!;
  const work = await rp.attach(workTarget.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } })}).then(()=>true)`);
  await until(() => rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "安全工具验收");
  await rp.pressEnter(panel);
  await until(() => rp.evaluate(panel, '!!document.querySelector(".gc-app iframe") && !document.querySelector(".msg.assistant.streaming")'), 30_000, "小工具出现");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "只是在输入框打字");
  await sleep(1200);
  const users = () => rp.evaluate(panel, '[...document.querySelectorAll("#messages .msg.user")].map(m=>m.textContent)') as Promise<string[]>;
  const messages = await users();
  const leaked = (await rp.targets()).filter(t => t.url === `${origin}/unrequested`);
  await rp.screenshot(panel, join(out, "1-unrelated-click.png"));
  check("侧栏打字不发送消息、不打开网页", messages.length === 1 && leaked.length === 0, { messages, opened: leaked.length });
  const cancel = () => rp.evaluate(panel, '[...document.querySelectorAll(".gc-app-bar button")].find(b=>b.textContent==="取消")?.getBoundingClientRect().toJSON()');
  if (await cancel()) await rp.click(panel, ".gc-app-bar button:last-child");
  const frameTarget = await until(async () => (await rp.targets()).find(t => t.type === "iframe" && t.url.includes("mini-app.html")), 10_000, "沙箱");
  let frame = await rp.attach(frameTarget.targetId);
  const clickInFrame = async (selector: string) => {
    await rp.evaluate(panel, 'document.querySelector(".gc-app").scrollIntoView({block:"center"});true');
    const outer = await rp.evaluate(panel, 'document.querySelector(".gc-app iframe").getBoundingClientRect().toJSON()');
    const inside = await rp.evaluate(frame, `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: outer.x + inside.x + inside.width / 2, y: outer.y + inside.y + inside.height / 2, button: "left", clickCount: 1 }, panel);
  };
  await clickInFrame("#ask");
  await until(() => rp.evaluate(panel, 'document.querySelector(".gc-app-bar")?.innerText.includes("我核对过这条工具消息")'), 10_000, "宿主展示具体消息");
  await sleep(200);
  await rp.evaluate(panel, 'document.querySelector(".gc-app-bar button").click();true');
  check("合成点击不能授权发送", (await users()).length === 1);
  await rp.screenshot(panel, join(out, "2-host-action.png"));
  await rp.click(panel, ".gc-app-bar button");
  await until(async () => (await users()).length === 2, 10_000, "真实点击发送一次");
  await sleep(250);
  check("只发送展示的消息，不接受随后替换", (await users()).filter(s => s.includes("我核对过这条工具消息")).length === 1 && !(await users()).some(s => s.includes("不应")), await users());
  await until(() => rp.evaluate(panel, '!document.querySelector(".msg.assistant.streaming") && !document.querySelector("#send-btn")?.classList.contains("stopping")'), 30_000, "助手回应结束");
  await clickInFrame("#open");
  await until(() => rp.evaluate(panel, 'document.querySelector(".gc-app-bar")?.innerText.includes("打开网页")'), 10_000, "宿主展示网址");
  check("提议打开不等于打开", !(await rp.targets()).some(t => t.url === `${origin}/requested`));
  await rp.click(panel, ".gc-app-bar button");
  const opened = await until(async () => (await rp.targets()).find(t => t.url === `${origin}/requested`), 10_000, "真实点击打开一次");
  check("只打开一个目标网页", (await rp.targets()).filter(t => t.url === `${origin}/requested`).length === 1);
  await rp.cdp.send("Target.closeTarget", { targetId: opened.targetId });
  await rp.cdp.send("Page.reload", {}, panel);
  await until(() => rp.evaluate(panel, '!!document.querySelector(".gc-app iframe") && document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false'), 30_000, "历史重放");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "重开后打字");
  await sleep(1000);
  check("历史重放不恢复授权", (await users()).length === 2 && !(await rp.targets()).some(t => t.url === `${origin}/unrequested`));
  await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, panel);
  check("深色与减少动态效果下动作按钮仍可见", await rp.evaluate(panel, 'matchMedia("(prefers-color-scheme: dark)").matches && matchMedia("(prefers-reduced-motion: reduce)").matches && !!document.querySelector(".gc-app-bar button")?.checkVisibility()'));
  await rp.screenshot(panel, join(out, "3-replay-dark-reduced.png"));
  if (await cancel()) await rp.click(panel, ".gc-app-bar button:last-child");
  frame = await rp.attach((await rp.targets()).find(t => t.type === "iframe" && t.url.includes("mini-app.html"))!.targetId);
  await clickInFrame("#open");
  await until(() => rp.evaluate(panel, 'document.querySelector(".gc-app-bar")?.innerText.includes("打开网页")'), 10_000, "旧任务提出动作");
  await rp.evaluate(panel, 'document.querySelector(".gc-app-bar button").id="stale-mini-action"; document.querySelector("#input").value="";true');
  await rp.click(panel, "#input");
  await rp.typeText(panel, "我核对过这条工具消息");
  await rp.pressEnter(panel);
  await until(async () => (await users()).length === 3, 10_000, "新任务已提交");
  await rp.click(panel, "#stale-mini-action");
  await until(() => rp.evaluate(panel, 'document.querySelector(".gc-app-bar")?.innerText.includes("页面或对话已经变化")'), 10_000, "旧动作失效");
  check("新任务不能沿用旧动作", !(await rp.targets()).some(t => t.url === `${origin}/requested`) && (await users()).length === 3);
  const windowId = await rp.evaluate(panel, `chrome.windows.create({url:${JSON.stringify(origin)},focused:false}).then(w=>w.id)`);
  const beforePanels = new Set((await rp.targets()).filter(t => t.url.includes("sidepanel.html")).map(t => t.targetId));
  await rp.openSidePanel(windowId);
  const secondTarget = await until(async () => (await rp.targets()).find(t => t.url.includes("sidepanel.html") && !beforePanels.has(t.targetId)), 15_000, "第二个侧栏");
  const second = await rp.attach(secondTarget.targetId);
  await until(() => rp.evaluate(second, 'document.querySelector("#send-btn")?.disabled===false && document.querySelector("#conversation-new")?.disabled===false'), 30_000, "第二个侧栏就绪");
  await rp.click(second, "#input");
  await rp.typeText(second, "另一个窗口打字");
  await sleep(1000);
  check("另一个窗口的输入不会授权旧卡片", (await users()).length === 3 && !(await rp.targets()).some(t => t.url === `${origin}/unrequested`));
} catch (error) {
  checks.push({ name: "执行流程", pass: false, detail: String(error) });
  if (panel) await rp.screenshot(panel, join(out, "failure.png")).catch(() => {});
} finally {
  await rp.close();
  await rp.remove();
  await model.close();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
await writeFile(join(out, "result.json"), JSON.stringify({ checks, dependency: "真实隔离扩展、本机网站、脚本模型" }, null, 2));
console.log(JSON.stringify({ out, checks }, null, 2));
assert.ok(checks.length >= 8 && checks.every(c => c.pass), "小工具授权安全验收未通过");
