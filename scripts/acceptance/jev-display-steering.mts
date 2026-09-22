/**
 * Ticket 6 real acceptance: a real sidepanel modification while a real task is running.
 *
 * Panel -> WS -> ConversationManager -> production runtime/model -> registered browser tools -> page.
 * Each pair submits the SAME modification once with the steering fast path off and once on,
 * alternating order, and checks both the page result and the original task's own result.
 * No microphone, no ASR/TTS claims; voice coverage is marked separately in results.json.
 *
 * Usage: npx --no-install tsx scripts/acceptance/jev-display-steering.mts --headless [--smoke] [--boundaries-only] [--pairs N] [--skip-boundaries]
 * 效率分层：--smoke（1 对 2 臂，~2.5 分钟）用于迭代；--pairs N --skip-boundaries 用于中问抽查；
 * 全量 10 对 + 6 边界只用于正式留证。部分范围的水远不会置 results.passed=true。
 */
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, writeFile, readFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {homedir} from 'node:os';
import {resolve, join} from 'node:path';
import {WebSocketServer, WebSocket} from 'ws';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {ConversationStore} from '../../agent/src/conversation-store.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {TaskDispatcher, TaskReceiptStore} from '../../agent/src/task-dispatcher.js';
import {loadConfig} from '../../agent/src/config.js';
import {DEFAULT_PORT, PROTOCOL_VERSION, HOST_VERSION, STORAGE_SCHEMA_VERSION, parseClientMessage} from '../../shared/protocol.js';
import {launchIsolatedExtension, until} from './isolated-extension.mts';
import {displayAcceptanceExitCode, judgeDisplaySteeringRun, summarizeDisplaySteering} from './display-steering-oracle.mjs';

if (!process.argv.includes('--headless')) throw new Error('Required: --headless');

const smoke = process.argv.includes('--smoke');

const boundariesOnly = process.argv.includes('--boundaries-only');

const skipBoundaries = process.argv.includes('--skip-boundaries');

const pairsFlag = process.argv.find(a => a === '--pairs' || a.startsWith('--pairs='));

const pairsRaw = pairsFlag ? Number(pairsFlag.includes('=') ? pairsFlag.slice('--pairs='.length) : process.argv[process.argv.indexOf(pairsFlag) + 1]) : NaN;

if (pairsFlag && !(Number.isInteger(pairsRaw) && pairsRaw >= 1 && pairsRaw <= 10)) throw new Error('--pairs 需要 1..10 的整数（总对数固定 10）');

const reviewRaces = process.argv.includes('--review-races');

const PAIR_COUNT = smoke ? 1 : (Number.isInteger(pairsRaw) ? pairsRaw : 10);

const pairsLimited = PAIR_COUNT < 10;

const out = resolve('out/acceptance', `jev-display-steering-${Date.now()}`);

await mkdir(out, {recursive: true});

async function readTypesafeKey(): Promise<string> {
  for (const path of [resolve('.env.typesafe.local'), join(homedir(), '.sideagent', 'typesafe.env')]) {
    try {
      const line = (await readFile(path, 'utf8')).split('\n').find(value => value.startsWith('TYPESAFE_API_KEY='));

      if (line) return line.slice('TYPESAFE_API_KEY='.length).trim().replace(/^["']|["']$/g, '');
    } catch { /* try the next location */ }
  }

  return '';
}

const typesafeKey = await readTypesafeKey();

if (!typesafeKey) throw new Error('缺少 TYPESAFE_API_KEY：本机 ~/.sideagent/typesafe.env 或 .env.typesafe.local。不把密钥写进仓库或报告。');

process.env.TYPESAFE_API_KEY = typesafeKey;

process.env.SIDEAGENT_DISPLAY_FASTPATH = '1';

async function portFree(port: number): Promise<boolean> {
  return await new Promise<boolean>(done => {
    const probe = createServer();
    probe.once('error', () => done(false));
    probe.once('listening', () => probe.close(() => done(true)));
    probe.listen(port, '127.0.0.1');
  });
}

if (!(await portFree(DEFAULT_PORT))) throw new Error(`端口 ${DEFAULT_PORT} 已被占用（可能有本地伴随进程在运行）。不终止任何进程；请先停掉冲突实例再重跑。`);

const token = randomUUID();

// 执行模型默认取本机 config.json；可用 SIDEAGENT_ACCEPTANCE_MODEL 覆盖，不改日常配置。
const model = process.env.SIDEAGENT_ACCEPTANCE_MODEL || loadConfig().model;

const runtimeDir = resolve('out/acceptance', `jev-display-steering-store-${Date.now()}`);

await mkdir(runtimeDir, {recursive: true});

const events: any[] = [];

const store = new ConversationStore(join(runtimeDir, 'conversations'));

let socket: WebSocket | undefined;

const manager = new ConversationManager(
  (id, emit, summary) => createConversationRuntime(id, emit, model, {sessionManager: store.sessionManager(id), mode: summary?.mode}),
  message => { events.push({at: Date.now(), direction: 'server', message});

 if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); },
  store, undefined, undefined, new TaskDispatcher(new TaskReceiptStore(join(runtimeDir, 'receipts'))),
);

const wss = new WebSocketServer({host: '127.0.0.1', port: DEFAULT_PORT});

const listening = new Promise<void>((done, reject) => { wss.once('listening', done); wss.once('error', reject); });

wss.on('connection', client => {
  client.on('message', async raw => {
    const message = parseClientMessage(raw.toString());

    if (!message) return;

    if (message.type === 'hello') {
      if (message.token !== token) { client.close();

 return; }

      socket = client;
      const session = manager.get('default')!.runtime.session;
      client.send(JSON.stringify({type: 'hello_ok', version: PROTOCOL_VERSION, model: session.modelName(), models: await session.availableModels(), hostVersion: HOST_VERSION, storageSchema: STORAGE_SCHEMA_VERSION, extensionVersion: '0.1.0'}));
      client.send(JSON.stringify({type: 'conversation_list', conversations: manager.list()}));
      manager.replayState(m => client.send(JSON.stringify(m)));

      return;
    }

    if (socket !== client) return;
    events.push({at: Date.now(), direction: 'client', message});
    void manager.handleMessage(message).catch(error => events.push({error: String(error)}));
  });
  client.on('close', () => { if (socket === client) { socket = undefined; manager.disconnect(); } });
});

/** Count real Jev calls and record decision reasons without touching credentials. */
const jevCalls: number[] = [];

const displayDecisions: {at: number; reason: string; ms: number}[] = [];

const originalConsoleError = console.error;

console.error = (...args: any[]) => {
  originalConsoleError(...args);

  if (args[0] === '[display-fast-path]' && typeof args[1] === 'string') {
    try { const parsed = JSON.parse(args[1]); displayDecisions.push({at: Date.now(), reason: String(parsed.reason), ms: Number(parsed.ms)}); } catch { /* keep raw log only */ }
  }
};

const originalFetch = globalThis.fetch;

// Review race mode uses a controlled decision response, never claims live Jev accuracy.
let reviewDecision: (() => Promise<Response>) | null = null;

globalThis.fetch = (async (input: any, init?: any) => {
  if (String(input).includes('api.typesafe.ai')) {
    if (reviewDecision) return reviewDecision();
    const started = Date.now();

    try { return await originalFetch(input, init); } finally { jevCalls.push(Date.now() - started); }
  }

  return originalFetch(input, init);
}) as typeof fetch;

const TASK_TEXT = '请阅读当前网页的文章：先数一数正文一共有几个段落，再用一句不超过40字的话概括。不要修改网页上的任何内容，也不要翻译。回答中各用独立一行给出“段落数：N”和“概括：一句话”，N只写数字。';

const MODIFIERS = [
  {text: '把已有译文改成宋体。', font: 'songti', mode: null},
  {text: '已有译文请只显示译文。', font: null, mode: 'translated'},
  {text: '把已有译文切回双语。', font: null, mode: 'bilingual'},
  {text: '现成译文的字体换成宋体。', font: 'songti', mode: null},
  {text: '原文先隐藏，只留译文。', font: null, mode: 'translated'},
  {text: '原文和译文一起显示。', font: null, mode: 'bilingual'},
  {text: '用宋体显示已有译文。', font: 'songti', mode: null},
  {text: '我不要双语，只要译文。', font: null, mode: 'translated'},
  {text: '把已有译文恢复成网站原来的字体。', font: 'original', mode: null},
  {text: '已有译文改成宋体，并保留原文对照。', font: 'songti', mode: 'bilingual'},
] as const;

const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Display steering</title>
<style>body{font:20px Arial;max-width:720px;margin:24px}</style>
<h1>Display steering</h1>
<article>
<p>Paragraph one explains the reading habit and why careful notes help.</p>
<p>Paragraph two lists the tools used during a long research session.</p>
<p>Paragraph three reports the result of comparing two sources.</p>
<p>Paragraph four closes with the next step for the reader.</p>
</article>`;

let iso: Awaited<ReturnType<typeof launchIsolatedExtension>> | undefined;

let panel = '';

const results: any = {passed: false, pairs: [], boundaries: [], runs: [], summary: {}, scope: {}, error: null};

results.sourceDigests=Object.fromEntries(await Promise.all([
  'agent/src/session.ts','agent/src/conversation-manager.ts','agent/src/task-progress.ts',
  'scripts/acceptance/jev-display-steering.mts','scripts/acceptance/display-steering-oracle.mjs',
].map(async path=>[path,createHash('sha256').update(await readFile(path)).digest('hex')])));

const sleep = (ms: number) => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

try {
  await listening;
  const entry = await manager.ensureDefault();
  assert(entry.runtime.session.available, '需要一个可用的执行模型（本机 config.json 的 model）');
  iso = await launchIsolatedExtension({fixtureHtml});
  await iso.swEval(`chrome.storage.local.set({sideagent_token:${JSON.stringify(token)}})`);
  const extensionId = await iso.swEval('chrome.runtime.id');
  panel = await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  await until(async () => await iso!.evalIn(panel, "!!document.querySelector('#input')") || undefined, 10000, 'panel');
  await iso.evalIn(panel, "globalThis.probePort=chrome.runtime.connect({name:'sideagent-panel'});probePort.postMessage({kind:'retry'});");
  await until(() => socket?.readyState === WebSocket.OPEN || undefined, 15000, 'connected');
  let target = await iso.newTarget(`${iso.fixtureOrigin}/article`);
  let tab: any = await until(async () => (await iso!.swEval('chrome.tabs.query({})') as any[]).find(candidate => candidate.url === `${iso!.fixtureOrigin}/article`), 5000, 'tab');
  await iso.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
  const page = (expression: string) => iso!.evalIn(target, expression);
  let fixtureConversationId='default';

  const call = async (params: any) => {
    // Seed with the arm's own conversation identity through the existing test hook;
    // otherwise seeding claims every new page for "default" before the actual task starts.
    const receipt:any = await iso!.swEval(`globalThis.__saCall(${JSON.stringify(`fixture-${randomUUID()}`)},'page_translation',${JSON.stringify({tabId:tab.id,...params})},'main',undefined,${JSON.stringify(fixtureConversationId)})`);
    assert(receipt.ok, receipt.error);

    return receipt.data;
  };

  const observe = () => page(`(()=>{const paragraphs=[...document.querySelectorAll('article p')].map(p=>{const t=p.querySelector('[data-bys-translation]');return {mode:t?'bilingual':'translated',font:getComputedStyle(t||p).fontFamily,text:p.textContent??''};});return {...paragraphs[0],paragraphs};})()`);
  const panelIdle = async () => (await iso!.evalIn(panel, "document.getElementById('abort-btn').hidden")) === true;
  const panelRunning = async () => (await iso!.evalIn(panel, "!document.getElementById('abort-btn').hidden")) === true;
  const sendInput = (text: string) => iso!.evalIn(panel, `(()=>{const e=document.querySelector('#input');e.value=${JSON.stringify(text)};e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);

  const waitSettled = async (start: number, timeoutMs: number, session=entry.runtime.session): Promise<'settled' | 'timeout'> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const ended = events.slice(start).some(item => item.message?.event?.kind === 'agent_end' && item.message.event.willRetry !== true);

      if (ended && !session.isStreaming()) return 'settled';
      await sleep(150);
    }

    return 'timeout';
  };

  const waitMatch = async (match: () => Promise<boolean>, timeoutMs: number, done?:()=>boolean): Promise<number | undefined> => {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (await match()) return Date.now();

      if (done?.()) return undefined;
      await sleep(120);
    }

    return undefined;
  };

  async function seedTranslations(): Promise<void> {
    await until(async () => await page('document.readyState==="complete"') || undefined, 5000, 'page ready');
    let receipt = await call({action: 'begin', mode: 'translated'});
    receipt = await call({action: 'collect', document: receipt.document});
    const zh = ['第一段说明阅读习惯和记笔记的好处。', '第二段列出长时间查资料时用到的工具。', '第三段报告比较两份资料的结果。', '第四段给出读者下一步可以做什么。'];
    const translations = receipt.blocks.flatMap((block: any, index: number) => block.segments.map((segment: any) => ({id: segment.id, text: zh[index % zh.length]})));
    await call({action: 'apply', document: receipt.document, translations});
  }

  const setDisplay = (mode: string, fontFamily: string) => call({action: 'display', mode, fontFamily});

  const matchesExpected = async (modifier: {font: string | null; mode: string | null}, expected: {font: string; mode: string}) => {
    const observed = await observe();
    const paragraphs = observed.paragraphs ?? [];

    return {ok: paragraphs.length === 4 && paragraphs.every((p:any) => p.mode === expected.mode
      && (expected.font === 'songti' ? /Songti SC/.test(p.font) : p.font === 'Arial')), observed};
  };

  async function runSteered(name: string, modifier: {text: string; font: string | null; mode: string | null}, enabled: boolean, options?: {initial?: {mode: string; font: string}; waitForChange?: boolean}): Promise<any> {
    // Each arm gets a fresh conversation through the actual panel. A prior arm's runtime
    // "already applied" message must not become evidence for the next arm's request.
    await until(async()=>await panelIdle()||undefined,20000,'previous panel task idle');
    const creationStart=events.length;
    await iso!.evalIn(panel,"document.getElementById('conversation-new').click()");
    const created:any=await until(()=>events.slice(creationStart).find(e=>e.message?.type==='conversation_created')?.message,15000,'fresh arm conversation');
    const conversationId=created.conversation.id;
    fixtureConversationId=conversationId;
    const runEntry=manager.get(conversationId)!;
    await until(async()=>((await iso!.swEval("chrome.storage.session.get('selectedConversationId')")) as {selectedConversationId?:string}|undefined)?.selectedConversationId===conversationId||undefined,5000,'panel selected fresh conversation');
    // Use an equivalent new fixture page as well: never bypass the previous conversation's page ownership.
    const previousTarget=target;
    const url=`${iso!.fixtureOrigin}/article#arm-${randomUUID()}`;
    target=await iso!.newTarget(url);
    tab=await until(async()=>(await iso!.swEval('chrome.tabs.query({})') as any[]).find(t=>t.url===url),5000,'fresh arm page');
    await iso!.swEval(`chrome.tabs.update(${tab.id},{active:true})`);
    await iso!.closeTarget(previousTarget);
    await seedTranslations();
    const waitForChange = options?.waitForChange !== false;
    const initialMode = options?.initial?.mode ?? (modifier.mode ? (modifier.mode === 'bilingual' ? 'translated' : 'bilingual') : 'translated');
    const initialFont = options?.initial?.font ?? (modifier.font === 'original' ? 'songti' : 'original');
    await setDisplay(initialMode, initialFont);
    const expected = {mode: modifier.mode ?? initialMode, font: modifier.font ?? initialFont};

    if (waitForChange) assert((await matchesExpected(modifier, expected)).ok === false, '初始显示状态必须与目标不同');
    await until(async () => ((await panelIdle()) && !runEntry.runtime.session.isStreaming() && ['idle', 'none', 'aborted', 'error'].includes(manager.getTaskProgress(conversationId)?.state ?? '')) || undefined, 20000, 'panel idle');
    process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH = enabled ? '1' : '0';
    const jevStart = jevCalls.length;
    const decisionStart = displayDecisions.length;
    const conversationCountBefore = manager.list().length;
    const taskMarker = events.length;
    await sendInput(TASK_TEXT);
    // 等新一轮的模型真的在流：仅看面板 running 会读到上一轮残留状态。
    await until(async () => ((await panelRunning()) && runEntry.runtime.session.isStreaming() && events.slice(taskMarker).some(item => item.message?.conversationId===conversationId&&item.message?.event?.kind === 'turn_start')) || undefined, 30000, 'task running with model');
    await sleep(300);
    const runId = manager.getTaskProgress(conversationId)?.runId ?? null;
    const start = events.length;
    const steerAt = Date.now();
    await sendInput(modifier.text);

    const pageAt = waitForChange ? await waitMatch(async () => (await matchesExpected(modifier, expected)).ok, 45000,
      ()=>!runEntry.runtime.session.isStreaming()&&events.slice(start).some(e=>e.message?.conversationId===conversationId&&e.message?.event?.kind==='agent_end'&&e.message.event.willRetry!==true)) : undefined;

    const settle = await waitSettled(start, 90000,runEntry.runtime.session);
    await sleep(1200);
    const final = await matchesExpected(modifier, expected);
    const window = events.slice(start);
    const displayStarts = window.filter(item => item.message?.event?.kind === 'tool_start' && item.message.event.name === 'page_translation' && item.message.event.params?.action === 'display');
    const directStarts = displayStarts.filter(item => String(item.message.event.toolCallId).startsWith('display-'));

    const reTranslate = window.filter(item => item.message?.type === 'tool_call' && item.message.name === 'page_translation'
      && !['display','collect'].includes(item.message.params?.action));

    const findings = window.filter(item => item.message?.event?.kind === 'user_delivery' && ['finding', 'reply'].includes(item.message.event.delivery.kind));
    const runIdAfter = manager.getTaskProgress(conversationId)?.runId ?? null;
    const answer = findings.map(item => item.message.event.delivery.text).join(' ');
    const steeringReceipt=window.find(item=>item.message?.event?.receipt?.action==='steer')?.message.event.receipt??null;

    const displayExecutions = window.filter(item => item.message?.type === 'tool_call' && item.message.name === 'page_translation'
      && item.message.params?.action === 'display').map(item => {
      const call = item.message;
      const result = window.find(e => e.message?.type === 'tool_result' && e.message.id === call.id)?.message;

      return {id:call.id, params:call.params, ok:result?.ok === true && !result?.data?.error,
        executionFact:result?.data?.executionFact ?? result?.executionFact ?? 'unknown',
        tabId:result?.data?.tabId ?? call.params.tabId, document:result?.data?.document ?? call.params.document ?? null,
        runId:call.runId ?? null};
    });

    const run = {
      name, enabled, text: modifier.text, expected,
      initialMode, initialFont,
      pageChangedMs: pageAt ? pageAt - steerAt : null,
      totalMs: Date.now() - steerAt,
      settle, finalMatch: final.ok, finalObserved: final.observed,
      direct: directStarts.length > 0 && steeringReceipt?.status==='applied', directStarts: directStarts.length, displayStarts: displayStarts.length,
      reTranslate: reTranslate.length,
      modelTurns: window.filter(item => item.message?.event?.kind === 'turn_start').length,
      jevCalls: jevCalls.length - jevStart, jevMs: jevCalls.slice(jevStart),
      decisions: displayDecisions.slice(decisionStart).map(entry => entry.reason),
      sameRunId: runId !== null && runIdAfter === runId,
      runId, conversationId, tabId:tab.id,
      delivered: findings.length > 0, answer: answer.slice(0, 400),
      answerMentionsCount: /(4|四)/.test(answer),
      deliveries:findings.map(item => item.message.event.delivery), displayExecutions,
      steeringReceipt,
      conversationCountBefore, conversationCountAfter: manager.list().length,
    };

    return {...run, judgment:judgeDisplaySteeringRun(run)};
  }

  await seedTranslations();

  if (reviewRaces) {
    const latch = () => {let release!:()=>void;const promise=new Promise<void>(resolve=>{release=resolve;});

return {promise,release};};

    const decisionResponse = () => new Response(JSON.stringify({answers:{
      direct:{noul:.99},extra:{noul:.01},partial:{noul:.01},font_requested:{noul:.99},mode_requested:{noul:.01},
      font:{choice:'songti',probabilities:{songti:.99,original:.005,unspecified:.005}},mode:{choice:'unspecified'},
    }}),{headers:{'Content-Type':'application/json'}});

    for (const kind of ['refresh-during-route','cancel-during-readback'] as const) {
      const originalHold=latch(),decisionHold=latch(),readbackHold=latch();
      const originalCall=entry.runtime.rpc.call.bind(entry.runtime.rpc);
      let originalWaiting=false,routeWaiting=false,readbackWaiting=false,wrote=false;
      const marker=events.length;
      let failure:string|null=null,receipt:any=null;

      try {
        await until(()=>!entry.runtime.session.isStreaming()||undefined,20000,'previous task idle');
        await setDisplay('translated','original');
        process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH='1';
        entry.runtime.rpc.call=(async (...args:any[])=>{
          const [name,params]=args;
          const result=await (originalCall as any)(...args);

          if(name==='read_element'&&!originalWaiting){originalWaiting=true;await originalHold.promise;}

          if(name==='page_translation'&&params?.action==='display')wrote=true;

          if(kind==='cancel-during-readback'&&name==='snapshot'&&wrote&&!readbackWaiting){readbackWaiting=true;await readbackHold.promise;}

          return result;
        }) as typeof entry.runtime.rpc.call;
        await sendInput(`先调用 read_element 读取 body 全文，不能跳过这个工具。${TASK_TEXT}`);
        await until(()=>originalWaiting||undefined,45000,'original task held at real read_element receipt');
        const runId=manager.getTaskProgress('default')!.runId;
        reviewDecision=async()=>{routeWaiting=true;

if(kind==='refresh-during-route')await decisionHold.promise;

return decisionResponse();};

        const editStart=events.length;
        await sendInput('把译文改成宋体');

        if(kind==='refresh-during-route'){
          await until(()=>routeWaiting||undefined,10000,'Jev route held');
          await page('location.reload()');
          await seedTranslations();
          decisionHold.release();
        }else{
          await until(()=>readbackWaiting||undefined,10000,'post-write readback held');
          await iso.evalIn(panel,"document.getElementById('abort-btn').click()");
          await until(()=>events.slice(editStart).some(e=>e.direction==='client'&&(e.message?.type==='abort'||e.message?.action==='abort'))||undefined,5000,'panel cancellation sent');
          originalHold.release();
          await until(()=>manager.getTaskProgress('default')?.state==='aborted'||undefined,10000,'task cancelled');
          readbackHold.release();
        }

        receipt=await until(()=>events.slice(editStart).find(e=>e.message?.event?.receipt?.action==='steer')?.message.event.receipt,10000,'steering receipt');

        if(kind==='refresh-during-route'){
          assert.equal(receipt.status,'rejected');
          assert(!manager.getTaskProgress('default')?.recoveryInput?.requirements.includes('把译文改成宋体'));
        }else{
          assert.notEqual(receipt.status,'applied');
          assert(!receipt.message.includes('原任务继续'));
        }

        originalHold.release();readbackHold.release();reviewDecision=null;
        assert.equal(await waitSettled(marker,90000),'settled');
        const after=await observe();
        const writes=events.slice(editStart).filter(e=>e.message?.type==='tool_call'&&e.message.name==='page_translation'&&e.message.params?.action==='display');
        assert.equal(writes.length,kind==='refresh-during-route'?0:1);
        assert(after.paragraphs.every((p:any)=>kind==='refresh-during-route'?!/Songti SC/.test(p.font):/Songti SC/.test(p.font)));
        assert.equal(manager.getTaskProgress('default')?.runId,runId);
        results.boundaries.push({name:kind,failure:null,receipt,displayCalls:writes.length,observed:after,
          scope:'real panel/extension/runtime/tools; live task model; controlled Jev response and read receipt timing'});
      }catch(error){
        failure=error instanceof Error?error.message:String(error);
        results.boundaries.push({name:kind,failure,receipt});
      }finally{
        decisionHold.release();originalHold.release();readbackHold.release();reviewDecision=null;
        entry.runtime.rpc.call=originalCall;

        if(failure&&entry.runtime.session.isStreaming())await manager.handleMessage({type:'abort',conversationId:'default'});
        await writeFile(join(out,'results.json'),JSON.stringify(results,null,2));
        console.log(JSON.stringify({reviewRace:kind,failure,receipt}));
      }
    }
  }

  if (!boundariesOnly && !reviewRaces) {
    for (let pair = 0; pair < PAIR_COUNT; pair++) {
      const modifier = MODIFIERS[pair % MODIFIERS.length]!;
      const order = pair % 2 === 0 ? [false, true] : [true, false];
      const pairResult: any = {pair, text: modifier.text, arms: {}};

      for (const enabled of order) {
        const run = await runSteered(`pair-${pair}-${enabled ? 'on' : 'off'}`, modifier, enabled);
        results.runs.push(run);
        pairResult.arms[enabled ? 'on' : 'off'] = run;
        console.log(JSON.stringify({pair, enabled, ms: run.pageChangedMs, settle: run.settle, direct: run.direct, match: run.finalMatch, answer: run.answerMentionsCount, jev: run.jevCalls}));
        await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
      }

      results.pairs.push(pairResult);
    }
  }

  if (!smoke && !reviewRaces && !skipBoundaries) {
    const boundary = async (name: string, text: string, check: (run: any) => string | null, options?: {initial?: {mode: string; font: string}; waitForChange?: boolean; font?: string | null; mode?: string | null}) => {
      const run = await runSteered(`boundary-${name}`, {text, font: options?.font ?? null, mode: options?.mode ?? null}, true, options);
      const required=['settled','sameTask','deliveryIdentity','paragraphCount','summary','noRepeatedExecution','noRetranslation'];
      const missing=required.filter(key=>!run.judgment.checks[key]);
      const failure = check(run) ?? (missing.length ? `原任务或执行证据未通过：${missing.join(', ')}` : null);
      results.boundaries.push({name, text, ...run, failure});
      console.log(JSON.stringify({boundary: name, failure, observed: run.finalObserved, direct: run.direct}));
      await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
    };

    await boundary('局部标题不改整页', '只把标题的字体改成宋体，正文不要动。', run => /Songti SC/.test(run.finalObserved.font) ? '正文被整页改动' : run.delivered ? null : '没有交付说明', {waitForChange: false});
    // Jev 的既有政策：礼貌请求（“你能…吗”）算请求。这个句式按请求执行是记录到的真实行为，不是失败。
    await boundary('礼貌请求按请求执行', '你能把已有译文改成宋体吗？', run => /Songti SC/.test(run.finalObserved.font) ? null : '礼貌请求没有执行', {waitForChange: false, font: 'songti'});
    await boundary('明确信息问句不改页面', '请问把译文改成宋体是已经支持的功能吗？', run => /Songti SC/.test(run.finalObserved.font) || run.displayStarts > 0 ? '信息问句被当成执行' : null, {waitForChange: false});
    await boundary('纯否定不改页面', '不要把已有译文改成宋体。', run => /Songti SC/.test(run.finalObserved.font) ? '否定被当成执行' : null, {waitForChange: false});
    await boundary('显示加另一步都完成', '把已有译文改成宋体，再告诉我文章标题。', run => /Songti SC/.test(run.finalObserved.font) && run.answer.includes('Display steering') ? null : '没有同时完成两项要求', {font: 'songti'});
    await boundary('恢复网站字体', '把已有译文恢复成网站原来的字体。', run => /Songti SC/.test(run.finalObserved.font) ? '没有恢复原字体' : null, {font: 'original', initial: {mode: 'translated', font: 'songti'}});
  }

  results.summary = summarizeDisplaySteering(results.runs, results.pairs, results.boundaries);
  results.scope = {
    pairsRequested: PAIR_COUNT,
    pairsLimited: pairsLimited || smoke || null,
    boundariesSkipped: skipBoundaries || smoke || null,
    model: model ?? '(runtime default)',
    textRoute: 'real sidepanel input -> background -> task_action steer -> ConversationManager -> registered tools',
    voiceRoute: 'not exercised in this script (no microphone/ASR); shared dispatch covered by agent/test/voice-display-steering.test.ts',
    switchAfterRun: 'SIDEAGENT_DISPLAY_STEER_FASTPATH left off; ~/.sideagent/config.json unchanged',
    reviewRaces: reviewRaces ? 'Live task model and actual browser, scripted Jev response/read receipt timing; no model accuracy or latency claims' : null,
    note: 'paired on/off runs follow browser-use/jev-ultrafast docs/performance.md; small samples are not a statistical claim',
    armIsolation: 'fresh conversation and equivalent fixture page per arm; no cross-arm memory or page-ownership bypass',
  };
  const exitCode = displayAcceptanceExitCode({summary:results.summary, smoke, boundariesOnly:boundariesOnly||reviewRaces, boundaries:results.boundaries, pairsExpected: pairsLimited ? PAIR_COUNT : null});
  // 正式通过只能来自全量范围：10 对全跑且含 6 个边界。部分范围（smoke/--pairs/--skip-boundaries）只看退出码与逐项结果。
  results.passed = !smoke && !boundariesOnly && !reviewRaces && !skipBoundaries && !pairsLimited && exitCode === 0;
  results.smokePassed = smoke ? exitCode === 0 : null;
  results.boundariesPassed = boundariesOnly ? exitCode === 0 : null;
  results.reviewRacesPassed = reviewRaces ? exitCode === 0 : null;
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2));
  await iso.screenshot(target, join(out, 'page.png'));
  await iso.screenshot(panel, join(out, 'panel.png'));
  console.log(JSON.stringify({out, passed: results.passed, summary: results.summary}, null, 2));
  process.exitCode = exitCode;
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  await writeFile(join(out, 'results.json'), JSON.stringify(results, null, 2)).catch(() => {});
  throw error;
} finally {
  process.env.SIDEAGENT_DISPLAY_STEER_FASTPATH = '';
  await writeFile(join(out, 'events.json'), JSON.stringify(events, null, 2)).catch(() => {});
  globalThis.fetch = originalFetch;
  console.error = originalConsoleError;
  await iso?.close();
  manager.dispose();

  for (const client of wss.clients) client.terminate();
  await new Promise<void>(done => wss.close(() => done()));
}
