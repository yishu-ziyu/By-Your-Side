/**
 * 把活的 uplink.handleRaw 挂到 SW globalThis.__saCall。
 * 生产代码没有导出 executeToolCall；唯一外部可达路径是：
 * Debugger 在模块顶层 listener 里 paused → evaluateOnCallFrame 看见闭包里的 uplink
 * → handleRaw(tool_call) → onServerMessage → executeToolCall → gate.run → handlers。
 *
 * 触发用无副作用的 runtime.sendMessage（不是 mark_action / handback_click）。
 */
export const HOOK_EXPRESSION = `(() => {
  const rawTransport = typeof transport !== "undefined" && transport ? transport : null;
  const scopedUplink = typeof uplink !== "undefined" && uplink ? uplink : null;
  const incoming = rawTransport && typeof rawTransport.handleRaw === "function"
    ? rawTransport.handleRaw.bind(rawTransport)
    : scopedUplink && typeof scopedUplink.handleRaw === "function"
      ? scopedUplink.handleRaw.bind(scopedUplink)
      : null;
  const outgoing = rawTransport && typeof rawTransport.sendClientMessage === "function"
    ? rawTransport
    : scopedUplink;
  if (!incoming || !outgoing || typeof outgoing.sendClientMessage !== "function") {
    return { ok: false, error: "module scope missing transport/uplink raw path" };
  }
  if (typeof executeToolCall !== "function") {
    return { ok: false, error: "module scope missing executeToolCall" };
  }
  function recordServer(msg) {
    if (!msg || typeof msg.type !== "string") return;
    globalThis.__saLastServer = msg;
    if (!Array.isArray(globalThis.__saServerEvents)) globalThis.__saServerEvents = [];
    globalThis.__saServerEvents.push(msg);
  }
  function installTeam() {
    if (typeof handleTakeover === "function") {
      globalThis.__saTakeover = async function (tabId) {
        try {
          await handleTakeover(tabId, undefined, tabId == null);
          return { ok: true, gate: globalThis.__saGate() };
        } catch (error) {
          return { ok: false, error: String(error && error.message ? error.message : error), gate: globalThis.__saGate() };
        }
      };
    }
    globalThis.__saTakeoverProbe = async function () {
      const members = typeof localActiveMembers === "function" ? await localActiveMembers() : [];
      return {
        n: members.length,
        lastStatus: typeof lastStatus !== "undefined" ? lastStatus : null,
        lead: typeof LEAD_SESSION_ID !== "undefined" ? LEAD_SESSION_ID : null,
        keys: typeof statusBySession !== "undefined" && statusBySession ? [...statusBySession.keys()] : [],
      };
    };
    if (typeof handleHandback === "function") globalThis.__saHandback = handleHandback;
    if (!globalThis.__saClientWrap) {
      const current = outgoing.sendClientMessage.bind(outgoing);
      outgoing.sendClientMessage = function (msg) {
        if (msg && (msg.type === "takeover" || msg.type === "handback")) {
          globalThis.__saLastClient = clipControlFrame(msg);
        }
        return current(msg);
      };
      globalThis.__saClientWrap = true;
    }
    if (!globalThis.__saServerWrap) {
      if (rawTransport && rawTransport.handlers && typeof rawTransport.handlers.onServerMessage === "function") {
        const onServerMessage = rawTransport.handlers.onServerMessage.bind(rawTransport.handlers);
        rawTransport.handlers.onServerMessage = function (msg) {
          recordServer(msg);
          return onServerMessage(msg);
        };
      } else if (scopedUplink && typeof scopedUplink.handleRaw === "function") {
        const raw = scopedUplink.handleRaw.bind(scopedUplink);
        scopedUplink.handleRaw = function (value) {
          try { recordServer(typeof value === "string" ? JSON.parse(value) : value); } catch (e) {}
          return raw(value);
        };
      }
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
    globalThis.__saResetControl = function () {
      if (typeof pendingControl !== "undefined" && pendingControl) {
        try { pendingControl.timeout.clear(); } catch (e) {}
        pendingControl = null;
      }
      if (typeof gate !== "undefined" && gate && typeof gate.abort === "function") gate.abort();
      if (typeof team !== "undefined" && team && typeof team.clear === "function") team.clear();
    };
    globalThis.__saMarkRunning = function () {
      lastStatus = "running";
      if (typeof statusBySession !== "undefined" && statusBySession && typeof statusBySession.set === "function") {
        statusBySession.set("main", "running");
      }
    };
    globalThis.__saPrepareTeam = function (capability, workerId, tabId, leadTask, workerTask) {
      const requestId = "accept-team-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8);
      globalThis.__saLastServer = null;
      globalThis.__saServerEvents = [];
      if (!outgoing.sendClientMessage({
        type: "acceptance_prepare_team",
        requestId: requestId,
        capability: capability,
        worker: { sessionId: workerId, tabId: tabId },
        tasks: { lead: leadTask, worker: workerTask },
        ...(globalThis.__saAcceptanceConversationId ? { conversationId: globalThis.__saAcceptanceConversationId } : {})
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
    globalThis.__saSendClient = function (msg) { return outgoing.sendClientMessage(msg); };
    // 隔离验收观察真实面板的授权选择，不记录请求正文或其它用户消息。
    if (!globalThis.__saConsentClientHook) {
      const sendClient = outgoing.sendClientMessage.bind(outgoing);
      globalThis.__saConsentClientFrames = [];
      outgoing.sendClientMessage = function (msg) {
        if (msg && (msg.type === "consent_decision" || msg.type === "consent_list")) {
          globalThis.__saConsentClientFrames.push(msg);
        }
        return sendClient(msg);
      };
      globalThis.__saConsentClientHook = true;
    }
    if (typeof workerTabControl !== "undefined" && !globalThis.__saClaimHook) {
      const manage = workerTabControl.manage.bind(workerTabControl);
      workerTabControl.manage = function (params, key, discard, canTake) {
        let checks = 0;
        return manage(params, key, discard, async function (keys) {
          if (canTake) await canTake(keys);
          if (params.action === "claim" && globalThis.__saPauseClaim && ++checks === 2) {
            globalThis.__saClaimPaused = true;
            await new Promise(resolve => { globalThis.__saResumeClaim = resolve; });
            globalThis.__saClaimPaused = false;
          }
        });
      };
      globalThis.__saClaimHook = true;
    }
    globalThis.__saHandleServer = function (msg) {
      incoming(typeof msg === "string" ? msg : JSON.stringify(msg));
      return { ok: true };
    };
    globalThis.__saDeliverUser = function (delivery) {
      if (typeof broadcastVisibleServer === "function") {
        broadcastVisibleServer({ type: "agent_event", event: { kind: "user_delivery", delivery } });
        return { ok: true, via: "broadcast" };
      }
      incoming(JSON.stringify({
        type: "agent_event",
        conversationId: delivery.conversationId,
        event: { kind: "user_delivery", delivery },
      }));
      return { ok: true, via: "raw" };
    };
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
  const orig = outgoing.sendClientMessage.bind(outgoing);
  const waiters = new Map();
  outgoing.sendClientMessage = function (msg) {
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
  globalThis.__saCall = function (id, name, params, sessionId, programId, conversationId, identity) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(function () {
        waiters.delete(id);
        reject(new Error("tool_call timeout: " + name));
      }, 30000);
      waiters.set(id, function (msg) {
        clearTimeout(timer);
        resolve(msg);
      });
      incoming({
        type: "tool_call",
        id: id,
        name: name,
        params: params || {},
        sessionId: sessionId,
        ...(programId ? { programId: programId } : {}),
        ...(identity ? {runId:identity.runId,epochs:identity.epochs} : {}),
        ...(conversationId ? { conversationId: conversationId } : {})
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
  const controller = new AbortController();

  const parsed = cdp.waitForEvent('Debugger.scriptParsed', 12_000, {
    sessionId, signal: controller.signal,
    predicate: message => message.params?.url?.split('?')[0] === scriptUrl(extensionId),
  });

  try {
    await cdp.send('Debugger.enable', {}, sessionId);

    return (await parsed).params.scriptId;
  } finally { controller.abort(); }
}

async function listenerBodyLines(cdp, sessionId, scriptId) {
  const { scriptSource } = await cdp.send("Debugger.getScriptSource", { scriptId }, sessionId);
  const lines = String(scriptSource ?? "").split("\n");
  const needles = ["chrome.runtime.onMessage.addListener", "chrome.runtime.onConnect.addListener"];
  const out = [];

  for (const needle of needles) {
    for (let idx = 0; idx < lines.length; idx += 1) {
      if (lines[idx].includes(needle)) out.push(idx + 1);
    }
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

// Runs before breakpoints are installed: no paused worker can block readiness.
export function prepareProbeExpression(probeUrl) {
  return `(async () => {
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(probeUrl)}, active: false });
    globalThis.__saProbeTab = tab.id;
    globalThis.__saProbeState = { phase: 'tab-created', tabId: tab.id };
    const ready = await new Promise((resolve, reject) => {
      const finish = (error, value) => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(updated); error ? reject(error) : resolve(value); };
      const updated = (id, change, value) => { if (id === tab.id && change.status === 'complete') finish(null, value); };
      const timer = setTimeout(() => finish(new Error('probe page did not become complete')), 12000);
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.get(tab.id).then(value => { if (value.status === 'complete') finish(null, value); }, error => finish(error));
    });
    globalThis.__saProbeState = { phase: 'page-complete', tabId: tab.id, url: ready.url, status: ready.status };
    if (ready.url !== ${JSON.stringify(probeUrl)}) throw new Error('probe URL mismatch: ' + ready.url);
    const injected = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => {
      globalThis.__saProbe = { ready: document.readyState, url: location.href, sent: false };
      return globalThis.__saProbe;
    } });
    const result = injected[0];
    if (!result || result.result.ready !== 'complete' || result.result.url !== ${JSON.stringify(probeUrl)}) throw new Error('probe injection did not confirm readiness');
    globalThis.__saProbeState = { phase: 'injected', tabId: tab.id, documentId: result.documentId, injected: result.result };
    return globalThis.__saProbeState;
  })()`;
}

export function triggerExpression(tabId) {
  return `chrome.scripting.executeScript({ target: { tabId: ${JSON.stringify(tabId)} }, func: () => {
    if (!globalThis.__saProbe) throw new Error('probe injection missing');
    const message = chrome.runtime.sendMessage({ type: 'sideagent-accept-probe' });
    globalThis.__saProbe.sent = true;
    message.then(() => { globalThis.__saProbe.delivered = true; }, error => { globalThis.__saProbe.messageError = String(error); });
    return { sent: true };
  } })`;
}

function evaluateValue(result) {
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);

  return result.result?.value;
}

/**
 * One trigger, with session-scoped pauses; never await its completion before resume.
 * @param {(kind: string, data: unknown) => void} [diagnose]
 */
export async function installExecuteToolCallHook(cdp, sessionId, extensionId, probeUrl, diagnose = () => {}) {
  if (!probeUrl) throw new Error('installExecuteToolCallHook 需要本地 probeUrl');
  const evaluate = async expression => evaluateValue(await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId));

  if (await evaluate('typeof globalThis.__saCall') === 'function') return { ok: true, already: true };
  const offException = cdp.onEvent('Runtime.exceptionThrown', message => diagnose('sw-exception', { expectedSession: sessionId, ...message }));

  const offPause = cdp.onEvent('Debugger.paused', message => diagnose('debugger-paused', {
    expectedSession: sessionId, sessionId: message.sessionId, reason: message.params?.reason,
    hitBreakpoints: message.params?.hitBreakpoints, frames: message.params?.callFrames?.map(frame => ({ functionName: frame.functionName, location: frame.location })),
  }));

  const waits = new AbortController(), breakpointIds = [];
  let trigger;

  try {
    await cdp.send('Runtime.enable', {}, sessionId);
    const probe = await evaluate(prepareProbeExpression(probeUrl));
    diagnose('probe-ready', probe);
    const scriptId = await findBackgroundScript(cdp, sessionId, extensionId);
    const lines = await listenerBodyLines(cdp, sessionId, scriptId);

    for (const lineNumber of lines) {
      const bp = await cdp.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber } }, sessionId);

      if (bp.breakpointId) breakpointIds.push(bp.breakpointId);
    }

    if (!breakpointIds.length) throw new Error('setBreakpoint 未返回 breakpointId');

    const pausedWait = timeout => cdp.waitForEvent('Debugger.paused', timeout, {
      sessionId, signal: waits.signal,
      predicate: message => message.params?.hitBreakpoints?.some(id => breakpointIds.includes(id)),
    });

    let pausedPromise = pausedWait(12_000);
    diagnose('trigger-dispatched', { sessionId, tabId: probe.tabId });
    trigger = evaluate(triggerExpression(probe.tabId)).then(value => {
      if (value?.[0]?.result?.sent !== true) throw new Error('probe message was not sent');
      diagnose('trigger-complete', { sessionId, value });

      return value;
    });

    // A successful trigger is not readiness; a rejected trigger ends the wait.
    const nextPause = pending => new Promise((resolve, reject) => {
      pending.then(resolve, reject);
      trigger.catch(reject);
    });

    let paused = await nextPause(pausedPromise);
    let hooked, lastError;

    for (let framePass = 0; framePass <= lines.length; framePass++) {
      try { hooked = await hookOnPausedFrame(cdp, sessionId, paused); break; }
      catch (error) { lastError = error; }

      if (framePass === lines.length) break;
      pausedPromise = pausedWait(4_000);
      await cdp.send('Debugger.resume', {}, sessionId);
      paused = await nextPause(pausedPromise);
    }

    if (!hooked) throw new Error(`No controller scope in triggered listeners: ${lastError}`);

    // Remove before resuming so the same message cannot hit another breakpoint.
    for (const breakpointId of breakpointIds.splice(0)) await cdp.send('Debugger.removeBreakpoint', { breakpointId }, sessionId);
    await cdp.send('Debugger.resume', {}, sessionId);
    await trigger;
    diagnose('probe-message', await evaluate(`chrome.scripting.executeScript({target:{tabId:${probe.tabId}},func:()=>globalThis.__saProbe})`));

    if (await evaluate('typeof globalThis.__saCall') !== 'function') throw new Error('钩子安装后 globalThis.__saCall 仍不可用');

    return hooked;
  } catch (error) {
    diagnose('hook-error', { sessionId, error: String(error), cdp: cdp.diagnostics() });
    throw error;
  } finally {
    waits.abort();
    offException(); offPause();

    // Debugger.disable removes our breakpoints and resumes even on trigger failure.
    try {
      await cdp.send('Debugger.disable', {}, sessionId, 4000);

      if (trigger) await trigger.catch(() => {});
      diagnose('probe-final-state', await evaluate('globalThis.__saProbeState'));
      await evaluate(`(async()=>{if(globalThis.__saProbeTab != null){await chrome.tabs.remove(globalThis.__saProbeTab);delete globalThis.__saProbeTab;}})()`);
      diagnose('hook-cleanup', { status: 'PASS', sessionId });
    } catch (error) {
      diagnose('hook-cleanup', { status: 'FAIL', sessionId, error: String(error) });
      throw error;
    }
  }
}
