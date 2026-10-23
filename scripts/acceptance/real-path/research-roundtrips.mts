/** Real extension, real model, a multi-site research task starting from a blank page.
 * SIDEAGENT_ACCEPTANCE_DIST=... npx tsx scripts/acceptance/real-path/research-roundtrips.mts --headless --label=before
 * Saves independent page evidence separately from model traces. No expected answers enter the conversation.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { loadavg } from 'node:os';
import { REPO, launchRealPath, requireHeadless, until, sleep } from './harness.mts';
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from './inproc-config.mts';
import { networkUsage } from '../../gym/instrumentation.mts';

requireHeadless();
const arg = (key: string) => process.argv.find(v => v.startsWith(`--${key}=`))?.slice(key.length + 3);
const label = arg('label') ?? 'baseline';
const holdout = arg('case') === 'holdout';
const out = resolve(arg('out') ?? join(REPO, 'out/acceptance/real-path', `${new Date().toISOString().replace(/[:.]/g, '-')}-research-roundtrips-${label}`));
await mkdir(out, { recursive: true });
const pages = holdout ? [
  { name: 'Cassini-Huygens', alias: /Cassini|卡西尼/i, url: 'https://science.nasa.gov/mission/cassini/', date: '1997-10-15', sourceDate: /Oct(?:ober|\.)?\s*15,?\s*1997/i, targets: [/Saturn|土星/i] },
  { name: 'Chandrayaan-3', alias: /Chandrayaan.?3|月船[三3]/i, url: 'https://www.isro.gov.in/ISRO_EN/Chandrayaan3.html', date: '2023-07-14', sourceDate: /July\s+14,?\s*2023/i, targets: [/Moon|月球/i] },
] : [
  { name: 'Voyager 1', alias: /Voyager\s*1|旅行者[一1]/i, url: 'https://science.nasa.gov/mission/voyager/voyager-1/', date: '1977-09-05', sourceDate: /Sept(?:ember|\.)?\s*5,?\s*1977/i, targets: [/Jupiter|木星/i, /Saturn|土星/i] },
  { name: 'Rosetta', alias: /Rosetta|罗塞塔/i, url: 'https://www.esa.int/Science_Exploration/Space_Science/Rosetta', date: '2004-03-02', sourceDate: /2\s+March\s+2004/i, targets: [/67P/i] },
  { name: 'Hayabusa2', alias: /Hayabusa\s*2|隼鸟[二2]/i, url: 'https://global.jaxa.jp/projects/sas/hayabusa2/', date: '2014-12-03', sourceDate: /December\s+3,?\s*2014/i, targets: [/Ryugu|龙宫/i] },
];
const prompt = `请查阅下面${holdout ? '两个' : '三个'}官网页面，核实 ${pages.map(p=>p.name).join('、')} 的发射日期和最初的主要探测目标天体，不要把后续扩展任务的目标混进来。用${holdout ? '两' : '三'}行表格汇总：任务名、发射日期（YYYY-MM-DD）、最初目标、支持日期和目标的英文原文短引文、对应官网链接。不要只凭已有知识回答，请实际查阅页面。${process.argv.includes('--explicit-quotes') ? '每一行的英文原文引文必须同时包含官网中的发射日期写法和目标天体名称，可以分成两段短引文。' : ''}\n${pages.map(p=>p.url).join('\n')}`;
type Row = Record<string, any>;
const evidence: Row[] = [];
const normalized = (text: string) => text.normalize('NFKC').replace(/\s*—\s*/g, ' ').replace(/[−–]/g, '-').replace(/[“”‘’"']/g, '').replace(/\[\d+\]/g, '').replace(/\s+/g, ' ').trim().replace(/[.,:;](?=\s|$)/g, '').toLowerCase();
function sourceContainsQuote(source: string, quote: string): boolean {
  const text = normalized(source), parts = quote.split(/…|\.{3}/).map(normalized).filter(Boolean);
  let end = 0;
  for (const part of parts) {
    const at = text.indexOf(part, end);
    if (at < 0) return false;
    end = at + part.length;
  }
  return parts.length > 0;
}
function judge(rows: Row[], _answer: string): { pass: boolean; checks: Row[] } {
  const checks = pages.map(page => {
    const source = evidence.find(e=>e.name===page.name);
    const matches = rows.filter(row => page.alias.test(row.cells[0] ?? ''));
    const row = matches.length === 1 ? matches[0] : undefined;
    const quotes = [...String(row?.cells.slice(3).join(' ') ?? '').matchAll(/[“"]([^”"]+)[”"]/g)].map(m=>m[1]!);
    return { name: page.name, date: String(row?.cells[1] ?? '').trim() === page.date,
      targets: page.targets.every(pattern=>pattern.test(row?.cells[2] ?? '')),
      link: !!row?.links.some((url: string)=>url===page.url||url===source.url),
      quotes: quotes.length>=1 && quotes.every(quote=>sourceContainsQuote(source.text,quote))
        && page.sourceDate.test(quotes.join(' ')) && page.targets.every(pattern=>pattern.test(quotes.join(' '))),
    };
  });
  return { pass: checks.every(c=>c.date&&c.targets&&c.link&&c.quotes), checks };
}
// Re-score a finished run with the current judge, from its saved table and independently read sources; no browser or model.
const rejudge = arg('rejudge');
if (rejudge) {
  const saved = JSON.parse(await readFile(join(rejudge, 'result.json'), 'utf8')) as Row;
  evidence.push(...JSON.parse(await readFile(join(rejudge, 'sources.json'), 'utf8')) as Row[]);
  const verdict = judge(saved.tableRows ?? [], saved.answer ?? '');
  await writeFile(join(rejudge, 'rejudge.json'), JSON.stringify({ label: saved.label, before: saved.verdict, verdict }, null, 2));
  console.log(JSON.stringify({ label: saved.label, was: saved.verdict?.pass ?? null, now: verdict.pass, checks: verdict.checks }));
  process.exit(0);
}
const loadWait = Date.now();
while (loadavg()[0] > 20 && Date.now() - loadWait < 300_000) {
  console.log(JSON.stringify({ phase: 'waiting_for_load', load: loadavg()[0] }));
  await sleep(15_000);
}
if (loadavg()[0] > 20) {
  await writeFile(join(out, 'result.json'), JSON.stringify({ status: 'not_run', reason: 'machine_load', load: loadavg(), label }));
  throw new Error('Machine load remains above 20; no comparison started');
}
const plan = await loadModelPlan(DEFAULT_TEST_MODEL);
if (plan.credential.type === 'oauth') plan.credential.refresh = '';
console.log(JSON.stringify({ phase: 'launch', label, out }));
const rp = await launchRealPath();
let panel = '', trace: Row[] = [], finishNetwork: Awaited<ReturnType<typeof networkUsage>> | undefined;
let workerSession = '';
const result: Row = { label, model: DEFAULT_TEST_MODEL, prompt, pages, status: 'unknown', out, loadAtStart: loadavg(), storageErrors: [] };
const tableExpression = `[...([...document.querySelectorAll('#messages .msg.assistant table')].at(-1)?.querySelectorAll('tr')??[])].map(row=>({cells:[...row.querySelectorAll(':scope > th,:scope > td')].map(cell=>cell.innerText),links:[...row.querySelectorAll('a[href]')].map(a=>a.href)}))`;
// Table labels can be separated by a colon, an em dash or a line break; excerpt-ending punctuation is editorial.
// Keep punctuation inside numbers, and require every quoted word in the source in the same order.
const traceExpression = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
try {
  result.buildHash = createHash('sha256').update(await readFile(join(rp.dirs.extension, 'inproc.js'))).digest('hex');
  for (const page of pages) {
    const { targetId } = await rp.cdp.send('Target.createTarget', { url: page.url });
    const session = await rp.attach(targetId);
    await until(async () => await rp.evaluate(session, `document.readyState!=='loading' && document.body?.innerText.length>500 && new RegExp(${JSON.stringify(page.sourceDate.source)},'i').test(document.body.innerText)`) || undefined, 60_000, `${page.name} public page`).catch(async error => {
      await writeFile(join(out, `${page.name}-source-failure.json`), JSON.stringify(await rp.evaluate(session, `({url:location.href,title:document.title,state:document.readyState,text:document.body?.innerText})`), null, 2));
      await rp.screenshot(session, join(out, `${page.name}-source-failure.png`));
      throw error;
    });
    const source = await rp.evaluate(session, `({url:location.href,title:document.title,text:document.body.innerText})`) as Row;
    await writeFile(join(out, `${page.name}-source.json`), JSON.stringify(source, null, 2));
    if (!page.sourceDate.test(source.text) || !page.targets.every(pattern=>pattern.test(source.text))) throw new Error(`${page.name}: independent reference missing`);
    evidence.push({ name: page.name, ...source, hash: createHash('sha256').update(source.text).digest('hex') });
    await rp.screenshot(session, join(out, `${page.name}.png`));
    await rp.cdp.send('Target.closeTarget', {targetId});
    console.log(JSON.stringify({ phase: 'source', page: page.name, chars: source.text.length }));
  }
  await writeFile(join(out, 'sources.json'), JSON.stringify(evidence, null, 2));
  panel = await rp.attach(await rp.openSidePanel());
  const settings = modelStorageItems(plan);
  settings.inproc_fast_model_config = settings.inproc_model_config;
  await rp.evaluate(panel, `chrome.storage.local.set(${JSON.stringify(settings)}).then(()=>true)`);
  await until(async () => await rp.evaluate(panel, `document.querySelector('#status-dot')?.classList.contains('on') && document.querySelector('#send-btn')?.disabled===false`) || undefined, 60_000, 'sidebar ready');
  finishNetwork = await networkUsage(rp);
  const agentTarget = (await rp.targets()).find(t => t.url === `chrome-extension://${rp.extensionId}/inproc.html`)!;
  const agentSession = await rp.attach(agentTarget.targetId);
  rp.cdp.onEvent('Runtime.consoleAPICalled', (event: { sessionId?: string; params: { args?: Array<{ value?: unknown; description?: string }> } }) => {
    if (event.sessionId !== agentSession) return;
    const text = (event.params.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
    if (text.includes('[sideagent] opfs')) result.storageErrors.push(text);
  });
  await rp.cdp.send('Runtime.enable', {}, agentSession);
  const worker = (await rp.targets()).find(t => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${rp.extensionId}/`))!;
  workerSession = await rp.attach(worker.targetId);
  await rp.evaluate(workerSession, `(()=>{globalThis.evidenceReads=[];const original=chrome.debugger.sendCommand.bind(chrome.debugger);chrome.debugger.sendCommand=async function(target,method,params){const started=performance.now();try{const result=await original(target,method,params);evidenceReads.push({tabId:target.tabId,method,ms:performance.now()-started,...(method==='Accessibility.getFullAXTree'?{result}:{})});return result}catch(error){evidenceReads.push({tabId:target.tabId,method,ms:performance.now()-started,error:String(error)});throw error}};return true})()`);
  await rp.click(panel, '#input');
  await rp.typeText(panel, prompt);
  const started = Date.now();
  result.startedAt = new Date(started).toISOString();
  result.loadSamples = [];
  await rp.pressEnter(panel);
  let quietSince = 0, lastCount = 0, lastReport = 0, lastVisibleAnswer = '';
  while (Date.now() - started < 300_000) {
    await sleep(1000);
    result.loadSamples.push({ ms: Date.now() - started, load: loadavg()[0] });
    trace = await rp.evaluate(panel, traceExpression);
    const visibleAnswer = String(await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant')].map(e=>e.innerText).join(${JSON.stringify('\n\n')})`));
    if (visibleAnswer && visibleAnswer !== lastVisibleAnswer) {
      result.firstVisibleMs ??= Date.now() - started;
      result.lastVisibleChangeMs = Date.now() - started;
      lastVisibleAnswer = visibleAnswer;
    }
    const idle = await rp.evaluate(panel, `document.querySelector('#send-btn')?.disabled===false && !document.querySelector('#status-pill')?.classList.contains('running') && !document.querySelector('.msg.assistant.streaming,.msg.assistant[data-revealing]')`);
    const failed = trace.findLast(e => e.type === 'session_error');
    if (failed && idle) throw new Error(`Session failed: ${JSON.stringify(failed.data)}`);
    if (!idle || trace.length !== lastCount) quietSince = 0;
    lastCount = trace.length;
    if (idle && trace.some(e => e.type === 'agent_end')) quietSince ||= Date.now();
    if (Date.now() - lastReport > 15_000) {
      await writeFile(join(out, 'trace.jsonl'), trace.map(e => JSON.stringify(e)).join('\n') + '\n');
      await writeFile(join(out, 'progress.json'), JSON.stringify({ load: loadavg(), storageErrors: result.storageErrors, seconds: (Date.now() - started) / 1000 }));
      console.log(JSON.stringify({ phase: 'running', seconds: Math.round((Date.now() - started) / 1000), modelCalls: trace.filter(e => e.type === 'model_request').length, tools: trace.filter(e => e.type === 'tool_execution_end').length, last: trace.at(-1)?.type }));
      lastReport = Date.now();
    }
    if (quietSince && Date.now() - quietSince >= 20_000) { result.settled = true; break; }
  }
  result.elapsedMs = Date.now() - started;
  result.timingComparable = result.loadSamples.every((sample: {load: number}) => sample.load <= 30);
  result.agentElapsedMs = Math.max(0, ...trace.filter(e => e.type === 'agent_end').map(e => Date.parse(e.time) - started));
  result.network = await finishNetwork();
  finishNetwork = undefined;
  result.answer = await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant')].map(e=>e.innerText).join(${JSON.stringify('\n\n')})`);
  result.links = await rp.evaluate(panel, `[...document.querySelectorAll('#messages .msg.assistant a[href]')].map(e=>({text:e.textContent,href:e.href}))`);
  result.tableRows = await rp.evaluate(panel, tableExpression);
  result.verdict = judge(result.tableRows, result.answer);
  result.modelCalls = trace.filter(e => e.type === 'model_request').length;
  result.sideCalls = trace.filter(e => e.type === 'side_call').map(e => e.data);
  result.observations = trace.filter(e => e.type === 'pre_observation').map(e => e.data);
  result.goalChecks = trace.filter(e => e.type === 'goal_check').map(e => e.data);
  result.tools = trace.filter(e => e.type === 'tool_execution_end').map(e => ({ name: e.data.toolName, error: e.data.isError, elapsedMs:e.data.elapsedMs }));
  result.steps = trace.filter(e=>e.type==='program_step').map(e=>e.data.step);
  result.requests = trace.filter(e=>e.type==='model_request').map(e=>({at:e.time,effort:e.data.effort}));
  result.status = !result.settled ? 'timeout' : result.verdict.pass ? 'pass' : 'failed_or_unverified';
  await rp.screenshot(panel, join(out, 'answer.png'));
  await writeFile(join(out, 'answer.txt'), String(result.answer));
  if (process.argv.includes('--oracle-probe') && result.verdict.pass) {
    await rp.evaluate(panel, `(()=>{const cell=document.querySelector('#messages .msg.assistant table tbody tr td:nth-child(2)');if(!cell)throw Error('No numeric answer cell');globalThis.evidenceProbe={cell,text:cell.textContent};cell.textContent='999999';return true})()`);
    result.negativeControl = judge(await rp.evaluate(panel, tableExpression), result.answer);
    await rp.screenshot(panel, join(out, 'wrong-value-rejected.png'));
    await rp.evaluate(panel, `(()=>{evidenceProbe.cell.textContent=evidenceProbe.text;delete globalThis.evidenceProbe;return true})()`);
    result.restoredControl = judge(await rp.evaluate(panel, tableExpression), result.answer);
    if (result.negativeControl.pass || !result.restoredControl.pass) throw new Error('Independent judge failed its visible wrong-value control');
  }
  if (result.status !== 'pass') process.exitCode = 1;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  result.status = 'error';
  process.exitCode = 1;
} finally {
  if (panel) {
    trace = await rp.evaluate(panel, traceExpression).catch(() => trace);
    if (result.error) {
      await rp.screenshot(panel, join(out, 'error.png')).catch(() => {});
      await writeFile(join(out, 'error-ui.txt'), String(await rp.evaluate(panel, 'document.body.innerText').catch(String)));
    }
  }
  result.network ??= await finishNetwork?.().catch(() => []);
  if (workerSession) await writeFile(join(out, 'browser-reads.json'), JSON.stringify(await rp.evaluate(workerSession, 'evidenceReads').catch(() => [])));
  await writeFile(join(out, 'trace.jsonl'), trace.map(e => JSON.stringify(e)).join('\n') + '\n');
  await writeFile(join(out, 'result.json'), JSON.stringify(result, null, 2));
  await rp.close();
  await rp.remove();
  console.log(JSON.stringify({ status: result.status, error: result.error, out }));
}
