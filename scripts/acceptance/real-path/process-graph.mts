/**
 * 过程块 B1 + B3：并行标签页扇形、并行抓取竖向分支、死路原因、折叠时序（#263）。
 *   npx tsx scripts/acceptance/real-path/process-graph.mts --headless
 * 脚本模型：同时开 4 页 → 同时跑 5 路 js（2 路抛人话失败）→ 再抓一次许可证 → 回答。
 *   a) 先出现 B3 扇形 4 格，后出现 B1 竖向 ≥5 路；单步回合并不画分叉（见 process-block）。
 *   b) 5 路长出：第 1 路与第 5 路 animation-delay 差 280±40ms；分叉 450±50ms。
 *   c) 两条死路带人话原因，不出现「出错」。
 *   d) 各组汇合后 1.25±0.2 秒内收起，收起后对话里不留分叉行；过程块高度 ≤176px。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, type Json } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const out = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-process-graph`);
await mkdir(out, { recursive: true });

const page = (title: string) => `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><body><main><h1>${title}</h1></main></body></html>`;
const site = createServer((req, res) => {
  const name = req.url === "/p2" ? "Tab B" : req.url === "/p3" ? "Tab C" : req.url === "/p4" ? "Tab D" : "Tab A";
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(name));
});
await new Promise<void>((done) => site.listen(0, "127.0.0.1", done));

const ASK = "案例：每个去查一下是否开源";
const ANSWER = "查过了，三个开源，两个接口没回。";
const port = siteAddress(site).port;
const tab = (path: string) => ({ name: "tabs", args: { action: "open", url: `http://127.0.0.1:${port}${path}` } });
const grab = (purpose: string, fail?: string) => ({
  name: "js",
  args: {
    purpose,
    readonly: true,
    code: fail
      ? `(() => new Promise((_, reject) => setTimeout(() => reject(new Error(${JSON.stringify(fail)})), 500)))()`
      : "(() => new Promise((resolve) => setTimeout(() => resolve('GPL-3.0'), 800)))()",
  },
});

const model = await startScriptedModel([
  { match: '"goalPage"', steps: [{ text: JSON.stringify({ status: "done", remaining: "", correction: "" }) }] },
  { match: ASK, steps: [
    { tools: [tab("/p1"), tab("/p2"), tab("/p3"), tab("/p4")], delayMs: 400 },
    { text: "_" }, { text: "_" }, { text: "_" },
    { tools: [
      grab("抓取 api.github.com"),
      grab("抓取 gitlab.com"),
      grab("抓取 codeberg.org"),
      grab("抓取 huggingface.co", "接口没回（HTTP 0）"),
      grab("抓取 npmjs.com", "连不上这个地址"),
    ], delayMs: 400 },
    { text: "_" }, { text: "_" }, { text: "_" }, { text: "_" },
    { tool: grab("重试许可证"), delayMs: 300 },
    { text: ANSWER },
  ] },
]);

const rp = await launchRealPath();
const checks: Array<{ name: string; pass: boolean; actual: Json }> = [];
const check = (name: string, pass: boolean, actual: Json) => { checks.push({ name, pass, actual }); console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(actual)); };

const READ = `(() => {
  const d = [...document.querySelectorAll("#messages details.run-steps")].at(-1);
  if (!d) return null;
  // 分叉层紧跟在过程块后面（不放进收起的 details 里）。
  const graph = d.nextElementSibling?.matches(".run-live-graph") ? d.nextElementSibling : null;
  const groups = [...(graph?.querySelectorAll(".run-graph-group") ?? [])].map((g) => {
    const rows = [...g.querySelectorAll(".run-graph-row, .run-tab-tile")];
    const delays = rows.map((row) => parseFloat(getComputedStyle(row).animationDelay) || 0);
    return {
      kind: g.dataset.kind ?? "",
      state: g.dataset.state ?? "",
      lanes: rows.length,
      forkMs: Number(g.dataset.forkMs ?? NaN),
      foldHold: Number(g.dataset.foldHoldMs ?? NaN),
      foldMs: Number(g.dataset.foldMs ?? NaN),
      delayMin: Math.min(...delays, 0),
      delayMax: Math.max(...delays, 0),
      dead: [...g.querySelectorAll("[data-state=dead]")].map((row) => row.textContent?.replace(/\\s+/g, " ").trim() ?? ""),
      fold: g.querySelector(".run-graph-fold")?.textContent ?? "",
    };
  });
  const top = d.getBoundingClientRect().top;
  const bottom = (graph && !graph.hidden ? graph : d).getBoundingClientRect().bottom;
  return {
    title: d.querySelector(".run-title")?.textContent ?? "",
    height: Math.round(bottom - top),
    graphShown: !!graph && graph.getClientRects().length > 0,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    text: document.querySelector("#messages")?.textContent ?? "",
    groups,
  };
})()`;

type Read = { title: string; height: number; graphShown: boolean; overflowX: boolean; text: string; groups: Array<{ kind: string; state: string; lanes: number; forkMs: number; foldHold: number; foldMs: number; delayMin: number; delayMax: number; dead: string[]; fold: string }> };

try {
  const work = await rp.attach((await rp.targets()).find((t) => t.url === "about:blank")!.targetId);
  await rp.cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/p1` }, work);
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
  const b3 = await until(async () => { const r = await read(); return r?.groups.some((g) => g.kind === "b3" && g.lanes >= 4) ? r : undefined; }, 30_000, "B3 扇形", 50);
  await rp.screenshot(panel, join(out, "b3.png"));
  const b1 = await until(async () => { const r = await read(); return r?.groups.some((g) => g.kind === "b1" && g.lanes >= 5) ? r : undefined; }, 30_000, "B1 竖向", 50);
  await rp.screenshot(panel, join(out, "b1.png"));
  const fan = b3.groups.find((g) => g.kind === "b3")!;
  const vert = b1.groups.find((g) => g.kind === "b1" && g.lanes >= 5)!;
  check("a 先 B3 四页、后 B1 五路", fan.lanes >= 4 && vert.lanes >= 5 && b3.height <= 176, { b3: fan, b1: { kind: vert.kind, lanes: vert.lanes }, height: b3.height });
  check("b 五路错开 280±40ms，分叉 450±50ms", Math.abs((vert.delayMax - vert.delayMin) * 1000 - 280) <= 40 && Math.abs(vert.forkMs - 450) <= 50, { delayMin: vert.delayMin, delayMax: vert.delayMax, forkMs: vert.forkMs });

  await until(async () => { const r = await read(); return r?.text.includes(ANSWER) ? r : undefined; }, 60_000, "回答", 100);
  await sleep(1_400);
  const done = (await read())!;
  await rp.screenshot(panel, join(out, "folded.png"));
  const dead = done.groups.flatMap((g) => g.dead).join(" ");
  check("c 死路带人话原因，不写出错", /接口没回|连不上/.test(dead) && !done.text.includes("出错"), { dead: done.groups.flatMap((g) => g.dead), fold: done.groups.map((g) => g.fold) });
  check("d 收起后不留分叉行，高度不超过 176", done.groups.some((g) => g.kind === "b1" || g.kind === "b3") && done.groups.filter((g) => g.kind === "b1" || g.kind === "b3").every((g) => g.state === "folded") && !done.graphShown && done.height <= 176 && !done.overflowX, { states: done.groups.map((g) => `${g.kind}:${g.state}`), graphShown: done.graphShown, height: done.height, overflowX: done.overflowX });
} catch (error) { check("流程完成", false, String(error)); } finally {
  await writeFile(join(out, "result.json"), JSON.stringify({ status: checks.every((c) => c.pass) ? "PASS" : "FAIL", checks, modelRequests: model.requests }, null, 2));
  await rp.close(); await rp.remove(); await model.close(); await new Promise<void>((done) => site.close(() => done()));
}

console.log(`证据：${out}`);
if (checks.some((c) => !c.pass)) process.exitCode = 1;
