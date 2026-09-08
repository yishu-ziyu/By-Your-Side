/** Installed native host + real Step audio + real M3 team + real Chrome controls. */
import {createServer} from 'node:http';
import {mkdir,readFile,writeFile,unlink} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker} from './cdp.mjs';
import {sideagentExtensionId} from './constants.mjs';
const out=`/tmp/ego-voice-control-${Date.now()}`;await mkdir(out,{recursive:true});
const report:any={ok:false,checks:[],source:'installed native host + Step PCM + M3 lead/worker + Chrome; synthetic human page edits'};
const phrases=['暂停整个任务，我来操作。','预算改成六百。','继续原任务。','终止当前任务。'];
const audios:Buffer[]=[];
for(const [i,text] of phrases.entries()){
 execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',`${out}/${i}.aiff`,text]);
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',`${out}/${i}.aiff`,'-ar','24000','-ac','1','-f','s16le',`${out}/${i}.pcm`]);
 audios.push(Buffer.concat([await readFile(`${out}/${i}.pcm`),Buffer.alloc(24000)]));
}
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
let connection:Awaited<ReturnType<typeof connectParentAcceptance>>|undefined;
let targetId:string|undefined,pageSid:string|undefined,cid:string|undefined,runId:string|undefined,original='default';
const voiceId=randomUUID();let origin='';
const capPath=join(homedir(),'.sideagent','acceptance-team-capability.json');let capabilityCreated=false;let ownedCapability:string|null=null;
const server=createServer((req,res)=>{
 const side=req.url?.startsWith('/worker')?'worker':'lead';res.setHeader('Content-Type','text/html;charset=utf-8');
 res.end(`<!doctype html><title>Control ${side}</title><h1>${side} 计数验收</h1><p id="marker">initial-${side}</p><label>预算<input id="budget" aria-label="预算" value="1000"></label><button id="inc">加一</button><p>次数：<b id="count">0</b></p><p id="seen">未操作</p><script>document.querySelector('#inc').onclick=()=>{document.querySelector('#count').textContent=String(Number(document.querySelector('#count').textContent)+1);document.querySelector('#seen').textContent=document.querySelector('#marker').textContent+':'+document.querySelector('#budget').value;};</script>`);
});
const w=(expression:string)=>{new Function(expression);return evaluateInWorker(connection!.cdp,connection!.sid,expression);};
async function page(expression:string){new Function(expression);const r=await connection!.cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},pageSid);if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result?.value;}
async function wait(expression:string,ms=60000){const end=Date.now()+ms;while(Date.now()<end){const r=await w(expression);if(r)return r;await sleep(100);}throw Error(`Timed out: ${expression.slice(0,100)}`);}
const native=(m:unknown)=>w(`globalThis.__saSendClient(${JSON.stringify(m)})`);
const check=(name:string,ok:boolean)=>{report.checks.push({name,ok});console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)throw Error(name);};
const ownEvents=()=>`(globalThis.__saServerEvents||[]).filter(e=>e.conversationId===${JSON.stringify(cid)})`;
const receipts=()=>`${ownEvents()}.filter(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.receipt).map(e=>e.event.receipt)`;
async function state(){return w(`chrome.tabs.query({}).then(ts=>Promise.all(ts.filter(t=>t.url?.startsWith(${JSON.stringify(origin+'/')})).map(t=>chrome.scripting.executeScript({target:{tabId:t.id},func:()=>({side:document.title.includes('worker')?'worker':'lead',count:Number(document.querySelector('#count').textContent),budget:Number(document.querySelector('#budget').value),marker:document.querySelector('#marker').textContent,seen:document.querySelector('#seen').textContent})}).then(r=>({tabId:t.id,...r[0].result})))))`);}
const sendVoice=(command:unknown)=>page(`globalThis.vport.postMessage(${JSON.stringify({kind:'client',msg:{type:'voice',voiceId,conversationId:cid,command}})})`);
async function speak(index:number,action:string){
 const turn=index+1,pcm=audios[index]!;
 await sendVoice({kind:'interrupt',turn});
 for(let i=0;i<pcm.length;i+=4800){await sendVoice({kind:'audio',turn,data:pcm.subarray(i,i+4800).toString('base64')});await sleep(100);}
 await sendVoice({kind:'commit',turn});
 const receipt=await wait(`${receipts()}.find(r=>r.requestId===${JSON.stringify(`${voiceId}-${turn}`)}&&r.action===${JSON.stringify(action)})`,55000);
 report[`receipt${turn}`]=receipt;check(`${action} acknowledged`,['accepted','applied'].includes(receipt.status));
 await wait(`${ownEvents()}.some(e=>e.type==='voice'&&e.voiceId===${JSON.stringify(voiceId)}&&e.event.kind==='response_end'&&e.event.turn===${turn})`,15000);
 return receipt;
}

try{
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${(server.address() as any).port}`;
 connection=await connectParentAcceptance();original=await w(`chrome.storage.session.get('selectedConversationId').then(s=>s.selectedConversationId||'default')`);
 const preflight=randomUUID();await native({type:'conversation_list',requestId:preflight});
 const listed=await wait(`(globalThis.__saServerEvents||[]).find(e=>e.type==='conversation_list'&&e.requestId===${JSON.stringify(preflight)})`);
 if(listed.conversations.some((c:any)=>c.state==='running'))throw Error('Another native task is running; do not disturb it');
 const created=randomUUID();await native({type:'conversation_create',requestId:created,title:'自动验收 · 语音控制'});
 cid=(await wait(`(globalThis.__saServerEvents||[]).find(e=>e.type==='conversation_created'&&e.requestId===${JSON.stringify(created)})`)).conversation.id;report.cid=cid;
 await native({type:'set_model',conversationId:cid,model:'minimax-cn/MiniMax-M3'});
 await wait(`${ownEvents()}.some(e=>e.type==='model_info'&&e.model?.includes('MiniMax-M3'))`);
 const target=await connection.cdp.send('Target.createTarget',{url:`chrome-extension://${sideagentExtensionId()}/sidepanel.html`,background:true});targetId=target.targetId;pageSid=await connection.cdp.attachSession(targetId);
 for(let i=0;i<100;i++){if(await page('!!globalThis.chrome?.runtime'))break;await sleep(100);}
 await page(`globalThis.vport=chrome.runtime.connect({name:'sideagent-panel'});vport.onMessage.addListener(m=>{if(m.kind==='server'&&m.msg.type==='voice'&&m.msg.voiceId===${JSON.stringify(voiceId)}&&m.msg.event.kind==='response_end')vport.postMessage({kind:'client',msg:{type:'voice',conversationId:${JSON.stringify(cid)},voiceId:${JSON.stringify(voiceId)},command:{kind:'playback_done',responseId:m.msg.event.responseId}}});});vport.postMessage({kind:'client',msg:{type:'voice',conversationId:${JSON.stringify(cid)},voiceId:${JSON.stringify(voiceId)},command:{kind:'start'}}});`);
 await wait(`${ownEvents()}.some(e=>e.type==='voice'&&e.voiceId===${JSON.stringify(voiceId)}&&e.event.kind==='state'&&e.event.state==='ready')`,20000);
 const leadTab=await connection.tool(cid,'main','open_tab',{url:origin+'/lead'});
 const workerTab=await connection.tool(cid,'ctrlworker','open_tab',{url:origin+'/worker'});
 if(!leadTab.ok||!workerTab.ok)throw Error('Could not create isolated control fixtures');
 const cap=randomUUID()+randomUUID();await writeFile(capPath,JSON.stringify({expiresAt:Date.now()+300000,tokens:[cap]}),{flag:'wx',mode:0o600});capabilityCreated=true;ownedCapability=cap;
 const common="这是控制验收，你的工作页已经打开并提供了页面锚点。不要open_tab或navigate。每轮只调用一次js执行 (() => { document.querySelector('#inc').click(); return document.querySelector('#count').textContent; })()，再调用js表达式 new Promise(r=>setTimeout(r,10000)) 等待，然后继续下一轮。一直重复直到用户暂停或终止。每次browser_run最多一轮，不要长循环、不要批量执行、不要设置循环定时器。收到交还后先读取新标记，先把用户指定的新预算填入budget，再继续计数。不要创建协作者。";
 const prepared=randomUUID();
 await native({type:'acceptance_prepare_team',conversationId:cid,requestId:prepared,capability:cap,worker:{sessionId:'ctrlworker',tabId:workerTab.data.tabId},tasks:{lead:{taskId:'live-lead',expectedSnapshotMarker:'page-mark-user-lead'},worker:{taskId:'live-worker',expectedSnapshotMarker:'page-mark-user-wiki'}},live:{leadGoal:common,workerGoal:common,leadContext:{tabId:leadTab.data.tabId,title:'Control lead',url:origin+'/lead'},workerContext:{tabId:workerTab.data.tabId,title:'Control worker',url:origin+'/worker'}}});
 const assembly=await wait(`${ownEvents()}.find(e=>e.type==='acceptance_team_ready'&&e.requestId===${JSON.stringify(prepared)})`);if(!assembly.ok)throw Error(assembly.reason);
 runId=(await wait(`${ownEvents()}.find(e=>e.type==='agent_event'&&e.event.kind==='agent_start'&&!e.sessionId&&e.runId)`)).runId;report.runId=runId;report.liveAssembly=assembly;
 const until=Date.now()+240000;let initial:any[]=[];
 while(Date.now()<until){initial=await state();if(initial.length===2&&initial.every(t=>t.count>0))break;await sleep(300);}
 report.initial=initial;check('real lead and worker both wrote',initial.length===2&&initial.every(t=>t.count>0));
 await speak(0,'pause');const paused=await state();await sleep(5000);check('zero writes during pause',JSON.stringify(await state())===JSON.stringify(paused));report.paused=paused;
 for(const t of paused)await w(`chrome.scripting.executeScript({target:{tabId:${t.tabId}},func:()=>{document.querySelector('#marker').textContent=${JSON.stringify(t.side==='lead'?'page-mark-user-lead':'page-mark-user-wiki')};}})`);
 await speak(1,'steer');check('paused edit does not resume',(await state()).every((t:any)=>t.budget===1000));
 await speak(2,'resume');
 const resumedUntil=Date.now()+90000;let resumed:any[]=[];
 while(Date.now()<resumedUntil){resumed=await state();if(resumed.length===2&&resumed.every(t=>t.seen.includes('page-mark-user-'))&&resumed.find(t=>t.side==='lead')?.budget===600)break;await sleep(200);}
 check('fresh human markers and new budget used',resumed.length===2&&resumed.every(t=>t.seen.includes('page-mark-user-'))&&resumed.find(t=>t.side==='lead')?.budget===600);report.resumed=resumed;
 check('same task identity after handback',await w(`${receipts()}.filter(r=>r.action==='pause'||r.action==='resume'||r.action==='steer').every(r=>r.runId===${JSON.stringify(runId)})`));
 await speak(3,'abort');const stopped=await state();await sleep(5000);check('zero writes after abort',JSON.stringify(await state())===JSON.stringify(stopped));
 const stale=await w(`globalThis.__saCall('stale-write-'+Date.now(),'js',{code:'document.querySelector("#count").textContent="999"'},'main',undefined,${JSON.stringify(cid)},{runId:${JSON.stringify(runId)},epochs:{main:0}})`);
 check('old task write rejected',!stale.ok);report.stale=stale;check('stale write made no page change',JSON.stringify(await state())===JSON.stringify(stopped));
 report.ok=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 if(connection&&cid){
  if(pageSid)await page(`vport?.postMessage({kind:'client',msg:{type:'voice',conversationId:${JSON.stringify(cid)},voiceId:${JSON.stringify(voiceId)},command:{kind:'stop'}}})`).catch(()=>{});
  if(runId){const cleanup=randomUUID();await native({type:'task_action',conversationId:cid,request:{requestId:cleanup,conversationId:cid,source:'text',action:'abort',expectedRunId:runId}}).catch(()=>{});await wait(`${receipts()}.find(r=>r.requestId===${JSON.stringify(cleanup)})`,50000).catch(()=>{});}
  report.events=await w(`${ownEvents()}.filter(e=>e.type!=='tool_call').map(e=>e.type==='voice'&&e.event.kind==='audio'?{type:'voice',event:{kind:'audio',turn:e.event.turn,bytes:e.event.data.length}}:e)`).catch(()=>[]);
  const owned=await w(`chrome.tabs.query({}).then(ts=>ts.filter(t=>t.url?.startsWith(${JSON.stringify(origin+'/')})).map(t=>t.id))`).catch(()=>[]);
  for(const id of owned)await w(`chrome.tabs.remove(${id}).catch(()=>{})`).catch(()=>{});
  if(pageSid)await page(`vport.postMessage({kind:'select_conversation',conversationId:${JSON.stringify(original)}})`).catch(()=>{});
 }
 if(connection&&targetId)await connection.cdp.send('Target.closeTarget',{targetId}).catch(()=>{});
 if(capabilityCreated){try{const record=JSON.parse(await readFile(capPath,'utf8'));if(record.tokens?.includes(ownedCapability))await unlink(capPath);}catch{}}
 await connection?.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
 await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,error:report.error}));
}
