/** P0: production modules + extension; synthetic native PCM, not microphone/UI acceptance. */
import {createServer, type ServerResponse} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {StepVoiceSession} from '../../agent/src/voice-session.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker,connectBrowser,findServiceWorker} from './cdp.mjs';
import {discoverChromeMain} from './discover.mjs';
import {sideagentExtensionId} from './constants.mjs';
import {judgeBudgetRun} from './voice-steer-oracle.mjs';
const out=`/tmp/ego-voice-p0-${new Date().toISOString().replace(/[:.]/g,'-')}`;
await mkdir(out,{recursive:true});
const write=(name:string,data:unknown)=>writeFile(`${out}/${name}.json`,JSON.stringify(data,null,2));
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(test:()=>boolean,ms:number,label:string){const end=Date.now()+ms;while(!test()){if(Date.now()>end)throw Error(label);await sleep(100);}}
const instruction='预算改成八百，只看八百元以内的书桌，再按价格从低到高排序。';
const report:any={at:new Date().toISOString(),status:'blocked',source:'production modules in harness; extension tools; synthetic PCM, not sidepanel UI',results:[]};
let connection:Awaited<ReturnType<typeof connectParentAcceptance>>|undefined;let pcm:Buffer;
try{
 report.commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 report.workingTree=execFileSync('git',['status','--short'],{encoding:'utf8'}).trim();
 const {cdp,version}=await connectBrowser(discoverChromeMain().port);
 try{
  const sw=findServiceWorker((await cdp.send('Target.getTargets')).targetInfos,sideagentExtensionId());if(!sw)throw Error('Extension worker missing');
  const sid=await cdp.attachSession(sw.targetId);
  report.environment=await evaluateInWorker(cdp,sid,'Promise.all([chrome.windows.getAll().then(ws=>ws.length),Promise.resolve(chrome.runtime.getManifest().version),fetch(chrome.runtime.getURL("background.js")).then(r=>r.text())]).then(([windows,extensionVersion,source])=>({windows,extensionVersion,source}))');
  report.environment.browser=version.Browser;
  report.environment.backgroundSha256=createHash('sha256').update(report.environment.source).digest('hex');delete report.environment.source;
  if(!report.environment.windows)throw Error('ChromeMain has no window');
 }finally{await cdp.close();}
 await readStepVoiceKey();
 execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',out+'/input.aiff',instruction]);
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',out+'/input.aiff','-ar','24000','-ac','1','-f','s16le',out+'/input.pcm']);
 pcm=await readFile(out+'/input.pcm');report.audio={text:instruction,source:'Tingting',rate:24000,bytes:pcm.length,sha256:createHash('sha256').update(pcm).digest('hex')};
 connection=await connectParentAcceptance();report.status='running';await write('report',report);
 for(const mode of ['text','voice'] as const)report.results.push(await run(mode));
 report.status=report.results.some((r:any)=>r.status==='blocked')?'blocked':report.results.every((r:any)=>r.ok)?'passed':'failed';
}catch(error){report.error=String(error);if(report.status==='running')report.status='failed';}
finally{await connection?.close();await write('report',report);console.log(JSON.stringify({status:report.status,out,results:report.results.map((r:any)=>({mode:r.mode,ok:r.ok,error:r.error,checks:r.checks})),error:report.error}));if(report.status!=='passed')process.exitCode=1;}
async function run(mode:'text'|'voice'){
 const evidence:any={mode,model:'minimax-cn/MiniMax-M3',events:[],voiceEvents:[],diagnostics:[],applications:[],ok:false};
 let gate:ServerResponse|undefined;let released=false;
 const release=()=>{released=true;if(gate&&!gate.writableEnded)gate.end('continue');};
 const server=createServer((req,res)=>{
  if(req.url==='/gate'){gate=res;if(released)res.end('continue');return;}
  if(req.url?.startsWith('/applied?')){evidence.applications.push({at:Date.now(),...JSON.parse(decodeURIComponent(req.url.slice(9)))});res.end('ok');return;}
  res.setHeader('Content-Type','text/html; charset=utf-8');
  res.end(`<!doctype html><title>P0 ${mode} budget</title><h1>书桌筛选</h1><label>最高预算<input id="budget" aria-label="最高预算" value="1000"></label><label>排序<select id="sort" aria-label="排序"><option value="original">原始顺序</option><option value="asc">价格从低到高</option></select></label><button id="apply">筛选</button><ol id="result"></ol><script>document.querySelector('#apply').onclick=()=>{let prices=[899,699,1099,799].filter(n=>n<=Number(budget.value));if(sort.value==='asc')prices.sort((a,b)=>a-b);result.innerHTML=prices.map(n=>'<li>'+n+'</li>').join('');fetch('/applied?'+encodeURIComponent(JSON.stringify({budget:Number(budget.value),sort:sort.value,prices})));};</script>`);
 });
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 const created=new Set<number>();const jobs=new Set<Promise<void>>();let cid='';let ready=false,done=false;
 const manager=new ConversationManager((id,emit)=>createConversationRuntime(id,emit,evidence.model),(m:any)=>{
  evidence.events.push({at:Date.now(),...m});
  if(m.type==='tool_call'){
   console.log(`${mode}: ${m.name}`);
   const job=connection!.tool(m.conversationId,'main',m.name,m.params).then(async(result:any)=>{
    if(m.name==='open_tab'&&result.ok&&Number.isInteger(result.data?.tabId))created.add(result.data.tabId);
    // Synchronization only: hold the real gate tool result until input delivery.
    // Some model expressions start fetch but return synchronously. Do not let this
    // fixture mistake turn the running-task test into an already-ended-task test.
    if(result.ok&&m.name==='js'&&String(m.params.code).includes('/gate'))await until(()=>released,35000,'Input gate delivery timeout');
    manager.get(m.conversationId)?.runtime.handleMessage({...result,id:m.id});
   }).catch((error:unknown)=>{evidence.bridgeError=String(error);manager.get(m.conversationId)?.runtime.handleMessage({type:'tool_result',id:m.id,ok:false,error:'Acceptance bridge failure'} as any);});
   jobs.add(job);void job.finally(()=>jobs.delete(job));
  }
 });
 let voice:StepVoiceSession|undefined;
 try{
  await manager.handleMessage({type:'conversation_create',requestId:`p0-${mode}`,title:`P0 ${mode}`});cid=manager.list()[0]!.id;evidence.cid=cid;
  if(mode==='voice'){
   voice=new StepVoiceSession({getSnapshot:()=>manager.getTaskProgress(cid),route:(text,start,current,context)=>manager.routeVoiceInput(cid,text,start,current,context),diagnostic:(event,fields)=>evidence.diagnostics.push({at:Date.now(),event,...fields}),emit:e=>{
    evidence.voiceEvents.push({at:Date.now(),...(e.kind==='audio'?{kind:'audio',bytes:Buffer.from(e.data,'base64').length}:e)});
    if(e.kind==='state'&&e.state==='ready')ready=true;
    if(e.kind==='response_end'){voice!.command({kind:'playback_done',responseId:e.responseId});done=true;}
   }});voice.start(await readStepVoiceKey());await until(()=>ready,15000,'Voice configuration timeout');
  }
  await manager.handleMessage({type:'user_message',conversationId:cid,text:`这是本地验收，只操作你自己的新标签页 ${url}。先保持最高预算1000和原始顺序，点击筛选，确认结果。然后必须调用js工具执行 fetch('/gate').then(r=>r.text()) 等待测试输入，不加顶层await。收到continue后按用户最新要求修改预算及排序，点击筛选并读取结果后结束。不要创建worker。等待门前不能自行改变预算或排序。`});
  await until(()=>{
   const failure=evidence.events.find((e:any)=>e.type==='agent_event'&&e.event.kind==='error');
   if(failure)throw Error(failure.event.message);
   return !!gate;
  },150000,'Task did not reach input gate');
  evidence.before=manager.getTaskProgress(cid);evidence.baseline=evidence.applications[0];evidence.submittedAt=Date.now();
  if(mode==='text'){await manager.handleMessage({type:'task_action',conversationId:cid,request:{requestId:`p0-${mode}-edit`,conversationId:cid,source:'text',action:'steer',expectedRunId:evidence.before.runId,text:instruction}});release();}
  else{
   voice!.command({kind:'interrupt',turn:1});const audio=Buffer.concat([pcm,Buffer.alloc(24000)]);
   for(let i=0;i<audio.length;i+=960){voice!.command({kind:'audio',turn:1,data:audio.subarray(i,i+960).toString('base64')});await sleep(20);}
   voice!.command({kind:'commit',turn:1});evidence.committedAt=Date.now();
   await until(()=>evidence.diagnostics.some((d:any)=>d.event==='route_result')||done,20000,'Voice routing timeout');release();
  }
  await until(()=>!manager.get(cid)!.runtime.session.isStreaming()&&!jobs.size&&(mode==='text'||done),150000,'Task completion timeout');
  const owned=[...created];if(owned.length!==1)throw Error(`Expected one fixture tab, got ${owned.length}`);
  evidence.page=await evaluateInWorker(connection!.cdp,connection!.sid,`chrome.scripting.executeScript({target:{tabId:${owned[0]}},func:()=>({budget:Number(document.querySelector('#budget').value),sort:document.querySelector('#sort').value,prices:[...document.querySelectorAll('#result li')].map(e=>Number(e.textContent))})}).then(r=>r[0].result)`);
  const receipts=evidence.events.filter((e:any)=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.message.startsWith('语音修改已送达'));
  evidence.starts=evidence.events.filter((e:any)=>e.type==='agent_event'&&e.event.kind==='agent_start').length;
  Object.assign(evidence,judgeBudgetRun({mode,baseline:evidence.baseline,page:evidence.page,starts:evidence.starts,receipts:receipts.length,receiptAt:receipts[0]?.at,firstAudioAt:evidence.voiceEvents.find((e:any)=>e.kind==='audio')?.at}));
  evidence.missingContracts=['formal runId/requestId and persistent structured receipt','sidepanel UI and real microphone acceptance'];
 }catch(error){evidence.error=String(error);evidence.status=!evidence.baseline&&/529|overloaded|模型|configuration/i.test(evidence.error)?'blocked':'failed';}
 finally{
  release();voice?.close();manager.dispose();await Promise.allSettled([...jobs]);
  for(const tabId of created)await evaluateInWorker(connection!.cdp,connection!.sid,`chrome.tabs.remove(${tabId}).catch(()=>{})`).catch(()=>{});
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await write(mode,evidence);
 }
 return evidence;
}
