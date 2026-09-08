/**
 * issue #4 C6：真实扩展运行时的可见故障→保留正文/引用→连接恢复→重试 路径。
 *
 * 证据层级：真实 Chrome side panel 容器的替代形态 = 隔离 profile + 真实构建扩展 +
 * 普通标签页打开 sidepanel.html。panel↔background 走真实 chrome.runtime Port、
 * 真实 service worker、真实 chrome.storage；故障不是注入替身，而是用 CDP
 * Target.closeTarget 终止 service worker 进程（等价于 SW 被回收）触发真实
 * onDisconnect。上行（background→agent）状态如实记录，不人为制造。
 *
 * 用法：node extension/test/panel-delivery-e2e.mjs [--keep]
 * 证据（截图 + result.json）写入 docs/evidence/20260907-send-delivery/。
 */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sideagentExtensionId } from "../../scripts/acceptance/constants.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = join(repoRoot, "extension", "dist");
const outDir = join(repoRoot, "docs", "evidence", "20260907-send-delivery");
mkdirSync(outDir, { recursive: true });

const chromeBin = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const SEND_TEXT = "E2E-真实扩展-断线保留-20260907";
const ASK = { text: "E2E-真实引用", tabId: 1, title: "测试页", url: "https://example.com/page" };

const check = [];
const record = (label, ok, extra) => check.push({ label, ok, extra });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const userDataDir = mkdtempSync(join(tmpdir(), "sideagent-e2e-profile-"));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    headless: true,
    viewport: { width: 360, height: 780 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const extId = sideagentExtensionId();

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.waitForSelector("#input", { timeout: 10_000 });

  // 引用经真实链路进入面板：storage.session 种子 → 页面重载 → SW sync 分发 ask_selection
  await page.evaluate(async (ask) => {
    await chrome.storage.session.set({ pendingAsk: ask });
  }, ASK);
  await page.reload();
  await page.waitForSelector("#input", { timeout: 10_000 });
  await page.waitForSelector("#ask-cite:not([hidden])", { timeout: 5_000 });
  record("引用经真实 SW sync 链路显示", true);

  await page.fill("#input", SEND_TEXT);
  await page.screenshot({ path: join(outDir, "e2e-1-before-fault.png") });

  // 真实故障：经页面 CDP 会话找到并终止 service worker（等价 SW 被回收）→ 面板 Port onDisconnect
  const cdp = await ctx.newCDPSession(page);
  const { targetInfos } = await cdp.send("Target.getTargets");
  const swTarget = targetInfos.find(
    (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`),
  );
  if (swTarget) {
    await cdp.send("Target.closeTarget", { targetId: swTarget.targetId });
  } else {
    await cdp.send("ServiceWorker.stopAllWorkers");
  }
  await page.waitForFunction(
    () => document.getElementById("status-text")?.textContent?.includes("重连"),
    null,
    { timeout: 5_000, polling: 25 },
  );
  // 在 500ms 重连退避窗口内发送（用户在断线瞬间的真实操作）
  await page.press("#input", "Enter");
  await sleep(400);

  const afterFault = await page.evaluate(async () => ({
    input: document.getElementById("input").value,
    askHidden: document.getElementById("ask-cite").hidden,
    askStored: (await chrome.storage.session.get("pendingAsk")).pendingAsk?.text ?? null,
    notice: [...document.querySelectorAll("#messages .msg.notice")].some((n) => n.textContent.includes("没有发出去")),
    userBubbles: document.querySelectorAll("#messages .msg.user").length,
    status: document.getElementById("status-text")?.textContent ?? "",
  }));
  await page.screenshot({ path: join(outDir, "e2e-2-after-fault-preserved.png") });
  record("断线发送后正文保留", afterFault.input === SEND_TEXT, afterFault);
  record("断线发送后引用 UI 保留", !afterFault.askHidden);
  record("断线发送后引用存储保留", afterFault.askStored === ASK.text);
  record("明确提示未发送", afterFault.notice);
  record("未伪造已发送气泡", afterFault.userBubbles === 0);

  // 连接恢复：等待面板自动重连唤醒 SW（真实重连，不注入）
  await page.waitForFunction(
    () => {
      const t = document.getElementById("status-text")?.textContent ?? "";
      return !t.includes("重连") && t !== "";
    },
    null,
    { timeout: 15_000, polling: 100 },
  );
  const recoveredStatus = await page.evaluate(() => document.getElementById("status-text")?.textContent ?? "");
  record("面板自动重连成功（真实 SW 唤醒）", true, { recoveredStatus });

  // 用户重试：此时 Port 已恢复，消息应被真实 background 接受并回显
  await page.press("#input", "Enter");
  let echoed = false;
  try {
    await page.waitForSelector("#messages .msg.user", { timeout: 8_000 });
    echoed = true;
  } catch {
    echoed = false;
  }
  await sleep(600); // 给可能的上行失败回执留时间
  const final = await page.evaluate(async () => ({
    input: document.getElementById("input").value,
    askHidden: document.getElementById("ask-cite").hidden,
    askStored: (await chrome.storage.session.get("pendingAsk")).pendingAsk?.text ?? null,
    bubble: document.querySelector("#messages .msg.user")?.textContent ?? null,
    bubbleFailed: document.querySelector("#messages .msg.user")?.dataset?.failed ?? null,
    status: document.getElementById("status-text")?.textContent ?? "",
  }));
  await page.screenshot({ path: join(outDir, "e2e-3-after-retry.png") });
  record("重试被真实 background 接受并回显", echoed && final.bubble?.includes(SEND_TEXT), final);
  record("成功后正文清空", final.input === "");
  record("成功后引用清除（UI + 存储）", final.askHidden && final.askStored === null);
  record("页面无未捕获异常", pageErrors.length === 0, { pageErrors });

  await ctx.close();
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (!process.argv.includes("--keep")) rmSync(userDataDir, { recursive: true, force: true });
}

const failed = check.filter((c) => !c.ok);
const report = {
  when: new Date().toISOString(),
  gitSha: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
  dist: execSync("shasum -a 256 extension/dist/sidepanel.js", { cwd: repoRoot }).toString().trim(),
  checks: check,
  failedCount: failed.length,
};
writeFileSync(join(outDir, "e2e-result.json"), JSON.stringify(report, null, 2));
for (const c of check) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.label}${c.extra ? ` :: ${JSON.stringify(c.extra)}` : ""}`);
console.log(`\n证据目录：${outDir}`);
process.exit(failed.length === 0 ? 0 : 1);
