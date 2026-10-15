/**
 * 模型用错 tabs 的参数、或原地重复同一个调用时，工具结果当场指出来，不让它空转。
 *   npx tsx scripts/acceptance/real-path/tool-misuse-guard.mts --headless
 * 本机页 A。脚本模型：先发 tabs {action:"list", url}，再连发 3 次同样的 snapshot（页面不变）。
 *   a) tabs list 带 url 不执行，结果写明该用 action:"open" 或 navigate。
 *   b) 第 3 次 snapshot 的结果开头有「连续第 3 次同样的调用」的框架说明，前两次没有；第 3 次仍照常读出页面。
 * 失败方式（旧代码）：tabs list 带 url 照常回标签页列表；第 3 次 snapshot 与前两次一模一样，没有说明。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-tool-misuse-guard`);

await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><h1>Start</h1><p>静止的页面。</p></main></body></html>`;

const site = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_A); });

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const port = siteAddress(site).port;

const ASK = "案例：用错工具参数和原地重复。";

const ANSWER = "用错参数和原地重复核对完毕。";

const NOTE = "这是连续第 3 次同样的调用，结果没有变化。如果在等页面变化，先等待再读（例如 browser.sleep 或 wait_for）；否则请换一种做法。";

type Message = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";

/** 每次主任务请求里的工具结果（按出现顺序）。 */
let toolResults: string[] = [];

const snapshot = { tool: { name: "snapshot", args: {} } };

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "tabs", args: { action: "list", url: `http://127.0.0.1:${port}/b` } } },
    snapshot, snapshot, snapshot,
    { text: ANSWER },
  ] },
], undefined, payload => {
  if (payload.tools?.length) toolResults = ((payload.messages ?? []) as Message[]).filter(m => m.role === "tool").map(textOf);
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(ANSWER)})`) || undefined, 90_000, "回答");

  const [tabs = "", first = "", second = "", third = ""] = toolResults;
  check("a tabs list 带 url 不执行，指出用 open 或 navigate", tabs.includes('tabs action:"list" 不接受 url') && tabs.includes('action:"open"') && tabs.includes("navigate") && !tabs.includes("Page A"), { tabs: tabs.slice(0, 400) });
  check("b 第 3 次同样的 snapshot 开头有重复说明，前两次没有，页面照常读出", third.trimStart().startsWith(`[框架说明] ${NOTE}`) && third.includes("Start")
    && first.includes("Start") && !first.includes("框架说明") && !second.includes("框架说明"), { first: first.slice(0, 200), second: second.slice(0, 200), third: third.slice(0, 300) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, toolResults }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
