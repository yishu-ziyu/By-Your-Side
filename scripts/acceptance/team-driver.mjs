/**
 * 在 SideAgent SW 里跑全队接管验收。
 * 真实上行 takeover/handback，等待 Agent 的 control_result。
 * 不静音、不伪造 control_result / team_status。
 */
export async function teamDriver(opts) {
  const started = Date.now();
  const out = {
    lead: { sessionId: opts.leadId, tabId: null, mark: opts.leadMark },
    worker: { sessionId: opts.workerId, tabId: null, mark: opts.workerMark },
    snapshots: { leadBefore: "", workerBefore: "", leadAfterUser: "", workerAfterUser: "" },
    blocked: { lead: null, worker: null },
    takeover: { requestId: null, confirmedAt: null, members: [], groupId: null, fromAgent: false },
    lastWriteEndedAt: null,
    inflightStartedAt: null,
    handback: { requestId: null, members: [], sentAt: null, fromAgent: false, team: null },
    agentAssembly: { ready: false, members: [] },
    originalTask: { leadResumed: false, workerResumed: false, before: [], after: [], reason: "尚未校验" },
    partial: { fromAgent: false, team: null, openTabAfter: null },
    abortState: { gate: null, team: null, noBlockedSessions: false },
    openTabAfterHandback: 0,
    gateAfterTakeover: null,
    extension: {
      id: chrome.runtime.id,
      version: (chrome.runtime.getManifest && chrome.runtime.getManifest().version) || "",
    },
    via: {
      path: "handleTakeover / handleHandback → uplink → Agent Fleet.holdActiveGroup/continueMembers → executeToolCall → gate.run",
    },
    stage: "init",
    error: null,
    startedAt: started,
    elapsedMs: 0,
  };

  const call = globalThis.__saCall;
  if (typeof call !== "function") {
    out.stage = "hook";
    out.error = "globalThis.__saCall 不存在：未进入 executeToolCall";
    out.elapsedMs = Date.now() - started;
    return out;
  }
  if (
    typeof globalThis.__saTakeover !== "function" ||
    typeof globalThis.__saHandback !== "function" ||
    typeof globalThis.__saPrepareTeam !== "function"
  ) {
    out.stage = "hook";
    out.error = "未挂上生产 handleTakeover/handleHandback";
    out.elapsedMs = Date.now() - started;
    return out;
  }

  let seq = 0;
  let openTabCount = 0;
  async function tool(sessionId, name, params) {
    if (name === "open_tab") openTabCount += 1;
    const id = "team-" + sessionId + "-" + name + "-" + ++seq;
    const msg = await call(id, name, params, sessionId);
    if (!msg || msg.type !== "tool_result") throw new Error(name + " 未回 tool_result");
    return msg;
  }

  function waitControlResult(requestId, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const s = (globalThis.__saServerEvents || []).find(function (event) {
          return event && event.type === "control_result" && event.requestId === requestId;
        });
        if (s && s.type === "control_result" && s.requestId === requestId) {
          clearInterval(timer);
          resolve(s);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error("等待 Agent control_result 超时 requestId=" + requestId));
        }
      }, 40);
    });
  }

  function waitServerEvent(type, requestId, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const event = (globalThis.__saServerEvents || []).find(function (item) {
          return item && item.type === type && item.requestId === requestId;
        });
        if (event) {
          clearInterval(timer);
          resolve(event);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error("等待 Agent " + type + " 超时 requestId=" + requestId));
        }
      }, 40);
    });
  }

  function waitTeamStatus(groupId, generation, predicate, timeoutMs) {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const event = (globalThis.__saServerEvents || []).find(function (item) {
          return (
            item &&
            item.type === "team_status" &&
            item.team &&
            item.team.groupId === groupId &&
            item.team.generation === generation &&
            predicate(item.team)
          );
        });
        if (event) {
          clearInterval(timer);
          resolve(event.team);
          return;
        }
        if (Date.now() - t0 > timeoutMs) {
          clearInterval(timer);
          reject(new Error("等待 Agent team_status 最终状态超时 groupId=" + groupId));
        }
      }, 40);
    });
  }

  async function mutate(tabId, text) {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (value) => {
        const el = document.getElementById("page-mark");
        if (el) el.textContent = value;
      },
      args: [text],
    });
  }

  try {
    out.stage = "open_lead";
    const leadOpen = await tool(opts.leadId, "open_tab", { url: opts.leadUrl });
    if (!leadOpen.ok) throw new Error(leadOpen.error || "lead open_tab failed");
    out.lead.tabId = leadOpen.data.tabId;

    out.stage = "open_worker";
    const workerOpen = await tool(opts.workerId, "open_tab", { url: opts.workerUrl });
    if (!workerOpen.ok) throw new Error(workerOpen.error || "worker open_tab failed");
    out.worker.tabId = workerOpen.data.tabId;
    const openTabsBefore = openTabCount;

    out.stage = "agent_assembly";
    const leadTask = {
      taskId: "lead-original-" + opts.userLeadMark,
      expectedSnapshotMarker: "page-mark-" + opts.userLeadMark,
    };
    const workerTask = {
      taskId: "worker-original-" + opts.userWorkerMark,
      expectedSnapshotMarker: "page-mark-" + opts.userWorkerMark,
    };
    const assembled = await globalThis.__saPrepareTeam(opts.capability, opts.workerId, out.worker.tabId, leadTask, workerTask);
    out.agentAssembly.ready = Boolean(assembled && assembled.ok);
    out.agentAssembly.members = (assembled && assembled.members) || [];
    out.originalTask.before = (assembled && assembled.continuity) || [];

    out.stage = "write_lead";
    const leadClick = await tool(opts.leadId, "click", { target: opts.incSelector });
    if (!leadClick.ok || (leadClick.data && leadClick.data.held)) throw new Error("lead click 未落地");
    await tool(opts.leadId, "fill", { target: opts.inputSelector, value: opts.leadFill });
    const leadSnap = await tool(opts.leadId, "snapshot", {});
    out.snapshots.leadBefore = leadSnap.ok && leadSnap.data ? leadSnap.data.text : "";

    out.stage = "write_worker";
    const workerClick = await tool(opts.workerId, "click", { target: opts.incSelector });
    if (!workerClick.ok || (workerClick.data && workerClick.data.held)) throw new Error("worker click 未落地");
    await tool(opts.workerId, "fill", { target: opts.inputSelector, value: opts.workerFill });
    const workerSnap = await tool(opts.workerId, "snapshot", {});
    out.snapshots.workerBefore = workerSnap.ok && workerSnap.data ? workerSnap.data.text : "";

    out.stage = "status";
    globalThis.__saLastServer = null;
    globalThis.__saLastClient = null;
    globalThis.__saServerEvents = [];

    out.stage = "inflight";
    out.inflightStartedAt = Date.now();
    const delayMs = opts.inflightMs || 1800;
    const code = "new Promise(function(r){setTimeout(function(){r(1)}," + delayMs + ")})";
    let writeEnded = 0;
    const inflightLead = tool(opts.leadId, "js", { code }).then((msg) => {
      writeEnded = Date.now();
      return msg;
    });
    const inflightWorker = tool(opts.workerId, "js", { code }).then((msg) => {
      writeEnded = Date.now();
      return msg;
    });
    await new Promise((r) => setTimeout(r, 120));

    out.stage = "takeover";
    await globalThis.__saTakeover();
    const takeMsg = globalThis.__saLastClient;
    if (!takeMsg || takeMsg.type !== "takeover" || !takeMsg.requestId) {
      throw new Error("生产 handleTakeover 没有发出 takeover 帧");
    }
    if (!Array.isArray(takeMsg.members) || takeMsg.members.length < 2) {
      throw new Error("takeover 帧没有冻结两名成员");
    }
    out.takeover.requestId = takeMsg.requestId;
    out.takeover.groupId = takeMsg.groupId || null;
    const agentTake = await waitControlResult(takeMsg.requestId, 15000);
    out.takeover.confirmedAt = Date.now();
    out.takeover.fromAgent = true;
    out.takeover.frozenMembers = takeMsg.members;
    out.takeover.members =
      (agentTake.team && agentTake.team.members) ||
      (globalThis.__saTeamView() && globalThis.__saTeamView().members) ||
      takeMsg.members;
    await inflightLead;
    await inflightWorker;
    out.lastWriteEndedAt = writeEnded;
    out.gateAfterTakeover = globalThis.__saGate();

    out.stage = "blocked";
    const lateLead = await tool(opts.leadId, "click", { target: opts.incSelector });
    const lateWorker = await tool(opts.workerId, "fill", { target: opts.inputSelector, value: "should-not-land" });
    out.blocked.lead = lateLead.ok ? "landed" : lateLead.error || "blocked";
    out.blocked.worker = lateWorker.ok ? "landed" : lateWorker.error || "blocked";

    out.stage = "user_mutate";
    await mutate(out.lead.tabId, "page-mark-" + opts.userLeadMark);
    await mutate(out.worker.tabId, "page-mark-" + opts.userWorkerMark);

    out.stage = "handback";
    globalThis.__saLastServer = null;
    globalThis.__saServerEvents = [];
    await globalThis.__saHandback();
    const backMsg = globalThis.__saLastClient;
    if (!backMsg || backMsg.type !== "handback") throw new Error("生产 handleHandback 没有发出 handback 帧");
    out.handback.requestId = backMsg.requestId;
    out.handback.members = backMsg.members || [];
    out.handback.sentAt = Date.now();
    const leadMember = (backMsg.members || []).find((m) => m.sessionId === opts.leadId || m.sessionId === "main");
    const workerMember = (backMsg.members || []).find((m) => m.sessionId === opts.workerId);
    out.snapshots.leadAfterUser = leadMember && leadMember.snapshot ? leadMember.snapshot : "";
    out.snapshots.workerAfterUser = workerMember && workerMember.snapshot ? workerMember.snapshot : "";
    const agentBack = await waitControlResult(backMsg.requestId, 15000);
    out.handback.fromAgent = Boolean(agentBack && agentBack.ok);
    const continuityEvent = await waitServerEvent("acceptance_team_evidence", backMsg.requestId, 15000);
    const handbackGroupId = backMsg.groupId || agentBack?.team?.groupId || out.takeover.groupId;
    const handbackGeneration = backMsg.generation ?? agentBack?.team?.generation;
    out.handback.team = await waitTeamStatus(
      handbackGroupId,
      handbackGeneration,
      (view) => view.phase === "restored" && view.members.every((member) => member.phase === "restored"),
      15000,
    );
    out.originalTask.after = continuityEvent.continuity || [];
    function resumed(sessionId, taskId, tabId) {
      const before = out.originalTask.before.find((item) => item.sessionId === sessionId);
      const after = out.originalTask.after.find((item) => item.sessionId === sessionId);
      return Boolean(
        before &&
          after &&
          before.instanceId === after.instanceId &&
          before.taskId === taskId &&
          after.taskId === taskId &&
          before.step === "before" &&
          after.step === "continued" &&
          before.active === true &&
          after.active === true &&
          after.resumedTabId === tabId &&
          after.snapshotMarkerFound === true
          && after.preTaskPrompted === true
          && after.preTaskAgentStarted === true
          && after.contextTaskFound === true
          && after.resumeRequested === true
          && after.resumeAgentStarted === true
          && after.resumeSnapshotToolCalled === true
          && after.resumeSnapshotMarkerFound === true
          && after.resumeContinuationMarkerFound === true
      );
    }
    out.originalTask.leadResumed = resumed(opts.leadId, leadTask.taskId, out.lead.tabId);
    out.originalTask.workerResumed = resumed(opts.workerId, workerTask.taskId, out.worker.tabId);
    out.originalTask.reason =
      out.originalTask.leadResumed && out.originalTask.workerResumed
        ? "same instance/task advanced before→continued with own fresh marker"
        : "instance/task/step continuity mismatch";
    out.openTabAfterHandback = openTabCount - openTabsBefore;

    out.stage = "partial_takeover";
    globalThis.__saLastClient = null;
    globalThis.__saServerEvents = [];
    await globalThis.__saTakeover();
    const partialTake = globalThis.__saLastClient;
    if (!partialTake || partialTake.type !== "takeover" || !partialTake.requestId) {
      throw new Error("partial 验收没有发出第二次 takeover");
    }
    await waitControlResult(partialTake.requestId, 15000);
    const openBeforePartial = openTabCount;
    await chrome.tabs.remove(out.worker.tabId);
    await new Promise((resolve) => setTimeout(resolve, 120));

    out.stage = "partial_handback";
    globalThis.__saLastClient = null;
    globalThis.__saServerEvents = [];
    await globalThis.__saHandback();
    const partialBack = globalThis.__saLastClient;
    if (!partialBack || partialBack.type !== "handback" || !partialBack.requestId) {
      throw new Error("partial 验收没有发出 handback");
    }
    const partialAck = await waitControlResult(partialBack.requestId, 15000);
    const partialGroupId = partialBack.groupId || partialAck?.team?.groupId;
    const partialGeneration = partialBack.generation ?? partialAck?.team?.generation;
    const partialTeam = await waitTeamStatus(
      partialGroupId,
      partialGeneration,
      (view) => {
        const lead = view.members.find((member) => member.sessionId === opts.leadId || member.sessionId === "main");
        const worker = view.members.find((member) => member.sessionId === opts.workerId);
        return view.phase === "partial" && lead?.phase === "restored" && worker?.phase === "paused_tab_closed";
      },
      15000,
    );
    out.partial.fromAgent = true;
    out.partial.team = partialTeam;
    out.partial.openTabAfter = openTabCount - openBeforePartial;

    out.stage = "abort";
    globalThis.__saAbortTeam();
    await new Promise((resolve) => setTimeout(resolve, 120));
    out.abortState.gate = globalThis.__saGate();
    out.abortState.team = globalThis.__saTeamView();
    out.abortState.noBlockedSessions = Object.values(out.abortState.gate?.sessions ?? {}).every(
      (owner) => owner === "agent",
    );

    out.stage = "done";
  } catch (e) {
    out.error = e && e.message ? e.message : String(e);
  } finally {
    try {
      if (out.abortState.team?.phase !== "aborted" && typeof globalThis.__saAbortTeam === "function") globalThis.__saAbortTeam();
    } catch {
      /* Agent 可能已断开；本地闸门仍要清 */
    }
    try {
      if (typeof globalThis.__saAbortGate === "function") globalThis.__saAbortGate();
    } catch {
      /* 隔离下一轮 */
    }
    for (const tabId of [out.lead.tabId, out.worker.tabId]) {
      if (tabId == null) continue;
      try {
        await chrome.tabs.remove(tabId);
      } catch {
        /* 标签可能已关 */
      }
    }
    out.elapsedMs = Date.now() - started;
  }
  return out;
}

export function buildTeamDriverExpression(opts) {
  return `(${teamDriver.toString()})(${JSON.stringify(opts)})`;
}
