/**
 * 日常路径冒烟（真实模型，只装扩展，无头）：提问 → 操作网页 → 记住 → 新会话想起来 → 重启后旧会话还在。
 *   EGO_ACCEPTANCE_CHROME=<Chrome for Testing> npx tsx scripts/acceptance/real-path/smoke.mts --headless [--model=provider/id]
 * 失败方式：问了没回答；表单没填或没点；「记住」没落库；新会话想不起来；重启后旧会话丢了或打不开。
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc, type JsonRecord } from "./harness.mts";
import { DEFAULT_TEST_MODEL, configureViaSettings, loadModelPlan, modelStorageItems } from "./inproc-config.mts";

requireHeadless();

const started = Date.now();

const modelArg = process.argv.find((arg) => arg.startsWith("--model="))?.slice("--model=".length) ?? DEFAULT_TEST_MODEL;

const plan = await loadModelPlan(modelArg);

const nonce = randomBytes(4).toString("hex");

const email = `smoke-${nonce}@example.com`;

const fillValue = `smoke-${nonce}`;

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-smoke`);

await mkdir(artifacts, { recursive: true });

// 小页面：一个输入框、一个按钮；点按钮把输入框的值发回服务器，页面外也能核对。
const received: string[] = [];

const site = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");

  if (url.pathname === "/submit") {
    received.push(url.searchParams.get("v") ?? "");

    return void res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end('<!doctype html><meta charset="utf-8"><title>冒烟表单</title><h1>冒烟表单</h1><label>代号 <input id="code" name="code" aria-label="代号"></label> <button id="go" onclick="fetch(\'/submit?v=\'+encodeURIComponent(document.getElementById(\'code\').value)).then(()=>{document.title=\'已提交\'})">提交</button>');
});

await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const rp = await launchRealPath();

let error: string | null = null;

let panel = "";

let inproc: Awaited<ReturnType<typeof watchInproc>> | undefined;

const evidence: JsonRecord = { model: modelArg, email, fillValue };

type PanelState = { ready: boolean; busy: boolean; users: string[]; answers: string[] };

// SAFETY: 页面脚本返回的对象与 PanelState 逐字段对应。
const state = () => rp.evaluate(panel, `({
  ready: document.querySelector("#send-btn")?.disabled === false,
  busy: !!(document.querySelector("#send-btn")?.classList.contains("stopping") || document.querySelector("#status-pill")?.classList.contains("running") || document.querySelector(".msg.assistant.streaming,.msg.assistant[data-revealing]")),
  users: [...document.querySelectorAll("#messages .msg.user")].map((e) => e.innerText),
  answers: [...document.querySelectorAll("#messages .msg.assistant")].map((e) => e.innerText),
})`) as Promise<PanelState>;

const openPanel = async () => {
  panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  await until(async () => (await state()).ready || undefined, 60_000, "侧栏就绪");
};

/** 发一句话，等助手停下来；返回这句之后新增的助手回答。 */
const ask = async (text: string) => {
  const before = (await state()).answers.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, text);
  await rp.pressEnter(panel);
  await until(async () => (await state()).users.some((u) => u.includes(text.slice(0, 8))) || undefined, 30_000, `「${text.slice(0, 10)}」进入对话`);

  const s = await until(async () => {
    const now = await state();

    return !now.busy && now.answers.length > before ? now : undefined;
  }, 120_000, `真实模型回答「${text.slice(0, 10)}」`, 500);

  await sleep(500);

  return s.answers.slice(before).join("\n");
};

/** 记忆库（扩展自己的 IndexedDB）里所有记忆原文。 */
const storedMemories = async (): Promise<string[]> => {
  // SAFETY: CDP Target.createTarget 的返回值带字符串 targetId。
  const target = (await rp.cdp.send("Target.createTarget", { url: `chrome-extension://${rp.extensionId}/voice-permission.html` })).targetId as string;

  try {
    const ext = await rp.attach(target);
    await until(async () => (await rp.evaluate(ext, `location.protocol === "chrome-extension:" && document.readyState === "complete"`)) || undefined, 10_000, "扩展页");

    // SAFETY: 页面脚本返回 kv 里 memories 的 JSON 文本，库或键不存在时返回空串。
    const raw = await rp.evaluate(ext, `(async () => {
      if (!(await indexedDB.databases()).some((d) => d.name === "sideagent-memory")) return "";
      const db = await new Promise((res, rej) => { const r = indexedDB.open("sideagent-memory"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      if (!db.objectStoreNames.contains("kv")) { db.close(); return ""; }
      const v = await new Promise((res, rej) => { const r = db.transaction("kv").objectStore("kv").get("memories"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      db.close();
      return typeof v === "string" ? v : "";
    })()`) as string;

    // SAFETY: memories 键由扩展写入，形状是 { entries: [{ text, status }] }。
    return raw ? (JSON.parse(raw) as { entries?: Array<{ text: string; status?: string }> }).entries?.filter((e) => e.status === "active").map((e) => e.text) ?? [] : [];
  } finally {
    await rp.cdp.send("Target.closeTarget", { targetId: target }).catch(() => undefined);
  }
};

// SAFETY: 页面脚本返回字符串。没存过时 background 用默认会话（"default"），这里同一规则。
const selectedConversation = () => rp.evaluate(panel, `chrome.storage.local.get("selectedConversationId").then((v) => v.selectedConversationId ?? "default")`) as Promise<string>;

try {
  // 1. 打开侧栏，配真实模型。
  await openPanel();

  if (plan.credential.type === "api_key") evidence.step1 = (await configureViaSettings(rp, panel, plan)).saveStatus;
  else {
    // 订阅登录（如 openai-codex）设置页路径不支持：写入与设置页保存相同格式的存储。
    await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
    evidence.step1 = "storage (oauth plan)";
  }

  inproc = await watchInproc(rp, rp.extensionId);
  await until(async () => (await state()).ready || undefined, 60_000, "配好模型后侧栏可发送");
  // 配好模型后默认会话才建出来：等「新会话」不再忙。
  const settled = `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false" && document.querySelector("#send-btn")?.disabled === false`;
  await sleep(3000);
  await until(async () => (await rp.evaluate(panel, settled)) || undefined, 60_000, "默认会话建好");

  // 2. 普通提问。
  const intro = await ask("用一句话介绍你自己");
  evidence.step2 = intro;
  assert.ok(intro.trim().length > 0, "step 2: 助手给出了非空回答");

  // 3. 填表并点击；页面外的服务器收到值。
  const work = await rp.cdp.send("Target.createTarget", { url: `http://127.0.0.1:${siteAddress(site).port}/` });
  await rp.cdp.send("Target.activateTarget", { targetId: work.targetId });
  await sleep(800);
  evidence.step3Answer = await ask(`请在当前网页的「代号」输入框里填入 ${fillValue}，然后点「提交」按钮。`);
  await until(async () => received.length > 0 || undefined, 30_000, "页面服务器收到提交");
  evidence.step3Received = received;
  assert.ok(received.includes(fillValue), `step 3: 服务器收到提交的值 ${fillValue}，实际 ${JSON.stringify(received)}`);
  await rp.cdp.send("Target.closeTarget", { targetId: work.targetId }).catch(() => undefined);

  // 4. 记住邮箱；记忆落库，抽屉里也看得到。
  const firstConversation = await selectedConversation();
  evidence.firstConversation = firstConversation;
  evidence.step4Answer = await ask(`记住我的邮箱是 ${email}`);
  await until(async () => (await storedMemories()).some((t) => t.includes(email)) || undefined, 60_000, "记忆库里出现邮箱");
  await rp.click(panel, "#memory-open");
  await until(async () => (await rp.evaluate(panel, `document.querySelector("#memory-body")?.innerText.includes(${JSON.stringify(email)})`)) || undefined, 20_000, "记忆抽屉列出邮箱");
  await rp.screenshot(panel, join(artifacts, "step4-memory.png"));
  await rp.click(panel, "#memory-close");
  evidence.step4Memories = await storedMemories();

  // 5. 新会话里问邮箱。
  await rp.click(panel, "#conversation-new");
  await until(async () => ((await selectedConversation()) !== firstConversation && (await rp.evaluate(panel, `document.querySelector("#conversation-new")?.getAttribute("aria-busy") === "false"`))) || undefined, 30_000, "新会话建好");
  const recalled = await ask("我的邮箱是什么？");
  evidence.step5Answer = recalled;
  assert.ok(recalled.includes(email), `step 5: 新会话的回答含 ${email}`);

  // 6. 重启后旧会话还在，点开有原来的消息。
  await rp.restart();
  await openPanel();
  await rp.click(panel, "#conversation-switcher");
  await until(async () => (await rp.evaluate(panel, `!!document.querySelector('#conversation-menu [data-conversation-id=${JSON.stringify(firstConversation)}]')`)) || undefined, 15_000, "会话列表里有旧会话");
  await rp.click(panel, `[data-conversation-id="${firstConversation}"]`);

  const reopened = await until(async () => {
    const s = await state();

    return s.users.some((u) => u.includes(email)) && s.answers.length > 0 ? s : undefined;
  }, 20_000, "旧会话的消息恢复");

  evidence.step6 = { users: reopened.users, answers: reopened.answers.length };
  await rp.screenshot(panel, join(artifacts, "step6-reopened.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);

  if (panel) {
    await rp.screenshot(panel, join(artifacts, "failure.png")).catch(() => undefined);
    evidence.inprocLog = inproc?.logs().slice(-4000);
    evidence.inprocRequests = inproc?.requestsBetween(0).map((r) => `${r.method} ${r.url.split("?")[0]} ${r.status} ${r.failed ?? ""}`);
    evidence.failureText = await rp.evaluate(panel, `document.body.innerText.slice(0, 3000)`).catch(() => null);
    evidence.failureMessages = await rp.evaluate(panel, `[...document.querySelectorAll("#messages > *")].map((e) => e.className + ": " + e.innerText.slice(0, 300))`).catch(() => null);
  }
} finally {
  const wallSeconds = Math.round((Date.now() - started) / 1000);
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", wallSeconds, evidence, error }, null, 2));
  await rp.close().catch(() => undefined);
  await rp.remove().catch(() => undefined);
  await new Promise<void>((done) => { site.closeAllConnections(); site.close(() => done()); });
  console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", wallSeconds, artifacts, error: error?.split("\n")[0] ?? null }));
}

if (error) process.exitCode = 1;
