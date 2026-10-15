/**
 * 两个侧栏页面各看各的会话（docs/evals/20261015-per-panel-conversation.md）。
 *   甲 侧栏 A 问一句，答完。
 *   乙 第二个窗口开侧栏 B：先跟 A 看同一个会话；B 点「新会话」再问一句，A 仍是甲会话。
 *   丙 A 点「新会话」，问一句慢慢写出来的；写的过程中和写完后，B 都只有乙会话，没有这段字。
 *   丁 A 从会话菜单切回甲会话，B 不动。
 *   戊 刷新 B：回放的仍是乙会话的问答，不是 A 正在看的会话。
 *   己 A 在甲会话、B 在乙会话，乙会话的任务连着遇到 429：B 倒计时并自己重试，答完；A 没有出错卡。
 *   庚 B 刷新时还记着一个已经不存在的会话：B 换到一个新会话，在里面问得通；A 不动。
 *   辛 刚点过 B，再在 A 所在窗口的网页上划词、按快捷键、点「在侧栏继续」：选段进 A 正看着的会话，B 不动。
 * 右键菜单本身在无窗口浏览器里点不到；它和辛走同一个「按动手的窗口找侧栏」的判断（conversationForWindow），这里用快捷键这条路代替。
 * 失败方式：一个侧栏切会话，另一个跟着切；A 正在写的回答出现在 B；刷新 B 后换成 A 的会话；
 *   另一个侧栏拿着重试锁，B 的出错只给手动按钮；划词交给了最近点过、却不在这个窗口的侧栏。
 * 产物：out/acceptance/real-path/<时间>-per-panel-conversation/*.png、result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-per-panel-conversation`);

await mkdir(artifacts, { recursive: true });

const ASK = { a: "甲会话问题", b: "乙会话问题", slow: "丙慢慢说", retry: "己重试问题" };

const ANSWER = { a: "甲答完了。", b: "乙答完了。", slow: `丙开始写。${"丙一段一段地写出来，".repeat(10)}丙写完了。`, retry: "己重试后答完了。" };

const QUOTE = "米娅负责编辑。";

// 任务请求带上当前标签页的文字（第二个侧栏开在标签页里，会带上别的会话的问题），脚本模型按顺序挑第一条匹配的：后问的排前面。
const model = await startScriptedModel([
  { match: "庚新会话问题", steps: [{ text: "庚答完了。" }] },
  { match: ASK.retry, steps: [{ text: ANSWER.retry }] },
  { match: ASK.slow, steps: [{ text: ANSWER.slow, chunkDelayMs: 1_000 }] },
  { match: ASK.b, steps: [{ text: ANSWER.b }] },
  { match: ASK.a, steps: [{ text: ANSWER.a }] },
]);

// 挡在模型前面：接下来几次任务请求（带工具表）回 429。
let failNext = 0;

const gate: string[] = [];

const front = createServer(async (req, res) => {
  let body = "";

  for await (const chunk of req) body += String(chunk);
  const task = /"tools"\s*:\s*\[\s*\{/.test(body);

  if (task && failNext > 0) {
    failNext -= 1;
    gate.push("429");
    res.writeHead(429, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Rate limit reached, please retry later" } }));

    return;
  }

  if (task) gate.push("ok");
  const upstream = await fetch(`${model.baseUrl.replace(/\/$/, "")}${(req.url ?? "").replace(/^\/v1/, "")}`, { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "POST" ? body : undefined });
  res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" }).end(Buffer.from(await upstream.arrayBuffer()));
});

await new Promise<void>(resolve => front.listen(0, "127.0.0.1", resolve));

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>名单</title><p>${QUOTE}</p>`); });

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let a = "";

let b = "";

try {
  a = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(a, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: `http://127.0.0.1:${siteAddress(front).port}/v1` },
    "inproc_cred:custom": { type: "api_key", key: "test-key" },
  })}).then(() => true)`);

  const text = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  const ready = (panel: string, label: string) => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, label);
  const shows = (panel: string, needle: string, label: string, ms = 40_000) => until(async () => (await text(panel)).includes(needle) || undefined, ms, label);
  const send = async (panel: string, ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };
  const newConversation = async (panel: string, label: string) => {
    const before = await text(panel);
    await rp.click(panel, "#conversation-new");
    await until(async () => (await text(panel)) !== before && !(await text(panel)).includes(ASK.a) || undefined, 15_000, label);
    await ready(panel, `${label}：可以输入`);
  };

  evidence.stage = "甲";
  await ready(a, "甲：侧栏 A 就绪");
  await send(a, ASK.a);
  await shows(a, ANSWER.a, "甲：A 看到回答");

  evidence.stage = "乙";
  const extensionId = String(await rp.evaluate(a, "chrome.runtime.id"));
  b = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${extensionId}/sidepanel.html`, newWindow: true })).targetId);
  await shows(b, ANSWER.a, "乙：新开的 B 先显示 A 的会话");
  await newConversation(b, "乙：B 换到新会话");
  await send(b, ASK.b);
  await shows(b, ANSWER.b, "乙：B 看到回答");
  await sleep(1_000);
  const aAfterB = await text(a);
  assert.ok(aAfterB.includes(ANSWER.a) && !aAfterB.includes(ASK.b), "乙：B 新建会话并提问后，A 仍是甲会话");

  evidence.stage = "丙";
  await newConversation(a, "丙：A 换到新会话");
  assert.ok((await text(b)).includes(ANSWER.b), "丙：A 新建会话后，B 仍是乙会话");
  await send(a, ASK.slow);
  // 侧栏可能等整段到齐才显示：以模型那头还在一段一段地发为准。
  const streaming = () => model.requests.find(r => r.rule === ASK.slow && r.firstTextAt !== undefined);
  await until(async () => streaming() || undefined, 40_000, "丙：A 的回答开始写");
  const during: string[] = [];

  while (!streaming()!.finished) {
    const seen = await text(b);
    during.push(seen.includes("丙") ? "B 出现了丙" : "B 没有丙");
    assert.ok(!seen.includes("丙"), "丙：A 写的过程中，B 不出现这段字");
    assert.ok(seen.includes(ANSWER.b), "丙：A 写的过程中，B 仍是乙会话");
    await sleep(300);
  }

  await shows(a, "丙写完了", "丙：A 写完");
  evidence.slowSamples = during.length;
  assert.ok(during.length >= 3, "丙：至少在写的过程中看了 B 三次");
  await rp.screenshot(a, join(artifacts, "a-streaming-done.png"));
  await rp.screenshot(b, join(artifacts, "b-while-a-streams.png"));
  assert.ok(!(await text(b)).includes("丙"), "丙：A 写完后，B 也没有这段字");

  evidence.stage = "丁";
  await rp.click(a, "#conversation-switcher");
  await sleep(200);
  await rp.click(a, `#conversation-menu [data-conversation-id][title*="${ASK.a}"]`);
  await shows(a, ANSWER.a, "丁：A 切回甲会话");
  await sleep(1_000);
  const bAfterSwitch = await text(b);
  assert.ok(bAfterSwitch.includes(ANSWER.b) && !bAfterSwitch.includes(ASK.a), "丁：A 切会话后，B 仍是乙会话");

  evidence.stage = "戊";
  await rp.evaluate(b, "setTimeout(() => location.reload(), 0), true");
  await sleep(1_500);
  await shows(b, ANSWER.b, "戊：刷新后 B 回放乙会话");
  await sleep(1_500);
  const bReloaded = await text(b);
  assert.ok(!bReloaded.includes(ASK.a) && !bReloaded.includes("丙"), "戊：刷新后 B 没有换成 A 的会话");
  assert.ok((await text(a)).includes(ANSWER.a), "戊：刷新 B 后 A 仍是甲会话");
  await rp.screenshot(b, join(artifacts, "b-after-reload.png"));

  evidence.stage = "己";
  const countdown = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector(".error-card:not(.is-retired) .error-card-countdown [aria-hidden]")?.textContent ?? ""'));
  await ready(b, "己：刷新后的 B 可以输入");
  // 助手自己先悄悄重试几次，还不行才出卡（和 auto-retry-countdown 的庚一样用 3 次）。
  failNext = 3;
  await send(b, ASK.retry);
  await until(async () => /第 1 次/.test(await countdown(b)) || undefined, 60_000, "己：B 自己倒计时");
  await rp.screenshot(b, join(artifacts, "b-retry-countdown.png"));
  await shows(b, ANSWER.retry, "己：B 重试后答完", 60_000);
  evidence.retryGate = [...gate];
  assert.equal(gate.at(-1), "ok", "己：重试后请求成功");
  assert.equal(await rp.evaluate(b, 'document.querySelectorAll(".error-card:not(.is-retired)").length'), 0, "己：B 答完后出错卡收起");
  assert.equal(await rp.evaluate(a, 'document.querySelectorAll(".error-card").length'), 0, "己：A 没有出错卡");

  evidence.stage = "庚";
  const titleOf = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#conversation-switcher")?.textContent ?? ""'));
  const aTitle = await titleOf(a);
  await rp.evaluate(b, `sessionStorage.setItem("sideagent-panel-conversation", "gone-conversation-1"), setTimeout(() => location.reload(), 0), true`);
  await sleep(1_500);
  await ready(b, "庚：B 刷新后可以输入");
  await until(async () => !(await text(b)).includes(ASK.retry) && (await titleOf(b)) === "新会话" || undefined, 20_000, "庚：B 换到新会话");
  await sleep(1_000);
  await send(b, "庚新会话问题");
  await shows(b, "庚答完了。", "庚：B 在新会话里问得通");
  assert.ok(!(await text(b)).includes("找不到"), "庚：B 没有停在已经不存在的会话上");
  assert.equal(await titleOf(a), aTitle, "庚：A 的会话不动");
  assert.ok((await text(a)).includes(ANSWER.a), "庚：A 仍显示甲会话");
  const bTitle = await titleOf(b);

  evidence.stage = "辛";
  const extensionWindow = Number(await rp.evaluate(a, "chrome.windows.getCurrent().then(w => w.id)"));
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "辛：A 窗口里的空白页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete" && document.body.textContent.includes(${JSON.stringify(QUOTE)})`) || undefined, 10_000, "辛：网页打开");
  const worker = await rp.attach((await rp.serviceWorker())!.targetId);
  const workWindow = Number(await rp.evaluate(worker, `chrome.tabs.query({}).then(tabs => tabs.find(t => t.url?.startsWith("http://127.0.0.1:${siteAddress(site).port}"))?.windowId)`));
  assert.equal(workWindow, extensionWindow, "辛：网页和 A 在同一个窗口");
  await rp.click(b, "#input");
  await sleep(300);
  await rp.evaluate(work, `(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector("p")); const s = getSelection(); s.removeAllRanges(); s.addRange(r); return true; })()`);
  await rp.evaluate(worker, `chrome.tabs.query({}).then(tabs => chrome.tabs.sendMessage(tabs.find(t => t.url?.startsWith("http://127.0.0.1:${siteAddress(site).port}")).id, { type: "ask-hotkey" })).then(() => true)`);

  type ShadowNode = { attributes?: string[]; children?: ShadowNode[]; shadowRoots?: ShadowNode[]; backendNodeId: number };

  const shadow = await until(async () => {
    const doc = await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work);
    const find = (node: ShadowNode): ShadowNode | undefined => node.attributes?.includes("data-sideagent-ask") ? node : [...(node.children ?? []), ...(node.shadowRoots ?? [])].map(find).find(Boolean);
    const host = find(doc.root);

    if (!host?.shadowRoots?.[0]) return undefined;

    return (await rp.cdp.send("DOM.resolveNode", { backendNodeId: host.shadowRoots[0].backendNodeId }, work)).object.objectId;
  }, 5_000, "辛：划词阅读卡");
  const shadowRead = async (expression: string) => (await rp.cdp.send("Runtime.callFunctionOn", { objectId: shadow, returnByValue: true, functionDeclaration: `function(){return ${expression};}` }, work)).result.value;
  await until(async () => await shadowRead(`this.querySelector(".surface").classList.contains("expanded")`) || undefined, 5_000, "辛：阅读卡展开");
  const point = await shadowRead(`(() => { const r = this.querySelector('[data-act="handoff"]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, work);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, work);
  await until(async () => await rp.evaluate(a, `!document.querySelector("#ask-cite").hidden && document.querySelector("#ask-cite-text").textContent === ${JSON.stringify(QUOTE)}`) || undefined, 15_000, "辛：选段进了 A");
  await sleep(1_000);
  assert.equal(await titleOf(a), aTitle, "辛：A 仍在原来的会话");
  assert.equal(await rp.evaluate(b, 'document.querySelector("#ask-cite").hidden'), true, "辛：B 没有收到选段");
  assert.equal(await titleOf(b), bTitle, "辛：B 的会话不动");
  assert.ok(!(await text(b)).includes("找不到"), "辛：B 一直没有停在已经不存在的会话上");
  await rp.screenshot(a, join(artifacts, "a-ask-handoff.png"));

  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  for (const [name, panel] of [["a", a], ["b", b]] as const) {
    if (!panel) continue;
    evidence[`messages_${name}`] = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => `${el.className}: ${el.textContent.slice(0, 80)}`)').catch(() => null);
    await rp.screenshot(panel, join(artifacts, `failure-${name}.png`)).catch(() => undefined);
  }
} finally {
  evidence.gate = gate;
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  front.closeAllConnections();
  front.close();
  site.close();
}

console.log(artifacts);

if (error) {
  console.error(error);
  process.exitCode = 1;
}
