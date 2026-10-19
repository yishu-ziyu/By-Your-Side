/**
 * 行内计时：秒数贴在动词后面，没有扫光，长步骤只报已过多久（方向 A）。
 *   npx tsx scripts/acceptance/real-path/wait-inline-timer.mts --headless
 * 脚本模型：空会话 → 首字前挂 16 秒 → 回答；新会话里一步之后再想 5 秒；先送思考摘要、19 秒后才出正文；
 * 核对判「没做完」后接着做的那一轮挂 20 秒；再一问一直回 500。
 *   a) 空会话看得到起点建议，没有过程行。
 *   b) 首字前 3 秒：第一行是「正在思考」加「N 秒」，没有「已等」、没有间隔点、标题不扫光、没有百分号。
 *   c) 满 15 秒没回音：标题改成「还没有回音」，秒数继续数，仍不扫光、不写百分号。
 *   d) 一步之后的长思考：只报这段秒数，不写百分号，标题不是「还没有回音」。
 *   e) 模型出错时错误卡看得到。
 *   f) 思考摘要已经流进来、16 秒还没出正文：标题仍是「正在思考」，不换成「还没有回音」。
 *   g) 核对后接着做、16 秒还没回音：标题仍是「还没做完，接着做」，不被「还没有回音」盖掉。
 * 失败方式：仍写「已等」、标题还在扫光、超时标题不变、长步骤出现 %、空会话或错误卡没了、思考或重试时标题被换掉。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-wait-inline-timer`);
await mkdir(out, { recursive: true });

const PAGE = `<!doctype html><html lang="zh"><meta charset="utf-8"><title>作品页</title><body><main><h1>作品</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((_req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK_WAIT = "行内计时：等回音。";
const ASK_STEP = "行内计时：点作品。";
const ASK_ERROR = "行内计时：出错。";
const ASK_THINK = "行内计时：先想想。";
const ASK_CONT = "行内计时：接着做。";
const ANSWER_WAIT = "回音到了。";
const ANSWER_STEP = "已经点开作品。";
const ANSWER_THINK = "想好了。";
const port = siteAddress(site).port;
// 规则按数组顺序匹配：接着做的提示里也带着任务原话，所以 [GOAL CHECK] 放在最前。
const model = await startScriptedModel([
  { match: "[GOAL CHECK]", steps: [{ text: "补上了。", delayMs: 20_000 }] },
  { match: "GOAL-CHECK-CONTINUE", steps: [{ text: JSON.stringify({ status: "continue", remaining: "再点一次作品", correction: "" }) }] },
  { match: "GOAL-CHECK-DONE", steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK_WAIT, steps: [{ text: ANSWER_WAIT, delayMs: 60_000 }] },
  { match: ASK_STEP, steps: [
    { tool: { name: "click", args: { target: "#ok", label: "作品" } } },
    { text: ANSWER_STEP, delayMs: 5_000 },
  ] },
  { match: ASK_ERROR, steps: [{ status: 500, body: '{"error":{"message":"fixture upstream failure"}}' }] },
  { match: ASK_THINK, steps: [{ text: ANSWER_THINK, reasoning: "先看看这一页有什么，再决定怎么回。", pieces: [{ text: ANSWER_THINK, delayMs: 19_000 }] }] },
  { match: ASK_CONT, steps: [{ tool: { name: "click", args: { target: "#ok", label: "作品" } } }, { text: "点了作品。" }] },
]);

// 目标核对经这里改写成脚本结论：只有 ASK_CONT 的第一次核对判「没做完」，其余都判做完。
const GOAL_CHECK_PREFIX = "You check whether a browser assistant has finished the user's goal";
let continued = false;
const modelOrigin = new URL(model.baseUrl).origin;
const relay = createServer(async (req, res) => {
  try {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    let body = Buffer.concat(parts).toString("utf8");
    if (req.method === "POST" && body.includes(GOAL_CHECK_PREFIX)) {
      const verdict = !continued && body.includes(ASK_CONT) ? "GOAL-CHECK-CONTINUE" : "GOAL-CHECK-DONE";
      if (verdict === "GOAL-CHECK-CONTINUE") continued = true;
      // SAFETY: OpenAI 兼容请求体；只换 messages，保留 stream 等其余字段。
      body = JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), messages: [{ role: "user", content: verdict }] });
    }
    const up = await fetch(new URL(req.url ?? "/", modelOrigin), { method: req.method, headers: { "content-type": req.headers["content-type"] ?? "application/json" }, body: req.method === "GET" ? undefined : body });
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") ?? "application/json" });
    if (up.body) for await (const part of up.body) res.write(part);
    res.end();
  } catch { res.destroy(); }
});
await new Promise<void>((done) => relay.listen(0, "127.0.0.1", done));
const relayBase = `http://127.0.0.1:${siteAddress(relay).port}${new URL(model.baseUrl).pathname}`;

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const READ = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  const title = d?.querySelector(".run-title");
  const time = d?.querySelector(".run-time");
  const ts = title ? getComputedStyle(title) : null;
  const before = time ? getComputedStyle(time, "::before").content : "";
  const starter = document.querySelector("#starter");
  const error = document.querySelector(".error-card");
  const thinking = !!d?.querySelector("details.thinking");
  return {
    starter: !!starter && starter.getClientRects().length > 0,
    error: !!error && error.getClientRects().length > 0,
    title: title?.textContent ?? "",
    time: time?.textContent ?? "",
    before,
    shine: ts?.animationName ?? "",
    thinking,
    all: document.querySelector("#messages")?.textContent ?? "",
  };
})()`;

type Read = { starter: boolean; error: boolean; title: string; time: string; before: string; shine: string; thinking: boolean; all: string };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: relayBase }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#app")?.classList.contains("starter-ready") && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);

  const read = async () => (await rp.evaluate(panel, READ)) as Read;
  const empty = await read();
  await rp.screenshot(panel, join(out, "empty.png"));
  check("a 空会话看得到起点建议，没有过程行", empty.starter && !empty.title, { starter: empty.starter, title: empty.title });

  const send = async (ask: string) => {
    await rp.click(panel, "#input");
    await rp.typeText(panel, ask);
    await rp.pressEnter(panel);
  };

  const liveOk = (r: Read) => {
    const secs = Number(/^(\d+) 秒$/.exec(r.time)?.[1] ?? NaN);
    const noDot = r.before === "none" || r.before === "normal" || r.before === '""' || r.before === "";
    const noShine = r.shine === "none" || r.shine === "" || !r.shine.includes("runShine");
    return { secs, noDot, noShine, noWaitWord: !r.time.includes("已等") && !r.all.includes("已等"), noPct: !r.title.includes("%") && !r.time.includes("%") && !/%/.test(r.all) };
  };

  await send(ASK_WAIT);
  // 等的是时刻，不是措辞：改前的写法也要能截到同一时刻，由下面的判定决定过不过。
  const shownSecs = (r: Read) => Number(/(\d+) 秒/.exec(r.time)?.[1] ?? 0);
  await until(async () => shownSecs(await read()) >= 3 ? true : undefined, 8_000, "首字前数到 3 秒", 100);
  const waiting = await read();
  await rp.screenshot(panel, join(out, "waiting.png"));
  const waitLive = liveOk(waiting);
  check("b 首字前是「正在思考 N 秒」，没有已等、间隔点和扫光", waiting.title === "正在思考" && waitLive.secs >= 3 && waitLive.noWaitWord && waitLive.noDot && waitLive.noShine && waitLive.noPct, { title: waiting.title, time: waiting.time, before: waiting.before, shine: waiting.shine, secs: waitLive.secs });

  await until(async () => { const r = await read(); return r.title === "还没有回音" || shownSecs(r) >= 16 ? true : undefined; }, 18_000, "首字前等满 15 秒", 100);
  const stale = await read();
  await rp.screenshot(panel, join(out, "timeout.png"));
  const staleLive = liveOk(stale);
  check("c 满 15 秒标题改成「还没有回音」，秒数继续数", stale.title === "还没有回音" && staleLive.secs >= 15 && staleLive.noWaitWord && staleLive.noDot && staleLive.noShine && staleLive.noPct, { title: stale.title, time: stale.time, shine: stale.shine, secs: staleLive.secs });

  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#input")?.value === "" && document.querySelector("#send-btn")?.disabled===false'), 15_000, "新会话");
  await send(ASK_STEP);
  await until(async () => model.requests.filter((q) => q.rule === ASK_STEP).length >= 2 ? true : undefined, 30_000, "点作品之后开始想", 50);
  const thinkingSince = Date.now();
  await sleep(3_200);
  const step = await read();
  const elapsed = (Date.now() - thinkingSince) / 1000;
  await rp.screenshot(panel, join(out, "long-step.png"));
  const stepLive = liveOk(step);
  // 秒数每秒刷新、对齐这段的整秒，所以只会比真实少不到 1 秒；按发送算的整轮读数会多出前一步的时间。
  check("d 长步骤只报这段已过多久，不写百分号，不是超时文案", step.title.startsWith("正在") && step.title !== "还没有回音" && stepLive.secs >= 3 && Math.abs(stepLive.secs - elapsed) <= 1 && stepLive.noWaitWord && stepLive.noShine && stepLive.noPct, { title: step.title, time: step.time, elapsed, shine: step.shine });

  await until(async () => { const r = await read(); return r.all.includes(ANSWER_STEP) ? true : undefined; }, 20_000, "长步骤回答", 100);
  const fresh = async (label: string) => {
    await rp.click(panel, "#conversation-new");
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#input")?.value === "" && document.querySelector("#send-btn")?.disabled===false'), 15_000, label);
  };

  await fresh("思考用的新会话");
  await send(ASK_THINK);
  await until(async () => (await read()).thinking ? true : undefined, 10_000, "思考摘要流进来", 100);
  await until(async () => shownSecs(await read()) >= 16 ? true : undefined, 20_000, "思考时等满 16 秒", 100);
  const thinkingLong = await read();
  await rp.screenshot(panel, join(out, "thinking-long.png"));
  const spine = await rp.evaluate(panel, '(()=>{const t=[...document.querySelectorAll("#messages details.thinking")].at(-1);return t?getComputedStyle(t,"::before").content:null})()');
  check("f 思考块左侧没有竖线", spine === "none", spine);
  check("f 思考摘要在流、16 秒没出正文：标题仍是「正在思考」", thinkingLong.title === "正在思考" && thinkingLong.thinking && !thinkingLong.all.includes(ANSWER_THINK), { title: thinkingLong.title, time: thinkingLong.time, thinking: thinkingLong.thinking });
  await until(async () => (await read()).all.includes(ANSWER_THINK) ? true : undefined, 15_000, "思考之后的回答", 100);

  await fresh("接着做用的新会话");
  await send(ASK_CONT);
  await until(async () => /接着做|还在做第/.test((await read()).title) ? true : undefined, 30_000, "核对后接着做", 100);
  await sleep(16_000);
  const continuing = await read();
  await rp.screenshot(panel, join(out, "continue-long.png"));
  check("g 接着做的一轮过了 15 秒，标题仍是接着做那句", continued && /接着做|还在做第/.test(continuing.title), { title: continuing.title, time: continuing.time, continued });

  await fresh("再开新会话");
  await send(ASK_ERROR);
  await until(async () => (await read()).error ? true : undefined, 30_000, "错误卡出现");
  const failed = await read();
  await rp.screenshot(panel, join(out, "error.png"));
  check("e 模型出错时错误卡看得到", failed.error, { error: failed.error, all: failed.all.slice(0, 200) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); relay.closeAllConnections(); await new Promise<void>((done) => relay.close(() => done())); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
