/**
 * 意图明确但格式不对的工具写法直接照意图执行，结果里附一句规范写法，不再报错浪费一个模型回合。
 *   npx tsx scripts/acceptance/real-path/lenient-tool-args.mts --headless
 * 本机页 A、B。脚本模型：
 *   第 1 个 browser_run：browser.sleep(300)、browser.navigate("…/b")、browser.wait_for_load()，
 *     再读 #agree 的 checked 和不存在的 innerText、#play 的 pressed（按钮没有 aria-pressed）和 enabled。
 *   第 2 步直接调 read_element 读 #play 的 pressed；第 3 步 read_element 用 expect 等 pressed（expect 不放宽）。
 *   a) 第 1 个程序没有报错，网站收到 /b，结果里附了 sleep、navigate、wait_for_load 三句规范写法。
 *   b) #agree 照常读出 checked=true，结果写明「不支持的属性：innerText」和可用的属性。
 *   c) #play 的 pressed 是 null，enabled 照常读出；直调 read_element 也不报错，带 null 和说明。
 *   d) expect 等一个读不到的 pressed 仍当场失败。
 * 失败方式（旧代码）：sleep(数字) 报 “takes one object of named fields”；wait_for_load 报 “not a browser method”；
 *   混入 innerText 整次读取失败；pressed 读不到整次读取失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-lenient-tool-args`);

await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><h1>Start</h1></main></body></html>`;

const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><label><input id="agree" type="checkbox" checked> 同意</label> <button id="play" aria-label="Play">▶</button></main></body></html>`;

const visits: string[] = [];

const site = createServer((req, res) => {
  visits.push(req.url ?? "");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const port = siteAddress(site).port;

const ASK = "案例：宽容的工具写法。";

const ANSWER = "宽容写法核对完毕。";

const PROGRAM = [
  "await browser.sleep(300);",
  `await browser.navigate(${JSON.stringify(`http://127.0.0.1:${port}/b`)});`,
  "await browser.wait_for_load();",
  'const agree = await browser.read_element({target: "#agree", properties: ["checked", "innerText"]});',
  'const play = await browser.read_element({target: "#play", properties: ["pressed", "enabled"]});',
  "return {agree: agree.properties, agreeNote: agree.note, play: play.properties};",
].join("\n");

type Message = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";

/** 每次主任务请求里的工具结果（按出现顺序）。 */
let toolResults: string[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "browser_run", args: { code: PROGRAM, label: "宽容写法" } } },
    { tool: { name: "read_element", args: { target: "#play", properties: ["pressed"] } } },
    { tool: { name: "read_element", args: { target: "#play", expect: { property: "pressed", equals: true } } } },
    { text: ANSWER },
  ] },
], undefined, payload => {
  if (payload.tools?.length) toolResults = ((payload.messages ?? []) as Message[]).filter(m => m.role === "tool").map(textOf);
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** browser_run 结果里 {value, steps} 那段 JSON；读不出就是 null。 */
const programValue = (text: string): { agree?: Record<string, unknown>; agreeNote?: string; play?: Record<string, unknown> } | null => {
  const match = /\{"value":.*?,"steps":\d+\}/s.exec(text);

  try { return match ? JSON.parse(match[0]).value : null; } catch { return null; }
};

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

  const [program = "", direct = "", expectRead = ""] = toolResults;
  const value = programValue(program);
  check("a 程序没有报错，网站收到 /b，附了三句规范写法", !!value && visits.includes("/b")
    && program.includes("browser.sleep(N) ran as browser.sleep({ms: N})")
    && program.includes('browser.navigate("…") ran as browser.navigate({url: "…"})')
    && program.includes("browser.wait_for_load ran as browser.waitForLoad"), { program: program.slice(0, 900), visits });
  check("b 混入 innerText 仍读出 checked，并写明不支持的属性和可用的属性", value?.agree?.checked === true && !("innerText" in (value?.agree ?? {}))
    && /不支持的属性：innerText；可用的属性：.*checked/.test(value?.agreeNote ?? "") && program.includes("不支持的属性：innerText"), { agree: value?.agree ?? null, agreeNote: value?.agreeNote ?? null });
  check("c pressed 读成 null 并说明，enabled 照常；直调 read_element 也不报错", value?.play?.pressed === null && value?.play?.enabled === true
    && /"pressed":null/.test(direct) && direct.includes("该元素不支持或尚无有效的 pressed 属性，已返回 null") && !program.includes("button") && !direct.split("</page-content>")[1]?.includes("button"), { play: value?.play ?? null, direct: direct.slice(0, 400) });
  check("d expect 等读不到的 pressed 仍当场失败", expectRead.includes("不支持或尚无有效的 pressed 属性") && !expectRead.includes('"matched":true'), { expectRead: expectRead.slice(0, 400) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, toolResults, visits }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
