/** Production panel/Port/background/WS/Pi/tools in isolated headless Chrome.
 * The transport server uses the production conversation runtime with private stores.
 * A test-only barrier tool makes insertion timing repeatable; it is not a latency test.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { Type } from 'typebox';
import { ConversationManager } from '../../agent/src/conversation-manager.js';
import { ConversationStore } from '../../agent/src/conversation-store.js';
import { createConversationRuntime } from '../../agent/src/conversation-runtime.js';
import { TaskDispatcher, TaskReceiptStore } from '../../agent/src/task-dispatcher.js';
import { loadConfig } from '../../agent/src/config.js';
import { DEFAULT_PORT, PROTOCOL_VERSION, HOST_VERSION, STORAGE_SCHEMA_VERSION, parseClientMessage } from '../../shared/protocol.js';
import { launchIsolatedExtension, until, sleep } from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('Required: --headless');
const out = resolve('out/acceptance', `continuous-steering-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(out, { recursive: true });
const sourceFiles = ['agent/src/session.ts','agent/src/conversation-manager.ts','agent/src/fleet.ts','agent/src/task-dispatcher.ts','extension/dist/background.js','extension/dist/sidepanel.js','scripts/acceptance/continuous-steering.mts'];
const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async p => [p, createHash('sha256').update(await readFile(p)).digest('hex')])));
const model = loadConfig().model;
const token = randomUUID();
const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>独立助手表单</title><h1>联系信息</h1><form><label for="name">姓名</label><input id="name"><label for="email">邮箱</label><input id="email" value="keep@example.com"><button>提交</button></form><script>window.writes=[];window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};document.querySelectorAll('input').forEach(e=>e.addEventListener('input',()=>window.writes.push({field:e.id,value:e.value,at:Date.now()})));</script>`;
const events: any[] = [];
const cases: any[] = [];
let socket: WebSocket | undefined;
let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;
let panel = '';
let holdNextSnapshot = false;
let heldSnapshot: any = null;
let barrier: { entered: boolean; release: () => void; promise: Promise<void> };
function resetBarrier() {
  let release!: () => void;
  barrier = { entered: false, promise: new Promise<void>(r => { release = r; }), release: () => release() };
}
resetBarrier();
const store = new ConversationStore(join(out, 'conversations'));
const manager = new ConversationManager((id, emit, summary) => createConversationRuntime(id, emit, model, {
  sessionManager: store.sessionManager(id), mode: summary?.mode,
  customTools: [{
    name: 'await_fixture_release', label: '等待验收资料', description: 'Wait for the local fixture test barrier before changing page fields.',
    parameters: Type.Object({}),
    execute: async (_id: string, _params: unknown, signal?: AbortSignal) => {
      const current = barrier;
      current.entered = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => { cleanup(); reject(new Error('Fixture wait cancelled')); };
        const cleanup = () => signal?.removeEventListener('abort', abort);
        if (signal?.aborted) { abort(); return; }
        signal?.addEventListener('abort', abort, { once: true });
        void current.promise.then(() => { cleanup(); resolve(); });
      });
      return { content: [{ type: 'text' as const, text: '资料已就绪。操作前处理所有最新补充要求。' }], details: {} };
    },
  }],
}), message => {
  events.push({ at: Date.now(), direction: 'server', message });
  if (holdNextSnapshot && message.type === 'tool_call' && message.name === 'snapshot') {
    holdNextSnapshot = false;
    heldSnapshot = message;
    return;
  }
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}, store, undefined, undefined, new TaskDispatcher(new TaskReceiptStore(join(out, 'receipts'))));
const wss = new WebSocketServer({ host: '127.0.0.1', port: DEFAULT_PORT });
const listening = new Promise<void>((resolve, reject) => { wss.once('listening', resolve); wss.once('error', reject); });
wss.on('connection', client => {
  client.on('message', async raw => {
    const message = parseClientMessage(raw.toString());
    if (!message) return;
    if (message.type === 'hello') {
      if (message.token !== token) { client.close(); return; }
      socket = client;
      const session = manager.get('default')!.runtime.session;
      client.send(JSON.stringify({ type: 'hello_ok', version: PROTOCOL_VERSION, model: session.modelName(), models: await session.availableModels(), hostVersion: HOST_VERSION, storageSchema: STORAGE_SCHEMA_VERSION, extensionVersion: '0.1.0' }));
      client.send(JSON.stringify({ type: 'conversation_list', conversations: manager.list() }));
      manager.replayState(m => client.send(JSON.stringify(m)));
      return;
    }
    if (client !== socket) return;
    events.push({ at: Date.now(), direction: 'client', message });
    void manager.handleMessage(message).catch(error => events.push({ at: Date.now(), error: String(error) }));
  });
  client.on('close', () => { if (socket === client) { socket = undefined; manager.disconnect(); } });
});
const panelEval = (expression: string) => iso!.evalIn(panel, expression);
const send = async (text: string) => {
  await panelEval(`(()=>{const e=document.querySelector('#input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  await until(async () => await panelEval("document.querySelector('#input').value === ''") || undefined, 5000, 'panel accepted input');
};
const receipt = (text: string) => events.map(e => e.message?.event?.receipt).find(r => r?.text === text);
async function createCase(title: string) {
  resetBarrier();
  const requestId = randomUUID();
  await panelEval(`probePort.postMessage({kind:'client',msg:{type:'conversation_create',requestId:${JSON.stringify(requestId)},title:${JSON.stringify(title)}}})`);
  const event = await until(() => events.find(e => e.message?.type === 'conversation_created' && e.message.requestId === requestId), 10000, 'conversation created');
  const id = event.message.conversation.id;
  await until(async () => (await iso!.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId)")) === id || undefined, 5000, 'selected conversation');
  await sleep(500);
  const target = await iso!.newTarget(`${iso!.fixtureOrigin}/${id}`);
  await until(async () => await iso!.evalIn(target, "document.readyState==='complete'") || undefined, 5000, 'fixture');
  await iso!.evalIn(target, `document.title='连续插话验收';document.body.innerHTML='<h1>联系信息</h1><form><label for="name">姓名</label><input id="name"><label for="email">邮箱</label><input id="email" value="keep@example.com"><label for="city">城市</label><input id="city"><label for="note">备注</label><input id="note"><button>提交</button></form>';window.writes=[];window.submits=0;document.querySelector('form').onsubmit=e=>{e.preventDefault();window.submits++};document.querySelectorAll('input').forEach(e=>e.addEventListener('input',()=>window.writes.push({field:e.id,value:e.value,at:Date.now()})));`);
  const tabs = await iso!.swEval('chrome.tabs.query({})') as any[];
  const tab = tabs.find(t => t.url === `${iso!.fixtureOrigin}/${id}`);
  await iso!.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
  const state = () => iso!.evalIn(target, "({name:document.querySelector('#name').value,email:document.querySelector('#email').value,city:document.querySelector('#city').value,note:document.querySelector('#note').value,submits:window.submits,writes:window.writes})");
  return { id, target, tab, state };
}
async function complete(id: string) {
  await until(() => manager.getTaskProgress(id)?.state === 'idle' && !manager.get(id)!.runtime.session.isStreaming() || undefined, 120000, 'task completed');
  await sleep(300);
}
const report: any = { passed: false, selection: process.argv.includes('--thinking-only') ? 'thinking-only' : process.argv.includes('--observation-only') ? 'observation-only' : process.argv.includes('--team-only') ? 'team-only' : process.argv.includes('--controls-only') ? 'controls-only' : 'all', scope: 'isolated headless production panel + Port + background + WS + actual Pi/model + production browser tools; guided barrier and assigned team setup, no native host or microphone', model, cases, hashes };
try {
  await listening;
  const initial = await manager.ensureDefault();
  assert(initial.runtime.session.available, 'configured model available');
  report.actualModel = initial.runtime.session.modelName();
  iso = await launchIsolatedExtension({ fixtureHtml });
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const extensionId = await iso.swEval('chrome.runtime.id');
  panel = await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => await panelEval("!!document.querySelector('#input')") || undefined, 10000, 'panel');
  await panelEval("globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => socket?.readyState === WebSocket.OPEN || undefined, 15000, 'real WS connected');
  await sleep(1000);

  if (report.selection === 'all') {
    const continuous = await createCase('连续三条修改');
    await send('先调用 await_fixture_release 等待资料，等待结束后填写姓名为张三、城市为北京、备注为初稿。保留邮箱，不提交。只操作当前本地表单。');
    await until(() => barrier.entered || undefined, 60000, 'model at controlled wait');
    const edits = ['姓名改成李四。保留邮箱。', '城市改成上海。', '备注填写地铁附近。不要提交。'];
    for (const text of edits) { await send(text); await until(() => receipt(text) || undefined, 20000, 'steer receipt'); assert.equal(receipt(text).status, 'accepted'); }
    const acceptedAt = Date.now();
    barrier.release();
    await complete(continuous.id);
    const result = await continuous.state();
    assert.equal(result.name, '李四'); assert.equal(result.city, '上海'); assert.equal(result.note, '地铁附近'); assert.equal(result.email, 'keep@example.com'); assert.equal(result.submits, 0);
    assert.equal(result.writes.filter((w: any) => w.at >= acceptedAt && ['张三', '北京', '初稿'].includes(w.value)).length, 0, 'no old-plan writes after all receipts');
    cases.push({ name: 'three edits during running task', passed: true, result, receipts: edits.map(receipt) });
    const sessionPath = (await readFile(join(out, 'conversations', continuous.id, 'session-path.txt'), 'utf8')).trim();
    const history = (await readFile(sessionPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.type === 'message').map(e => e.message);
    const firstEdit = history.findIndex(m => m.role === 'user' && JSON.stringify(m.content).includes(edits[0]));
    assert(firstEdit >= 0, 'first edit persisted');
    const nextResponse = history.findIndex((m, i) => i > firstEdit && m.role === 'assistant');
    const inputs = history.slice(firstEdit, nextResponse).filter(m => m.role === 'user').map(m => JSON.stringify(m.content)).join('\n');
    const allInNextTurn = edits.every(text => inputs.includes(text));
    cases.push({ name: 'all queued edits consumed before next model response', passed: allInNextTurn });
    await iso.screenshot(continuous.target, join(out, 'continuous-result.png'));
    await iso.screenshot(panel, join(out, 'continuous-panel.png'));
  }

  if (report.selection === 'all' || report.selection === 'thinking-only') {
    const thinking = await createCase('思考中补充');
    await send('先调用 await_fixture_release 等待资料，随后填写姓名为旧名字、城市为旧城市。保留邮箱，不提交。');
    const thinkingStart = await until(() => events.find(e => e.message?.conversationId === thinking.id && e.message.event?.kind === 'thinking_delta') || undefined, 60000, 'actual thinking stream');
    const thinkingTexts = ['姓名使用陈七。', '城市使用成都。', '备注使用安静房间。邮箱保留，不提交。'];
    for (const text of thinkingTexts) {
      await send(text); await until(() => receipt(text) || undefined, 20000, 'thinking edit receipt');
      assert.equal(receipt(text).status, 'accepted');
    }
    const inputEvents = thinkingTexts.map(text => events.find(e => e.direction === 'client' && e.message?.request?.text === text)!);
    barrier.release(); await complete(thinking.id);
    const firstTool = events.find(e => e.at >= thinkingStart.at && e.message?.conversationId === thinking.id && e.message.event?.kind === 'tool_start');
    const duringThinking = !!firstTool && inputEvents.every(e => e.at < firstTool.at);
    const thinkingResult = await thinking.state();
    assert.equal(thinkingResult.name, '陈七'); assert.equal(thinkingResult.city, '成都'); assert.equal(thinkingResult.note, '安静房间'); assert.equal(thinkingResult.email, 'keep@example.com'); assert.equal(thinkingResult.submits, 0);
    cases.push({ name: 'three edits during actual thinking reach final page', passed: duringThinking, inputTimes: inputEvents.map(e => e.at), firstToolAt: firstTool?.at, result: thinkingResult });
  }

  if (report.selection === 'all' || report.selection === 'observation-only') {
    const observation = await createCase('读取期间停止');
    await send('先调用 await_fixture_release 等待资料，之后填写姓名为不应填写。保留邮箱，不提交。');
    await until(() => barrier.entered || undefined, 60000, 'task waiting before observation correction');
    holdNextSnapshot = true;
    const text = '不是这个页面，先重新看当前页面再改姓名。';
    await send(text);
    await until(() => heldSnapshot || undefined, 5000, 'correction snapshot is in flight');
    const stoppedAt = Date.now();
    await panelEval("document.querySelector('#send-btn').click()");
    await until(() => manager.getTaskProgress(observation.id)?.state === 'aborted' || undefined, 3000, 'stop bypasses waiting correction');
    const confirmedAt = Date.now();
    socket!.send(JSON.stringify(heldSnapshot)); heldSnapshot = null;
    barrier.release();
    await until(() => receipt(text) || undefined, 10000, 'cancelled correction has a receipt');
    await manager.get(observation.id)!.runtime.session.waitForStop(); await sleep(300);
    const result = await observation.state();
    cases.push({ name: 'stop bypasses correction pre-observation and late correction is rejected', passed: receipt(text).status === 'rejected' && result.writes.length === 0, stoppedAt, confirmedAt, receipt: receipt(text), result });
  }

  if (report.selection === 'all' || report.selection === 'controls-only') {
    const stopped = await createCase('停止等待任务');
    await send('先调用 await_fixture_release 等待资料，之后把姓名填成不应写入。保留邮箱，不提交。');
    await until(() => barrier.entered || undefined, 60000, 'stop wait');
    const stopAt = Date.now();
    await panelEval("document.querySelector('#send-btn').click()");
    await until(() => manager.getTaskProgress(stopped.id)?.state === 'aborted' || undefined, 10000, 'stop applied');
    barrier.release(); await manager.get(stopped.id)!.runtime.session.waitForStop(); await sleep(1500);
    const stoppedState = await stopped.state();
    assert.equal(stoppedState.name, ''); assert.equal(stoppedState.submits, 0);
    cases.push({ name: 'stop cancels tool wait and prevents late writes', passed: true, stopAt, result: stoppedState });

    const paused = await createCase('暂停补充并恢复');
    await send('先调用 await_fixture_release 等待资料，再填写姓名为王五。保留邮箱，不提交。');
    await until(() => barrier.entered || undefined, 60000, 'pause wait');
    await panelEval("document.querySelector('#takeover-btn').click()");
    await until(() => manager.getTaskProgress(paused.id)?.state === 'paused' || undefined, 10000, 'page handed to user');
    const pausedEdit = '姓名改成赵六，城市填写杭州。保留邮箱，不提交。';
    await send(pausedEdit);
    await until(() => receipt(pausedEdit) || undefined, 10000, 'paused edit saved');
    assert.equal(receipt(pausedEdit).status, 'accepted');
    assert.equal((await paused.state()).name, '', 'no write while user owns page');
    barrier.release();
    await iso.clickButton(paused.target, '交还');
    await until(() => manager.getTaskProgress(paused.id)?.state === 'running' || undefined, 10000, 'task resumed');
    await complete(paused.id);
    const resumedState = await paused.state();
    assert.equal(resumedState.name, '赵六'); assert.equal(resumedState.city, '杭州'); assert.equal(resumedState.email, 'keep@example.com'); assert.equal(resumedState.submits, 0);
    cases.push({ name: 'paused edit applied after handback with original email', passed: true, result: resumedState });

    const original = events.find(e => e.direction === 'client' && e.message?.type === 'task_action' && e.message.request.text === pausedEdit)!.message;
    const beforeReplay = await paused.state();
    const oldSocket = socket;
    socket?.close();
    await until(() => !socket || undefined, 5000, 'disconnect');
    await panelEval("probePort.postMessage({kind:'retry'})");
    await until(() => socket && socket !== oldSocket && socket.readyState === WebSocket.OPEN || undefined, 15000, 'reconnect');
    const previousEvents = events.length;
    await panelEval(`probePort.postMessage(${JSON.stringify({kind:'client',msg:original})})`);
    await until(() => events.slice(previousEvents).find(e => e.message?.event?.receipt?.requestId === original.request.requestId) || undefined, 10000, 'replayed receipt');
    await sleep(500);
    assert.deepEqual(await paused.state(), beforeReplay, 'request replay does not execute again');
    cases.push({ name: 'reconnect and same request replay do not duplicate writes', passed: true });

    const lateText = '迟到修改不得填写姓名';
    const late = { ...original, request: { ...original.request, requestId: randomUUID(), text: lateText, expectedRunId: manager.getTaskProgress(paused.id)?.runId } };
    await panelEval(`probePort.postMessage(${JSON.stringify({kind:'client',msg:late})})`);
    await until(() => receipt(lateText) || undefined, 10000, 'late edit receipt');
    assert.equal(receipt(lateText).status, 'rejected');
    assert.deepEqual(await paused.state(), beforeReplay);
    cases.push({ name: 'delayed running-task envelope arriving after completion is rejected', passed: true, receipt: receipt(lateText) });
  }

  if (report.selection === 'all' || report.selection === 'team-only') {
    const team = await createCase('并行助手共同修改');
    await send('先调用 await_fixture_release 等待资料。之后只汇总两个助手的完成结果，助手负责各自独立表单，当前页面不填写。');
    await until(() => barrier.entered || undefined, 60000, 'lead waits while team is assigned');
    const fleet = manager.get(team.id)!.runtime.fleet;
    const workers = [];
    for (const id of ['form_a', 'form_b']) workers.push(await fleet.spawn({
      id, url: `${iso.fixtureOrigin}/${id}`, task: `填写${id}表单`, output: '填写结果',
      goal: '你只负责自己的独立表单。先调用 await_message 等待 from=main、kind=fixture-ready、timeout=120 的资料，此前不要写入。收到后填写姓名为张三，保留原邮箱，不提交。读取字段核对，最后 post 给 main，kind=done，报告最终姓名和邮箱。',
    }));
    await until(() => workers.every(w => events.some(e => e.message?.conversationId === team.id && e.message.sessionId === w.id && e.message.event?.kind === 'tool_start' && e.message.event.name === 'await_message')) || undefined, 90000, 'both workers waiting before writes');
    await iso.swEval(`chrome.tabs.update(${team.tab.id},{active:true})`);
    const assignments = workers.map(w => `${w.id} 负责 tabId=${w.tabId}`).join('；');
    const text = `验收已装配的两个助手：${assignments}。共同要求修改：它们各自表单的姓名都改成李四，保留邮箱，不提交。各自继续原分工，主助手等待这两位的 done 消息后只汇总，不重新创建助手或检查其他会话页面。`;
    const leadBeforeCorrection = await team.state();
    await send(text); await until(() => receipt(text) || undefined, 20000, 'team correction receipt');
    assert.equal(receipt(text).status, 'accepted');
    const acceptedAt = Date.now();
    for (const w of workers) fleet.mailbox.post({ from: 'main', to: w.id, kind: 'fixture-ready', body: '资料就绪，按已收到的最新要求继续。' });
    barrier.release();
    await until(() => fleet.list().every(w => !w.streaming) || undefined, 120000, 'workers complete');
    await complete(team.id);
    const results: any[] = [];
    const teamCase = { name: 'both actual workers receive common correction and avoid old writes', passed: false, setup: 'fleet.spawn assigns two independent local pages; correction uses production panel', results };
    cases.push(teamCase);
    for (const w of workers) {
      const result = await iso.swEval(`chrome.scripting.executeScript({target:{tabId:${w.tabId}},world:'MAIN',func:()=>({name:document.querySelector('#name').value,email:document.querySelector('#email').value,submits:window.submits,writes:window.writes})}).then(r=>r[0].result)`) as any;
      results.push({ id: w.id, result });
      assert.equal(result.name, '李四'); assert.equal(result.email, 'keep@example.com'); assert.equal(result.submits, 0);
      assert.equal(result.writes.filter((write: any) => write.at >= acceptedAt && write.value === '张三').length, 0, 'worker did not write old goal after correction receipt');
    }
    assert.deepEqual(await team.state(), leadBeforeCorrection, 'member correction does not write the lead page');
    teamCase.passed = true;
    await iso.screenshot(panel, join(out, 'team-panel.png'));
  }
  report.passed = cases.every(c => c.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  barrier.release();
  manager.dispose();
  await iso?.close();
  for (const client of wss.clients) client.terminate();
  await new Promise<void>(r => wss.close(() => r()));
  await writeFile(join(out, 'events.json'), JSON.stringify(events, null, 2));
  await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, ...report }));
}
