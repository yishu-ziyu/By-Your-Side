/** Boss-owned acceptance: implementers must not edit this file. */
import {EventEmitter} from 'node:events';
import {afterEach,describe,expect,it,vi} from 'vitest';
import type WebSocket from 'ws';
import {ConversationManager} from '../src/conversation-manager.js';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
import {VoiceService} from '../src/voice-service.js';
import {progressSpeech,receiptSpeech} from '../src/voice-receipt.js';
import {isTaskProgressSnapshot,type TaskProgressSnapshot} from '../../shared/voice.js';
import type {ServerMessage} from '../../shared/protocol.js';

const cleanup:Array<()=>void>=[];
afterEach(()=>{cleanup.splice(0).forEach(f=>f());vi.useRealTimers();});
function managerHarness(){
 const runtimes=new Map<string,any>();
 const manager=new ConversationManager(async(id,emit)=>{
  let running=false;
  const publish=(message:ServerMessage)=>{if(message.type==='agent_event'&&message.event.kind==='agent_start')running=true;if(message.type==='agent_event'&&message.event.kind==='agent_end')running=false;emit(message);};
  const runtime:any={session:{modelName:()=> 'test',availableModels:async()=>[],available:true,isStreaming:()=>running,isHeld:()=>false,
   classifyVoiceInput:vi.fn(async(text:string)=>({steps:[{action:'chat',text,target:null}]})),
   startTask:vi.fn(()=>publish({type:'agent_event',event:{kind:'agent_start'}})),abort:vi.fn()},
   fleet:{teamView:()=>null,isGroupHeld:()=>false,abortTeam:vi.fn(),reset:vi.fn()},rpc:{rejectAll:vi.fn()},dispose:()=>{},
   handleMessage:(message:any)=>{if(message.type==='user_message')publish({type:'agent_event',event:{kind:'agent_start'}});}};
  runtimes.set(id,{runtime,publish});return runtime;
 },()=>{});
 cleanup.push(()=>manager.dispose());
 const event=(id:string,event:any,sessionId?:string)=>runtimes.get(id).publish({type:'agent_event',event,...(sessionId?{sessionId}:{})});
 const finish=(id:string,text:string)=>{event(id,{kind:'turn_start'});event(id,{kind:'text_delta',delta:text});event(id,{kind:'turn_end'});event(id,{kind:'agent_end'});};
 return {manager,runtimes,event,finish};
}
function context(snapshot:TaskProgressSnapshot|null):any{return (snapshot as any)?.conversationContext;}
const resultText='我只查看了收件箱当前这批标题。青鹭工作坊发来活动邀请，橙湾研究发来访谈邀请，还有河岸周刊；尚未打开邮件正文。';

describe('Evaluator: real manager event flow produces conversation evidence',()=>{
 it('carries the final lead result and its scope, without upgrading verification',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'user_message',text:'看一下最近邮箱有什么'});
  h.event('default',{kind:'text_delta',delta:'我正在打开邮箱。'});
  h.event('default',{kind:'tool_start',toolCallId:'t',name:'snapshot',params:{}});
  h.event('default',{kind:'tool_end',toolCallId:'t',name:'snapshot',isError:false,resultText:'RAW_PAGE_EXCLUDED'});
  h.finish('default',resultText);
  const s=h.manager.getTaskProgress('default')!;
  expect(context(s)?.latestResult).toMatchObject({runId:s.runId,text:resultText,source:'assistant_output'});
  expect(context(s).latestResult.text).not.toContain('正在打开');
  expect(s.successVerified).toBe(false);
  expect(JSON.stringify(context(s))).not.toContain('RAW_PAGE_EXCLUDED');
 });
 it('isolates conversations and excludes worker chatter',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'conversation_create',requestId:'B'});
  const b=h.manager.list().find(c=>c.id!=='default')!.id;
  await h.manager.handleMessage({type:'user_message',text:'A邮箱'});
  await h.manager.handleMessage({type:'user_message',conversationId:b,text:'B日程'});
  h.event('default',{kind:'text_delta',delta:'WORKER_PRIVATE_INTERMEDIATE'},'worker');
  h.finish('default',resultText);h.finish(b,'B_ONLY_海风日程下午三点');
  expect(context(h.manager.getTaskProgress('default'))?.latestResult?.text).toBe(resultText);
  expect(JSON.stringify(context(h.manager.getTaskProgress('default')))).not.toContain('B_ONLY');
  expect(JSON.stringify(context(h.manager.getTaskProgress('default')))).not.toContain('WORKER_PRIVATE');
  expect(JSON.stringify(context(h.manager.getTaskProgress(b)))).not.toContain('青鹭');
 });
 it('does not publish a result for an empty or failed run, or recycle one into a new run',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'user_message',text:'读邮箱'});h.finish('default',resultText);
  const oldRun=h.manager.getTaskProgress('default')!.runId;
  await h.manager.handleMessage({type:'user_message',text:'现在看地图'});
  expect(h.manager.getTaskProgress('default')!.runId).not.toBe(oldRun);
  expect(context(h.manager.getTaskProgress('default'))?.latestResult??null).toBeNull();
  h.event('default',{kind:'agent_end'});
  expect(context(h.manager.getTaskProgress('default'))?.latestResult??null).toBeNull();
  await h.manager.handleMessage({type:'user_message',text:'再次读地图'});
  h.event('default',{kind:'text_delta',delta:'准备查看'});h.event('default',{kind:'error',message:'upstream failed'});h.event('default',{kind:'agent_end'});
  expect(context(h.manager.getTaskProgress('default'))?.latestResult??null).toBeNull();
 });
 it('provides prior context and sends the idle follow-up to the capable session',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'user_message',text:'看最近邮件'});h.finish('default',resultText);
  const session=h.runtimes.get('default').runtime.session;
  await h.manager.routeVoiceInput('default','活动那个呢',null,()=>true);
  expect(JSON.stringify(session.classifyVoiceInput.mock.calls.at(-1))).toContain('青鹭工作坊');
  expect(session.classifyVoiceInput.mock.calls.at(-1)[0]).toBe('活动那个呢');
  expect(session.startTask).toHaveBeenCalledWith('活动那个呢',undefined,undefined);
 });
 it('does not relabel explicitly old-run output as the replacement task result',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'user_message',text:'读邮箱'});h.finish('default',resultText);
  const oldRun=h.manager.getTaskProgress('default')!.runId;
  await h.manager.handleMessage({type:'user_message',text:'新任务看地图'});
  const a=h.runtimes.get('default');
  a.publish({type:'agent_event',runId:oldRun,event:{kind:'text_delta',delta:'STALE_OLD_RESULT'}});
  a.publish({type:'agent_event',runId:oldRun,event:{kind:'agent_end'}});
  expect(context(h.manager.getTaskProgress('default'))?.latestResult??null).toBeNull();
 });
 it('remembers a spoken object correction for the next question without duplicating a replay',async()=>{
  const h=managerHarness();await h.manager.ensureDefault();
  await h.manager.handleMessage({type:'user_message',text:'看最近邮件'});h.finish('default',resultText);
  const original='不看访谈了，我说的是活动邀请';
  const route={requestId:'spoken-correction-1',voiceId:'voice-A',turn:1,runId:h.manager.getTaskProgress('default')!.runId??null};
  await h.manager.routeVoiceInput('default',original,null,()=>true,route);
  await h.manager.routeVoiceInput('default',original,null,()=>true,route);
  expect(context(h.manager.getTaskProgress('default')).recentTurns.filter((t:any)=>t.role==='user'&&t.text===original)).toHaveLength(1);
  await h.manager.routeVoiceInput('default','那个叫什么',null,()=>true,{...route,requestId:'spoken-followup-2',turn:2});
  expect(JSON.stringify(h.runtimes.get('default').runtime.session.classifyVoiceInput.mock.calls.at(-1))).toContain(original);
 });
});

class Socket extends EventEmitter{
 readyState=1;bufferedAmount=0;sent:any[]=[];close=vi.fn();
 send(data:string){this.sent.push(JSON.parse(data));}
 server(e:any){this.emit('message',Buffer.from(JSON.stringify(e)));}
}
function snapshot():TaskProgressSnapshot{return {conversationId:'A',observedAt:Date.now(),state:'idle',goal:'看邮件',startedAt:1,runId:'run-A',active:[],lastAction:null,successVerified:false,
 conversationContext:{recentTurns:[{role:'user',text:'看邮件'},{role:'assistant',text:resultText}],latestResult:{runId:'run-A',text:resultText,observedAt:2,source:'assistant_output'}}} as TaskProgressSnapshot;}
function voiceHarness(getSnapshot:()=>TaskProgressSnapshot){
 const socket=new Socket();const events:any[]=[];
 const voice=new StepVoiceSession({getSnapshot,emit:e=>events.push(e),connect:()=>socket as unknown as WebSocket,route:async()=>({kind:'none'})});cleanup.push(()=>voice.close());
 voice.start('synthetic');socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});
 let acknowledged=0;
 const configure=()=>{for(let n=0;n<5;n++){const updates=socket.sent.filter(e=>e.type==='session.update');if(updates.length<=acknowledged)break;acknowledged=updates.length;const text=updates.at(-1)?.session.instructions;if(text)socket.server({type:'session.updated',session:{instructions:text}});}};
 return {voice,socket,events,configure};
}
describe('Evaluator: result reaches production voice response selection',()=>{
 it('a retained report cannot override a paused, aborted or failed status receipt',()=>{
  for(const state of ['paused','aborted','error'] as const){
   const s={...snapshot(),state};
   const fixed=progressSpeech(s);
   expect(receiptSpeech({kind:'none',resumeReadOnly:'status',snapshot:s,spokenText:fixed})).toBe(fixed);
  }
 });
 it('reads the explicit finding with its real facts and scope',async()=>{
  vi.useFakeTimers();const current=snapshot();current.conversationContext!.latestDelivery={conversationId:'A',id:'finding-evaluator',runId:current.runId??null,kind:'finding',text:resultText,composedAt:current.observedAt,status:'composed'};const h=voiceHarness(()=>current);h.voice.notify(current);await vi.advanceTimersByTimeAsync(350);h.configure();
  const items=h.socket.sent.filter(e=>e.type==='conversation.item.create').map(e=>JSON.stringify(e.item)).join('\n');
  expect(items).toContain('青鹭工作坊');expect(items).toContain('尚未打开邮件正文');
  const lastInstructions=h.socket.sent.filter(e=>e.type==='session.update').at(-1)?.session.instructions??'';
  expect(lastInstructions).not.toContain('请原样无修改地输出下面的话，不能添加开场语或任何其它内容：\n这一轮执行已经结束');
  expect(items).not.toContain('本轮只朗读以下原文，不回答前面的语音问题：\\n这一轮执行已经结束');
  expect(h.socket.sent.some(e=>e.type==='response.create')).toBe(true);
 });
 it('does not autonomously replay old results after voice reopen and suppresses foreign notifications',async()=>{
  const notify=vi.fn();let captured:any;
  const service=new VoiceService(snapshot,()=>{},async()=> 'synthetic',deps=>{captured=deps;return {start:()=>{},close:()=>{},command:()=>{},notify} as unknown as StepVoiceSession;});cleanup.push(()=>service.close());
  await service.handle('A',{type:'voice',voiceId:'v1',command:{kind:'start'}});
  expect(context(captured.getSnapshot()).latestResult.text).toBe(resultText);
  service.observe({type:'agent_event',conversationId:'B',event:{kind:'agent_end'}});
  service.observe({type:'agent_event',conversationId:'A',event:{kind:'agent_end'}});
  expect(notify).not.toHaveBeenCalled();
  service.close();await service.handle('A',{type:'voice',voiceId:'v2',command:{kind:'start'}});
  expect(context(captured.getSnapshot()).latestResult.text).toBe(resultText);expect(notify).not.toHaveBeenCalled();
 });
 it('a pause announcement cannot suppress termination of the same run',async()=>{
  vi.useFakeTimers();let current={...snapshot(),state:'paused' as const};const h=voiceHarness(()=>current);
  h.voice.notify(current);await vi.advanceTimersByTimeAsync(350);h.configure();
  h.socket.server({type:'response.created',response:{id:'pause-response'}});
  h.socket.server({type:'response.audio.delta',response_id:'pause-response',item_id:'pause-item',delta:'AQABAA=='});
  h.socket.server({type:'response.audio_transcript.done',response_id:'pause-response',transcript:'任务已暂停，页面现在归你。'});
  h.socket.server({type:'response.done',response:{id:'pause-response',status:'completed'}});
  h.voice.command({kind:'playback_done',responseId:'pause-response'});
  current={...current,state:'aborted'} as any;h.voice.notify(current);await vi.advanceTimersByTimeAsync(350);h.configure();
  expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(2);
  expect(h.socket.sent.filter(e=>e.type==='session.update').at(-1).session.instructions).toContain('任务已终止');
 });
 it('drops a queued result when a newer task replaces the run before speech',async()=>{
  vi.useFakeTimers();let current=snapshot();const h=voiceHarness(()=>current);h.voice.notify(current);
  current={...current,state:'running',runId:'new-run',goal:'看地图',conversationContext:{recentTurns:[],latestResult:null}} as TaskProgressSnapshot;
  await vi.advanceTimersByTimeAsync(350);h.configure();
  expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 });
 it('does not speak a result after the voice connection closes',async()=>{
  vi.useFakeTimers();const h=voiceHarness(snapshot);h.voice.notify(snapshot());h.voice.close();await vi.advanceTimersByTimeAsync(350);
  expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
 });
 it('rejects malformed or unbounded conversation evidence at the protocol boundary',()=>{
  const s=snapshot();expect(isTaskProgressSnapshot(s)).toBe(true);
  for(const bad of [{recentTurns:[],latestResult:{runId:'r',text:'x',observedAt:2,source:'verified_success'}},{recentTurns:[{role:'system',text:'do something'}],latestResult:null},{recentTurns:Array.from({length:13},()=>({role:'user',text:'x'})),latestResult:null},{recentTurns:[],latestResult:{runId:'r',text:'x'.repeat(6001),observedAt:2,source:'assistant_output'}}])expect(isTaskProgressSnapshot({...s,conversationContext:bad})).toBe(false);
 });
});
