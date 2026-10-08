/**
 * browser_run 的 check 与 assert（docs/evals/20261008-check-assert-referee.md R1、R2）。
 * 只装扩展、隔离构建、本机脚本模型；练习站在服务器上数请求，裁判是服务器计数和工具回执，不是模型。
 *   npx tsx scripts/acceptance/real-path/check-assert.mts --headless
 * 第一程（有提示）：点「提交」→ check 看见「已提交」→ assert 故意停下 → 点「下一步」。
 *   期望 /submit 1 次、/next 0 次；回执写停在第 3 步「故意停下」、已完成 2 步；侧栏那一步的 chip 标失败。
 * 第二程（没提示）：同样的页面但不出提示，只有藏在 script 和 display:none 里的「已提交」；check 应返回 ok:false。
 * 失败方式：assert 之后 /next 还是被点了；藏起来的文字把 check 骗成 true；回执没有停在哪一步。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until } from "./harness.mts";
import { configureViaSettings } from "./inproc-config.mts";
import { startScriptedModel } from "./scripted-model.mts";

requireHeadless();
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-check-assert`);

await mkdir(artifacts, { recursive: true });
const hits = { submit: 0, next: 0 };

/** 练习页：藏起来的「已提交」从一开始就在；toast 只在 withToast 时点击 300ms 后出现。 */
const page = (withToast: boolean) => `<!doctype html><meta charset="utf-8"><title>练习站</title>
<script>var i18n = { done: "已提交" };</script>
<div id="hidden" style="display:none">已提交</div>
<div style="visibility:hidden">已提交</div>
<div class="duplicate">重复目标</div><div class="duplicate">重复目标</div>
<button id="submit" onclick="fetch('/submit');${withToast ? "setTimeout(() => { document.getElementById('toast').textContent = '已提交'; }, 300);" : ""}">提交</button>
<button id="next" onclick="fetch('/next')">下一步</button>
<div id="toast"></div>`;
const site = createServer((req, res) => {
  if (req.url === "/submit") { hits.submit++; res.writeHead(204).end(); return; }

  if (req.url === "/next") { hits.next++; res.writeHead(204).end(); return; }

  if (req.url === "/" || req.url === "/quiet") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(req.url === "/"));
    return;
  }

  res.writeHead(404).end();
});

await new Promise<void>(resolve => site.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}`;
const MARK_STOP = "提交后核对再停下";
const MARK_QUIET = "没提示时核对";

/** 第一程：assert 的 reason 把 check 的结果带进回执，裁判只看回执文字。 */
const PROGRAM_STOP = [
  'await browser.click({target:"#submit"});',
  'const c = await browser.check({text:"已提交", timeoutMs:3000});',
  'try { await browser.assert({ok:false, name:"故意停下", reason:"验收 check.ok=" + c.ok + " waitedMs=" + c.waitedMs}); } catch {}',
  'await browser.click({target:"#next"});',
  'return "不该走到这里";',
].join("\n");
const PROGRAM_QUIET = 'await browser.click({target:"#submit"}); const absent = await browser.check({text:"已提交", timeoutMs:1500}); const gone = await browser.check({selector:"#missing",state:"disappears"}); const hidden = await browser.check({selector:"#hidden",state:"disappears"}); return {absent,gone,hidden};';
const MARK_ERROR = "核对失败如实报告";
const PROGRAM_ERROR = 'try { await browser.check({selector:".duplicate",state:"disappears"}); } catch {} await browser.click({target:"#next"});';
type Payload = { tools?: Array<{ function?: { name?: string } }>; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };
const payloads: Payload[] = [];
const model = await startScriptedModel([
  { match: MARK_STOP, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "browser_run", args: { label: MARK_STOP, code: PROGRAM_STOP } } },
    { text: `【${MARK_STOP}结束】` },
  ] },
  { match: MARK_QUIET, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "browser_run", args: { label: MARK_QUIET, code: PROGRAM_QUIET } } },
    { text: `【${MARK_QUIET}结束】` },
  ] },
  { match: MARK_ERROR, steps: [
    { tool: { name: "tabs", args: { action: "active" } } },
    { tool: { name: "browser_run", args: { label: MARK_ERROR, code: PROGRAM_ERROR } } },
    { text: `【${MARK_ERROR}结束】` },
  ] },
], undefined, payload => {
  // SAFETY: 脚本模型把产品的 OpenAI 兼容请求体原样交给这里；Payload 只取其中可选的 tools 与 messages。
  payloads.push(payload as Payload);
});
const rp = await launchRealPath();

let error: string | null = null;
type Chip = { label: string; past: string; error: boolean };
type Summary = {
  status: "PASS" | "FAIL";
  hits: typeof hits;
  stopReceipt?: string;
  quietReceipt?: string;
  errorReceipt?: string;
  chips?: Chip[];
  error: string | null;
};
const summary: Summary = { status: "FAIL", hits, error: null };

/** 主任务请求里的工具回执：browser_run 那条是第 2 条（第 1 条是 tabs）。 */
const receiptsOf = (mark: string) => {
  const last = payloads.findLast(p => p.tools?.length && p.messages?.some(m => m.role === "user" && JSON.stringify(m.content).includes(mark)));
  assert.ok(last, `model received the result for ${mark}`);
  const messages = last.messages ?? [];
  const start = messages.findLastIndex(m => m.role === "user" && JSON.stringify(m.content).includes(mark));
  return messages.slice(start + 1).filter(m => m.role === "tool").map(m => Array.isArray(m.content) ? m.content.map(part => part.text ?? "").join("") : m.content ?? "");
};
const finished = (rp: Awaited<ReturnType<typeof launchRealPath>>, panel: string, mark: string) =>
  until(async () => await rp.evaluate(panel, `document.querySelector("#messages")?.textContent.includes(${JSON.stringify(`【${mark}结束】`)}) && !document.querySelector("#status-pill")?.classList.contains("running")`) || undefined, 90_000, `${mark} finished`);

try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "fixture tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.navigate", { url: `${origin}/` }, work);
  const panel = await rp.attach(await rp.openSidePanel());
  await rp.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }, panel);
  const configured = await configureViaSettings(rp, panel, { providerId: "custom", modelId: "demo-model", credential: { type: "api_key", key: "local-demo-no-secret" } }, { baseUrl: model.baseUrl });
  await rp.cdp.send("Target.closeTarget", { targetId: configured.settingsTargetId });
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false') || undefined, 60_000, "sidebar ready");

  // 第一程：提示会出现；assert 故意停下，后面的「下一步」不该被点。
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK_STOP}：点提交，核对出现「已提交」，然后故意停下。`);
  await rp.pressEnter(panel);
  await finished(rp, panel, MARK_STOP);
  await sleep(500);

  const stopReceipt = receiptsOf(MARK_STOP)[1] ?? "";
  summary.stopReceipt = stopReceipt.slice(0, 400);
  // SAFETY: 侧栏里的 chip 是产品自己渲染的；这里只读标签、过去式说明和有没有 error 类。
  summary.chips = await rp.evaluate(panel, '[...document.querySelectorAll(".chip")].map(c => ({ label: c.querySelector(".chip-label")?.textContent ?? "", past: c.dataset.past ?? "", error: c.classList.contains("error") }))') as Chip[];
  await rp.screenshot(panel, join(artifacts, "sidebar.png"));

  // R2：服务器计数——提交 1 次、下一步 0 次；回执写停在第 3 步、已完成 2 步，名字带「故意停下」。
  assert.equal(hits.submit, 1, "the click before the assert reached the site once");
  assert.equal(hits.next, 0, "the click after the failed assert never happened");
  assert.ok(stopReceipt.includes("程序在第 3 步「故意停下」停下"), `receipt names the stopped step: ${stopReceipt}`);
  assert.ok(stopReceipt.includes("（已完成 2 步）"), `receipt counts the completed steps: ${stopReceipt}`);
  // R1（正）：check 在 toast 出现后返回 true，没叫模型（回执里 check 的结果由程序带出）。
  assert.ok(stopReceipt.includes("check.ok=true"), `check saw the toast: ${stopReceipt}`);
  // 侧栏：核对条件那一步的 chip 标失败，前两步没标。
  const chips = summary.chips;
  const assertChip = chips.find(c => c.label.includes("核对条件") || c.past.includes("核对条件"));
  assert.ok(assertChip?.error === true, `assert chip is marked failed: ${JSON.stringify(chips)}`);
  assert.ok(!chips.some(c => c.error && c !== assertChip), `only the assert chip is marked failed: ${JSON.stringify(chips)}`);

  // 第二程：没提示的页面，只有藏起来的「已提交」；check 必须返回 ok:false。
  await rp.cdp.send("Page.navigate", { url: `${origin}/quiet` }, work);
  await until(async () => await rp.evaluate(work, 'location.pathname === "/quiet" && !!document.querySelector("#submit")') || undefined, 10_000, "quiet page");
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK_QUIET}：点提交，核对有没有「已提交」。`);
  await rp.pressEnter(panel);
  await finished(rp, panel, MARK_QUIET);
  await sleep(500);

  const quietReceipt = receiptsOf(MARK_QUIET)[1] ?? "";
  summary.quietReceipt = quietReceipt.slice(0, 400);
  // R1（反）：藏在 script / display:none 里的文字不算出现；到时返回假，不报错。
  assert.equal(hits.submit, 2, "the quiet page's submit reached the site");
  assert.equal(hits.next, 0, "next was never clicked");
  const quiet = JSON.parse(quietReceipt.slice(quietReceipt.indexOf('{'), quietReceipt.lastIndexOf('}') + 1));
  assert.equal(quiet.value.absent.ok, false, "script and hidden text do not count as visible");
  assert.ok(quiet.value.absent.waitedMs >= 1500 && quiet.value.absent.waitedMs < 5000, "check timed out within a bounded interval");
  assert.equal(quiet.value.gone.ok, true, "a missing target has disappeared");
  assert.equal(quiet.value.hidden.ok, true, "a CSS-hidden target has disappeared");
  assert.equal(quiet.steps, 4, "all checks completed without an error");
  await rp.click(panel, "#input");
  await rp.typeText(panel, `${MARK_ERROR}：核对重复目标，失败后不能继续点击。`);
  await rp.pressEnter(panel);
  await finished(rp, panel, MARK_ERROR);
  summary.errorReceipt = receiptsOf(MARK_ERROR)[1] ?? "";
  assert.match(summary.errorReceipt, /AMBIGUOUS/, "a non-retryable error is not disguised as disappeared");
  assert.equal(hits.next, 0, "catch cannot continue after a program error");
  for (const mark of [MARK_STOP, MARK_QUIET, MARK_ERROR]) {
    assert.equal(model.requests.filter(r => r.rule === mark && r.tools).length, 3, "check adds no model round trip");
  }
  summary.status = "PASS";
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  summary.error = error;
} finally {
  await writeFile(join(artifacts, "summary.json"), JSON.stringify({ ...summary, modelRequests: model.requests }, null, 2));
  await rp.close();
  await rp.remove();
  await model.close();
  site.closeAllConnections();
  site.close();
}

console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error: error?.split("\n")[0] ?? null }));

if (error) process.exitCode = 1;
