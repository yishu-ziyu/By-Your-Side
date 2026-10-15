/**
 * 会话单独开一个窗口（docs/evals/20261015-conversation-popout.md）。
 *   甲 侧栏 A 问一句，答完。
 *   乙 A 的「⋯」菜单点「在新窗口打开」：开出一个弹出窗口 P，显示同一个会话。
 *   丙 用户点进 P 问「点一下按钮」：页面标牌是源窗口的网页；脚本模型点的按钮在源窗口的网页上（计数变 1）；A 仍在原来的会话。
 *   丁 另开一个普通窗口 W2，关掉源窗口；用户点进 P 再问：这次的页面和点击落在 W2 的网页上。
 *   戊 刷新 P：仍是这个会话的问答。
 *   己 网页里的内容脚本从路径是 /sidepanel.html?… 的网页连侧栏端口：后台不理它（收不到会话清单），确认卡端口被断开。
 *   庚 普通窗口全关掉，只剩 P；在 P 里让助手打开一个网址：P 还是会话页，没被换成网页。
 * 失败方式：P 打开后是新会话；用户在 P 里时，助手读、点的是 P 自己（扩展页）而不是源窗口的网页；
 *   源窗口关掉后助手还指着已经关掉的窗口；刷新 P 换了会话；伪造路径的网页能连上侧栏端口。
 * 产物：out/acceptance/real-path/<时间>-conversation-popout/*.png、result.json。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = process.env.OUT ?? join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-conversation-popout`);

await mkdir(artifacts, { recursive: true });

const ASK = { first: "甲先聊一句", click: "丙点一下按钮", after: "丁再点一下按钮", alone: "庚打开练习页" };

const ANSWER = { first: "甲答完了。", click: "丙点好了。", after: "丁点好了。", alone: "庚说完了。" };

const PAGE = { source: "源窗口的练习页", other: "另一个窗口的练习页" };

// 丁：用户消息带着的页面（「[This is tab N …」）就是助手要操作的页；像真模型一样先切到它再点。
const switchArgs: { action: string; tabId: number } = { action: "switch", tabId: -1 };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK.after, steps: [{ tool: { name: "tabs", args: switchArgs } }, { tool: { name: "click", args: { target: "loc=css:#bump" } } }, { text: ANSWER.after }] },
  { match: ASK.click, steps: [{ tool: { name: "click", args: { target: "loc=css:#bump" } } }, { text: ANSWER.click }] },
  { match: ASK.first, steps: [{ text: ANSWER.first }] },
  { match: ASK.alone, steps: [{ tool: { name: "navigate", args: { url: "http://127.0.0.1:9/alone" } } }, { text: ANSWER.alone }] },
], undefined, payload => {
  for (const message of payload.messages ?? []) {
    const text = typeof message.content === "string" ? message.content : (message.content ?? []).map(part => part.text ?? "").join("");

    if (message.role === "user" && text.includes(ASK.after)) {
      const tab = /\[This is tab (\d+)/.exec(text);

      if (tab) switchArgs.tabId = Number(tab[1]);
    }
  }
});

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const title = url.searchParams.get("t") ?? "练习页";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><title>${title}</title><h1>${title}</h1><p>按了 <b id="count">0</b> 次</p><button id="bump" type="button" onclick="count.textContent = Number(count.textContent) + 1">加一</button>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const rp = await launchRealPath();

let error: string | null = null;

const evidence: Record<string, unknown> = {};

let a = "";

let p = "";

try {
  a = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(a, `chrome.storage.local.set(${JSON.stringify({
    inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl },
    "inproc_cred:custom": { type: "api_key", key: "test-key" },
  })}).then(() => true)`);
  const worker = await rp.attach((await rp.serviceWorker())!.targetId);
  const sw = (expression: string) => rp.evaluate(worker, expression);

  const text = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#messages")?.textContent ?? ""'));
  const titleOf = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#conversation-switcher")?.textContent ?? ""'));
  const pill = async (panel: string) => String(await rp.evaluate(panel, 'document.querySelector("#tab-title-text")?.textContent ?? ""'));
  const ready = (panel: string, label: string) => until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, label);
  const shows = (panel: string, needle: string, label: string, ms = 40_000) => until(async () => (await text(panel)).includes(needle) || undefined, ms, label);
  const send = async (panel: string, ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };
  const count = (page: string) => rp.evaluate(page, 'Number(document.querySelector("#count").textContent)');

  evidence.stage = "甲";
  const sourceWindow = Number(await rp.evaluate(a, "chrome.windows.getCurrent().then(w => w.id)"));
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "甲：A 窗口里的空白页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/?t=${encodeURIComponent(PAGE.source)}` }, work);
  await until(async () => await rp.evaluate(work, `document.readyState === "complete" && !!document.querySelector("#bump")`) || undefined, 10_000, "甲：源窗口网页打开");
  assert.equal(Number(await sw(`chrome.tabs.query({}).then(tabs => tabs.find(t => t.url?.startsWith(${JSON.stringify(origin)}))?.windowId)`)), sourceWindow, "甲：网页和 A 在同一个窗口");
  await ready(a, "甲：侧栏 A 就绪");
  await send(a, ASK.first);
  await shows(a, ANSWER.first, "甲：A 看到回答");
  const aTitle = await titleOf(a);

  evidence.stage = "乙";
  await rp.click(a, "#header-more");
  await until(async () => await rp.evaluate(a, '!!document.querySelector("#header-menu:popover-open #popout-open")') || undefined, 5_000, "乙：菜单里有「在新窗口打开」");
  await sleep(400);
  await rp.screenshot(a, join(artifacts, "menu.png"));
  await rp.click(a, "#popout-open");
  const popupTarget = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url.includes("sidepanel.html?conversation=")), 10_000, "乙：开出单独窗口");
  p = await rp.attach(popupTarget.targetId);
  await until(async () => await rp.evaluate(p, "document.readyState === \"complete\" && !!globalThis.chrome?.windows").catch(() => false) || undefined, 10_000, "乙：单独窗口加载");
  const popupWindow = Number(await rp.evaluate(p, "chrome.windows.getCurrent().then(w => w.id)"));
  const popup = await sw(`chrome.windows.get(${popupWindow}).then(w => ({ type: w.type, width: w.width, height: w.height, left: w.left, top: w.top }))`) as { type: string; width: number; height: number; left: number; top: number };
  evidence.popup = popup;
  assert.equal(popup.type, "popup", "乙：开出的是弹出窗口");
  assert.equal(new URL(popupTarget.url).searchParams.get("window"), String(sourceWindow), "乙：地址里记着源窗口");
  await shows(p, ANSWER.first, "乙：P 显示同一个会话");
  assert.equal(await titleOf(p), aTitle, "乙：P 的会话标题和 A 一样");
  assert.equal(await rp.evaluate(p, '!document.querySelector("#popout-open") && getComputedStyle(document.querySelector("#composer .voice-start")).display === "none" && getComputedStyle(document.querySelector("#dictate-btn")).display === "none"'), true, "乙：P 里没有再开窗口、语音对话、说话输入");
  evidence.windows = await sw("chrome.windows.getAll().then(ws => ws.map(w => ({ id: w.id, type: w.type, left: w.left, top: w.top, width: w.width, height: w.height })))");

  evidence.stage = "丙";
  await sw(`chrome.windows.update(${popupWindow}, { focused: true }).then(() => true)`);
  evidence.lastFocusedBeforeAsk = await sw("chrome.windows.getLastFocused().then(w => w.id)");
  await ready(p, "丙：P 可以输入");
  await until(async () => (await pill(p)).includes(PAGE.source) || undefined, 10_000, "丙：P 的页面标牌是源窗口的网页");
  await send(p, ASK.click);
  await shows(p, ANSWER.click, "丙：P 看到回答", 60_000);
  assert.equal(await count(work), 1, "丙：点的是源窗口网页上的按钮");
  await rp.screenshot(p, join(artifacts, "popup.png"));
  await rp.screenshot(work, join(artifacts, "source-page.png"));
  assert.equal(await titleOf(a), aTitle, "丙：A 仍在原来的会话");
  assert.ok((await text(a)).includes(ANSWER.first), "丙：A 仍显示这个会话");
  await rp.screenshot(a, join(artifacts, "side-panel.png"));

  evidence.stage = "丁";
  const otherTarget = (await rp.cdp.send("Target.createTarget", { url: `${origin}/?t=${encodeURIComponent(PAGE.other)}`, newWindow: true })).targetId;
  const other = await rp.attach(otherTarget);
  await until(async () => await rp.evaluate(other, `document.readyState === "complete" && !!document.querySelector("#bump")`) || undefined, 10_000, "丁：另一个窗口的网页打开");
  const otherWindow = Number(await sw(`chrome.tabs.query({}).then(tabs => tabs.find(t => t.url?.includes(${JSON.stringify(encodeURIComponent(PAGE.other))}))?.windowId)`));
  assert.notEqual(otherWindow, sourceWindow, "丁：W2 是另一个窗口");
  await sw(`chrome.windows.remove(${sourceWindow}).then(() => true)`);
  await until(async () => await sw(`chrome.windows.get(${sourceWindow}).then(() => false, () => true)`) || undefined, 10_000, "丁：源窗口关掉");
  await sw(`chrome.windows.update(${otherWindow}, { focused: true }).then(() => chrome.windows.update(${popupWindow}, { focused: true })).then(() => true)`);
  await until(async () => (await pill(p)).includes(PAGE.other) || undefined, 10_000, "丁：P 的页面标牌换成 W2 的网页");
  await send(p, ASK.after);
  await shows(p, ANSWER.after, "丁：P 看到回答", 60_000);
  evidence.switchTo = switchArgs.tabId;
  assert.equal(await count(other), 1, "丁：点的是 W2 网页上的按钮");

  evidence.stage = "戊";
  const pTitle = await titleOf(p);
  await rp.evaluate(p, "setTimeout(() => location.reload(), 0), true");
  await sleep(1_500);
  await shows(p, ANSWER.after, "戊：刷新后 P 回放这个会话");
  assert.ok((await text(p)).includes(ANSWER.first), "戊：刷新后 P 仍有甲的问答");
  assert.equal(await titleOf(p), pTitle, "戊：刷新后 P 的会话不变");
  await rp.screenshot(p, join(artifacts, "popup-after-reload.png"));

  evidence.stage = "己";
  const forgedTarget = (await rp.cdp.send("Target.createTarget", { url: `${origin}/sidepanel.html?conversation=x&window=${otherWindow}` })).targetId;
  const forged = await rp.attach(forgedTarget);
  const isolated = new Set<number>();
  rp.cdp.onEvent("Runtime.executionContextCreated", (message: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (message.sessionId === forged && message.params.context.auxData?.type === "isolated" && message.params.context.origin.startsWith("chrome-extension://")) isolated.add(message.params.context.id);
  });
  await rp.cdp.send("Runtime.enable", {}, forged);
  const contextId = await until(async () => [...isolated][0], 10_000, "己：网页里的内容脚本环境");
  const probe = await rp.cdp.send("Runtime.evaluate", { contextId, awaitPromise: true, returnByValue: true, expression: `new Promise(done => {
    const seen = [];
    const panel = chrome.runtime.connect({ name: "sideagent-panel" });
    panel.onMessage.addListener(m => seen.push(m?.kind ?? "?"));
    panel.postMessage({ kind: "sync", afterSeq: 0 });
    let confirmCut = false;
    const confirm = chrome.runtime.connect({ name: "send-confirm-panel" });
    confirm.onDisconnect.addListener(() => { confirmCut = true; });
    setTimeout(() => done({ url: location.href, seen, confirmCut }), 3000);
  })` }, forged) as { result?: { value?: { url: string; seen: string[]; confirmCut: boolean } } };
  evidence.forged = probe.result?.value;
  assert.ok(probe.result?.value?.url.includes("/sidepanel.html?"), "己：伪造网页的路径是 /sidepanel.html?…");
  assert.deepEqual(probe.result?.value?.seen, [], "己：伪造网页连侧栏端口收不到任何消息");
  assert.equal(probe.result?.value?.confirmCut, true, "己：伪造网页的确认卡端口被断开");

  evidence.stage = "庚";
  await rp.cdp.send("Target.closeTarget", { targetId: forgedTarget }).catch(() => undefined);
  await sw(`chrome.windows.getAll({ windowTypes: ["normal"] }).then(ws => Promise.all(ws.map(w => chrome.windows.remove(w.id)))).then(() => true)`);
  await until(async () => await sw(`chrome.windows.getAll({ windowTypes: ["normal"] }).then(ws => ws.length === 0)`) || undefined, 10_000, "庚：普通窗口全关掉");
  await send(p, ASK.alone);
  await shows(p, ANSWER.alone, "庚：P 看到回答", 60_000);
  const alone = await rp.evaluate(p, `({ path: location.pathname, pill: document.querySelector("#tab-title-text")?.textContent ?? "" })`) as { path: string; pill: string };
  evidence.alone = alone;
  assert.equal(alone.path, "/sidepanel.html", "庚：P 还是会话页，没被换成网页");
  assert.ok(!alone.pill.includes("sidepanel"), "庚：页面标牌不指着 P 自己");

  evidence.stage = "done";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  for (const [name, panel] of [["a", a], ["p", p]] as const) {
    if (!panel) continue;
    evidence[`messages_${name}`] = await rp.evaluate(panel, '[...document.querySelectorAll("#messages > *")].map(el => `${el.className}: ${el.textContent.slice(0, 120)}`)').catch(() => null);
    await rp.screenshot(panel, join(artifacts, `failure-${name}.png`)).catch(() => undefined);
  }
} finally {
  evidence.modelRequests = model.requests.map(r => ({ rule: r.rule, step: r.step, status: r.status }));
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(artifacts);

if (error) {
  console.error(error);
  process.exitCode = 1;
}
