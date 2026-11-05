import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-program-long-wait`);
await mkdir(out, { recursive: true });

const FINISH_MS = 75_000;
const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>生成页</title><body><main id="reply">正在生成</main>
<script>if (location.pathname === "/slow") setTimeout(() => { document.querySelector("#reply").textContent = "生成完成"; }, ${FINISH_MS});</script></body></html>`;
const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });
await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const waitLoop = `for (let i = 0; i < 30; i++) {
  await browser.sleep({ms: 10000});
  const text = await browser.js({code: "document.querySelector('#reply').textContent"});
  if (text.value === "生成完成") return {done: true, rounds: i + 1};
}
return {done: false};`;
const ASK_WAIT = "用例 long-wait：等页面生成完。";
const ASK_STEER = "用例 long-wait-steer：等页面生成完。";
const STEER = "用例插话：别等了，换一件事。";
const WAIT_ANSWER = "页面已生成完成。";
const STEER_ANSWER = "好的，不等了。";

type Message = { role: string; content?: string | Array<{ text?: string }> | null };
const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";
const replies = new Map<string, { text: string; at: number }>();

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: STEER, steps: [{ text: STEER_ANSWER }] },
  { match: ASK_STEER, steps: [{ tool: { name: "browser_run", args: { code: waitLoop, label: "等页面生成完" } } }] },
  { match: ASK_WAIT, steps: [{ tool: { name: "browser_run", args: { code: waitLoop, label: "等页面生成完" } } }, { text: WAIT_ANSWER }] },
], undefined, payload => {
  for (const message of (payload.messages ?? []) as Message[]) if (message.role === "tool" && !replies.has(textOf(message))) replies.set(textOf(message), { text: textOf(message), at: Date.now() });
});

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };
const toolTexts = () => [...replies.values()].map(r => r.text);
const shown = (text: string) => `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(text)})`;

try {
  const port = siteAddress(site).port;
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/slow` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");

  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_WAIT);
  await rp.pressEnter(panel);
  await sleep(30_000);
  await rp.screenshot(panel, join(out, "waiting-30s.png"));
  const waitingLabel = await rp.evaluate(panel, shown("等页面生成完"));
  check("等待期间侧栏写明在等什么", waitingLabel === true, waitingLabel as Json);
  await until(async () => await rp.evaluate(panel, shown(WAIT_ANSWER)) || undefined, 120_000, "等待后的回答");
  const waited = toolTexts().find(t => t.includes('"done"')) ?? "";
  check("超过 60 秒的等待没有报失败，程序读到了生成完成", /"done":true/.test(waited), { waited: waited.slice(0, 200), all: toolTexts().map(t => t.slice(0, 120)) });
  check("没有再叫模型重试等待", !toolTexts().some(t => /timed out/i.test(t)), toolTexts().map(t => t.slice(0, 120)));

  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/never` }, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK_STEER);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, shown("等页面生成完")) || undefined, 30_000, "第二次开始等待");
  await sleep(5_000);
  const before = model.requests.length;
  await rp.click(panel, "#input");
  await rp.typeText(panel, STEER);
  const spoke = Date.now();
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, shown(STEER_ANSWER)) || undefined, 30_000, "插话后的回答");
  const elapsed = Date.now() - spoke;
  const stopped = toolTexts().find(t => t.includes("user just sent a new message")) ?? "";
  check("用户插话后 15 秒内得到回答（单次等待 10 秒的程序也立刻结束）", elapsed < 15_000, { elapsed, requests: model.requests.length - before });
  check("等待被插话结束，结果不是失败，也没有继续操作", stopped.includes("no further actions"), { stopped: stopped.slice(0, 240) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, tools: toolTexts() }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some(c => !c.pass)) process.exitCode = 1;
