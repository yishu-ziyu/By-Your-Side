/**
 * 开工窗口：用户发出任务后、第一次请求模型之前（替模型读当前页、站点笔记、记忆），这段时间算不算“在做”。
 * 只装扩展、隔离构建、本机脚本模型、本机大页面（读一次页要 1.5 秒以上）。
 *   npx tsx scripts/acceptance/real-path/startup-window.mts --headless
 *   0) 基线：只发一条，量「按回车 → 模型收到第一条主请求」的时间，证明窗口够宽。
 *   A) 开工窗口里补一句：发「把这页的标题列出来」，约 300 ms 后（模型还没收到请求）再发「改成只列前三个」。
 *      通过 = 只开了一轮（侧栏一个最终回答、只有一条没有前文回答的开头请求），且这一轮的请求里有「改成只列前三个」。
 *   B) 开工窗口里按停止：发任务，约 300 ms 后按停止。通过 = 停止后 10 秒内模型收到 0 条主请求，侧栏写这一轮已中止并回到空闲。
 *   C) 开工窗口里按停止，1 秒内发新任务。通过 = 新任务开跑、模型请求里有新任务原话，侧栏从没出现「已转为插话」。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-startup-window`);

await mkdir(out, { recursive: true });

const ROWS = Number(process.argv.find(a => a.startsWith("--rows="))?.slice(7) ?? 2500);

const PAGE = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>大页面练习页</title><body style="font:14px sans-serif;margin:20px">
<h1>商品清单（大页面）</h1>
${Array.from({ length: ROWS }, (_, i) => `<section class="item"><h2>标题 ${i + 1}：第 ${i + 1} 号商品</h2><div><span>价格 ${(i * 7) % 997} 元</span> <a href="#i${i}">详情</a> <button type="button">加入购物车</button><ul><li>规格 A${i}</li><li>规格 B${i}</li></ul></div></section>`).join("\n")}
</body></html>`;

const site = createServer((_, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE); });

await new Promise<void>(done => site.listen(0, "127.0.0.1", done));

const ASK = { base: "基线：把这页的标题列出来", a: "把这页的标题列出来", fix: "改成只列前三个", b: "停止用例：把这页的价格列出来", c1: "停后新任务一：把这页的按钮数一下", c2: "停后新任务二：把这页的链接列出来" };

const DONE = JSON.stringify({ status: "done", remaining: "", correction: "" });

type ContentPart = { text?: string };

type Msg = { role: string; content?: string | ContentPart[] | null };

const textOf = (m: Msg) => typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map(p => p.text ?? "").join("") : "";

/** 主任务请求（带工具表）：收到的本机时间、最后一条用户消息的开头和长度、全部消息里有没有两句原话。 */
type Main = { at: number; lastUser: string; lastUserChars: number; assistants: number; hasAsk: boolean; hasFix: boolean; hasPage: boolean; hasC2: boolean };

const mains: Main[] = [];

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: DONE }] },
  { match: ASK.fix, steps: [{ text: "前三个标题：标题 1、标题 2、标题 3。" }] },
  { match: ASK.a, steps: [{ text: "标题如下：标题 1、标题 2……" }] },
  { match: ASK.b, steps: [{ text: "价格如下。" }] },
  { match: ASK.c1, steps: [{ text: "按钮数好了。" }] },
  { match: ASK.c2, steps: [{ text: "链接已列出。" }] },
], undefined, payload => {
  if (!payload.tools?.length) return;
  // SAFETY: OpenAI 兼容请求体，messages 为消息数组。
  const messages = (payload.messages ?? []) as Msg[];
  const user = messages.filter(m => m.role === "user").at(-1);
  const all = messages.map(textOf).join("\n");
  mains.push({ at: Date.now(), lastUser: user ? textOf(user).slice(0, 60) : "", lastUserChars: user ? textOf(user).length : 0, assistants: messages.filter(m => m.role === "assistant").length, hasAsk: all.includes(ASK.a), hasFix: all.includes(ASK.fix), hasPage: all.includes("第 1 号商品"), hasC2: all.includes(ASK.c2) });
});

const rp = await launchRealPath();

const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];

const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const facts: Record<string, Json> = {};

try {
  const work = await rp.attach((await rp.targets()).find(t => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${siteAddress(site).port}/` }, work);
  await until(async () => await rp.evaluate(work, `document.querySelectorAll("section.item").length === ${ROWS}`), 20_000, "大页面加载");
  facts.pageNodes = await rp.evaluate(work, "document.querySelectorAll('*').length") as number;
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Page.bringToFront", {}, work);

  const ask = async (text: string) => { await rp.click(panel, "#input"); await rp.typeText(panel, text); const at = Date.now(); await rp.pressEnter(panel); return at; };

  const stopping = async () => await rp.evaluate(panel, 'document.querySelector("#send-btn").classList.contains("stopping")') as boolean;

  const idle = async (ms = 30_000) => { await until(async () => !(await stopping()), ms, "侧栏回到空闲", 50); await sleep(1500); };

  const fresh = async () => { await idle(); await rp.click(panel, "#conversation-new"); await until(async () => await rp.evaluate(panel, '!document.querySelector(".msg.user")'), 10_000, "新对话"); await sleep(500); };

  const view = async () => await rp.evaluate(panel, `({ runs: document.querySelectorAll(".answer-actions").length, users: [...document.querySelectorAll(".msg.user")].map(u => u.textContent.trim().slice(0, 40)), assistants: [...document.querySelectorAll(".msg.assistant")].map(a => a.textContent.trim().slice(0, 60)), text: document.querySelector("#messages").textContent.replace(/\\s+/g, " ").slice(-400) })`) as { runs: number; users: string[]; assistants: string[]; text: string };

  // ── 0：基线，量开工窗口有多宽 ──
  await fresh();
  let from = mains.length;
  const baseAt = await ask(ASK.base);
  await until(async () => mains.length > from, 30_000, "基线第一条主请求", 20);
  facts.baselineSendToFirstRequestMs = mains[from]!.at - baseAt;
  facts.baselineRequestHasPage = mains[from]!.hasPage;
  console.log(`基线：按回车到模型收到第一条主请求 ${String(facts.baselineSendToFirstRequestMs)} ms（请求里有页面内容：${String(facts.baselineRequestHasPage)}）`);
  check("0 开工窗口 ≥1.5 秒（按回车 → 第一条主请求）", Number(facts.baselineSendToFirstRequestMs) >= 1500, facts.baselineSendToFirstRequestMs as number);

  // ── A：开工窗口里补一句 ──
  await fresh();
  from = mains.length;
  const aAt = await ask(ASK.a);
  await sleep(300);
  const fixTypedBeforeRequest = mains.length === from;
  const fixAt = await ask(ASK.fix);
  const fixBeforeRequest = mains.length === from;
  await until(async () => mains.length > from, 30_000, "A 第一条主请求", 20);
  await sleep(1000);
  await idle();
  const mainsA = mains.slice(from);
  const viewA = await view();
  // 新对话里，开头请求的历史里还没有助手回答；补的一句若另开一轮，会再出一个最终回答。
  const starts = mainsA.filter(m => m.assistants === 0);
  facts.A = { fixSentAfterAskMs: fixAt - aAt, firstRequestAfterAskMs: mainsA[0] ? mainsA[0].at - aAt : null, fixSentBeforeFirstRequest: fixTypedBeforeRequest && fixBeforeRequest, mainRequests: mainsA, runStarts: starts.length, panel: viewA };
  check("A 开工窗口里补的一句发生在模型收到请求之前", fixTypedBeforeRequest && fixBeforeRequest, { fixSentAfterAskMs: fixAt - aAt, firstRequestAfterAskMs: mainsA[0] ? mainsA[0].at - aAt : null });
  check("A 只开一轮，且这一轮的请求里有「改成只列前三个」", viewA.runs === 1 && starts.length === 1 && mainsA.some(m => m.hasAsk && m.hasFix), { panelRuns: viewA.runs, runStarts: starts.length, mainRequests: mainsA.length, correctionReachedModel: mainsA.some(m => m.hasFix), sameRequestHasBoth: mainsA.some(m => m.hasAsk && m.hasFix), users: viewA.users });
  await rp.screenshot(panel, join(out, "a-panel.png"));

  // ── B：开工窗口里按停止 ──
  await fresh();
  from = mains.length;
  const bAt = await ask(ASK.b);
  await sleep(300);
  const stopVisible = await stopping();
  const beforeStop = mains.length - from;
  const stopAt = Date.now();
  await rp.click(panel, "#send-btn");
  await sleep(10_000);
  const mainsB = mains.slice(from);
  const viewB = await view();
  const stoppedShown = /已中止|你中止了|已停止/.test(viewB.text);
  const stillRunning = await stopping();
  facts.B = { stopAfterAskMs: stopAt - bAt, stopButtonShown: stopVisible, requestsBeforeStop: beforeStop, requestsWithin10sAfterStop: mainsB.filter(m => m.at >= stopAt).map(m => ({ afterStopMs: m.at - stopAt, lastUser: m.lastUser })), panel: viewB, stoppedShown, stillRunning };
  check("B 按停止时模型还没收到请求（停在开工窗口里）", beforeStop === 0 && stopVisible, { requestsBeforeStop: beforeStop, stopButtonShown: stopVisible, stopAfterAskMs: stopAt - bAt });
  check("B 停止后 10 秒内模型收到 0 条主请求，侧栏写已中止并回到空闲", mainsB.filter(m => m.at >= stopAt).length === 0 && stoppedShown && !stillRunning, { afterStop: mainsB.filter(m => m.at >= stopAt).map(m => m.at - stopAt), stoppedShown, stillRunning, panelTail: viewB.text.slice(-160) });
  await rp.screenshot(panel, join(out, "b-panel.png"));

  // ── C：开工窗口里按停止，马上发新任务 ──
  await fresh();
  from = mains.length;
  const cAt = await ask(ASK.c1);
  await sleep(300);
  const cBeforeStop = mains.length - from;
  const cStopAt = Date.now();
  await rp.click(panel, "#send-btn");
  await sleep(500);
  const c2At = await ask(ASK.c2);
  let steerNotice = false;
  const answeredC = await until(async () => {
    steerNotice ||= await rp.evaluate(panel, 'document.body.textContent.includes("已转为插话")') as boolean;

    return await rp.evaluate(panel, '[...document.querySelectorAll(".msg.assistant")].some(m => m.textContent.includes("链接已列出"))') as boolean;
  }, 30_000, "C 新任务的回答", 100).then(() => true, () => false);
  await idle().catch(() => {});
  const mainsC = mains.slice(from);
  const viewC = await view();
  steerNotice ||= viewC.text.includes("已转为插话");
  facts.C = { stopAfterAskMs: cStopAt - cAt, newTaskAfterStopMs: c2At - cStopAt, requestsBeforeStop: cBeforeStop, mainRequests: mainsC.map(m => ({ afterNewTaskMs: m.at - c2At, lastUser: m.lastUser, hasC2: m.hasC2 })), answeredC, steerNotice, panel: viewC };
  check("C 开工中停下后 1 秒内发新任务：新任务开跑、请求里有新任务原话、没有「已转为插话」", cBeforeStop === 0 && c2At - cStopAt < 1000 && mainsC.some(m => m.hasC2) && answeredC && !steerNotice, { requestsBeforeStop: cBeforeStop, newTaskAfterStopMs: c2At - cStopAt, newTaskReachedModel: mainsC.some(m => m.hasC2), answeredC, steerNotice, panelTail: viewC.text.slice(-200) });
  await rp.screenshot(panel, join(out, "c-panel.png"));
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ checks, facts, mains, modelRequests: model.requests, notCovered: ["真实模型", "真实网站", "站点笔记和记忆有内容时的开工时长"] }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>(done => site.close(() => done()));
}

console.log(`证据：${out}`);

if (checks.some(c => !c.pass)) process.exitCode = 1;
