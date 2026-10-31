/**
 * 真实扩展 + 真实本地语义模型：换个说法找到自动总结的做法；无关记忆不带入；忘记并重启扩展后找不回。
 * SIDEAGENT_SEMANTIC_OFFLINE=1 时阻断模型下载，验证原对话与关键词回退不受影响。
 *   npx tsx scripts/acceptance/real-path/memory-semantic-recall.mts --headless
 *   SIDEAGENT_SEMANTIC_OFFLINE=1 npx tsx scripts/acceptance/real-path/memory-semantic-recall.mts --headless
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const offline = process.env.SIDEAGENT_SEMANTIC_OFFLINE === "1";
const name = `memory-semantic-recall${offline ? "-offline" : ""}`;
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-${name}`);
await mkdir(artifacts, { recursive: true });

const ASK = "第一轮研究完成了，接下来怎样处理这些录音";
const TARGET = "做用户访谈后，先逐条整理受访者原话，再归纳共同需求";
const UNRELATED = "发布浏览器扩展前，先备份上一个版本";
const ANSWER = "先逐条整理受访者原话，再归纳共同需求。";
const NOW = Date.now();
const memory = (id: string, text: string) => ({
  id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: "seed",
  createdAt: NOW - 60_000, updatedAt: NOW - 60_000, kind: "method", useCount: 0, status: "active", formatVersion: 3,
  experience: { runId: `${id}-run`, topic: text, evidence: [text] },
});
const seeded = JSON.stringify({ format: 3, rev: 1, entries: [memory("semantic-target", TARGET), memory("semantic-unrelated", UNRELATED)] }) + "\n";

const upstream = await startScriptedModel([
  { match: ASK, steps: [{ text: ANSWER }] },
  { match: "DECISION::none", steps: [{ text: JSON.stringify({ action: "none", text: "", evidence: "", scope: { kind: "all" }, targets: [], taskRequested: false, about: { longTerm: false, date: null, onlyThisTask: false, explicitRequest: false } }) }] },
]);
const requests: string[] = [];
const proxy = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
    const payload = JSON.parse(body) as { messages?: Array<{ role: string; content?: string | Array<{ text?: string }> }>; tools?: unknown[] };
    const text = (content: (typeof payload.messages)[number]["content"]) => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : content ?? "";
    const messages = payload.messages ?? [];
    const context = messages.filter((message, index, all) => message.role === "system" || message.role === "developer" || (message.role === "user" && text(message.content).startsWith("本次运行的上下文") && !all.slice(index + 1).some(next => next.role === "user" && text(next.content).startsWith("本次运行的上下文")))).map(message => text(message.content)).join("\n");
    if (payload.tools?.length) requests.push(context);
    if (context.includes("You interpret the CURRENT direct user message")) body = JSON.stringify({ ...payload, messages: [{ role: "user", content: "DECISION::none" }] });
  }
  const reply = await fetch(new URL(upstream.baseUrl).origin + (req.url ?? "/"), { method: req.method, headers: { "content-type": "application/json" }, body: req.method === "GET" || req.method === "HEAD" ? undefined : body });
  res.writeHead(reply.status, { "content-type": reply.headers.get("content-type") ?? "application/json" });
  for await (const chunk of reply.body ?? []) res.write(chunk);
  res.end();
});
await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));

const HOST = "research.test";
const siteServer = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>用户研究</title><p>访谈录音</p>"));
await new Promise<void>(resolve => siteServer.listen(0, "127.0.0.1", resolve));
const hostRule = `MAP ${HOST} 127.0.0.1:${siteAddress(siteServer).port}`;
const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=${hostRule}${offline ? ", MAP * ~NOTFOUND, EXCLUDE 127.0.0.1" : ""}`, "--no-proxy-server"] });
let panel = "";
let error: string | null = null;
const evidence: Record<string, unknown> = { offline, semanticTurns: 0 };

type PanelState = { ready: boolean; busy: boolean; users: number; replies: number };
const state = async (): Promise<PanelState> => await rp.evaluate(panel, `(() => ({
  ready: document.querySelector("#send-btn")?.disabled === false,
  busy: !!(document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector(".msg.assistant.streaming, .msg.assistant[data-revealing]")),
  users: document.querySelectorAll("#messages .msg.user").length,
  replies: document.querySelectorAll("#messages .msg:not(.user)").length,
}))()`) as PanelState;

async function newConversation() {
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, `document.querySelectorAll("#messages .msg.user").length === 0 && !document.querySelector("#conversation-new").disabled`) || undefined, 15_000, "新会话");
  await sleep(500);
}

async function turn(): Promise<string> {
  const mark = requests.length;
  const before = await state();
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => (await state()).users > before.users || undefined, 10_000, "消息发出");
  await until(async () => {
    const current = await state();
    return !current.busy && current.replies > before.replies && requests.length > mark ? true : undefined;
  }, 120_000, "这一轮回答结束", 500);
  await sleep(1000);
  assert.ok(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].at(-1)?.textContent.includes(${JSON.stringify(ANSWER)})`), "用户看得到脚本回答");
  return requests[mark] ?? "";
}

async function usedItem(id: string): Promise<{ state: string; note: string; buttons: string[] } | null> {
  return await rp.evaluate(panel, `(() => {
    const item = [...document.querySelectorAll(".memory-used-item")].filter(node => node.dataset.usedId === ${JSON.stringify(id)}).at(-1);
    return item ? { state: item.dataset.state, note: item.querySelector(".memory-used-note")?.textContent ?? "", buttons: [...item.querySelectorAll("button")].map(button => button.textContent) } : null;
  })()`) as { state: string; note: string; buttons: string[] } | null;
}

async function clickUsed(id: string, label: string): Promise<void> {
  const found = await rp.evaluate(panel, `(() => {
    const items = [...document.querySelectorAll(".memory-used-item")].filter(node => node.dataset.usedId === ${JSON.stringify(id)}).reverse();
    const button = items.map(item => [...item.querySelectorAll("button")].find(node => node.textContent === ${JSON.stringify(label)})).find(Boolean);
    if (!button) return false;
    button.setAttribute("data-acceptance-click", "1");
    button.scrollIntoView({ block: "center" });
    return true;
  })()`);
  assert.ok(found, `来源里可以点「${label}」`);
  await rp.click(panel, "[data-acceptance-click]");
  await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
  await sleep(1000);
}

try {
  const blank = await until(async () => (await rp.targets()).find(target => target.type === "page" && target.url === "about:blank"), 10_000, "初始标签页");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://${HOST}/` }, work);
  await until(async () => await rp.evaluate(work, `location.hostname === ${JSON.stringify(HOST)} && document.readyState === "complete"`) || undefined, 15_000, "研究网站");
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => await rp.evaluate(ext, `document.readyState === "complete"`) || undefined, 10_000, "扩展页");
  await rp.evaluate(ext, `(async () => { const db = await new Promise((resolve, reject) => { const request = indexedDB.open("sideagent-memory", 1); request.onupgradeneeded = () => request.result.createObjectStore("kv"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(seeded)}, "memories"); await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close(); return true; })()`);
  await rp.cdp.send("Target.activateTarget", { targetId: blank.targetId });
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: `http://127.0.0.1:${siteAddress(proxy).port}/v1` });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  const inproc = await watchInproc(rp, rp.extensionId);
  await until(async () => (await state()).ready || undefined, 90_000, "侧栏就绪", 500);

  if (offline) {
    await newConversation();
    const prompt = await turn();
    evidence.prompt = { target: prompt.includes(TARGET), unrelated: prompt.includes(UNRELATED) };
    evidence.inprocLogs = inproc.logs();
    assert.equal(prompt.includes(TARGET), false, "模型不可用时不错误带入语义记忆");
    assert.equal(prompt.includes(UNRELATED), false, "模型不可用时不错误带入无关记忆");
  } else {
    let prompt = "";
    const deadline = Date.now() + 240_000;
    do {
      await newConversation();
      prompt = await turn();
      evidence.semanticTurns = Number(evidence.semanticTurns) + 1;
    } while (!prompt.includes(TARGET) && Date.now() < deadline);
    evidence.recall = { target: prompt.includes(TARGET), unrelated: prompt.includes(UNRELATED), turns: evidence.semanticTurns };
    evidence.inprocLogs = inproc.logs();
    assert.ok(prompt.includes(TARGET), "真实本地模型在换说法后找到了目标记忆");
    assert.equal(prompt.includes(UNRELATED), false, "无关记忆没有被带入");
    const usedLine = await rp.evaluate(panel, `(() => {
      const answer = [...document.querySelectorAll("#messages .msg.assistant")].at(-1);
      const line = answer?.querySelector(".memory-used-line");
      const toggle = answer?.querySelector(".memory-used-toggle");
      return line && toggle ? {
        open: line.dataset.open,
        label: toggle.textContent,
        items: [...line.querySelectorAll(".memory-used-item")].map(item => ({ id: item.dataset.usedId, text: item.querySelector(".memory-used-text")?.textContent })),
      } : null;
    })()`) as { open: string; label: string; items: Array<{ id: string; text: string }> } | null;
    evidence.usedLine = usedLine;
    assert.ok(usedLine?.label.startsWith("参考了你记住的"), "回答下说明参考了哪条语义记忆");
    assert.equal(usedLine.open, "false", "来源默认折起");
    assert.deepEqual(usedLine.items, [{ id: "semantic-target", text: TARGET }], "只列出本次语义命中的原文");
    await rp.screenshot(panel, join(artifacts, "semantic-recall.png"));

    await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.assistant")].at(-1).querySelector(".memory-used-toggle").setAttribute("data-acceptance-click", "1"); true`);
    await rp.click(panel, "[data-acceptance-click]");
    await rp.evaluate(panel, `document.querySelector("[data-acceptance-click]")?.removeAttribute("data-acceptance-click"); true`);
    await sleep(600);
    const expanded = await rp.evaluate(panel, `(() => {
      const line = [...document.querySelectorAll("#messages .msg.assistant")].at(-1).querySelector(".memory-used-line");
      const item = line.querySelector(".memory-used-item");
      return {
        open: line.dataset.open,
        whiteSpace: getComputedStyle(item.querySelector(".memory-used-text")).whiteSpace,
        actionOpacity: getComputedStyle(item.querySelector(".memory-used-actions")).opacity,
        buttons: [...item.querySelectorAll("button")].map(button => button.textContent),
      };
    })()`) as { open: string; whiteSpace: string; actionOpacity: string; buttons: string[] };
    evidence.expanded = expanded;
    assert.equal(expanded.open, "true", "来源可以原地展开");
    assert.equal(expanded.whiteSpace, "normal", "完整原文换行显示，不截成省略号");
    assert.equal(expanded.actionOpacity, "1", "控制操作不用悬停也能看见");
    assert.deepEqual(expanded.buttons, ["在这个网站不用", "忘记"], "展开后能在这个网站停用或忘记");
    await rp.screenshot(panel, join(artifacts, "semantic-recall-expanded.png"));
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }, { name: "prefers-reduced-motion", value: "reduce" }] }, panel);
    await sleep(300);
    evidence.reducedMotion = await rp.evaluate(panel, `getComputedStyle([...document.querySelectorAll("#messages .msg.assistant")].at(-1).querySelector(".memory-used-line")).transitionDuration`);
    assert.equal(evidence.reducedMotion, "0s", "减少动态效果时展开不播动效");
    await rp.screenshot(panel, join(artifacts, "semantic-recall-dark.png"));
    await rp.cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }, { name: "prefers-reduced-motion", value: "no-preference" }] }, panel);

    await clickUsed("semantic-target", "在这个网站不用");
    const notHere = await usedItem("semantic-target");
    assert.equal(notHere?.state, "not-here", "网站停用状态可见");
    assert.equal(notHere?.note, `在 ${HOST} 不用`, "网站停用说明对应当前网站");
    const withoutHere = await turn();
    assert.equal(withoutHere.includes(TARGET), false, "在这个网站不用后，下一轮不再带入");
    await clickUsed("semantic-target", "撤销");
    assert.equal((await usedItem("semantic-target"))?.state, "used", "网站停用可以撤销");
    const restoredHere = await turn();
    assert.ok(restoredHere.includes(TARGET), "撤销网站停用后，下一轮重新带入");

    await clickUsed("semantic-target", "忘记");
    assert.equal((await usedItem("semantic-target"))?.state, "forgotten", "忘记状态可见");
    await clickUsed("semantic-target", "撤销");
    assert.equal((await usedItem("semantic-target"))?.state, "used", "忘记可以撤销");
    const afterUndo = await turn();
    assert.ok(afterUndo.includes(TARGET), "撤销忘记后，下一轮重新带入");
    evidence.controls = { withoutHere: withoutHere.includes(TARGET), restoredHere: restoredHere.includes(TARGET), afterUndo: afterUndo.includes(TARGET) };
    await clickUsed("semantic-target", "忘记");
    assert.equal((await usedItem("semantic-target"))?.state, "forgotten", "最终忘记已生效");
    await rp.screenshot(panel, join(artifacts, "semantic-forgotten.png"));
    const worker = await rp.serviceWorker();
    assert.ok(worker, "扩展后台存在");
    await rp.evaluate(ext, `setTimeout(() => chrome.runtime.reload(), 0); true`);
    await until(async () => { const next = await rp.serviceWorker(); return next && next.targetId !== worker!.targetId ? true : undefined; }, 30_000, "扩展重启");
    panel = await rp.attach(await rp.openSidePanel());
    await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
    await until(async () => (await state()).ready || undefined, 90_000, "重启后侧栏就绪", 500);
    await newConversation();
    const afterForget = await turn();
    evidence.afterForget = { target: afterForget.includes(TARGET), unrelated: afterForget.includes(UNRELATED) };
    assert.equal(afterForget.includes(TARGET), false, "忘记并重启后目标记忆没有复活");
    assert.equal(afterForget.includes(UNRELATED), false, "重启后仍不带入无关记忆");
  }
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  if (panel) await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  proxy.closeAllConnections();
  proxy.close();
  siteServer.closeAllConnections();
  siteServer.close();
  await upstream.close().catch(() => undefined);
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
