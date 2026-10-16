/**
 * 真模型在维基百科填搜索框但不搜索，随后从侧栏恢复原值。
 *   npx tsx scripts/acceptance/real-path/fill-summary-live.mts --headless [--headed]
 * 有窗口时在后台启动隔离浏览器，不使用日常账号，不提交页面。
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO, launchRealPath, requireHeadless, until } from "./harness.mts";
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from "./inproc-config.mts";
requireHeadless();
const artifacts = join(REPO, "out/acceptance/real-path", `${new Date().toISOString().replace(/[:.]/g, "-")}-fill-summary-live`);
await mkdir(artifacts, { recursive: true });
const rp = await launchRealPath({ headed: process.argv.includes("--headed") });
const evidence: Record<string, unknown> = { model: DEFAULT_TEST_MODEL, website: "https://www.wikipedia.org/" };
let error: string | null = null;
try {
  const blank = await until(async () => (await rp.targets()).find(t => t.type === "page" && t.url === "about:blank"), 10_000, "blank tab");
  const work = await rp.attach(blank.targetId);
  await rp.cdp.send("Page.enable", {}, work);
  await rp.cdp.send("Page.navigate", { url: "https://www.wikipedia.org/" }, work);
  await until(async () => await rp.evaluate(work, '!!document.querySelector("#searchInput")') || undefined, 30_000, "Wikipedia search");
  const before = await rp.evaluate(work, 'document.querySelector("#searchInput").value');
  const panel = await rp.attach(await rp.openSidePanel());
  const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(() => true)`);
  await until(async () => await rp.evaluate(panel, 'document.querySelector("#send-btn")?.disabled === false') || undefined, 30_000, "panel ready");
  await rp.click(panel, "#input");
  await rp.typeText(panel, "只把当前维基百科首页搜索框填写成 By Your Side acceptance，不要按回车，不要点击搜索，不要跳转。填好后告诉我。");
  await rp.pressEnter(panel);
  await until(async () => await rp.evaluate(panel, 'document.querySelector(".plan-undo")?.textContent.includes("恢复这") && !document.querySelector("#send-btn")?.disabled') || undefined, 150_000, "live fill and restore affordance");
  const filled = await rp.evaluate(work, '({value:document.querySelector("#searchInput")?.value,url:location.href})');
  evidence.filled = filled;
  assert.equal(filled.value, "By Your Side acceptance");
  assert.equal(filled.url, "https://www.wikipedia.org/");
  await rp.screenshot(panel, join(artifacts, "filled-panel.png"));
  await rp.screenshot(work, join(artifacts, "filled-page.png"));
  await rp.click(panel, ".plan-undo");
  await until(async () => await rp.evaluate(panel, 'document.querySelector(".plan-undo")?.textContent.includes("已恢复 1 处")') || undefined, 15_000, "one field restored");
  assert.equal(await rp.evaluate(work, 'document.querySelector("#searchInput").value'), before);
  assert.equal(await rp.evaluate(work, 'location.href'), "https://www.wikipedia.org/");
  evidence.restored = await rp.evaluate(panel, 'document.querySelector(".plan-card")?.textContent');
  await rp.screenshot(panel, join(artifacts, "restored-panel.png"));
  await rp.screenshot(work, join(artifacts, "restored-page.png"));
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
} finally {
  await writeFile(join(artifacts, "result.json"), JSON.stringify({ status: error ? "FAIL" : "PASS", evidence, error }, null, 2));
  await rp.close();
  await rp.remove();
}
console.log(JSON.stringify({ status: error ? "FAIL" : "PASS", artifacts, error }));
if (error) process.exitCode = 1;
