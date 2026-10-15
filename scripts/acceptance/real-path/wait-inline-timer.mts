/**
 * 行内计时：秒数贴在动词后面，没有扫光，长步骤只报已过多久（方向 A）。
 *   npx tsx scripts/acceptance/real-path/wait-inline-timer.mts --headless
 * 脚本模型：空会话 → 首字前挂 16 秒 → 回答；新会话里一步之后再想 5 秒；再一问回 500。
 *   a) 空会话看得到起点建议，没有过程行。
 *   b) 首字前 3 秒：第一行是「正在思考」加「N 秒」，没有「已等」、没有间隔点、标题不扫光、没有百分号。
 *   c) 满 15 秒没回音：标题改成「还没有回音」，秒数继续数，仍不扫光、不写百分号。
 *   d) 一步之后的长思考：只报这段秒数，不写百分号，标题不是「还没有回音」。
 *   e) 模型出错时错误卡看得到。
 * 失败方式：仍写「已等」、标题还在扫光、超时标题不变、长步骤出现 %、空会话或错误卡没了。
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
const ANSWER_WAIT = "回音到了。";
const ANSWER_STEP = "已经点开作品。";
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK_WAIT, steps: [{ text: ANSWER_WAIT, delayMs: 60_000 }] },
  { match: ASK_STEP, steps: [
    { tool: { name: "click", args: { target: "#ok", label: "作品" } } },
    { text: ANSWER_STEP, delayMs: 5_000 },
  ] },
  { match: ASK_ERROR, steps: [{ status: 500, body: '{"error":{"message":"fixture upstream failure"}}' }] },
]);

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
  return {
    starter: !!starter && starter.getClientRects().length > 0,
    error: !!error && error.getClientRects().length > 0,
    title: title?.textContent ?? "",
    time: time?.textContent ?? "",
    before,
    shine: ts?.animationName ?? "",
    all: document.querySelector("#messages")?.textContent ?? "",
  };
})()`;

type Read = { starter: boolean; error: boolean; title: string; time: string; before: string; shine: string; all: string };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
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
  await rp.screenshot(panel, join(out, "long-step.png"));
  const stepLive = liveOk(step);
  const elapsed = (Date.now() - thinkingSince) / 1000;
  check("d 长步骤只报这段已过多久，不写百分号，不是超时文案", step.title.startsWith("正在") && step.title !== "还没有回音" && stepLive.secs >= 2 && Math.abs(stepLive.secs - elapsed) <= 1.5 && stepLive.noWaitWord && stepLive.noShine && stepLive.noPct, { title: step.title, time: step.time, elapsed, shine: step.shine });

  await until(async () => { const r = await read(); return r.all.includes(ANSWER_STEP) ? true : undefined; }, 20_000, "长步骤回答", 100);
  await rp.click(panel, "#conversation-new");
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#input")?.value === "" && document.querySelector("#send-btn")?.disabled===false'), 15_000, "再开新会话");
  await send(ASK_ERROR);
  await until(async () => (await read()).error ? true : undefined, 30_000, "错误卡出现");
  const failed = await read();
  await rp.screenshot(panel, join(out, "error.png"));
  check("e 模型出错时错误卡看得到", failed.error, { error: failed.error, all: failed.all.slice(0, 200) });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
