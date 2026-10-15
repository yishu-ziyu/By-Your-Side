/**
 * 把一页上的一段文字原样填进另一页：模型只给 fill 的 from（文字在哪个元素），文字由扩展直接搬，不经过模型重打。
 * 只装扩展、隔离构建、本机脚本模型、本机两页：左边「回答页」有一段含中文引号、空行和列表的纯文字回答、一段由几个 <p>
 * 和一个 <ul><li> 组成的回答（ChatGPT、Gemini 的回答就是这样排的）、一个密码栏、一段隐藏的字和一个收起的折叠面板；
 * 右边「聊天页」（用户正看着）有输入框和「提交」按钮，提交时把收到的文字发回本机服务。
 *   npx tsx scripts/acceptance/real-path/fill-from-source.mts --headless
 * 脚本模型依次：value 和 from 一起给（报错）、from 指向密码栏（拒绝）、指向隐藏的字（拒绝）、指向收起的面板里的字（拒绝）、
 * from 用 CSS 指向纯文字回答（填好）、先填一句占位、读回答页快照后 from 用快照里那行文字的 @ref 再填（文字节点，真实模型就这样选）、
 * 点「提交」；再 from 指向 <p>/<li> 那段回答、点「提交」。
 * 判据：四次被拒的填写之后输入框一次都没被写过；服务端收到 2 次提交，各自与写死的期望文字逐字相同（第 2 次段落和列表之间的换行都在，
 * 隐藏的段落不在）；密码和隐藏的字没出现在给模型的任何内容里；搬运的回执只有字数和首尾几个字，没有全文。
 * 按钮叫「提交」不叫「发送」：点「发送」会先停下等用户在网页上确认，那不是这里要测的。
 * 失败方式：去掉扩展 fill 里读 from 的那一段，提交的文字不是原文；来源改回取 visibleText，第 2 次提交的段落挤成一行。
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

// 标签之间不留空白：段落之间的换行只能来自排版，不能来自 HTML 源码里的换行。
const RICH = `<div id="rich"><p>第一段：“先想清楚目标”。</p><p>第二段：每天 25 分钟。</p><ul><li>周一：打基础</li><li>周二：做练习</li></ul><p style="display:none">隐藏的字</p></div>`;
// 段落之间空一行、列表项之间换一行：这是浏览器排版后用户看到、复制出来的样子。
const RICH_EXPECTED = "第一段：“先想清楚目标”。\n\n第二段：每天 25 分钟。\n\n周一：打基础\n周二：做练习";
const HIDDEN = "隐藏来源里的字";
const FOLDED = "收起面板里的字";

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
    ? page("回答", `<h1>对话</h1><div id="answer" style="white-space:pre-wrap">${escape(ANSWER)}</div>${RICH}<label>登录密码 <input id="pw" type="password" value="${SECRET}"></label><div id="hidden" style="display:none">${HIDDEN}<script>var x = 1;</script></div><details><summary>更多</summary><div id="folded">${FOLDED}</div></details>`)
    : page("聊天", `<h1>聊天</h1><textarea id="box" rows="10" cols="60" aria-label="消息" oninput="(window.__writes ||= []).push(this.value)"></textarea><button id="submit" type="button" onclick="fetch('/received', { method: 'POST', body: document.getElementById('box').value })">提交</button>`);

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
const richFrom = { tabId: -1, target: "#rich" };
const hiddenFrom = { tabId: -1, target: "#hidden" };
const foldedFrom = { tabId: -1, target: "#folded" };

/** 给模型的每条工具回执原文，按出现顺序（同一回执只记一次）。 */
const toolTexts: string[] = [];
const seenCalls = new Set<string>();

/** 模型收到的全部请求正文，用来查密码有没有漏进去。 */
const payloads: string[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "fill", args: { target: "#box", value: "我自己打的字", from } } },
    { tool: { name: "fill", args: { target: "#box", from: pwFrom } } },
    { tool: { name: "fill", args: { target: "#box", from: hiddenFrom } } },
    { tool: { name: "fill", args: { target: "#box", from: foldedFrom } } },
    { tool: { name: "fill", args: { target: "#box", from } } },
    { tool: { name: "fill", args: { target: "#box", value: "占位" } } },
    { tool: { name: "snapshot", args: snapshotArgs } },
    { tool: { name: "fill", args: { target: "#box", from: refFrom } } },
    { tool: { name: "click", args: { target: "#submit", label: "提交" } } },
    { tool: { name: "fill", args: { target: "#box", from: richFrom } } },
    { tool: { name: "click", args: { target: "#submit", label: "提交" } } },
    { text: FINAL },
  ] },
], undefined, (payload: { messages?: Array<{ role: string; content?: unknown; tool_call_id?: string }> }) => {
  payloads.push(JSON.stringify(payload));

  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((p: { text?: string }) => p.text ?? "").join("") : "";

    if (m.role === "tool" && !seenCalls.has(m.tool_call_id ?? text)) { seenCalls.add(m.tool_call_id ?? text); toolTexts.push(text); }
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
  richFrom.tabId = answerTabId;
  hiddenFrom.tabId = answerTabId;
  foldedFrom.tabId = answerTabId;

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
  await until(async () => received.length > 1 || undefined, 5_000, "服务端收到两次提交").catch(() => {});
  await sleep(800);
  await rp.screenshot(panel, join(artifacts, "panel.png"));
  await rp.screenshot(chat, join(artifacts, "chat.png"));

  const writes = (await rp.evaluate(chat, "window.__writes ?? []")) as string[];
  evidence.received = received;
  evidence.receipts = toolTexts;
  evidence.firstWrites = writes.slice(0, 3).map(w => w.slice(0, 40));
  evidence.writeCount = writes.length;
  const [both, pw, hidden, folded, copied, placeholder, snapshot, byRef, , rich] = toolTexts;

  assert.match(both ?? "", /value 和 from 只能给一个/, `giving both value and from is an error: ${JSON.stringify(both)}`);
  assert.match(pw ?? "", /敏感栏/, `from on a password field is refused: ${JSON.stringify(pw)}`);
  assert.match(hidden ?? "", /来源元素不可见/, `from on a display:none element is refused: ${JSON.stringify(hidden)}`);
  assert.match(folded ?? "", /来源元素不可见/, `from inside a closed <details> is refused: ${JSON.stringify(folded)}`);
  assert.ok(writes.length > 0 && writes.slice(0, writes.findIndex(w => w !== "") + 1).every(w => w === "" || ANSWER.startsWith(w)),
    `the box was not written before the first successful copy: ${JSON.stringify(evidence.firstWrites)}`);
  assert.ok(!payloads.some(p => p.includes(SECRET) || p.includes(HIDDEN) || p.includes(FOLDED)), "the password and hidden text never reached the model");

  assert.match(copied ?? "", new RegExp(`Copied ${ANSWER.length} characters from #answer`), `the copy receipt gives the length: ${JSON.stringify(copied)}`);
  assert.match(copied ?? "", /<page-content untrusted/, `the copied ends are wrapped as page content: ${JSON.stringify(copied)}`);
  assert.ok(!copied?.includes("一、先想清楚目标"), `the copy receipt does not carry the full text: ${JSON.stringify(copied)}`);
  assert.match(copied ?? "", /holds exactly this text/, `the field read back the same text: ${JSON.stringify(copied)}`);
  assert.match(placeholder ?? "", /«占位»/, `the placeholder fill replaced the box before the ref copy: ${JSON.stringify(placeholder)}`);
  assert.match(snapshot ?? "", /RootWebArea/, "the model read the answer tab's snapshot");
  assert.notEqual(refFrom.target, "@0", "the snapshot listed the answer as a text line with a ref");
  assert.match(byRef ?? "", new RegExp(`Copied ${ANSWER.length} characters from ${refFrom.target} .*holds exactly this text`, "s"), `from a snapshot text ref copies the same text: ${JSON.stringify(byRef)}`);
  assert.match(rich ?? "", new RegExp(`Copied ${RICH_EXPECTED.length} characters from #rich`), `the paragraph answer was copied: ${JSON.stringify(rich)}`);

  assert.equal(received.length, 2, `server received exactly two submits: ${JSON.stringify(received)}`);
  assert.equal(received[0], ANSWER, `the ref copy replaced the placeholder with the answer, character for character: ${JSON.stringify(received[0])}`);
  assert.equal(received[1], RICH_EXPECTED, `the paragraph-and-list answer keeps its paragraph and list breaks and leaves out the hidden paragraph: ${JSON.stringify(received[1])}`);
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
