/**
 * 对话超出模型的上下文窗口时，删掉这一轮之前的旧网页内容再问一次，回答照常出来。
 *   npx tsx scripts/acceptance/real-path/overflow-retry.mts --headless
 * 本机三个长页面 A、B、C 上各问一句；脚本模型在一个主任务请求同时带着三页正文时回超窗口错误。
 *   a) 第三问照样答完，侧栏不显示超窗口的错误。
 *   b) 第三问重试的请求里还有页 C 的正文，页 A、B 的正文没有了。
 *   c) 第二问的请求、第三问第一次请求都带着前面各页的全文（没超窗口时不删）。
 * 失败方式：去掉超窗口后的删除重试，a 失败。反例结果见验收文件。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-overflow-retry`);

await mkdir(out, { recursive: true });

// 每页正文约 3000 字，带一个只在这页出现的标记词，用来判断请求里有没有这页的正文。
const MARKS = { a: "ALPHAMARK", b: "BETAMARK", c: "GAMMAMARK" } as const;

const page = (key: keyof typeof MARKS) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page ${key}</title><body><main><h1>Page ${key}</h1>${
  Array.from({ length: 30 }, (_, i) => `<p>${MARKS[key]} paragraph ${i}: the fixture records ${key}-${i * 37} items shipped on day ${i}.</p>`).join("")}</main></body></html>`;

const site = createServer((req, res) => {
  const key = (req.url ?? "/a").slice(1) as keyof typeof MARKS;
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(key in MARKS ? key : "a"));
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASKS = ["溢出一：这页讲什么？", "溢出二：这页讲什么？", "溢出三：这页讲什么？"];

const ANSWERS = ["第一页是发货记录。", "第二页也是发货记录。", "第三页还是发货记录。"];

/** 第三问的每个主任务请求：原文，以及是否被回了超窗口。 */
const third: Array<{ raw: string; overflow: boolean }> = [];

const seen: string[][] = ASKS.map(() => []);

const isOverflow = (raw: string) => Object.values(MARKS).every(mark => raw.includes(mark));

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...ASKS.map((ask, i) => ({ match: ask, steps: [{ text: ANSWERS[i]! }] })),
], undefined, undefined, raw => {
  const n = ASKS.findLastIndex(ask => raw.includes(ask));

  if (n >= 0) seen[n]!.push(raw);

  if (n === 2) third.push({ raw, overflow: isOverflow(raw) });

  return isOverflow(raw);
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const marksIn = (raw: string) => Object.entries(MARKS).filter(([, mark]) => raw.includes(mark)).map(([key]) => key).join("");

try {
  const port = siteAddress(site).port;
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");

  for (const [i, ask] of ASKS.entries()) {
    await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/${"abc"[i]}` }, work);
    await sleep(1_000);
    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
    const done = `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.textContent.includes(${JSON.stringify(ANSWERS[i])})) && document.querySelector("#send-btn")?.disabled === false`;
    await until(async () => await rp.evaluate(panel, done) || undefined, 60_000, `回答「${ANSWERS[i]}」`, 250).catch(() => undefined);
    await sleep(2_000);
  }

  await rp.screenshot(panel, join(out, "panel.png")).catch(() => {});
  const panelText = String(await rp.evaluate(panel, `document.querySelector("#messages")?.innerText ?? ""`));
  check("a 第三问照样答完，侧栏没有超窗口错误", panelText.includes(ANSWERS[2]!) && !/没有给出回答|maximum context length/i.test(panelText), { answered: panelText.includes(ANSWERS[2]!), errorShown: /没有给出回答|maximum context length/i.test(panelText), overflowReplies: third.filter(r => r.overflow).length });
  const retry = third.find(r => !r.overflow);
  check("b 重试的请求只留页 C 的正文", third[0]?.overflow === true && !!retry && marksIn(retry.raw) === "c", { requests: third.map(r => ({ overflow: r.overflow, pages: marksIn(r.raw) })) });
  check("c 没超窗口时不删：第二问带着 A、B，第三问第一次带着 A、B、C", seen[1]!.length > 0 && seen[1]!.every(raw => marksIn(raw) === "ab") && marksIn(third[0]?.raw ?? "") === "abc", { second: seen[1]!.map(marksIn), thirdFirst: marksIn(third[0]?.raw ?? "") });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, third: third.map(r => ({ overflow: r.overflow, pages: marksIn(r.raw), chars: r.raw.length })) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
