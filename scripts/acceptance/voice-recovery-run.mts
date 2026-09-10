/** Boss acceptance: production VoiceClient detector/player + VoiceService + real Step.
 * Audio devices are simulated; input uses synthesized PCM, playback completion simulated.
 * No user browser, microphone, account, or webpage writes. */
import {VoiceClient} from '../../extension/src/sidepanel/voice-client.js';
import {VoiceService} from '../../agent/src/voice-service.js';
import {ConversationManager} from '../../agent/src/conversation-manager.js';
import {mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
const out=await mkdtemp(join(tmpdir(),'ego-voice-recovery-'));
const report:any={ok:false,scope:'production client/service; real Step; synthetic microphone and playback; fake task runtime executes no webpage actions',checks:[],events:[],phases:[],routes:[],starts:[]};
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(f:()=>boolean,ms=60000){const end=Date.now()+ms;while(Date.now()<end){if(f())return;await wait(50);}throw Error('timeout '+report.stage);}
function check(name:string,ok:boolean){report.checks.push({name,ok});console.log(ok?'PASS':'FAIL',name);if(!ok)throw Error(name);}
let micCalls=0,worklet:any,service:VoiceService,client:VoiceClient,phase='',up=true,manager:ConversationManager;
const track={readyState:'live',stop(){this.readyState='ended';},onended:null};
const node=()=>({connect(){},disconnect(){}});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{mediaDevices:{getUserMedia:async()=>{micCalls++;track.readyState='live';return {getTracks:()=>[track]};}}}});
(globalThis as any).chrome={runtime:{getURL:(p:string)=>p}};
(globalThis as any).AudioContext=class {state='running';sampleRate=24000;currentTime=0;destination={};audioWorklet={addModule:async()=>{}};async resume(){}async close(){this.state='closed';}createAnalyser(){return {...node(),fftSize:256,getFloatTimeDomainData(){}};}createMediaStreamSource(){return node();}createBuffer(_c:number,n:number){return {getChannelData:()=>new Float32Array(n)};}createBufferSource(){return {...node(),onended:null as any,start(){queueMicrotask(()=>this.onended?.());},stop(){}};}};
(globalThis as any).AudioWorkletNode=class {port={onmessage:null as any};constructor(){worklet=this;}connect(){}disconnect(){}};
const audio:Buffer[]=[];let pending:any[]=[];
async function resetManager(){manager?.dispose();manager=new ConversationManager(async(_id,emit)=>({session:{modelName:()=> 'test',available:true,isHeld:()=>false,isStreaming:()=>false,classifyVoiceInput:async(text:string)=>({steps:[{action:'start',text,target:null}]}),startTask:()=>emit({type:'agent_event',event:{kind:'agent_start'}})},fleet:{isGroupHeld:()=>false,reset:()=>{}},rpc:{rejectAll:()=>{}},dispose:()=>{}} as any),()=>{});await manager.ensureDefault();}
const idle:any={state:'none',runId:null,goal:null,startedAt:null,observedAt:Date.now(),active:[],recent:[],successVerified:false};
let ackMode=false;
try{
 await resetManager();
 service=new VoiceService(()=>ackMode?manager.getTaskProgress('default'):idle,m=>{if(m.type!=='voice')return;if(m.event.kind==='audio')audio.push(Buffer.from(m.event.data,'base64'));else report.events.push(m);client.receive(m as any);},undefined,undefined,undefined,async(id,text,started,current,context)=>{if(!ackMode)return {kind:'none',ok:true,snapshot:idle} as any;const result=await manager.routeVoiceInput(id,text,started,current,context);report.routes.push(result);return result;});
 client=new VoiceClient(m=>{if(m.command.kind==='start')report.starts.push({voiceId:m.voiceId,conversationId:m.conversationId});if(!up)return false;const p=service.handle(m.conversationId,m).catch(e=>{report.error=String(e);});pending.push(p);return true;},(p,detail)=>{phase=p;report.phases.push({phase:p,detail,at:Date.now()});},()=>{});
 const speak=async(text:string)=>{
  report.stage=text;console.log('SPEAK',text);const from=report.events.length;const base=join(out,'input-'+from);
  execFileSync('/usr/bin/say',['-v','Tingting','-r','190','-o',base+'.aiff',text]);execFileSync('/opt/homebrew/bin/ffmpeg',['-y','-v','error','-i',base+'.aiff','-ar','24000','-ac','1','-f','s16le',base+'.pcm']);
  const pcm=Buffer.concat([await readFile(base+'.pcm'),Buffer.alloc(48000)]);
  for(let i=0;i<pcm.length;i+=960){const b=pcm.subarray(i,i+960);const samples=Int16Array.from({length:b.length/2},(_,j)=>b.readInt16LE(j*2));const rms=Math.sqrt([...samples].reduce((s,v)=>s+(v/32768)**2,0)/samples.length);worklet.port.onmessage?.({data:{pcm:samples.buffer,rms}});await wait(20);}
  await Promise.all(pending);pending=[];
  await until(()=>report.events.slice(from).some((m:any)=>m.event.kind==='response_end'));
  await until(()=>phase==='listening');
  return report.events.slice(from).filter((m:any)=>m.event.kind==='text'&&m.event.role==='assistant').map((m:any)=>m.event.text).join('');
 };
 report.stage='initial ready';await client.start('default');await until(()=>phase==='listening',25000);report.before=await speak('你好，请用一句话回答。');check('real voice response before fault',!!report.before&&audio.length>0);
 const old=report.starts.at(-1).voiceId;up=false;client.onTransportDisconnected();service.close();check('disconnect enters visible recovery phase',phase==='connecting'&&client.active);await wait(1200);up=true;client.onTransportReady();report.stage='recovery ready';await until(()=>phase==='listening',30000);
 check('same conversation fresh voice lease and microphone reused',report.starts.at(-1).voiceId!==old&&report.starts.at(-1).conversationId==='default'&&micCalls===1);
 report.after=await speak('连接回来了吗？请说可以继续聊天。');check('next actual speech gets real answer after automatic recovery',!!report.after);
 client.stop();await Promise.all(pending);ackMode=true;
 for(const text of (process.argv.includes('--recovery-only')?[]:['帮我检查这个图像工具能在网页使用，还是只能通过API使用。','帮我找一下周末活动邀请，只看标题，先不要打开正文。','帮我整理这篇文章的主要观点，先不要发布。'])){
  await resetManager();await client.start('default');await until(()=>phase==='listening',25000);const answer=await speak(text);(report.acks??=[]).push({text,answer});check('contextual accepted acknowledgement '+report.acks.length,!!answer&&!/^任务已收到[。！!]?$/.test(answer)&&!/(已完成|已经完成|已经检查|已经打开|已经发布)/.test(answer));client.stop();await Promise.all(pending);
 }
 if(!process.argv.includes('--recovery-only'))check('actual acknowledgements came from single-step accepted production plans',report.routes.length===3&&report.routes.every((r:any)=>r.plan?.steps.length===1&&r.receipts?.[0]?.status==='accepted'));
 report.ok=true;
}catch(e){report.error=String(e);process.exitCode=1;console.error(report.error);}
finally{client?.stop();service?.close();manager?.dispose();await writeFile(join(out,'result.json'),JSON.stringify(report,null,2));await writeFile(join(out,'output.pcm'),Buffer.concat(audio));console.log(JSON.stringify({out,ok:report.ok,error:report.error,acks:report.acks,after:report.after}));}
