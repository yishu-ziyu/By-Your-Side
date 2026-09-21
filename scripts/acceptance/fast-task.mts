/** Real panel → production host → isolated headless extension. Oracle reads browser/DOM independently. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

if (!process.argv.includes('--headless')) throw new Error('--headless required');
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const scenario = arg('scenario') ?? 'tab';
if (!['tab', 'display', 'font', 'negative', 'compound'].includes(scenario)) throw new Error('Unsupported scenario');
const simpleTask = ['tab', 'display', 'font'].includes(scenario);
const displayTask = ['display', 'font'].includes(scenario);
const pauseDuringDecision = process.argv.includes('--pause');
const baseline = arg('baseline-root');
const out = resolve('out/acceptance', `fast-task-${baseline ? 'baseline' : 'current'}-${scenario}-${Date.now()}`);
await mkdir(out, { recursive: true });
process.env.SIDEAGENT_TRACE_DIR = join(out, 'traces');
process.env.SIDEAGENT_GENERAL_BROWSER_LOOP = '1';
process.env.SIDEAGENT_DISPLAY_FASTPATH = '1';
process.env.EGO_ACCEPTANCE_CHROME = resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const sourceRoot = baseline ?? process.cwd();
const { startHost, startIsolatedPanel, stopHost } = await import(pathToFileURL(join(sourceRoot, 'scripts/acceptance/product-journeys/runner.mts')).href);
const { loadConfig } = await import(pathToFileURL(join(sourceRoot, 'agent/src/config.ts')).href);
const events: any[] = [];
let host: any, iso: any;
const report: any = { passed: false, scenario, baseline: !!baseline, kind: 'development-regression', input: 'typed-real-panel', headless: true };
const wait = async (fn: () => any, label: string, ms = 90000) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    const value = await fn();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 80));
  }
  throw new Error(`${label} timeout`);
};
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Reading desk</title><main><article><h1 id="title">Research desk</h1><p id="body">Rainfall increased by ten percent. River levels stayed stable.</p></article></main><script>if(location.pathname==='/paper'){document.title='Rainfall study';document.querySelector('#title').textContent='Rainfall study'}else if(location.pathname==='/other'){document.title='Wind study';document.querySelector('#title').textContent='Wind study'}</script></html>`;
try {
  host = await startHost(loadConfig().model ?? '', join(out, 'store'), events);
  const { iso: browser, panel } = await startIsolatedPanel(host, { fixtureHtml: html });
  iso = browser;
  await iso.newTarget(iso.fixtureOrigin + '/paper');
  await iso.newTarget(iso.fixtureOrigin + '/other');
  const desk = await iso.newTarget(iso.fixtureOrigin + '/desk');
  const tabs = await wait(async () => {
    const values = await iso.swEval('chrome.tabs.query({})');
    return ['/paper', '/other', '/desk'].every(path => values.some((t: any) => t.url === iso.fixtureOrigin + path && t.status === 'complete')) ? values : undefined;
  }, 'fixture tabs', 5000);
  const paper = tabs.find((t: any) => t.url === iso.fixtureOrigin + '/paper');
  const home = tabs.find((t: any) => t.url === iso.fixtureOrigin + '/desk');
  await wait(() => iso.evalIn(desk, 'document.readyState === "complete"'), 'fixture loaded', 5000);
  await iso.swEval(`chrome.tabs.update(${home.id},{active:true})`);
  if (displayTask) {
    const call = async (params: any) => {
      const result = await iso.tool('page_translation', { tabId: home.id, ...params }, 'main');
      if (!result.ok) throw new Error(JSON.stringify(result));
      return result.data;
    };
    const started = await call({ action: 'begin', mode: 'bilingual' });
    const collected = await call({ action: 'collect', document: started.document });
    await call({ action: 'apply', document: started.document, translations: collected.blocks.flatMap((b: any) => b.segments.map((s: any) => ({ id: s.id, text: '降雨增加，河流水位稳定。' }))) });
    if (!(await iso.evalIn(desk, "document.querySelectorAll('[data-bys-translation]').length"))) throw new Error('Translation fixture not initialized');
  }
  const prompts: Record<string, string[]> = {
    tab: ['切换到已经打开的 Rainfall study 标签页。', '我想看 Rainfall study 那一页，帮我切过去。'],
    display: ['已有译文只显示译文，隐藏原文。', '保留翻译，把英文原文收起来。'],
    font: ['译文换成宋体。', '请用宋体显示现有翻译，保持双语对照。'],
    negative: ['不要切换标签。告诉我 Rainfall study 是否已经打开。', 'Rainfall study 那个标签还在吗？不用打开给我看。'],
    compound: ['切换到 Rainfall study，然后总结这篇文章的主要结论。', '切到 Rainfall study，再用一句话告诉我降雨和河流水位的变化。'],
  };
  const variant = Number(arg('variant') ?? 0);
  const text = prompts[scenario]?.[variant];
  if (!text) throw new Error('Unknown prompt variant');
  report.variant = variant;
  report.text = text;
  const firstEvent = events.length;
  const begin = performance.now();
  await iso.evalIn(panel, `(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(text)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  if (pauseDuringDecision) {
    await wait(() => events.slice(firstEvent).some(e => e.message.type === 'tool_call' && e.message.name === 'snapshot'), 'initial observation', 5000);
    const before = host.manager.getTaskProgress('default');
    const receipt = await host.manager.dispatchTaskAction({ requestId: `pause-${Date.now()}`, conversationId: 'default', source: 'text', action: 'pause', expectedRunId: before.runId, expectedControlVersion: before.controlVersion, text: '暂停这次测试任务' });
    const cutoff = events.length;
    await wait(() => !host.manager.get('default').runtime.session.isStreaming(), 'paused work drained', 10000);
    report.snapshot = host.manager.getTaskProgress('default');
    const activeId = await iso.swEval('chrome.tabs.query({active:true}).then(tabs=>tabs.find(tab=>tab.url.startsWith(' + JSON.stringify(iso.fixtureOrigin) + '))?.id)');
    report.pauseReceipt = receipt;
    report.checks = {
      paused: report.snapshot.state === 'paused',
      noPageChange: activeId === home.id,
      noFalseComplete: !report.snapshot.goalPlan.goals.every((goal: any) => goal.status === 'satisfied') && !events.slice(firstEvent).some(e => e.message.event?.kind === 'user_delivery' && e.message.event.delivery.facts?.outcome === 'complete'),
      noLateWrite: !events.slice(cutoff).some(e => e.message.type === 'tool_call' && ['switch_tab','navigate','page_translation','fill','click'].includes(e.message.name)),
    };
    report.pausedDuringDecision = true;
  } else {
  const deliveryEvent = await wait(async () => {
    if (report.visibleResultMs === undefined && simpleTask) {
      const matches = scenario === 'font'
        ? await iso.evalIn(desk, "(()=>{const e=document.querySelector('#body [data-bys-translation]');return !!e && /Songti SC/.test(getComputedStyle(e).fontFamily)})()")
        : scenario === 'display'
        ? await iso.evalIn(desk, "document.querySelectorAll('[data-bys-translation]').length === 0 && document.querySelector('#body').textContent === '降雨增加，河流水位稳定。'")
        : await iso.swEval(`chrome.tabs.get(${paper.id}).then(tab => tab.active)`);
      if (matches) report.visibleResultMs = performance.now() - begin;
    }
    return events.slice(firstEvent).find(e => e.message.event?.kind === 'user_delivery' && e.message.event.delivery.kind === 'finding');
  }, 'finding');
  report.deliveryMs = performance.now() - begin;
  await wait(() => !host.manager.get('default').runtime.session.isStreaming() && host.manager.getTaskProgress('default')?.state === 'idle', 'idle', 15000);
  const panelState = await wait(async () => {
    const value = await iso.evalIn(panel, `({headline:document.querySelector('.tb-status')?.textContent,waiting:document.querySelector('.tb-waiting')?.textContent})`);
    return value.headline?.includes('本轮已结束') ? value : undefined;
  }, 'panel outcome', 5000);
  report.panelMs = performance.now() - begin;
  const actualTabs = await iso.swEval('chrome.tabs.query({})');
  report.tabsBefore = tabs.map((t: any) => ({id:t.id,url:t.url}));
  report.tabsAfter = actualTabs.map((t: any) => ({id:t.id,url:t.url}));
  const active = actualTabs.find((t: any) => t.active && t.url?.startsWith(iso.fixtureOrigin));
  const display = await iso.evalIn(desk, `({translations:document.querySelectorAll('[data-bys-translation]').length,text:document.querySelector('#body').textContent,font:(()=>{const e=document.querySelector('#body [data-bys-translation]')||document.querySelector('#body');return getComputedStyle(e).fontFamily})()})`);
  const window = events.slice(firstEvent);
  report.delivery = deliveryEvent.message.event.delivery;
  report.snapshot = host.manager.getTaskProgress('default');
  report.panel = panelState;
  report.actual = { active: active?.url, display };
  report.calls = window.filter(e => e.message.type === 'tool_call').map(e => ({ name: e.message.name, params: e.message.params }));
  report.checks = {
    actualOutcome: scenario === 'font' ? display.translations > 0 && /Songti SC/.test(display.font) && display.text.includes('Rainfall increased') : scenario === 'display' ? display.translations === 0 && display.text === '降雨增加，河流水位稳定。' : active?.id === (scenario === 'negative' ? home.id : paper.id),
    goalsSatisfied: report.snapshot.goalPlan?.goals.every((g: any) => g.status === 'satisfied') === true,
    verifiedDelivery: report.delivery.facts?.outcome === 'complete',
    panelComplete: panelState.headline.includes('本轮已结束'),
    tabsPreserved: tabs.length === actualTabs.length && tabs.every((before: any) => actualTabs.some((after: any) => after.id === before.id && after.url === before.url)),
    noUnexpectedTranslationGeneration: !report.calls.some((c: any) => c.name === 'page_translation' && ['begin','apply'].includes(c.params.action)),
  };
  if (scenario === 'negative') report.checks.noSwitch = !report.calls.some((c: any) => c.name === 'switch_tab');
  if (scenario === 'compound') report.checks.answerPresent = /降雨|rainfall/i.test(report.delivery.text) && /水位|river/i.test(report.delivery.text);
  }
} catch (error) {
  report.error = String(error);
  report.snapshot = host?.manager.getTaskProgress('default');
  if (iso) report.tabsAfter = await iso.swEval('chrome.tabs.query({})').catch(() => undefined);
} finally {
  if (host) await stopHost(host).catch(() => {});
  await iso?.close().catch(() => {});
  const traces: any[] = [];
  for (const file of await readdir(join(out, 'traces')).catch(() => [] as string[])) {
    for (const line of (await readFile(join(out, 'traces', file), 'utf8')).split('\n').filter(Boolean)) traces.push(JSON.parse(line));
  }
  report.primaryModelTurns = traces.filter(t => t.type === 'turn_start').length;
  if (report.checks && !baseline) {
    const stages = traces.filter(t => t.type === 'stage_end');
    const starts = traces.filter(t => t.type === 'stage_start');
    report.stages = stages.map(t => ({ name: t.data.name, branch: t.data.branch, outcome: t.data.outcome, durationMs: t.data.durationMs, runId: t.runId, goalRevision: t.goalRevision }));
    report.checks.modelRouteCorrect = simpleTask ? report.primaryModelTurns === 0 : report.primaryModelTurns > 0;
    report.checks.stagesClosed = starts.length > 0 && starts.every(start => stages.filter(end => end.data.stageId === start.data.stageId).length === 1);
    report.checks.stageDurationsValid = stages.every(stage => Number.isFinite(stage.data.durationMs) && stage.data.durationMs >= 0);
    report.checks.stageTaskIdentity = stages.every(stage => stage.runId === report.snapshot.runId && stage.goalRevision === report.snapshot.goalPlan.revision);
    report.checks.requiredStages = (pauseDuringDecision ? ['fast_task_total','observation'] : simpleTask
      ? ['fast_task_total','observation','judgment','execution','verification','persist_delivery']
      : ['fast_task_total','observation','judgment']).every(name => stages.some(stage => stage.data.name === name));
  }
  report.passed = !report.error && !!report.checks && Object.values(report.checks).every(Boolean);
  await writeFile(join(out, 'result.json'), JSON.stringify({ ...report, traces, events }, null, 2));
  console.log(JSON.stringify({ out, ...report }, null, 2));
  process.exit(report.passed ? 0 : 1);
}
