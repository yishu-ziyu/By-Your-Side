/**
 * 把一页上的一段文字原样填进另一页：模型只给 fill 的 from（文字在哪个元素），文字由扩展直接搬，不经过模型重打。
 * 只装扩展、隔离构建、本机脚本模型、本机两页：左边「回答页」是一段含中文引号、空行和列表的回答，旁边有一个密码栏；
 * 右边「聊天页」（用户正看着）有输入框和「提交」按钮，提交时把收到的文字发回本机服务。
 *   npx tsx scripts/acceptance/real-path/fill-from-source.mts --headless
 * 脚本模型依次：value 和 from 一起给（应报错）、from 指向密码栏（应拒绝）、from 用 CSS 指向回答（应填好）、
 * 读回答页快照后 from 用快照里那行文字的 @ref（文字节点，真实模型就这样选）再填一次（应填好）、点「提交」。
 * 判据：服务端只收到 1 次提交，文字与原文逐字相同；前两次填写都报错（未执行）；
 * 密码栏的值没出现在给模型的任何内容里；搬运那次的回执只有字数和首尾几个字，没有全文。
 * 按钮叫「提交」不叫「发送」：点「发送」会先停下等用户在网页上确认，那不是这里要测的。
 * 失败方式：去掉扩展 fill 里读 from 的那一段，提交的文字不是原文。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-from-source`);

await mkdir(artifacts, { recursive: true });

const ANSWER = `好的，下面是“三步走”的建议：

一、先想清楚目标
只写“每天学习三小时”往往坚持不到一周。
- 周一：打基础
- 周二：做练习

最后提醒一句：“今天先做 25 分钟”。`;

const SECRET = "hunter2-very-secret-pw";

const page = (title: string, body: string) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head><body style="font:16px sans-serif;margin:40px">${body}</body></html>`;

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const received: string[] = [];

const site = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/received") {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (d) => (body += d));
    req.on("end", () => { received.push(body); res.end("ok"); });

    return;
  }

  const body = req.url === "/answer"
    ? page("回答", `<h1>对话</h1><div id="answer" style="white-space:pre-wrap">${escape(ANSWER)}</div><label>登录密码 <input id="pw" type="password" value="${SECRET}"></label>`)
    : page("聊天", `<h1>聊天</h1><textarea id="box" rows="10" cols="60" aria-label="消息"></textarea><button id="submit" type="button" onclick="fetch('/received', { method: 'POST', body: document.getElementById('box').value })">提交</button>`);

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(body);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;

const ASK = "搬运测试：把左边那页的回答原样填进这一页的输入框，然后点提交。";
const FINAL = "已原样提交。";
// 回答页的标签页 id 要等页面开好才知道：先占位，发问前填进去。
const from = { tabId: -1, target: "#answer" };
const pwFrom = { tabId: -1, target: "#pw" };
// 快照里回答那一行的 @ref：模型读到快照后才知道，脚本在收到快照回执时填进去。
const refFrom = { tabId: -1, target: "@0" };
const snapshotArgs = { tabId: -1 };

/** 给模型的每条工具回执原文，按出现顺序。 */
const toolTexts: string[] = [];

/** 模型收到的全部请求正文，用来查密码有没有漏进去。 */
const payloads: string[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "fill", args: { target: "#box", value: "我自己打的字", from } } },
    { tool: { name: "fill", args: { target: "#box", from: pwFrom } } },
    { tool: { name: "fill", args: { target: "#box", from } } },
    { tool: { name: "snapshot", args: snapshotArgs } },
    { tool: { name: "fill", args: { target: "#box", from: refFrom } } },
    { tool: { name: "click", args: { target: "#submit", label: "提交" } } },
    { text: FINAL },
  ] },
], undefined, (payload: { messages?: Array<{ role: string; content?: unknown }> }) => {
  payloads.push(JSON.stringify(payload));

  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : "";

    if (m.role === "tool" && !toolTexts.includes(text)) toolTexts.push(text);
    const ref = text.match(/\[ref=(\d+)\] text: 好的/)?.[1];

    if (m.role === "tool" && ref) refFrom.target = `@${ref}`;
  }
});

const rp = await launchRealPath();
let error: string | null = null;
const evidence: Record<string, unknown> = {};
let panelForDump: string | null = null;

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const answerTab = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/answer` }, answerTab);
  const { targetId: chatTargetId } = await rp.cdp.send("Target.createTarget", { url: `${origin}/chat` }) as { targetId: string };
  const chat = await rp.attach(chatTargetId);
  const sw = await rp.attach((await until(() => rp.serviceWorker(), 15_000, "service worker")).targetId);
  await until(async () => await rp.evaluate(sw, "typeof chrome === 'object' && !!chrome.tabs").catch(() => false), 15_000, "扩展后台就绪");
  const answerTabId = await until(async () => (await rp.evaluate(sw, `chrome.tabs.query({}).then(ts => ts.find(t => t.title === "回答")?.id ?? null)`)) as number | null ?? undefined, 15_000, "回答页的标签页 id");
  from.tabId = answerTabId;
  pwFrom.tabId = answerTabId;
  refFrom.tabId = answerTabId;
  snapshotArgs.tabId = answerTabId;

  const panel = await rp.attach(await rp.openSidePanel());
  panelForDump = panel;
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, chat);
  await sleep(500);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages").textContent.includes(${JSON.stringify(FINAL)})`) || undefined, 90_000, `回答「${FINAL}」`, 100);
  await until(async () => received.length > 0 || undefined, 5_000, "服务端收到提交").catch(() => {});
  await sleep(800);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  await rp.screenshot(chat, join(artifacts, "chat.png"));

  const fills = toolTexts.filter(t => !/^Click/.test(t) && !t.includes("RootWebArea")).slice(0, 4);
  evidence.received = received;
  evidence.fillReceipts = fills;
  evidence.box = await rp.evaluate(chat, 'document.getElementById("box").value');

  assert.equal(received.length, 1, `server received exactly one submit: ${JSON.stringify(received)}`);
  assert.equal(received[0], ANSWER, `the submitted text equals the answer character for character: ${JSON.stringify(received[0])}`);

  assert.match(fills[0] ?? "", /value 和 from 只能给一个/, `giving both value and from is an error: ${JSON.stringify(fills[0])}`);
  assert.match(fills[1] ?? "", /敏感栏/, `from on a password field is refused: ${JSON.stringify(fills[1])}`);
  assert.ok(!payloads.some(p => p.includes(SECRET)), "the password value never reached the model");

  const copied = fills[2] ?? "";
  assert.match(copied, new RegExp(`Copied ${ANSWER.length} characters`), `the copy receipt gives the length: ${JSON.stringify(copied)}`);
  assert.match(copied, /<page-content untrusted/, `the copied ends are wrapped as page content: ${JSON.stringify(copied)}`);
  assert.ok(!copied.includes("一、先想清楚目标"), `the copy receipt does not carry the full text: ${JSON.stringify(copied)}`);
  assert.match(copied, /holds exactly this text/, `the field read back the same text: ${JSON.stringify(copied)}`);
  assert.notEqual(refFrom.target, "@0", "the snapshot listed the answer as a text line with a ref");
  assert.match(fills[3] ?? "", new RegExp(`Copied ${ANSWER.length} characters from ${refFrom.target} .*holds exactly this text`, "s"), `from a snapshot text ref copies the same text: ${JSON.stringify(fills[3])}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  if (panelForDump) await writeFile(join(artifacts, "messages.html"), String(await rp.evaluate(panelForDump, 'document.querySelector("#messages")?.outerHTML ?? ""').catch(() => ""))).catch(() => {});
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice pages", evidence, allToolTexts: toolTexts, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, evidence, error: error?.split("\n")[0] ?? null }, null, 2));

if (error) process.exitCode = 1;
