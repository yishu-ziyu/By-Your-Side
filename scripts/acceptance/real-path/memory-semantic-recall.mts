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

const rp = await launchRealPath({ chromeArgs: offline ? ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1", "--no-proxy-server"] : [] });
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

try {
  const ext = await rp.attach((await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId);
  await until(async () => await rp.evaluate(ext, `document.readyState === "complete"`) || undefined, 10_000, "扩展页");
  await rp.evaluate(ext, `(async () => { const db = await new Promise((resolve, reject) => { const request = indexedDB.open("sideagent-memory", 1); request.onupgradeneeded = () => request.result.createObjectStore("kv"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction("kv", "readwrite"); tx.objectStore("kv").put(${JSON.stringify(seeded)}, "memories"); await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); db.close(); return true; })()`);
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
    await rp.screenshot(panel, join(artifacts, "semantic-recall.png"));

    for (let index = 0; index < 3 && !(await rp.evaluate(panel, `document.querySelector("#header-menu").matches(":popover-open")`)); index++) { await rp.click(panel, "#header-more"); await sleep(300); }
    await rp.click(panel, "#memory-open");
    await until(async () => await rp.evaluate(panel, `!!document.querySelector('[data-memory-id="semantic-target"][data-memory-action="forget"]')`) || undefined, 15_000, "记忆面板找到目标");
    await rp.click(panel, '[data-memory-id="semantic-target"][data-memory-action="forget"]');
    await rp.click(panel, '[data-memory-id="semantic-target"][data-memory-action="confirm-forget"]');
    await until(async () => await rp.evaluate(panel, `!document.querySelector('.memory-row[data-memory-id="semantic-target"]')`) || undefined, 15_000, "目标记忆已忘记");
    await rp.click(panel, "#memory-close");
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
  await upstream.close().catch(() => undefined);
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }));
if (error) process.exitCode = 1;
