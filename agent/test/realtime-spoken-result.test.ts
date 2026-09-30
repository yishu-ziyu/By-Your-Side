/** Realtime 3 语音会话的通用回归（原 Jev 播报闸门已随本机模式退役）。 */
import {afterEach, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';
import {MODEL, STEP_VOICE} from '../src/realtime-voice-connection.js';
import {classifyDirectExecutionFeedback} from '../../shared/execution-feedback.js';

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

const cleanups: (() => void)[] = [];

afterEach(() => { cleanups.splice(0).forEach(f => f()); vi.useRealTimers(); });

const drain = async () => { for (let i=0;i<30;i++) await Promise.resolve(); };

function harness(options: {result?: any; delegate?: boolean} = {}) {
  const socket = new Socket(), events: any[] = [], logs: any[] = [], capsules: any[] = [];

  const tool = vi.fn(async (call: any) => {
    // 浏览器边界替身：默认回执带执行后读回的核验事实（实际活动页 8、窗口聚焦、工作目标一致）。
    const result = options.result ?? {ok:true,executionFact:'executed',data:{tabId:8,
      verification:{verified:true,activeTabId:8,windowId:1,windowFocused:true,workingTabId:8}}};

    const feedback = classifyDirectExecutionFeedback({tool:call.name,args:call.args,executionFact:result.executionFact,
      data:result.data,failed:result.ok===false,inputId:call.inputId,toolCallId:call.callId});

    if(feedback) capsules.push(feedback);

    return {...result,feedback};
  });

  const sessionDeps: ConstructorParameters<typeof RealtimeVoiceSession>[0] = {voiceId:'v23',
    getSnapshot:()=>({conversationId:'c',state:'idle'} as any),emit:e=>events.push(e),
    diagnostic:(type,fields)=>logs.push({type,...JSON.parse(String(fields?.detail ?? '{}'))}),
    browserTool:tool,connect:()=>socket as any};

  if(options.delegate)sessionDeps.dispatchTask=async()=>({ok:true,status:'accepted'});
  const session = new RealtimeVoiceSession(sessionDeps);

  cleanups.push(()=>session.close());session.start('offline-key');
  socket.server({type:'session.created',session:{model:MODEL}});
  socket.server({type:'session.updated',session:{model:MODEL,voice:STEP_VOICE,input_audio_format:'pcm16',output_audio_format:'pcm16',turn_detection:{type:'server_vad'}}});
  const asr = (id='u1',text='切到测试标签页。') => socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:id,transcript:text});

  const begin = (n=1,text='切到测试标签页。') => {
    socket.server({type:'input_audio_buffer.speech_started',item_id:`u${n}`});
    session.command({kind:'commit',turn:n+1,input:{context:{tabId:7,title:'测试',url:'https://example.test'}}});
    socket.server({type:'input_audio_buffer.speech_stopped',item_id:`u${n}`});
    socket.server({type:'response.created',response:{id:`r${n}`}});asr(`u${n}`,text);
  };

  const call = (id='c1',args:unknown={action:'switch',tabId:8},rid='r1',name='tabs') => socket.server({type:'response.function_call_arguments.done',response_id:rid,call_id:id,name,arguments:JSON.stringify(args)});
  const done = (id='r1',extra:Record<string, Json>={}) => socket.server({type:'response.done',response:{id,status:'completed',...extra}});
  const audio = (id='a1') => socket.server({type:'response.audio.delta',response_id:id,delta:'AAAA'});
  const final = (text:string,id='a1') => socket.server({type:'response.audio_transcript.done',response_id:id,transcript:text});
  const created = (id='a1') => socket.server({type:'response.created',response:{id}});

  return {socket,events,logs,capsules,tool,session,asr,begin,call,done,audio,final,created,
    outputs:()=>socket.sent.filter(e=>e.item?.type==='function_call_output'),creates:()=>socket.sent.filter(e=>e.type==='response.create')};
}

it('A7 general regression: late authoritative final is idempotent; audio streams without text',async()=>{
  const h=harness();h.begin();h.audio('r1');
  h.socket.server({type:'response.audio_transcript.delta',response_id:'r1',delta:'切好了'});h.done();h.done();
  expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
  expect(h.events.filter(e=>e.kind==='response_end')).toHaveLength(1);
  h.final('切好了，一加一等于二','r1');h.final('切好了，一加一等于二','r1');
  expect(h.events.filter(e=>e.kind==='text'&&e.text==='切好了，一加一等于二')).toHaveLength(1);
});

it('A7 generation done releases tools before playback; stop suppresses later audio without replay',async()=>{
  const h=harness();h.begin();h.audio('r1');h.call();h.done();await drain();
  expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  h.created();h.session.command({kind:'interrupt',turn:2});h.audio();h.done('a1',{status:'cancelled'});
  expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);expect(h.events.some(e=>e.kind==='reset_output')).toBe(true);
  h.begin(2);h.audio('r2');expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(2);
});
