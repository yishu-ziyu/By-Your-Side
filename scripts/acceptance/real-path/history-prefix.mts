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
    await sleep(2_000);
  }

  for (const n of [1, 2]) {
    const result = extends_(requests[n - 1]!.at(-1) ?? [], requests[n]![0] ?? []);
    check(`a${n} 第 ${n + 1} 条消息的第一次请求以第 ${n} 条的最后一次请求开头`, result.ok, result);
  }

  const second = requests[1]![0] ?? [], third = requests[2]![0] ?? [];
  const blocks = (messages: string[], path: string) => count(messages, `/${path}" title=`);
  check("b 同一页没变：第 2 条的请求里页 A 只读进来一份，并有一行指回去", blocks(second, "a") === 1 && count(second, "unchanged since your earlier observation") === 1, { aBlocks: blocks(second, "a"), unchangedLines: count(second, "unchanged since your earlier observation") });
  check("c 换了页：第 3 条的请求里有页 B 的正文", blocks(third, "b") === 1 && count(third, B_TEXT) > 0, { bBlocks: blocks(third, "b"), bText: count(third, B_TEXT) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, requests: requests.map(r => r.map(m => m.map(raw => JSON.parse(raw)))) }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
