/** R4 真实扩展侧栏验收；脚本模型仅替代回复，工具、文件区和裁判走产品路径。
 * 重跑：npx tsx scripts/acceptance/real-path/run-check.mts --headless
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, recordScreen, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel, type Rule } from "./scripted-model.mts";

requireHeadless();

const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-run-check`);

await mkdir(artifacts, { recursive: true });

const site = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) { res.writeHead(500).end("boom"); return; }

  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<!doctype html><title>字幕练习页</title><pre id=\"data\">第1行 字幕\n第2行 字幕</pre>");
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));

const origin = `http://127.0.0.1:${siteAddress(site).port}/`;

/** 期望值来自手数：文件就是 N 行「字幕 i」，不带结尾换行。 */
const program = (filename: string, lines: number) => `
const content = Array.from({ length: ${lines} }, (_, i) => "字幕 " + (i + 1)).join("\\n");
return await browser.saveFile({ filename: ${JSON.stringify(filename)}, content });
`;

const badUrl = `${origin}api/subtitles`;
const save = (filename: string) => ({ tool: { name: "browser_run", args: { label: "保存字幕", code: program(filename, 3) } } });
const fail = { tool: { name: "fetch", args: { url: badUrl } } };
const scenarios = [
  { mark: "场景A", steps: [fail, save("a.txt")], reply: "已保存 1 个文件。", expectLine: "核对 2/3 · 有一步失败没说" },
  { mark: "场景B", steps: [fail, save("b.txt")], reply: `fetch ${badUrl} 失败。已保存 1 个文件。`, expectLine: "核对 3/3" },
  { mark: "场景C", steps: [save("c.txt")], reply: "已保存 2 个文件。", expectLine: "核对 2/3 · 回复说 2 个文件，本任务记录了 1 个文件" },
  { mark: "场景D", steps: [save("c.txt")], reply: "已保存 1 个文件。", expectLine: "核对 2/3 · 要求保存，但新增了 0 个文件" },
  { mark: "场景E", steps: [{ tool: { name: "browser_run", args: { label: "尝试接口后保存", code: `try { await browser.fetch({url: ${JSON.stringify(badUrl)}}); } catch {}\n${program("e.txt", 3)}` } } }], reply: "字幕处理结束。", expectLine: "核对 1/3 · 有一步失败没说 · 要求保存，但新增了 0 个文件" },
  { mark: "场景F", steps: [fail, save("f.txt")], reply: "别的操作失败了。已保存 1 个文件。", expectLine: "核对 2/3 · 有一步失败没说" },
  { mark: "场景H", steps: [
    { tool: { name: "browser_run", args: { label: "尝试读取", code: `await browser.js({code: '(() => { throw new Error("fixture failure"); })()', readonly: true});` } } },
    { tool: { name: "browser_run", args: { label: "读标题并保存", code: `await browser.js({code: 'document.title', readonly: true});\n${program("h.txt", 3)}` } } },
  ], reply: "已保存 1 个文件。", expectLine: "核对 2/3 · 有一步失败没说" },
  { mark: "场景G", steps: [save("g.txt")], reply: "已保存 1 个文件，完成 2 处改动。", expectLine: "核对 2/3 · 回复中的改动处数暂无可核对记录" },
  { mark: "条数反例", steps: [{ tool: { name: "browser_run", args: { code: program("rows.txt", 658) } } }], reply: "已保存 1 个文件。rows.txt 有 830 条字幕。", expectLine: "核对 2/3 · 回复说 830 条，文件 rows.txt 有 658 条" },
  { mark: "条数对照", steps: [{ tool: { name: "browser_run", args: { code: program("correct.txt", 830) } } }], reply: "已保存 1 个文件。correct.txt 有 830 条字幕。", expectLine: "核对 3/3" },
  { mark: "CSV换行", steps: [{ tool: { name: "browser_run", args: { code: "return await browser.saveFile(" + JSON.stringify({filename:"quoted.csv",content:'"A\nB",1\nC,2'}) + ");" } } }], reply: "已保存 1 个文件。quoted.csv 有 3 条记录。", expectLine: "核对 2/3 · 回复说 3 条，文件 quoted.csv 有 2 条" },
  { mark: "JSON排版", steps: [{ tool: { name: "browser_run", args: { code: 'return await browser.saveFile({filename:"formatted.json",content:JSON.stringify([{name:"A"}],null,2)});' } } }], reply: "已保存 1 个文件。formatted.json 有 1 条记录。", expectLine: "核对 3/3" },
  { mark: "无关条数", steps: [save("comments.txt")], reply: "页面存在 12 条评论。已保存 1 个文件。", expectLine: "核对 3/3" },
  { mark: "中文文件数", steps: [save("chinese.txt")], reply: "已保存两个文件。", expectLine: "核对 2/3 · 回复说 2 个文件，本任务记录了 1 个文件" },
];
const rules: Rule[] = [
  { match: '"lastReply"', steps: [{ text: '{"status":"done","remaining":"","correction":""}' }] },
  ...scenarios.map(s => ({ match: s.mark, steps: [...s.steps, { text: s.reply }] })),
];

const model = await startScriptedModel(rules);

const rp = await launchRealPath();

let error: string | null = null;
let stopScreen: (() => Promise<string | null>) | null = null;
let video: string | null = null;

/** 侧栏回执读数与预期；写进 summary.json。 */
const summary: Array<{ mark: string; userText: string; line: string | null; foldPresent: boolean; expectLine: string }> = [];
async function openLatestCheck(panel: string): Promise<void> {
  const point = await rp.evaluate(panel, `(() => { const summary = [...document.querySelectorAll("details.run-steps > summary")].at(-1); summary.scrollIntoView({block:"center"}); const r=summary.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`) as { x: number; y: number };
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 }, panel);
  await rp.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 }, panel);
  await sleep(200);
  assert.equal(await rp.evaluate(panel, '[...document.querySelectorAll("details.run-steps")].at(-1).open'), true, "the user can open the fold to see the check");
}

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: origin }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  stopScreen = await recordScreen(rp.cdp, panel, join(artifacts, "panel.mp4")).catch(() => null);

  for (const s of scenarios) {
    await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false && !document.querySelector("#status-pill")?.classList.contains("running")') || undefined, 60_000, "previous turn settled");
    const linesBefore = Number(await rp.evaluate(panel, 'document.querySelectorAll(".run-check").length'));
    const userText = `${s.mark}：提取这页的字幕并保存成文件`;
    await rp.click(panel, "#input");
    await rp.typeText(panel, userText);
    await rp.pressEnter(panel);
    await until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(s.reply)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 90_000, `${s.mark} finished`);
    await sleep(800);

    // 每轮新增一条核对行，正常和失败都保留在折叠区。
    const read = await rp.evaluate(panel, `(() => { const all = [...document.querySelectorAll(".run-check")]; const last = all.length > ${linesBefore} ? all[all.length - 1] : null; return { count: all.length, line: last ? last.textContent : null, foldPresent: !!last?.closest("details.run-steps")?.isConnected }; })()`) as { count: number; line: string | null; foldPresent: boolean };
    summary.push({ mark: s.mark, userText, line: read.line, foldPresent: read.foldPresent, expectLine: s.expectLine });

    if (s.mark === "场景E") {
      const names = await rp.evaluate(panel, '[...document.querySelectorAll(".artifact-card:not([data-deleted=true]) .artifact-name")].map(n => n.textContent)') as string[];
      assert.ok(!names.includes("e.txt"), "失败RPC永久停止程序，catch之后不能保存e.txt");
      await writeFile(join(artifacts, "files-after-stopped-program.json"), JSON.stringify(names, null, 2));
    }
    if (s.mark === "场景A") await rp.screenshot(panel, join(artifacts, "sidebar-a.png"));
    if (s.mark === "条数反例") { await openLatestCheck(panel); await rp.screenshot(panel, join(artifacts, "rows-mismatch.png")); }
  }

  await openLatestCheck(panel);
  await rp.screenshot(panel, join(artifacts, "sidebar-final.png"));

  for (const s of summary) {
    assert.equal(s.line, s.expectLine, `${s.mark}: 核对行文字`);
    assert.equal(s.foldPresent, true, `${s.mark}: 核对行保留在过程折叠区`);
  }

  assert.ok((await rp.targets()).some(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`), "real offscreen Agent required");
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  video = await stopScreen?.().catch(() => null) ?? null;
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", dependency: "isolated real extension/offscreen Agent/sidebar; scripted local model; local practice site", scenarios: summary, error, video, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, summary: summary.map(s => `${s.mark} ${s.line ?? "(无核对行)"}`), error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
