/**
 * PR #3 R1/R2 补证：模型选择状态矩阵与渲染几何（生产 UI + 模拟通信边界）。
 *
 * 证据层级：真实构建扩展（extension/dist，本分支 HEAD 构建）+ 隔离 profile +
 * 普通标签页加载生产 sidepanel.html（非 Chrome side panel 容器）。
 * 生产 DOM/CSS/JS 全真；只有通信边界是替身——chrome.runtime.connect 被包装，
 * 测试经其监听器下发真实格式的 BgToPanel 信封（hello_ok / model_info / agent_event），
 * 并记录面板发出的 PanelToBg。不复制任何渲染逻辑。
 *
 * 用法：node extension/test/panel-states-check.mjs [--keep]
 * 证据（截图 + result.json）写入 docs/evidence/20260907-model-labels-r1r2/（本地，不入库）。
 */
import { chromium } from "/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sideagentExtensionId } from "../../scripts/acceptance/constants.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const extDir = join(repoRoot, "extension", "dist");
const outDir = join(repoRoot, "docs", "evidence", "20260907-model-labels-r1r2");
mkdirSync(outDir, { recursive: true });

const chromeBin = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

/** 旧协议四字段目录（id/provider/modelId/name，无任何能力字段），含未知供应商模型。 */
const CATALOG = [
  { id: "minimax/MiniMax-M3", provider: "minimax", modelId: "MiniMax-M3", name: "MiniMax M3" },
  { id: "openai/gpt-5.2", provider: "openai", modelId: "gpt-5.2", name: "GPT-5.2" },
  { id: "unknown-provider/weird-model", provider: "unknown-provider", modelId: "weird-model", name: "Weird Model" },
  { id: "zhipu/glm-5", provider: "zhipu", modelId: "glm-5", name: "GLM-5" },
];
const FABRICATED_TAGS = ["支持档位调节", "内置深度思考", "极速直接响应"];

/** Port 边界替身：记录面板上行，暴露 __emitToPanel 下行真实格式信封。 */
const portBoundary = () => {
  const sends = [];
  let listeners = [];
  window.__panelSends = sends;
  window.__emitToPanel = (msg) => {
    for (const l of [...listeners]) l(msg);
  };
  chrome.runtime.connect = (opts) => {
    listeners = [];
    return {
      name: opts?.name,
      postMessage(m) {
        sends.push(m);
      },
      onMessage: { addListener(l) { listeners.push(l); } },
      onDisconnect: { addListener() {} },
    };
  };
};

const results = [];
const push = (scenario, checks, extra) => {
  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  results.push({ scenario, failed, extra: extra ?? {}, checks: checks.map(([label, ok]) => `${ok ? "PASS" : "FAIL"} ${label}`) });
};

async function openPanel(ctx, extId, { width = 360, scheme = "light" } = {}) {
  const page = await ctx.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(portBoundary);
  await page.emulateMedia({ colorScheme: scheme });
  await page.setViewportSize({ width, height: 720 });
  await page.goto(`chrome-extension://${extId}/sidepanel.html`);
  await page.waitForSelector("#input", { timeout: 10_000 });
  return { page, pageErrors };
}

const emitHello = (page, model) =>
  page.evaluate(
    ({ model, models }) =>
      window.__emitToPanel({
        kind: "server",
        msg: { type: "hello_ok", version: 1, model, models },
      }),
    { model, models: CATALOG },
  );

async function stateMatrix(ctx, extId) {
  const { page, pageErrors } = await openPanel(ctx, extId);

  // ── R1-1 旧四字段目录 / 未知模型 ─────────────────────────────
  await emitHello(page, "minimax/MiniMax-M3");
  await page.waitForSelector("#model-btn:not([hidden])", { timeout: 5_000 });
  const s1 = await page.evaluate((tags) => {
    const name = document.getElementById("model-name")?.textContent ?? "";
    return {
      chip: name,
      chipTagHidden: document.getElementById("model-reasoning-tag")?.hidden,
      bodyHasFabricated: tags.some((t) => document.body.textContent.includes(t)),
    };
  }, FABRICATED_TAGS);
  await page.click("#model-btn");
  await page.waitForSelector("#model-popover:not([hidden])", { timeout: 3_000 });
  const s1m = await page.evaluate((tags) => {
    const pop = document.getElementById("model-popover");
    const items = [...pop.querySelectorAll(".model-item")];
    return {
      itemCount: items.length,
      hasUnknown: items.some((i) => i.dataset.model === "unknown-provider/weird-model"),
      selected: pop.querySelector(".model-item[aria-selected='true']")?.dataset.model ?? null,
      popoverHasFabricated: tags.some((t) => pop.textContent.includes(t)),
      popoverItemsHaveTag: items.some((i) => i.querySelector(".reasoning-tag")),
    };
  }, FABRICATED_TAGS);
  push(
    "R1-1 旧四字段目录+未知模型",
    [
      ["模型芯片可见且有名称", s1.chip.includes("MiniMax")],
      ["芯片能力标签隐藏", s1.chipTagHidden === true],
      ["页面无捏造能力文案", !s1.bodyHasFabricated],
      ["菜单列出全部 4 个模型（含未知供应商）", s1m.itemCount === 4 && s1m.hasUnknown],
      ["当前模型 aria-selected 正确", s1m.selected === "minimax/MiniMax-M3"],
      ["菜单项无能力标签", !s1m.popoverItemsHaveTag && !s1m.popoverHasFabricated],
    ],
    s1m,
  );
  await page.screenshot({ path: join(outDir, "r1-1-old-catalog.png") });

  // ── R1-2 点击切换、尚未收到成功回执：不假更新 ─────────────────
  const before = await page.evaluate(() => window.__panelSends.length);
  await page.click("#model-popover .model-item[data-model='openai/gpt-5.2']");
  await page.waitForTimeout(150);
  const s2 = await page.evaluate(
    (n) => {
      const newSends = window.__panelSends.slice(n).filter((m) => m.kind === "client");
      return {
        chip: document.getElementById("model-name")?.textContent ?? "",
        popoverClosed: document.getElementById("model-popover")?.hidden,
        setModelSends: newSends.filter((m) => m.msg?.type === "set_model"),
        tagHidden: document.getElementById("model-reasoning-tag")?.hidden,
      };
    },
    before,
  );
  await page.click("#model-btn");
  const s2m = await page.evaluate(() => ({
    selected: document.querySelector("#model-popover .model-item[aria-selected='true']")?.dataset.model ?? null,
  }));
  push("R1-2 切换未回执不假更新", [
    ["恰发出一条 set_model 请求", s2.setModelSends.length === 1 && s2.setModelSends[0].msg.model === "openai/gpt-5.2"],
    ["芯片仍显示上一确认模型", s2.chip.includes("MiniMax")],
    ["菜单选中项仍是上一确认模型", s2m.selected === "minimax/MiniMax-M3"],
    ["无能力标签出现", s2.tagHidden === true],
    ["弹层点击后收起", s2.popoverClosed === true],
  ]);

  // ── R1-3 model_info 成功回执：名称与选中项更新 ─────────────────
  await page.keyboard.press("Escape");
  await page.evaluate(
    ({ model, models }) =>
      window.__emitToPanel({ kind: "server", msg: { type: "model_info", model, models } }),
    { model: "openai/gpt-5.2", models: CATALOG },
  );
  await page.waitForTimeout(100);
  const s3 = await page.evaluate(() => ({
    chip: document.getElementById("model-name")?.textContent ?? "",
    tagHidden: document.getElementById("model-reasoning-tag")?.hidden,
  }));
  await page.click("#model-btn");
  const s3m = await page.evaluate(() => ({
    selected: document.querySelector("#model-popover .model-item[aria-selected='true']")?.dataset.model ?? null,
    current: document.querySelector("#model-popover .model-item.current")?.dataset.model ?? null,
  }));
  push("R1-3 model_info 回执后状态正确", [
    ["芯片显示新确认模型", s3.chip.includes("GPT-5.2")],
    ["菜单选中项更新为新模型", s3m.selected === "openai/gpt-5.2" && s3m.current === "openai/gpt-5.2"],
    ["仍无能力标签", s3.tagHidden === true],
  ]);
  await page.screenshot({ path: join(outDir, "r1-3-after-model-info.png") });

  // ── R1-4 真实格式切换失败：保留上一确认模型 + 显示错误 ─────────
  const before4 = await page.evaluate(() => window.__panelSends.length);
  await page.click("#model-popover .model-item[data-model='zhipu/glm-5']");
  await page.waitForTimeout(100);
  await page.evaluate(() =>
    window.__emitToPanel({
      kind: "server",
      msg: { type: "agent_event", event: { kind: "error", message: "model zhipu/glm-5 unavailable" } },
    }),
  );
  await page.waitForTimeout(100);
  const s4 = await page.evaluate(
    (n) => {
      const sends = window.__panelSends.slice(n).filter((m) => m.kind === "client");
      const err = [...document.querySelectorAll("#messages .msg.error")].pop()?.textContent ?? "";
      return {
        chip: document.getElementById("model-name")?.textContent ?? "",
        errorShown: err.length > 0,
        errorText: err,
        setModelSends: sends.filter((m) => m.msg?.type === "set_model"),
        tagHidden: document.getElementById("model-reasoning-tag")?.hidden,
      };
    },
    before4,
  );
  push("R1-4 切换失败保留旧模型并显示错误", [
    ["失败请求已发出（断言请求而非 grep bundle）", s4.setModelSends.length === 1],
    ["芯片保留上一确认模型 GPT-5.2", s4.chip.includes("GPT-5.2")],
    ["错误消息可见", s4.errorShown],
    ["失败后仍无能力标签", s4.tagHidden === true],
    ["全程无页面异常", pageErrors.length === 0],
  ], { errorText: s4.errorText, pageErrors });
  await page.screenshot({ path: join(outDir, "r1-4-switch-failure.png") });
  await page.close();
}

/** R2：窄宽度 × 亮暗模式下核心控件可见、可操作、不裁切不重叠。 */
async function geometryTheme(ctx, extId) {
  const combos = [
    { width: 320, scheme: "light" },
    { width: 320, scheme: "dark" },
    { width: 360, scheme: "light" },
    { width: 360, scheme: "dark" },
    { width: 400, scheme: "dark" },
  ];
  for (const combo of combos) {
    const tag = `${combo.width}x720-${combo.scheme}`;
    const { page, pageErrors } = await openPanel(ctx, extId, combo);
    await emitHello(page, "unknown-provider/weird-model");
    await page.waitForSelector("#model-btn:not([hidden])", { timeout: 5_000 });
    await page.click("#model-btn");
    await page.waitForSelector("#model-popover:not([hidden])", { timeout: 3_000 });
    const g = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
      };
      const overlap = (a, b) => a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
      const input = rect("#input");
      const send = rect("#send-btn");
      const modelBtn = rect("#model-btn");
      const pop = rect("#model-popover");
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const inView = (r) => r && r.w > 0 && r.h > 0 && r.x >= 0 && r.y >= 0 && r.right <= vw && r.bottom <= vh;
      return {
        vw,
        vh,
        input,
        send,
        modelBtn,
        pop,
        inputOk: inView(input),
        sendOk: inView(send),
        modelOk: inView(modelBtn),
        popOk: inView(pop),
        noOverlap: !overlap(input, send) && !overlap(input, modelBtn) && !overlap(send, modelBtn),
      };
    });
    // 可操作性：输入文本、点选另一个模型（真实点击路径）
    await page.fill("#input", "E2E-几何-输入");
    const before = await page.evaluate(() => window.__panelSends.length);
    await page.click("#model-popover .model-item[data-model='zhipu/glm-5']");
    await page.waitForTimeout(120);
    const acted = await page.evaluate((n) => {
      const sends = window.__panelSends.slice(n).filter((m) => m.kind === "client");
      return {
        input: document.getElementById("input")?.value ?? "",
        setModel: sends.filter((m) => m.msg?.type === "set_model").length,
      };
    }, before);
    push(`R2 几何与可操作 ${tag}`, [
      [`输入框完整可见（${g.inputOk ? `${Math.round(g.input.w)}px 宽` : "裁切"}）`, g.inputOk],
      ["发送按钮完整可见", g.sendOk],
      ["模型入口完整可见", g.modelOk],
      ["模型菜单完整可见", g.popOk],
      ["核心控件互不重叠", g.noOverlap],
      ["输入框可输入", acted.input === "E2E-几何-输入"],
      ["菜单项可点击且发出 set_model", acted.setModel === 1],
      ["无页面异常", pageErrors.length === 0],
    ], { viewport: `${g.vw}x${g.vh}`, rects: { input: g.input, send: g.send, modelBtn: g.modelBtn } });
    await page.screenshot({ path: join(outDir, `r2-${tag}.png`) });
    await page.close();
  }
}

const userDataDir = mkdtempSync(join(tmpdir(), "sideagent-states-profile-"));
let ctx;
try {
  ctx = await chromium.launchPersistentContext(userDataDir, {
    executablePath: chromeBin,
    headless: true,
    viewport: { width: 360, height: 720 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  const extId = sideagentExtensionId();
  await stateMatrix(ctx, extId);
  await geometryTheme(ctx, extId);
  await ctx.close();
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (!process.argv.includes("--keep")) rmSync(userDataDir, { recursive: true, force: true });
}

const failedScenarios = results.filter((r) => r.failed.length > 0);
const report = {
  when: new Date().toISOString(),
  gitSha: execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim(),
  distSha256: createHash("sha256").update(readFileSync(join(extDir, "sidepanel.js"))).digest("hex"),
  tier: "生产 UI + 模拟通信边界（标签页加载 sidepanel.html，非 side panel 容器）",
  results,
  exit: failedScenarios.length === 0 ? 0 : 1,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(report, null, 2));
for (const r of results) {
  console.log(`${r.failed.length === 0 ? "PASS" : "FAIL"} ${r.scenario}`);
  for (const c of r.checks) console.log(`   ${c}`);
}
console.log(`\ngit ${report.gitSha.slice(0, 8)}  dist sha256 ${report.distSha256.slice(0, 16)}…`);
console.log(`结果与截图：${outDir}`);
process.exit(report.exit);
