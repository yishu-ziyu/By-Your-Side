/**
 * 点提交一类的按钮前，核对这次填过的值是不是用户这次要的（docs/evals/20261007-submit-check.md R1、R3）。只装扩展、隔离构建、本机脚本模型、本机预订页。
 *   npx tsx scripts/acceptance/real-path/submit-check.mts --headless
 * 脚本模型同时扮演做事的模型和核对用的那次短判断：判断的回答按要核对的日期写死（10-08 对不上、10-15 对得上）。
 *   a) 用户说「下周四」，模型把日期填成 10 月 8 日后点「预订」：服务器收到 0 次预订；模型收到的结果和侧栏都写明哪一栏对不上。
 *   b) 模型改成 10 月 15 日后再点「预订」：服务器恰好收到 1 次，日期是 10 月 15 日。
 * 失败方式：去掉提交前核对（checkRouteBeforeSubmit 直接放行），a 的服务器在第一次点「预订」时就收到 10 月 8 日的预订。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-submit-check`);

await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>会议室预订</title><body style="font:16px sans-serif;margin:40px">
<form id="f"><p><label>日期 <input id="date" type="text" aria-label="日期"></label></p><p><button id="submit">预订</button></p></form>
<output id="status"></output>
<script>document.querySelector('#f').addEventListener('submit', async e => { e.preventDefault();
  await fetch('/book', { method: 'POST', body: document.querySelector('#date').value }); document.querySelector('#status').textContent = '已预订'; });</script></body></html>`;

const bookings: string[] = [];

const site = createServer(async (req, res) => {
  if (req.method === "POST") { let body = ""; for await (const part of req) body += part; bookings.push(body); res.end("ok"); return; }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
});

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASK = "案例：在当前网页订下周四的会议室。直接点预订。";

const WRONG = "2026-10-08";

const RIGHT = "2026-10-15";

const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });

const fill = (value: string) => ({ tool: { name: "fill", args: { target: "#date", value, label: "日期" } } });

const clickSubmit = { tool: { name: "click", args: { target: "#submit", label: "预订" } } };

/** 模型收到的工具结果，按调用编号去重（每次请求都带着全部历史）。 */
const toolTexts: string[] = [];

const toolIds = new Set<string>();

const model = await startScriptedModel([
  // 核对请求的内容是 JSON，里面带着用户原话：先按要核对的值认它，免得匹配到下面的任务去点按钮。
  { match: `"value":"${WRONG}"`, steps: [{ text: JSON.stringify({ mismatches: [{ field: "日期", now: "10 月 8 日", asked: "10 月 15 日" }] }) }] },
  { match: `"value":"${RIGHT}"`, steps: [{ text: JSON.stringify({ mismatches: [] }) }] },
  { match: '"goalPage"', steps: [{ text: DONE }] },
  // 第 3 步前停 4 秒：留时间在改值之前看服务器和侧栏。
  { match: ASK, steps: [fill(WRONG), clickSubmit, { ...fill(RIGHT), delayMs: 4000 }, clickSubmit, { text: "已订好 10 月 15 日的会议室。" }] },
], undefined, payload => {
  for (const m of payload.messages ?? []) {
    const text = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

    // SAFETY: OpenAI 兼容的 tool 消息带 tool_call_id。
    const id = String((m as { tool_call_id?: unknown }).tool_call_id ?? "");

    if (m.role === "tool" && !toolIds.has(id)) { toolIds.add(id); toolTexts.push(text); }
  }
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const panelText = async () => String(await rp.evaluate(panel, 'document.querySelector("#messages").innerText'));

  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  // ── a：日期对不上，不点 ──
  // 拦下的结果或预订请求，先到哪个算哪个：去掉核对时，这里看到的是 10 月 8 日的预订。
  await until(async () => bookings.length > 0 || toolTexts.some(t => t.includes("Not submitted")), 60_000, "核对结论或预订请求", 100);
  await sleep(1000);
  const held = toolTexts.find(t => t.includes("Not submitted")) ?? null;
  check("a 日期填成 10 月 8 日：点「预订」被拦下，服务器 0 次", bookings.length === 0 && held !== null, { bookings: [...bookings], held });
  check("a 模型收到的结果写明哪一栏对不上", !!held?.includes("日期现在是「10 月 8 日」，你这次说的是「10 月 15 日」"), { held });
  const sideA = await panelText();
  check("a 侧栏留一行「核对没过：…」", sideA.includes("核对没过：日期现在是「10 月 8 日」"), { panel: sideA.slice(-800) });
  await rp.evaluate(panel, 'void ([...document.querySelectorAll(".run-steps")].at(-1)?.setAttribute("open", "")); true');
  await rp.screenshot(panel, join(out, "a-panel.png"));

  // ── b：改对后再点，订成一次 ──
  await until(async () => bookings.length > 0 || undefined, 60_000, "改对后的预订请求", 200);
  await until(async () => (await panelText()).includes("已订好 10 月 15 日的会议室。") || undefined, 60_000, "回答");
  await sleep(1500);
  check("b 改成 10 月 15 日后：服务器恰好 1 次，日期是 10 月 15 日", bookings.length === 1 && bookings[0] === RIGHT, { bookings: [...bookings] });
  // 做完后过程行收起：读整段文字（含收起的部分）。
  const sideB = String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'));
  check("b 过程行里留一行「核对过了」", sideB.includes("核对过了：和你这次说的一致"), { panel: sideB.slice(-800) });
  await rp.evaluate(panel, 'void ([...document.querySelectorAll(".run-steps")].at(-1)?.setAttribute("open", "")); true');
  await rp.screenshot(panel, join(out, "b-panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, bookings, toolTexts, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
