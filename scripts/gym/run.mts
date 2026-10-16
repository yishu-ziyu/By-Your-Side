/**
 * Real BYS sidebar → existing agent → AX/CDP → local app. No scripted model.
 * npm run gym -- --headless [--tasks=todo,form,search] [--seeds=11,29,47] [--groups=A,B]
 *   [--seconds=180] [--commands=600] [--fault=none|drop|late-drop|stale|unknown|waiting] [--out=absolute-directory] [--no-video]
 * Uses one frozen build and a fresh profile per episode. Failed samples are append-only.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { loadavg } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { REPO, launchRealPath, requireHeadless, until, sleep, recordScreen } from '../acceptance/real-path/harness.mts';
import { DEFAULT_TEST_MODEL, loadModelPlan, modelStorageItems } from '../acceptance/real-path/inproc-config.mts';
import { startFixture, promptFor, tasks, seeds } from './fixture.mjs';
import { evaluate, feedback, claimFrom } from './evaluator.mjs';

import { installAudit, installBudget, networkUsage } from './instrumentation.mts';

requireHeadless();
const arg = (key: string) => process.argv.find(x => x.startsWith(`--${key}=`))?.slice(key.length + 3);
const selectedTasks = arg('tasks')?.split(',') ?? tasks;
const selectedSeeds = arg('seeds')?.split(',').map(Number) ?? seeds;
const groups = arg('groups')?.split(',') ?? ['A', 'B'];
const seconds = Number(arg('seconds') ?? 180), commands = Number(arg('commands') ?? 600);
const fault = arg('fault') ?? 'none';
if(!['none','drop','late-drop','stale','unknown','waiting'].includes(fault))throw new Error('Invalid fault');
if((fault==='unknown'&&selectedTasks.some(t=>t!=='todo'))||(['late-drop','waiting'].includes(fault)&&selectedTasks.some(t=>t!=='form')))throw new Error('Fault/task mismatch');
if (!selectedTasks.every(x => tasks.includes(x)) || !selectedSeeds.every(x => seeds.includes(x)) || !groups.every(x => ['A','B'].includes(x)) || !Number.isFinite(seconds) || seconds < 30 || !Number.isInteger(commands) || commands < 1) throw new Error('Invalid experiment arguments');
const out = resolve(arg('out') ?? join(REPO, 'out/gym', new Date().toISOString().replace(/[:.]/g, '-')));
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const model = DEFAULT_TEST_MODEL;
const plan = await loadModelPlan(model);
// The test extension must not race the user's login refresh owner.
if (plan.credential.type === 'oauth') plan.credential.refresh = '';
const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
const version = git('rev-parse', 'HEAD');
const sourceHash = createHash('sha256');
for (const file of (await readdir(join(REPO, 'scripts/gym'))).sort()) sourceHash.update(await readFile(join(REPO, 'scripts/gym', file)));
const dist = process.env.SIDEAGENT_ACCEPTANCE_DIST ?? join(out, 'dist');
if (!process.env.SIDEAGENT_ACCEPTANCE_DIST) execFileSync(process.execPath, [join(REPO, 'extension/build.mjs')], { env: { ...process.env, SIDEAGENT_BUILD_DIST: dist }, stdio: ['ignore','pipe','pipe'] });
process.env.SIDEAGENT_ACCEPTANCE_DIST = dist;
await writeFile(join(out, 'manifest.json'), JSON.stringify({ version, sourceHash: sourceHash.digest('hex'), dirty: git('status','--short'), model, selectedTasks, selectedSeeds, groups, seconds, commands, fault, headed: process.argv.includes('--headed'), parameters: 'Existing BYS defaults; effective efforts recorded per model_request and side_call. No provider switch.', cost: 'ChatGPT subscription; cash cost unknown, tokens measured separately.' }, null, 2));

type RP = Awaited<ReturnType<typeof launchRealPath>>;
type Row = Record<string, any>;
const traceExpression = `new Promise((resolve,reject)=>{const r=indexedDB.open('sideagent-diagnostics');r.onerror=()=>reject(r.error);r.onsuccess=()=>{const db=r.result;if(!db.objectStoreNames.contains('trace-lines')){db.close();resolve([]);return}const tx=db.transaction('trace-lines');const q=tx.objectStore('trace-lines').getAll();q.onsuccess=()=>resolve(q.result.map(x=>JSON.parse(x.line)));tx.oncomplete=()=>db.close()}})`;
const idleExpression = `document.querySelector('#send-btn')?.disabled===false && !document.querySelector('#status-pill')?.classList.contains('running') && !document.querySelector('.msg.assistant.streaming,.msg.assistant[data-revealing]')`;


async function run(task: string, seed: number, group: string) {
  const waitStarted=Date.now();
  while(loadavg()[0]>20 && Date.now()-waitStarted<180_000){
    console.log(`Waiting for load: ${loadavg()[0].toFixed(1)}; no episode started`);
    await sleep(10_000);
  }
  if (loadavg()[0] > 20) throw new Error(`Load ${loadavg()[0].toFixed(1)} exceeds 20 after bounded wait; no episode started`);
  const id = `${task}-${seed}-${group}`;
  const dir = join(out,id); await mkdir(dir);
  const fixture = await startFixture(task, seed, fault);
  let rp: RP | undefined, panel = '', work = '', stopVideo: (() => Promise<string | null>) | undefined;
  let observe: Awaited<ReturnType<typeof installAudit>> | undefined, budget: Awaited<ReturnType<typeof installBudget>> | undefined, finishNetwork: Awaited<ReturnType<typeof networkUsage>> | undefined;
  let trace: Row[] = [], audit: Row[] = [], current: Row | null = null, lastState = '', started = 0;
  const row: Row = { id, task, seed, group, fault, model, version, status: 'unknown', corrections: [], load: loadavg()[0] };
  try {
    rp = await launchRealPath({ headed: process.argv.includes('--headed') });
    work = await rp.attach((await rp.targets()).find(t => t.url === 'about:blank')!.targetId);
    await rp.cdp.send('Page.enable',{},work);
    await rp.cdp.send('Page.navigate',{url:fixture.origin},work);
    await until(async () => await rp!.evaluate(work,"document.readyState==='complete' && !!document.querySelector('main')") || undefined, 10_000,'fixture');
    observe = await installAudit(rp,work);
    panel = await rp.attach(await rp.openSidePanel());
    await rp.evaluate(panel,`chrome.storage.local.set(${JSON.stringify(modelStorageItems(plan))}).then(()=>true)`);
    await until(async () => await rp!.evaluate(panel,"document.querySelector('#status-dot')?.classList.contains('on') && document.querySelector('#send-btn')?.disabled===false") || undefined, 60_000,'sidebar ready');
    finishNetwork = await networkUsage(rp);
    await rp.screenshot(work,join(dir,'before.png'));
    if(!process.argv.includes('--no-video')) stopVideo = await recordScreen(rp.cdp,work,join(dir,'execution.mp4'));
    started = Date.now(); row.startedAt = new Date(started).toISOString();
    budget = await installBudget(rp,started+seconds*1000,commands,fault);
    const say = async (text: string) => { await rp!.click(panel,'#input'); await rp!.typeText(panel,text); await rp!.pressEnter(panel); };
    row.prompt=promptFor(task,fault);
    await say(row.prompt);
    let quietSince = 0, previousTraceCount = 0;
    while (Date.now() < started+seconds*1000) {
      await sleep(500);
      const observed=await observe(); current=observed.state; audit=observed.audit; row.observedAt=observed.at;
      const serialized = JSON.stringify(current);
      if (serialized !== lastState) { await appendFile(join(dir,'states.jsonl'),JSON.stringify({at:Date.now(),state:current})+'\n'); lastState=serialized; }
      trace = await rp.evaluate(panel,traceExpression);
      const busy = !await rp.evaluate(panel,idleExpression);
      // Let the existing asynchronous goal checker finish; never substitute an early oracle stop for A.
      const meaningful = trace.filter(e => !['stage_start','stage_end'].includes(e.type)).length;
      if (busy || meaningful !== previousTraceCount) quietSince=0;
      previousTraceCount=meaningful;
      if (!busy && trace.some(e=>e.type==='agent_end')) quietSince ||= Date.now();
      if (!quietSince || Date.now()-quietSince < 22_000) continue;
      const verdict = evaluate(task,current,fixture.effects,audit);
      row.checkpoints ??= []; row.checkpoints.push({at:Date.now(),verdict,state:current});
      if (group==='A' || verdict.status==='success' || row.corrections.length>=2 || verdict.errors.includes('UNEXPECTED_SUBMISSION')) break;
      const waiting = trace.findLast(e=>e.type==='goal_check')?.data?.status === 'needs_user' || await rp.evaluate(panel, `!!document.querySelector('.send-confirm,#takeover-btn[data-mode="handback"]')`);
      if (waiting) { row.stopped='needs_user'; break; }
      const text = feedback(verdict);
      row.corrections.push({at:Date.now(),text}); await say(text); quietSince=0;
    }
    // End the scoring window before screenshots/video encoding or persistence probes.
    row.elapsedMs=Date.now()-started;
    row.stopped ??= row.elapsedMs>=seconds*1000 ? 'time_budget' : 'settled';
    await rp.cdp.send('Emulation.setScriptExecutionDisabled',{value:true},work);
    row.network=await finishNetwork(); finishNetwork=undefined;
    const agentTarget=(await rp.targets()).find(t=>t.url===`chrome-extension://${rp!.extensionId}/inproc.html`);
    if(agentTarget)await rp.cdp.send('Target.closeTarget',{targetId:agentTarget.targetId});
    row.finalState=current;
    row.answers=trace.filter(e=>e.type==='message_end' && e.data.message?.role==='assistant').map(e=>({at:e.time,text:(e.data.message.content??[]).filter((p:Row)=>p.type==='text').map((p:Row)=>p.text).join('\n')})).filter(e=>e.text.trim());
    row.answer=row.answers.at(-1)?.text??'';
    await rp.screenshot(work,join(dir,'after.png')); await rp.screenshot(panel,join(dir,'sidebar.png'));
    row.video=await stopVideo?.()??null; stopVideo=undefined;
    if(task==='todo') {
      await rp.cdp.send('Emulation.setScriptExecutionDisabled',{value:false},work);
      await rp.cdp.send('Page.reload',{},work);
      await sleep(1200);
      row.refreshed=(await (await installAudit(rp,work))()).state;
    }
    row.verdict=evaluate(task,current,fixture.effects,audit,row.refreshed);
    row.status=row.stopped==='time_budget' ? 'unknown' : row.verdict.status;

  } catch(error) { process.exitCode=1; row.error=error instanceof Error?error.stack:String(error); row.finalState=current; }
  finally {
    if(rp){
      if(row.error){
        if(work) await rp.cdp.send('Emulation.setScriptExecutionDisabled',{value:true},work).catch(()=>{});
        row.network ??= await finishNetwork?.().catch(()=>[]); finishNetwork=undefined;
        const agent=(await rp.targets().catch(()=>[])).find(t=>t.url===`chrome-extension://${rp!.extensionId}/inproc.html`);
        if(agent) await rp.cdp.send('Target.closeTarget',{targetId:agent.targetId}).catch(()=>{});
      }
      row.video ??= await stopVideo?.().catch(()=>null);
      row.network ??= await finishNetwork?.().catch(()=>[]);
      row.budget=await budget?.read().catch(()=>null);
      if(panel) trace=await rp.evaluate(panel,traceExpression).catch(()=>trace);
      row.effects=fixture.effects; row.perturbations=fixture.events;
      row.claim=claimFrom(row.answer??'');
      row.falseSuccess=row.claim==='success'&&row.status==='failure';
      row.falseFailure=row.claim==='failure'&&row.status==='success';
      row.tools=trace.filter(e=>e.type==='tool_execution_end').map(e=>({name:e.data.toolName,error:e.data.isError,result:e.data.result}));
      row.toolReportedErrors=row.tools.filter((e:Row)=>e.error).length;
      row.mainModelCalls=trace.filter(e=>e.type==='model_request').length;
      row.sideModelCalls=trace.filter(e=>e.type==='side_call').reduce((n,e)=>n+(e.data.attempts??0),0);
      row.mainUsage=trace.filter(e=>e.type==='turn_end').map(e=>e.data.usage);
      row.traceComplete=trace.some(e=>e.type==='run_start') && trace.some(e=>e.type==='agent_end') && row.stopped==='settled' && !trace.some(e=>e.truncated||e.droppedEvents||e.type==='trace_limit');
      row.usageComplete=Array.isArray(row.network) && row.network.length>=row.mainModelCalls+row.sideModelCalls && row.network.every((r:Row)=>r.usage);
      row.agentElapsedMs=Math.max(0,...trace.filter(e=>e.type==='agent_end').map(e=>Date.parse(e.time)-started));
      row.cashCost=null;
      await writeFile(join(dir,'trace.jsonl'),trace.map(e=>JSON.stringify(e)).join('\n')+'\n');
      await writeFile(join(dir,'browser-events.json'),JSON.stringify(audit,null,2));
      await rp.close(); await rp.remove();
    }
    await fixture.close();
    await writeFile(join(dir,'result.json'),JSON.stringify(row,null,2));
    await appendFile(join(out,'results.jsonl'),JSON.stringify(row)+'\n');
    console.log(JSON.stringify({id,status:row.status,claim:row.claim,elapsedMs:row.elapsedMs,corrections:row.corrections.length,error:row.error,dir}));
  }
}
console.log(`BYS-Gym output: ${out}`);
for(const [taskIndex,task] of selectedTasks.entries()) for(const [index,seed] of selectedSeeds.entries()) for(const group of (index+taskIndex)%2 ? [...groups].reverse() : groups) await run(task,seed,group);
console.log('All episodes recorded.');
