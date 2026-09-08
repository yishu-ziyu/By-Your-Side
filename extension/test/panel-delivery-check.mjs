/**
 * issue #4 断线发送回归（生产 UI + 模拟通信边界）。
 *
 * 证据层级：真实构建的扩展（extension/dist）加载进隔离 persistent profile，
 * 在普通标签页打开生产入口 sidepanel.html（非 Chrome side panel 容器），
 * 故障只注入在 chrome.runtime.connect Port 边界（panel→background）——
 * 生产 DOM、生产 sidepanel.js、真实 chrome.storage.session。
 *
 * 用法：node extension/test/panel-delivery-check.mjs [--keep]
 * 退出码 0 = 全部断言通过；1 = 存在失败。结果 JSON 与截图落 /tmp/sideagent-panel-delivery/。
 */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sideagentExtensionId } from "../../scripts/acceptance/constants.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = join(repoRoot, "extension", "dist");
const outDir = join(tmpdir(), "sideagent-panel-delivery");
mkdirSync(outDir, { recursive: true });

const chromeBin = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const ASK = { text: "E2E-引用文字", tabId: 1, title: "测试页", url: "https://example.com/page" };
const SEND_TEXT = "E2E-发送正文-20260907";

/** 注入到 sidepanel.html 的 Port 边界替身：窗口初建为正常 Port，测试随时切换故障形态。 */
const portBoundary = () => {
  const sends = [];
  window.__panelSends = sends;
  window.__fault = "record"; // record | null | throw（按调用时读取，允许中途切换）
  let listeners = [];
  let disconnects = [];
  window.__emitToPanel = (msg) => {
    for (const l of [...listeners]) l(msg);
  };
  window.__panelHasPort = () => listeners.length > 0;
  // 模拟 Port 对端死亡：触发面板 onDisconnect（真实断线时序）
  window.__dropPort = () => {
    for (const l of [...disconnects]) l();
  };
  window.__setFault = (f) => {
    window.__fault = f;
  };
  chrome.runtime.connect = (opts) => {
    // fault="null"：connect 抛错 → 面板 port 停留 null（重连退避循环里）
    if (window.__fault === "null") throw new Error("injected: connect unavailable");
    // 每次连接重置监听集合；fault="throw" 只对 client 信封抛错
    listeners = [];
    disconnects = [];
    return {
      name: opts?.name,
      postMessage(m) {
        if (window.__fault === "throw" && m?.kind === "client") {
          throw new Error("injected: postMessage failed");
        }
        sends.push(m);
      },
      onMessage: { addListener(l) { listeners.push(l); } },
      onDisconnect: { addListener(l) { disconnects.push(l); } },
    };
  };
};

const results = [];

async function scenario(ctx, extId, name, { fault, steer = false, expectDelivered = false }) {
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  try {
    await page.addInitScript(portBoundary);
    await page.goto(`chrome-extension://${extId}/sidepanel.html`);
    await page.waitForSelector("#input", { timeout: 10_000 });

    // 阶段一：Port 正常。选中即问引用经 Port 边界下发 + 真实 storage.session 种子
    await page.evaluate(async (ask) => {
      await chrome.storage.session.set({ pendingAsk: ask });
      window.__emitToPanel({ kind: "ask_selection", ask });
    }, ASK);
    await page.waitForSelector("#ask-cite:not([hidden])", { timeout: 5_000 });
    if (steer) {
      await page.evaluate(() =>
        window.__emitToPanel({ kind: "server", msg: { type: "status", state: "running" } }),
      );
    }
    await page.fill("#input", SEND_TEXT);
    await page.screenshot({ path: join(outDir, `${name}-1-before-send.png`) });

    // 阶段二：注入故障（真实断线时序：先断 Port，重连进入故障形态）
    if (fault !== "record") {
      await page.evaluate((f) => {
        window.__setFault(f);
        window.__dropPort();
      }, fault);
      if (fault === "null") {
        await page.waitForTimeout(150); // onDisconnect → port=null，重连全部抛错
      } else {
        // throw：等面板重连拿到"postMessage 会抛错"的新 Port（约 +500ms）
        await page.waitForFunction(() => window.__panelHasPort(), null, { timeout: 5_000 });
      }
    }

    await page.press("#input", "Enter");
    await page.waitForTimeout(300); // 清空/保留均在此窗口内发生

    await page.screenshot({ path: join(outDir, `${name}-2-after-send.png`) });
    const state = await page.evaluate(async () => {
      const stored = await chrome.storage.session.get("pendingAsk");
      const bubble = document.querySelector("#messages .msg.user");
      const retryBtn = bubble?.querySelector("button[data-retry]") ?? null;
      return {
        input: document.getElementById("input").value,
        askHidden: document.getElementById("ask-cite").hidden,
        askStored: stored.pendingAsk?.text ?? null,
        clientSends: window.__panelSends.filter((m) => m.kind === "client"),
        userBubbleText: bubble?.textContent ?? null,
        retryVisible: !!retryBtn,
        noticeShown: [...document.querySelectorAll("#messages .msg.notice")].some((n) =>
          n.textContent.includes("没有发出去"),
        ),
      };
    });

    const expectType = steer ? "steer" : "user_message";
    const checks = expectDelivered
      ? [
          ["正文在成功后被清空（正常路径不受影响）", state.input === ""],
          ["引用在成功后被清除", state.askHidden && state.askStored === null],
          ["恰好发出一条 client 信封", state.clientSends.length === 1],
          [`信封类型为 ${expectType}`, state.clientSends[0]?.msg?.type === expectType],
          ["信封携带选区上下文", state.clientSends[0]?.msg?.context?.selection?.text === ASK.text],
          ["失败标记不存在", !state.retryVisible && !state.noticeShown],
        ]
      : [
          ["断线时正文保留在输入框", state.input === SEND_TEXT],
          ["断线时引用 UI 保留", !state.askHidden],
          ["断线时引用存储保留", state.askStored === ASK.text],
          ["没有发出任何 client 信封", state.clientSends.length === 0],
          ["不伪造已发送气泡", state.userBubbleText === null],
          ["明确提示未发送", state.noticeShown],
        ];
    const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
    results.push({ scenario: name, fault, steer, expectDelivered, checks, failed, pageErrors });
    return state;
  } finally {
    // 层内交互的收尾断言在独立 scenario 中做，这里直接关页
    await page.close();
  }
}

/** 修复后行为：delivery 回执 → 气泡标记 + 重试一次 + 迟到回执不清新正文。 */
async function receiptScenarios(ctx, extId, push) {
  // 1) 上行不可用回执：正常 Port 收下发 → background 层接受（history 回显）→ delivery ok:false → 气泡标记，重试恰发一条
  {
    const page = await ctx.newPage();
    try {
      await page.addInitScript(portBoundary, "record");
      await page.goto(`chrome-extension://${extId}/sidepanel.html`);
      await page.waitForSelector("#input", { timeout: 10_000 });
      await page.fill("#input", "E2E-上行失败消息");
      await page.press("#input", "Enter");
      // 模拟 background：先回 history 回显（background 层已接受），再回 delivery 失败回执
      await page.evaluate((text) => {
        window.__emitToPanel({ kind: "history", entries: [{ seq: 7, item: { kind: "user", text } }] });
        window.__emitToPanel({
          kind: "delivery",
          seq: 7,
          ok: false,
          original: { type: "user_message", text, context: undefined },
        });
      }, "E2E-上行失败消息");
      let marked = true;
      try {
        await page.waitForSelector("#messages .msg.user[data-seq='7'][data-failed='true']", {
          timeout: 5_000,
        });
      } catch {
        marked = false;
      }
      let state = null;
      if (marked) {
        // 用户随即编辑新正文；点重试只应重发原消息，且不动新正文
        await page.fill("#input", "E2E-用户后来编辑的新正文");
        const sendsBefore = await page.evaluate(() => window.__panelSends.filter((m) => m.kind === "client").length);
        await page.click("#messages .msg.user[data-seq='7'] button[data-retry]");
        await page.waitForTimeout(200);
        state = await page.evaluate((before) => {
          const all = window.__panelSends.filter((m) => m.kind === "client");
          return {
            input: document.getElementById("input").value,
            retried: document.querySelectorAll("#messages .msg.user[data-seq='7'][data-retried]").length,
            clientSends: all,
            retrySends: all.slice(before),
          };
        }, sendsBefore);
      }
      const checks = [
        ["delivery ok:false 后气泡标记未送达", marked],
        ["重试按钮存在且可点", marked && !!state],
        ["迟到编辑的新正文不被重试清掉", state?.input === "E2E-用户后来编辑的新正文"],
        ["重试恰发出一条新 client 信封", state?.retrySends.length === 1],
        ["重试信封携带 original 原文", state?.retrySends[0]?.msg?.text === "E2E-上行失败消息"],
        ["重试后原气泡标记已重试", state?.retried === 1],
      ];
      push("receipt-failed-marks-bubble-and-retry-once", checks, []);
      await page.screenshot({ path: join(outDir, "receipt-failed-marks-bubble-and-retry-once.png") });
    } finally {
      await page.close();
    }
  }
  // 2) 旧/未知回执与未知信封kind：不崩溃、不动输入框
  {
    const page = await ctx.newPage();
    try {
      await page.addInitScript(portBoundary, "record");
      await page.goto(`chrome-extension://${extId}/sidepanel.html`);
      await page.waitForSelector("#input", { timeout: 10_000 });
      await page.fill("#input", "E2E-稳态正文");
      await page.evaluate(() => {
        window.__emitToPanel({ kind: "delivery", seq: 999, ok: false, original: { type: "user_message", text: "旧请求" } });
        window.__emitToPanel({ kind: "made_up_kind_v2", whatever: 1 });
        window.__emitToPanel({ kind: "delivery", seq: "not-a-number", ok: false });
      });
      await page.waitForTimeout(150);
      const state = await page.evaluate(() => ({
        input: document.getElementById("input").value,
        failedBubbles: document.querySelectorAll("#messages .msg.user[data-failed='true']").length,
      }));
      const checks = [
        ["未知 seq 回执不动输入框", state.input === "E2E-稳态正文"],
        ["从未出现的 seq 不产生失败气泡", state.failedBubbles === 0],
      ];
      push("unknown-and-late-receipts-tolerated", checks, []);
    } finally {
      await page.close();
    }
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), "sideagent-panel-delivery-profile-"));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    // 用户在本机工作：一律 headless（完整二进制的新 headless 支持 --load-extension）
    headless: true,
    viewport: { width: 360, height: 780 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  // 扩展 ID 由 manifest.key 确定性推导；tier-2 的 Port 被替身接管，无需真实 SW 启动
  const extId = sideagentExtensionId();

  const push = (name, checks, pageErrors) => {
    const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
    results.push({ scenario: name, checks, failed, pageErrors });
  };

  // C1 四类失败边界（user_message/steer × port=null/postMessage 抛错）+ 两个正常对照
  await scenario(ctx, extId, "user_message-port-null", { fault: "null" });
  await scenario(ctx, extId, "user_message-post-throws", { fault: "throw" });
  await scenario(ctx, extId, "steer-port-null", { fault: "null", steer: true });
  await scenario(ctx, extId, "steer-post-throws", { fault: "throw", steer: true });
  await scenario(ctx, extId, "user_message-normal", { fault: "record", expectDelivered: true });
  await scenario(ctx, extId, "steer-normal", { fault: "record", steer: true, expectDelivered: true });

  // 修复后新增行为（旧代码上这些会失败，属于 C2–C4 的生产 UI 断言）
  await receiptScenarios(ctx, extId, push);

  await ctx.close();
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (!process.argv.includes("--keep")) rmSync(userDataDir, { recursive: true, force: true });
}

const failedScenarios = results.filter((r) => r.failed.length > 0 || (r.pageErrors ?? []).length > 0);
const report = {
  when: new Date().toISOString(),
  scenarios: results.map((r) => ({
    scenario: r.scenario,
    fault: r.fault,
    failed: r.failed,
    pageErrors: r.pageErrors ?? [],
    checks: r.checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"} ${label}`),
  })),
  exit: failedScenarios.length === 0 ? 0 : 1,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(report, null, 2));
for (const s of report.scenarios) {
  console.log(`${s.failed.length === 0 && s.pageErrors.length === 0 ? "PASS" : "FAIL"} ${s.scenario}`);
  for (const c of s.checks) console.log(`   ${c}`);
  for (const e of s.pageErrors) console.log(`   PAGEERROR ${e}`);
}
console.log(`\n结果与截图：${outDir}`);
process.exit(report.exit);
