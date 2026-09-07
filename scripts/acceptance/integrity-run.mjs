#!/usr/bin/env node
/**
 * 观测与点击完整性独立验收脚本 (Antigravity)
 * 对应标准: docs/evals/20260907-observation-click-integrity.md (A1, A2, A3, B1, B2, B3)
 *
 * 用法:
 *   node scripts/acceptance/integrity-run.mjs [--case=screenshot|viewport|click|move|occlude|duplicate|handback|all] [--dry-run]
 *
 * 核心设计:
 * 1. 真实工具链优先: 通过 Service Worker __saCall 入口调用生产 executeToolCall 链路，
 *    不另写独立 snapshot/click 实现，不伪造 DOM 赋值/直接点击。
 * 2. 真实双标签页与长视口夹具: 校验 DPR/像素尺寸、工作标签归属、视口节点过滤、单次点击与干扰响应。
 * 3. 严格判定与防放水:
 *    - tabId/url 缺失直接 FAIL
 *    - PNG 尺寸通过二进制标头独立解码核验，严禁二次调用工具存图
 *    - 遮挡时必须明确拒绝 (ok === false) 且四项目标计数均为 0
 *    - 位移必须先确认 isMoved 真实发生再断言 trapCount === 0
 *    - 同名按钮必须先用歧义选择器证明拒绝/零点击，再用唯一标识命中
 *    - handback 标为 NOT_COVERED 由 Codex 模型实机闭环验证
 * 4. 结果保存结构化 JSON、截图、起止耗时与明确状态。
 */

import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { startIntegrityFixtureServer } from "./integrity-fixture-server.mjs";
import { discoverChromeMain } from "./discover.mjs";
import { connectBrowser, evaluateInWorker, findServiceWorker } from "./cdp.mjs";
import { sideagentExtensionId } from "./constants.mjs";
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from "./sw-hook.mjs";

const parseArg = (name) => {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const caseArg = parseArg("case") || "all";
const validCases = ["screenshot", "viewport", "click", "move", "occlude", "duplicate", "handback", "all"];
if (!validCases.includes(caseArg)) {
  console.error(`未知场景: ${caseArg}。有效选项: ${validCases.join(", ")}`);
  process.exit(1);
}

const isDryRun = hasFlag("dry-run");
const outDir = parseArg("out-dir") || join(
  process.cwd(),
  "out/acceptance",
  `integrity-${new Date().toISOString().replace(/[:.]/g, "-")}`,
);

function sanitizeRecord(val) {
  return JSON.parse(
    JSON.stringify(val, (k, v) => (k === "imageBase64" ? `[image omitted, len=${String(v).length}]` : v)),
  );
}

/**
 * 独立解码 PNG 标头 (IHDR chunk)，获取物理像素宽高。
 * 不依赖第三方库或浏览器端环境。
 */
function decodePngDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a;
  if (!isPng) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

async function main() {
  const startedAt = Date.now();
  await mkdir(outDir, { recursive: true });

  console.log(`[Antigravity] 启动完整性验收套件... (case: ${caseArg})`);

  // 1. 启动本地双标签夹具服务器
  const fixtureServer = await startIntegrityFixtureServer();
  const origin = fixtureServer.origin;
  console.log(`[Antigravity] 夹具服务器已就绪: ${origin}`);

  // dry-run 模式：仅确认夹具服务与文件配置，严禁输出 passed:true 冒充功能验收
  if (isDryRun) {
    console.log(`[Antigravity] Dry run 完成: 夹具服务器配置正常，浏览器执行处于 not_run 状态。`);
    await fixtureServer.close();
    await writeFile(
      join(outDir, "result.json"),
      JSON.stringify(
        {
          status: "configured",
          execution: "not_run",
          suitePassed: null,
          origin,
          timestamp: startedAt,
          note: "Fixtures and server configured; browser execution not run.",
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }

  // 2. 检查 ChromeMain 与 ServiceWorker
  let cdp;
  let swSession;
  const suiteResults = [];

  try {
    let connection;
    try {
      connection = discoverChromeMain();
    } catch (e) {
      const errReport = {
        suitePassed: false,
        status: "BLOCKED",
        reason: "ChromeMain 未运行或未开启 remote-debugging-port",
        error: String(e),
      };
      await writeFile(join(outDir, "result.json"), JSON.stringify(errReport, null, 2));
      console.error(`[Antigravity] BLOCKED: ${errReport.reason}`);
      process.exit(2);
    }

    console.log(`[Antigravity] 连接 Chrome CDP (port: ${connection.port})...`);
    ({ cdp } = await connectBrowser(connection.port));

    const extId = sideagentExtensionId();
    const { targetInfos } = await cdp.send("Target.getTargets");
    const sw = findServiceWorker(targetInfos, extId);
    if (!sw) {
      throw new Error(`未找到 SideAgent Service Worker (extId: ${extId})`);
    }

    swSession = await cdp.attachSession(sw.targetId);
    await normalizeServiceWorkerInspector(cdp, swSession);
    await installExecuteToolCallHook(cdp, swSession, extId, origin);

    // 检查是否有现有正在执行的会话冲突
    const gateStatus = await evaluateInWorker(
      cdp,
      swSession,
      "({ gate: globalThis.__saGate?.(), team: globalThis.__saTeamView?.() })",
    );
    await writeFile(join(outDir, "initial-gate-status.json"), JSON.stringify(gateStatus, null, 2));

    if (gateStatus.gate?.user || gateStatus.gate?.draining) {
      throw new Error("检测到用户正在接管或控制队列正在排空，暂避冲突");
    }

    // 3. 通用工具执行器 (严格走 __saCall 生产链路)
    const runCase = async (testCaseName, runnerFn) => {
      const caseDir = join(outDir, testCaseName);
      await mkdir(caseDir, { recursive: true });
      const caseStart = Date.now();
      const sessionId = "main";
      let toolSeq = 0;
      const records = [];

      const rawCall = async (name, params = {}) => {
        const id = `${sessionId}-${++toolSeq}`;
        const t0 = Date.now();
        const res = await evaluateInWorker(
          cdp,
          swSession,
          `globalThis.__saCall(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${JSON.stringify(params)}, ${JSON.stringify(sessionId)})`,
          65000,
        );
        const record = {
          id,
          name,
          params,
          startedAt: t0,
          elapsedMs: Date.now() - t0,
          ...res,
        };
        records.push(record);
        await appendFile(join(caseDir, "tools.jsonl"), JSON.stringify(sanitizeRecord(record)) + "\n");
        return res;
      };

      const toolCall = async (name, params = {}) => {
        const res = await rawCall(name, params);
        if (!res || !res.ok) {
          throw new Error(res?.error || `${name} 执行失败未返回 ok`);
        }
        return res.data;
      };

      console.log(`\n--- [Case: ${testCaseName}] 开始 ---`);
      const caseReport = {
        name: testCaseName,
        passed: false,
        status: "RUNNING",
        startedAt: caseStart,
        elapsedMs: 0,
        checks: [],
        error: null,
      };

      try {
        await runnerFn({ rawCall, toolCall, caseDir, sessionId, caseReport });
        if (caseReport.status !== "NOT_COVERED") {
          caseReport.passed = caseReport.checks.length > 0 && caseReport.checks.every((c) => c.pass);
          caseReport.status = caseReport.passed ? "PASS" : "FAIL";
        }
      } catch (err) {
        caseReport.passed = false;
        caseReport.status = "FAIL";
        caseReport.error = String(err && err.message ? err.message : err);
        console.error(`[Case: ${testCaseName}] 发生异常:`, err);
      } finally {
        caseReport.elapsedMs = Date.now() - caseStart;
        await writeFile(join(caseDir, "case-result.json"), JSON.stringify(caseReport, null, 2));
        suiteResults.push(caseReport);
        console.log(`--- [Case: ${testCaseName}] 完成: ${caseReport.status} (${caseReport.elapsedMs}ms) ---`);
      }
    };

    // 4. 场景执行逻辑

    // 场景 A: screenshot (测试 A1 & A2: 严格切换工作页/前台活动页核对，强制校验 tabId/url，独立解码 PNG)
    if (caseArg === "screenshot" || caseArg === "all") {
      await runCase("screenshot", async ({ toolCall, rawCall, caseDir, caseReport }) => {
        // 打开主工作标签页 ALPHA
        const openPrimary = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const primaryTabId = openPrimary.tabId;

        // 打开干扰标签页 BETA
        const openOther = await toolCall("open_tab", { url: `${origin}/other` });
        const otherTabId = openOther.tabId;

        try {
          // 显式将 session 工作页切回 ALPHA (因为 open_tab(BETA) 会将工作页更改为 BETA)
          await toolCall("switch_tab", { tabId: primaryTabId });

          // 将干扰页 BETA 置为前台活动标签页
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.tabs.update(${otherTabId}, { active: true })`,
          );

          // 验证实际前台活动页确为 BETA
          const activeTabInfo = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.tabs.query({ active: true, currentWindow: true }).then(ts => ts[0])`,
          );
          const activeTabId = activeTabInfo?.id;

          caseReport.checks.push({
            id: "A2_env_active_is_other",
            description: "前台活动标签确为干扰页 BETA，而非工作页 ALPHA",
            pass: activeTabId === otherTabId && activeTabId !== primaryTabId,
            details: { activeTabId, primaryTabId, otherTabId },
          });

          // 读取工作页 ALPHA 的基准视口与 DPR
          const primaryMetrics = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${primaryTabId} }, world: 'MAIN', func: () => window.readViewportMetrics() }).then(r => r[0].result)`,
          );

          // 触发生产截图工具 (单次真实调用)
          const shotRes = await rawCall("screenshot", {});
          if (!shotRes || !shotRes.ok) {
            throw new Error(`screenshot 工具执行失败: ${shotRes?.error || "未返回 ok"}`);
          }
          const shot = shotRes.data;
          caseReport.screenshotMeta = shot;

          // 解码本次所捕获的 PNG 二进制数据
          const pngBuf = Buffer.from(shot.imageBase64 || "", "base64");
          const decoded = decodePngDimensions(pngBuf);

          // 保存本次断言的同一张 PNG 截图文件，严禁二次调用工具
          await writeFile(join(caseDir, "screenshot-work-tab.png"), pngBuf);

          // 断言 A1/A2: tabId/url 必须存在，缺失直接 FAIL，不得跳过
          const hasTabId = shot.tabId != null && typeof shot.tabId === "number";
          const hasUrl = typeof shot.url === "string" && shot.url.length > 0;
          caseReport.checks.push({
            id: "A1_tabId_url_present",
            description: "截图元数据必须包含明确的 tabId 与 url，缺失直接 FAIL",
            pass: hasTabId && hasUrl,
            details: { tabId: shot.tabId, url: shot.url },
          });

          // 断言 A2: 截图归属工作页 ALPHA，而非前台活动页 BETA
          const workTabCorrect = shot.tabId === primaryTabId && shot.url.includes("observation-integrity.html");
          caseReport.checks.push({
            id: "A2_work_tab_not_confused_with_active",
            description: "截图元数据归属于工作页 ALPHA，未截取前台干扰页 BETA",
            pass: workTabCorrect,
            details: { reportedTabId: shot.tabId, primaryTabId, otherTabId, url: shot.url },
          });

          // 断言 A1: 独立解码 PNG 物理像素宽/高 > 0 且与元数据一致
          const decodedValid = decoded != null && decoded.width > 0 && decoded.height > 0;
          const metaMatchesDecoded = decoded != null && shot.width === decoded.width && shot.height === decoded.height;
          caseReport.checks.push({
            id: "A1_independent_png_decoding",
            description: "独立解码 PNG 标头宽高大于零且与元数据完全一致",
            pass: decodedValid && metaMatchesDecoded,
            details: { decoded, metaWidth: shot.width, metaHeight: shot.height },
          });

          // 断言 A1: 物理像素与 CSS 视口 * DPR 对应关系
          const expectedPxW = Math.round(primaryMetrics.innerWidth * primaryMetrics.dpr);
          const expectedPxH = Math.round(primaryMetrics.innerHeight * primaryMetrics.dpr);
          const dimMatches = decoded != null &&
            Math.abs(decoded.width - expectedPxW) <= 4 &&
            Math.abs(decoded.height - expectedPxH) <= 4;
          caseReport.checks.push({
            id: "A1_dpr_viewport_alignment",
            description: "独立解码物理像素与页面 CSS 视口 * DPR 匹配",
            pass: dimMatches,
            details: {
              decoded,
              expected: { width: expectedPxW, height: expectedPxH },
              primaryMetrics,
            },
          });
        } finally {
          await rawCall("close_tab", { tabId: otherTabId }).catch(() => {});
          await rawCall("close_tab", { tabId: primaryTabId }).catch(() => {});
        }
      });
    }

    // 场景 B: viewport (测试 A3: 视口过滤、深层标记隔离与 full_page 对比)
    if (caseArg === "viewport" || caseArg === "all") {
      await runCase("viewport", async ({ toolCall, rawCall, caseReport }) => {
        const opened = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const tabId = opened.tabId;

        try {
          // 1. 首屏视口快照 scope=viewport
          const vpSnapshot1 = await toolCall("snapshot", { scope: "viewport" });
          const vpText1 = vpSnapshot1.text || "";

          const hasInMarker1 = vpText1.includes("MARKER_IN_VIEWPORT_PRIMARY_8819");
          const hasOffMarker1 = vpText1.includes("MARKER_OFF_VIEWPORT_OMEGA_9942");

          caseReport.checks.push({
            id: "A3_viewport_includes_in_marker",
            description: "首屏视口快照包含首屏标记 MARKER_IN_VIEWPORT",
            pass: hasInMarker1,
            details: { hasInMarker1 },
          });

          caseReport.checks.push({
            id: "A3_viewport_filters_off_marker",
            description: "首屏视口快照真实过滤掉视口外的深层标记 MARKER_OFF_VIEWPORT",
            pass: !hasOffMarker1,
            details: { hasOffMarker1 },
          });

          // 2. 全页快照 scope=full_page
          const fullSnapshot = await toolCall("snapshot", { scope: "full_page" });
          const fullText = fullSnapshot.text || "";

          const fullHasIn = fullText.includes("MARKER_IN_VIEWPORT_PRIMARY_8819");
          const fullHasOff = fullText.includes("MARKER_OFF_VIEWPORT_OMEGA_9942");

          caseReport.checks.push({
            id: "A3_full_page_covers_both",
            description: "全页快照同时包含视口内与深层视口外标记",
            pass: fullHasIn && fullHasOff,
            details: { fullHasIn, fullHasOff },
          });

          // 3. 滚动到深层标记后，再次做 scope=viewport 快照
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => document.getElementById('marker-off-viewport')?.scrollIntoView({ block: 'center' }) })`,
          );

          const vpSnapshot2 = await toolCall("snapshot", { scope: "viewport" });
          const vpText2 = vpSnapshot2.text || "";

          const hasInMarker2 = vpText2.includes("MARKER_IN_VIEWPORT_PRIMARY_8819");
          const hasOffMarker2 = vpText2.includes("MARKER_OFF_VIEWPORT_OMEGA_9942");

          caseReport.checks.push({
            id: "A3_viewport_dynamic_after_scroll",
            description: "滚动后视口快照包含深层标记且不包含首屏顶部标记",
            pass: hasOffMarker2 && !hasInMarker2,
            details: { hasOffMarker2, hasInMarker2 },
          });
        } finally {
          await rawCall("close_tab", { tabId }).catch(() => {});
        }
      });
    }

    // 场景 C: click (测试 B1: 单次点击完整性、杜绝双发与防误点)
    if (caseArg === "click" || caseArg === "all") {
      await runCase("click", async ({ toolCall, rawCall, caseReport }) => {
        const opened = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const tabId = opened.tabId;

        try {
          // 重置夹具点击状态
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.resetClickEvidence?.() })`,
          );

          // 执行一次目标点击
          await toolCall("click", { target: "#target-counter" });

          // 读取页面真实事件证据
          const evidence = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.readClickEvidence() }).then(r => r[0].result)`,
          );
          caseReport.evidence = evidence;

          // 断言 B1: 目标计数恰好递增 1 次 (杜绝 dispatchEvent + .click 双发)
          caseReport.checks.push({
            id: "B1_exact_single_click",
            description: "目标按钮只收到一次 click 事件 (targetCount === 1)",
            pass: evidence.targetCount === 1,
            details: { targetCount: evidence.targetCount, targetEvents: evidence.targetEvents },
          });

          // 断言 B1: 旁边干扰计数器未被误点
          caseReport.checks.push({
            id: "B1_no_decoy_misclick",
            description: "紧邻的干扰计数器未被误点 (decoyCount === 0)",
            pass: evidence.decoyCount === 0,
            details: { decoyCount: evidence.decoyCount },
          });

          // 断言 B1: 陷阱与遮挡均未被命中
          caseReport.checks.push({
            id: "B1_no_trap_or_shield",
            description: "陷阱与遮挡未被误点 (trapCount === 0 && shieldCount === 0)",
            pass: evidence.trapCount === 0 && evidence.shieldCount === 0,
            details: { trapCount: evidence.trapCount, shieldCount: evidence.shieldCount },
          });
        } finally {
          await rawCall("close_tab", { tabId }).catch(() => {});
        }
      });
    }

    // 场景 D: move (测试 B2: 确认 isMoved 确实发生，再断言绝不误点原位陷阱)
    if (caseArg === "move" || caseArg === "all") {
      await runCase("move", async ({ toolCall, rawCall, caseReport }) => {
        const opened = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const tabId = opened.tabId;

        try {
          // 激活悬停自动位移: 当光标移入时目标移走，露出底层原位陷阱
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.triggerInterference('moveOnHover', true) })`,
          );

          // 发起点击
          const clickRes = await rawCall("click", { target: "#target-counter" });

          const evidence = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.readClickEvidence() }).then(r => r[0].result)`,
          );
          caseReport.evidence = evidence;
          caseReport.clickRes = clickRes;

          // 关键断言 1: 必须确认 isMoved 确实发生！否则本次位移测试无效
          caseReport.checks.push({
            id: "B2_target_actually_moved",
            description: "确认目标确实发生动态位移 (isMoved === true)",
            pass: evidence.isMoved === true,
            details: { isMoved: evidence.isMoved },
          });

          // 关键断言 2: 绝不可点击原坐标处的陷阱按钮
          caseReport.checks.push({
            id: "B2_no_blind_trap_click",
            description: "目标移开后，严禁盲目向原坐标派发点击击中陷阱 (trapCount === 0)",
            pass: evidence.trapCount === 0,
            details: { trapCount: evidence.trapCount },
          });

          // 关键断言 3: 位移后要么安全拒绝 (ok === false)，要么重新确认后命中 (targetCount === 1) 且无误点
          const handledSafely =
            (clickRes.ok === false && evidence.targetCount === 0 && evidence.decoyCount === 0 && evidence.trapCount === 0) ||
            (clickRes.ok === true && evidence.targetCount === 1 && evidence.decoyCount === 0 && evidence.trapCount === 0);
          caseReport.checks.push({
            id: "B2_reconfirmed_or_safely_aborted",
            description: "位移后要么跟踪命中新目标，要么明确拒绝，杜绝误点与假成功",
            pass: handledSafely,
            details: { ok: clickRes.ok, error: clickRes.error, evidence },
          });
        } finally {
          await rawCall("close_tab", { tabId }).catch(() => {});
        }
      });
    }

    // 场景 E: occlude (测试 B2: 遮挡时必须明确拒绝 ok === false 且 target/decoy/trap/shield 均为 0)
    if (caseArg === "occlude" || caseArg === "all") {
      await runCase("occlude", async ({ toolCall, rawCall, caseReport }) => {
        const opened = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const tabId = opened.tabId;

        try {
          // 触发遮挡层覆盖目标
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.triggerInterference('occlude', true) })`,
          );

          const clickRes = await rawCall("click", { target: "#target-counter" });

          const evidence = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.readClickEvidence() }).then(r => r[0].result)`,
          );
          caseReport.evidence = evidence;
          caseReport.clickRes = clickRes;

          // 关键断言 1: 全目标计数必须均为 0 (严禁点中遮挡层、目标或干扰)
          const zeroClicks =
            evidence.targetCount === 0 &&
            evidence.decoyCount === 0 &&
            evidence.trapCount === 0 &&
            evidence.shieldCount === 0;

          caseReport.checks.push({
            id: "B2_occlusion_zero_clicks",
            description: "被遮挡时全目标计数必须均为 0 (target/decoy/trap/shield === 0)",
            pass: zeroClicks,
            details: {
              targetCount: evidence.targetCount,
              decoyCount: evidence.decoyCount,
              trapCount: evidence.trapCount,
              shieldCount: evidence.shieldCount,
            },
          });

          // 关键断言 2: 遮挡时必须明确拒绝操作 (ok === false)
          caseReport.checks.push({
            id: "B2_occlusion_explicit_reject",
            description: "目标被遮挡不可命中时，点击操作必须明确拒绝 (ok === false)",
            pass: clickRes.ok === false,
            details: { ok: clickRes.ok, error: clickRes.error },
          });
        } finally {
          await rawCall("close_tab", { tabId }).catch(() => {});
        }
      });
    }

    // 场景 F: duplicate (测试 B2: 先用匹配两个同名按钮的选择器证明拒绝/零点击，再用唯一目标成功)
    if (caseArg === "duplicate" || caseArg === "all") {
      await runCase("duplicate", async ({ toolCall, rawCall, caseReport }) => {
        const opened = await toolCall("open_tab", { url: `${origin}/observation-integrity.html` });
        const tabId = opened.tabId;

        try {
          // 插入同名按钮
          await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.triggerInterference('duplicate', true) })`,
          );

          // 第一阶段: 用同时匹配两个同名按钮的选择器发起点击，验证系统拒绝歧义操作且不产生任何点击
          const ambiguousRes = await rawCall("click", { target: "button[aria-label='主计数按钮']" });
          const ambEvidence = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.readClickEvidence() }).then(r => r[0].result)`,
          );

          const ambiguousZeroClicks = ambEvidence.targetCount === 0 && ambEvidence.duplicateCount === 0;
          caseReport.checks.push({
            id: "B2_duplicate_ambiguous_rejected",
            description: "同名多目标歧义选择器必须被明确拒绝且零点击 (ok === false && targetCount === 0 && duplicateCount === 0)",
            pass: ambiguousZeroClicks && ambiguousRes.ok === false,
            details: { ambiguousRes, targetCount: ambEvidence.targetCount, duplicateCount: ambEvidence.duplicateCount },
          });

          // 第二阶段: 使用唯一确定性目标 (#target-counter) 发起点击，验证成功命中主目标
          const exactRes = await toolCall("click", { target: "#target-counter" });
          const exactEvidence = await evaluateInWorker(
            cdp,
            swSession,
            `chrome.scripting.executeScript({ target: { tabId: ${tabId} }, world: 'MAIN', func: () => window.readClickEvidence() }).then(r => r[0].result)`,
          );

          caseReport.evidence = exactEvidence;
          caseReport.checks.push({
            id: "B2_duplicate_exact_succeeded",
            description: "通过唯一目标精确定位时成功命中且仅命中主目标 (targetCount === 1 && duplicateCount === 0)",
            pass: exactEvidence.targetCount === 1 && exactEvidence.duplicateCount === 0,
            details: { targetCount: exactEvidence.targetCount, duplicateCount: exactEvidence.duplicateCount, exactRes },
          });
        } finally {
          await rawCall("close_tab", { tabId }).catch(() => {});
        }
      });
    }

    // 场景 G: handback (真实模型与会话状态交还由 Codex 编排复核，标记为 NOT_COVERED)
    if (caseArg === "handback" || caseArg === "all") {
      await runCase("handback", async ({ caseReport }) => {
        caseReport.status = "NOT_COVERED";
        caseReport.passed = null;
        caseReport.note =
          "同会话多任务接管交还 (B3) 涉及真实模型推理、侧栏交互与恢复上下文，由 Codex 编排统一执行复核，本夹具套件不伪造通过。";
        console.log(`[Antigravity] Case handback 标为 NOT_COVERED (归属 Codex 编排复核)`);
      });
    }

    // 汇总结果
    const coveredResults = suiteResults.filter((r) => r.status !== "NOT_COVERED");
    const suitePassed = coveredResults.length > 0 && coveredResults.every((r) => r.passed);
    const finalReport = {
      suitePassed,
      case: caseArg,
      totalCases: suiteResults.length,
      coveredCases: coveredResults.length,
      passedCases: coveredResults.filter((r) => r.passed).length,
      failedCases: coveredResults.filter((r) => !r.passed).length,
      notCoveredCases: suiteResults.filter((r) => r.status === "NOT_COVERED").map((r) => r.name),
      results: suiteResults,
      uncoveredNotice: {
        A2_cdp_fault_fallback: "NOT_COVERED (需编排统一注入 CDP 故障边界)",
        B1_dom_fallback: "NOT_COVERED (生产优先走 CDP，DOM 兜底路径需编排统一注入故障)",
        B3_model_handback: "NOT_COVERED (真实模型同会话多任务由 Codex 编排统一复核)",
      },
      elapsedMs: Date.now() - startedAt,
      evidenceDir: outDir,
    };

    await writeFile(join(outDir, "result.json"), JSON.stringify(finalReport, null, 2));
    console.log("\n==========================================");
    console.log(`[Antigravity] 套件执行总结: ${suitePassed ? "PASS" : "FAIL"}`);
    console.log(`已覆盖项通过率: ${finalReport.passedCases}/${finalReport.coveredCases}`);
    console.log(`未覆盖交由编排项: ${finalReport.notCoveredCases.join(", ") || "无"}`);
    console.log(`报告与证据输出目录: ${outDir}`);
    console.log("==========================================");

    process.exitCode = suitePassed ? 0 : 1;
  } catch (err) {
    console.error("[Antigravity] 套件运行发生未捕获致命错误:", err);
    await writeFile(
      join(outDir, "result.json"),
      JSON.stringify({ suitePassed: false, fatalError: String(err) }, null, 2),
    );
    process.exitCode = 1;
  } finally {
    if (cdp) {
      await cdp.close().catch(() => {});
    }
    await fixtureServer.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
