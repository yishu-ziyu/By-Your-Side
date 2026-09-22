import {afterEach, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';
import {MODEL, STEP_VOICE} from '../src/realtime-voice-connection.js';
import {RouteShadow} from '../src/route-shadow.js';
import {classifyDirectExecutionFeedback} from '../../shared/execution-feedback.js';

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
const answers = (spoken = 0.1, page = 0.95, lane = 'task') => ({lane_0:{choice:lane},pagechange_0:{noul:page},spoken_result_0:{noul:spoken}});
const response = (value: unknown = answers()) => ({ok:true,json:async()=>({answers:value})}) as Response;

function harness(options: {gate?: boolean; shadow?: boolean; fetch?: typeof fetch; key?: string; limit?: number; result?: any; delegate?: boolean} = {}) {
  const socket = new Socket(), events: any[] = [], logs: any[] = [], capsules: any[] = [];
  const root = mkdtempSync(join(tmpdir(),'bys-v23-'));
  const fetchMock = vi.fn(options.fetch ?? (async()=>response()));
  const shadow = new RouteShadow({enabled:()=>options.shadow ?? false,dailyLimit:()=>options.limit ?? 100,root,
    key:()=>options.key ?? 'offline-key',fetch:fetchMock});
  const tool = vi.fn(async (call: any) => {
    // 浏览器边界替身：默认回执带执行后读回的核验事实（实际活动页 8、窗口聚焦、工作目标一致）。
    const result = options.result ?? {ok:true,executionFact:'executed',data:{tabId:8,
      verification:{verified:true,activeTabId:8,windowId:1,windowFocused:true,workingTabId:8}}};
    const feedback = classifyDirectExecutionFeedback({tool:call.name,args:call.args,executionFact:result.executionFact,
      data:result.data,failed:result.ok===false,inputId:call.inputId,toolCallId:call.callId});
    if(feedback) capsules.push(feedback);
    return {...result,feedback};
  });
  const session = new RealtimeVoiceSession({voiceId:'v23',voiceSpokenResultGate:options.gate ?? true,shadow,
    getSnapshot:()=>({conversationId:'c',state:'idle'} as any),emit:e=>events.push(e),
    ...(options.delegate?{dispatchTask:async()=>({ok:true,status:'accepted'})}:{}),
    diagnostic:(type,fields)=>logs.push({type,...JSON.parse(String(fields?.detail ?? '{}'))}),
    browserTool:tool,connect:()=>socket as any});
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
  const done = (id='r1',extra:object={}) => socket.server({type:'response.done',response:{id,status:'completed',...extra}});
  const audio = (id='a1') => socket.server({type:'response.audio.delta',response_id:id,delta:'AAAA'});
  const final = (text:string,id='a1') => socket.server({type:'response.audio_transcript.done',response_id:id,transcript:text});
  const created = (id='a1') => socket.server({type:'response.created',response:{id}});
  return {socket,events,logs,capsules,fetchMock,tool,session,asr,begin,call,done,audio,final,created,
    outputs:()=>socket.sent.filter(e=>e.item?.type==='function_call_output'),creates:()=>socket.sent.filter(e=>e.type==='response.create'),
    audit:()=>readdirSync(root).flatMap(f=>readFileSync(join(root,f),'utf8').trim().split('\n').map(l=>JSON.parse(l)))};
}

it.each([false,true])('A1/A2 gate enabled with shadow=%s: one request, list then switch stops at capsule, next question has audio',async shadow=>{
  const h=harness({shadow});h.begin();h.asr();await drain();
  expect(h.fetchMock).toHaveBeenCalledTimes(1);
  const body=JSON.parse(String(h.fetchMock.mock.calls[0]![1]!.body));
  expect(Object.keys(body.questions).sort()).toEqual(['lane_0','pagechange_0','spoken_result_0']);
  h.call('list',{action:'list'});h.done();await drain();
  expect(h.creates()).toHaveLength(1);expect(h.capsules).toHaveLength(0);
  h.created('switch');h.call('switch',{action:'switch',tabId:8},'switch');h.call('switch',{action:'switch',tabId:8},'switch');h.done('switch');h.done('switch');await drain();
  expect(h.outputs().map(o=>o.item.call_id)).toEqual(['list','switch']);
  expect(h.capsules).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  expect(h.logs.filter(l=>l.type==='spoken_result_gate').at(-1)).toMatchObject({applied:true,inputId:'u1'});
  expect(h.audit().find(r=>r.type==='utterance')).toMatchObject({voiceId:'v23',turn:2,itemId:'u1',inputId:'u1',completedAt:expect.any(Number)});
  h.begin(2,'一加一等于几');h.audio('r2');h.final('一加一等于二','r2');h.done('r2');
  expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
  expect(h.events.filter(e=>e.kind==='text'&&e.text==='一加一等于二')).toHaveLength(1);
});

it('A2 回显一致但实际未激活：及时的胶囊足够判断也不闭合，保留正常续答',async()=>{
  // 浏览器边界替身：请求 8、回包目标 8（回显一致），但执行后读回显示实际活动页仍是 7。
  const h=harness({shadow:true,result:{ok:true,executionFact:'executed',data:{tabId:8,
    verification:{verified:false,activeTabId:7,windowId:1,windowFocused:true,workingTabId:8}}}});
  h.begin();await drain();
  h.call();h.done();await drain();
  expect(h.outputs()).toHaveLength(1);
  expect(h.capsules).toHaveLength(1);
  expect(h.capsules[0]).toMatchObject({kind:'unknown',text:'结果待确认',capsuleCanCloseAction:false});
  expect(h.capsules[0]!.facts.executionFact).toBe('executed');
  // 判断已及时到达（pageChange 0.95/spoken 0.1 胶囊足够），也不能凭错误成功回执结束语音续答。
  expect(h.creates()).toHaveLength(1);
  expect(h.logs.filter(l=>l.type==='spoken_result_gate').at(-1)).toMatchObject({applied:false,reason:'execution_requires_continuation'});
});

it.each([0.21,0.97])('A3 composite spokenResult=%s keeps answer audio',async spoken=>{
  const h=harness({fetch:async()=>response(answers(spoken))});h.begin(1,'切到标签页，再告诉我一加一等于几');await drain();
  h.call();h.done();await drain();expect(h.creates()).toHaveLength(1);expect(h.capsules).toHaveLength(1);
  h.created();h.final('一加一等于二');h.audio();h.done('a1');expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
});

it.each([
  {ok:false,executionFact:'not_executed',data:{}},
  {ok:true,executionFact:'unknown',data:{tabId:8}},
  {ok:false,executionFact:'not_executed',data:{held:true}},
  {ok:true,executionFact:'executed',data:{}},
  {ok:true,executionFact:'executed',data:{tabId:7}},
])('A4 execution fact cannot be upgraded: %j',async result=>{
  const h=harness({result});h.begin();await drain();h.call();h.done();await drain();
  expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  expect(h.logs.filter(l=>l.type==='spoken_result_gate').at(-1)?.applied).toBe(false);
});
it('A4 mixed batch including observation cannot end at capsule',async()=>{
  const h=harness();h.begin();await drain();h.call();h.call('snapshot',{},'r1','snapshot');h.done();await drain();
  expect(h.outputs()).toHaveLength(2);expect(h.creates()).toHaveLength(1);
});

it.each(['timeout','no_credential','daily_limit','invalid','out_of_range'] as const)('A5 %s fails open',async failure=>{
  const h=harness({key:failure==='no_credential'?'':undefined,limit:failure==='daily_limit'?0:100,
    fetch:async()=>{if(failure==='timeout')throw new DOMException('timeout','TimeoutError');return response(failure==='invalid'?{}:answers(failure==='out_of_range'?-1:0.1));}});
  h.begin();await drain();h.call();h.done();await drain();expect(h.creates()).toHaveLength(1);
  h.created();h.audio();expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
});
it('A5/A6 pending Jev does not block tools/outputs/first audio; late result never cancels or discards',async()=>{
  let resolve!:(r:Response)=>void;const h=harness({fetch:()=>new Promise(r=>{resolve=r;})});
  h.begin();h.call();h.done();await drain();
  expect(h.tool).toHaveBeenCalledTimes(1);expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  h.created();h.audio();expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
  resolve(response());await drain();h.audio();expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(2);
  expect(h.socket.sent.some(e=>e.type==='response.cancel')).toBe(false);expect(h.events.some(e=>e.kind==='reset_output')).toBe(false);
});
it('A5 late old judgment and visible old ASR cannot belong to the next input',async()=>{
  let resolve!:(r:Response)=>void;const h=harness({fetch:()=>new Promise(r=>{resolve=r;})});
  h.begin();h.begin(2,'切到另一个标签页');h.asr('u1','旧句补全');resolve(response());await drain();
  h.call('new',{action:'switch',tabId:8},'r2');h.done('r2');await drain();
  // Two pending requests: resolve is the new request, whose original input remains u2.
  expect(h.fetchMock).toHaveBeenCalledTimes(2);
  expect(h.events.some(e=>e.kind==='text'&&e.text==='旧句补全'&&e.turn===2)).toBe(true);
  expect(h.audit().filter(r=>r.type==='utterance')[0]).toMatchObject({itemId:'u2',turn:3});
});
it('A5 old judgment after new turn is ignored, including when new VAD omits itemId',async()=>{
  let resolve!:(r:Response)=>void;const h=harness({fetch:()=>new Promise(r=>{resolve=r;})});
  h.begin();h.socket.server({type:'input_audio_buffer.speech_started'});
  h.session.command({kind:'commit',turn:3,input:{context:{tabId:7,title:'测试',url:'https://example.test'}}});
  h.socket.server({type:'input_audio_buffer.speech_stopped'});h.created('r2');
  h.asr('u1');resolve(response());await drain();
  expect(h.fetchMock).toHaveBeenCalledTimes(1);
  h.asr('u2','切到另一个标签页');h.call('new',{action:'switch',tabId:8},'r2');h.done('r2');await drain();
  expect(h.creates()).toHaveLength(1);
});
it('A5 changed final text invalidates original judgment without a second request',async()=>{
  const h=harness();h.begin();await drain();h.asr('u1','切到测试标签页，再回答问题');h.call();h.done();await drain();
  expect(h.fetchMock).toHaveBeenCalledTimes(1);expect(h.creates()).toHaveLength(1);
});
it('A5 closed session ignores completion',async()=>{
  let resolve!:(r:Response)=>void;const h=harness({fetch:()=>new Promise(r=>{resolve=r;})});h.begin();h.session.close();
  const before=h.events.length;resolve(response());await drain();expect(h.events).toHaveLength(before);expect(h.creates()).toHaveLength(0);
});
it.each([false,true])('A8 gate off preserves normal continuation with shadow=%s',async shadow=>{
  const h=harness({gate:false,shadow});h.begin();await drain();h.call();h.done();await drain();expect(h.creates()).toHaveLength(1);
  expect(h.fetchMock).toHaveBeenCalledTimes(shadow?1:0);h.created();h.audio();expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
});

it('A7 general regression: late authoritative final is idempotent; audio streams without text',async()=>{
  const h=harness({gate:false});h.begin();h.audio('r1');
  h.socket.server({type:'response.audio_transcript.delta',response_id:'r1',delta:'切好了'});h.done();h.done();
  expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);
  expect(h.events.filter(e=>e.kind==='response_end')).toHaveLength(1);
  h.final('切好了，一加一等于二','r1');h.final('切好了，一加一等于二','r1');
  expect(h.events.filter(e=>e.kind==='text'&&e.text==='切好了，一加一等于二')).toHaveLength(1);
});
it('A7 generation done releases tools before playback; stop suppresses later audio without replay',async()=>{
  const h=harness({gate:false});h.begin();h.audio('r1');h.call();h.done();await drain();
  expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  h.created();h.session.command({kind:'interrupt',turn:2});h.audio();h.done('a1',{status:'cancelled'});
  expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(1);expect(h.events.some(e=>e.kind==='reset_output')).toBe(true);
  h.begin(2);h.audio('r2');expect(h.events.filter(e=>e.kind==='audio')).toHaveLength(2);
});


it.each([
  [0.20,0.80,'task',0], [0.20,0.79,'task',1], [0.20,0.80,'answer',1],
  [0.20,1.01,'task',1], [Number.NaN,0.95,'task',1],
])('policy boundary spoken=%s page=%s lane=%s',async(spoken,page,lane,creates)=>{
  const h=harness({fetch:async()=>response(answers(Number(spoken),Number(page),String(lane)))});
  h.begin();await drain();h.call();h.done();await drain();expect(h.creates()).toHaveLength(Number(creates));
});
it('old completed request cannot authorize a new VAD-bound input',async()=>{
  const resolvers: ((r:Response)=>void)[]=[];
  const h=harness({fetch:()=>new Promise(r=>resolvers.push(r))});
  h.begin();h.begin(2);resolvers[0]!(response());await drain();
  h.call('new',{action:'switch',tabId:8},'r2');h.done('r2');await drain();
  expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  resolvers[1]!(response());await drain();expect(h.creates()).toHaveLength(1);
});
it('stop invalidates a request even when its judgment was already ready',async()=>{
  const h=harness();h.begin();await drain();h.session.command({kind:'interrupt',turn:2});
  h.done('r1',{status:'cancelled'});h.created('late');h.call('late',{action:'switch',tabId:8},'late');h.done('late');await drain();
  expect(h.logs.some(l=>l.type==='spoken_result_gate'&&l.applied)).toBe(false);
});
it('A7 source contains no production hold/judge mechanism',()=>{
  const files=['realtime-voice-connection.ts','realtime-voice-session.ts','voice-service.ts'];
  for(const file of files) expect(readFileSync(join('agent/src',file),'utf8')).not.toMatch(/quietJudge|heldQuiets|QUIET_HOLD_BUDGET_MS|audio_held_quiet_confirmation|quiet_budget_expired/);
});

it('stop before final ASR prevents a later same-turn judgment from closing an action',async()=>{
  const h=harness();
  h.socket.server({type:'input_audio_buffer.speech_started',item_id:'u1'});
  h.session.command({kind:'commit',turn:2,input:{context:{tabId:7,title:'测试',url:'https://example.test'}}});
  h.socket.server({type:'input_audio_buffer.speech_stopped',item_id:'u1'});h.created('r1');
  h.session.command({kind:'interrupt',turn:2});h.done('r1',{status:'cancelled'});
  h.asr();await drain();h.created('late');h.call('late',{action:'switch',tabId:8},'late');h.done('late');await drain();
  expect(h.outputs()).toHaveLength(1);expect(h.creates()).toHaveLength(1);
  expect(h.logs.some(l=>l.type==='spoken_result_gate'&&l.applied)).toBe(false);
});

it('A4 mixed batch with accepted delegated work retains its normal continuation',async()=>{
  const h=harness({delegate:true});h.begin();await drain();h.call();await drain();
  h.call('delegate',{action:'start'},'r1','task_action');h.done();await drain();
  expect(h.capsules).toHaveLength(1);expect(h.outputs()).toHaveLength(2);expect(h.creates()).toHaveLength(1);
  expect(h.logs.filter(l=>l.type==='spoken_result_gate').at(-1)).toMatchObject({applied:false});
});
