#!/usr/bin/env node
/**
 * 会话与共享页真实浏览器验收。
 * 页面写入只走 __saCall → transport.handleRaw → controller → executeToolCall
 * → gate → 生产 handler；本脚本不直接填写 DOM。
 */
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { connectBrowser, evaluateInWorker, fetchJson, findServiceWorker } from "./cdp.mjs";
import { discoverChromeMain } from "./discover.mjs";
import { redactEvidence } from "./redact.mjs";
import { installExecuteToolCallHook, normalizeServiceWorkerInspector } from "./sw-hook.mjs";
import { recoveryChromeMain, recoveryExtension, sideagentExtensionId } from "./constants.mjs";

export const SESSION_FIXTURE_MARKER = "SIDEAGENT_SESSION_MANAGEMENT_FIXTURE_20260908";
export const SESSION_A_DRAFT = "draft-from-conversation-a";
export const SESSION_B_DRAFT = "draft-from-conversation-b";
export const WORK_VALUE = "负责核心产品的交付与复盘";
export const EDUCATION_VALUE = "信息设计与人机交互";
export const B_AFTER_TAKEOVER = "conversation-b-kept-running";
const DEFAULT_CONVERSATION = "default";
const SHARED_WORKER = "resume-worker";
const TIMEOUT_MS = 30_000;
const FIXTURE_FILE = fileURLToPath(new URL("../../extension/test/fixtures/session-management.html", import.meta.url));

function startSessionFixtureServer() {
  const root = dirname(FIXTURE_FILE);
  const server = createServer((req, res) => {
    const pathname = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    if (pathname !== "/session-management.html" && pathname !== "/") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const file = normalize(join(root, "session-management.html"));
    if (!file.startsWith(normalize(root)) || !existsSync(file)) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    const { size } = statSync(file);
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-length": size,
      "cache-control": "no-store",
    });
    createReadStream(file).pipe(res);
  });
  server.keepAliveTimeout = 1;
  return new Promise((resolveServer, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("fixture 未绑定 127.0.0.1"));
      resolveServer({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => {
          const timer = setTimeout(done, 500);
          try { server.closeAllConnections?.(); } catch {}
          server.close(() => { clearTimeout(timer); done(); });
        }),
      });
    });
    server.on("error", reject);
  });
}

export async function sessionManagementDriver(opts) {
  const startedAt = Date.now();
  const DEFAULT_CONVERSATION = opts.defaultConversation || "default";
  const SHARED_WORKER = opts.sharedWorker || "resume-worker";
  const out = {
    startedAt,
    elapsedMs: 0,
    stage: "init",
    error: null,
    execution: "transport.handleRaw → controller(conversationId) → executeToolCall → gate.run → production handler",
    conversations: { a: DEFAULT_CONVERSATION, b: null, list: [] },
    agentAssembly: null,
    tabs: { a: null, b: null, sameUrl: false, groups: null },
    operations: { share: null, draftA: null, draftB: null, work: null, education: null, bAfterTakeover: null },
    snapshots: { a: "", b: "", bAfterTakeover: "" },
    eventTimeline: [],
    screenshots: { a: null, b: null },
    takeover: { frame: null, result: null, blocked: [] },
    abortIsolation: { bIdle: false, aStillHeld: false },
    persistence: {
      selectedConversationId: null,
      histories: [],
      workingTabs: null,
      tabResources: null,
      sidepanelReopen: { evaluated: false, reason: "由主线程使用真实侧栏关闭/重开验收" },
    },
    modelPlanning: {
      evaluated: false,
      reason: "自主判断与说明分工必须由真实模型用户路径另验，runner 不伪造模型决策",
    },
    modelRestore: { before: null, after: null, ok: false },
  };
  const call = globalThis.__saCall;
  const send = globalThis.__saSendClient;
  if (typeof call !== "function" || typeof send !== "function") {
    out.stage = "hook";
    out.error = "缺少 __saCall/__saSendClient 生产链钩子";
    out.elapsedMs = Date.now() - startedAt;
    return out;
  }
  let seq = 0;
  const opened = [];
  let originalModel = null;
  const events = () => globalThis.__saServerEvents || [];
  function waitFor(predicate, description, timeoutMs = 20_000) {
    const begin = Date.now();
    return new Promise((resolveWait, reject) => {
      const timer = setInterval(() => {
        const found = events().find(predicate);
        if (found) { clearInterval(timer); resolveWait(found); return; }
        if (Date.now() - begin > timeoutMs) {
          clearInterval(timer);
          reject(new Error("等待超时：" + description));
        }
      }, 40);
    });
  }
  async function tool(conversationId, sessionId, name, params) {
    const id = `session-accept-${++seq}-${name}`;
    const msg = await call(id, name, params || {}, sessionId, undefined, conversationId);
    if (!msg || msg.type !== "tool_result") throw new Error(name + " 未返回 tool_result");
    return msg;
  }
  async function groupOf(tabId) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId == null || tab.groupId < 0) return { tabId, groupId: tab.groupId ?? -1, title: "", color: "" };
    const group = await chrome.tabGroups.get(tab.groupId);
    return { tabId, groupId: tab.groupId, title: group.title || "", color: group.color || "" };
  }
  try {
    globalThis.__saServerEvents = [];
    globalThis.__saAcceptanceConversationId = DEFAULT_CONVERSATION;
    out.stage = "capture-original-model";
    const initialListRequestId = "initial-list-" + Date.now();
    if (!send({ type: "conversation_list", requestId: initialListRequestId })) throw new Error("初始 conversation_list 未发出");
    const initialList = await waitFor(
      (event) => event.type === "conversation_list" && event.requestId === initialListRequestId,
      "initial conversation_list",
    );
    originalModel = initialList.conversations.find((item) => item.id === DEFAULT_CONVERSATION)?.model ?? null;
    out.modelRestore.before = originalModel;

    out.stage = "open-a";
    const openedA = await tool(DEFAULT_CONVERSATION, "main", "open_tab", { url: opts.url });
    if (!openedA.ok) throw new Error(openedA.error || "A open_tab failed");
    out.tabs.a = openedA.data.tabId;
    opened.push(out.tabs.a);

    out.stage = "share-a";
    out.operations.share = await tool(DEFAULT_CONVERSATION, "main", "share_tab", {
      tabId: out.tabs.a,
      collaborators: ["main", SHARED_WORKER],
    });
    if (!out.operations.share.ok) throw new Error(out.operations.share.error || "share_tab failed");

    out.stage = "assemble-a-running";
    if (typeof globalThis.__saPrepareTeam !== "function") throw new Error("缺少 __saPrepareTeam");
    out.agentAssembly = await globalThis.__saPrepareTeam(
      opts.capability,
      SHARED_WORKER,
      out.tabs.a,
      { taskId: "conversation-a-lead-running", expectedSnapshotMarker: opts.workValue },
      { taskId: "conversation-a-worker-running", expectedSnapshotMarker: opts.educationValue },
    );

    out.stage = "create-b-while-a-running";
    const requestId = "create-b-" + Date.now();
    globalThis.__saServerEvents = [];
    if (!send({ type: "conversation_create", requestId, title: "会话 B" })) throw new Error("conversation_create 未发出");
    const created = await waitFor(
      (event) => event.type === "conversation_created" && event.requestId === requestId,
      "conversation_created",
    );
    out.conversations.b = created.conversation.id;
    if (!out.conversations.b || out.conversations.b === DEFAULT_CONVERSATION) throw new Error("B conversationId 无效");

    out.stage = "open-b-same-url";
    const openedB = await tool(out.conversations.b, "main", "open_tab", { url: opts.url });
    if (!openedB.ok) throw new Error(openedB.error || "B open_tab failed");
    out.tabs.b = openedB.data.tabId;
    opened.push(out.tabs.b);
    out.tabs.sameUrl = openedA.data.url === openedB.data.url;
    out.tabs.groups = { a: await groupOf(out.tabs.a), b: await groupOf(out.tabs.b) };

    out.stage = "conversation-drafts";
    out.operations.draftA = await tool(DEFAULT_CONVERSATION, "main", "page_operation", {
      tabId: out.tabs.a, target: "#session-draft", expectedValue: "", value: opts.draftA,
    });
    out.operations.draftB = await tool(out.conversations.b, "main", "fill", {
      target: "#session-draft", value: opts.draftB,
    });
    if (!out.operations.draftA.ok || !out.operations.draftB.ok) throw new Error("A/B 草稿写入失败");

    out.stage = "shared-page-concurrent-operations";
    const [work, education] = await Promise.all([
      tool(DEFAULT_CONVERSATION, "main", "page_operation", {
        tabId: out.tabs.a, target: "#work-experience", expectedValue: "", value: opts.workValue,
      }),
      tool(DEFAULT_CONVERSATION, SHARED_WORKER, "page_operation", {
        tabId: out.tabs.a, target: "#education", expectedValue: "", value: opts.educationValue,
      }),
    ]);
    out.operations.work = work;
    out.operations.education = education;
    if (!work.ok || !education.ok) throw new Error("共享页 page_operation 失败");

    out.stage = "snapshots";
    const [snapA, snapB, shotA, shotB] = await Promise.all([
      tool(DEFAULT_CONVERSATION, "main", "snapshot", {}),
      tool(out.conversations.b, "main", "snapshot", {}),
      tool(DEFAULT_CONVERSATION, "main", "screenshot", {}),
      tool(out.conversations.b, "main", "screenshot", {}),
    ]);
    out.snapshots.a = snapA.ok ? snapA.data?.text || "" : "";
    out.snapshots.b = snapB.ok ? snapB.data?.text || "" : "";
    out.eventTimeline = out.snapshots.a.match(/transaction-order-is-[^\n]*/)?.[0] ?? "";
    out.screenshots.a = shotA.ok ? shotA.data?.imageBase64 || null : null;
    out.screenshots.b = shotB.ok ? shotB.data?.imageBase64 || null : null;

    out.stage = "takeover-a";
    globalThis.__saServerEvents = [];
    globalThis.__saLastClient = null;
    await globalThis.__saTakeover();
    out.takeover.frame = globalThis.__saLastClient;
    if (!out.takeover.frame?.requestId) throw new Error("A takeover 未发出");
    out.takeover.result = await waitFor(
      (event) => event.type === "control_result" && event.requestId === out.takeover.frame.requestId,
      "A control_result",
    );

    out.stage = "writes-blocked-on-a";
    out.takeover.blocked = await Promise.all([
      tool(DEFAULT_CONVERSATION, "main", "page_operation", {
        tabId: out.tabs.a, target: "#work-experience", expectedValue: opts.workValue, value: "must-not-land-main",
      }),
      tool(DEFAULT_CONVERSATION, SHARED_WORKER, "page_operation", {
        tabId: out.tabs.a, target: "#education", expectedValue: opts.educationValue, value: "must-not-land-worker",
      }),
    ]);

    out.stage = "b-continues-after-a-takeover";
    out.operations.bAfterTakeover = await tool(out.conversations.b, "main", "fill", {
      target: "#summary", value: opts.bAfterTakeover,
    });
    const bAfterSnap = await tool(out.conversations.b, "main", "snapshot", {});
    out.snapshots.bAfterTakeover = bAfterSnap.ok ? bAfterSnap.data?.text || "" : "";

    out.stage = "abort-b-only";
    globalThis.__saServerEvents = [];
    if (!send({ type: "abort", conversationId: out.conversations.b })) throw new Error("B abort 未发出");
    await waitFor(
      (event) => event.type === "status" && event.conversationId === out.conversations.b && event.state === "idle",
      "B idle",
    );
    out.abortIsolation.bIdle = true;
    const aGate = globalThis.__saGate?.();
    out.abortIsolation.aStillHeld = aGate?.sessions?.main === "user" && aGate?.sessions?.[SHARED_WORKER] === "user";

    out.stage = "conversation-list-and-storage";
    const listRequestId = "list-" + Date.now();
    globalThis.__saServerEvents = [];
    send({ type: "conversation_list", requestId: listRequestId });
    const listed = await waitFor(
      (event) => event.type === "conversation_list" && event.requestId === listRequestId,
      "conversation_list",
    );
    out.conversations.list = listed.conversations;
    const [stored, localStored] = await Promise.all([chrome.storage.session.get(null), chrome.storage.local.get(null)]);
    out.persistence.selectedConversationId = stored.selectedConversationId ?? null;
    out.persistence.histories = [...new Set([...Object.keys(stored), ...Object.keys(localStored)])]
      .filter((key) => key.startsWith("history:"))
      .sort();
    out.persistence.workingTabs = stored.workingTabs ?? null;
    out.persistence.tabResources = stored.tabResources ?? stored.tabResourceMap ?? null;

    out.stage = "restore-original-model";
    if (!originalModel) throw new Error("无法确定 default 会话验收前模型，拒绝留下 acceptance provider");
    globalThis.__saServerEvents = [];
    if (!send({ type: "set_model", conversationId: DEFAULT_CONVERSATION, model: originalModel })) {
      throw new Error("恢复 default 会话模型的消息未发出");
    }
    const restoredModel = await waitFor(
      (event) => event.type === "model_info" && event.conversationId === DEFAULT_CONVERSATION && event.model === originalModel,
      "default model restore",
    );
    out.modelRestore.after = restoredModel.model;
    out.modelRestore.ok = true;
    out.stage = "done";
  } catch (error) {
    out.error = error && error.message ? error.message : String(error);
  } finally {
    if (originalModel && !out.modelRestore.ok) {
      try {
        globalThis.__saServerEvents = [];
        if (!send({ type: "set_model", conversationId: DEFAULT_CONVERSATION, model: originalModel })) throw new Error("恢复消息未发出");
        const restored = await waitFor(
          (event) => event.type === "model_info" && event.conversationId === DEFAULT_CONVERSATION && event.model === originalModel,
          "finally default model restore",
        );
        out.modelRestore.after = restored.model;
        out.modelRestore.ok = true;
      } catch (restoreError) {
        out.stage = "restore-original-model";
        out.error = `${out.error ? `${out.error}; ` : ""}恢复 default 会话模型失败：${restoreError && restoreError.message ? restoreError.message : String(restoreError)}`;
      }
    }
    try { send?.({ type: "abort", conversationId: DEFAULT_CONVERSATION }); } catch {}
    try { if (typeof globalThis.__saAbortGate === "function") globalThis.__saAbortGate(); } catch {}
    for (const tabId of opened) {
      try { await chrome.tabs.remove(tabId); } catch {}
    }
    out.elapsedMs = Date.now() - startedAt;
  }
  return out;
}

export function buildSessionManagementExpression(opts) {
  return `(${sessionManagementDriver.toString()})(${JSON.stringify(opts)})`;
}

function eventOrderIsSerialized(snapshot) {
  const positions = {};
  for (const match of String(snapshot).matchAll(/(focused-input|change)-(work-experience|education)/g)) {
    if (positions[`${match[1]}:${match[2]}`] == null) positions[`${match[1]}:${match[2]}`] = match.index;
  }
  const wf = positions["focused-input:work-experience"];
  const wi = positions["change:work-experience"];
  const ef = positions["focused-input:education"];
  const ei = positions["change:education"];
  if (![wf, wi, ef, ei].every(Number.isInteger)) return false;
  return (wf < wi && wi < ef && ef < ei) || (ef < ei && ei < wf && wf < wi);
}

export function evaluateSessionManagementRun(driver) {
  const checks = [];
  const add = (name, ok, actual) => checks.push({ name, ok: Boolean(ok), actual });
  const listIds = (driver?.conversations?.list ?? []).map((item) => item.id);
  const aGroup = driver?.tabs?.groups?.a;
  const bGroup = driver?.tabs?.groups?.b;
  add("a-running-while-b-created", driver?.agentAssembly?.ok === true && driver?.conversations?.b, driver?.agentAssembly);
  add("conversation-list", listIds.includes(DEFAULT_CONVERSATION) && listIds.includes(driver?.conversations?.b), listIds);
  add("same-url-distinct-tabs", driver?.tabs?.sameUrl && driver?.tabs?.a !== driver?.tabs?.b, driver?.tabs);
  add("separate-tab-groups", aGroup?.groupId >= 0 && bGroup?.groupId >= 0 && aGroup.groupId !== bGroup.groupId, driver?.tabs?.groups);
  add("draft-a-isolated", driver?.snapshots?.a?.includes(SESSION_A_DRAFT) && !driver.snapshots.a.includes(SESSION_B_DRAFT), "A snapshot");
  add("draft-b-isolated", driver?.snapshots?.b?.includes(SESSION_B_DRAFT) && !driver.snapshots.b.includes(SESSION_A_DRAFT), "B snapshot");
  add("shared-registered", driver?.operations?.share?.ok === true, driver?.operations?.share);
  add("shared-writes-verified", driver?.operations?.work?.data?.verified === true && driver?.operations?.education?.data?.verified === true, driver?.operations);
  add("focus-fill-readback-serialized", eventOrderIsSerialized(driver?.snapshots?.a), "fixture event log");
  add("never-submit", driver?.snapshots?.a?.includes("submit-count-is-0"), "A snapshot");
  add("takeover-all-writers", driver?.takeover?.result?.ok === true && (driver?.takeover?.frame?.members ?? []).some((m) => m.sessionId === SHARED_WORKER), driver?.takeover);
  add("a-writes-blocked", (driver?.takeover?.blocked ?? []).length === 2 && driver.takeover.blocked.every((item) => item.ok === false), driver?.takeover?.blocked);
  add("b-continues", driver?.operations?.bAfterTakeover?.ok === true && driver?.snapshots?.bAfterTakeover?.includes(B_AFTER_TAKEOVER), driver?.operations?.bAfterTakeover);
  add("abort-isolated", driver?.abortIsolation?.bIdle === true && driver?.abortIsolation?.aStillHeld === true, driver?.abortIsolation);
  add("browser-session-state-persisted", Boolean(driver?.persistence?.workingTabs && driver?.persistence?.tabResources), driver?.persistence);
  add("default-model-restored", driver?.modelRestore?.ok === true && driver?.modelRestore?.before === driver?.modelRestore?.after, driver?.modelRestore);
  const failed = checks.find((check) => !check.ok);
  return {
    ok: !driver?.error && !failed,
    checks,
    failureStage: failed?.name ?? (driver?.error ? driver.stage : null),
    failureCategory: failed ? "acceptance_mismatch" : driver?.error ? "driver_error" : null,
    error: driver?.error ?? null,
  };
}

async function writeScreenshot(root, name, base64) {
  if (!base64) return null;
  await writeFile(join(root, name), Buffer.from(base64, "base64"));
  return name;
}

async function main() {
  const root = process.env.ACCEPT_SESSION_EVIDENCE_DIR || join(tmpdir(), `sideagent-accept-sessions-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await mkdir(root, { recursive: true });
  const say = (message) => console.log(message);
  let fixture;
  let cdp;
  const capabilityPath = join(homedir(), ".sideagent", "acceptance-team-capability.json");
  try {
    const connection = discoverChromeMain();
    say(`PASS connect ${connection.wrapperBundleId} pid=${connection.pid} port=${connection.port}`);
    const extId = sideagentExtensionId();
    const browser = await connectBrowser(connection.port);
    cdp = browser.cdp;
    let targets = await cdp.send("Target.getTargets");
    let sw = findServiceWorker(targets.targetInfos ?? targets, extId);
    if (!sw) sw = findServiceWorker(await fetchJson(`http://127.0.0.1:${connection.port}/json/list`), extId);
    if (!sw) throw Object.assign(new Error(recoveryExtension(extId)), { stage: "extension" });
    const sessionId = await cdp.attachSession(sw.targetId ?? sw.id);
    await normalizeServiceWorkerInspector(cdp, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    fixture = await startSessionFixtureServer();
    const url = `${fixture.origin}/session-management.html?scenario=same-url&run=${Date.now()}`;
    const hooked = await installExecuteToolCallHook(cdp, sessionId, extId, url);
    say(`PASS hook already=${Boolean(hooked.already)}`);
    const capability = randomBytes(32).toString("hex");
    await mkdir(dirname(capabilityPath), { recursive: true });
    await writeFile(capabilityPath, `${JSON.stringify({ expiresAt: Date.now() + 5 * 60_000, tokens: [capability] })}\n`, { mode: 0o600 });
    const expression = buildSessionManagementExpression({
      url,
      capability,
      defaultConversation: DEFAULT_CONVERSATION,
      sharedWorker: SHARED_WORKER,
      draftA: SESSION_A_DRAFT,
      draftB: SESSION_B_DRAFT,
      workValue: WORK_VALUE,
      educationValue: EDUCATION_VALUE,
      bAfterTakeover: B_AFTER_TAKEOVER,
    });
    const driver = await evaluateInWorker(cdp, sessionId, expression, TIMEOUT_MS + 40_000);
    const evaluated = evaluateSessionManagementRun(driver);
    const screenshots = [];
    for (const side of ["a", "b"]) {
      const name = await writeScreenshot(root, `conversation-${side}.png`, driver?.screenshots?.[side]);
      if (name) screenshots.push(name);
    }
    const result = redactEvidence({
      ok: evaluated.ok,
      startedAt: driver?.startedAt ?? Date.now(),
      elapsedMs: driver?.elapsedMs ?? 0,
      failureCategory: evaluated.failureCategory,
      failureStage: evaluated.failureStage,
      error: evaluated.error,
      checks: evaluated.checks,
      conversations: driver?.conversations,
      tabs: driver?.tabs,
      operations: driver?.operations,
      eventTimeline: driver?.eventTimeline,
      takeover: driver?.takeover,
      abortIsolation: driver?.abortIsolation,
      persistence: driver?.persistence,
      agentAssembly: driver?.agentAssembly,
      modelPlanning: driver?.modelPlanning,
      modelRestore: driver?.modelRestore,
      execution: driver?.execution,
      screenshots,
      evidenceDir: root,
    });
    await writeFile(join(root, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    for (const check of evaluated.checks) say(`${check.ok ? "PASS" : "FAIL"} ${check.name}`);
    say("INFO model-autonomous-planning requires separate real-model user-path acceptance");
    say(`evidence ${root}`);
    process.exitCode = evaluated.ok ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    say(`FAIL ${error?.stage ?? "run"} ${message}`);
    if (/chrome-main|CDP|ECONNREFUSED/i.test(message)) say(recoveryChromeMain());
    await writeFile(join(root, "result.json"), `${JSON.stringify({ ok: false, error: message, evidenceDir: root }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    try { await unlink(capabilityPath); } catch {}
    try { await fixture?.close(); } catch {}
    if (cdp) await cdp.close();
  }
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) main().catch((error) => { console.error(error); process.exit(1); });
