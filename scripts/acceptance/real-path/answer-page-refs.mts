/**
 * 回答里提到的按钮能在页面上指出来：只装扩展、隔离构建、本机脚本模型、本机练习页，真实点击。
 *   npx tsx scripts/acceptance/real-path/answer-page-refs.mts --headless [--record]
 *   1) 助手读页后回答「点右上角的「导出」按钮…」：读页时拿到过位置、现在还在页上的「导出」「筛选」带虚线；
 *      读页后被网页删掉的「分享」、页上从来没有的「打印」不带虚线。
 *   2) 点「导出」：网页上箭头飞到导出按钮、画出墨蓝圈；回答下出现灰字「已在页面上圈出 · 再点一次可由我来点」。
 *   3) 再点一次：发出一句「点「导出」」，和用户自己打字发出的一样。
 *   4) 页面刷新后再点「筛选」：不画圈，虚线收掉。
 * --record：录下 1–3 的侧栏和网页，左右并排成 page-refs.mp4，只给人看，不参与判定。
 * SIDEAGENT_ACCEPTANCE_DIST 指向旧版扩展时用来录改动前的样子，判定照常会失败。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-answer-page-refs`);

await mkdir(artifacts, { recursive: true });

const site = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>季度报表</title><style>
body{margin:0;font:15px/1.6 sans-serif;color:#333}header{display:flex;justify-content:space-between;align-items:center;padding:10px 20px;border-bottom:1px solid #e5e5e5}
header div{display:flex;gap:8px}button{font:inherit;padding:3px 12px;border:1px solid #ccc;border-radius:6px;background:#fafafa}
table{margin:20px;border-collapse:collapse;width:calc(100% - 40px)}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left}
</style></head><body><header><b>季度报表</b><div><button id="filter">筛选</button><button id="export">导出</button><button id="share">分享</button></div></header>
<table><tr><th>月份</th><th>收入</th><th>支出</th></tr><tr><td>7 月</td><td>12,400</td><td>8,100</td></tr><tr><td>8 月</td><td>13,050</td><td>8,420</td></tr><tr><td>9 月</td><td>14,210</td><td>9,030</td></tr></table></body></html>`);
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
const ASK = "这张表怎么下载";
const ANSWER = "点右上角的「导出」按钮，再选 CSV。要先缩小范围，就先点「筛选」。「分享」能把表发给同事。这页没有「打印」按钮。";
const model = await startScriptedModel([
  { match: ASK, steps: [{ tool: { name: "snapshot", args: {} } }, { text: ANSWER, delayMs: 1800 }] },
  { match: "点「导出」", steps: [{ tool: { name: "click", args: { target: "#export" } } }, { text: "点了「导出」，选 CSV 就能下载。" }] },
]);

const rp = await launchRealPath();
const evidence: Record<string, unknown> = {};
let error: string | null = null;

type DomNode = { nodeName: string; nodeValue?: string; attributes?: string[]; children?: DomNode[]; shadowRoots?: DomNode[] };

const walk = (n: DomNode, hit: (n: DomNode) => boolean): DomNode | undefined =>
  hit(n) ? n : [...(n.children ?? []), ...(n.shadowRoots ?? [])].map(c => walk(c, hit)).find(Boolean);

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "page loaded");
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ inproc_model_config: { provider: "custom", modelId: "demo-model", baseUrl: model.baseUrl }, "inproc_cred:custom": { type: "api_key", key: "local-demo-no-secret" } })}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  const inspectOnPage = async () => {
    const root = (await rp.cdp.send("DOM.getDocument", { depth: -1, pierce: true }, work)).root as DomNode;
    const attrs = (n: DomNode) => n.attributes?.join(" ") ?? "";

    return !!walk(root, n => n.nodeName === "DIV" && /\binspect\b/.test(attrs(n)) && /\bon\b/.test(attrs(n)) && !/\bout\b/.test(attrs(n)));
  };
  const underlined = () => rp.evaluate(panel, `[...(document.querySelector("#messages .msg.assistant")?.querySelectorAll(".page-ref") ?? [])].map(e => e.textContent)`) as Promise<string[]>;

  const record = process.argv.includes("--record");
  const stops = record ? [await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")), await recordScreen(rp.cdp, work, join(artifacts, "page.mp4"))] : [];
  await rp.click(panel, "#input");
  await rp.typeText(panel, ASK);
  await rp.pressEnter(panel);
  // 读页结果已经交给模型（第二次请求）之后、回答写出来之前，网页删掉「分享」。
  await until(async () => model.requests.filter(r => r.rule === ASK).length >= 2 || undefined, 30_000, "snapshot returned", 50);
  await rp.evaluate(work, `document.getElementById("share").remove(); true`);
  await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("这页没有")`) || undefined, 30_000, "answer", 100);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "settled", 100);
  await sleep(1200);
  const marks = await underlined();
  evidence.underlined = marks;
  await rp.screenshot(panel, join(artifacts, "1-underlined.png"));

  let pointed = false;
  let hint = "";
  if (marks.includes("导出")) {
    if (record) await sleep(1500);
    await rp.click(panel, `#messages .page-ref[data-name="导出"]`);
    pointed = !!await until(async () => await inspectOnPage() || undefined, 8_000, "ring on page", 100).catch(() => false);
    hint = await until(async () => (await rp.evaluate(panel, `document.querySelector("#messages .page-ref-hint")?.textContent ?? ""`) as string) || undefined, 5_000, "hint", 100).catch(() => "");
    await sleep(1600);
    await rp.screenshot(panel, join(artifacts, "2-pointed-panel.png"));
    await rp.screenshot(work, join(artifacts, "2-pointed-page.png"));
  } else if (record) {
    // 改动前：回答里没有可点的地方，用户只能自己在页面上找。
    await sleep(3000);
  }
  evidence.pointed = { pointed, hint };

  let resent = "";
  if (pointed) {
    if (record) await sleep(800);
    await rp.click(panel, `#messages .page-ref[data-name="导出"]`);
    resent = await until(async () => (await rp.evaluate(panel, `[...document.querySelectorAll("#messages .msg.user")].map(e => e.textContent).find(t => t.includes("点「导出」")) ?? ""`) as string) || undefined, 10_000, "second click sends", 100).catch(() => "");
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes("选 CSV 就能下载")`) || undefined, 30_000, "click answer", 100).catch(() => undefined);
    await sleep(1500);
  }
  evidence.resent = resent;

  if (record) {
    const [panelVideo, pageVideo] = await Promise.all(stops.map(stop => stop()));

    if (panelVideo && pageVideo) {
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", pageVideo, "-i", panelVideo, "-filter_complex",
        "[0:v][1:v]scale2ref=oh*mdar:ih[page][panel];[page][panel]hstack=inputs=2,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p", join(artifacts, "page-refs.mp4")]);
      evidence.recording = join(artifacts, "page-refs.mp4");
    }
  }

  assert.deepEqual([...marks].sort(), ["导出", "筛选"].sort(), `1: 只有读页拿到过、现在还在页上的按钮带虚线 ${JSON.stringify(marks)}`);
  assert.ok(pointed, "2: 点了以后网页上画出圈");
  assert.equal(hint, "已在页面上圈出 · 再点一次可由我来点", "2: 回答下写灰字");
  assert.ok(resent, "3: 再点一次发出「点「导出」」");

  // 4) 页面刷新后，读页拿到的位置作废：点了不画圈，虚线收掉。
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "settled again", 100);
  await rp.cdp.send("Page.reload", {}, work);
  await until(async () => await rp.evaluate(work, 'document.readyState==="complete"') || undefined, 10_000, "reloaded");
  await sleep(800);
  await rp.click(panel, `#messages .msg.assistant .page-ref[data-name="筛选"]`);
  await sleep(1500);
  const after = { ring: await inspectOnPage(), marks: await underlined() };
  evidence.afterReload = after;
  assert.ok(!after.ring && !after.marks.includes("筛选"), `4: 页面刷新后不画圈、虚线收掉 ${JSON.stringify(after)}`);
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
