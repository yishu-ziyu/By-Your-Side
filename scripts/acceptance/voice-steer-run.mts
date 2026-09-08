/** Real Step audio + production Pi steer + real Chrome fixture. Synthetic input, no microphone. */
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {createConversationRuntime} from '../../agent/src/conversation-runtime.js';
import {StepVoiceSession} from '../../agent/src/voice-session.js';
import {readStepVoiceKey} from '../../agent/src/voice-service.js';
import {connectParentAcceptance} from './parent-tab-control-run.mjs';
import {evaluateInWorker} from './cdp.mjs';
import type {ServerMessage} from '../../shared/protocol.js';
const out='/tmp/ego-voice-steer-evidence';await mkdir(out,{recursive:true});
execFileSync('/usr/bin/say',['-v','Tingting','-r','165','-o',out+'/input.aiff','预算改成八百，只看八百元以内的书桌。']);
execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',out+'/input.aiff','-ar','24000','-ac','1','-f','s16le',out+'/input.pcm']);
const pcm=await readFile(out+'/input.pcm');
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const server=createServer((_q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end(`<!doctype html><title>语音调整预算验收</title><h1>书桌筛选</h1><label>最高预算<input id="budget" aria-label="最高预算" value="1000"></label><button onclick="document.querySelector('#result').textContent='已应用预算：'+document.querySelector('#budget').value+'；候选商品：'+(['699','799','899'].filter(n=>Number(n)<=Number(document.querySelector('#budget').value)).join(','))">筛选</button><p id="result">尚未筛选</p>`);});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${(server.address() as any).port}/`;
const connection=await connectParentAcceptance();
const events:any[]=[];const bridge=new Set<Promise<unknown>>();let cid='';let waitStarted=false;let audioStarted=false;
const manager=new ConversationManager((id,emit)=>createConversationRuntime(id,emit,'minimax-cn/MiniMax-M3'),(m:ServerMessage)=>{
 events.push({at:Date.now(),...m});
 if(m.type==='tool_call'){
  console.log('Pi tool:',m.name);
  if(m.name==='js'&&JSON.stringify(m.params).includes('setTimeout'))waitStarted=true;
  const job=connection.tool(m.conversationId,'main',m.name,m.params).then((result:any)=>manager.get(m.conversationId!)!.runtime.handleMessage({...result,id:m.id}));
  bridge.add(job);void job.finally(()=>bridge.delete(job)).catch(()=>{});
 }
});
let voice:StepVoiceSession|undefined;const voiceEvents:any[]=[];
try{
 if(await evaluateInWorker(connection.cdp,connection.sid,'chrome.windows.getAll().then(ws=>ws.length)')===0)throw Error('ChromeMain has no window; open it before running this acceptance.');
 await manager.handleMessage({type:'conversation_create',requestId:'voice-steer-eval',title:'语音调整预算验收'});cid=manager.list()[0]!.id;
 await manager.handleMessage({type:'user_message',conversationId:cid,text:`这是本地浏览器验收。请只在你自己的新标签页打开 ${url}。目前预算1000元。打开后，先调用 js 工具执行 new Promise(r=>setTimeout(r,12000)) 等待12秒（测试需要这段等待，请真的调用并等待，不加顶层await）。等这一步结束再按你收到的最新预算填写“最高预算”并点击“筛选”，读取结果后结束。不要创建worker，不要在等待前填写或筛选。`});
 for(let i=0;i<1500&&!waitStarted;i++){await delay(100);if(!manager.get(cid)!.runtime.session.isStreaming()&&i>30)throw Error('Pi stopped before waiting step');}
 if(!waitStarted)throw Error('Pi did not reach waiting step');
 const before=manager.getTaskProgress(cid)!;console.log('voice starts on running task',before.state);
 let ready=false,done=false;
 voice=new StepVoiceSession({getSnapshot:()=>manager.getTaskProgress(cid),route:(text,startedAt,stillCurrent)=>manager.routeVoiceInput(cid,text,startedAt,stillCurrent),emit:e=>{
  voiceEvents.push(e.kind==='audio'?{kind:e.kind,bytes:Buffer.from(e.data,'base64').length}:e);
  if(e.kind==='state'&&e.state==='ready')ready=true;
  if(e.kind==='state'&&e.state==='error')console.log('VOICE ERROR',e.detail);
  if(e.kind==='text')console.log(e.role,e.text);
  if(e.kind==='response_end'){voice!.command({kind:'playback_done',responseId:e.responseId});done=true;}
 }});voice.start(await readStepVoiceKey());
 for(let i=0;i<150&&!ready;i++)await delay(100);if(!ready)throw Error('Voice not ready');
 voice.command({kind:'interrupt',turn:1});audioStarted=true;
 const audio=Buffer.concat([pcm,Buffer.alloc(36000)]);
 for(let i=0;i<audio.length;i+=960){voice.command({kind:'audio',turn:1,data:audio.subarray(i,i+960).toString('base64')});await delay(20);}
 voice.command({kind:'commit',turn:1});
 for(let i=0;i<2400;i++){
  if(done&&!manager.get(cid)!.runtime.session.isStreaming()&&!bridge.size)break;
  if(i===2399)throw Error('Task timeout');await delay(100);
 }
 const read=await connection.tool(cid,'main','js',{code:'JSON.stringify({budget:document.querySelector("#budget").value,result:document.querySelector("#result").textContent})'});
 const receipt=events.find(e=>e.type==='agent_event'&&e.event.kind==='notice'&&e.event.message.startsWith('语音修改已送达'));
 const startCount=events.filter(e=>e.type==='agent_event'&&e.event.kind==='agent_start').length;
 const ok=!!receipt&&startCount===1&&JSON.stringify(read).includes('800')&&JSON.stringify(read).includes('799')&&!JSON.stringify(read).includes('899');
 await writeFile(out+'/result.json',JSON.stringify({ok,cid,before,audioStarted,receipt,startCount,read,voiceEvents,events},null,2));
 console.log(JSON.stringify({ok,receipt:receipt?.event,startCount,read}));if(!ok)process.exitCode=1;
}catch(e){console.error(String(e));await writeFile(out+'/result.json',JSON.stringify({ok:false,error:String(e),cid,events,voiceEvents},null,2));process.exitCode=1;}
finally{voice?.close();manager.dispose();await Promise.allSettled([...bridge]);const tabs=await connection.tool(cid,'main','list_tabs',{}).catch(()=>null);for(const t of tabs?.data?.tabs??[])await connection.tool(cid,'main','close_tab',{tabId:t.id}).catch(()=>{});await connection.close();server.closeAllConnections();server.close();}
