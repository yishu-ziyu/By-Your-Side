/**
 * Real isolated extension: one user request waits without model polling, then reads,
 * marks and verifies the matching result on the original page. Only the model and
 * fixture website are scripted. --case=stop checks a late change after stopping;
 * --case=irrelevant adds unrelated mutations before the actual result.
 * --case=watch verifies two batches without repeating the first, then stops.
 * Control cases: pause, revise, navigate, reload, disable, restart, new-task (scripted model only).
 * Boundary cases: already, deadline, exists, disabled-default (scripted model only).
 * Add --live [--model=openai-codex/gpt-6-luna] for natural real-model planning and verification.
 * npx tsx scripts/acceptance/real-path/condition-continuation.mts --headless [--case=once|stop|irrelevant|watch] [--live]
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO, launchRealPath, requireHeadless, siteAddress, sleep, until, watchInproc } from './harness.mts';
import { startScriptedModel, type Step } from './scripted-model.mts';
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from './inproc-config.mts';
import type { TaskView } from '../../../shared/task-view.js';
import { redactCredentialText } from '../../../shared/untrusted.js';

requireHeadless();
const scenario = process.argv.find(arg => arg.startsWith('--case='))?.slice(7) ?? 'once';
const controlCases = ['pause', 'revise', 'navigate', 'reload', 'disable', 'restart', 'new-task'];
const boundaryCases = ['already', 'deadline', 'exists', 'disabled-default'];
assert.ok(['once', 'stop', 'irrelevant', 'watch', ...controlCases, ...boundaryCases].includes(scenario), 'supported case');
const live = process.argv.includes('--live');
assert.ok(!live || ![...controlCases, ...boundaryCases].includes(scenario), 'the added control and boundary cases use the scripted model; --live supports once/stop/irrelevant/watch');
const watching = scenario === 'watch';
const stages: Array<{ at: number; phase: string; detail?: unknown }> = [];
const stage = (phase: string, detail?: unknown) => { stages.push({ at: Date.now(), phase, ...(detail === undefined ? {} : { detail }) }); console.log(JSON.stringify(stages.at(-1))); };
const runStage = async <T,>(phase: string, action: () => Promise<T>): Promise<T> => {
  stage(`${phase}：开始`);
  try { const result = await action(); stage(`${phase}：完成`); return result; }
  catch (error) { stage(`${phase}：失败`, String(error).split('\n')[0]); throw error; }
};
const artifacts = join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-condition-continuation-${scenario}${live ? '-live' : ''}`);
await mkdir(artifacts, { recursive: true });
const ASK = watching
  ? `持续委托验收：在这次${live ? '三' : '一'}分钟关注结束前，出现新的结果就筛选分数大于等于80的条目，把符合的结果标在页面上并说明依据，不要重复处理。`
  : `持续委托验收：${live ? '在三分钟内' : ''}等这页结果生成完成，筛选分数大于等于80的条目，把符合的结果标在页面上，并说明依据。`;
const FINAL = '【持续委托已核对】已标注甲：90分，大于等于80；乙为60分，不符合，未标注。依据是当前页的结果分数。';
const FINAL_SECOND = '【第二批已核对】新增丙：95分，大于等于80，已补充标注。甲的90分标注保留，没有重复处理；乙60分仍未标注。继续关注到本次期限。';
const WAKE = '[CONDITION CONTINUATION]';
const SECOND_WAKE = '"processedVersion":"';
const REVISION = '把筛选阈值改为95分及以上，其他要求保持；仍等待新的结果，不要标注90分。';
const NEW_QUESTION = '另一个问题：这页标题是什么？';
const NEW_ANSWER = '这页标题是“结果生成与筛选”。';
const REVISED_FINAL = '【修订目标已核对】仅标注丙95分，满足修订后的95分及以上；甲90分和乙60分不符合，没有标注。';
type Payload = { at: number; tools?: unknown[]; messages?: Array<{ role: string; content?: string | Array<{ text?: string }> | null }> };
const payloads: Payload[] = [];
const initial: Step[] = [
  { tool: { name: 'snapshot', args: {} } },
  { tool: { name: 'wait_for_condition', args: { condition: watching
    ? { target: '#results', property: 'text', operator: 'changed', goalItem: 'filter', description: '等待新的稳定结果条目' }
    : scenario === 'exists' ? { target: '#good', property: 'exists', operator: 'equals', expected: true, goalItem: 'filter', description: '等待结果条目出现' }
      : { target: '#status', property: 'text', operator: 'equals', expected: '完成', goalItem: 'filter', description: '等待结果生成完成' }, mode: watching ? 'watch' : 'once', durationMs: scenario === 'deadline' ? 1000 : live ? 180_000 : 60_000 } } },
  { text: '正在等待结果生成完成，完成后自动筛选并标注。' },
];
const follow: Step[] = [
  { tool: { name: 'snapshot', args: {} } },
  { tool: { name: 'mark', args: { target: '#good', label: '符合：90分 ≥ 80分' } } },
  { tool: { name: 'read_element', args: { target: '#good' } } },
  { text: FINAL },
];
const secondBatch: Step[] = [
  { tool: { name: 'snapshot', args: {} } },
  { tool: { name: 'mark', args: { target: '#new', label: '新增符合：95分 ≥ 80分' } } },
  { tool: { name: 'read_element', args: { target: '#new' } } },
  { text: FINAL_SECOND },
];
let revisionStage = 0;
const revisionSteps: Step[] = [];
const revisedWait = (): Step => ({ tool: { name: 'wait_for_condition', args: { condition: { target: '#results', property: 'text', operator: 'changed', goalItem: 'filter95', description: '等待新增95分及以上结果' }, mode: 'once', durationMs: 60_000 } } });
const model = live ? null : await startScriptedModel([
  { match: '"lastReply"', steps: [{ text: JSON.stringify({ status: 'done', remaining: '', items: [{ text: '筛选分数大于等于80的条目，标注并说明依据', done: true }] }) }] },
  { match: '"requests"', steps: [{ text: JSON.stringify({ scope: 'local' }) }] },
  { match: '"userMessage"', steps: [{ text: JSON.stringify({ feedback: 'none', aspect: null, lasting: false, rule: '', evidence: '' }) }] },
  { match: '"task":', steps: [{ text: JSON.stringify({ title: '结果筛选' }) }] },
  { match: REVISION, steps: revisionSteps },
  { match: NEW_QUESTION, steps: [{ text: NEW_ANSWER }] },
  // Each wake is a new user-shaped host prompt. The second one includes a committed processing position.
  { match: SECOND_WAKE, steps: secondBatch },
  { match: WAKE, steps: follow },
  { match: ASK, steps: initial },
], undefined, payload => {
  payloads.push({ at: Date.now(), ...structuredClone(payload) }); stage('模型收到请求', { count: payloads.length, tools: !!payload.tools?.length });
  revisionSteps.splice(0, revisionSteps.length, ...(revisionStage < 2
    ? [{ tool: { name: 'snapshot', args: {} } }, ...(revisionStage === 1 ? [{ tool: { name: 'read_element', args: { target: '#good' } } }] : []), revisedWait(), { text: '当前结果尚无95分及以上，继续等待新结果。' }] as Step[]
    : [{ tool: { name: 'snapshot', args: {} } }, { tool: { name: 'mark', args: { target: '#new', label: '修订后符合：95分' } } }, { tool: { name: 'read_element', args: { target: '#new' } } }, { text: REVISED_FINAL }] as Step[]));
});
const site = createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/other') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>结果生成与筛选</title>
  <style>body{font:18px/1.8 -apple-system,sans-serif;margin:48px;color:#222}article{margin:32px 0;padding:20px;width:420px;border:1px solid #ddd}#status{font-weight:600}#unrelated{color:#888}</style>
  <h1>结果生成与筛选</h1><p>生成状态：<span id="status">${scenario === 'already' ? '完成' : '生成中'}</span></p><main id="results">${watching ? '<article id="seed">基线：40分</article>' : scenario === 'already' ? '<article id="good">甲：90分</article><article id="bad">乙：60分</article>' : ''}</main><p id="unrelated">页面提示</p></html>`);
});
await new Promise<void>(resolve => site.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${siteAddress(site).port}/`;
let rp: Awaited<ReturnType<typeof launchRealPath>> | undefined;
let network: Awaited<ReturnType<typeof watchInproc>> | undefined;
const isModelRequest = (request: { url: string; method: string }) => request.method === 'POST' && /(?:\/responses|\/chat\/completions|\/messages|\/completions)(?:[/?]|$)/.test(request.url);
const requestCount = () => live ? network?.requestsBetween(0).filter(isModelRequest).length ?? 0 : payloads.length;
const modelRequests = () => model?.requests ?? [];
const liveModel = live ? process.argv.find(arg => arg.startsWith('--model='))?.slice(8) ?? DEFAULT_TEST_MODEL : null;
let panel = '', work = '', error: string | null = null;
let views: TaskView[] = [], marks: unknown = null, layerCount = 0;
let waiting: TaskView | undefined, ending: TaskView | undefined;
let waitWindow: { from: number; to: number; requestsBefore: number; requestsAfter: number } | null = null;
let conditionAt: number | null = null, finalAt: number | null = null, userMessages = 0;
let userMessageTexts: string[] = [];
const batchWindows: Array<{ from: number; to: number; requestsBefore: number; requestsAfter: number }> = [];
let firstBatch: TaskView | undefined, secondBatchView: TaskView | undefined;
let controlEvidence: unknown = null;
const isolated = new Set<number>();
try {
 await (async () => {
  rp = await runStage('启动隔离真实扩展', () => launchRealPath());
  const browser = rp;
  const blank = await runStage('查找目标页面', () => until(async () => (await browser.targets()).find(target => target.type === 'page' && target.url === 'about:blank'), 10_000, 'fixture tab'));
  work = await browser.attach(blank.targetId);
  browser.cdp.onEvent('Runtime.executionContextCreated', (event: { sessionId?: string; params: { context: { id: number; origin: string; auxData?: { type?: string } } } }) => {
    if (event.sessionId === work && event.params.context.auxData?.type === 'isolated' && event.params.context.origin.startsWith('chrome-extension://')) isolated.add(event.params.context.id);
  });
  browser.cdp.onEvent('Runtime.executionContextDestroyed', (event: { sessionId?: string; params: { executionContextId: number } }) => {
    if (event.sessionId === work) isolated.delete(event.params.executionContextId);
  });
  browser.cdp.onEvent('Runtime.executionContextsCleared', (event: { sessionId?: string }) => { if (event.sessionId === work) isolated.clear(); });
  await browser.cdp.send('Runtime.enable', {}, work);
  await browser.cdp.send('Page.enable', {}, work);
  await runStage('打开结果页面', () => browser.cdp.send('Page.navigate', { url: origin }, work));
  await runStage('确认结果页面可读', () => until(() => browser.evaluate(work, '!!document.querySelector("#status")'), 10_000, 'fixture ready'));
  if (scenario === 'already') conditionAt = Date.now();
  panel = await runStage('打开并连接真实侧栏', async () => browser.attach(await browser.openSidePanel()));
  await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, panel);
  await runStage(live ? '配置真实模型和持续委托开关' : '配置本机脚本模型和持续委托开关', async () => {
    const modelItems = live ? modelStorageItems(await loadModelPlan(liveModel!)) : { inproc_model_config: { provider: 'custom', modelId: 'demo-model', baseUrl: model!.baseUrl }, 'inproc_cred:custom': { type: 'api_key', key: 'local-demo-no-secret' } };
    await browser.evaluate(panel, `chrome.storage.local.set(${JSON.stringify({ ...modelItems, sideagent_self_use: { until: Date.now() + 600_000 }, ...(scenario === 'disabled-default' ? {} : { continuousDelegation: true }) })}).then(()=>true)`);
  });
  await runStage('等待侧栏可发送', () => until(() => browser.evaluate(panel, 'document.querySelector("#send-btn")?.disabled===false'), 60_000, 'sidebar ready'));
  if (live) network = await runStage('观察真实模型网络请求元数据', () => watchInproc(browser, browser.extensionId));
  // A second read-only panel port records the same authoritative views consumed by the UI.
  await runStage('连接只读任务视图端口', () => browser.evaluate(panel, `(() => {
    globalThis.__conditionViews=[]; globalThis.__conditionMessages=[];
    const port=chrome.runtime.connect({name:'sideagent-panel'}); globalThis.__conditionPort=port;
    port.onMessage.addListener(message=>{globalThis.__conditionMessages.push(message);if(message.kind==='server'&&message.msg?.type==='task_view')globalThis.__conditionViews.push(message.msg.view)});
    port.postMessage({kind:'sync',afterSeq:0}); return true;
  })()`));
  const readViews = async () => await browser.evaluate(panel, 'globalThis.__conditionViews ?? []') as TaskView[];
  let lastState = '', stateLoggedAt = 0;
  const latest = async () => {
    const view = (await readViews()).findLast(view => view.goal?.includes('持续委托验收'));
    const state = `${view?.state ?? 'none'}/${view?.continuation?.state ?? '未登记'}`;
    if (state !== lastState || Date.now() - stateLoggedAt > 10_000) {
      lastState = state; stateLoggedAt = Date.now();
      stage('当前权威任务状态', { state, lastError: view?.continuation?.lastError ?? null, modelRequests: requestCount() });
    }
    if (view?.state === 'error' && scenario !== 'disabled-default') {
      const visible = redactCredentialText(String(await browser.evaluate(panel, 'document.querySelector("#messages")?.innerText ?? ""'))).slice(-1200);
      const explicitErrors = redactCredentialText(network?.logs() ?? '').split('\n').filter(line => /error|failed|失败|错误/i.test(line)).slice(-8).map(line => line.slice(-1200));
      stage('任务终止错误', { visible, explicitErrors });
      throw new Error(`任务已终止，停止等待：${visible || explicitErrors.join(' / ') || '用户可见错误原因尚未取得'}`);
    }
    return view;
  };
  const probe = async <T,>(expression: string): Promise<T | undefined> => {
    for (const contextId of isolated) {
      const reply = await browser.cdp.send('Runtime.evaluate', { expression: `(() => {const ns=globalThis.__sideagent;return ns?.marksState?(${expression}):undefined})()`, contextId, returnByValue: true }, work).catch(() => null) as { result?: { value?: T } } | null;
      if (reply?.result?.value !== undefined) return reply.result.value;
    }
    return undefined;
  };
  const assertUserInputs = async () => {
    userMessageTexts = await browser.evaluate(panel, `Array.from(document.querySelectorAll('#messages .msg.user')).map(node=>(node.querySelector('.user-msg-text')?.textContent??node.textContent??'').trim())`) as string[];
    userMessages = userMessageTexts.length;
    const extraInputs = scenario === 'pause' ? 2 : scenario === 'revise' ? 1 : 0;
    assert.equal(userMessages, 1 + extraInputs, 'only the original goal and necessary explicit user control appear as user messages');
    if (scenario === 'pause') assert.deepEqual(userMessageTexts.slice(1), ['继续原任务', '继续原任务'], 'the added user bubbles are solely the explicit resume button controls');
    if (scenario === 'revise') assert.equal(userMessageTexts[1], REVISION, 'the added user bubble is solely the exact goal revision');
  };
  await browser.screenshot(work, join(artifacts, 'before-page.png'));
  await runStage('用户仅发送一次目标', async () => {
    await browser.click(panel, '#input'); await browser.typeText(panel, ASK); await browser.pressEnter(panel);
  });
  if (scenario === 'disabled-default') {
    const flag = await browser.evaluate(panel, `chrome.storage.local.get('continuousDelegation').then(stored=>stored.continuousDelegation??null)`);
    assert.notEqual(flag, true, 'a fresh isolated extension leaves continuous delegation off by default');
    await runStage('确认默认关闭时登记被拒绝并结束本轮', () => until(async () => {
      const view = await latest();
      return modelRequests().some(request => request.rule === ASK && request.step >= 1 && request.finished)
        && view && ['idle', 'error'].includes(view.state)
        && await browser.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running") && document.querySelector("#send-btn")?.disabled===false') ? view : undefined;
    }, 30_000, 'disabled registration rejected'));
    await sleep(750);
    const refusal = payloads.flatMap(payload => payload.messages ?? []).filter(message => message.role === 'tool').map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    assert.match(refusal, /持续委托尚未开启|Unknown tool[^\n]*wait_for_condition|wait_for_condition[^\n]*(?:not found|not available|不存在)/i, 'the attempted registration has an explicit disabled/unavailable result');
    const before = requestCount(); conditionAt = Date.now();
    await runStage('默认关闭后发布迟到结果', () => browser.evaluate(work, `document.querySelector('#results').innerHTML='<article id="good">甲：90分</article><article id="bad">乙：60分</article>';document.querySelector('#status').textContent='完成';true`));
    await runStage('观察默认关闭时不自动续做', () => sleep(4500));
    views = await readViews(); ending = await latest(); marks = await probe('ns.marksState()'); layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
    assert.equal(requestCount(), before, 'default-disabled extension does not issue a wake model request');
    assert.ok(views.every(view => !view.continuation), 'default-disabled extension never saves a continuation');
    assert.equal(layerCount, 0, 'default-disabled extension cannot annotate from the late condition');
    assert.equal(modelRequests().filter(request => request.rule === WAKE || request.rule === SECOND_WAKE).length, 0, 'no continuation prompt is generated');
    await assertUserInputs(); await browser.screenshot(work, join(artifacts, 'after-page.png')); await browser.screenshot(panel, join(artifacts, 'after-panel.png'));
    controlEvidence = { flag, registrationRefused: true, beforeRequests: before, afterRequests: requestCount(), persistedContinuations: 0 };
    stage('默认关闭反例核验完成', controlEvidence); return;
  }
  waiting = await runStage('登记持久等待条件', () => until(async () => {
    const view = await latest();
    return ['already', 'deadline'].includes(scenario)
      ? (await readViews()).find(candidate => candidate.goal?.includes('持续委托验收') && candidate.continuation?.state === 'WAITING_CONDITION')
      : view?.continuation?.state === 'WAITING_CONDITION' ? view : undefined;
  }, live ? 180_000 : 60_000, 'durable condition wait'));
  stage('已进入条件等待', { runId: waiting.runId, continuation: waiting.continuation });
  assert.ok(waiting.runId, 'waiting is bound to the accepted original run');
  if (scenario === 'deadline') {
    assert.equal(waiting.continuation!.expiresAt - waiting.continuation!.createdAt, 1000, 'one-second deadline was actually accepted');
    ending = await runStage('期限到达后停止且不伪装完成', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'STOPPED' ? view : undefined; }, 15_000, 'deadline stopped'));
    assert.equal(ending.continuation!.stopReason, 'deadline', 'deadline is retained as the stop reason');
    assert.notEqual(ending.goalStatus?.status, 'done', 'expiration is not projected as goal completion');
    const before = requestCount(); conditionAt = Date.now();
    await browser.evaluate(work, `document.querySelector('#results').innerHTML='<article id="good">甲：90分</article><article id="bad">乙：60分</article>';document.querySelector('#status').textContent='完成';true`);
    await runStage('到期后迟到结果不能复活委托', () => sleep(4500));
    views = await readViews(); ending = await latest(); marks = await probe('ns.marksState()'); layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
    assert.equal(ending?.continuation?.state, 'STOPPED', 'expired delegation stays stopped');
    assert.equal(ending?.continuation?.processedVersion, null, 'deadline cannot advance the processed position');
    assert.ok(views.every(view => view.continuation?.state !== 'COMPLETED'), 'no snapshot ever claimed the expired goal completed');
    assert.equal(requestCount(), before, 'late result after the deadline calls no model'); assert.equal(layerCount, 0, 'late result after the deadline gets no annotation');
    await assertUserInputs(); await browser.screenshot(work, join(artifacts, 'after-page.png')); await browser.screenshot(panel, join(artifacts, 'after-panel.png'));
    controlEvidence = { stoppedBecause: 'deadline', beforeRequests: before, afterRequests: requestCount(), processedVersion: null };
    stage('期限反例核验完成', controlEvidence); return;
  }
  if (scenario !== 'already') {
    await runStage('确认执行资源释放', () => until(() => browser.evaluate(panel, '!document.querySelector("#status-pill")?.classList.contains("running")'), 15_000, 'execution resource released'));
    await sleep(750);
    const from = Date.now(), requestsBefore = requestCount();
    if (scenario === 'irrelevant') await browser.evaluate(work, `document.querySelector('#unrelated').textContent='无关广告更新'; document.body.dataset.refresh='1'; true`);
    await runStage('观察无变化期间模型调用', () => sleep(4500));
    waitWindow = { from, to: Date.now(), requestsBefore, requestsAfter: requestCount() };
    assert.equal(waitWindow.requestsAfter, waitWindow.requestsBefore, 'stable external wait sends zero model requests across two observation intervals');
    assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'unrelated changes do not wake execution');
    stage('无变化观察完成', waitWindow);
    if (scenario === 'exists') assert.equal(await browser.evaluate(work, 'document.querySelectorAll("#good").length'), 0, 'the exists condition was registered before the target appeared');
  }
  await browser.screenshot(panel, join(artifacts, 'waiting-panel.png'));
  const stop = async () => runStage('用户停止原委托', async () => {
    await browser.evaluate(panel, `globalThis.__conditionPort.postMessage({kind:'client',msg:{type:'task_action',request:${JSON.stringify({ requestId: `stop-condition-${Date.now()}`, conversationId: waiting!.conversationId, source: 'text', action: 'abort', expectedRunId: waiting!.runId })}}}); true`);
    return until(async () => { const view = await latest(); return view?.continuation?.state === 'STOPPED' ? view : undefined; }, 15_000, 'stop accepted');
  });
  const publishFirst = () => runStage('发布第一批结果以满足条件', () => browser.evaluate(work, `if(!document.querySelector('#good'))document.querySelector('#results').insertAdjacentHTML('beforeend','<article id="good">甲：90分</article><article id="bad">乙：60分</article>'); document.querySelector('#status').textContent='完成'; true`));
  const saveControlEvidence = async () => {
    ending = await latest(); views = await readViews(); marks = await probe('ns.marksState()'); layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
    await assertUserInputs();
    await browser.screenshot(work, join(artifacts, 'after-page.png')); await browser.screenshot(panel, join(artifacts, 'after-panel.png'));
    assert.equal(ending?.runId, waiting?.runId, 'control retains the original task identity');
    stage('控制反例核验完成', { scenario, state: ending?.continuation?.state, layerCount, controlEvidence });
  };
  if (scenario === 'navigate' || scenario === 'reload' || scenario === 'disable') {
    const before = requestCount();
    const priorDocumentTime = Number(await browser.evaluate(work, 'performance.timeOrigin'));
    if (scenario === 'disable') await runStage('关闭持续委托功能开关', () => browser.evaluate(panel, 'chrome.storage.local.set({continuousDelegation:false}).then(()=>true)'));
    else {
      if (scenario === 'navigate') await runStage('同站切换到另一资源', () => browser.cdp.send('Page.navigate', { url: `${origin}other` }, work));
      else await runStage('同一地址重新加载为新文档', () => browser.cdp.send('Page.reload', {}, work));
      await runStage('确认新的目标页面可读', () => until(() => browser.evaluate(work, `!!document.querySelector('#status') && document.readyState!=='loading' && ${scenario === 'navigate' ? `location.href===${JSON.stringify(`${origin}other`)}` : `performance.timeOrigin!==${priorDocumentTime}`}`), 10_000, 'replacement page ready'));
    }
    ending = await runStage('等待旧条件失效', () => until(async () => { const view = await latest(); return view?.continuation?.state === (scenario === 'disable' ? 'STOPPED' : 'SUSPENDED') ? view : undefined; }, 15_000, 'condition invalidated'));
    conditionAt = Date.now(); await publishFirst();
    await runStage('观察失效后的迟到完成事件', () => sleep(4500));
    assert.equal(requestCount(), before, 'invalidated condition sends no model requests');
    assert.equal(await probe<number>('ns.markLayerCount()') ?? 0, 0, 'no mark is drawn in the replacement document or after disabling');
    assert.equal((await latest())?.continuation?.state, scenario === 'disable' ? 'STOPPED' : 'SUSPENDED', 'late completion cannot rebind an invalid condition');
    assert.equal((await latest())?.continuation?.processedVersion, null, 'invalidated result is not recorded as processed');
    controlEvidence = { beforeRequests: before, afterRequests: requestCount(), oldUrl: waiting.continuation!.url, oldDocumentId: waiting.continuation!.documentId, state: ending.continuation!.state };
    await saveControlEvidence(); return;
  }
  if (scenario === 'new-task') {
    const before = requestCount();
    await runStage('用户在同一页面输入框问另一个问题', async () => { await browser.click(panel, '#input'); await browser.typeText(panel, NEW_QUESTION); await browser.pressEnter(panel); });
    await runStage('出现另开会话的提示', () => until(() => browser.evaluate(panel, `!!document.querySelector('.receipt-decision')?.textContent.includes('另开会话')`), 15_000, 'new conversation offer'));
    assert.equal(requestCount(), before, 'the offer itself calls no model');
    assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'asking another question keeps the watch');
    await browser.screenshot(panel, join(artifacts, 'offer-panel.png'));
    await runStage('用户点击另开会话', () => browser.click(panel, '.receipt-decision div > button:first-child'));
    await runStage('新问题在新会话里回答', () => until(() => browser.evaluate(panel, `document.querySelector('#messages')?.textContent.includes(${JSON.stringify(NEW_ANSWER)})`), 30_000, 'new question answered'));
    await browser.screenshot(panel, join(artifacts, 'new-conversation-panel.png'));
    assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'the original watch is still waiting after the other answer');
    conditionAt = Date.now(); await publishFirst();
    ending = await runStage('原会话的关注照常唤醒并核对', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'COMPLETED' && view.continuation.processedVersion ? view : undefined; }, 60_000, 'original watch completed'));
    finalAt = Date.now();
    views = await readViews(); marks = await probe('ns.marksState()'); layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
    assert.equal(ending.runId, waiting.runId, 'the watch keeps its original task identity');
    assert.equal(layerCount, 1, 'the original watch marks the qualifying result');
    assert.equal(modelRequests().filter(request => request.rule === WAKE && request.tools && request.step === 0).length, 1, 'exactly one wake for the original watch');
    assert.ok(modelRequests().some(request => request.rule === NEW_QUESTION), 'the new question reached the model as its own task');
    await browser.screenshot(work, join(artifacts, 'after-page.png')); await browser.screenshot(panel, join(artifacts, 'after-panel.png'));
    controlEvidence = { beforeRequests: before, offered: true, forked: true, finalState: ending.continuation!.state };
    stage('另开会话反例核验完成', controlEvidence); return;
  }
  if (scenario === 'pause') {
    const before = requestCount();
    await runStage('用户点击真实暂停关注按钮', () => browser.click(panel, 'button[data-continuation-control="pause"]'));
    const paused = await runStage('确认关注已暂停', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'WAITING_USER' ? view : undefined; }, 15_000, 'pause accepted'));
    assert.ok(paused.continuation!.controlVersion > waiting.continuation!.controlVersion, 'pause invalidates the prior control version');
    await runStage('结果未出时点击真实继续关注按钮', () => browser.click(panel, 'button[data-continuation-control="resume"]'));
    await runStage('确认回到等待', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'WAITING_CONDITION' ? view : undefined; }, 15_000, 'resume returns to waiting'));
    await runStage('继续关注后条件未满足时保持安静', () => sleep(4500));
    assert.equal(requestCount(), before, 'resuming before the condition holds calls no model');
    assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'resume keeps waiting for the condition');
    await runStage('再次点击真实暂停关注按钮', () => browser.click(panel, 'button[data-continuation-control="pause"]'));
    await runStage('确认再次暂停', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'WAITING_USER' ? view : undefined; }, 15_000, 'second pause accepted'));
    conditionAt = Date.now(); await publishFirst();
    await runStage('条件满足时仍等待用户继续', () => sleep(4500));
    assert.equal(requestCount(), before, 'paused condition cannot call the model');
    assert.equal(await probe<number>('ns.markLayerCount()') ?? 0, 0, 'paused task cannot annotate');
    assert.equal((await latest())?.continuation?.state, 'WAITING_USER', 'page changes cannot replace user continuation');
    await runStage('用户点击真实继续关注按钮', () => browser.click(panel, 'button[data-continuation-control="resume"]'));
    controlEvidence = { beforeRequests: before, pausedRequests: requestCount(), pausedControlVersion: paused.continuation!.controlVersion, resumedBy: 'real continuation button' };
  }
  if (scenario === 'revise') {
    const revisionId = `revise-condition-${Date.now()}`;
    const tabId = Number(await browser.evaluate(panel, `chrome.tabs.query({url:${JSON.stringify(origin)}}).then(tabs=>tabs[0]?.id)`));
    await runStage('修改原目标为95分及以上', () => browser.evaluate(panel, `globalThis.__conditionPort.postMessage({kind:'client',msg:{type:'task_action',request:${JSON.stringify({ requestId: revisionId, conversationId: waiting!.conversationId, source: 'text', action: 'steer', expectedRunId: waiting!.runId, text: REVISION, context: { tabId, url: origin, title: '结果生成与筛选' } })}}}); true`));
    const revised = await runStage('保存修订版本并登记新等待', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'WAITING_CONDITION' && view.continuation.goalVersion > waiting!.continuation!.goalVersion ? view : undefined; }, 30_000, 'revised wait'));
    revisionStage = 1; conditionAt = Date.now(); await publishFirst();
    const rejected = await runStage('90分结果按新要求排除后继续等待', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'WAITING_CONDITION' && view.continuation.baseline !== revised.continuation!.baseline ? view : undefined; }, 30_000, '90 rejected under revised goal'));
    assert.equal(await probe<number>('ns.markLayerCount()') ?? 0, 0, '90 points is never marked after threshold revision');
    const quietFrom = Date.now(), quietBefore = requestCount(); await sleep(4500);
    batchWindows.push({ from: quietFrom, to: Date.now(), requestsBefore: quietBefore, requestsAfter: requestCount() });
    assert.equal(requestCount(), quietBefore, 'revised goal waits quietly after rejecting 90');
    revisionStage = 2;
    await runStage('发布满足修订目标的95分新条目', () => browser.evaluate(work, `document.querySelector('#results').insertAdjacentHTML('beforeend','<article id="new">丙：95分</article>'); true`));
    ending = await runStage('按修订目标核对完成', () => until(async () => { const view = await latest(); return view?.continuation?.state === 'COMPLETED' ? view : undefined; }, 60_000, 'revised goal verified'));
    finalAt = Date.now();
    await saveControlEvidence();
    const revisedMarks = marks as Array<{ shown: boolean; element: { name: string } | null }> | undefined;
    assert.equal(layerCount, 1, 'only one revised matching result is marked');
    assert.ok(revisedMarks?.some(mark => mark.shown && mark.element?.name.includes('丙') && mark.element.name.includes('95')), '95-point result is visibly marked');
    assert.ok(!revisedMarks?.some(mark => mark.element?.name.includes('甲') || mark.element?.name.includes('90') || mark.element?.name.includes('乙')), 'old threshold cannot produce marks');
    assert.ok(views.filter(view => view.continuation?.state === 'RUNNING' && view.observedAt >= revised.observedAt).every(view => view.continuation!.goalVersion === revised.continuation!.goalVersion), 'old goal version cannot start another execution segment');
    controlEvidence = { oldGoalVersion: waiting.continuation!.goalVersion, newGoalVersion: revised.continuation!.goalVersion, rejectedVersion: rejected.continuation!.observedVersion, finalProcessedVersion: ending!.continuation!.processedVersion, fullyVerified: true };
    stage('修订目标反例完成', controlEvidence); return;
  }
  if (scenario === 'restart') {
    const old = await until(async () => (await browser.targets()).find(target => target.url === `chrome-extension://${browser.extensionId}/inproc.html`), 10_000, 'owned offscreen target');
    const boundary = (await readViews()).length;
    const restartAt = Date.now();
    await runStage('仅关闭本次隔离扩展的离屏宿主', () => browser.evaluate(panel, 'chrome.offscreen.closeDocument().then(()=>true)'));
    await runStage('通过真实重连通道恢复离屏宿主', () => browser.evaluate(panel, `globalThis.__conditionPort.postMessage({kind:'retry'});true`));
    await runStage('确认创建了新的离屏宿主', () => until(async () => (await browser.targets()).find(target => target.url === old.url && target.targetId !== old.targetId), 45_000, 'new offscreen target'));
    await browser.evaluate(panel, `globalThis.__conditionPort.postMessage({kind:'client',msg:{type:'task_view_query',requestId:'restore-condition-query'}});true`);
    const restored = await runStage('从持久化恢复同一委托等待', () => until(async () => (await readViews()).slice(boundary).find(view => view.observedAt >= restartAt && view.continuation?.id === waiting!.continuation!.id && view.continuation.state === 'WAITING_CONDITION'), 45_000, 'same durable waiting delegation'));
    assert.equal(restored.continuation!.documentId, waiting.continuation!.documentId, 'read-only recovery is bound to the same live document');
    assert.equal(restored.continuation!.goalVersion, waiting.continuation!.goalVersion, 'restart retains goal version');
    assert.equal(restored.continuation!.controlVersion, waiting.continuation!.controlVersion, 'restart retains control version');
    assert.equal(restored.continuation!.observedVersion, waiting.continuation!.observedVersion, 'restored observation is read back from the checkpoint');
    assert.equal(restored.continuation!.processedVersion, waiting.continuation!.processedVersion, 'restart does not prematurely advance the processing position');
    assert.equal(restored.runId, waiting.runId, 'restart retains original run');
    controlEvidence = { originalOffscreenTarget: old.targetId, recoveredContinuationId: restored.continuation!.id, documentId: restored.continuation!.documentId, goalVersion: restored.continuation!.goalVersion, controlVersion: restored.continuation!.controlVersion };
  }
  if (scenario === 'stop') ending = await stop();
  conditionAt ??= Date.now();
  await publishFirst();
  if (scenario === 'stop') {
    await runStage('观察停止后的迟到变化', () => sleep(5000));
    if (!live) assert.equal(modelRequests().filter(request => request.rule === WAKE && request.tools).length, 0, 'late condition after stop does not wake the model');
    else assert.equal(requestCount(), waitWindow!.requestsAfter, 'late condition after stop does not issue new model requests');
    assert.equal((await latest())?.continuation?.state, 'STOPPED', 'late event cannot revive a stopped delegation');
  } else {
    await runStage('等待自动唤醒原任务', () => until(async () => (await readViews()).find(view => view.goal?.includes('持续委托验收') && view.continuation?.processingVersion), 30_000, 'one automatic wake'));
    ending = await runStage('核对第一批处理结果', () => until(async () => { const view = await latest(); return view?.continuation?.processedVersion && view.continuation.state === (watching ? 'WAITING_CONDITION' : 'COMPLETED') ? view : undefined; }, live ? 180_000 : 60_000, 'original goal verified and completed'));
    firstBatch = ending;
    await runStage('确认有依据的第一批回答可见', () => until(() => browser.evaluate(panel, live
      ? `(() => {const text=document.querySelector('#messages')?.innerText ?? '';return text.includes('甲')&&text.includes('90')&&text.includes('80')})()`
      : `document.querySelector('#messages')?.textContent.includes(${JSON.stringify(FINAL)})`), 15_000, 'sourced final answer shown'));
    finalAt = Date.now();
    const stableFrom = Date.now(), stableBefore = requestCount();
    await runStage('确认已处理版本不会重复唤醒', () => sleep(4500));
    batchWindows.push({ from: stableFrom, to: Date.now(), requestsBefore: stableBefore, requestsAfter: requestCount() });
    if (watching) assert.equal(requestCount(), stableBefore, 'verified first batch waits without model requests');
    if (!live) {
      const wakeStarts = modelRequests().filter(request => request.rule === WAKE && request.tools && request.step === 0);
      assert.equal(wakeStarts.length, 1, 'exactly one execution segment starts for this observed version');
    }
    assert.equal(ending.runId, waiting.runId, 'wake preserves the original accepted run');
    assert.ok(ending.continuation?.processedVersion, 'verified processing position was saved');
    assert.equal(ending.continuation?.pendingVersion, null, 'no pending version remains after verified delivery');
    if (watching) {
      assert.equal((await latest())?.continuation?.state, 'WAITING_CONDITION', 'one delivery does not complete an ongoing watch');
      assert.equal(await probe<number>('ns.markLayerCount()'), 1, 'the first batch produced one real mark');
      await browser.screenshot(work, join(artifacts, 'first-batch-page.png'));
      await runStage('发布第二批新条目并保留旧结果', () => browser.evaluate(work, `document.querySelector('#results').insertAdjacentHTML('beforeend','<article id="new">丙：95分</article>'); true`));
      secondBatchView = await runStage('核对第二批并保存独立处理位置', () => until(async () => {
        const view = await latest();
        return view?.continuation?.state === 'WAITING_CONDITION' && view.continuation.processedVersion && view.continuation.processedVersion !== firstBatch?.continuation?.processedVersion ? view : undefined;
      }, live ? 180_000 : 60_000, 'second batch verified without replay'));
      await runStage('确认第二批回答可见', () => until(() => browser.evaluate(panel, live
        ? `(() => {const text=document.querySelector('#messages')?.innerText ?? '';return text.includes('丙')&&text.includes('95')})()`
        : `document.querySelector('#messages')?.textContent.includes(${JSON.stringify(FINAL_SECOND)})`), 15_000, 'second sourced answer shown'));
      const nextFrom = Date.now(), nextBefore = requestCount();
      await runStage('确认第二批处理后继续安静等待', () => sleep(4500));
      batchWindows.push({ from: nextFrom, to: Date.now(), requestsBefore: nextBefore, requestsAfter: requestCount() });
      assert.equal(requestCount(), nextBefore, 'verified second batch waits without model requests');
      if (!live) {
        assert.equal(modelRequests().filter(request => request.rule === SECOND_WAKE && request.tools && request.step === 0).length, 1, 'one second execution segment starts for the new version');
        assert.equal(modelRequests().filter(request => request.rule === WAKE && request.tools && request.step === 0).length, 1, 'first batch is not started again');
      }
      assert.equal(secondBatchView.runId, waiting.runId, 'second batch retains the original accepted run');
      ending = await stop();
    }
  }
  marks = await probe('ns.marksState()');
  layerCount = await probe<number>('ns.markLayerCount()') ?? 0;
  const markList = marks as Array<{ label: string; element: { name: string } | null; shown: boolean }> | undefined;
  if (scenario === 'stop') assert.equal(layerCount, 0, 'no annotation was drawn after stopping');
  else {
    assert.equal(layerCount, watching ? 2 : 1, 'the real annotation layer has one mark per qualifying stable item');
    assert.ok(markList?.some(mark => mark.shown && mark.element?.name.includes('甲') && mark.element.name.includes('90')), 'a visible mark is anchored to the matching 90-point result');
    assert.ok(!markList?.some(mark => mark.element?.name.includes('乙') || mark.element?.name.includes('60')), 'the rejected 60-point result has no mark');
    if (watching) {
      assert.equal(markList?.filter(mark => mark.shown && mark.element?.name.includes('甲')).length, 1, 'the original result keeps exactly one mark');
      assert.equal(markList?.filter(mark => mark.shown && mark.element?.name.includes('丙') && mark.element.name.includes('95')).length, 1, 'the new 95-point result gets exactly one additional mark');
    }
  }
  await assertUserInputs();
  await browser.screenshot(work, join(artifacts, 'after-page.png'));
  await browser.screenshot(panel, join(artifacts, 'after-panel.png'));
  views = await readViews();
  assert.ok(views.filter(view => view.continuation?.id === waiting?.continuation?.id).every(view => view.runId === waiting?.runId), 'every continuation projection retains the original run identity');
  if (live) {
    const wakes = new Set(views.filter(view => view.continuation?.id === waiting?.continuation?.id).map(view => view.continuation?.requestId).filter(Boolean));
    assert.equal(wakes.size, scenario === 'stop' ? 0 : watching ? 2 : 1, 'real model work is admitted once per observed version');
    assert.ok(network?.requestsBetween(0).some(isModelRequest), 'network instrumentation actually observed a real model request');
  }
  stage('页面标注与任务身份核验完成', { layerCount, userMessages, state: ending?.continuation?.state });
 })();
} catch (caught) {
  error = caught instanceof Error ? caught.stack ?? caught.message : String(caught);
  stage('验收失败', error.split('\n')[0]);
  if (rp && panel) await rp.screenshot(panel, join(artifacts, 'failure-panel.png')).catch(() => {});
  if (rp && work) await rp.screenshot(work, join(artifacts, 'failure-page.png')).catch(() => {});
} finally {
  if (rp && panel) {
    views = await rp.evaluate(panel, 'globalThis.__conditionViews ?? []').catch(() => views) as TaskView[];
    if (error) stage('失败时最后的权威任务状态', views.at(-1) ?? null);
    await writeFile(join(artifacts, 'panel-messages.json'), JSON.stringify(await rp.evaluate(panel, 'globalThis.__conditionMessages ?? []').catch(() => []), null, 2));
    await rp.evaluate(panel, 'globalThis.__conditionPort?.disconnect(); true').catch(() => {});
    if (live) {
      // Select timing and token facts inside the isolated extension; no request headers or bodies leave it.
      const metrics = await rp.evaluate(panel, `new Promise((resolve,reject)=>{
        const request=indexedDB.open('sideagent-diagnostics');request.onerror=()=>reject(request.error);
        request.onsuccess=()=>{const db=request.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}
          const tx=db.transaction('trace-lines');const all=tx.objectStore('trace-lines').getAll();
          all.onsuccess=()=>resolve(all.result.flatMap(row=>{let event;try{event=JSON.parse(row.line)}catch{return []}
            const data=event.data??{};if(!['model_request','side_call','message_end','goal_check','response_headers'].includes(event.type))return [];
            return [{type:event.type,at:event.at??event.timestamp??null,runId:event.runId??null,turn:event.turn??null,
              usage:data.message?.usage??data.usage??null,model:data.message?.model??data.model??null,provider:data.message?.provider??data.provider??null,
              elapsedMs:data.elapsedMs??data.ms??data.sinceRequestMs??null,status:data.status??null,toolCount:data.toolCount??null}]
          }));tx.oncomplete=()=>db.close();all.onerror=()=>reject(all.error)}
      })`).catch(() => []);
      await writeFile(join(artifacts, 'model-usage-and-latency.json'), JSON.stringify(metrics, null, 2));
    }
  }
  if (!live) await writeFile(join(artifacts, 'payloads.jsonl'), payloads.map(payload => JSON.stringify(payload)).join('\n'));
  const networkRecords = network?.requestsBetween(0).filter(isModelRequest).map(request => {
    const url = new URL(request.url);
    return { ...request, url: `${url.origin}${url.pathname}` };
  }) ?? [];
  if (live) await writeFile(join(artifacts, 'model-network.json'), JSON.stringify(networkRecords, null, 2));
  await writeFile(join(artifacts, 'task-views.json'), JSON.stringify(views, null, 2));
  await writeFile(join(artifacts, 'stages.jsonl'), stages.map(entry => JSON.stringify(entry)).join('\n'));
  await writeFile(join(artifacts, 'result.json'), JSON.stringify({ status: error ? 'FAIL' : 'PASS', scenario, live, model: liveModel ?? 'scripted-local', dependency: `isolated real extension/offscreen Agent/sidebar and annotation layer; ${live ? 'real model and checker, natural planning from original user input' : 'scripted local model/checker'}; local practice page`, waiting, ending, firstBatch, secondBatchView, controlEvidence, lastTaskView: views.at(-1) ?? null, waitWindow, batchWindows, marks, layerCount, userMessages, userMessageTexts, requests: live ? networkRecords : modelRequests(), conditionAt, finalAt, conditionToVerifiedMs: conditionAt && finalAt ? finalAt - conditionAt : null, error }, null, 2));
  await rp?.close();
  await rp?.remove();
  await model?.close();
  site.closeAllConnections();
  await new Promise<void>(resolve => site.close(() => resolve()));
}
console.log(JSON.stringify({ status: error ? 'FAIL' : 'PASS', scenario, artifacts, waitWindow, layerCount, error: error?.split('\n')[0] ?? null }, null, 2));
if (error) process.exitCode = 1;
