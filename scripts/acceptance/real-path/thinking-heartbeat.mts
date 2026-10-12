/**
 * 思考心跳：进行中两行不变，思考时多一个 0.9s 转圈，扫光仍是 2.4s（#263）。
 *   npx tsx scripts/acceptance/real-path/thinking-heartbeat.mts --headless
 * 脚本模型：想 4 秒 → 打开页 B → 点不存在的按钮 → 想 8 秒 → 点「作品」→ 回答。
 *   a) 想的时候第一行是思考动词（默认 v3：想想怎么说 / 理一理 / 看看下一步），秒数从这段开始数，第二行仍是「已做 2 步 · 1 步换了做法」。
 *   b) `.run-beat` 四个墨点在呼吸；450ms 后点的 transform 变了。
 *   c) 标题扫光仍是 2.4±0.05s。
 *   d) 回执仍是一行「做了 3 步：… · 1 步换了做法」；收尾后墨点不再显示。
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
  const dot = beat?.querySelector("i");
  const cs = beat ? getComputedStyle(beat) : null;
  const ds = dot ? getComputedStyle(dot) : null;
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
    beatDots: beat?.querySelectorAll("i").length ?? 0,
    beatVariant: beat?.dataset.variant ?? "",
    beatDuration: seconds(ds?.animationDuration),
    beatDurationRaw: ds?.animationDuration ?? "",
    beatName: ds?.animationName ?? "",
    beatTransform: ds?.transform ?? "",
    shineDuration: seconds(ts?.animationDuration),
    shineDurationRaw: ts?.animationDuration ?? "",
    shineName: ts?.animationName ?? "",
    all: document.querySelector("#messages")?.textContent ?? "",
  };
})()`;

type Read = {
  done: boolean; title: string; time: string; meta: string; phase: string;
  beatDisplay: string; beatDots: number; beatVariant: string; beatDuration: number; beatDurationRaw: string; beatName: string; beatTransform: string;
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
  const think = (title: string) => title === "正在思考" || ["想想怎么说", "理一理", "看看下一步"].includes(title);
  check("a 想的时候两行仍是思考动词和步数，秒数从这段开始数", !!first && think(first.title) && think(second?.title ?? "") && second?.meta === "已做 2 步 · 1 步换了做法" && Math.abs(liveSecs - elapsed) <= 1.2, { title: second?.title ?? null, time: second?.time ?? null, elapsed, meta: second?.meta ?? null, phase: second?.phase ?? null });
  check("b 墨点在呼吸，450ms 后样子变了", first != null && first.beatDisplay !== "none" && first.beatDisplay !== "missing" && first.beatDots === 4 && /markBreathe/.test(first.beatName) && first.beatTransform !== "none" && first.beatTransform !== second?.beatTransform, { beatDisplay: first?.beatDisplay, beatDots: first?.beatDots, beatVariant: first?.beatVariant, beatName: first?.beatName, t0: first?.beatTransform, t1: second?.beatTransform });
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
