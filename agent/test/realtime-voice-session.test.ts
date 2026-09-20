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
function fixture(diagnosticMode=false){
  const socket=new Socket(),events:VoiceEvent[]=[];
  const snapshot:TaskProgressSnapshot={conversationId:'A',runId:null,state:'none',goal:null,startedAt:null,observedAt:1,active:[],lastAction:null,successVerified:false};
  const route=vi.fn(async(..._args:unknown[])=>({kind:'action' as const,ok:true,message:'已接收，不代表完成'}));const readPage=vi.fn(async()=>({text:'真实页面'}));
  const session=new RealtimeVoiceSession({voiceId:'voice3',diagnosticMode,getSnapshot:()=>snapshot,emit:e=>events.push(e),route,readPage,connect:()=>socket as any});sessions.push(session);session.start('not-a-real-key');
  const ready=()=>{socket.server({type:'session.created',session:{model:MODEL}});socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:diagnosticMode?{type:''}:{type:'server_vad'}}});};
  const begin=(item='u1',response='r1')=>{socket.server({type:'input_audio_buffer.speech_started',item_id:item});socket.server({type:'input_audio_buffer.speech_stopped',item_id:item});socket.server({type:'response.created',response:{id:response}});};
  return {session,socket,events,route,readPage,ready,begin,snapshot};
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
 it('does not send tool output until real playback_done, nor mark accepted as finished',async()=>{
  const f=fixture();f.ready();f.begin();f.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'文章',url:'https://example.test'}}});
  f.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u1',transcript:'翻译文章'});
  f.socket.server({type:'response.audio.delta',response_id:'r1',delta:Buffer.alloc(960).toString('base64')});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'c1',response_id:'r1',name:'browser_request',arguments:'{}'});await Promise.resolve();await Promise.resolve();await Promise.resolve();
  f.socket.server({type:'response.done',response:{id:'r1',status:'completed'}});
  expect(f.socket.sent.some(x=>x.item?.type==='function_call_output')).toBe(false);
  f.session.command({kind:'playback_done',responseId:'r1'});await Promise.resolve();await Promise.resolve();
  await vi.waitFor(()=>expect(f.socket.sent.find(x=>x.item?.type==='function_call_output')?.item.output).toContain('不代表完成'));
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
 it('manual stop only cancels speech, never dispatches a task control',()=>{const f=fixture();f.ready();f.begin();f.session.command({kind:'interrupt',turn:2});expect(f.socket.sent.some(x=>x.type==='response.cancel')).toBe(true);expect(f.route).not.toHaveBeenCalled();});
 it('diagnostic mode has no tools or task routes and requires explicit audio commit',async()=>{
  const f=fixture(true);f.ready();expect(f.socket.sent[0].session.tools).toEqual([]);expect(f.socket.sent[0].session.turn_detection).toBeNull();
  expect(f.events).toContainEqual({kind:'diag',record:{type:'ready',sampleRate:24000,maxSeconds:60}});
  f.session.command({kind:'interrupt',turn:1});f.session.command({kind:'audio',turn:1,data:Buffer.alloc(960).toString('base64')});f.session.command({kind:'commit',turn:1});
  f.socket.server({type:'response.function_call_arguments.done',call_id:'evil',name:'browser_request',arguments:'{}'});await Promise.resolve();expect(f.route).not.toHaveBeenCalled();expect(f.socket.sent.some(x=>x.type==='input_audio_buffer.commit')).toBe(true);
 });
});
