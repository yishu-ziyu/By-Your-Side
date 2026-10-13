/**
 * 同一会话接着问，每条新消息的请求都是上一条的前缀延伸，同一页没变不再带第二份正文（#271）。
 *   npx tsx scripts/acceptance/real-path/history-prefix.mts --headless
 * 本机文章页 A 上连问两句，再换到页 B 问一句；脚本模型直接回答，记下每次主任务请求（带工具表）的 messages。
 *   a) 第 2、3 条消息的第一次请求，以上一条消息最后一次请求的全部消息开头，逐字相同；末尾的应用状态快照也要留在原位（10-13：每次删掉再追加，后端缓存退回到系统提示词）。
 *   b) 第 2 条消息（同一页没变）的请求里，页 A 的正文只出现一次，并有一行「unchanged since your earlier observation」。
 *   c) 第 3 条消息（换了页）的请求里有页 B 的正文。
 * 失败方式：把本次运行的上下文改回只在本次运行里插入，或把状态快照改回每次删掉再追加到末尾，a 失败；去掉同页去重，b 失败。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-history-prefix`);

await mkdir(out, { recursive: true });

const A_TEXT = "Ghibli fixture article: the studio was founded in June 1985 in Tokyo.";

const B_TEXT = "Totoro fixture article: the film opened in April 1988.";

const page = (title: string, text: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1><p>${text}</p></main></body></html>`;

const site = createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? page("Totoro", B_TEXT) : page("Ghibli", A_TEXT));
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASKS = ["案例一：总结这页。", "案例二：它是哪年成立的？", "案例三：这部电影哪年上映？"];

const ANSWERS = ["这页讲吉卜力工作室。", "1985 年成立。", "1988 年上映。"];

type Message = { role: string; content?: string | Array<{ text?: string }> | null };

const textOf = (m: Message) => Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : m.content ?? "";

/** 每条消息的主任务请求，按发出顺序；每个请求存成逐条消息的 JSON 字符串，方便逐字比较。 */
const requests: string[][][] = ASKS.map(() => []);

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  ...ASKS.map((ask, i) => ({ match: ask, steps: [{ text: ANSWERS[i]! }] })),
], undefined, payload => {
  if (!payload.tools?.length) return;
  const messages = (payload.messages ?? []) as Message[];
  const last = [...messages].reverse().find(m => m.role === "user" && ASKS.some(ask => textOf(m).includes(ask)));
  const n = last ? ASKS.findIndex(ask => textOf(last).includes(ask)) : -1;

  if (n >= 0) requests[n]!.push(messages.map(m => JSON.stringify(m)));
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 上一条消息最后一次请求的全部消息是不是下一条消息第一次请求的开头；不是时给出第一处不同的位置。 */
function extends_(before: string[], after: string[]) {
  const prefix = before;
  const differs = prefix.findIndex((m, i) => after[i] !== m);

  return { prefixMessages: prefix.length, nextMessages: after.length, firstDifferentIndex: differs, ok: prefix.length > 0 && differs === -1 };
}

const count = (messages: string[], needle: string) => messages.map(raw => textOf(JSON.parse(raw) as Message)).join("\n").split(needle).length - 1;

try {
  const port = siteAddress(site).port;
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");

  for (const [i, ask] of ASKS.entries()) {
    if (i === 2) {
      await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/b` }, work);
      await sleep(1_000);
    }

    await rp.cdp.send("Page.bringToFront", {}, work);
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
    const done = `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.textContent.includes(${JSON.stringify(ANSWERS[i])})) && document.querySelector("#send-btn")?.disabled === false && !document.querySelector("#status-pill")?.classList.contains("running")`;
    await until(async () => await rp.evaluate(panel, done) || undefined, 60_000, `回答「${ANSWERS[i]}」`, 250);
    // 等回答后的后台判断收完，免得下一句被当成插话。
    await sleep(2_000);
  }

  for (const n of [1, 2]) {
    const result = extends_(requests[n - 1]!.at(-1) ?? [], requests[n]![0] ?? []);
    check(`a${n} 第 ${n + 1} 条消息的第一次请求以第 ${n} 条的最后一次请求开头`, result.ok, result);
  }

  const second = requests[1]![0] ?? [], third = requests[2]![0] ?? [];
  // 一份读页 = 一个 <page-content> 块（正文和 AX 树都在里面）。
  const blocks = (messages: string[], path: string) => count(messages, `/${path}" title=`);
  check("b 同一页没变：第 2 条的请求里页 A 只读进来一份，并有一行指回去", blocks(second, "a") === 1 && count(second, "unchanged since your earlier observation") === 1, { aBlocks: blocks(second, "a"), unchangedLines: count(second, "unchanged since your earlier observation") });
  check("c 换了页：第 3 条的请求里有页 B 的正文", blocks(third, "b") === 1 && count(third, B_TEXT) > 0, { bBlocks: blocks(third, "b"), bText: count(third, B_TEXT) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, requests: requests.map(r => r.map(m => m.map(raw => JSON.parse(raw)))) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
