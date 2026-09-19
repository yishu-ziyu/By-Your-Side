/**
 * T05 接续入口真实隔离验收：A05-01（关侧栏再开）、A05-02（接收后重启再说继续）、
 * A05-03（执行后中断 + 人工改字段 + 继续）、timing（50 次摘要呈现 P95）。
 *
 * 复用 T01 的隔离运行器设施（真实生产 ConversationManager / 真实侧栏入口 / 无头隔离扩展 /
 * 真实模型），只走真实面板按钮与输入框，不直接调用 agent 内部函数。
 *
 *   npx --no-install tsx scripts/acceptance/t05-resume-entry-run.mts --headless --case A05-01
 *   ... --case A05-02|A05-03|timing [--material 1] [--report out/acceptance/<dir>]
 *
 * 退出码 0 = 所选范围全部检查通过；1 = 有检查失败或基础设施失败。
 */
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {WebSocket} from 'ws';
import {loadConfig} from '../../agent/src/config.js';
import {startHost, stopHost, startIsolatedPanel, type HostHolder} from './product-journeys/runner.mjs';
import {createJourneyFixture, at2, PLAIN_FORMS} from './product-journeys/fixtures.mjs';
import {sleep, until} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('需要显式 --headless：本驱动只允许无头隔离运行。');
const argOf = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1];
};
const caseId = argOf('--case', 'A05-02')!;
if (!['A05-01', 'A05-02', 'A05-03', 'timing', 'cancel-late'].includes(caseId)) throw new Error(`未知 --case：${caseId}`);
const material = Number(argOf('--material', '0')) as 0 | 1;
const model = loadConfig().model ?? '(未配置)';
const outRoot = resolve(argOf('--report', `out/acceptance/${new Date().toISOString().replace(/[:.]/g, '-')}-t05-${caseId}`)!);
mkdirSync(outRoot, {recursive: true});

type TraceEvent = {at: number; direction: 'client' | 'server' | 'error'; message: Record<string, unknown>};
type Check = {id: string; ok: boolean; detail: string};

const checks: Check[] = [];
const check = (id: string, ok: boolean, detail = ''): void => { checks.push({id, ok, detail}); };
const events: TraceEvent[] = [];
const fixture = createJourneyFixture();
await new Promise<void>((r) => fixture.server.listen(0, '127.0.0.1', r));
const storeDir = join(outRoot, 'host');
const holder: HostHolder = {current: await startHost(model, storeDir, events)};
let iso: Awaited<ReturnType<typeof startIsolatedPanel>>['iso'] | undefined;
let panel = '';
let conversationId = 'default';
let tabId = -1;
let pageTarget = '';
let restartAtMs: number | null = null;
const humanEdit = {selector: '#note', value: ''};

const eventKind = (event: TraceEvent): string | undefined => {
  const message = event.message;
  if (message.type === 'agent_event') return (message.event as {kind?: string} | undefined)?.kind;
  return typeof message.type === 'string' ? message.type : undefined;
};
const eventReceipt = (event: TraceEvent): {action?: string; status?: string; runId?: string | null} | undefined => {
  const message = event.message;
  if (message.type !== 'agent_event') return undefined;
  return (message.event as {receipt?: {action?: string; status?: string; runId?: string | null}} | undefined)?.receipt;
};
const ownEvents = (from = 0): TraceEvent[] => events.slice(from).filter((event) =>
  (event.message as {conversationId?: string}).conversationId === conversationId
  || (event.message as {event?: {conversationId?: string}}).event?.conversationId === conversationId);

const panelEval = <T,>(expression: string): Promise<T> => iso!.evalIn(panel, expression) as Promise<T>;
const panelSend = async (text: string): Promise<void> => {
  await panelEval(`(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
};
const entryText = (): Promise<string> => panelEval(`(()=>{const el=document.querySelector('#resume-entry-root');return el&&!el.hidden?el.innerText.replace(/\\s+/g,' ').trim():'';})()`);
const entryButton = (): Promise<{present: boolean; disabled: boolean; label: string}> => panelEval(`(()=>{const b=document.querySelector('#resume-entry-root .resume-action');return {present:!!b,disabled:!!(b&&b.disabled),label:b?b.textContent:''};})()`);
const clickResume = (): Promise<void> => panelEval(`document.querySelector('#resume-entry-root .resume-action').click()`);
const pageProbe = (): Promise<Record<string, unknown>> => iso!.swEval(
  `chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{const f=window.__fixture||{};const fields={};for(const el of document.querySelectorAll('input,textarea,select')){if(!el.id)continue;if(el.type==='checkbox')fields[el.id]=el.checked;else if(el.type==='radio'){if(el.checked)fields[el.name]=el.value;}else fields[el.id]=el.value;}return {fields,status:(document.querySelector('#status')||{}).textContent||null,inputCounts:f.inputCounts||{}};}}).then(r=>r[0].result).catch(e=>({error:String(e)}))`,
  15_000,
) as Promise<Record<string, unknown>>;

interface FillCall { at: number; value: string | null; target: string | null; confirmed: boolean }
/** 从事件流按顺序配对 fill 调用与回执（与 T01 runner 同口径）。 */
function fillCalls(from: number): FillCall[] {
  const calls = new Map<string, {at: number; value: string | null; target: string | null}>();
  const results: FillCall[] = [];
  for (const event of ownEvents(from)) {
    const message = event.message;
    const ev = (message.event ?? {}) as {kind?: string; toolCallId?: string; name?: string; params?: {value?: unknown; target?: unknown}; isError?: boolean; executionFact?: string};
    if (message.type === 'agent_event' && ev.kind === 'tool_start' && ev.name === 'fill' && ev.toolCallId) {
      calls.set(ev.toolCallId, {at: event.at, value: typeof ev.params?.value === 'string' ? ev.params.value : null, target: typeof ev.params?.target === 'string' ? ev.params.target : null});
    }
    if (message.type === 'agent_event' && ev.kind === 'tool_end' && ev.name === 'fill' && ev.toolCallId && calls.has(ev.toolCallId)) {
      const started = calls.get(ev.toolCallId)!;
      calls.delete(ev.toolCallId);
      results.push({...started, confirmed: ev.isError === false && ev.executionFact === 'executed'});
    }
  }
  return results;
}

/** 等“已接收”回执或首个已确认 fill，然后立刻停宿主；返回停之前已发生的模型输出数。 */
async function killHostAt(cue: 'accepted' | 'first-fill', from: number): Promise<{outputsBeforeKill: number; runIdAtKill: string | null}> {
  if (cue === 'accepted') {
    await until(() => ownEvents(from).some((event) => {
      const receipt = eventReceipt(event);
      return receipt?.action === 'start' && receipt.status === 'accepted';
    }) || undefined, 30_000, 'accepted receipt');
  } else {
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline && !fillCalls(from).some((call) => call.confirmed)) await sleep(40);
    if (!fillCalls(from).some((call) => call.confirmed)) throw new Error('等待首个已确认 fill 超时');
  }
  const outputsBeforeKill = ownEvents(from).filter((event) => ['text_delta', 'tool_start'].includes(eventKind(event) ?? '')).length;
  const runIdAtKill = holder.current.manager.getTaskProgress(conversationId)?.runId ?? null;
  restartAtMs = Date.now();
  const token = holder.current.token;
  const port = holder.current.port;
  await stopHost(holder.current);
  holder.current = await startHost(model, storeDir, events, token, port);
  await until(() => holder.current.socket?.readyState === WebSocket.OPEN || undefined, 30_000, 'host reconnected');
  return {outputsBeforeKill, runIdAtKill};
}

async function openPanel(): Promise<string> {
  const id = (await iso!.swEval('chrome.runtime.id')) as string;
  const target = await iso!.newTarget(`chrome-extension://${id}/sidepanel.html?acceptance=t05`);
  await until(async () => (await iso!.evalIn(target, "!!document.querySelector('#input')")) || undefined, 10_000, 'panel input');
  return target;
}

async function newConversation(): Promise<void> {
  await until(async () => (await panelEval<boolean>("document.querySelector('#conversation-new')?.disabled===false")) || undefined, 10_000, 'new conversation ready');
  await panelEval("document.querySelector('#conversation-new').click()");
  await sleep(400);
  conversationId = (await iso!.swEval("chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId??'default')")) as string;
}

async function openFixturePage(): Promise<void> {
  pageTarget = await iso!.newTarget(`${fixture.origin}/form-plain?m=${material}`);
  const tab = await until(async () => {
    const tabs = (await iso!.swEval('chrome.tabs.query({})')) as {id: number; url: string}[];
    return tabs.find((candidate) => candidate.url.startsWith(`${fixture.origin}/form-plain`));
  }, 5_000, 'fixture tab');
  tabId = tab.id;
  await iso!.swEval(`chrome.tabs.update(${tabId},{active:true})`).catch(() => {});
  await sleep(300);
}

async function waitForEntry(timeout = 45_000): Promise<void> {
  await until(async () => (await entryButton()).present || undefined, timeout, 'resume entry button');
}

async function waitForEnd(from: number, timeout = 240_000): Promise<boolean> {
  return until(async () => {
    const own = ownEvents(from);
    const ended = own.some((event) => ['agent_end', 'error'].includes(eventKind(event) ?? ''));
    const snapshot = holder.current.manager.getTaskProgress(conversationId);
    if (!ended || !snapshot || ['running', 'interrupted', 'paused'].includes(snapshot.state)) return undefined;
    await sleep(1_500);
    return holder.current.manager.getTaskProgress(conversationId);
  }, timeout, 'task terminal').then(() => true).catch(() => false);
}

const plan = {caseId, material, model, fixture: fixture.origin, outRoot, startedAt: new Date().toISOString()};
writeFileSync(join(outRoot, 'plan.json'), JSON.stringify(plan, null, 2));

try {
  const started = await startIsolatedPanel(holder.current);
  iso = started.iso;
  panel = started.panel;
  const expected = at2(PLAIN_FORMS, material).fields;
  const userText = `帮我填登记表：姓名${expected.name}，邮箱${expected.email}，城市${expected.city}，备注「${expected.note}」。先不要提交。`;
  await newConversation();
  await openFixturePage();
  const before = events.length;

  if (caseId === 'A05-01') {
    await panelSend(`${userText}每填一项后读回确认，全部填完再汇报。`);
    await until(() => ownEvents(before).some((event) => eventKind(event) === 'tool_start') || undefined, 90_000, 'first tool');
    await iso.closeTarget(panel);
    await sleep(700);
    const running = holder.current.manager.getTaskProgress(conversationId);
    check('background-task-survives-panel-close', running?.state === 'running', `state=${running?.state}`);
    panel = await openPanel();
    // 新面板默认另开一段会话；按产品的会话背景/切换器回到原任务。
    await panelEval(`(()=>{document.querySelector('#conversation-switcher').click();const row=document.querySelector('#conversation-menu button[data-conversation-id=${JSON.stringify(conversationId)}]');if(!row)throw new Error('找不到原会话入口');row.click();})()`);
    const observed = await until(async () => {
      const text = await entryText();
      const state = holder.current.manager.getTaskProgress(conversationId)?.state;
      return text ? {text, state} : undefined;
    }, 20_000, 'summary visible').catch(() => null);
    check('summary-shows-goal', !!observed && observed.text.includes('登记表'), observed ? observed.text.slice(0, 240) : 'no summary before task end');
    check('summary-mentions-running', !!observed && ['running', 'paused', 'interrupted'].includes(observed.state ?? '') && (observed.text.includes('正在执行') || observed.text.includes('剩余') || observed.text.includes('正在处理')), observed ? `${observed.state} ${observed.text.slice(0, 200)}` : 'no summary before task end');
    const ended = await waitForEnd(before);
    check('task-completed-after-reopen', ended, `terminal=${ended}`);
    const probe = await pageProbe();
    const fields = (probe.fields ?? {}) as Record<string, unknown>;
    check('fields-complete', fields.name === expected.name && fields.email === expected.email && fields.city === expected.city && fields.note === expected.note, JSON.stringify(fields));
    check('no-submit', fixture.writes().length === 0, `writes=${fixture.writes().length}`);
    const notices = ownEvents(before).filter((event) => eventKind(event) === 'notice').map((event) => String((event.message.event as {message?: string})?.message ?? ''));
    check('no-interruption-notice', !notices.some((message) => message.includes('中断')), notices.find((message) => message.includes('中断')) ?? '');
  }

  if (caseId === 'A05-02' || caseId === 'A05-03') {
    await panelSend(caseId === 'A05-03' ? `${userText}每填一项后读回确认，全部填完再汇报。` : userText);
    const {outputsBeforeKill, runIdAtKill} = await killHostAt(caseId === 'A05-02' ? 'accepted' : 'first-fill', before);
    if (caseId === 'A05-02') check('killed-before-first-output', outputsBeforeKill === 0, `outputs=${outputsBeforeKill}`);
    else check('killed-mid-execution', fillCalls(before).some((call) => call.confirmed && call.at < (restartAtMs ?? 0)), `confirmed=${fillCalls(before).filter((call) => call.confirmed).length}`);
    await waitForEntry();
    const entry = await entryText();
    check('entry-shows-original-goal', entry.includes('登记表') || entry.includes(expected.name), entry.slice(0, 240));
    check('entry-shows-remaining', entry.includes('剩余') || entry.includes('未完成'), entry.slice(0, 240));
    const button = await entryButton();
    check('resume-button-available', button.present && !button.disabled && button.label === '继续原任务', JSON.stringify(button));
    if (caseId === 'A05-03') {
      humanEdit.value = `人工备注-${material}`;
      await iso!.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:(selector,value)=>{const el=document.querySelector(selector);el.focus();el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));},args:[${JSON.stringify(humanEdit.selector)},${JSON.stringify(humanEdit.value)}]})`);
      await sleep(300);
    }
    // A05-03 的未知写入需要一次用户确认（P0 有界恢复）：验收脚本作为模拟用户点真实面板卡片。
    // 人工改过的字段保留：卡片若要求重设人工值，模拟用户拒绝；其余允许一次。
    const consentSamples: unknown[] = [];
    const consentTimer = caseId === 'A05-03' ? setInterval(() => {
      void panelEval<Record<string, unknown>>(`(()=>{const root=document.getElementById('consent-requests');const card=document.querySelector('#consent-requests .consent-card');const pre=document.querySelector('#consent-requests .consent-card pre');const allow=document.querySelector('#consent-requests .consent-allow');return {hidden:root?root.hidden:null,cards:document.querySelectorAll('#consent-requests .consent-card').length,allow:!!allow,allowDisabled:allow?allow.disabled:null,text:pre?pre.textContent:(card?card.innerText:'')};})()`)
        .then((snapshot) => {
          consentSamples.push(snapshot);
          if (consentSamples.length > 40) consentSamples.shift();
          if (snapshot.allow !== true || snapshot.allowDisabled !== false) return;
          const text = String(snapshot.text ?? '');
          const overwritesHumanEdit = text.includes(`= ${expected.note}`);
          const selector = overwritesHumanEdit ? '.consent-reject' : '.consent-allow';
          void panelEval<boolean>(`(()=>{const b=document.querySelector('#consent-requests ${selector}');if(b&&!b.disabled){b.click();return true;}return false;})()`)
            .then((done) => { if (done) check(overwritesHumanEdit ? 'simulated-user-protected-human-edit' : 'simulated-user-allowed-one-reset', true, overwritesHumanEdit ? '拒绝重设人工值' : '面板真实确认卡片'); })
            .catch(() => {});
        })
        .catch((error) => { consentSamples.push({error: error instanceof Error ? error.message : String(error)}); if (consentSamples.length > 40) consentSamples.shift(); });
    }, 400) : null;
    await clickResume();
    if (consentTimer) setTimeout(() => clearInterval(consentTimer), 180_000);
    if (caseId === 'A05-03') writeFileSync(join(outRoot, 'consent-samples.json'), JSON.stringify(consentSamples, null, 2));
    const accepted = await until(() => ownEvents(before).some((event) => {
      const receipt = eventReceipt(event);
      return receipt?.action === 'resume' && (receipt.status === 'accepted' || receipt.status === 'applied');
    }) || undefined, 30_000, 'resume accepted').then(() => true).catch(() => false);
    check('resume-request-accepted', accepted, `accepted=${accepted}`);
    const ended = await waitForEnd(before, caseId === 'A05-03' ? 420_000 : 240_000);
    check('task-completed-after-resume', ended, `terminal=${ended}`);
    const probe = await pageProbe();
    const fields = (probe.fields ?? {}) as Record<string, unknown>;
    check('same-task-identity', (holder.current.manager.getTaskProgress(conversationId)?.runId ?? null) === runIdAtKill, `${holder.current.manager.getTaskProgress(conversationId)?.runId} vs ${runIdAtKill}`);
    if (caseId === 'A05-03') {
      const confirmedBefore = fillCalls(before).filter((call) => call.confirmed && call.at < (restartAtMs ?? 0)).map((call) => call.value);
      const afterRestart = fillCalls(before).filter((call) => call.at > (restartAtMs ?? 0));
      check('no-replayed-fill-after-restart', afterRestart.every((call) => !confirmedBefore.includes(call.value)), JSON.stringify({confirmedBefore, afterRestart: afterRestart.map((call) => call.value)}));
      check('human-edit-preserved', fields.note === humanEdit.value, `note=${JSON.stringify(fields.note)} want=${JSON.stringify(humanEdit.value)}`);
      check('other-fields-complete', fields.name === expected.name && fields.email === expected.email && fields.city === expected.city, JSON.stringify(fields));
      writeFileSync(join(outRoot, 'consent-samples.json'), JSON.stringify(consentSamples, null, 2));
    } else {
      check('fields-complete', fields.name === expected.name && fields.email === expected.email && fields.city === expected.city && fields.note === expected.note, JSON.stringify(fields));
    }
    check('no-submit', fixture.writes().length === 0, `writes=${fixture.writes().length}`);
  }

  if (caseId === 'timing') {
    await panelSend(userText);
    await killHostAt('accepted', before);
    await waitForEntry();
    // 面板是可见侧栏时才有帧：把面板标签页设为活动页再采样（无头下后台页 rAF 会被节流）。
    const panelTab = await iso!.swEval(`chrome.tabs.query({}).then(tabs=>{const t=tabs.find(x=>(x.url||'').includes('sidepanel.html'));return t?t.id:null;})`) as number | null;
    if (panelTab !== null) await iso!.swEval(`chrome.tabs.update(${panelTab},{active:true})`).catch(() => {});
    await sleep(1_000);
    for (let i = 0; i < 50; i += 1) {
      await panelEval('window.__t05QueryView&&window.__t05QueryView()');
      await sleep(250);
    }
    await sleep(1_500);
    const timing = await panelEval<{count: number; p95: number | null; samples: number[]}>('window.__resumeEntryTiming()');
    check('timing-samples', timing.count >= 50, `count=${timing.count}`);
    check('timing-p95', timing.p95 !== null && timing.p95 <= 200, `p95=${timing.p95}`);
    writeFileSync(join(outRoot, 'timing.json'), JSON.stringify(timing, null, 2));
  }

  if (caseId === 'cancel-late') {
    await panelSend(userText);
    await killHostAt('accepted', before);
    await waitForEntry();
    const runId = holder.current.manager.getTaskProgress(conversationId)?.runId ?? null;
    const resumeAt = Date.now();
    // 人工注入竞态：页面主线程忙等，让恢复前的页面读回晚到。
    void iso!.swEval(`chrome.scripting.executeScript({target:{tabId:${tabId}},world:'MAIN',func:()=>{const end=Date.now()+4000;while(Date.now()<end){}}})`).catch(() => {});
    await sleep(120);
    await clickResume();
    await sleep(400);
    const abortAt = Date.now();
    const abortRequestId = `abort-${abortAt}`;
    await panelEval(`(()=>{const p=chrome.runtime.connect({name:'sideagent-panel'});p.postMessage({kind:'client',msg:{type:'task_action',conversationId:${JSON.stringify(conversationId)},request:{requestId:${JSON.stringify(abortRequestId)},conversationId:${JSON.stringify(conversationId)},source:'text',action:'abort',expectedRunId:${JSON.stringify(runId)},expectedControlVersion:0}}});return true;})()`);
    await sleep(6_000);
    const snapshot = holder.current.manager.getTaskProgress(conversationId);
    const startsAfterResume = ownEvents(before).filter((event) => eventKind(event) === 'agent_start' && event.at > resumeAt).length;
    const fillsAfterAbort = fillCalls(before).filter((call) => call.at > abortAt);
    check('late-read-does-not-start-old-task', startsAfterResume === 0, `agent_start after resume=${startsAfterResume}`);
    check('cancelled-task-not-resurrected', ['aborted', 'interrupted'].includes(snapshot?.state ?? ''), `state=${snapshot?.state}`);
    check('no-page-write-after-cancel', fillsAfterAbort.length === 0, `fills=${JSON.stringify(fillsAfterAbort.map((call) => call.value))}`);
    const probe = await pageProbe();
    const fields = (probe.fields ?? {}) as Record<string, unknown>;
    const untouched = Object.values(fields).every((value) => value === '' || value === undefined);
    check('process-page-not-polluted', untouched, JSON.stringify(fields));
    const button = await entryButton();
    check('no-resume-button-after-cancel', !button.present, JSON.stringify(button));
  }

  writeFileSync(join(outRoot, 'events.json'), JSON.stringify(events.slice(before), null, 2));
} catch (error) {
  check('infrastructure', false, error instanceof Error ? error.message : String(error));
} finally {
  writeFileSync(join(outRoot, 'result.json'), JSON.stringify({
    caseId, material, model, restartAtMs, humanEdit, conversationId, tabId, pageTarget,
    checks, ok: checks.every((item) => item.ok), endedAt: new Date().toISOString(),
  }, null, 2));
  if (iso && panel) await iso.screenshot(panel, join(outRoot, 'panel-final.png')).catch(() => {});
  if (iso && pageTarget) await iso.screenshot(pageTarget, join(outRoot, 'page-final.png')).catch(() => {});
  await iso?.close().catch(() => {});
  await stopHost(holder.current).catch(() => {});
  await fixture.close().catch(() => {});
}
console.log(JSON.stringify({caseId, material, ok: checks.every((item) => item.ok), checks}, null, 2));
process.exit(checks.every((item) => item.ok) ? 0 : 1);
