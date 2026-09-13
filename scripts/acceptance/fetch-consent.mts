/** Real panel -> background -> manager authorization -> real extension fetch.
 * The native transport and model are fixtures; only the local HTTP counter is written.
 */
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {mkdir, writeFile} from "node:fs/promises";
import {join, resolve} from "node:path";
import {BrowserAgentSession} from "../../agent/src/session.js";
import {createConversationRuntime} from "../../agent/src/conversation-runtime.js";
import {ConversationManager} from "../../agent/src/conversation-manager.js";
import {parseClientMessage, type ServerMessage} from "../../shared/protocol.js";
import {launchIsolatedExtension, until, sleep} from "./isolated-extension.mts";

if (!process.argv.includes("--headless")) throw new Error("Required: --headless");
const out = resolve("out/acceptance", `fetch-consent-${new Date().toISOString().replace(/[:.]/g, "-")}`);
await mkdir(out, {recursive: true});
const received: Array<{method: string; body: string}> = [];
const server = createServer(async (req, res) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  if (req.method === "POST") received.push({method: req.method, body});
  res.writeHead(200, {"content-type": "application/json"});
  res.end(JSON.stringify({count: received.length}));
});
await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
const port = (server.address() as {port: number}).port;
const url = `http://consent-fixture.test:${port}/counter`;
const iso = await launchIsolatedExtension({hostResolverRules: "MAP consent-fixture.test 127.0.0.1"});
let manager!: ConversationManager;
let bridge = Promise.resolve();
const failures: string[] = [];
const sends = (message: ServerMessage) => {
  bridge = bridge.then(async () => {
    if (message.type === "tool_call") {
      const result = await iso.swEval(`globalThis.__saCall(${JSON.stringify(message.id)},${JSON.stringify(message.name)},${JSON.stringify(message.params)},${JSON.stringify(message.sessionId ?? "main")},${JSON.stringify(message.programId)},${JSON.stringify(message.conversationId ?? "default")},${JSON.stringify({runId: message.runId, epochs: message.epochs})})`);
      const parsed = parseClientMessage(JSON.stringify(result));
      assert.ok(parsed);
      await manager.handleMessage(parsed);
    } else await iso.swEval(`globalThis.__saHandleServer(${JSON.stringify(message)})`);
  }).catch(error => { failures.push(String(error)); });
};
const originalCreate = BrowserAgentSession.create;
let tools: any[] = [];
const results: Record<string, unknown> = {scope: "real compiled panel/background, production ConversationManager/runtime/tool assembly and local HTTP counter; model/native transport substituted"};
try {
  BrowserAgentSession.create = async (_rpc, callbacks, options) => {
    tools = options?.customTools ?? [];
    let running = false, epoch = 0;
    return {
      available: true, modelName: () => "fixture/model", availableModels: async () => [],
      setTeamToolsMounted() {}, isToolActive: () => true, executionEpoch: () => epoch,
      canWriteCurrentInput: () => true, assertTaskResultExecution() {}, observeProgramStep() {},
      isHeld: () => false, isStreaming: () => running,
      startTask: () => {running = true; callbacks.emit({kind: "agent_start"});},
      steerCurrentTask: async () => {epoch++;},
      abort: () => {running = false; epoch++;}, dispose() {},
    } as unknown as BrowserAgentSession;
  };
  manager = new ConversationManager((id, emit) => createConversationRuntime(id, emit), sends);
  await manager.ensureDefault();
  BrowserAgentSession.create = originalCreate;
  const extId = await iso.swEval("chrome.runtime.id");
  const panel = await iso.newTarget(`chrome-extension://${extId}/sidepanel.html`);
  await until(async () => await iso.evalIn(panel, "Boolean(document.querySelector('#input'))") ? true : undefined, 15000, "panel loaded");
  sends({type: "hello_ok", version: 1, model: "fixture/model", models: []});
  sends({type: "conversation_list", conversations: manager.list()});
  await bridge;
  await sleep(150);
  async function pump() {
    const frames = await iso.swEval("globalThis.__saConsentClientFrames.splice(0)") as unknown[];
    for (const frame of frames) {
      const parsed = parseClientMessage(JSON.stringify(frame));
      assert.ok(parsed);
      await manager.handleMessage(parsed);
    }
    await bridge;
    assert.deepEqual(failures, []);
  }
  await pump();
  const startRequest = {requestId: "start", conversationId: "default", source: "text" as const, action: "start" as const, expectedRunId: null, text: "确认一次本地测试请求"};
  const start = await manager.dispatchTaskAction(startRequest);
  assert.equal(start.status, "accepted");
  await bridge;
  const fetch = tools.find(tool => tool.name === "fetch")!;
  const program = tools.find(tool => tool.name === "browser_run")!;
  async function request(tool: any, id: string, args: unknown, allow: boolean, screenshot = false, beforeChoice?: () => Promise<void>) {
    let settled = false, error: unknown;
    const pending = tool.execute(id, args, undefined, undefined, {}).then(() => {settled = true;}, (e: unknown) => {settled = true; error = e;});
    await until(async () => {
      await pump();
      return await iso.evalIn(panel, "Boolean(document.querySelector('.consent-allow:not(:disabled)'))") ? true : undefined;
    }, 10000, "real approval button");
    assert.equal(settled, false);
    const before = received.length;
    await beforeChoice?.();
    await pump();
    if (screenshot) {
      await iso.evalIn(panel, "document.documentElement.style.width='390px'; document.body.style.width='390px'; document.querySelector('.consent-card details').open=true");
      await iso.screenshot(panel, join(out, "approval.png"));
    }
    const clickable = await iso.evalIn(panel, `(() => {
      const button=document.querySelector(${JSON.stringify(allow ? ".consent-allow" : ".consent-reject")});
      button.scrollIntoView({block:'nearest'});
      const r=button.getBoundingClientRect(), hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return r.width>0 && r.height>0 && (hit===button || button.contains(hit));
    })()`);
    assert.equal(clickable, true, "approval action must be visibly clickable");
    await iso.evalIn(panel, `document.querySelector(${JSON.stringify(allow ? ".consent-allow" : ".consent-reject")}).click()`);
    await until(async () => {await pump(); return settled ? true : undefined;}, 15000, "choice applied");
    await pending;
    assert.equal(received.length, before + (allow ? 1 : 0));
    assert.equal(!!error, !allow);
    return {before, after: received.length, error: error ? String(error) : null};
  }
  results.directAllowed = await request(fetch, "direct", {url, method: "POST", body: '{"request":"direct"}'}, true, true);
  results.programRejected = await request(program, "reject-program", {code: `return await browser.fetch(${JSON.stringify({url, method: "POST", body: '{"request":"rejected"}'})});`}, false);
  results.programAllowed = await request(program, "allow-program", {code: `return await browser.fetch(${JSON.stringify({url, method: "POST", body: '{"request":"program"}'})});`}, true);
  results.invalidControlPreservesApproval = await request(fetch, "after-invalid", {url, method: "POST", body: '{"request":"validated"}'}, true, false, async () => {
    const stale = await manager.dispatchTaskAction({requestId: "stale-control", conversationId: "default", source: "text", action: "steer", expectedRunId: "stale-run", text: "修改过期任务"});
    assert.equal(stale.status, "rejected");
    assert.equal((await manager.dispatchTaskAction(startRequest)).status, "accepted");
  });
  let cancelled = false;
  const waiting = fetch.execute("cancel-pending", {url, method: "POST", body: '{"request":"must-not-send"}'}, undefined, undefined, {}).then(() => {throw new Error("cancelled request executed");}, () => {cancelled = true;});
  const pendingId = await until(async () => {
    await pump();
    return await iso.evalIn(panel, "document.querySelector('.consent-allow:not(:disabled)')?.closest('.consent-card')?.dataset.requestId") as string | undefined;
  }, 10000, "approval before changing task");
  const changed = await manager.dispatchTaskAction({requestId: "new-direction", conversationId: "default", source: "text", action: "steer", expectedRunId: manager.getTaskProgress("default")!.runId ?? null, text: "先整理信息，不发送这次请求"});
  assert.equal(changed.status, "accepted");
  await waiting;
  await manager.handleMessage({type: "consent_decision", conversationId: "default", requestId: pendingId, allow: true});
  await pump();
  assert.equal(cancelled, true);
  results.changedTaskRejectsLateApproval = true;
  assert.deepEqual(received.map(item => JSON.parse(item.body).request), ["direct", "program", "validated"]);
  const overflow = await iso.evalIn(panel, "document.documentElement.scrollWidth > document.documentElement.clientWidth");
  assert.equal(overflow, false);
  Object.assign(results, {passed: true, received, horizontalOverflow: overflow});
} catch (error) {
  Object.assign(results, {passed: false, error: String(error), bridgeFailures: failures});
  throw error;
} finally {
  BrowserAgentSession.create = originalCreate;
  manager?.dispose();
  await bridge;
  await iso.close();
  await new Promise<void>(r => server.close(() => r()));
  await writeFile(join(out, "result.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({out, ...results}));
}
