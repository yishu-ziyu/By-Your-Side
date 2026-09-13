/**
 * Confirmation handoff through the real manager, session and isolated extension.
 * Transcription/classification and the Pi SDK are fixtures; this is not acoustic
 * or model acceptance. No user profile, host or personal trace is touched.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConversationManager } from "../../agent/src/conversation-manager.js";
import { BrowserAgentSession } from "../../agent/src/session.js";
import { RunTrace } from "../../agent/src/run-trace.js";
import type { ServerMessage } from "../../shared/protocol.js";
import type { VoiceRouteContext } from "../../shared/voice.js";
import { launchIsolatedExtension, until } from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless (isolated Chrome only)");
const output = resolve("out/acceptance", `voice-confirm-context-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(output, {recursive: true});
const sourceHashes = Object.fromEntries(await Promise.all([
  "agent/src/conversation-manager.ts", "agent/src/voice-confirm.ts", "agent/src/session.ts", "extension/dist/background.js",
].map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
const browser = await launchIsolatedExtension();
let manager: ConversationManager | undefined;
const calls: Array<{name: string; params: Record<string, unknown>}> = [];
const steers: Array<{text: string; images?: unknown[]}> = [];
let trace: RunTrace | undefined;
try {
  const pageA = await browser.newTarget(`${browser.fixtureOrigin}/original-a`);
  const pageB = await browser.newTarget(`${browser.fixtureOrigin}/confirmation-b`);
  for (const target of [pageA, pageB]) {
    await until(async () => await browser.evalIn(target, "document.readyState === 'complete'") ? true : undefined, 10000, "fixture document");
  }
  await browser.evalIn(pageA, "document.title='原页面A'; document.body.innerHTML='<h1>ORIGINAL_A_INITIAL</h1><input aria-label=原字段 value=A_UNCHANGED>'");
  await browser.evalIn(pageB, "document.title='确认时页面B'; document.body.innerHTML='<h1>CONFIRMATION_B_ONLY</h1><input aria-label=其他字段 value=B_UNCHANGED>'");
  const tabs = await browser.swEval("chrome.tabs.query({})") as Array<{id: number; url: string; title: string}>;
  const tabA = tabs.find(tab => tab.url === `${browser.fixtureOrigin}/original-a`)!;
  const tabB = tabs.find(tab => tab.url === `${browser.fixtureOrigin}/confirmation-b`)!;
  assert.ok(tabA?.id && tabB?.id, "both real tabs exist");
  let running = false;
  const raw = {
    model: {id: "no-model-fixture", provider: "fixture"},
    get isStreaming() { return running; },
    steer: async (text: string, images?: unknown[]) => { steers.push({text, images}); },
  };
  const rpc = { call: async (name: string, params: Record<string, unknown>) => {
    calls.push({name, params});
    const response = await browser.tool(name, params, "main");
    if (!response.ok) throw new Error(response.error);
    return response.data;
  } };
  let wrapped!: BrowserAgentSession;
  manager = new ConversationManager(async (_id, emit) => {
    const Session = BrowserAgentSession as unknown as new (...args: any[]) => BrowserAgentSession;
    wrapped = new Session(raw, null, {
      emit: (event: Extract<ServerMessage, {type: "agent_event"}>["event"]) => emit({type: "agent_event", event}),
      setStatus: (state: "idle" | "running" | "user") => emit({type: "status", state}),
    }, null, null, undefined, null, rpc);
    trace = new RunTrace(join(output, "traces"));
    (wrapped as any).runTrace = trace;
    wrapped.startTask = () => { running = true; emit({type: "agent_event", event: {kind: "agent_start"}}); };
    wrapped.classifyVoiceInput = async text => ({steps: [{action: "steer", text, target: null}]});
    return {session: wrapped, fleet: {reset() {}, isGroupHeld: () => false}, rpc: {rejectAll() {}}, dispose() {}} as any;
  }, () => {});
  await manager.ensureDefault();
  const start = await manager.dispatchTaskAction({requestId: "start", conversationId: "default", source: "text", action: "start", expectedRunId: null, text: "查看当前网页"});
  assert.equal(start.status, "accepted");
  const input: VoiceRouteContext = {
    requestId: "correction", voiceId: "fixture-voice", turn: 1,
    runId: manager.getTaskProgress("default")!.runId ?? null, controlVersion: 0,
    input: {context: {tabId: tabA.id, title: tabA.title, url: tabA.url}},
  };
  const asked = await manager.routeVoiceInput("default", "不是刚才那个，改看当前页面", null, () => true, input);
  assert.equal(asked.kind, "clarify");
  assert.equal(steers.length, 0);
  // The original document changes while confirmation is pending; a new snapshot
  // must contain this value, rather than old page content or the active page B.
  await browser.evalIn(pageA, "document.querySelector('h1').textContent='ORIGINAL_A_FRESH_AFTER_QUESTION'");
  await browser.swEval(`chrome.tabs.update(${tabB.id}, {active: true})`);
  const activeTab = await browser.swEval("chrome.tabs.query({active:true,lastFocusedWindow:true}).then(t=>t[0]?.id)");
  assert.equal(activeTab, tabB.id);
  const previousEpoch = wrapped.executionEpoch();
  const confirmation = await manager.routeVoiceInput("default", "对", null, () => true, {
    ...input, requestId: "confirmation", turn: 2,
    input: {context: {tabId: tabB.id, title: tabB.title, url: tabB.url}},
  });
  const checks = {
    confirmed: confirmation.kind === "steer" && confirmation.ok,
    originalPageRead: calls.length === 1 && calls[0]!.name === "snapshot" && calls[0]!.params.tabId === tabA.id,
    freshOriginalContent: steers.length === 1 && steers[0]!.text.includes("ORIGINAL_A_FRESH_AFTER_QUESTION"),
    noOtherPageContent: !steers.some(steer => steer.text.includes("CONFIRMATION_B_ONLY") || steer.text.includes(tabB.url)),
    oldWriteEpochInvalidated: wrapped.executionEpoch() > previousEpoch && !wrapped.canWriteCurrentInput(),
    fixturesUnchanged: await browser.evalIn(pageA, "document.querySelector('input').value") === "A_UNCHANGED" && await browser.evalIn(pageB, "document.querySelector('input').value") === "B_UNCHANGED",
  };
  const evidence = {passed: Object.values(checks).every(Boolean), scope: "real manager + actual BrowserAgentSession + isolated built Chrome extension; synthetic transcript/classifier/SDK, no audio or external model", sourceHashes, originalTabId: tabA.id, confirmationTabId: tabB.id, checks, calls, confirmation, steers};
  await writeFile(join(output, "result.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({output, ...checks, passed: evidence.passed}));
  assert.ok(evidence.passed, "confirmation must deliver fresh original-page context");
} finally {
  manager?.dispose();
  await trace?.flush();
  await browser.close();
}
