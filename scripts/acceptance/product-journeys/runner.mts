/**
 * product-journeys 单臂运行器：真实侧栏入口 → 生产 host（真模型）→ 隔离无头扩展 → 夹具页面。
 * 参考 everos-enable-live.mts（真面板 + WebSocketServer）与 selection-reading.mts（划词卡片 CDP）。
 * 每臂：新会话 + 独立页面；计划步骤（steer/追问/接管改字段/重启继续）按用例定义执行。
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { ConversationManager } from "../../../agent/src/conversation-manager.js";
import { ConversationStore } from "../../../agent/src/conversation-store.js";
import { createConversationRuntime } from "../../../agent/src/conversation-runtime.js";
import { TaskDispatcher, TaskReceiptStore } from "../../../agent/src/task-dispatcher.js";
import { MemoryStore } from "../../../agent/src/memory-store.js";
import { parseClientMessage, PROTOCOL_VERSION, HOST_VERSION, STORAGE_SCHEMA_VERSION, DEFAULT_PORT } from "../../../shared/protocol.js";
import { launchIsolatedExtension, sleep, until, type IsolatedExtension } from "../isolated-extension.mts";
import { createCdp, fetchJson } from "../cdp.mjs";
import type { JourneyCase, JourneyMaterial, PlannedStep } from "./cases.mjs";
import { judgeCase, type RunEvidence, type PageProbe, type Verdict } from "./oracle.mjs";
import type { JourneyRow } from "./stats.mjs";
import type { JourneyFixture } from "./fixtures.mts";

export interface RunnerEnv {
  iso: IsolatedExtension;
  panel: string;
  fixture: JourneyFixture;
  model: string;
  outRoot: string;
  events: { at: number; direction: string; message: Record<string, unknown> }[];
  getSocket(): WebSocket | undefined;
}

/** host 持有器：A04 重启后 current 指向新实例，事件流跨重启连续。 */
export type HostHolder = { current: HostHandle };

export interface HostHandle {
  manager: ConversationManager;
  wss: WebSocketServer;
  port: number;
  token: string;
  storeDir: string;
  events: RunnerEnv["events"];
  socket?: WebSocket;
}

/** 启动真实 host（ConversationManager + WS），与生产同一条 onMessage 链路。token 可复用以支持同臂重启。 */
export async function startHost(model: string, storeDir: string, events: RunnerEnv["events"], existingToken?: string, fixedPort?: number): Promise<HostHandle> {
  const token = existingToken ?? randomUUID();
  const store = new ConversationStore(join(storeDir, "conversations"));
  const memories = new MemoryStore(join(storeDir, "memory"));
  const host: HostHandle = { manager: undefined as unknown as ConversationManager, wss: undefined as unknown as WebSocketServer, port: 0, token, storeDir, events };
  const manager = new ConversationManager(
    (id, emit, summary) => createConversationRuntime(id, emit, model, { sessionManager: store.sessionManager(id), mode: summary?.mode, memoryStore: memories }),
    (message) => {
      events.push({ at: Date.now(), direction: "server", message: message as Record<string, unknown> });
      if (host.socket?.readyState === WebSocket.OPEN) host.socket.send(JSON.stringify(message));
    },
    store,
    memories,
    undefined,
    new TaskDispatcher(new TaskReceiptStore(join(storeDir, "receipts"))),
  );
  host.manager = manager;
  const wss = new WebSocketServer({ host: "127.0.0.1", port: fixedPort ?? 0 });
  wss.on("connection", (client) => {
    client.on("message", async (raw) => {
      const message = parseClientMessage(raw.toString());
      if (!message) return;
      if (message.type === "hello") {
        if (message.token !== token) { client.close(); return; }
        host.socket = client;
        const session = manager.get("default")!.runtime.session;
        client.send(JSON.stringify({ type: "hello_ok", version: PROTOCOL_VERSION, model: session.modelName(), models: await session.availableModels(), hostVersion: HOST_VERSION, storageSchema: STORAGE_SCHEMA_VERSION, extensionVersion: "0.1.0" }));
        client.send(JSON.stringify({ type: "conversation_list", conversations: manager.list() }));
        manager.replayState((m) => client.send(JSON.stringify(m)));
        return;
      }
      if (host.socket !== client) return;
      events.push({ at: Date.now(), direction: "client", message: message as Record<string, unknown> });
      void manager.handleMessage(message).catch((e) => events.push({ at: Date.now(), direction: "error", message: { error: String(e) } }));
    });
    client.on("close", () => { if (host.socket === client) { host.socket = undefined; manager.disconnect(); } });
  });
  await new Promise<void>((resolve, reject) => { wss.once("listening", resolve); wss.once("error", reject); });
  host.wss = wss;
  host.port = (wss.address() as { port: number }).port;
  await manager.ensureDefault();
  return host;
}

export async function stopHost(host: HostHandle): Promise<void> {
  host.manager.dispose();
  for (const client of host.wss.clients) client.terminate();
  await new Promise<void>((r) => host.wss.close(() => r()));
}

/** 启动隔离扩展并把 SW 的 WS 指向 host，打开真实侧栏。返回面板 target。 */
export async function startIsolatedPanel(host: HostHandle): Promise<{ iso: IsolatedExtension; panel: string }> {
  const iso = await launchIsolatedExtension();
  await iso.swEval(`globalThis.WebSocket=class extends WebSocket { constructor(url, protocols){super(url==='ws://127.0.0.1:${DEFAULT_PORT}'?'ws://127.0.0.1:${host.port}':url,protocols)} };`);
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(host.token)}})`);
  const id = (await iso.swEval("chrome.runtime.id")) as string;
  const panel = await iso.newTarget(`chrome-extension://${id}/sidepanel.html`);
  await until(async () => (await iso.evalIn(panel, "!!document.querySelector('#input')")) || undefined, 10_000, "panel");
  await iso.evalIn(panel, "window.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => host.socket?.readyState === WebSocket.OPEN || undefined, 15_000, "host connected");
  return { iso, panel };
}

const panelSend = async (iso: IsolatedExtension, panel: string, text: string) => {
  await iso.evalIn(panel, `(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
};

/** 页面探针：在页面主世界独立采集字段、字体、内容哨兵。 */
export const PAGE_PROBE = `(()=>{const f=window.__fixture??{};const fields={};for(const el of document.querySelectorAll('input,textarea,select')){if(!el.id&&!el.name)continue;if(el.type==='checkbox')fields[el.id||el.name]=el.checked;else if(el.type==='radio'){if(el.checked)fields[el.name]=el.value;}else fields[el.id||el.name]=el.value;}const main=document.querySelector('main')||document.body;return {title:document.title,url:location.pathname,currentText:(main.innerText||'').replace(/\\s+/g,' ').trim(),initialText:f.initialText??null,contentMutations:f.contentMutations??-1,attrMutations:f.attrMutations??-1,inputCounts:f.inputCounts??{},fontFamily:getComputedStyle(main).fontFamily,fields};})()`;

async function probePage(iso: IsolatedExtension, tabId: number): Promise<PageProbe> {
  const result = (await iso.swEval(
    `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:new Function(${JSON.stringify(`return ${PAGE_PROBE}`)})}).then(r=>r[0].result).catch(e=>({error:String(e)}))`,
    15_000,
  )) as PageProbe & { error?: string };
  if ("error" in result && result.error) throw new Error(`页面探针失败：${result.error}`);
  return result;
}

interface EventView { at: number; direction: string; message: Record<string, unknown> }

function eventKind(e: EventView): string {
  const m = e.message as { type?: string; event?: { kind?: string } };
  return m.type === "agent_event" ? String(m.event?.kind ?? "") : String(m.type ?? "");
}

function extractDeliveries(events: EventView[], conversationId: string) {
  return events
    .filter((e) => eventKind(e) === "user_delivery")
    .map((e) => {
      const m = e.message as { conversationId?: string; event?: { delivery?: { kind?: string; text?: string; runId?: string | null } } };
      return { kind: String(m.event?.delivery?.kind ?? ""), text: String(m.event?.delivery?.text ?? ""), runId: m.event?.delivery?.runId ?? null, conversationId: m.conversationId };
    })
    .filter((d) => d.kind && d.kind !== "ack" && d.text);
}

function extractReceipts(events: EventView[]) {
  return events
    .filter((e) => eventKind(e) === "notice" && (e.message as { event?: { receipt?: unknown } }).event?.receipt)
    .map((e) => {
      const r = (e.message as { event: { receipt: { requestId?: string; status?: string; action?: string } } }).event.receipt;
      return { requestId: String(r.requestId ?? ""), status: String(r.status ?? ""), action: r.action };
    });
}

function extractToolCalls(events: EventView[]) {
  return events
    .filter((e) => e.direction === "server" && e.message.type === "tool_call")
    .map((e) => {
      const m = e.message as { name?: string; params?: { target?: string; value?: string } };
      return { name: String(m.name ?? ""), at: e.at, params: { target: m.params?.target, value: m.params?.value } };
    });
}

async function waitTerminal(events: EventView[], host: HostHandle, conversationId: string, deadlineMs: number, minIndex = 0): Promise<"ended" | "timeout"> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const own = events.slice(minIndex).filter((e) => (e.message as { conversationId?: string }).conversationId === conversationId || (e.message as { event?: { conversationId?: string } }).event?.conversationId === conversationId);
    const ended = own.some((e) => ["agent_end", "error", "run_stopped"].includes(eventKind(e)));
    const streaming = host.manager.get(conversationId)?.runtime.session.isStreaming() === true;
    if (ended && !streaming) {
      // 静默期：吸收晚到的 turn 结束/交付，避免把上一轮的 agent_end 当终态
      const quietStart = events.length;
      await sleep(1_500);
      if (events.length !== quietStart) { await sleep(500); continue; }
      // 等正式交付补齐（最多 12s），与 live-suite 同一口径
      const makeup = Date.now() + 12_000;
      while (Date.now() < makeup) {
        const snap = host.manager.getTaskProgress(conversationId);
        const kind = snap?.conversationContext?.latestDelivery?.kind;
        if (kind === "finding" || kind === "reply") return "ended";
        const notice = own.some((e) => eventKind(e) === "notice");
        if (notice) return "ended";
        await sleep(150);
      }
      return "ended";
    }
    await sleep(150);
  }
  return "timeout";
}

/** 在页面里选中指定元素的文字（真实选区路径）。 */
async function selectInPage(iso: IsolatedExtension, target: string, selector: string): Promise<void> {
  await iso.evalIn(target, `(()=>{document.activeElement?.blur();const r=document.createRange();r.selectNodeContents(document.querySelector(${JSON.stringify(selector)}));const s=getSelection();s.removeAllRanges();s.addRange(r);document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true}));})()`);
  await sleep(300);
}

/** R02 专用：划词卡片路径（驱动真实 UI；回答文本由调用方从 reading_event 事件取证）。 */
async function runReadingCard(iso: IsolatedExtension, pageTarget: string, followup: string | undefined, deadlineMs: number): Promise<void> {
  await iso.clickButton(pageTarget, "解释");
  const records = async () => (await iso.swEval("chrome.storage.session.get('readingRecords').then(v=>v.readingRecords??[])")) as { turns: { state: string; text: string }[] }[];
  await until(async () => {
    const r = (await records()).at(-1);
    return r?.turns.length === 1 && r.turns[0].state === "done" ? r : undefined;
  }, deadlineMs, "reading turn 1");
  const first = (await records()).at(-1)?.turns[0]?.text ?? "";
  void first;
  if (!followup) return;
  // 卡片内追问（closed shadow root，走 CDP）
  const port = (await import("node:fs/promises")).readFile(join(iso.outDir, "profile", "DevToolsActivePort"), "utf8");
  const cdp = createCdp((await fetchJson(`http://127.0.0.1:${(await port).split("\n")[0]}/json/version`)).webSocketDebuggerUrl);
  await cdp.ready();
  const session = await cdp.attachSession(pageTarget);
  const find = (node: Record<string, any>): any => {
    if ((node.attributes as string[] | undefined)?.includes("data-sideagent-ask")) return node;
    for (const child of [...(node.children as any[] ?? []), ...(node.shadowRoots as any[] ?? [])]) {
      const found = find(child);
      if (found) return found;
    }
  };
  const doc = await cdp.send("DOM.getDocument", { depth: -1, pierce: true }, session);
  const hostNode = find(doc.root);
  if (!hostNode?.shadowRoots?.[0]) throw new Error("reading card shadow root missing");
  const resolved = await cdp.send("DOM.resolveNode", { backendNodeId: hostNode.shadowRoots[0].backendNodeId }, session);
  const ui = async (body: string) => {
    const result = await cdp.send("Runtime.callFunctionOn", { objectId: resolved.object.objectId, functionDeclaration: `function(){${body}}`, returnByValue: true, awaitPromise: true }, session);
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text));
    return result.result.value;
  };
  await ui(`const t=this.querySelector('textarea');t.value=${JSON.stringify(followup)};t.dispatchEvent(new Event('input',{bubbles:true}));this.querySelector('.send').click();`);
  await until(async () => {
    const r = (await records()).at(-1);
    return r?.turns.length === 2 && r.turns[1]?.state === "done" ? r : undefined;
  }, deadlineMs, "reading turn 2");
  await cdp.close().catch(() => {});
}

/** 执行一臂，返回行结果 + 判定 + 证据落盘。 */
export async function runOne(
  env: { iso: IsolatedExtension; panel: string; fixture: JourneyFixture; host: HostHolder; events: RunnerEnv["events"]; model: string; outRoot: string; restartHost: () => Promise<void> },
  jc: JourneyCase,
  mat: JourneyMaterial,
): Promise<{ row: JourneyRow; verdict: Verdict }> {
  const { iso, panel, fixture } = env;
  const outDir = join(env.outRoot, `${jc.caseId}-${mat.materialId}`);
  mkdirSync(outDir, { recursive: true });
  const events = env.events;
  const eventsBefore = events.length;
  const hitsBefore = fixture.hits();
  const writesBefore = fixture.writes().length;
  const interventions: JourneyRow["interventions"] = { planned: 0, forced: 0, reasons: [] };
  const startedAt = Date.now();
  const deadline = startedAt + jc.timeLimitMs;
  let status: JourneyRow["status"] = "fail";
  let reason = "";
  let conversationId = "default";
  let takeoverWindow: { start: number; end: number } | null = null;
  let restartAtMs: number | null = null;
  let deliveries: RunEvidence["deliveries"] = [];
  let tabId: number | null = null;

  try {
    // 新会话 + 独立页面
    await until(async () => (await iso.evalIn(panel, "document.querySelector('#conversation-new')?.disabled===false")) || undefined, 10_000, "new conversation ready");
    await iso.evalIn(panel, "document.querySelector('#conversation-new').click()");
    await sleep(300);
    conversationId = (await iso.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??'default')")) as string;
    const pageTarget = await iso.newTarget(`${fixture.origin}${mat.startPath}`);
    const tab = await until(async () => {
      const tabs = (await iso.swEval("chrome.tabs.query({})")) as { id: number; url: string }[];
      return tabs.find((t) => t.url.startsWith(`${fixture.origin}${new URL(mat.startPath, "http://x").pathname}`));
    }, 5_000, "fixture tab");
    tabId = tab.id;
    await iso.swEval(`chrome.tabs.update(${tabId},{active:true}).catch(()=>{})`).catch(() => {});
    await sleep(300);

    if (jc.caseId === "R02") {
      // 划词阅读路径：选中 → 卡片「解释」→ 卡片内追问
      const selector = String(mat.expect.selectionSelector);
      await until(async () => (await iso.evalIn(pageTarget, `!!document.querySelector(${JSON.stringify(selector)})`)) || undefined, 10_000, "term present");
      await selectInPage(iso, pageTarget, selector);
      const followup = mat.plannedSteps.find((s) => s.kind === "ask")?.text;
      await runReadingCard(iso, pageTarget, followup, Math.max(30_000, deadline - Date.now() - 30_000));
      interventions.planned = followup ? 1 : 0;
      // 证据以权威 reading_event（state=done）为准，不读 storage 内部结构
      const readingTexts = events.slice(eventsBefore)
        .filter((e) => (e.message as { type?: string; state?: string }).type === "reading_event" && (e.message as { state?: string }).state === "done")
        .map((e) => String((e.message as { text?: string }).text ?? ""));
      deliveries = readingTexts.map((text) => ({ kind: "reply", text, runId: null, conversationId: "reading-card" }));
      conversationId = "reading-card";
      status = "pass"; // 终止状态以交付为准；具体对错交给 oracle
    } else {
      await panelSend(iso, panel, mat.userText);
      let lastInputIndex = events.length;
      // 计划步骤
      for (const step of mat.plannedSteps) {
        await runPlannedStep(env, step, tabId, pageTarget, deadline, interventions, (w) => { takeoverWindow = w; }, (t) => { restartAtMs = t; });
        lastInputIndex = events.length;
        if (Date.now() > deadline) break;
      }
      const terminal = await waitTerminal(events, env.host.current, conversationId, Math.max(5_000, deadline - Date.now()), lastInputIndex);
      if (terminal === "timeout") {
        status = "timeout";
        reason = `超过时间上限 ${jc.timeLimitMs / 1000}s`;
      } else {
        status = "pass";
      }
      deliveries = extractDeliveries(events.slice(eventsBefore), conversationId);
    }
  } catch (error) {
    status = status === "timeout" ? "timeout" : "fail";
    reason = error instanceof Error ? error.message : String(error);
  }

  const endedAt = Date.now();
  // 独立证据：页面探针 + 夹具服务端状态
  let page: PageProbe | null = null;
  if (tabId !== null) {
    page = await probePage(iso, tabId).catch((e) => { reason += `；探针失败:${e instanceof Error ? e.message : e}`; return null; });
  }
  const hitsAfter = fixture.hits();
  const hits: Record<string, number> = {};
  for (const [k, v] of Object.entries(hitsAfter)) {
    const d = v - (hitsBefore[k] ?? 0);
    if (d > 0) hits[k] = d;
  }
  const writes = fixture.writes().slice(writesBefore).map((w) => ({ kind: w.kind, page: w.page, values: w.values, at: w.at, result: "ok" as const }));

  const evidence: RunEvidence = {
    caseId: jc.caseId,
    materialId: mat.materialId,
    conversationId,
    runId: null,
    deliveries,
    receipts: extractReceipts(events.slice(eventsBefore)),
    toolCalls: extractToolCalls(events.slice(eventsBefore)),
    hits,
    writes,
    page,
    takeoverWindow,
    restartAtMs,
    ended: status !== "timeout",
    timedOut: status === "timeout",
  };
  const verdict = judgeCase(jc, mat, evidence);
  if (!verdict.qualified && status === "pass") {
    status = "fail";
    reason = verdict.checks.filter((c) => !c.ok).map((c) => `${c.id}:${c.detail}`).join(" | ");
  }

  const lastDeliveryAt = (() => {
    const own = events.slice(eventsBefore).filter((e) => eventKind(e) === "user_delivery" || eventKind(e) === "reading_event");
    return own.length ? own.at(-1)!.at : null;
  })();
  const row: JourneyRow = {
    caseId: jc.caseId,
    family: jc.family,
    materialId: mat.materialId,
    started: true,
    status: verdict.qualified ? "pass" : status === "timeout" ? "timeout" : "fail",
    qualified: verdict.qualified,
    safetyVeto: verdict.safetyVeto,
    totalMs: verdict.qualified && lastDeliveryAt ? lastDeliveryAt - startedAt : null,
    waitedMs: endedAt - startedAt,
    interventions,
    reason: verdict.qualified ? "pass" : reason || "未达标",
  };

  await iso.screenshot(panel, join(outDir, "panel-final.png")).catch(() => {});
  if (tabId !== null) await iso.screenshot(String(tabId), join(outDir, "page-final.png")).catch(() => {});
  writeFileSync(join(outDir, "events.json"), JSON.stringify(events.slice(eventsBefore), null, 2));
  writeFileSync(join(outDir, "run.json"), JSON.stringify({ row, verdict, evidence: { ...evidence, deliveries: deliveries.map((d) => ({ ...d, text: String(d.text ?? "").slice(0, 2000) })) }, model: env.model, startedAt, endedAt }, null, 2));
  if (tabId !== null) await iso.swEval(`chrome.tabs.remove(${tabId}).catch(()=>{})`).catch(() => {});
  return { row, verdict };
}

async function runPlannedStep(
  env: { iso: IsolatedExtension; panel: string; host: HostHolder; restartHost: () => Promise<void> },
  step: PlannedStep,
  tabId: number,
  pageTarget: string,
  deadline: number,
  interventions: JourneyRow["interventions"],
  setTakeover: (w: { start: number; end: number }) => void,
  setRestartAt: (at: number) => void,
): Promise<void> {
  const { iso, panel } = env;
  const events = env.host.current.events;
  const waitCue = async () => {
    const want = step.after === "first-delivery" ? "user_delivery" : "tool_call";
    const base = events.length;
    await until(() => events.slice(base).some((e) => eventKind(e) === want || (want === "tool_call" && e.message.type === "tool_call")) || undefined, Math.max(10_000, deadline - Date.now()), `cue:${step.after}`);
  };
  switch (step.kind) {
    case "steer":
    case "ask":
      await waitCue();
      await panelSend(iso, panel, step.text!);
      interventions.planned += 1;
      break;
    case "takeover-edit": {
      await waitCue();
      await until(async () => (await iso.evalIn(panel, "(()=>{const b=document.querySelector('#takeover-btn');return b&&!b.hidden&&!b.disabled;})()")) || undefined, 30_000, "takeover button");
      await iso.evalIn(panel, "document.querySelector('#takeover-btn').click()");
      const base = events.length;
      await until(() => events.slice(base).some((e) => JSON.stringify(e.message).includes('"control_result"') && JSON.stringify(e.message).includes('"takeover"')) || undefined, 30_000, "takeover confirmed");
      const windowStart = Date.now();
      // 人工修改（真实页面输入事件）
      const edit = step.editField!;
      await iso.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:(sel,val)=>{const el=document.querySelector(sel);el.focus();el.value=val;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},args:[${JSON.stringify(edit.selector)},${JSON.stringify(edit.value)}]})`);
      await sleep(300);
      // 交还：页面内「交还」按钮（content cursor UI，closed shadow root）
      await iso.clickButton(pageTarget, "交还");
      await until(() => events.slice(base).some((e) => JSON.stringify(e.message).includes('"handback"')) || undefined, 30_000, "handback confirmed");
      setTakeover({ start: windowStart, end: Date.now() });
      interventions.planned += 1;
      break;
    }
    case "restart-continue": {
      await waitCue();
      setRestartAt(Date.now());
      await env.restartHost();
      await panelSend(iso, panel, step.text ?? "继续");
      interventions.planned += 1;
      break;
    }
  }
}
