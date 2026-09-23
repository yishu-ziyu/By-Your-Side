/**
 * 浏览器能力对齐 E2E（Issue: Browser Capability Parity with EGO Lite）七案驱动。
 * 只通过 globalThis.__saCall（= uplink.handleRaw → executeToolCall → gate.run → handlers）
 * 走真实 Harness：working tab、control gate、execution ledger、observation 约束全部生效。
 * 不在这里重写任何被测能力本身。
 */
export async function parityDriver(opts) {
  const started = Date.now();
  const out = {
    tabId: null,
    stage: "init",
    error: null,
    cases: {},
    receipts: {},
    snapshots: {},
    durationsMs: {},
    startedAt: started,
    elapsedMs: 0,
  };
  const call = globalThis.__saCall;
  if (typeof call !== "function") {
    out.stage = "hook";
    out.error = "__saCall 不存在：未进入 executeToolCall";
    out.elapsedMs = Date.now() - started;
    return out;
  }
  const sid = opts.sessionId || "acpt-parity";
  let seq = 0;

  async function raw(step, name, params, identity) {
    const id = "parity-" + name + "-" + ++seq;
    const t0 = Date.now();
    const msg = await call(id, name, params, sid, undefined, undefined, identity);
    out.durationsMs[step] = (out.durationsMs[step] || 0) + (Date.now() - t0);
    if (!msg || msg.type !== "tool_result") throw new Error(name + " 未回 tool_result");
    return msg;
  }
  async function ok(step, name, params) {
    const msg = await raw(step, name, params);
    if (msg.ok === false) throw new Error(name + " 失败: " + msg.error);
    const data = msg.data;
    if (data && typeof data === "object" && data.held === true) {
      throw new Error(name + " 被危险确认拦住，未真正执行");
    }
    return data;
  }
  async function expectFail(step, name, params, needle, identity) {
    const msg = await raw(step, name, params, identity);
    if (msg.ok !== false) throw new Error(name + " 本应被拦截却成功返回");
    const error = String(msg.error || "");
    if (needle && !error.includes(needle)) {
      throw new Error(name + " 拦截信息不符，期望包含「" + needle + "」，实际: " + error);
    }
    return error;
  }
  function refFor(snap, needle) {
    const line = String(snap || "").split("\n").find(function (l) { return l.includes(needle) && l.includes("[ref="); });
    if (!line) return null;
    const m = line.match(/\[ref=(\d+)\]/);
    return m ? "@" + m[1] : null;
  }

  try {
    out.stage = "open_tab";
    const opened = await ok("open_tab", "open_tab", { url: opts.url });
    if (!opened || opened.tabId == null) throw new Error("open_tab 未返回 tabId");
    out.tabId = opened.tabId;

    out.stage = "snapshot0";
    const snap = await ok("snapshot0", "snapshot", {});
    out.snapshots.before = snap.text || "";
    out.snapshots.tabId = snap.tabId ?? null;

    // ── Case 6：统一 target —— 同一元素经 @ref / loc=css: / xpath= / text= 执行等价动作 ──
    out.stage = "case6-unified-target";
    out.receipts.c6 = [];
    const tabsAfterSnap = await ok("c6-tabs-0", "list_tabs", { });
    out.cases.case6pre = {
      parityAlive: (tabsAfterSnap.tabs || []).some(function (t) { return t.id === out.tabId; }),
      workingIsParity: (tabsAfterSnap.tabs || []).some(function (t) { return t.id === out.tabId && t.working === true; }),
      tabIds: (tabsAfterSnap.tabs || []).map(function (t) { return t.id; }),
      snapshotTabId: out.snapshots.tabId ?? null,
      parityTabId: out.tabId,
    };
    // 防倒退认领：工作页一旦不是本次打开的 fixture 页，立即停手，绝不落到“认领当前活动页”。
    if (!out.cases.case6pre.parityAlive || out.snapshots.tabId !== out.tabId) {
      throw new Error("Case 0：工作页不是本次打开的 fixture 页（alive=" + out.cases.case6pre.parityAlive + "，snapshotTab=" + out.snapshots.tabId + "，parityTab=" + out.tabId + "），停止操作");
    }
    const ranProbe = await ok("c6-script-probe", "js", { code: "window.__parityRan === true" });
    if (ranProbe.value !== true) {
      const tabsNow = await ok("c6-tabs-1", "list_tabs", { });
      out.cases.case6tabs = (tabsNow.tabs || []).map(function (t) { return { id: t.id, url: t.url, working: t.working }; });
      let diagTab = null, diagTabError = null;
      try { diagTab = await ok("c6-script-diag-tab", "js", { code: "JSON.stringify({href: location.href, ran: window.__parityRan === true})", tabId: out.tabId }); }
      catch (e) { diagTabError = e && e.message ? e.message : String(e); }
      const diag = await ok("c6-script-diag", "js", { code: "JSON.stringify({href: location.href, title: document.title, ran: window.__parityRan === true, scripts: document.scripts.length})" });
      out.cases.case6 = { scriptRan: false, diag: diag.value, diagTab: diagTab ? diagTab.value : null, diagTabError: diagTabError, tabs: out.cases.case6tabs };
      throw new Error("Case 0：fixture 脚本未执行或 tab 消失；diagTabError=" + diagTabError + "；diag=" + diag.value + "；tabs=" + JSON.stringify(out.cases.case6tabs));
    }
    const ref = refFor(out.snapshots.before, "计数按钮");
    if (!ref) throw new Error("snapshot 里找不到「计数按钮」的 [ref=N]，无法测 @ref 路径");
    const countTrace = [];
    for (const [step, target] of [["c6-ref", ref], ["c6-css", "loc=css:#count-btn"], ["c6-xpath", "xpath=//button[@id='count-btn']"], ["c6-text", "text=计数按钮"]]) {
      const clickData = await ok(step, "click", { target });
      out.receipts.c6.push({ target: target, data: clickData });
      const probe = await ok(step + "-count", "js", { code: "document.getElementById('count').textContent" });
      countTrace.push(probe.value);
    }
    const countAfter4 = await ok("c6-read", "read_element", { target: "#count" });
    out.cases.case6 = { scriptRan: true, ref: ref, countTrace: countTrace, countAfterFourClicks: countAfter4.textContent };
    if (String(countAfter4.textContent) !== "4") {
      throw new Error("Case 6 等价动作失败：四种 target 各点一次后期望 4，实际 " + countAfter4.textContent);
    }

    // ── Case 1：真实双击 —— 可见状态只由 dblclick 改变 ──
    out.stage = "case1-double-click";
    const dblBefore = await ok("c1-before", "read_element", { target: "#dblmsg" });
    const control = await ok("c1-control-click", "click", { target: "#dblzone" });
    const dblAfterControl = await ok("c1-after-control", "read_element", { target: "#dblmsg" });
    if (String(dblAfterControl.textContent || "") !== "") {
      throw new Error("Case 1 对照失败：单击后可见状态不应改变，实际 " + dblAfterControl.textContent);
    }
    const dbl = await ok("c1-double-click", "double_click", { target: "#dblzone", label: "双击区" });
    const dblAfter = await ok("c1-after", "read_element", { target: "#dblmsg" });
    if (!/^DOUBLE-/.test(String(dblAfter.textContent || ""))) {
      throw new Error("Case 1 失败：double_click 后可见状态未改变，dblmsg=" + dblAfter.textContent);
    }
    out.receipts.c1 = { control: control, doubleClick: dbl, dblmsg: dblAfter.textContent };
    out.cases.case1 = { before: dblBefore.textContent, afterControl: dblAfterControl.textContent, afterDouble: dblAfter.textContent };

    // ── Case 2：真实拖拽 —— 卡片跨槽 + 原生滑杆 ──
    out.stage = "case2-drag";
    const slotBefore = await ok("c2-slot-before", "read_element", { target: "#slot-b" });
    const cardDrag = await ok("c2-card-drag", "drag", {
      from: { target: "#dragcard" },
      to: { target: "#slot-b" },
      label: "卡片拖到B槽",
    });
    const slotAfter = await ok("c2-slot-after", "read_element", { target: "#dragcard" });
    const cardMoved = String(slotAfter.textContent || "").includes("已到B");

    const rectMsg = await ok("c2-slider-rect", "js", {
      code: "(()=>{const r=document.getElementById('slider').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()",
    });
    const rect = rectMsg.value;
    if (!rect || typeof rect.w !== "number") throw new Error("Case 2 读取 slider rect 失败");
    const sliderDrag = await ok("c2-slider-drag", "drag", {
      from: { target: "#slider" },
      to: { point: [Math.round(rect.x + rect.w - 4), Math.round(rect.y + rect.h / 2)] },
      label: "拖动滑杆",
    });
    const sliderVal = await ok("c2-slider-value", "read_element", { target: "#sliderval" });
    const sliderNum = Number(sliderVal.textContent);
    if (!cardMoved) throw new Error("Case 2 卡片拖拽失败：卡片未进入 B 槽");
    if (!(sliderNum >= 50)) throw new Error("Case 2 滑杆拖拽失败：值 " + sliderVal.textContent + " < 50");
    out.cases.case2 = { cardMoved: cardMoved, sliderValue: sliderNum, slotBeforeText: String(slotBefore.textContent || "").slice(0, 40) };
    out.receipts.c2 = { cardDrag: cardDrag, sliderDrag: sliderDrag };

    // ── Case 3：文件上传（授权路径），读回 files 列表与页面 input/change 状态 ──
    out.stage = "case3-upload";
    const up = await ok("c3-upload", "upload_file", { target: "#file", paths: [opts.uploadPath] });
    const upmsg = await ok("c3-upmsg", "read_element", { target: "#upmsg" });
    const expectedName = opts.uploadName;
    const fileOk = up.files && up.files.length === 1 && up.files[0].name === expectedName;
    const msgOk = String(upmsg.textContent) === "UP:1:" + expectedName;
    if (!fileOk) throw new Error("Case 3 读回不符: " + JSON.stringify(up.files));
    if (!msgOk) throw new Error("Case 3 页面 input/change 状态不符: " + upmsg.textContent);
    out.cases.case3 = { files: up.files, pageState: upmsg.textContent, documentId: up.documentId || null };
    out.receipts.c3 = up;

    // ── Case 4：无专用 helper 的只读 CDP 方法经 escape hatch 可达 ──
    out.stage = "case4-cdp-read";
    const cdpRead = await ok("c4-cdp", "cdp", { method: "Page.getLayoutMetrics" });
    const metrics = cdpRead.result || {};
    if (cdpRead.truncated !== false || !metrics.cssVisualViewport && !metrics.layoutViewport) {
      throw new Error("Case 4 结果不符: " + JSON.stringify(cdpRead).slice(0, 200));
    }
    out.cases.case4 = { method: "Page.getLayoutMetrics", truncated: cdpRead.truncated, keys: Object.keys(metrics).slice(0, 8) };
    out.receipts.c4 = { resultKeys: Object.keys(metrics) };

    // ── Case 5：边界 —— 非 working tab / 越权 method / stale run 身份 ──
    out.stage = "case5-boundaries";
    const other = await ok("c5-open-other", "open_tab", { url: opts.otherUrl });
    const otherTab = other && other.tabId;
    const nonWorkingError = await expectFail("c5-nonworking", "cdp", { tabId: out.tabId, method: "Page.getLayoutMetrics" }, "只能操作当前工作标签页");
    const deniedError = await expectFail("c5-denied-method", "cdp", { method: "Browser.close" }, "被拒绝");
    // 越权调用没有真的关掉浏览器：后续只读 CDP 仍然可达。
    await ok("c5-alive", "cdp", { method: "Page.getLayoutMetrics" });
    const staleRunError = await expectFail(
      "c5-stale-run",
      "snapshot",
      {},
      "原任务已停止或发生变化",
      { runId: "acpt-foreign-run", epochs: undefined },
    );
    await ok("c5-close-other", "close_tab", { tabId: otherTab });
    const back = await ok("c5-switch-back", "switch_tab", { tabId: out.tabId });
    out.cases.case5 = {
      nonWorkingTabBlocked: true,
      deniedMethodBlocked: true,
      browserStillAlive: true,
      staleRunBlocked: true,
      errors: { nonWorking: nonWorkingError, denied: deniedError, staleRun: staleRunError },
      restoredWorkingTab: back.tabId === out.tabId,
    };

    out.stage = "case7-pending";
    // Case 7 由 runner 用生产 runBrowserProgram 执行（browser_run 不是扩展 RPC）；
    // 驱动在这里只保留工作页不关，等 runner 跑完组合程序后再关。
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  } finally {
    if (out.tabId != null && out.stage === "done") {
      // 只有全部 1–6 案成功才把关页留给 runner；失败路径立刻自清理。
    }
    if (out.tabId != null && out.stage !== "case7-pending") {
      try {
        await call("parity-close-" + Date.now(), "close_tab", { tabId: out.tabId }, sid);
      } catch { /* 标签可能已关 */ }
    }
    out.elapsedMs = Date.now() - started;
  }
  return out;
}

/** Case 7 的组合程序：由 runner 在生产同一份 runBrowserProgram 模块里执行，子调用经 __saCall 转发进真实 Harness。 */
export const CASE7_CODE = [
  "const info = await browser.pageInfo();",
  "await browser.waitFor({ selector: 'text=计数按钮', timeoutMs: 3000 });",
  "const before = await browser.read_element({ target: '#count' });",
  "await browser.fill({ target: '#name', value: '组合验证' });",
  "await browser.click({ target: 'text=计数按钮' });",
  "await browser.doubleClick({ target: 'loc=css:#dblzone' });",
  "const after = await browser.read_element({ target: '#count' });",
  "const dbl = await browser.read_element({ target: '#dblmsg' });",
  "const name = await browser.read_element({ target: '#name' });",
  "return { tabId: info.tabId, readyState: info.page && info.page.readyState, before: before.textContent, after: after.textContent, dbl: dbl.textContent, name: name.value };",
].join("\n");

export function buildParityExpression(opts) {
  return `(${parityDriver.toString()})(${JSON.stringify(opts)})`;
}
