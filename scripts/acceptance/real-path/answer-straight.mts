import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-straight`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>会议室预订</title><body style="font:16px sans-serif;margin:40px">
<form id="f"><p><label>日期 <input id="date" type="text" aria-label="日期"></label></p><p><button id="submit">提交</button></p></form>
<output id="status"></output>
<script>document.querySelector('#f').addEventListener('submit', async e => { e.preventDefault();
  await fetch('/book', { method: 'POST', body: document.querySelector('#date').value }); document.querySelector('#status').textContent = '已提交'; });</script></body></html>`;

const bookings: string[] = [];

const hits: string[] = [];

const site = createServer(async (req, res) => {
  if (req.url === "/moved") { hits.push(`${req.method} /moved`); res.writeHead(302, { location: "/done" }).end(); return; }
  if (req.method === "POST") { let body = ""; for await (const part of req) body += part; bookings.push(body); res.end("ok"); return; }
  hits.push(req.url ?? "");
  if (req.url === "/missing" || req.url === "/gone-api") { res.writeHead(404, { "content-type": "text/plain" }).end("not found"); return; }
  if (req.url === "/empty") { res.writeHead(204).end(); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const closed = createServer();
await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
const CLOSED_PORT = siteAddress(closed).port;
await new Promise<void>(done => closed.close(() => done()));

const ASK = "案例：在当前网页订下周四的会议室，直接点提交。";

const FETCH_HOST = "fixture-missing.test";

const WRONG = "2026-10-08";

const ANSWER = "已提交 10 月 8 日的会议室预订。";

const FORBIDDEN = ["结果还没确认", "有一步失败没说", "页面没有变化", "核对没过"];

const CHECK_DELAY_MS = 4_000;

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }), delayMs: CHECK_DELAY_MS }] },
  { match: ASK, steps: [
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/missing` } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/moved` } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/empty` } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${CLOSED_PORT}/` } } },
    { tool: { name: "fill", args: { target: "#date", value: WRONG, label: "日期" } } },
    { tool: { name: "click", args: { target: "#submit", label: "提交" } } },
    { tool: { name: "browser_run", args: { code: `const a = await browser.fetch({url: "http://${FETCH_HOST}:${siteAddress(site).port}/empty"}); const b = await browser.fetch({url: "http://${FETCH_HOST}:${siteAddress(site).port}/gone-api"}); return [a.status, b.status];`, label: "取接口" } } },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${FETCH_HOST} 127.0.0.1`, "--no-proxy-server"] });

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const samples: Array<{ at: number; answer: boolean }> = [];

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  const ANSWER_JS = `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.getClientRects().length > 0 && m.textContent.includes(${JSON.stringify(ANSWER)}))`;
  const started = Date.now();

  for (;;) {
    const answer = Boolean(await rp.evaluate(panel, ANSWER_JS));
    samples.push({ at: Date.now(), answer });

    if (answer || Date.now() - started > 60_000) break;
    await sleep(50);
  }

  const delivered = model.requests.find(r => r.rule === ASK && r.step === 8 && r.lastTextAt !== undefined)?.lastTextAt ?? null;
  const shownAt = samples.find(s => s.answer)?.at ?? null;
  const lagMs = delivered !== null && shownAt !== null ? shownAt - delivered : null;

  await rp.screenshot(panel, join(out, "b-answer-shown.png"));
  check("b 模型写完回答后 1.5 秒内，侧栏显示这句回答", lagMs !== null && lagMs <= 1_500, { deliveredAt: delivered, shownAt, lagMs });

  await until(async () => bookings.length > 0 || undefined, 10_000, "网站收到提交", 100).catch(() => null);
  check("a 网站收到提交，日期是模型填的 10 月 8 日", bookings.length === 1 && bookings[0] === WRONG, { bookings: [...bookings] });

  await until(async () => model.requests.some(r => r.rule === '"goalPage"') || undefined, 20_000, "目标核对请求", 100);
  await sleep(CHECK_DELAY_MS + 1_500);
  const text = String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'));
  const found = FORBIDDEN.filter(word => text.includes(word));
  check("c 侧栏没有拦截或待确认的标签", found.length === 0 && text.includes(ANSWER), { found, tail: text.slice(-600) });

  const failedNote = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .act-failed")].map(n => n.textContent).join(" | ")`));
  check("d 失败步骤写人话原因，不带选择子", /没找到目标/.test(failedNote) && /页面不存在（404）/.test(failedNote) && !failedNote.includes("#gone"), { failedNote });
  const notes = failedNote ? failedNote.split(" | ") : [];
  const steps = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip-label")].map(n => n.textContent).join(" | ")`));
  check("e browser_run 里失败的 fetch 写人话原因", hits.includes("/gone-api") && notes.filter(n => n.includes("页面不存在（404）")).length === 2, { hits: [...hits], notes, steps });
  check("f 204 空回执和 302 跳转不算失败", hits.includes("/empty") && hits.includes("GET /moved") && notes.length === 4, { hits: [...hits], notes, steps });
  check("g 连不上的地址写「连不上这个地址」", notes.filter(n => n.includes("连不上这个地址")).length === 1 && !notes.some(n => /结果未知|已取消/.test(n)), { notes });
  const run = await rp.evaluate(panel, `(() => { const r = [...document.querySelectorAll("#messages .run-steps")].at(-1); const mark = r?.querySelector(".run-orb-mark"); return { title: r?.querySelector("summary")?.textContent ?? null, mark: mark && !mark.hidden ? mark.dataset.state ?? null : null }; })()`) as { title: string | null; mark: string | null };
  check("h 程序最后一步 404 后回答，这轮不算没做成", run.title !== null && !/做了 \d+ 步 · 有 \d+ 步没做成/.test(run.title) && run.mark !== "failed", run);
  await rp.evaluate(panel, 'void ([...document.querySelectorAll(".run-steps")].at(-1)?.setAttribute("open", "")); true');
  await rp.screenshot(panel, join(out, "c-panel.png"));
  await writeFile(join(out, "messages.html"), String(await rp.evaluate(panel, 'document.querySelector("#messages")?.outerHTML ?? ""')));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every(c => c.pass) ? "PASS" : "FAIL", checks, bookings, samples: samples.length, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
