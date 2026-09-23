import {afterEach,describe,it,expect,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';
import {MODEL,STEP_VOICE} from '../src/realtime-voice-connection.js';
import type {TaskProgressSnapshot,VoiceEvent} from '../../shared/voice.js';

class Socket extends EventEmitter{
  readyState=1;sent:any[]=[];
  send(raw:string){this.sent.push(JSON.parse(raw));}
  close(){this.readyState=3;this.emit('close',1000,Buffer.from(''));}
  server(e:unknown){this.emit('message',Buffer.from(JSON.stringify(e)));}
}

const sessions:RealtimeVoiceSession[]=[];

afterEach(()=>{sessions.splice(0).forEach(s=>s.close());vi.useRealTimers();});

function fixture(diagnosticMode=false,structured=false,shadow?:{judge:ReturnType<typeof vi.fn>;actual:ReturnType<typeof vi.fn>}){
  const socket=new Socket(),events:VoiceEvent[]=[];
  const snapshot:TaskProgressSnapshot={conversationId:'A',runId:null,state:'none',goal:null,startedAt:null,observedAt:1,active:[],lastAction:null,successVerified:false};
  const route=vi.fn(async(..._args:unknown[])=>({kind:'action' as const,ok:true,message:'已接收，不代表完成'}));const readPage=vi.fn(async()=>({text:'真实页面'}));const dispatchTask=vi.fn(async(..._args:unknown[])=>({ok:true,status:'accepted'}));const onPlayback=vi.fn();
  const deps: ConstructorParameters<typeof RealtimeVoiceSession>[0] = {voiceId:'voice3',diagnosticMode,getSnapshot:()=>snapshot,emit:e=>events.push(e),route,readPage,onPlayback,connect:()=>socket as any};

  if(structured)deps.dispatchTask=dispatchTask;

  if(shadow)deps.shadow=shadow as never;
  const session=new RealtimeVoiceSession(deps);sessions.push(session);session.start('not-a-real-key');
  const ready=()=>{socket.server({type:'session.created',session:{model:MODEL}});socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:diagnosticMode?{type:''}:{type:'server_vad'}}});};

  const begin=(item='u1',response='r1')=>{socket.server({type:'input_audio_buffer.speech_started',item_id:item});socket.server({type:'input_audio_buffer.speech_stopped',item_id:item});socket.server({type:'response.created',response:{id:response}});};

  return {session,socket,events,route,readPage,dispatchTask,onPlayback,ready,begin,snapshot};
}

describe('daily Realtime 3 native adapter',()=>{
 it('confirms 3, requests server VAD and does not cancel merely because the user speaks',()=>{
  const f=fixture();f.ready();expect(f.socket.sent[0].session.turn_detection.type).toBe('server_vad');
  expect(f.events).toContainEqual(expect.objectContaining({kind:'state',state:'ready',inputMode:'server_vad'}));
  f.begin();expect(f.events).toContainEqual({kind:'input_turn',turn:2});expect(f.socket.sent.some(x=>x.type==='response.cancel')).toBe(false);
 });
 it('rejects 2.5 instead of falling back',()=>{const f=fixture();f.socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});expect(f.events.some(e=>e.kind==='state'&&e.state==='error')).toBe(true);expect(f.socket.sent).toHaveLength(0);});
 it('waits for authoritative page context and dispatches the original ASR, not tool arguments',async()=>{
  vi.useFakeTimers();const f=fixture();f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,contextPending:true});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'翻译这篇文章'});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'call1',response_id:'r1',name:'browser_request',arguments:'{"text":"付款"}'});
  await vi.advanceTimersByTimeAsync(40);expect(f.route).not.toHaveBeenCalled();
  f.session.command({kind:'input_context',turn:2,input:{context:{tabId:7,title:'文章',url:'https://example.test'}}});await vi.advanceTimersByTimeAsync(40);
  expect(f.route).toHaveBeenCalledTimes(1);expect(f.route.mock.calls[0]?.[0]).toBe('翻译这篇文章');
  f.socket.server({type:'response.function_call_arguments.done',call_id:'call1',response_id:'r1',name:'browser_request',arguments:'{}'});await vi.advanceTimersByTimeAsync(30);expect(f.route).toHaveBeenCalledTimes(1);
 });
 it('cannot dispatch a late transcript from an older speech item',async()=>{
  vi.useFakeTimers();const f=fixture();f.ready();f.begin('old','old-r');f.begin('new','new-r');
  f.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'新页面',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'old',transcript:'旧任务'});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'old-call',response_id:'old-r',name:'browser_request',arguments:'{}'});await vi.advanceTimersByTimeAsync(50);expect(f.route).not.toHaveBeenCalled();
 });
 it('sends a finished tool result without waiting for preamble playback, without marking playback or the task complete',async()=>{
  const f=fixture();f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'文章',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'翻译文章'});
  f.socket.server({type:'response.audio.delta',response_id:'r1',delta:Buffer.alloc(960).toString('base64')});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'c1',response_id:'r1',name:'browser_request',arguments:'{}'});await Promise.resolve();await Promise.resolve();await Promise.resolve();
  f.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
  await vi.waitFor(()=>expect(f.socket.sent.find(x=>x.item?.type==='function_call_output')?.item.output).toContain('不代表完成'));
  expect(f.socket.sent.some(x=>x.type==='response.create')).toBe(true);
  expect(f.onPlayback).not.toHaveBeenCalled();
  f.session.command({kind:'playback_done',responseId:'r1'});
 });
 it('includes earlier queued audio in the playback deadline without claiming it has played',async()=>{
  vi.useFakeTimers();const f=fixture();f.ready();f.begin('u1','preamble');
  f.socket.server({type:'response.audio.delta',response_id:'preamble',delta:Buffer.alloc(24000*2*20).toString('base64')});
  f.socket.server({type:'response.done',response:{id:'preamble',status:'completed'}});
  f.socket.server({type:'response.created',response:{id:'answer'}});
  f.socket.server({type:'response.audio.delta',response_id:'answer',delta:Buffer.alloc(24000*2*2).toString('base64')});
  f.socket.server({type:'response.done',response:{id:'answer',status:'completed'}});
  await vi.advanceTimersByTimeAsync(13000);
  expect(f.events.some(e=>e.kind==='state'&&e.state==='error')).toBe(false);
  await vi.advanceTimersByTimeAsync(7000);f.session.command({kind:'playback_done',responseId:'preamble'});
  await vi.advanceTimersByTimeAsync(2000);f.session.command({kind:'playback_done',responseId:'answer'});
  expect(f.events.some(e=>e.kind==='state'&&e.state==='error')).toBe(false);
 });
 it('still fails visibly when the player never confirms an ended response',async()=>{
  vi.useFakeTimers();const f=fixture();f.ready();f.begin();
  f.socket.server({type:'response.audio.delta',response_id:'r1',delta:Buffer.alloc(24000*2).toString('base64')});
  f.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
  await vi.advanceTimersByTimeAsync(12000);
  expect(f.events.some(e=>e.kind==='state'&&e.state==='error')).toBe(true);
  expect(f.onPlayback).not.toHaveBeenCalled();
 });
 it('records an accepted asynchronous task without generating a second spoken plan',async()=>{
  const f=fixture(false,true);f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'填写代号'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'accepted',arguments:'{"action":"start"}'});
  await vi.waitFor(()=>expect(f.dispatchTask).toHaveBeenCalledTimes(1));
  f.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
  expect(f.socket.sent.some(x=>x.item?.type==='function_call_output')).toBe(true);
  expect(f.socket.sent.some(x=>x.type==='response.create')).toBe(false);
 });
 it('surfaces provider warnings and stops visibly after bounded busy retries',()=>{
  const f=fixture();f.ready();f.socket.server({type:'error',error:{code:'temporary_warning',message:'暂时无法生成'}});
  expect(f.events).toContainEqual(expect.objectContaining({kind:'state',state:'answering',detail:'语音服务提示：暂时无法生成'}));

  for(let i=0;i<4;i++)f.socket.server({type:'error',event_id:`busy-${i}`,error:{code:'response_already_active',message:'busy'}});
  expect(f.events.some(e=>e.kind==='state'&&e.state==='error'&&e.detail?.includes('后台任务保留'))).toBe(true);expect(f.route).not.toHaveBeenCalled();
 });
 it('cannot dispatch pending input after the provider disconnects',async()=>{
  vi.useFakeTimers();const f=fixture();f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,contextPending:true});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'翻译文章'});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'pending',response_id:'r1',name:'browser_request',arguments:'{}'});
  await vi.advanceTimersByTimeAsync(20);f.socket.emit('close',1006,Buffer.from('disconnected'));
  f.session.command({kind:'input_context',turn:2,input:{context:{tabId:7,title:'文章',url:'https://example.test'}}});
  await vi.advanceTimersByTimeAsync(100);expect(f.route).not.toHaveBeenCalled();
  expect(f.events).toContainEqual(expect.objectContaining({kind:'state',state:'error',recoverable:true}));
 });
 it('accepts the official response.done tool-output path once, including dual event delivery',async()=>{
  const f=fixture();f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'response.done',response:{id:'r1',status:'completed',output:[{type:'function_call',name:'read_page',call_id:'complete-call',arguments:'{}'}]}});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'read_page',call_id:'complete-call',arguments:'{}'});
  await vi.waitFor(()=>expect(f.readPage).toHaveBeenCalledTimes(1));
 });
 it('does not execute cancelled response output',async()=>{
  const f=fixture();f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{}});
  f.socket.server({type:'response.done',response:{id:'r1',status:'cancelled',output:[{type:'function_call',name:'read_page',call_id:'cancelled-call',arguments:'{}'}]}});
  await Promise.resolve();expect(f.readPage).not.toHaveBeenCalled();
 });
 it('structured task action dispatches actual ASR with observed identity, without the old classifier',async()=>{
  const f=fixture(false,true);f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'},observation:{token:'private',tabId:7}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'按页面要求查找信息，不要提交'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'task-call',arguments:JSON.stringify({action:'start'})});
  await vi.waitFor(()=>expect(f.dispatchTask).toHaveBeenCalledTimes(1));
  expect(f.dispatchTask.mock.calls[0]?.[0]).toMatchObject({source:'voice',conversationId:'A',expectedRunId:null,action:'start',text:'按页面要求查找信息，不要提交',context:{tabId:7}});
  expect(f.dispatchTask.mock.calls[0]?.[0]).not.toHaveProperty('observation');expect(f.route).not.toHaveBeenCalled();
 });
 it.each([{action:'start',text:'替换原话'},{action:'abort'},{action:'pause',targetId:'invented'}])('rejects invalid structured task arguments %j',async(args)=>{
  const f=fixture(false,true);f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'暂停任务'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'bad-task',arguments:JSON.stringify(args)});
  await new Promise(r=>setTimeout(r,25));expect(f.dispatchTask).not.toHaveBeenCalled();expect(f.route).not.toHaveBeenCalled();
 });
 it('does not expose structured task dispatch without explicit enablement or in diagnostic mode',()=>{
  const normal=fixture();normal.ready();const diagnostic=fixture(true,true);diagnostic.ready();
  expect(normal.socket.sent[0].session.tools.some((t:any)=>t.function?.name==='task_action')).toBe(false);
  expect(diagnostic.socket.sent[0].session.tools).toEqual([]);
 });
 it.each([true,false])('a task notice needs provider acceptance and actual audio before played=%s',async(audio)=>{
  const f=fixture();f.ready();f.snapshot.runId='run1';
  f.session.completeDelivery({id:'delivery1',runId:'run1',kind:'finding',text:'实际结果'});
  const notice=f.socket.sent.find(x=>x.item?.id?.startsWith('bys-notice-'));
  expect(notice.item.role).toBe('user');expect(f.socket.sent.some(x=>x.type==='response.create')).toBe(false);
  f.socket.server({type:'conversation.item.created',item:{id:notice.item.id,type:'message',role:'user'}});
  expect(f.socket.sent.some(x=>x.type==='response.create')).toBe(true);
  f.socket.server({type:'response.created',response:{id:'notice-response'}});

  if(audio)f.socket.server({type:'response.audio.delta',response_id:'notice-response',delta:Buffer.alloc(960).toString('base64')});
  f.socket.server({type:'response.done',response:{id:'notice-response',status:'completed'}});
  f.session.command({kind:'playback_done',responseId:'notice-response'});
  expect(f.onPlayback.mock.calls.some(c=>c[0]==='delivery1'&&c[1]==='played')).toBe(audio);
 });
 it('rejected task notice never manufactures a delivered response',()=>{
  const f=fixture();f.ready();f.snapshot.runId='run1';f.session.completeDelivery({id:'delivery1',runId:'run1',kind:'finding',text:'结果'});
  f.socket.server({type:'error',error:{code:'400',message:'item rejected'}});
  expect(f.socket.sent.some(x=>x.type==='response.create')).toBe(false);expect(f.onPlayback).not.toHaveBeenCalled();
  expect(f.events.some(e=>e.kind==='state'&&e.state==='error')).toBe(true);
 });
 it.each(['partial','unverified'] as const)('does not speak a completion claim from a %s delivery',outcome=>{
  const f=fixture();f.ready();f.snapshot.runId='run1';
  f.session.completeDelivery({id:'uncertain',runId:'run1',kind:'finding',text:'已经切到资料页了。',facts:{outcome,delivered:[],remaining:[],sources:[]}});
  const notice=f.socket.sent.find(x=>x.item?.id?.startsWith('bys-notice-'));
  expect(notice.item.content[0].text).not.toContain('已经切到资料页');
  expect(notice.item.content[0].text).toContain('还没确认');
 });
 it('keeps the originating task name in an uncertain background-task notice',()=>{
  const f=fixture();f.ready();
  (f.session as any).deps.getDeliverySnapshot=()=>({...f.snapshot,conversationId:'B',runId:'other-run',goal:'整理资料'});
  f.session.completeDelivery({id:'background',runId:'other-run',kind:'finding',text:'全部完成',facts:{outcome:'unverified',delivered:[],remaining:[],sources:[]}});
  const notice=f.socket.sent.find(x=>x.item?.id?.startsWith('bys-notice-'));
  expect(notice.item.content[0].text).toContain('整理资料');
  expect(notice.item.content[0].text).not.toContain('全部完成');
 });
 it.each([false,true,'new-request'])('retains an undispatched late transcript but combines only explicitly requested same-page continuation (mode=%s)',async(changed)=>{
  vi.useFakeTimers();const f=fixture(false,true);f.ready();f.begin('first','r1');
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'early',arguments:'{"action":"start"}'});
  f.begin('second','r2');f.session.command({kind:'commit',turn:3,input:{context:{tabId:changed===true?8:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'first',transcript:'填写代号并勾选条件'});
  await vi.advanceTimersByTimeAsync(3100);expect(f.dispatchTask).not.toHaveBeenCalled();
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'second',transcript:'不要保存，也不要提交'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r2',name:'task_action',call_id:'current',arguments:JSON.stringify({action:'start',includePending:changed!=='new-request'})});
  await vi.advanceTimersByTimeAsync(30);

  if(changed===true)expect(f.dispatchTask).not.toHaveBeenCalled();
  else {expect(f.dispatchTask).toHaveBeenCalledTimes(1);expect(f.dispatchTask.mock.calls[0]?.[0]).toMatchObject({text:changed==='new-request'?'不要保存，也不要提交':'填写代号并勾选条件\n不要保存，也不要提交'});}
 });
 it('does not attach previous ordinary conversation to a new task',async()=>{
  const f=fixture(false,true);f.ready();f.begin('greet','r1');f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'greet',transcript:'你好'});
  f.begin('task','r2');f.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'task',transcript:'填写字段'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r2',name:'task_action',call_id:'new',arguments:'{"action":"start"}'});
  await vi.waitFor(()=>expect(f.dispatchTask).toHaveBeenCalledTimes(1));expect(f.dispatchTask.mock.calls[0]?.[0]).toMatchObject({text:'填写字段'});
 });
 it('manual stop only cancels speech, never dispatches a task control',()=>{const f=fixture();f.ready();f.begin();f.session.command({kind:'interrupt',turn:2});expect(f.socket.sent.some(x=>x.type==='response.cancel')).toBe(true);expect(f.route).not.toHaveBeenCalled();});
 it('diagnostic mode has no tools or task routes and requires explicit audio commit',async()=>{
  const f=fixture(true);f.ready();expect(f.socket.sent[0].session.tools).toEqual([]);expect(f.socket.sent[0].session.turn_detection).toBeNull();
  expect(f.events).toContainEqual({kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:60}});
  f.session.command({kind:'interrupt',turn:1});f.session.command({kind:'audio',turn:1,data:Buffer.alloc(960).toString('base64')});f.session.command({kind:'commit',turn:1});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'evil',name:'browser_request',arguments:'{}'});await Promise.resolve();expect(f.route).not.toHaveBeenCalled();expect(f.socket.sent.some(x=>x.type==='input_audio_buffer.commit')).toBe(true);
 });
 it('route-shadow: observes each settled user transcript with previous utterances, task state and page, and never blocks routing',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(false,false,shadow);f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'填写代号'});
  expect(f.route).not.toHaveBeenCalled(); // shadow observation must never itself trigger real routing
  expect(shadow.judge).toHaveBeenCalledTimes(1);
  expect(shadow.judge).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',inputId:'u1',text:'填写代号',previous:[],taskRunning:false,taskState:'none',page:{title:'Page',url:'https://example.test'}},false);
  f.begin('second','r2');f.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'second',transcript:'不要保存'});
  expect(shadow.judge).toHaveBeenCalledTimes(2);
  expect(shadow.judge.mock.calls[1]?.[0]).toMatchObject({turn:3,itemId:'second',text:'不要保存',previous:['填写代号']});
 });
 it('route-shadow: records nothing in diagnostic mode even with a shadow configured',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(true,true,shadow);f.ready();
  f.session.command({kind:'interrupt',turn:1});f.session.command({kind:'audio',turn:1,data:Buffer.alloc(960).toString('base64')});f.session.command({kind:'commit',turn:1});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'d1',transcript:'诊断语句'});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'evil',name:'browser_request',arguments:'{}'});
  await Promise.resolve();
  expect(shadow.judge).not.toHaveBeenCalled();expect(shadow.actual).not.toHaveBeenCalled();
 });
 it('route-shadow: records a tool actual for read_page, task_status and browser_request, bound to the latest user item',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(false,false,shadow);f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'读一下页面'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'read_page',call_id:'call-read',arguments:'{}'});
  await vi.waitFor(()=>expect(f.readPage).toHaveBeenCalledTimes(1));
  expect(shadow.actual).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',kind:'tool',name:'read_page'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_status',call_id:'call-status',arguments:'{}'});
  await vi.waitFor(()=>expect(shadow.actual).toHaveBeenCalledWith(expect.objectContaining({kind:'tool',name:'task_status'})));
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'browser_request',call_id:'call-browser',arguments:'{"text":"打开这个"}'});
  await vi.waitFor(()=>expect(f.route).toHaveBeenCalledTimes(1));
  expect(shadow.actual).toHaveBeenCalledWith(expect.objectContaining({kind:'tool',name:'browser_request'}));
 });
 it('route-shadow: records a task_action tool actual and the dispatch outcome once dispatchTask resolves',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(false,true,shadow);f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'填写代号'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'accepted',arguments:'{"action":"start"}'});
  await vi.waitFor(()=>expect(f.dispatchTask).toHaveBeenCalledTimes(1));
  expect(shadow.actual).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',kind:'tool',name:'task_action',action:'start'});
  await vi.waitFor(()=>expect(shadow.actual).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',kind:'dispatch',action:'start',status:'accepted'}));
 });
 it('route-shadow: attributes the dispatch actual to the requesting turn/item even if a new turn starts before it resolves',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(false,true,shadow);f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'填写代号'});
  let resolveDispatch!:(value:{ok:boolean;status:string})=>void;
  f.dispatchTask.mockImplementation(()=>new Promise<{ok:boolean;status:string}>(resolve=>{resolveDispatch=resolve;}));
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'task_action',call_id:'accepted',arguments:'{"action":"start"}'});
  await vi.waitFor(()=>expect(f.dispatchTask).toHaveBeenCalledTimes(1));
  // A new turn begins, with its own transcript, while the dispatch above is still pending.
  f.begin('second','r2');f.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'second',transcript:'新的一句'});
  resolveDispatch({ok:true,status:'applied'});
  await vi.waitFor(()=>expect(shadow.actual).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',kind:'dispatch',action:'start',status:'applied'}));
 });
 it('route-shadow: never carries a previous turn itemId into a tool actual for a new turn without its own transcript',async()=>{
  const shadow={judge:vi.fn(),actual:vi.fn()};
  const f=fixture(false,false,shadow);f.ready();f.begin();
  f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'读一下页面'});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r1',name:'read_page',call_id:'call-read',arguments:'{}'});
  await vi.waitFor(()=>expect(shadow.actual).toHaveBeenCalledWith({channel:'voice',conversationId:'A',voiceId:'voice3',turn:2,itemId:'u1',kind:'tool',name:'read_page'}));
  shadow.actual.mockClear();
  // Turn 3 starts and its page context arrives, but no transcript for turn 3 exists yet.
  f.begin('second','r2');f.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'Page',url:'https://example.test'}}});
  f.socket.server({type:'response.function_call_arguments.done',response_id:'r2',name:'read_page',call_id:'call-read-2',arguments:'{}'});
  await vi.waitFor(()=>expect(shadow.actual).toHaveBeenCalledTimes(1));
  const recorded=shadow.actual.mock.calls[0]?.[0] as Record<string,unknown>;
  expect(recorded).toMatchObject({turn:3,kind:'tool',name:'read_page'});
  expect(recorded.itemId).toBeUndefined();
 });
});
