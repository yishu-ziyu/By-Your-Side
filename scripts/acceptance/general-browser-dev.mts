// Development integration only. This task is exposed to the implementer and is NOT a holdout.
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {WRITE_TOOLS} from '../../shared/control.js';

const PAGE_MUTATIONS=new Set<string>(WRITE_TOOLS.filter(n=>!['worker_tabs','mark','clear_marks'].includes(n)));

if(!process.argv.includes('--headless'))throw new Error('--headless required');

const root=resolve('out/acceptance/20260920-general-browser'),out=join(root,`dev-${Date.now()}`);

await mkdir(out,{recursive:true});

process.env.SIDEAGENT_TRACE_DIR=join(out,'traces');

process.env.SIDEAGENT_GENERAL_BROWSER_LOOP='1';

process.env.EGO_ACCEPTANCE_CHROME=resolve('out/experiments/realtime3-browser/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');

const {startHost,startIsolatedPanel,stopHost}=await import('./product-journeys/runner.mjs');

const {loadConfig}=await import('../../agent/src/config.js');

const events:any[]=[];

let host:any,iso:any,panel:string|undefined;

const report:any={passed:false,kind:'development-not-holdout',headless:true,checks:[]};

const save=()=>writeFile(join(out,'result.json'),JSON.stringify({...report,events},null,2));

const timer=setTimeout(()=>{report.error='150s hard timeout';void save().finally(()=>process.exit(2));},150000);

const wait=async(fn:()=>any,label:string,ms=110000)=>{const end=Date.now()+ms;

while(Date.now()<end){const r=await fn();

if(r)return r;await new Promise(r=>setTimeout(r,100));}

throw Error(label+' timeout');};

try{
 host=await startHost(loadConfig().model??'',join(out,'store'),events);
 const scope=process.argv.includes('--scope');
 const html=scope?'<!doctype html><meta charset="utf-8"><title>Scoped controls development</title><form aria-label="Main settings"><label>级别<select id="tier"><option value="copper">Copper</option><option value="silver">Silver</option><option value="gold">Gold</option></select></label><label>锁定值<input id="locked" readonly value="unchanged"></label><button type="button" id="save" onclick="window.__saved=true">保存</button></form><section role="region" aria-label="Other panel"><button id="tick">Counter 0</button></section><article>'+Array.from({length:240},(_,i)=>`<p>Background paragraph ${i} ${'unrelated explanatory text '.repeat(15)}</p>`).join('')+'</article>':'<!doctype html><meta charset="utf-8"><title>Control contract development</title><main><h1>项目筛选</h1><label>代号<input id="code" autocomplete="off"></label><label><input id="only" type="checkbox">只看可用项目</label><button id="save" onclick="window.__saved=true">保存</button><p id="tick"></p></main>';
 ({iso,panel}=await startIsolatedPanel(host,{fixtureHtml:html}));
 const target=await iso.newTarget(iso.fixtureOrigin);await iso.evalIn(target,`setInterval(()=>document.querySelector('#tick').textContent='时间 '+Date.now(),30)`);
 const input=scope?'把级别改成 Gold，不要改锁定值，不要点保存。':'把代号填为 nebula-42，勾选“只看可用项目”。不要点击保存，也不要提交。';
 report.scenario=scope?'separate-changing-region-and-long-prose':'on-demand-field-material';
 await iso.evalIn(panel,`(()=>{const i=document.querySelector('#input');i.value=${JSON.stringify(input)};i.dispatchEvent(new Event('input',{bubbles:true}));i.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);

 if(process.argv.includes('--stop')){
  await wait(()=>events.some(e=>e.message.type==='tool_call'&&e.message.name==='snapshot'&&e.message.params?.decision===true),'initial loop observation');
  const before=host.manager.getTaskProgress('default');
  const receipt=await host.manager.dispatchTaskAction({requestId:`stop-${Date.now()}`,conversationId:'default',source:'text',action:'abort',expectedRunId:before.runId,expectedControlVersion:before.controlVersion,text:'取消测试任务'});
  const cutoff=Date.now();await wait(()=>!host.manager.get('default').runtime.session.isStreaming(),'loop drained',12000);
  const first=await iso.evalIn(target,`({value:document.querySelector('#code')?.value,checked:document.querySelector('#only')?.checked,saved:window.__saved===true})`);
  await new Promise(r=>setTimeout(r,1200));
  const later=await iso.evalIn(target,`({value:document.querySelector('#code')?.value,checked:document.querySelector('#only')?.checked,saved:window.__saved===true})`);
  report.checks=[{name:'abort-receipt',passed:['accepted','applied'].includes(receipt.status),receipt},{name:'no-post-cancel-writes',passed:!events.some(e=>e.at>cutoff&&e.message.type==='tool_call'&&PAGE_MUTATIONS.has(e.message.name))},{name:'page-stable-after-drain',passed:JSON.stringify(first)===JSON.stringify(later),first,later},{name:'no-false-completion',passed:!events.some(e=>e.message.event?.kind==='user_delivery'&&e.message.event.delivery.facts?.outcome==='complete')}];
  report.passed=report.checks.every((c:any)=>c.passed);
 }else{
 const delivery=await wait(()=>events.find(e=>e.message.type==='agent_event'&&e.message.event.kind==='user_delivery'&&['finding','reply'].includes(e.message.event.delivery.kind)),'verified task delivery');
 const result=await iso.evalIn(target,scope?`({tier:document.querySelector('#tier').value,locked:document.querySelector('#locked').value,saved:window.__saved===true})`:`({value:document.querySelector('#code').value,checked:document.querySelector('#only').checked,saved:window.__saved===true})`);
 const loopStarts=events.filter(e=>e.message.event?.kind==='tool_start'&&e.message.event.name==='browser_loop');
 const decisions=events.filter(e=>e.message.type==='tool_call'&&e.message.params?.decisionGuard);
 const writes=events.filter(e=>e.message.type==='tool_call'&&PAGE_MUTATIONS.has(e.message.name));
 const directId=loopStarts[0]?.message.event.toolCallId;
 report.checks=[{name:'natural-entry-host-starts-loop',passed:typeof directId==='string'&&directId.startsWith('display-')},
  {name:'all-required-writes-owned-by-initial-loop',passed:writes.length>=(scope?1:2)&&writes.every(e=>e.message.programId===directId)},
{name:'actual-loop-tool-used',passed:loopStarts.length>0},{name:'guarded-actions-used',passed:decisions.length>0},{name:'independent-page-readback',passed:(scope?result.tier==='gold'&&result.locked==='unchanged':result.value==='nebula-42'&&result.checked)&&!result.saved,result},{name:'delivered',passed:true,delivery:delivery.message.event.delivery}];
 report.passed=report.checks.every((c:any)=>c.passed);
 }
}catch(e){report.error=String(e);}finally{
 clearTimeout(timer);await iso?.close().catch(()=>{});

if(host)await stopHost(host).catch(()=>{});await save();console.log(JSON.stringify({out,...report},null,2));

if(!report.passed)process.exitCode=1;
}
