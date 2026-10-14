/**
 * 提交直接交给网站，回答直接显示，不挂拦截的标签（docs/evals/20261010-drop-blocking-labels.md）。只装扩展、隔离构建、本机脚本模型、本机预订页。
 *   npx tsx scripts/acceptance/real-path/answer-straight.mts --headless
 * 用户说「下周四」，脚本模型先点一个不存在的按钮、fetch 一个 404 地址、POST 一个回 302 的地址、GET 一个 204 空回执、fetch 一个没人听的端口，
 * 再把日期填成 10 月 8 日，点「提交」，最后跑一段 browser_run（先取 204，最后一次 fetch 是 404，像翻页翻到头），然后不再调工具直接回答。
 * 点击、404、没人听的端口、程序里的 404 这四步失败，回答也不提；302 和 204 不算失败。
 * 目标核对的结论故意晚 4 秒才回（判做完）。
 *   a) 网站收到这次提交，日期就是模型填的 10 月 8 日（提交前不再核对、不拦）。
 *   b) 模型写完回答后 1.5 秒内，侧栏显示这句回答（不等核对结论）。
 *   c) 侧栏任何地方（含折叠的执行过程）都没有「结果还没确认」「有一步失败没说」「页面没有变化」「核对没过」。
 *   d) 失败那一步写人话原因「没找到目标」，不照搬回执里的选择子 `#gone`（#304）。
 *   e) browser_run 里没拿到内容的 fetch 也写「页面不存在（404）」，不当成功（#304）。
 *   f) 204 空回执和 302 跳转（扩展不跟随，拿到 status 0）不算失败：侧栏只有上面四处失败。
 *   g) 没人听的端口写「连不上这个地址」，不写「结果未知」「已取消」。
 *   h) 程序最后一次 fetch 是 404、之后直接回答：这轮不算没做成（回执不是「做了 N 步 · 有 1 步没做成」，没有失败图标）。
 * 失败方式：恢复侧栏扣住回答（claim hold），b 失败（回答要等核对结论，约 4 秒）；恢复提交前核对，a 失败（网站收不到提交）；
 * 去掉 browser-program.ts 里的 fetch 判定，e 失败；run-orb.ts 里成功的一步不清掉失败，h 失败。反例结果见验收文件。
 */
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

/** 测试站收到的请求（预订提交除外）：证明 fetch 真的发到了。 */
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

// 没人听的端口：先占一个空闲端口再关掉，fetch 过去连接被拒。
const closed = createServer();
await new Promise<void>(done => closed.listen(0, "127.0.0.1", done));
const CLOSED_PORT = siteAddress(closed).port;
await new Promise<void>(done => closed.close(() => done()));

const ASK = "案例：在当前网页订下周四的会议室，直接点提交。";

// fetch 拒抓私有地址（shared/fetch.ts），用 host-resolver-rules 把一个公网名字映回本机测试站。
const FETCH_HOST = "fixture-missing.test";

const WRONG = "2026-10-08";

const ANSWER = "已提交 10 月 8 日的会议室预订。";

const FORBIDDEN = ["结果还没确认", "有一步失败没说", "页面没有变化", "核对没过"];

/** 目标核对晚回的时长：比 1.5 秒长得多，扣住回答就一定看得出来。 */
const CHECK_DELAY_MS = 4_000;

const model = await startScriptedModel([
  // 目标核对的请求内容是 JSON，带 goalPage；先认它，免得匹配到下面的任务。
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }), delayMs: CHECK_DELAY_MS }] },
  { match: ASK, steps: [
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/missing` } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/moved`, method: "POST", body: "x=1" } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${siteAddress(site).port}/empty` } } },
    { tool: { name: "fetch", args: { url: `http://${FETCH_HOST}:${CLOSED_PORT}/` } } },
    { tool: { name: "fill", args: { target: "#date", value: WRONG, label: "日期" } } },
    { tool: { name: "click", args: { target: "#submit", label: "提交" } } },
    // 程序里的 404 用另一个地址：同一地址同样失败两次会被重复失败策略升档，改变这轮的走向。
    { tool: { name: "browser_run", args: { code: `const a = await browser.fetch({url: "http://${FETCH_HOST}:${siteAddress(site).port}/empty"}); const b = await browser.fetch({url: "http://${FETCH_HOST}:${siteAddress(site).port}/gone-api"}); return [a.status, b.status];`, label: "取接口" } } },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath({ chromeArgs: [`--host-resolver-rules=MAP ${FETCH_HOST} 127.0.0.1`, "--no-proxy-server"] });

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

/** 侧栏读数：回答出现的本机时刻。 */
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

  // 每 50 毫秒读一次：回答气泡（不算折叠的执行过程）里有没有这句回答。
  const ANSWER_JS = `[...document.querySelectorAll("#messages .msg.assistant[data-delivery-id]")].some(m => m.getClientRects().length > 0 && m.textContent.includes(${JSON.stringify(ANSWER)}))`;
  const started = Date.now();

  for (;;) {
    const answer = Boolean(await rp.evaluate(panel, ANSWER_JS));
    samples.push({ at: Date.now(), answer });

    if (answer || Date.now() - started > 60_000) break;
    await sleep(50);
  }

  // 模型写完回答的时刻：主任务第 9 步（8 个工具结果之后）的末段正文。
  const delivered = model.requests.find(r => r.rule === ASK && r.step === 8 && r.lastTextAt !== undefined)?.lastTextAt ?? null;
  const shownAt = samples.find(s => s.answer)?.at ?? null;
  const lagMs = delivered !== null && shownAt !== null ? shownAt - delivered : null;

  await rp.screenshot(panel, join(out, "b-answer-shown.png"));
  check("b 模型写完回答后 1.5 秒内，侧栏显示这句回答", lagMs !== null && lagMs <= 1_500, { deliveredAt: delivered, shownAt, lagMs });

  await until(async () => bookings.length > 0 || undefined, 10_000, "网站收到提交", 100).catch(() => null);
  check("a 网站收到提交，日期是模型填的 10 月 8 日", bookings.length === 1 && bookings[0] === WRONG, { bookings: [...bookings] });

  // 等目标核对回来、侧栏空闲，再读含折叠内容的全部文字。
  await until(async () => model.requests.some(r => r.rule === '"goalPage"') || undefined, 20_000, "目标核对请求", 100);
  await sleep(CHECK_DELAY_MS + 1_500);
  const text = String(await rp.evaluate(panel, 'document.querySelector("#messages").textContent'));
  const found = FORBIDDEN.filter(word => text.includes(word));
  check("c 侧栏没有拦截或待确认的标签", found.length === 0 && text.includes(ANSWER), { found, tail: text.slice(-600) });

  // #304：失败那步写人话原因；只查失败尾巴，不查详情展开区（详情给模型看的原文留着）。
  const failedNote = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .act-failed")].map(n => n.textContent).join(" | ")`));
  check("d 失败步骤写人话原因，不带选择子", /没找到目标/.test(failedNote) && /页面不存在（404）/.test(failedNote) && !failedNote.includes("#gone"), { failedNote });
  const notes = failedNote ? failedNote.split(" | ") : [];
  const steps = String(await rp.evaluate(panel, `[...document.querySelectorAll("#messages .chip-label")].map(n => n.textContent).join(" | ")`));
  // 直调 fetch 和 browser_run 里的 fetch 各一处 404。
  check("e browser_run 里失败的 fetch 写人话原因", hits.includes("/gone-api") && notes.filter(n => n.includes("页面不存在（404）")).length === 2, { hits: [...hits], notes, steps });
  // 失败只有点击、直调 404、没人听的端口、程序里 404 四处；204 或 302 被当成失败就会多出来。
  check("f 204 空回执和 302 跳转不算失败", hits.includes("/empty") && hits.includes("POST /moved") && notes.length === 4, { hits: [...hits], notes, steps });
  check("g 连不上的地址写「连不上这个地址」", notes.filter(n => n.includes("连不上这个地址")).length === 1 && !notes.some(n => /结果未知|已取消/.test(n)), { notes });
  // 这一轮的过程行：回执标题和状态图标。
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
