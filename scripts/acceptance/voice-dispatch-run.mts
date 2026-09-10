/** Real Step PCM -> production manager -> real Pi -> Chrome. No microphone/UI claim. */
import {voiceEvidence} from './voice-evidence.mts';
import {createServer} from 'node:http';
import {execFileSync,spawn} from 'node:child_process';
import WebSocket from 'ws';
import {STEP_VOICE_ENDPOINT} from '../../agent/src/voice-session.js';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {StepVoiceSession} from '../../agent/src/voice-session.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker} from './cdp.mjs';
const suite=process.argv[process.argv.indexOf('--suite')+1];
async function child(args:string[]){await new Promise<void>((resolve,reject)=>{const p=spawn(process.execPath,args,{stdio:'inherit'});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(Error(`Acceptance child failed: ${args.join(' ')} (${code})`)));});}
if(suite==='extensions'){
 for(let repeat=1;repeat<=3;repeat++){console.log(`extensions repetition ${repeat}/3`);for(const file of ['voice-control-run.mts','voice-context-run.mts','voice-target-run.mts'])await child(['--import','tsx',`scripts/acceptance/${file}`]);}
 process.exit(0);
}
if(suite==='faults')await child(['node_modules/vitest/vitest.mjs','run','agent/test/voice-session.test.ts','agent/test/voice-intent.test.ts','agent/test/task-dispatcher.test.ts','agent/test/task-control.test.ts','extension/test/voice-audio.test.ts','extension/test/voice-relay.test.ts','extension/test/session-management.test.ts']);
const out=`/tmp/ego-voice-dispatch-${Date.now()}`;await mkdir(out,{recursive:true});
const report:any={evidence:voiceEvidence(),suite,ok:false,source:'production modules + real Step/Pi/Chrome; synthetic audio',checks:[],events:[],voiceEvents:[],diagnostics:[]};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(test:()=>boolean,ms=150000){const end=Date.now()+ms;while(!test()){if(report.voiceFailure)throw Error(report.voiceFailure);if(Date.now()>end)throw Error('Acceptance timeout');await sleep(100);}}
let connection:Awaited<ReturnType<typeof connectParentAcceptance>>|undefined;
let manager:ConversationManager|undefined;let voice:StepVoiceSession|undefined;
const tabs=new Set<number>(),jobs=new Set<Promise<void>>();
let turn=0,ready=false,done=false;let upstream:WebSocket|undefined;let dropped=false;let connections=0;
const server=createServer((_q,r)=>{
 r.setHeader('Content-Type','text/html;charset=utf-8');
 r.end(`<!doctype html><title>书桌筛选验收</title><h1>书桌筛选</h1><label>最高预算<input id="budget" aria-label="最高预算" value="1000"></label><label>排序<select id="sort" aria-label="排序"><option value="original">原始顺序</option><option value="asc">价格从低到高</option></select></label><button id="apply">筛选</button><ol id="result"></ol><script>apply.onclick=()=>{let p=[899,699,1099,799].filter(n=>n<=Number(budget.value));if(sort.value==='asc')p.sort((a,b)=>a-b);result.innerHTML=p.map(n=>'<li>'+n+'</li>').join('');};</script>`);
});
const check=(name:string,ok:boolean)=>{report.checks.push({name,ok});if(!ok)throw Error(name);};
try{
 if(suite!=='parity'&&suite!=='faults')throw Error(`Unknown suite ${suite}`);
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
 connection=await connectParentAcceptance();
 manager=new ConversationManager((id,emit)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3'),(m:any)=>{
  report.events.push({at:Date.now(),...m});
  if(m.type==='tool_call'){
   console.log(`tool ${m.name}`);
   const p=connection!.tool(m.conversationId,m.sessionId??'main',m.name,m.params).then((r:any)=>{
    if(m.name==='open_tab'&&r.ok&&Number.isInteger(r.data?.tabId))tabs.add(r.data.tabId);
    manager!.get(m.conversationId)!.runtime.handleMessage({...r,id:m.id});
   }).catch((e:unknown)=>{report.bridgeError=String(e);});jobs.add(p);void p.finally(()=>jobs.delete(p));
  }
 });
 await manager.handleMessage({type:'conversation_create',requestId:randomUUID(),title:'语音启动验收'});const cid=manager.list()[0]!.id;report.cid=cid;
 const opened=await connection.tool(cid,'main','open_tab',{url});if(!opened.ok)throw Error(opened.error);tabs.add(opened.data.tabId);report.tabId=opened.data.tabId;
 voice=new StepVoiceSession({connect:key=>{connections++;return upstream=new WebSocket(STEP_VOICE_ENDPOINT,{headers:{Authorization:`Bearer ${key}`},handshakeTimeout:12000,followRedirects:false});},getSnapshot:()=>manager!.getTaskProgress(cid),route:async(text,at,current,context)=>{const r=await manager!.routeVoiceInput(cid,text,at,current,context);if(suite==='faults'&&!dropped&&'receipts' in r&&r.receipts?.some(r=>r.action==='start'&&r.status==='accepted')){dropped=true;upstream?.terminate();}return r;},diagnostic:(event,fields)=>report.diagnostics.push({at:Date.now(),event,...fields}),emit:e=>{
  report.voiceEvents.push({at:Date.now(),...(e.kind==='audio'?{kind:'audio',turn:e.turn,bytes:Buffer.from(e.data,'base64').length}:e)});
  if(e.kind==='state'&&e.state==='ready'){ready=true;if(turn>0)done=true;}
  if(e.kind==='state'&&e.state==='error')report.voiceFailure=e.detail;
  if(e.kind==='response_end'){voice!.command({kind:'playback_done',responseId:e.responseId});done=true;}
 }});voice.start(await readStepVoiceKey());await until(()=>ready,15000);
 const starts=()=>report.events.filter((e:any)=>e.type==='agent_event'&&e.event.kind==='agent_start').length;
 await speak('你好，十加七等于多少？');check('闲聊不启动任务',starts()===0);
 await speak('现在任务做到哪了？');check('无任务进度查询不启动任务',starts()===0);
 await speak('请在当前书桌筛选页把最高预算设为八百，按价格从低到高排序，然后筛选。不要创建协作者，只在当前页面完成。');
 check('只播报接收回执，不提前声称网页完成',report.voiceEvents.some((e:any)=>e.kind==='text'&&e.role==='assistant'&&e.turn===3&&e.text==='任务已收到。')&&report.voiceEvents.some((e:any)=>e.kind==='audio'&&e.turn===3));
 await until(()=>!manager!.get(cid)!.runtime.session.isStreaming()&&!jobs.size);
 report.page=await evaluateInWorker(connection.cdp,connection.sid,`chrome.scripting.executeScript({target:{tabId:${opened.data.tabId}},func:()=>({budget:Number(document.querySelector('#budget').value),sort:document.querySelector('#sort').value,prices:[...document.querySelectorAll('#result li')].map(e=>Number(e.textContent))})}).then(r=>r[0].result)`);
 check('语音只启动一次任务',starts()===1);
 check('实际页面预算与排序正确',report.page.budget===800&&report.page.sort==='asc'&&JSON.stringify(report.page.prices)==='[699,799]');
 check('启动有正式回执和runId',report.events.some((e:any)=>e.event?.receipt?.action==='start'&&e.event.receipt.status==='accepted'&&typeof e.event.receipt.runId==='string'));
 await speak('别说了。');check('停止播报不新建任务',starts()===1);check('停止播报不生成新音频',!report.voiceEvents.some((e:any)=>e.kind==='audio'&&e.turn===turn));
 if(suite==='faults'){check('执行已接收后真实断线并重连',dropped&&connections>=2);check('断线没有重复路由任务',report.diagnostics.filter((e:any)=>e.event==='route_start'&&e.turn===3).length===1);}
 report.ok=true;
}catch(error){report.error=String(error);process.exitCode=1;}
finally{
 voice?.close();manager?.dispose();await Promise.allSettled([...jobs]);
 if(connection){for(const id of tabs)await evaluateInWorker(connection.cdp,connection.sid,`chrome.tabs.remove(${id}).catch(()=>{})`).catch(()=>{});await connection.close();}
 server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,checks:report.checks,error:report.error}));
}
if(suite==='faults'&&report.ok){
 try{await child(['--import','tsx','scripts/acceptance/voice-restart-run.mts']);report.restartPassed=true;}
 catch(error){report.ok=false;report.error=String(error);process.exitCode=1;}
 await writeFile(`${out}/result.json`,JSON.stringify(report,null,2));console.log(JSON.stringify({out,ok:report.ok,restartPassed:report.restartPassed,error:report.error}));
}
async function speak(text:string){
 const n=++turn;done=false;execFileSync('/usr/bin/say',['-v','Tingting','-r','185','-o',`${out}/${n}.aiff`,text]);
 execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',`${out}/${n}.aiff`,'-ar','24000','-ac','1','-f','s16le',`${out}/${n}.pcm`]);
 const pcm=Buffer.concat([await readFile(`${out}/${n}.pcm`),Buffer.alloc(24000)]);
 voice!.command({kind:'interrupt',turn:n});for(let i=0;i<pcm.length;i+=960){voice!.command({kind:'audio',turn:n,data:pcm.subarray(i,i+960).toString('base64')});await sleep(20);}
 voice!.command({kind:'commit',turn:n});if(suite==='faults')voice!.command({kind:'commit',turn:n});await until(()=>done,40000);
}
