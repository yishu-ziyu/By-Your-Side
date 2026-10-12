/**
 * 思考心跳：进行中两行不变，思考时多一个 0.9s 转圈，扫光仍是 2.4s（#263）。
 *   npx tsx scripts/acceptance/real-path/thinking-heartbeat.mts --headless
 * 脚本模型：想 4 秒 → 打开页 B → 点不存在的按钮 → 想 8 秒 → 点「作品」→ 回答。
 *   a) 想的时候第一行仍是「正在思考」，秒数从这段开始数（差 ≤1.2 秒），第二行仍是「已做 2 步 · 1 步换了做法」。
 *   b) `.run-beat` 可见，animation-duration 0.9±0.05s；450ms 后 transform 变了（转了约半圈）。
 *   c) 标题扫光仍是 2.4±0.05s。
 *   d) 回执仍是一行「做了 3 步：… · 1 步换了做法」；收尾后转圈不再显示。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-thinking-heartbeat`);
await mkdir(out, { recursive: true });

const PAGE_A = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page A</title><body><main><p>Start here.</p></main></body></html>`;
const PAGE_B = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Page B</title><body><main><h1>Works</h1><button id="ok">作品</button></main></body></html>`;
const site = createServer((req, res) => res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(req.url === "/b" ? PAGE_B : PAGE_A));
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：打开作品页，点作品。";
const ANSWER = "已经点开作品。";
const port = siteAddress(site).port;
const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tool: { name: "navigate", args: { url: `http://127.0.0.1:${port}/b` } }, delayMs: 4_000 },
    { tool: { name: "js", args: { code: "(() => document.title)()", purpose: "读出标题", readonly: true } } },
    { tool: { name: "click", args: { target: "#gone", label: "不存在的按钮" } } },
    { tool: { name: "click", args: { target: "#ok", label: "作品" } }, delayMs: 8_000 },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const READ = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  if (!d) return null;
  const beat = d.querySelector(".run-beat");
  const title = d.querySelector(".run-title");
  const cs = beat ? getComputedStyle(beat) : null;
  const ts = title ? getComputedStyle(title) : null;
  const seconds = (text) => {
    const first = String(text ?? "").split(",")[0].trim();
    const n = parseFloat(first);
    if (!Number.isFinite(n)) return null;
    return /ms$/i.test(first) ? n / 1000 : n;
  };
  return {
    done: d.classList.contains("done"),
    title: title?.textContent ?? "",
    time: d.querySelector(".run-time")?.textContent ?? "",
    meta: d.querySelector(".run-meta")?.hidden ? "" : d.querySelector(".run-meta")?.textContent ?? "",
    phase: d.dataset.phase ?? "",
    beatDisplay: cs?.display ?? "missing",
    beatDuration: seconds(cs?.animationDuration),
    beatDurationRaw: cs?.animationDuration ?? "",
    beatName: cs?.animationName ?? "",
    beatTransform: cs?.transform ?? "",
    shineDuration: seconds(ts?.animationDuration),
    shineDurationRaw: ts?.animationDuration ?? "",
    shineName: ts?.animationName ?? "",
    all: document.querySelector("#messages")?.textContent ?? "",
  };
})()`;

type Read = {
  done: boolean; title: string; time: string; meta: string; phase: string;
  beatDisplay: string; beatDuration: number; beatDurationRaw: string; beatName: string; beatTransform: string;
  shineDuration: number; shineDurationRaw: string; shineName: string; all: string;
};

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/a` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  const items = { inproc_model_config: { provider: "custom", modelId: "fixture", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-fixture" } };
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(items)}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#conversation-new")?.disabled===false && document.querySelector("#send-btn")?.disabled===false'), 60_000, "侧栏就绪");
  await rp.cdp.send("Emulation.setDeviceMetricsOverride", { width: 380, height: 760, deviceScaleFactor: 2, mobile: false }, panel);
  await rp.cdp.send("Page.bringToFront", {}, work);
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);

  const read = async () => (await rp.evaluate(panel, READ)) as Read | null;
  await until(async () => model.requests.filter((q) => q.rule === ASK).length >= 4 ? true : undefined, 60_000, "第 3 步结束", 50);
  const thinkingSince = Date.now();
  await sleep(2_000);
  const first = await read();
  await sleep(450);
  const second = await read();
  const elapsed = (Date.now() - thinkingSince) / 1000;
  const liveSecs = Number(/^(\d+) 秒$/.exec(second?.time ?? "")?.[1] ?? NaN);
  await rp.screenshot(panel, join(out, "thinking.png"));
  check("a 想的时候两行仍是「正在思考」和步数，秒数从这段开始数", first?.title === "正在思考" && second?.title === "正在思考" && second.meta === "已做 2 步 · 1 步换了做法" && Math.abs(liveSecs - elapsed) <= 1.2, { title: second?.title ?? null, time: second?.time ?? null, elapsed, meta: second?.meta ?? null, phase: second?.phase ?? null });
  check("b 思考转圈 0.9 秒一圈，450ms 后转角变了", first != null && first.beatDisplay !== "none" && first.beatDisplay !== "missing" && Math.abs(first.beatDuration - 0.9) <= 0.05 && first.beatName.includes("runBeat") && first.beatTransform !== "none" && first.beatTransform !== second?.beatTransform, { beatDisplay: first?.beatDisplay, beatDuration: first?.beatDuration, beatDurationRaw: first?.beatDurationRaw, beatName: first?.beatName, t0: first?.beatTransform, t1: second?.beatTransform });
  check("c 标题扫光仍是 2.4 秒", first != null && Math.abs(first.shineDuration - 2.4) <= 0.05 && first.shineName.includes("runShine"), { shineDuration: first?.shineDuration, shineDurationRaw: first?.shineDurationRaw, shineName: first?.shineName });

  await until(async () => { const r = await read(); return r?.done && r.all.includes(ANSWER) ? true : undefined; }, 60_000, "收尾", 100);
  await sleep(400);
  const done = (await read())!;
  await rp.screenshot(panel, join(out, "receipt.png"));
  check("d 回执仍是一行短名链；转圈收掉", /^做了 3 步：打开 Page B → (读出标题|…) → 点作品 · 1 步换了做法$/.test(done.title) && done.beatDisplay === "none", { title: done.title, beatDisplay: done.beatDisplay, done: done.done });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
