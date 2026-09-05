/**
 * 把活的 uplink.handleRaw 挂到 SW globalThis.__saCall。
 * 生产代码没有导出 executeToolCall；唯一外部可达路径是：
 * Debugger 在模块顶层 listener 里 paused → evaluateOnCallFrame 看见闭包里的 uplink
 * → handleRaw(tool_call) → onServerMessage → executeToolCall → gate.run → handlers。
 *
 * 触发用无副作用的 runtime.sendMessage（不是 mark_action / handback_click）。
 */
export const HOOK_EXPRESSION = `(() => {
  if (typeof uplink === "undefined" || typeof uplink.handleRaw !== "function") {
    return { ok: false, error: "module scope missing uplink.handleRaw" };
  }
  if (typeof executeToolCall !== "function") {
    return { ok: false, error: "module scope missing executeToolCall" };
  }
  function installTeam() {
    if (typeof handleTakeover === "function") globalThis.__saTakeover = handleTakeover;
    if (typeof handleHandback === "function") globalThis.__saHandback = handleHandback;
    if (!globalThis.__saClientWrap) {
      const current = uplink.sendClientMessage.bind(uplink);
      uplink.sendClientMessage = function (msg) {
        if (msg && (msg.type === "takeover" || msg.type === "handback")) {
          globalThis.__saLastClient = clipControlFrame(msg);
        }
        return current(msg);
      };
      globalThis.__saClientWrap = true;
    }
    if (!globalThis.__saServerWrap) {
      const raw = uplink.handleRaw.bind(uplink);
      uplink.handleRaw = function (incoming) {
        try {
          const msg = typeof incoming === "string" ? JSON.parse(incoming) : incoming;
          if (msg && (msg.type === "control_result" || msg.type === "team_status" || msg.type === "acceptance_team_ready" || msg.type === "acceptance_team_evidence")) {
            globalThis.__saLastServer = msg;
            if (!Array.isArray(globalThis.__saServerEvents)) globalThis.__saServerEvents = [];
            globalThis.__saServerEvents.push(msg);
          }
        } catch (e) {}
        return raw(incoming);
      };
      globalThis.__saServerWrap = true;
    }
    globalThis.__saGate = function () {
      const blocked = {};
      if (typeof gate !== "undefined" && gate && typeof gate.sessionOwners === "function") {
        Object.assign(blocked, gate.sessionOwners());
      }
      return {
        owner: typeof gate !== "undefined" ? gate.control : null,
        draining: typeof gate !== "undefined" ? gate.isDraining : null,
        user: typeof gate !== "undefined" ? gate.isUser() : null,
        sessions: blocked,
      };
    };
    globalThis.__saTeamView = function () {
      return typeof team !== "undefined" && team && typeof team.view === "function" ? team.view() : null;
    };
    globalThis.__saAbortGate = function () {
      if (typeof gate !== "undefined" && gate && typeof gate.abort === "function") gate.abort();
      if (typeof team !== "undefined" && team && typeof team.clear === "function") team.clear();
    };
    globalThis.__saPrepareTeam = function (capability, workerId, tabId, leadTask, workerTask) {
      const requestId = "accept-team-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      globalThis.__saLastServer = null;
      globalThis.__saServerEvents = [];
      if (!uplink.sendClientMessage({
        type: "acceptance_prepare_team",
        requestId: requestId,
        capability: capability,
        worker: { sessionId: workerId, tabId: tabId },
        tasks: { lead: leadTask, worker: workerTask }
      })) return Promise.reject(new Error("验收装配消息没有发给 Agent"));
      return new Promise(function (resolve, reject) {
        const started = Date.now();
        const timer = setInterval(function () {
          const msg = (globalThis.__saServerEvents || []).find(function (event) {
            return event && event.type === "acceptance_team_ready" && event.requestId === requestId;
          });
          if (msg && msg.type === "acceptance_team_ready" && msg.requestId === requestId) {
            clearInterval(timer);
            if (msg.ok) resolve(msg);
            else reject(new Error(msg.reason || "Agent 验收装配失败"));
            return;
          }
          if (Date.now() - started > 15000) {
            clearInterval(timer);
            reject(new Error("等待 Agent 验收装配超时"));
          }
        }, 40);
      });
    };
    if (typeof handleAbort === "function") globalThis.__saAbortTeam = handleAbort;
  }
  if (typeof globalThis.__saCall === "function") {
    installTeam();
    return { ok: true, already: true, team: typeof globalThis.__saTakeover === "function" };
  }
  function clipControlFrame(msg) {
    if (!msg || (msg.type !== "takeover" && msg.type !== "handback")) return msg;
    const needles = [
      "page-mark-user-lead",
      "page-mark-user-wiki",
      "page-mark-lead",
      "page-mark-wiki",
      "SIDEAGENT_ACCEPTANCE_UNIQUE_TEXT_20260904",
    ];
    function clipSnap(snap) {
      if (typeof snap !== "string") return "";
      return needles.filter((n) => snap.includes(n)).join("\\n");
    }
    if (msg.type === "takeover") {
      return {
        type: msg.type,
        requestId: msg.requestId,
        groupId: msg.groupId,
        generation: msg.generation,
        members: Array.isArray(msg.members)
          ? msg.members.map((m) => ({
              sessionId: m.sessionId,
              role: m.role,
              activity: m.activity,
              tabId: m.tabId,
              title: String(m.title || "").slice(0, 80),
              url: String(m.url || "").slice(0, 160)
            }))
          : [],
      };
    }
    return {
      type: msg.type,
      requestId: msg.requestId,
      members: Array.isArray(msg.members)
        ? msg.members.map((m) => ({
            sessionId: m.sessionId,
            closed: !!m.closed,
            reason: m.reason,
            capturedAt: m.capturedAt,
            context: m.context
              ? { tabId: m.context.tabId, title: String(m.context.title || "").slice(0, 80), url: String(m.context.url || "").slice(0, 160) }
              : undefined,
            snapshot: clipSnap(m.snapshot),
          }))
        : [],
    };
  }
  const orig = uplink.sendClientMessage.bind(uplink);
  const waiters = new Map();
  uplink.sendClientMessage = function (msg) {
    if (msg && (msg.type === "takeover" || msg.type === "handback")) {
      globalThis.__saLastClient = clipControlFrame(msg);
    }
    if (msg && msg.type === "tool_result" && waiters.has(msg.id)) {
      const resolve = waiters.get(msg.id);
      waiters.delete(msg.id);
      resolve(msg);
    }
    return orig(msg);
  };
  globalThis.__saClientWrap = true;
  globalThis.__saCall = function (id, name, params, sessionId) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(function () {
        waiters.delete(id);
        reject(new Error("tool_call timeout: " + name));
      }, 30000);
      waiters.set(id, function (msg) {
        clearTimeout(timer);
        resolve(msg);
      });
      uplink.handleRaw({
        type: "tool_call",
        id: id,
        name: name,
        params: params || {},
        sessionId: sessionId
      });
    });
  };
  installTeam();
  return { ok: true, already: false, team: typeof globalThis.__saTakeover === "function" };
})()`;

/**
 * 扩展热重载后 Chrome 偶尔会把旧 inspector domain 状态留在 SW target 上，
 * 直接 Runtime.enable / Debugger.enable 会一直等到超时。新 attach 先恢复并关闭
 * 这些 domain，后面的 hook 再按需要重新启用；不修改扩展或业务状态。
 */
export async function normalizeServiceWorkerInspector(cdp, sessionId) {
  for (const method of ["Runtime.runIfWaitingForDebugger", "Debugger.resume", "Debugger.disable", "Runtime.disable"]) {
    try {
      await cdp.send(method, {}, sessionId, 5_000);
    } catch {
      // resume 在未暂停时会正常报错；冷启动恢复应继续。
    }
  }
}

function scriptUrl(extensionId) {
  return `chrome-extension://${extensionId}/background.js`;
}

async function findBackgroundScript(cdp, sessionId, extensionId) {
  const wanted = scriptUrl(extensionId);
  /** @type {string | null} */
  let scriptId = null;
  const off = cdp.onEvent("Debugger.scriptParsed", (m) => {
    const info = m.params ?? {};
    const url = info.url ?? "";
    if (url.split("?")[0] === wanted) scriptId = info.scriptId;
  });
  await cdp.send("Debugger.enable", {}, sessionId);
  await new Promise((r) => setTimeout(r, 150));
  off();
  if (scriptId) return scriptId;
  throw new Error("Debugger 未看到 SideAgent background.js；service worker 可能未醒");
}

async function listenerBodyLines(cdp, sessionId, scriptId) {
  const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId }, sessionId);
  const lines = String(scriptSource ?? "").split("\n");
  const needles = ["chrome.runtime.onMessage.addListener", "chrome.runtime.onConnect.addListener"];
  const out = [];
  for (const needle of needles) {
    const idx = lines.findIndex((l) => l.includes(needle));
    if (idx >= 0) out.push(idx + 1);
  }
  if (out.length === 0) throw new Error("background.js 里找不到 onMessage/onConnect listener");
  return out;
}

async function hookOnPausedFrame(cdp, sessionId, paused) {
  const frames = paused.params?.callFrames ?? [];
  let lastErr = "no call frames";
  for (const frame of frames) {
    const id = frame.callFrameId;
    if (!id) continue;
    const probed = await cdp.send(
      "Debugger.evaluateOnCallFrame",
      { callFrameId: id, expression: HOOK_EXPRESSION, returnByValue: true },
      sessionId,
    );
    if (probed.exceptionDetails) {
      lastErr =
        probed.exceptionDetails.exception?.description ??
        probed.exceptionDetails.text ??
        "evaluateOnCallFrame exception";
      continue;
    }
    const value = probed.result?.value;
    if (value && value.ok) return value;
    if (value && value.error) lastErr = value.error;
  }
  throw new Error(`无法在暂停帧里拿到 uplink.handleRaw / executeToolCall：${lastErr}`);
}

function triggerExpression(probeUrl) {
  return `void (async () => {
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(probeUrl)}, active: false });
    await new Promise((r) => setTimeout(r, 400));
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => { chrome.runtime.sendMessage({ type: "sideagent-accept-probe" }); }
      });
    } finally {
      try { await chrome.tabs.remove(tab.id); } catch (e) {}
    }
  })()`;
}

/**
 * 在已 attach 的 SideAgent SW 上安装 __saCall。
 * 触发：在 127.0.0.1 fixture 标签的 isolated world 发 runtime.sendMessage
 * （SW 自己 sendMessage 不会进本 SW 的 onMessage）。
 */
export async function installExecuteToolCallHook(cdp, sessionId, extensionId, probeUrl) {
  if (!probeUrl) throw new Error("installExecuteToolCallHook 需要本地 probeUrl");
  const already = await cdp.send(
    "Runtime.evaluate",
    { expression: "typeof globalThis.__saCall", returnByValue: true },
    sessionId,
  );
  if (already.result?.value === "function") return { ok: true, already: true };

  const scriptId = await findBackgroundScript(cdp, sessionId, extensionId);
  const lines = await listenerBodyLines(cdp, sessionId, scriptId);
  const breakpointIds = [];
  for (const lineNumber of lines) {
    const bp = await cdp.send(
      "Debugger.setBreakpoint",
      { location: { scriptId, lineNumber } },
      sessionId,
    );
    if (bp.breakpointId) breakpointIds.push(bp.breakpointId);
  }
  if (breakpointIds.length === 0) throw new Error("setBreakpoint 未返回 breakpointId");

  try {
    const pausedP = cdp.waitForEvent("Debugger.paused", 12_000);
    await cdp.send(
      "Runtime.evaluate",
      { expression: triggerExpression(probeUrl), awaitPromise: false, returnByValue: true },
      sessionId,
    );
    let paused;
    try {
      paused = await pausedP;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(
        `无法把 SW 停在生产 onMessage 里以进入 executeToolCall 闭包（${msg}）。` +
          "SW 自己发 sendMessage 进不了本进程 listener；需要已加载扩展对 127.0.0.1 fixture 注入 content script。",
      );
    }
    const hooked = await hookOnPausedFrame(cdp, sessionId, paused);
    await cdp.send("Debugger.resume", {}, sessionId);
    const kind = await cdp.send(
      "Runtime.evaluate",
      { expression: "typeof globalThis.__saCall", returnByValue: true },
      sessionId,
    );
    if (kind.result?.value !== "function") {
      throw new Error("钩子安装后 globalThis.__saCall 仍不可用");
    }
    return hooked;
  } finally {
    for (const breakpointId of breakpointIds) {
      try {
        await cdp.send("Debugger.removeBreakpoint", { breakpointId }, sessionId);
      } catch {
        /* 忽略 */
      }
    }
    try {
      await cdp.send("Debugger.resume", {}, sessionId);
    } catch {
      /* 未暂停 */
    }
  }
}
