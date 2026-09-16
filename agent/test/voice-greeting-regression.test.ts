/**
 * 正确行为回归：2026-09-13 用户说“嗨，晚上好。”后，面板出现固定“任务已收到。”、
 * 后台跑了一整轮页面任务，并且首句只有文字没有声音。原诊断断言（空计划、文字先到丢音频、
 * 两种顺序都应出声）在本文件改写成应然行为，不再把 bug 当契约。
 *
 * A. 一轮 idle 闲聊（chat）仍交给有能力的会话处理，但真实发生的隐式派发要写进计划：
 *    不再是空计划，也不假装“零步=已知单步”；固定“任务已收到。”因此不再出现。
 * B. 语音侧不再在路由出结果之前抢答；音频的“允许播出”与“已经收到音频”分开，
 *    所以文字先到、音频后到时，后到的帧照样播出。
 */
import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';
import {contextualStartAck,receiptSpeech} from '../src/voice-receipt.js';
import type {SpeechCallbacks} from '../src/streaming-tts.js';
import type {UserDeliveryStream} from '../../shared/voice.js';
import type {ServerMessage} from '../../shared/protocol.js';

const sessions:StepVoiceSession[]=[];
afterEach(()=>{sessions.splice(0).forEach(s=>s.close());vi.useRealTimers();});

class Socket extends EventEmitter{
  readyState=1;bufferedAmount=0;sent:any[]=[];
  send=(data:string)=>{this.sent.push(JSON.parse(data));};
  close=vi.fn();
  server(event:object){this.emit('message',Buffer.from(JSON.stringify(event)));}
}

/** 真实 ConversationManager（含生产 VoicePlanStore 包装），classifier 结果由用例注入。 */
function managerHarness(){
  const emitted:ServerMessage[]=[];
  const runtimes=new Map<string,any>();
  const factory=async(id:string,emit:(m:ServerMessage)=>void)=>{
    const runtime:any={
      session:{modelName:()=>'test/model',availableModels:async()=>[],available:true,abort:vi.fn(),isHeld:()=>false,isStreaming:()=>false,persistTaskResults:vi.fn(),
        classifyVoiceInput:vi.fn(async(text:string)=>({steps:[{action:'chat',text,target:null}]})),
        startTask:vi.fn((text:string)=>{emit({type:'agent_event',conversationId:id,event:{kind:'agent_start'}});emit({type:'status',state:'running'});})},
      fleet:{teamView:()=>null,isGroupHeld:()=>false,abortTeam:vi.fn(),reset:vi.fn()},
      rpc:{rejectAll:vi.fn()},dispose:vi.fn(),handleMessage:vi.fn(),
    };
    runtimes.set(id,runtime);return runtime;
  };
  const manager=new ConversationManager(factory as never,m=>emitted.push(m));
  return {manager,runtimes,emitted};
}
const greetingRoute={requestId:'greeting-1',voiceId:'voice-one',turn:1,runId:null};

describe('A 应然：idle 闲聊仍交给有能力的会话，回答归属写清楚',()=>{
  it('隐式派发记成真实的一步 start；不再退回固定“任务已收到。”',async()=>{
    const h=managerHarness();await h.manager.ensureDefault();
    const session=h.runtimes.get('default')!.session;
    const result:any=await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{...greetingRoute});

    // 能力保留：同一句话仍由主 Agent 处理，不是被过滤掉或降级成纯语音闲聊。
    expect(session.classifyVoiceInput).toHaveBeenCalledTimes(1);
    expect(session.startTask).toHaveBeenCalledTimes(1);
    expect(session.startTask).toHaveBeenCalledWith('嗨，晚上好。',undefined,undefined,{pageObservation:'on-demand'});
    expect(result).toMatchObject({kind:'action',ok:true,awaitDelivery:true});
    // 计划记录真实发生的隐式派发（一步 start），不再是空计划。
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]).toMatchObject({action:'start',status:'complete'});
    expect(result.plan?.steps[0].receipt).toMatchObject({action:'start',status:'accepted',text:'嗨，晚上好。'});
    // 回执有原始委托可复用，固定文案不再兜底；回答归属由 awaitDelivery 交给主 Agent。
    expect(contextualStartAck(result)).toBe('嗨，晚上好。');
    expect(receiptSpeech(result)).toBeNull();
  });

  it('对照：普通页面问题仍进入有能力会话',async()=>{
    const h=managerHarness();await h.manager.ensureDefault();
    const session=h.runtimes.get('default')!.session;
    session.classifyVoiceInput.mockResolvedValue({steps:[{action:'observe',text:'这个岗位要求几年经验？',target:null}]});
    const result:any=await h.manager.routeVoiceInput('default','这个岗位要求几年经验？',null,()=>true,{...greetingRoute,requestId:'page-question'});
    expect(session.startTask).toHaveBeenCalledWith('这个岗位要求几年经验？',undefined,undefined);
    expect(result).toMatchObject({kind:'action',ok:true,awaitDelivery:true});
  });
});

/** 真实 StepVoiceSession：route 由用例控制，主 Agent 交付由 streamDelivery 注入。 */
function voiceHarness(){
  const socket=new Socket();const events:any[]=[];const outputs:Array<{cb:SpeechCallbacks;push:ReturnType<typeof vi.fn>;finish:ReturnType<typeof vi.fn>;cancel:ReturnType<typeof vi.fn>}>=[];
  const snapshot:any={conversationId:'A',observedAt:1,state:'running',goal:'嗨，晚上好。',startedAt:1,runId:'run-greeting',controlVersion:0,active:[],lastAction:null,successVerified:false};
  let resolveRoute!:(r:any)=>void;
  const route=vi.fn(()=>new Promise<any>(r=>resolveRoute=r));
  const session=new StepVoiceSession({earlyReplies:true,
    getSnapshot:()=>snapshot,
    route,
    emit:e=>events.push(e),
    createSpeech:(_key,cb)=>{const o={cb,push:vi.fn(),finish:vi.fn(),cancel:vi.fn()};outputs.push(o);return o;},
    connect:()=>socket as unknown as WebSocket});
  sessions.push(session);
  session.start('synthetic-secret');
  socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});
  socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});
  const startTurn=(turn=1,text='嗨，晚上好。')=>{
    session.command({kind:'interrupt',turn});
    session.command({kind:'audio',turn,data:'AQABAA=='});
    session.command({kind:'commit',turn});
    socket.server({type:'input_audio_buffer.committed',item_id:`u${turn}`});
    socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:`u${turn}`,transcript:text});
  };
  const responseCreated=(id='r1')=>{
    const update=socket.sent.filter(e=>e.type==='session.update').at(-1);
    if(update?.session?.instructions)socket.server({type:'session.updated',session:{instructions:update.session.instructions}});
    socket.server({type:'response.created',response:{id}});
  };
  const audioFrames=()=>events.filter(e=>e.kind==='audio');
  const assistantText=()=>events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>(e as any).text);
  const responseCreates=()=>socket.sent.filter(e=>e.type==='response.create').length;
  const delivery=(over:Partial<UserDeliveryStream>={}):UserDeliveryStream=>({id:'answer-1',runId:snapshot.runId,kind:'reply',text:'晚上好呀，我在。',phase:'streaming',...over});
  return {socket,events,outputs,session,route,startTurn,responseCreated,audioFrames,assistantText,responseCreates,delivery,resolve:(r:any)=>resolveRoute(r)};
}

const acceptedGreeting={kind:'action',ok:true,awaitDelivery:true,status:'accepted',message:'已接收新任务',receipts:[{requestId:'greeting-1',conversationId:'A',source:'voice',action:'start',runId:'run-greeting',status:'accepted',text:'嗨，晚上好。',message:'已接收新任务',updatedAt:1}]};

describe('B 应然：内容请求交给主 Agent 时，语音侧不抢答',()=>{
  it('问候交给主 Agent 时没有抢答，也不说“任务已收到”',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    expect(h.responseCreates()).toBe(0);
    expect(h.assistantText()).toEqual([]);
    expect(h.outputs).toHaveLength(0);
  });

  it('分类期间就到的正式交付不吞不重，路由返回后播一次',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.session.streamDelivery(h.delivery({id:'answer-during-route'}));
    expect(h.outputs).toHaveLength(0);
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('晚上好呀，我在。');
    h.session.completeDelivery({id:'answer-during-route',runId:'run-greeting',kind:'reply',text:'晚上好呀，我在。'});
    h.session.streamDelivery(h.delivery({id:'answer-during-route'}));
    h.session.completeDelivery({id:'answer-during-route',runId:'run-greeting',kind:'reply',text:'晚上好呀，我在。'});
    expect(h.outputs).toHaveLength(1); // 同一交付迟到/重复不再播第二次
  });

  it('路由返回后才到的正式交付直接出声',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    expect(h.outputs).toHaveLength(0);
    h.session.streamDelivery(h.delivery({id:'answer-after-route'}));
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('晚上好呀，我在。');
    expect(h.assistantText()).toEqual(['晚上好呀，我在。']);
  });

  it('被打断的旧轮：迟到的正式交付只静音，不再补播',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    h.startTurn(2,'先别看页面');
    h.session.streamDelivery(h.delivery({id:'stale-answer'}));
    expect(h.outputs).toHaveLength(0);
  });

  it.each([true,false])('空白打断后原答案仍播一次，不重新派发（提前到达=%s）',async(early)=>{
    const h=voiceHarness();h.startTurn();h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    h.session.command({kind:'interrupt',turn:2});
    if(early)h.session.completeDelivery(h.delivery({id:'original-answer'}));
    h.session.command({kind:'audio',turn:2,data:'AQABAA=='});
    h.session.command({kind:'commit',turn:2});
    h.socket.server({type:'input_audio_buffer.committed',item_id:'u2'});
    h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:''});
    await Promise.resolve();await Promise.resolve();
    if(!early)h.session.completeDelivery(h.delivery({id:'original-answer'}));
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(h.responseCreates()).toBe(0);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('晚上好呀，我在。');
  });

  it('空白打断发生在路由返回之前，也只恢复正式答案',async()=>{
    const h=voiceHarness();h.startTurn();h.startTurn(2,'');
    h.session.streamDelivery(h.delivery({id:'early-ack',kind:'ack',text:'收到。'}));
    h.resolve({...acceptedGreeting});
    for(let i=0;i<6;i++)await Promise.resolve();
    h.session.completeDelivery(h.delivery({id:'original-answer'}));
    expect(h.route).toHaveBeenCalledTimes(1);
    expect(h.responseCreates()).toBe(0);
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('晚上好呀，我在。');
  });

  it('dispatch 失败时不让归属吞掉错误，仍按回执说明失败',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({kind:'action',ok:false,awaitDelivery:false,status:'rejected',message:'当前执行模型不可用，任务未启动。',receipts:[{requestId:'greeting-1',conversationId:'A',source:'voice',action:'start',runId:null,status:'rejected',text:'嗨，晚上好。',message:'当前执行模型不可用，任务未启动。',updatedAt:1}]});
    await Promise.resolve();await Promise.resolve();
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('当前执行模型不可用，任务未启动。');
  });

  it('主 Agent 自己的开场确认不占出声名额：回执前排队与回执后到达都不播',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    // 回执返回前，主 Agent 自己的 ack 已经排进队列。
    h.session.streamDelivery({id:'own-ack-before',runId:'run-greeting',kind:'ack',text:'收到，我看看。',phase:'streaming'});
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    expect(h.outputs).toHaveLength(0);
    // 回执返回后才到的那条同样不播。
    h.session.streamDelivery({id:'own-ack-after',runId:'run-greeting',kind:'ack',text:'收到，我看看。',phase:'streaming'});
    expect(h.outputs).toHaveLength(0);
    h.session.streamDelivery(h.delivery({id:'answer-after-route'}));
    expect(h.outputs).toHaveLength(1);
    expect(h.outputs[0]!.push).toHaveBeenCalledWith('晚上好呀，我在。');
    expect(h.outputs.flatMap(o=>o.push.mock.calls).flat()).not.toContain('收到，我看看。');
  });

  it('等主 Agent 时保留原来的轮次死线：没有回答会明确超时，不重复下达',async()=>{
    vi.useFakeTimers();
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    expect(h.outputs).toHaveLength(0);
    vi.advanceTimersByTime(30_000);
    const failure=h.events.find(e=>e.kind==='state'&&e.state==='error');
    expect(failure?.detail).toContain('超时');
    expect(h.route).toHaveBeenCalledTimes(1); // 不重新分类、不重复下达任务
    expect(h.outputs).toHaveLength(0);
  });

  it('中途掉线重连后不会再留着“语音侧自己回答”的标记',async()=>{
    vi.useFakeTimers();
    const h=voiceHarness();
    h.startTurn(1,'今天有点累');
    h.resolve({kind:'none',resumeReadOnly:'chat'});
    await Promise.resolve();await Promise.resolve();
    expect(h.responseCreates()).toBe(1);
    // 掉线时那条回答还没建起来：重连必须重新决定归属，不能沿用旧标记。
    h.socket.emit('close',1006);
    vi.advanceTimersByTime(300);
    h.socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});
    h.socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});
    await Promise.resolve();await Promise.resolve();
    h.responseCreated();
    await Promise.resolve();await Promise.resolve();
    h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'嗯，慢慢说，我在这儿。'});
    expect(h.assistantText()).toEqual(['嗯，慢慢说，我在这儿。']);
  });

  /**
   * 低层用例，只钉住会话自身的归属记账：别的 runId 的交付不会顶掉本轮的等待。
   * 生产里跨 run 的交付在 VoiceService.observe 已按 snapshot.runId 拒收，
   * 所以这里不把"别的 run 会播"当成产品要求（也不是验收标准），只要求本轮回答仍交付一次、不被吞。
   */
  it('别的 runId 的交付不会顶掉本轮的等待归属',async()=>{
    const h=voiceHarness();
    h.startTurn(1,'嗨，晚上好。');
    h.resolve({...acceptedGreeting});
    await Promise.resolve();await Promise.resolve();
    h.session.streamDelivery({id:'other-run-finding',runId:'run-other',kind:'finding',text:'另外那个任务有结果了。',phase:'streaming'});
    h.session.streamDelivery(h.delivery({id:'answer-after-route'}));
    h.outputs.forEach(o=>o.cb.audio('AQABAA=='));
    h.session.command({kind:'playback_done',responseId:h.events.find(e=>e.kind==='audio').responseId});
    h.session.command({kind:'playback_done',responseId:h.events.filter(e=>e.kind==='audio').at(-1).responseId});
    const spoken=h.outputs.flatMap(o=>o.push.mock.calls).flat();
    expect(spoken.filter(t=>t==='晚上好呀，我在。')).toHaveLength(1);
  });
});

/** 走“语音侧自己回答”的闲聊（kind=none）：response.created 之后才出现音频/文字。 */
async function chatHarness(){
  const h=voiceHarness();
  h.startTurn(1,'今天有点累');
  h.resolve({kind:'none',resumeReadOnly:'chat'});
  await Promise.resolve();await Promise.resolve();
  h.responseCreated();
  await Promise.resolve();await Promise.resolve();
  return h;
}

describe('C 应然：语音侧自己回答时的音频顺序',()=>{
  it('文字先到、音频后到：后到的帧照样发出',async()=>{
    const h=await chatHarness();
    h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'嗯，慢慢说，我在这儿。'});
    expect(h.assistantText()).toEqual(['嗯，慢慢说，我在这儿。']);
    h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
    h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
    expect(h.audioFrames()).toHaveLength(2);
  });

  it('音频先到、文字后到：攒帧后落定再播',async()=>{
    const h=await chatHarness();
    h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
    expect(h.audioFrames()).toHaveLength(0); // 落定前不播
    h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:'嗯，慢慢说，我在这儿。'});
    expect(h.assistantText()).toEqual(['嗯，慢慢说，我在这儿。']);
    expect(h.audioFrames()).toHaveLength(1);
  });

  it('已路由出结果的长回答逐字播出，不被 24 字猜测校验降级成固定台词',async()=>{
    const h=await chatHarness();
    const long='嗯，先别急着一次做完，挑今天最想推进的那一件，做完再看剩下的两件也不迟。';
    h.socket.server({type:'response.audio_transcript.done',response_id:'r1',transcript:long});
    expect(h.assistantText()).toEqual([long]);
    h.socket.server({type:'response.audio.delta',response_id:'r1',item_id:'a1',delta:'AQABAA=='});
    expect(h.audioFrames()).toHaveLength(1);
    expect(h.assistantText()).not.toContain('我看一下');
  });
});

describe('continuous conversation while task results arrive',()=>{
 it('keeps the second queued result until the first actually finishes playing',async()=>{
  const h=voiceHarness();h.startTurn(1,'继续介绍');
  for(const [id,text] of [['queued-first','第一条结果。'],['queued-second','第二条结果。']] as const){
   h.session.completeDelivery({id,runId:'run-greeting',kind:'finding',text});
  }
  expect(h.outputs).toHaveLength(0);
  h.resolve({...acceptedGreeting});await Promise.resolve();await Promise.resolve();
  expect(h.outputs).toHaveLength(1);
  h.outputs[0]!.cb.audio('AQABAA==');h.outputs[0]!.cb.end();
  const response=h.audioFrames().at(-1)!;
  h.session.command({kind:'playback_done',responseId:response.responseId});
  expect(h.outputs).toHaveLength(2);
  expect(h.outputs[1]!.push).toHaveBeenCalledWith('第二条结果。');
 });
 it('does not flush queued task speech after a request to stay silent',async()=>{
  const h=voiceHarness();h.startTurn(1,'别说了');
  h.session.completeDelivery({id:'queued-result',runId:'run-greeting',kind:'finding',text:'后台刚完成的结果。'});
  h.resolve({kind:'silent',quiet:true});await Promise.resolve();await Promise.resolve();
  expect(h.outputs).toHaveLength(0);
  expect(h.responseCreates()).toBe(0);
 });
});

it('stays quiet for later task results, then answers a fresh user turn',async()=>{
 const h=voiceHarness();h.startTurn(1,'别说了');h.resolve({kind:'silent',quiet:true});
 await Promise.resolve();await Promise.resolve();
 h.session.completeDelivery({id:'later-result',runId:'run-greeting',kind:'finding',text:'稍后完成的结果。'});
 expect(h.outputs).toHaveLength(0);
 h.startTurn(2,'现在告诉我结果');
 h.resolve({...acceptedGreeting});await Promise.resolve();await Promise.resolve();
 h.session.completeDelivery({id:'fresh-answer',runId:'run-greeting',kind:'reply',text:'这是你刚才问的结果。'});
 expect(h.outputs).toHaveLength(1);
});

it('does not pass an interrupted realtime answer off as already heard',async()=>{
 const h=voiceHarness();h.startTurn(1,'介绍一下');h.resolve({kind:'none'});
 await Promise.resolve();await Promise.resolve();h.responseCreated('heard-boundary');
 h.socket.server({type:'response.audio.delta',response_id:'heard-boundary',item_id:'audio-boundary',delta:'AQABAA=='});
 h.socket.server({type:'response.audio_transcript.done',response_id:'heard-boundary',item_id:'audio-boundary',transcript:'第一句话。还没听到的后半段。'});
 h.startTurn(2,'你刚才说什么');
 const context=(h.route.mock.calls as any[]).at(-1)[3];
 expect(context.recentTurns.filter((t:any)=>t.role==='assistant')).toEqual([]);
});

it('retains a realtime answer after confirmed playback and ignores duplicate completion',async()=>{
 const h=voiceHarness();h.startTurn(1,'介绍一下');h.resolve({kind:'none'});
 await Promise.resolve();await Promise.resolve();h.responseCreated('fully-heard');
 h.socket.server({type:'response.audio.delta',response_id:'fully-heard',item_id:'heard-audio',delta:'AQABAA=='});
 h.socket.server({type:'response.audio_transcript.done',response_id:'fully-heard',item_id:'heard-audio',transcript:'这句已经完整播放。'});
 h.socket.server({type:'response.done',response:{id:'fully-heard',status:'completed'}});
 h.session.command({kind:'playback_done',responseId:'fully-heard'});
 h.session.command({kind:'playback_done',responseId:'fully-heard'});
 h.startTurn(2,'你刚才说什么');
 const context=(h.route.mock.calls as any[]).at(-1)[3];
 expect(context.recentTurns.filter((t:any)=>t.role==='assistant')).toEqual([{role:'assistant',text:'这句已经完整播放。'}]);
});

it('waits without speaking or dispatching while the user composes a sentence',async()=>{
 const h=voiceHarness();h.startTurn(1,'预算改成');h.resolve({kind:'listening'});
 await Promise.resolve();await Promise.resolve();
 expect(h.outputs).toHaveLength(0);expect(h.responseCreates()).toBe(0);
 expect(h.events.at(-1)).toMatchObject({kind:'state',state:'ready'});
 h.startTurn(2,'六百，按价格排序');
 expect((h.route.mock.calls as any[]).at(-1)[0]).toBe('预算改成 六百，按价格排序');
});

it('does not treat background noise as permission to speak after silence',async()=>{
 const h=voiceHarness();h.startTurn(1,'别说了');h.resolve({kind:'silent',quiet:true});
 await Promise.resolve();await Promise.resolve();
 h.startTurn(2,'');
 h.session.completeDelivery({id:'after-noise',runId:'run-greeting',kind:'finding',text:'新的后台结果。'});
 expect(h.outputs).toHaveLength(0);
});

it('holds task results while waiting for the rest of a sentence',async()=>{
 const h=voiceHarness();h.startTurn(1,'我想');h.resolve({kind:'listening'});
 await Promise.resolve();await Promise.resolve();
 h.session.completeDelivery({id:'while-composing',runId:'run-greeting',kind:'finding',text:'后台已完成。'});
 expect(h.outputs).toHaveLength(0);
 h.startTurn(2,'先听结果');h.resolve({kind:'silent'});
 await Promise.resolve();await Promise.resolve();
 expect(h.outputs).toHaveLength(1);
 expect(h.outputs[0]!.push).toHaveBeenCalledWith('后台已完成。');
});

it('does not dispatch an incomplete request through the production manager',async()=>{
 const h=managerHarness();try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'listen',text:'我想',target:null}]});
  expect(await h.manager.routeVoiceInput('default','我想',null,()=>true,{...greetingRoute,requestId:'unfinished-1'})).toMatchObject({kind:'listening'});
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('accepts conversational feedback without another model call or task action',async()=>{
 const h=managerHarness();try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  const result=await h.manager.routeVoiceInput('default','嗯，对。',null,()=>true,{...greetingRoute,requestId:'backchannel',interruptedSpeech:true});
  expect(result).toMatchObject({kind:'silent'});expect('quiet' in result&&result.quiet).toBeFalsy();
  expect(runtime.session.classifyVoiceInput).not.toHaveBeenCalled();
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('returns an unfinished-input decision without waiting for the next turn decision',async()=>{
 const h=managerHarness();try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'listen',text:'我想',target:null}]});
  const wait=vi.fn(()=>new Promise<void>(()=>{}));
  const result=await h.manager.routeVoiceInput('default','我想',null,()=>true,{...greetingRoute,requestId:'unfinished-race',awaitInputDecision:wait});
  expect(result).toMatchObject({kind:'listening'});expect(wait).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('joins a late listening decision before the following ASR completes',async()=>{
 const h=voiceHarness();let resolveFirst!:(r:any)=>void;
 h.route.mockImplementationOnce(()=>new Promise(r=>resolveFirst=r));
 h.startTurn(1,'我想');
 h.session.command({kind:'interrupt',turn:2});
 h.session.command({kind:'audio',turn:2,data:'AQABAA=='});
 resolveFirst({kind:'listening'});await Promise.resolve();await Promise.resolve();
 h.session.command({kind:'commit',turn:2});
 h.socket.server({type:'input_audio_buffer.committed',item_id:'u2'});
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'u2',transcript:'你给我介绍一下'});
 expect((h.route.mock.calls as any[]).at(-1)[0]).toBe('我想 你给我介绍一下');
 h.resolve({kind:'listening'});await Promise.resolve();await Promise.resolve();
 h.startTurn(3,'这个YouTube的视频');
 expect((h.route.mock.calls as any[]).at(-1)[0]).toBe('我想 你给我介绍一下 这个YouTube的视频');
});

it('silences explicit speech-only control without waiting on a classifier',async()=>{
 const h=managerHarness();try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  const result=await h.manager.routeVoiceInput('default','先别说了。',null,()=>true,{...greetingRoute,requestId:'speech-stop'});
  expect(result).toMatchObject({kind:'silent',quiet:true});
  expect(runtime.session.classifyVoiceInput).not.toHaveBeenCalled();
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('does not let an older idle chat start a task after a newer page question',async()=>{
 const h=managerHarness();try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  let current=true,durable=false,release!:()=>void,classified!:()=>void;
  const ready=new Promise<void>(r=>classified=r),gate=new Promise<void>(r=>release=r);
  const old=h.manager.routeVoiceInput('default','还不错，我现在在看这部剧。',null,()=>current||durable,{
   ...greetingRoute,requestId:'old-context-chat',
   onInputDecision:readOnly=>{durable=!readOnly;classified()},awaitInputDecision:()=>gate,
  });
  await ready;current=false;
  runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'observe',text:'你可以告诉我这部剧的内容吗？',target:null}]});
  runtime.session.answerVoiceObservation=vi.fn(async()=> '根据当前页的简介，这是一部校园短剧。');
  runtime.rpc.call=vi.fn(async()=>({tabId:7,url:'https://example.test/video',title:'校园短剧',text:'剧情简介',imageBase64:'image',documentId:'doc',capturedAt:Date.now(),scope:'viewport'}));
  release();await old;
  const result=await h.manager.routeVoiceInput('default','你可以告诉我这部剧的内容吗？',null,()=>true,{
   ...greetingRoute,turn:2,requestId:'new-page-question',pendingDelegation:true,input:{observation:{token:'observed',tabId:7}},
  });
  expect(runtime.session.startTask).not.toHaveBeenCalled();
  expect(result).toMatchObject({kind:'none',spokenText:'根据当前页的简介，这是一部校园短剧。'});
 }finally{h.manager.dispose()}
});

it.each(['before-next-text','after-next-text','after-third-text'])('assembles speech when classification settles %s',async timing=>{
 const h=voiceHarness();const resolutions:Array<(r:any)=>void>=[];
 h.route.mockImplementation(()=>new Promise(r=>resolutions.push(r)));
 h.startTurn(1,'我想');
 if(timing==='before-next-text'){resolutions[0]!({kind:'listening'});await Promise.resolve();await Promise.resolve();}
 h.startTurn(2,'你给我介绍一下');
 if(timing==='after-next-text'){resolutions[0]!({kind:'listening'});await Promise.resolve();await Promise.resolve();}
 if(timing!=='after-third-text'){
  await vi.waitFor(()=>expect(resolutions).toHaveLength(2));
  resolutions[1]!({kind:'listening'});await Promise.resolve();await Promise.resolve();
 }
 h.startTurn(3,'当前这篇文章');
 if(timing==='after-third-text'){resolutions[0]!({kind:'listening'});await Promise.resolve();await Promise.resolve();}
 await vi.waitFor(()=>expect((h.route.mock.calls as any[]).at(-1)[0]).toBe('我想 你给我介绍一下 当前这篇文章'));
});

it('waits for intent classification, not the preceding browser task to finish',()=>{
 const h=voiceHarness();h.startTurn(1,'帮我整理页面');
 const first=(h.route.mock.calls as any[])[0][3];first.onInputDecision(false);
 h.startTurn(2,'现在做得怎么样');
 expect(h.route).toHaveBeenCalledTimes(2);
});

it('sends audio to ASR before page context is ready and waits before routing',async()=>{
 const h=voiceHarness();
 h.session.command({kind:'interrupt',turn:1});h.session.command({kind:'audio',turn:1,data:'AQABAA=='});
 h.session.command({kind:'commit',turn:1,contextPending:true});
 expect(h.socket.sent.some(e=>e.type==='input_audio_buffer.commit')).toBe(true);
 h.socket.server({type:'input_audio_buffer.committed',item_id:'slow-page'});
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'slow-page',transcript:'介绍这个页面'});
 expect(h.route).not.toHaveBeenCalled();
 h.session.command({kind:'input_context',turn:1,input:{context:{tabId:7,title:'原页',url:'https://example.test/original'}}});
 await vi.waitFor(()=>expect(h.route).toHaveBeenCalledOnce());
 expect((h.route.mock.calls as any[])[0][3].input.context.tabId).toBe(7);
});

it('keeps the original page when delayed context and a following segment cross',async()=>{
 const h=voiceHarness();
 h.session.command({kind:'interrupt',turn:1});h.session.command({kind:'audio',turn:1,data:'AQABAA=='});
 h.session.command({kind:'commit',turn:1,contextPending:true});
 h.socket.server({type:'input_audio_buffer.committed',item_id:'fragment1'});
 h.session.command({kind:'interrupt',turn:2});
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'fragment1',transcript:'帮我介绍'});
 h.session.command({kind:'audio',turn:2,data:'AQABAA=='});h.session.command({kind:'commit',turn:2,contextPending:true});
 h.socket.server({type:'input_audio_buffer.committed',item_id:'fragment2'});
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'fragment2',transcript:'这个页面'});
 h.session.command({kind:'input_context',turn:2,input:{context:{tabId:8,title:'新页',url:'https://example.test/new'}}});
 expect(h.route).not.toHaveBeenCalled();
 h.session.command({kind:'input_context',turn:1,input:{context:{tabId:7,title:'原页',url:'https://example.test/original'}}});
 await vi.waitFor(()=>expect(h.route).toHaveBeenCalledOnce());
 const call=(h.route.mock.calls as any[])[0];expect(call[0]).toBe('帮我介绍 这个页面');expect(call[3].input.context.tabId).toBe(7);
});

it('does not dispatch a request whose page context failed',async()=>{
 const h=voiceHarness();
 h.session.command({kind:'interrupt',turn:1});h.session.command({kind:'audio',turn:1,data:'AQABAA=='});h.session.command({kind:'commit',turn:1,contextPending:true});
 h.socket.server({type:'input_audio_buffer.committed',item_id:'failed-page'});
 h.socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:'failed-page',transcript:'点击提交'});
 h.session.command({kind:'input_context',turn:1,error:'页面资料准备失败，这句话尚未执行。'});
 await vi.waitFor(()=>expect(h.events.at(-1)).toMatchObject({kind:'state',state:'ready',detail:expect.stringContaining('尚未执行')}));
 expect(h.route).not.toHaveBeenCalled();
});

it('keeps the original task answer while clarifying an additional independent task',async()=>{
 const h=voiceHarness();h.startTurn(1,'读一下这页最早的内容');h.resolve({...acceptedGreeting});
 await Promise.resolve();await Promise.resolve();
 h.startTurn(2,'同时在新标签页打开另一个网站');
 h.session.completeDelivery({id:'original-task-result',runId:'run-greeting',kind:'finding',text:'最早一轮讨论的是接口兼容。'});
 expect(h.outputs).toHaveLength(0);
 h.resolve({kind:'clarify',message:'当前任务还在执行。要另开会话处理这个新任务吗？'});
 await Promise.resolve();await Promise.resolve();
 expect(h.outputs).toHaveLength(1);
 h.outputs[0]!.cb.audio('AQABAA==');h.outputs[0]!.cb.end();
 h.session.command({kind:'playback_done',responseId:h.audioFrames().at(-1)!.responseId});
 expect(h.outputs).toHaveLength(2);
 expect(h.outputs[1]!.push).toHaveBeenCalledWith('最早一轮讨论的是接口兼容。');
});


it('retains a task result interrupted before the client hears its first sound',async()=>{
 const h=voiceHarness();h.startTurn(1,'读页面');h.resolve({...acceptedGreeting});
 await Promise.resolve();await Promise.resolve();
 h.session.completeDelivery({id:'unheard-task',runId:'run-greeting',kind:'finding',text:'页面开放时间是十点半。'});
 expect(h.outputs).toHaveLength(1);
 h.startTurn(2,'同时打开另一个页面');
 expect(h.outputs[0]!.cancel).toHaveBeenCalledOnce();
 h.resolve({kind:'silent'});await Promise.resolve();await Promise.resolve();
 expect(h.outputs).toHaveLength(2);
 expect(h.outputs[1]!.push).toHaveBeenCalledWith('页面开放时间是十点半。');
});
