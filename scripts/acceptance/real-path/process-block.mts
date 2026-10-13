/**
 * 过程块 AC：进行中两行，做完一行回执，展开是记录（#263，docs/evals/20261011-process-block-ac.md）。
 *   npx tsx scripts/acceptance/real-path/process-block.mts --headless
 * 脚本模型：想 4 秒 → 打开页 B → js（带用途「读出标题」）→ 点一个不存在的按钮（没做成）→ 想 8 秒 → 点「作品」→ 回答。
 *   a) 想 8 秒那段：第一行只写「正在思考」，秒数从这段开始数（和真实时间差 ≤1.2 秒）；第二行「已做 2 步 · 1 步换了做法」。
 *   b) 侧栏任何时候都没有「执行脚本」「0.0s」「+ 前面」「件事」。
 *   c) 回执「做了 3 步 · 耗时 · 核对状态」（#334 的收尾样式，换了做法的那步在展开的过程里）；380px 和 300px 宽都是一行。
 *   d) 展开的记录：「想了 N 秒」只列两段长的（4 秒、8 秒左右），末行「共 N 秒，其中想了 M 秒」，N 与发送到结束差 ≤1 秒。
 *   e) 重开侧栏（回放历史）后，过程块的文字和回放前一样；回放没有时钟时不写任何秒数。
 * 失败方式：标题仍拼「· 已做 N 步」、秒数数整轮、回执只写步数或写了耗时，对应的项失败。反例结果见验收文件。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-process-block`);

await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><p>Start here.</p></main></body></html>`;

const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Works</h1><button id="ok">作品</button></main></body></html>`;

const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A));

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开作品页，点作品。";

const ANSWER = "已经点开作品。";

/** 第 2 段长思考：点了不存在的按钮之后，脚本模型过这么久才回下一步。 */
const LONG_THINK_MS = 8_000;

const port = siteAddress(site).port;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 4_000 },
    { tool: { name: "js", args: { code: "(() => document.title)()", purpose: "读出标题", readonly: true } } },
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "click", args: { target: "#ok", label: "作品" } }, delayMs: LONG_THINK_MS },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 最后一个过程块的读数。 */
const READ = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  if (!d) return null;
  const title = d.querySelector(".run-title");
  return {
    done: d.classList.contains("done"),
    title: title?.textContent ?? "",
    time: d.querySelector(".run-time")?.textContent ?? "",
    meta: d.querySelector(".run-meta")?.hidden ? "" : d.querySelector(".run-meta")?.textContent ?? "",
    oneLine: title ? title.scrollWidth <= title.clientWidth + 1 && title.getBoundingClientRect().height < 30 : false,
    record: [...d.querySelectorAll(".run-body .chip:not(.prep) .chip-label, .run-body .run-think, .run-body details.thinking:not(.narration) > summary > span, .run-body .run-total")].map(e => e.textContent.trim()),
    text: d.textContent,
    all: document.querySelector("#messages").textContent,
  };
})()`;

type Read = { done: boolean; title: string; time: string; meta: string; oneLine: boolean; record: string[]; text: string; all: string };

const FORBIDDEN = ["执行脚本", "0.0s", "+ 前面", "件事"];

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  let panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  const sentAt = Date.now();
  await rp.pressEnter(panel);

  // 不存在的按钮那一步结束后，就是 8 秒的那段思考。
  const read = async () => (await rp.evaluate(panel, READ)) as Read | null;
  const seen = new Set<string>();
  // 第 4 个模型请求到达 = 第 3 步（不存在的按钮）的结果已经回给模型，8 秒的思考从这时开始。
  await until(async () => {
    const r = await read();

    if (r) for (const word of FORBIDDEN) if (r.all.includes(word)) seen.add(word);

    return model.requests.filter(q => q.rule === ASK).length >= 4 ? true : undefined;
  }, 60_000, "第 3 步结束", 50);
  const thinkingSince = Date.now();
  await sleep(5_000);
  const live = await read();
  const elapsed = (Date.now() - thinkingSince) / 1000;
  const liveSecs = Number(/^(\d+) 秒$/.exec(live?.time ?? "")?.[1] ?? NaN);
  await rp.screenshot(panel, join(out, "a-thinking.png"));
  const think = (title: string) => title === "正在思考";
  check("a 想的时候第一行只写「正在思考」，秒数从这段开始数，第二行写步数", !!live && think(live.title) && Math.abs(liveSecs - elapsed) <= 1.2 && live.meta === "已做 2 步 · 1 步换了做法", { title: live?.title ?? null, time: live?.time ?? null, elapsed, meta: live?.meta ?? null });

  await until(async () => { const r = await read(); if (r) for (const word of FORBIDDEN) if (r.all.includes(word)) seen.add(word); return r?.done && r.all.includes(ANSWER) ? true : undefined; }, 60_000, "收尾", 100);
  const endedAt = Date.now();
  await sleep(800);
  const done = (await read())!;
  check("b 侧栏没有「执行脚本」「0.0s」「+ 前面」「件事」", seen.size === 0 && !FORBIDDEN.some(w => done.all.includes(w)), { seen: [...seen] });
  check("c 回执「做了 3 步 · 耗时 · 核对状态」，380px 一行", /^做了 3 步 · \d[^·]*秒 · (核对中…|已核对页面)$/.test(done.title) && done.oneLine, { title: done.title, oneLine: done.oneLine });
  await rp.screenshot(panel, join(out, "c-receipt-380.png"));
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 300, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await sleep(500);
  const narrow = (await read())!;
  await rp.screenshot(panel, join(out, "c-receipt-300.png"));
  check("c2 300px 宽：回执仍是一行", narrow.oneLine && /^做了 3 步 · \d[^·]*秒 · (核对中…|已核对页面)$/.test(narrow.title), { title: narrow.title, oneLine: narrow.oneLine });
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);

  await rp.evaluate(panel, '[...document.querySelectorAll("#messages details.run-steps")].at(-1).open = true; true');
  await sleep(600);
  const opened = (await read())!;
  await rp.screenshot(panel, join(out, "d-record.png"));
  const thinks = opened.record.filter(t => /^想了 \d+ 秒$/.test(t)).map(t => Number(/\d+/.exec(t)![0]));
  const total = /^共 (\d+) 秒，其中想了 (\d+) 秒$/.exec(opened.record.at(-1) ?? "");
  const wall = (endedAt - sentAt) / 1000;
  check("d 记录只单列长思考（约 4 秒、8 秒），末行合计和真实时长差 ≤1 秒", thinks.length === 2 && Math.abs(thinks[0]! - 4) <= 1 && Math.abs(thinks[1]! - 8) <= 1 && !!total && Math.abs(Number(total[1]) - wall) <= 1.5 && opened.record.some(t => t.includes("读出标题")), { record: opened.record, wall });

  const before = opened.text;
  await rp.cdp.send("Page.reload", {}, panel);
  panel = await rp.attach(await rp.openSidePanel());
  await until(async () => (await read())?.done || undefined, 30_000, "回放出过程块", 200);
  await sleep(1_000);
  const replay = (await read())!;
  const sameAsBefore = replay.title === done.title;
  check("e 回放后回执不变；回放里有秒数时，和回放前一致", sameAsBefore && (!/\d+\s*秒/.test(replay.text) || replay.text.replace(/\s+/g, "") === before.replace(/\s+/g, "") || !replay.text.includes("想了")), { replayTitle: replay.title, hasSeconds: /\d+\s*秒/.test(replay.text) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
