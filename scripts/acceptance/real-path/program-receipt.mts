/**
 * 程序结束时说清停在哪一页；选择器歧义时报错直接给候选。
 *   npx tsx scripts/acceptance/real-path/program-receipt.mts --headless
 * 本机页 A 有两个同 class 的链接，都通往页 B。脚本模型：
 *   第 1 个程序用 a.item 点击 → 歧义报错；第 2 个程序用报错里第 2 个候选的 loc=css 点击，再用 browser.pressKey；然后回答。
 *   a) 歧义报错里列出两个候选，第 2 个带只指向它的 loc=css 和它的文字 "Beta"。
 *   b) 第 2 个程序没有报错（pressKey 是 press_key 的别名），网站收到了 /b 的请求。
 *   c) 第 2 个程序的结果里写明工作标签页现在是 "Page B" — …/b。
 * 失败方式：报错只说「请 snapshot」时 a 失败；只认部分 camelCase 时 b 失败；不写结束页面时 c 失败。反例结果见验收文件。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-program-receipt`);

await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main id="list"><a class="item" href="/b">Alpha</a> <a class="item" href="/b">Beta</a></main></body></html>`;

const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Arrived</h1></main></body></html>`;

const visits: string[] = [];

const site = createServer((req, res) => {
  visits.push(req.url ?? "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开第二个链接。";

const ANSWER = "已打开 Page B。";

const CANDIDATE = "loc=css:#list > a:nth-child(2)";

type Message = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";

/** 每次主任务请求里的工具结果（按出现顺序）。 */
let toolResults: string[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "browser_run", args: { code: 'await browser.click({target: "a.item"}); return "clicked";', label: "点链接" } } },
    { tool: { name: "browser_run", args: { code: `await browser.click({target: ${JSON.stringify(CANDIDATE)}}); await browser.pressKey({key: "Tab"}); return "clicked";`, label: "点第二个链接" } } },
    { text: ANSWER },
  ] },
], undefined, payload => {
  if (payload.tools?.length) toolResults = ((payload.messages ?? []) as Message[]).filter(m => m.role === "tool").map(textOf);
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const port = siteAddress(site).port;
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
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(ANSWER)})`) || undefined, 60_000, "回答");

  const [first = "", second = ""] = toolResults;
  check("a 歧义报错列出候选，第 2 个带只指向它的 loc=css 和文字", first.includes("候选：") && /2\) loc=css:\S+ <a> "Beta"/.test(first), { first: first.slice(0, 600) });
  check("b 第 2 个程序没有报错（pressKey 可用），网站收到 /b", !/not a browser method|失败|Error/i.test(second.split("[After this program")[0]!) && visits.includes("/b"), { second: second.slice(0, 400), visits });
  check("c 第 2 个程序的结果写明现在停在 Page B — …/b", /After this program the working tab \d+ shows "Page B" — http:\/\/127\.0\.0\.1:\d+\/b;/.test(second), { tail: second.slice(-300) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, toolResults, visits }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
