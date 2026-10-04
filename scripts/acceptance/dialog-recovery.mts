import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import type {Json, JsonRecord} from './real-path/harness.mts';
import type {IsolatedExtension} from './isolated-extension.mts';

if (!process.argv.includes('--headless')) throw new Error('Required --headless');

const repo = resolve(import.meta.dirname, '../..');

const out = join(repo, 'out/dialog-recovery', new Date().toISOString().replace(/[:.]/g, '-'));

const suiteVersion = 'dialog-recovery-7-case-v4';

const expectedCases = 7;

const quietWindowMs = 1000;

const quietWindow = () => new Promise(resolve=>setTimeout(resolve,quietWindowMs));

const dailyDist = join(repo, 'extension/dist');

const fingerprint = async (dir:string):Promise<string> => {
  const hash = createHash('sha256');

  const walk = async (path:string) => {
    for (const entry of (await readdir(path,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      const child = join(path,entry.name); hash.update(child.slice(dir.length));

      if (entry.isDirectory()) await walk(child); else hash.update(await readFile(child));
    }
  };

  try {await walk(dir);} catch(error) {if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'ABSENT'; throw error;}

  return hash.digest('hex');
};

const dailyBefore = await fingerprint(dailyDist);

let buildRoot = '';

let until: typeof import('./isolated-extension.mts').until;

await mkdir(out, {recursive: true});

// Server counts are independent of extension tool success and survive a blocked page.
const events: Record<string, number> = {};

const fixtureHtml = `<!doctype html><meta charset="utf-8"><title>Dialog recovery fixture</title>
<button id="confirm" type="button" onclick="run('confirm')">Confirm fixture</button>
<button id="prompt" type="button" onclick="run('prompt')">Prompt fixture</button>
<button id="double" type="button" ondblclick="run('double')">Double fixture</button>
<button id="mousedowndialog" type="button" onmousedown="runMouseBoundary()" onclick="mouseState.clicks++;reportEvent('mouse-click')">Mouse boundary</button>
<button id="chain" type="button" onclick="runChain()">Chain fixture</button>
<input id="after" aria-label="After dialog" value="before"><output id="result">untouched</output>
<script>
const state = {opened:0, completed:0, inputs:0, last:null};
function reportEvent(name) {fetch('/event?name='+encodeURIComponent(name),{method:'POST'});}
function run(kind) {
  state.opened++; reportEvent(kind+'-opened');
  const answer = kind==='prompt'||kind==='key' ? prompt(kind+' fixture', 'default value') : confirm(kind+' fixture');
  state.completed++; state.last={kind,answer};
  document.querySelector('#result').textContent=JSON.stringify(state.last);
  reportEvent(kind+'-completed');
}
document.addEventListener('keydown', e=>{if(e.key==='ArrowDown'){e.preventDefault();run('key');}});
document.addEventListener('keyup',e=>{if(e.key==='ArrowDown')reportEvent('key-keyup');if(e.key==='a')reportEvent('letter-keyup');});
const mouseState={opened:0,completed:0,clicks:0,answer:null};
const chainState={opened:0,completed:0,answerA:null,answerB:null};
window.boundaryState={mouse:mouseState,chain:chainState};
function runMouseBoundary(){
  mouseState.opened++;reportEvent('mouse-opened');
  mouseState.answer=confirm('mousedown fixture');
  mouseState.completed++;reportEvent('mouse-completed');
}
function runChain(){
  chainState.opened++;reportEvent('chain-opened');
  chainState.answerA=confirm('chain A fixture');
  reportEvent('chain-A-completed');reportEvent('chain-B-opened');
  chainState.answerB=prompt('chain B fixture','chain default');
  chainState.completed++;reportEvent('chain-completed');
}
document.querySelector('#after').addEventListener('input',()=>{state.inputs++;reportEvent('input');});
window.fixtureState=state;
</script>`;

const calls: JsonRecord[] = [], evidence: JsonRecord[] = [];


let iso: IsolatedExtension | undefined, page = '', panel = '', tabId = 0;

let currentCase = 'startup', currentCall: JsonRecord = {}, seq = 0;

let failure: Error | undefined;

const save = (name: string, value: Json) => writeFile(`${out}/${name}.json`, JSON.stringify(value, null, 2)+'\n');

const safe = async (fn: () => Promise<Json | void>) => {try {return (await fn()) ?? null;} catch(error) {return {error:String(error)};}};

const record = (value: Json): JsonRecord => {
  assert.equal(Object.prototype.toString.call(value), '[object Object]', 'expected JSON object');

  // SAFETY: the assertion above excludes null, arrays and scalar JSON values.
  return value as JsonRecord;
};

const swJson = async(expression:string, timeout=3000):Promise<Json> => JSON.parse(JSON.stringify(await iso!.swEval(expression,timeout)));

const pageJson = async(target:string, expression:string, timeout=3000):Promise<Json> => JSON.parse(JSON.stringify(await iso!.evalIn(target,expression,timeout)));

const data = (result:JsonRecord) => record(result.data);

try {
  buildRoot = await mkdtemp(join(tmpdir(),'bys-dialog-build-'));
  const build = spawnSync(process.execPath,['build.mjs'],{cwd:join(repo,'extension'),env:{...process.env,SIDEAGENT_BUILD_DIST:join(buildRoot,'extension/dist')},encoding:'utf8',timeout:120000});
  await writeFile(join(out,'build.log'),(build.stdout??'')+(build.stderr??'')+String(build.error??''));
  assert.equal(build.status,0,'isolated current-source build failed; see build.log');
  const previousCwd = process.cwd();
  let runtime: typeof import('./isolated-extension.mts');

  try {process.chdir(buildRoot); runtime = await import('./isolated-extension.mts');}
  finally {process.chdir(previousCwd);}

  until = runtime.until;
  iso = await runtime.launchIsolatedExtension({localOnly:true, fixtureHtml, fixture:(req,res)=>{
    if (!req.url?.startsWith('/event?')) return false;
    const name = new URL(req.url, 'http://fixture').searchParams.get('name')!;
    events[name] = (events[name] ?? 0)+1;
    res.end('ok');

 return true;
  }});
  const extensionId = await iso.swEval('chrome.runtime.id');
  page = await iso.newTarget(iso.fixtureOrigin);
  panel = await iso.newTarget(`chrome-extension://${extensionId}/sidepanel.html`);
  await iso.swEval('globalThis.__saSetSecurityHost({id:"default",title:"Dialog fixture",createdAt:1,updatedAt:1,state:"running",mode:"act",runId:"dialog-run"})');
  await until(async()=>{
    const state = record(await swJson('globalThis.__saSecurityProbe()'));

    return Number(state.panels)>0 && Array.isArray(state.summaries) && state.summaries.some(c=>record(c).id==='default'&&record(c).runId==='dialog-run') ? true : undefined;
  },8000,'trusted real sidepanel attached');
  const fixtureTabId = await iso.swEval(`(async()=> (await chrome.tabs.query({url:${JSON.stringify(iso.fixtureOrigin+'/*')}}))[0].id)()`);

  tabId = Number(fixtureTabId);
  assert.ok(Number.isSafeInteger(tabId) && tabId > 0);
  assert.equal(fixtureTabId,tabId,'tab id must be a numeric Chrome tab id');

  const start = async (name:string, params:JsonRecord) => {
    currentCall = {startedAt:Date.now(),case:currentCase,id:`dialog-${++seq}`,name,params}; calls.push(currentCall);
    await iso!.swEval(`globalThis.__dialogSettled=null;globalThis.__dialogReturnedAt=null;void globalThis.__saCall(${JSON.stringify(currentCall.id)},${JSON.stringify(name)},${JSON.stringify(params)},"acpt",undefined,"default",{runId:"dialog-run"}).then(r=>{globalThis.__dialogReturnedAt=Date.now();globalThis.__dialogSettled=r;},e=>{globalThis.__dialogReturnedAt=Date.now();globalThis.__dialogSettled={error:String(e)};});true`,3000);
  };

  const settled = async (limit=15000) => {
    const result = await until(async()=> (await swJson('globalThis.__dialogSettled',2000)) || undefined,limit,'tool result before dialog timeout');
    currentCall.result = result;
    currentCall.returnedAt = await swJson('globalThis.__dialogReturnedAt',2000);

 return record(result);
  };

  const call = async (name:string, params:JsonRecord, followDialog = false):Promise<JsonRecord> => {
    await start(name,params);
    const before = Date.now();
    const result = await settled();

    if (followDialog) {
      currentCall.elapsedMs = Date.now()-before;
      assert.ok(Number(currentCall.elapsedMs)<15000,'call must return within bounded total budget');
      const triggerCall = currentCall;

      if (result.ok && ['click','double_click','press_key'].includes(name) && data(result).dialog) {
        const dialog = record(data(result).dialog);
        const buffered = await call('consume_events',{tabId,clear:false});
        assert.equal(buffered.ok,true);
        const nativeEvents = data(buffered).events;
        assert.ok(Array.isArray(nativeEvents),'consume_events must return event array');
        const matches = nativeEvents.map(record).filter(event=>event.kind === 'dialog' && Number(event.at)>=Number(triggerCall.startedAt) && record(event.payload).type === dialog.type && record(event.payload).message === dialog.message).sort((a,b)=>Number(a.at)-Number(b.at));
        assert.ok(matches.length>0,'must find this call native dialog opening event');
        const latest = matches[matches.length-1];
        const delay = Number(triggerCall.returnedAt)-Number(latest.at);
        triggerCall.nativeDialogEvent = latest; triggerCall.dialogReturnDelayMs = delay;
        assert.ok(delay>=0 && delay<1000,'tool receipt must follow actual native dialog opening within 1000ms');
        currentCall = triggerCall;
      }

    }

    return result;
  };

  const dialogStatus = async()=> {
    const result = await call('dialog_info',{tabId});
    assert.equal(result.ok,true);

 return result;
  };

  const readPage = async()=>record(await pageJson(page,'({state:window.fixtureState,value:document.querySelector("#after").value,result:document.querySelector("#result").textContent})',3000));

  const recover = async(kind:string, accept:boolean, text?:string)=>{
    const params: JsonRecord = {tabId};

    if (text !== undefined) params.promptText = text;
    const handled = await call(accept?'accept_dialog':'dismiss_dialog',params,true);
    assert.equal(handled.ok,true); assert.equal(data(handled)[accept?'accepted':'dismissed'],true);
    const closed = await dialogStatus(); assert.equal(data(closed).dialog,null);
    await until(()=>events[`${kind}-completed`]===1?true:undefined,4000,'exactly one page completion');
    const before = await readPage();
    assert.deepEqual(record(before.state).last,{kind,answer:accept ? text ?? true : false});
    const value = `recovered-${kind}`;
    const filled = await call('fill',{tabId,target:'#after',value},true);
    assert.equal(filled.ok,true);
    await until(()=>events.input===evidence.filter(e=>e.recovered).length+1?true:undefined,4000,'one fill input event');
    const after = await readPage(); assert.equal(after.value,value);
    assert.equal(events[`${kind}-opened`],1); assert.equal(events[`${kind}-completed`],1);

    return {handled,closed,page:after,events:{...events},recovered:true};
  };

  // These triggers use real input events, not injected JavaScript dialog calls.
  for (const scenario of [
    {kind:'confirm',tool:'click',target:'#confirm',accept:false},
    {kind:'prompt',tool:'click',target:'#prompt',accept:true,text:'exact prompt value'},
    {kind:'double',tool:'double_click',target:'#double',accept:false},
    {kind:'key',tool:'press_key',key:'ArrowDown',accept:true,text:'exact keyboard value'},
  ]) {
    currentCase = `${scenario.tool}-${scenario.kind}-recover`;

    if (scenario.key) {
      assert.equal(await pageJson(page, 'document.activeElement?.id'), 'after', 'previous recovery fill must retain focus');
    }

    const trigger = await call(scenario.tool,{tabId,...(scenario.target?{target:scenario.target}:{key:scenario.key})},true);
    assert.equal(trigger.ok,true);
    assert.equal(record(data(trigger).dialog).type,scenario.accept?'prompt':'confirm');
    assert.equal(record(data(trigger).dialog).message,`${scenario.kind} fixture`);
    const status = await dialogStatus();
    assert.equal(record(data(status).dialog).type,scenario.accept?'prompt':'confirm');
    assert.equal(record(data(status).dialog).message,`${scenario.kind} fixture`);
    assert.equal(record(data(status).dialog).tabId,tabId);

    if (scenario.accept) assert.equal(record(data(status).dialog).defaultPrompt,'default value');
    await until(()=>events[`${scenario.kind}-opened`]===1?true:undefined,4000,'one actual input trigger');
    assert.equal(events[`${scenario.kind}-completed`]??0,0,'page remains waiting until the dialog is handled');

    if (scenario.kind==='confirm') {
      currentCase = `${scenario.tool}-${scenario.kind}-recover`;
    }

    const recovered = await recover(scenario.kind,scenario.accept,scenario.text);

    if (scenario.kind === 'key') {
      await quietWindow();
      assert.equal(events['key-keyup'] ?? 0,0,'modal-interrupted keydown must not release after dialog handling');
      recovered.events = {...events};
    }

    evidence.push({case:currentCase,trigger,dialog_status:status,...recovered});
  }

  assert.equal(evidence.length,4,'four recovery paths remain distinct');
  const originalState = (await readPage()).state;

  const boundaryFill = async(value:string) => {
    const previousInputs = events.input;
    const filled = await call('fill',{tabId,target:'#after',value},true);
    assert.equal(filled.ok,true);
    await until(()=>events.input === previousInputs+1 ? true : undefined,4000,'one boundary recovery fill event');
    assert.equal((await readPage()).value,value);
    assert.deepEqual(record((await readPage()).state).last,record(originalState).last);

    return filled;
  };

  currentCase = 'double-click-mousedown-interruption';
  const mouseTrigger = await call('double_click',{tabId,target:'#mousedowndialog'},true);
  assert.equal(mouseTrigger.ok,true);
  assert.equal(data(mouseTrigger).doubleClicked,false,'mousedown alone is not a completed double click');
  assert.equal(record(data(mouseTrigger).dialog).message,'mousedown fixture');
  const mouseOpen = await dialogStatus();
  assert.equal(record(data(mouseOpen).dialog).type,'confirm');
  assert.equal(record(data(mouseOpen).dialog).message,'mousedown fixture');
  const mouseHandled = await call('dismiss_dialog',{tabId},true);
  assert.equal(mouseHandled.ok,true); assert.equal(data(mouseHandled).dismissed,true);
  assert.equal(data(await dialogStatus()).dialog,null);
  await until(()=>events['mouse-completed'] === 1 ? true : undefined,4000,'one interrupted mouse completion');
  const mouseFill = await boundaryFill('recovered-mousedown');
  await quietWindow();
  assert.equal(events['mouse-opened'],1,'must not send a second mousedown after dialog handling');
  assert.equal(events['mouse-click'] ?? 0,0,'must not release a delayed click after dialog handling');
  const mousePage = await pageJson(page,'window.boundaryState.mouse');
  assert.deepEqual(mousePage,{opened:1,completed:1,clicks:0,answer:false});
  evidence.push({case:currentCase,trigger:mouseTrigger,dialog_status:mouseOpen,handled:mouseHandled,fill:mouseFill,page:mousePage,quietWindowMs,events:{...events}});

  currentCase = 'chain-dialog-preserves-next-pending';
  const chainTrigger = await call('click',{tabId,target:'#chain'},true);
  assert.equal(chainTrigger.ok,true);
  assert.equal(record(data(chainTrigger).dialog).message,'chain A fixture');
  const statusA = await dialogStatus(); assert.equal(record(data(statusA).dialog).message,'chain A fixture');
  const handledA = await call('accept_dialog',{tabId},true);
  assert.equal(handledA.ok,true); assert.equal(data(handledA).accepted,true);

  const statusB = await until(async()=> {
    const status = await dialogStatus();

    return data(status).dialog !== null && record(data(status).dialog).message === 'chain B fixture' ? status : undefined;
  },4000,'new pending prompt survives previous dialog cleanup');

  assert.equal(record(data(statusB).dialog).type,'prompt');
  assert.equal(record(data(statusB).dialog).defaultPrompt,'chain default');
  await until(()=>events['chain-B-opened'] === 1 ? true : undefined,4000,'chain reaches second actual dialog');
  assert.equal(events['chain-completed'] ?? 0,0,'handling A does not complete B');
  const handledB = await call('accept_dialog',{tabId,promptText:'exact chain value'},true);
  assert.equal(handledB.ok,true); assert.equal(data(handledB).accepted,true);
  assert.equal(data(await dialogStatus()).dialog,null);
  await until(()=>events['chain-completed'] === 1 ? true : undefined,4000,'one full chain completion');
  const chainFill = await boundaryFill('recovered-chain');
  const chainPage = await pageJson(page,'window.boundaryState.chain');
  assert.deepEqual(chainPage,{opened:1,completed:1,answerA:true,answerB:'exact chain value'});
  assert.equal(events['chain-opened'],1); assert.equal(events['chain-A-completed'],1); assert.equal(events['chain-B-opened'],1);
  evidence.push({case:currentCase,trigger:chainTrigger,dialogA:statusA,dialogB:statusB,handledA,handledB,fill:chainFill,page:chainPage,events:{...events}});

  currentCase = 'ordinary-letter-key-releases';
  const previousInputs = events.input;
  const seeded = await call('fill',{tabId,target:'#after',value:''},true);
  assert.equal(seeded.ok,true);
  await until(()=>events.input === previousInputs+1 ? true : undefined,4000,'seed fill emits once');
  assert.equal((await readPage()).value,'');
  assert.equal(await pageJson(page,'document.activeElement?.id'),'after');
  const typed = await call('press_key',{tabId,key:'a'},true);
  assert.equal(typed.ok,true); assert.equal(data(typed).pressed,true);
  await until(()=>events['letter-keyup'] === 1 && events.input === previousInputs+2 ? true : undefined,4000,'ordinary key produces input and keyup');
  await quietWindow();
  assert.equal(events['letter-keyup'],1); assert.equal(events['key-keyup'] ?? 0,0);
  const letterPage = await readPage(); assert.equal(letterPage.value,'a');
  assert.equal(data(await dialogStatus()).dialog,null);
  // The shared launcher hook has no heldInputs probe; do not infer the ledger from page keyup.
  const heldKeys = {status:'NOT_RUN',reason:'shared acceptance hook does not expose heldInputs; page keyup is checked separately'};
  evidence.push({case:currentCase,seeded,typed,page:letterPage,heldKeys,quietWindowMs,events:{...events}});

  assert.deepEqual((await readPage()).state,{...record(originalState),inputs:Number(record(originalState).inputs)+4},'boundary fixtures must not change the original dialog oracle');
  assert.equal(evidence.length,expectedCases);
  await iso.screenshot(panel,`${out}/sidebar.png`);
} catch(error) {
  failure = error instanceof Error ? error : new Error(String(error));
  await save('failure',{suiteVersion,expectedCases,status:'FAIL',case:currentCase,error:String(error),currentCall,calls,evidence,events,
    tool:iso?await safe(()=>swJson('globalThis.__dialogSettled',2000)):null,
    background:iso?await safe(()=>swJson('globalThis.__saSecurityProbe()',2000)):null,
    dialog_status:iso&&tabId!=null?await safe(async()=>JSON.parse(JSON.stringify(await iso!.tool('dialog_info',{tabId})))):null,
    page:iso&&page?await safe(()=>pageJson(page,'({url:location.href,state:window.fixtureState,boundaryState:window.boundaryState,value:document.querySelector("#after")?.value,result:document.querySelector("#result")?.textContent})',2000)):null,
    panel:iso&&panel?await safe(()=>pageJson(panel,'document.body.innerText',2000)):null});

  if (iso&&panel) await safe(()=>iso!.screenshot(panel,`${out}/failure.png`));
} finally {
  if (iso) {
    const cleanup = await iso.close(); await save('cleanup',cleanup);

    if (cleanup.status!=='PASS'&&!failure) failure = new Error('Isolation cleanup failed');
  }

  const dailyAfter = await fingerprint(dailyDist);
  await save('daily-dist',{before:dailyBefore,after:dailyAfter,unchanged:dailyBefore===dailyAfter});

  if (dailyBefore!==dailyAfter&&!failure) failure = new Error('Daily extension/dist changed during acceptance');

  if (buildRoot) await rm(buildRoot,{recursive:true,force:true});
  await save('result',{suiteVersion,expectedCases,status:failure?'FAIL':'PASS',scope:'current-source isolated Chrome extension RPC + real sidepanel; not model/SDK end-to-end',error:failure?String(failure):undefined,evidence,calls,events,dailyDistUnchanged:dailyBefore===dailyAfter});
}

if (failure) throw failure;
