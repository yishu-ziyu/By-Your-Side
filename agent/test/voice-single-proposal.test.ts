/**
 * 一次性提案（prepareVoiceTurn）的验收检查：
 * 判定并入主 Agent 的第一次推理后，一轮只有一个候选、只有一份正式回答，
 * PREPARING 阶段的输出不落线，控制链与授权语义原样保留。
 *
 * 覆盖契约里的六条反例与三条代码层不变量。
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import {VoiceIntentError} from '../src/voice-errors.js';
import {parseVoiceDecision} from '../src/voice-intent.js';
import {VoiceTurnGate} from '../src/voice-turn.js';
import type {ServerMessage} from '../../shared/protocol.js';
import type {UserDelivery, UserDeliveryStream} from '../../shared/voice.js';
import type {TaskProgressSnapshot} from '../../shared/voice.js';


/** 与 voice-model.test.ts 同形的模型调用替身。 */
function harnessModel(completeSimple:unknown){
  return {runtime:{completeSimple} as any,model:{id:'fixture'} as any,sessionId:'session-1',headers:{'x-opencode-session':'session-1'}};
}

type RouteContext = {requestId:string;voiceId:string;turn:number;runId:string|null;controlVersion?:number;input?:any;targets?:any;resumeReadOnly?:'chat'|'observe'|'status';resumeTargetId?:string;pendingDelegation?:boolean;awaitInputDecision?:()=>Promise<void>;onInputDecision?:(readOnly:boolean)=>void};

/** 计划协议替身：只判定计划（与旧分类调用同形）。 */
function plan(step:Record<string,unknown>,text:string,protocol:'plan'|'free_reply'='plan'){
  const parsed=parseVoiceDecision(JSON.stringify({steps:[step]}),text);
  return {plan:{steps:parsed.steps},replyText:null,requestId:'prepared',attempts:1,elapsedMs:5,protocol};
}
/** 白名单句子的最小直答替身：正文直接来自模型，不经过计划解析。 */
function freeReply(text:string,replyText:string|null=`回应：${text}`){
  return {plan:{steps:[{action:'chat',text,target:null}]},replyText,requestId:'prepared',attempts:1,elapsedMs:5,protocol:'free_reply' as const};
}
/** 会话替身带真实的轮次闸门：只有闸门放行才落线，和 session.ts 的 emitGatedUiEvent 一致。 */
function harness(){
  const emitted:ServerMessage[]=[];
  const runtimes=new Map<string,any>();
  const factory=async(id:string,emit:(m:ServerMessage)=>void)=>{
    let streaming=false,held=false;
    let gate:VoiceTurnGate|null=null;
    const observe=(m:ServerMessage)=>{
      if(m.type==='status')streaming=m.state==='running';
      if(m.type==='agent_event'&&m.event.kind==='agent_start')streaming=true;
      if(m.type==='agent_event'&&m.event.kind==='agent_end')streaming=false;
      emit(m);
    };
    const session:any={
      modelName:()=>'test/model',availableModels:async()=>[],available:true,persistTaskResults:vi.fn(),
      isStreaming:()=>streaming,isHeld:()=>held,executionEpoch:()=>0,abort:vi.fn(),
      prepareVoiceTurn:vi.fn(),
      classifyVoiceInput:vi.fn(async(text:string)=>({steps:[{action:'chat',text,target:null}]})),
      startTask:vi.fn((text:string)=>{observe({type:'agent_event',event:{kind:'agent_start'}});observe({type:'status',state:'running'});}),
      steerCurrentTask:vi.fn(async()=>{}),queueSteerForResume:vi.fn(),
      bindVoiceTurnGate:(g:VoiceTurnGate|null)=>{gate=g;},
      // 会话侧输出：先问闸门，held/dropped 都不落线。
      deliverStream:(stream:UserDeliveryStream)=>{const decision=gate?gate.holdDeliveryStream(stream,id):'pass';if(decision==='pass')emit({type:'agent_event',conversationId:id,event:{kind:'user_delivery_stream',stream}});return decision;},
      deliver:(delivery:UserDelivery)=>{const decision=gate?gate.holdUserDelivery(delivery,id):'pass';if(decision==='pass')emit({type:'agent_event',conversationId:id,event:{kind:'user_delivery',delivery}});return decision;},
      setHeld:(value:boolean)=>{held=value;},
    };
    const runtime:any={
      session,
      fleet:{teamView:()=>null,isGroupHeld:()=>false,abortTeam:vi.fn(),reset:vi.fn(),list:()=>[]},
      rpc:{rejectAll:vi.fn(),setPageTarget:vi.fn(),call:vi.fn()},
      consent:{list:()=>[],cancelAll:vi.fn(),decide:vi.fn()},
      dispose:vi.fn(),handleMessage:vi.fn(),
    };
    runtimes.set(id,{runtime,session,observe,publish:emit});
    return runtime;
  };
  const manager=new ConversationManager(factory as never,m=>emitted.push(m));
  return {manager,emitted,runtimes,session:(id='default')=>runtimes.get(id)!.session,event:(id:string,event:any)=>{runtimes.get(id)!.observe({type:'agent_event',event});}};
}

type DeliveryEvent=Extract<ServerMessage,{type:'agent_event'}> & {event:{kind:'user_delivery';delivery:UserDelivery}};
const streamsOf=(emitted:ServerMessage[])=>emitted.filter((m):m is Extract<ServerMessage,{type:'agent_event'}>=>m.type==='agent_event'&&m.event.kind==='user_delivery_stream');
const deliveriesOf=(emitted:ServerMessage[])=>emitted.filter((m):m is DeliveryEvent=>m.type==='agent_event'&&m.event.kind==='user_delivery');
const runIds=()=>new Set<string>();
const replyStream=(id:string,runId:string|null,text:string):UserDeliveryStream=>({id,runId,kind:'reply',text,phase:'streaming'});
const replyDelivery=(id:string,runId:string|null,text:string):UserDelivery=>({conversationId:'default',id,runId,kind:'reply',text,composedAt:Date.now(),status:'composed'});

describe('反例1：校验很慢、模型很快，批准前不落地任何输出',()=>{
  it('PREPARING 阶段的前缀与交付被扣住，COMMITTED 之后才发；没有工具执行与状态污染',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    let resolvePrepare!: (value:unknown)=>void;
    session.prepareVoiceTurn.mockImplementation(()=>new Promise(r=>{resolvePrepare=r;}));
    const context:RouteContext={requestId:'turn-1',voiceId:'v',turn:1,runId:null};
    const running=h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,context);
    await Promise.resolve();
    const before=h.emitted.length;
    // 模型很快：前缀和交付都已经产生，但还没通过校验。
    expect(session.deliverStream(replyStream('delivery-early',null,'任务已收到'))).toBe('held');
    expect(session.deliver(replyDelivery('delivery-early',null,'任务已收到'))).toBe('held');
    expect(h.emitted.slice(before).filter(m=>m.type==='agent_event')).toEqual([]);
    expect(h.manager.getTaskProgress('default')!.state).toBe('none');
    expect(session.startTask).not.toHaveBeenCalled();
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
    expect(session.classifyVoiceInput).not.toHaveBeenCalled();
    // 校验通过：这一轮的正文与刚才被扣住的输出在提交后才出去。
    resolvePrepare(freeReply('嗨，晚上好。'));
    await running;
    await Promise.resolve();
    const events=h.emitted.slice(before).filter(m=>m.type==='agent_event') as Extract<ServerMessage,{type:'agent_event'}>[];
    expect(events.some(e=>e.event.kind==='user_delivery_stream'&&e.event.stream.id==='delivery-early')).toBe(true);
  });
});

describe('反例2：生成中说停，旧 token / 旧交付 / 旧 agent_end / 重连都不能复活它',()=>{
  it('被取代的候选不复活，也不补说第二份回答',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    let resolveFirst!: (value:unknown)=>void;
    session.prepareVoiceTurn.mockImplementationOnce(()=>new Promise(r=>{resolveFirst=r;}));
    let current=true;
    const first=h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>current,{requestId:'turn-1',voiceId:'v',turn:1,runId:null});
    await Promise.resolve();
    // 模型很快：这一轮的前缀先被扣住，还没通过校验。
    expect(session.deliverStream(replyStream('delivery-late',null,'晚上好，我在这里'))).toBe('held');
    // 用户又说了一句：老轮次不再是当前轮，闸门进入终态。
    current=false;
    session.prepareVoiceTurn.mockResolvedValueOnce(freeReply('你好。'));
    await h.manager.routeVoiceInput('default','你好。',null,()=>true,{requestId:'turn-2',voiceId:'v',turn:2,runId:null});
    // 取消顺序第一步：旧候选的模型请求先失效。
    expect(session.prepareVoiceTurn.mock.calls[0]![1]?.cancel).toMatchObject({aborted:true});
    resolveFirst(freeReply('嗨，晚上好。'));
    // 被取代的候选按确定的失败收尾（语音层因这一轮已翻篇不再出声），绝不补发正文。
    await expect(first).rejects.toThrow(VoiceIntentError);
    // 迟到的同一条前缀不再复活；旧候选不产生正式回答。
    expect(session.deliverStream(replyStream('delivery-late',null,'晚上好，我在这里'))).toBe('dropped');
    expect(h.emitted.some(m=>m.type==='agent_event'&&m.event.kind==='user_delivery'&&m.event.delivery.text.includes('我在这里'))).toBe(false);
    // 只有新那句话的正式回答，旧候选没有补出第二份。
    expect(deliveriesOf(h.emitted).map(m=>m.event.delivery.text)).toEqual(['回应：你好。']);
    expect(session.startTask).not.toHaveBeenCalled();
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
  });
});

describe('反例3：原任务执行中问进度或闲聊不被隐式 steer',()=>{
  it('不需要外部事实的闲聊只产生一份只读正式回答，不动原任务与工作页面',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockResolvedValue(freeReply('嗨，晚上好。'));
    const receipt=await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{requestId:'turn-chat',voiceId:'v',turn:1,runId});
    expect(receipt).toMatchObject({kind:'none',resumeReadOnly:'chat',turn:{branch:'reply',phase:'COMMITTED'}});
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
    expect(session.queueSteerForResume).not.toHaveBeenCalled();
    expect(session.startTask).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    const runtime=h.runtimes.get('default')!.runtime;
    expect(runtime.rpc.setPageTarget).not.toHaveBeenCalled();
    expect(deliveriesOf(h.emitted)).toHaveLength(1);
    expect(h.manager.getTaskProgress('default')!.runId).toBe(runId);
  });
  it('依赖任务结果的追问不走 reply：退回原路径，不靠精简上下文编事实',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    // 模型给了正文，但这句话依赖任务结果：程序侧守卫必须拦下。
    session.prepareVoiceTurn.mockResolvedValue(freeReply('现在做到哪了？'));
    const receipt=await h.manager.routeVoiceInput('default','现在做到哪了？',null,()=>true,{requestId:'turn-progress-chat',voiceId:'v',turn:1,runId});
    expect(receipt).toMatchObject({kind:'none',resumeReadOnly:'chat'});
    expect(deliveriesOf(h.emitted)).toHaveLength(0);
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
    expect(session.startTask).not.toHaveBeenCalled();
    expect(session.abort).not.toHaveBeenCalled();
    expect(h.manager.getTaskProgress('default')!.runId).toBe(runId);
  });
});

describe('反例4：任务替换／控制版本变化后旧提案才返回',()=>{
  it('reply 分支不再对新 run 发布，控制分支按原控制版本被拒',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    let releaseReply!: (value:unknown)=>void,releaseControl!: (value:unknown)=>void;
    session.prepareVoiceTurn.mockImplementationOnce(()=>new Promise(r=>{releaseReply=r;}));
    const chat=h.manager.routeVoiceInput('default','晚上好。',null,()=>true,{requestId:'turn-old-reply',voiceId:'v',turn:1,runId:null});
    await Promise.resolve();
    h.event('default',{kind:'agent_start'});
    releaseReply(freeReply('晚上好。'));
    expect(await chat).toMatchObject({kind:'none',resumeReadOnly:'chat'});
    expect(deliveriesOf(h.emitted)).toHaveLength(0);
    // 运行中的任务被控制版本变化（用户接管过一次）后，旧提案的暂停不得生效。
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockImplementationOnce(()=>new Promise(r=>{releaseControl=r;}));
    const pending=h.manager.routeVoiceInput('default','暂停任务',null,()=>true,{requestId:'turn-old-control',voiceId:'v',turn:2,runId,controlVersion:0});
    await Promise.resolve();
    await h.manager.handleMessage({type:'takeover',conversationId:'default',requestId:'human-control'});
    releaseControl(plan({action:'pause'},'暂停任务'));
    const rejected=await pending;
    expect(rejected).toMatchObject({ok:false});
    expect(h.emitted.some(m=>m.type==='task_control'&&m.action==='pause')).toBe(false);
    expect(session.isHeld()).toBe(false);
    expect(h.manager.getTaskProgress('default')!.runId).toBe(runId);
  });
});

describe('反例5：只有标题没有正文／读页失败／操作回执 unknown',()=>{
  it('读页失败只给确定的失败回执，不编正文也不宣称已看到',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'observe'},'这页写了什么？'));
    const runtime=h.runtimes.get('default')!.runtime;
    runtime.rpc.call=vi.fn(async()=>{throw new Error('read failed');});
    const receipt=await h.manager.routeVoiceInput('default','这页写了什么？',null,()=>true,{requestId:'turn-observe',voiceId:'v',turn:1,runId,input:{observation:{token:'grant',tabId:7}}});
    expect(receipt).toMatchObject({kind:'none',spokenText:'这次没有完成当前页面的读取，请稍后再试。'});
    expect(JSON.stringify(receipt)).not.toContain('已看到');
    expect(deliveriesOf(h.emitted)).toHaveLength(0);
  });
  it('unknown 回执如实说明未确认，不自动重做',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'steer'},'预算改成八百'));
    // 跑着的任务先读回确认：这一轮不执行。
    const ask=await h.manager.routeVoiceInput('default','预算改成八百',null,()=>true,{requestId:'turn-unknown',voiceId:'v',turn:1,runId});
    expect(ask).toMatchObject({kind:'clarify'});
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
    // 确认轮的执行结果未知：如实说明，不重发。
    session.steerCurrentTask=vi.fn(async()=>{throw new Error('upstream vanished');});
    const receipt=await h.manager.routeVoiceInput('default','对',null,()=>true,{requestId:'turn-confirm',voiceId:'v',turn:2,runId});
    expect(receipt).toMatchObject({ok:false,status:'unknown'});
    expect(receipt.kind==='steer'&&receipt.message).toMatch(/无法确认|不会自动重做/);
    expect(session.steerCurrentTask).toHaveBeenCalledTimes(1);
  });
  it('非白名单句子不解析、也不接受任何模型正文：只有计划与派发',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockResolvedValue({plan:{steps:[{action:'observe',text:'点一下',target:null}]},replyText:'好的，我点了。',requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    const receipt=await h.manager.routeVoiceInput('default','点一下',null,()=>true,{requestId:'turn-observe-intent',voiceId:'v',turn:1,runId:null});
    expect(receipt).not.toMatchObject({turn:{branch:'reply'}});
    expect(deliveriesOf(h.emitted)).toHaveLength(0);
  });
});

describe('反例6：否定、引用、复合控制、重复 ASR 终稿',()=>{
  it('“不要停”与引用朗读不会被校验成现成的暂停',()=>{
    expect(()=>parseVoiceDecision(JSON.stringify({steps:[{action:'pause',target:null}]}),'不要停')).toThrow(VoiceIntentError);
    expect(()=>parseVoiceDecision(JSON.stringify({steps:[{action:'pause',target:null}]}),'把“暂停任务”读一遍')).toThrow(VoiceIntentError);
  });
  it('复合控制保序执行',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.setHeld(true);
    const order:string[]=[];
    session.queueSteerForResume=vi.fn(()=>{order.push('steer');});
    const prepared=parseVoiceDecision(JSON.stringify({steps:[{action:'steer',through:0},{action:'resume'}]}),'改六百，继续');
    session.prepareVoiceTurn.mockResolvedValue({plan:prepared,replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    const pending=h.manager.routeVoiceInput('default','改六百，继续',null,()=>true,{requestId:'turn-compound',voiceId:'v',turn:1,runId});
    await vi.waitFor(()=>expect(h.emitted.some(m=>m.type==='task_control'&&m.action==='resume')).toBe(true));
    expect(order).toEqual(['steer']);
    await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'turn-compound-1',action:'resume',runId,ok:true});
    expect(await pending).toMatchObject({ok:true,turn:{branch:'control',phase:'COMMITTED'}});
  });
  it('同一句语音重复到达只执行一次，也不重复提案',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'start'},'找书桌'));
    const context:RouteContext={requestId:'turn-once',voiceId:'v',turn:1,runId:null};
    await h.manager.routeVoiceInput('default','找书桌',null,()=>true,context);
    await h.manager.routeVoiceInput('default','找书桌',null,()=>true,context);
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(1);
    expect(session.startTask).toHaveBeenCalledTimes(1);
  });
});

describe('不变量：一轮一份正式回答、被丢弃候选零输出、执行身份仍有效',()=>{
  it('同一语义轮次的正式回答提交次数 ≤ 1，空白恢复不兑换第二份',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockResolvedValue(freeReply('嗨，晚上好。'));
    const context:RouteContext={requestId:'turn-single',voiceId:'v',turn:1,runId:null};
    expect(await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,context)).toMatchObject({spokenText:'回应：嗨，晚上好。'});
    expect(deliveriesOf(h.emitted)).toHaveLength(1);
    expect(streamsOf(h.emitted)).toHaveLength(1);
    // 空白输入恢复上一句：同一轮不再产出交付，也不重新提案。
    await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{...context,resumeReadOnly:'chat'});
    expect(deliveriesOf(h.emitted)).toHaveLength(1);
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(1);
    // 重复送达同一个计划编号也不会再发一份。
    await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,context);
    expect(deliveriesOf(h.emitted)).toHaveLength(1);
  });
  it('被丢弃的候选：零可见输出、零业务副作用，并给确定的失败回执',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockImplementation(()=>new Promise((_,reject)=>setTimeout(()=>reject(new VoiceIntentError('classifier_timeout')),0)));
    const before=h.emitted.length;
    await expect(h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{requestId:'turn-timeout',voiceId:'v',turn:1,runId:null})).rejects.toThrow(VoiceIntentError);
    expect(h.emitted.slice(before).filter(m=>m.type==='agent_event')).toEqual([]);
    expect(session.startTask).not.toHaveBeenCalled();
    expect(session.steerCurrentTask).not.toHaveBeenCalled();
    expect(h.runtimes.get('default')!.runtime.rpc.call).not.toHaveBeenCalled();
    // 模型不遵守提案格式（校验不通过）同样给确定失败，不放行成执行。
    session.prepareVoiceTurn.mockRejectedValue(new VoiceIntentError('classifier_invalid_reply','tool_intent_not_allowed'));
    await expect(h.manager.routeVoiceInput('default','点一下',null,()=>true,{requestId:'turn-invalid',voiceId:'v',turn:2,runId:null})).rejects.toThrow(VoiceIntentError);
    expect(session.startTask).not.toHaveBeenCalled();
  });
  it('控制的执行版本与运行身份仍在提交时复核',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'pause'},'暂停任务'));
    const stale=await h.manager.routeVoiceInput('default','暂停任务',null,()=>true,{requestId:'turn-stale',voiceId:'v',turn:1,runId:'other-run'});
    expect(stale).toMatchObject({ok:false});
    expect(h.emitted.some(m=>m.type==='task_control')).toBe(false);
    const fresh=h.manager.routeVoiceInput('default','暂停任务',null,()=>true,{requestId:'turn-fresh',voiceId:'v',turn:2,runId});
    await vi.waitFor(()=>expect(h.emitted.some(m=>m.type==='task_control'&&m.action==='pause')).toBe(true));
    await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'turn-fresh',action:'pause',runId,ok:true});
    expect(await fresh).toMatchObject({ok:true,turn:{branch:'control',phase:'COMMITTED'}});
  });
});

describe('observe/工具意图：复用既有派发与页面预观察',()=>{
  it('observe 走原有派发（预观察由既有链路完成），不塞合成的工具意图续跑文案',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'observe'},'这页写了什么？'));
    const receipt=await h.manager.routeVoiceInput('default','这页写了什么？',null,()=>true,{requestId:'turn-tool',voiceId:'v',turn:1,runId:null});
    expect(receipt).toMatchObject({kind:'action',ok:true,turn:{branch:'read_only',phase:'COMMITTED',protocol:'plan'}});
    // 页面问答走精简协议：请求形状与旧分类调用一致，首声不因合并变慢。
    expect(session.prepareVoiceTurn.mock.calls[0]![1]).toMatchObject({protocol:'plan'});
    // 派发参数与原路径一致：observe 不带 inputOptions，主 Agent 因此走 promptWithFreshPageObservation 预观察。
    expect(session.startTask).toHaveBeenCalledWith('这页写了什么？',undefined,undefined);
    expect(JSON.stringify(session.startTask.mock.calls)).not.toContain('approvedToolIntent');
  });
});

describe('轮次闸门本身',()=>{
  it('PREPARING → COMMITTED → COMPLETED 与两个终态都不会让晚到前缀复活',()=>{
    const gate=new VoiceTurnGate();
    gate.begin('t1','default');
    expect(gate.holdDeliveryStream(replyStream('d1',null,'前缀'),'default')).toBe('held');
    expect(gate.commit('t1')).toMatchObject({streams:[expect.objectContaining({id:'d1'})]});
    expect(gate.phase('t1')).toBe('COMMITTED');
    expect(gate.holdDeliveryStream(replyStream('d1',null,'前缀'),'default')).toBe('pass');
    gate.complete('t1');
    expect(gate.phase('t1')).toBe('COMPLETED');
    gate.begin('t2','default');
    expect(gate.holdDeliveryStream(replyStream('d2',null,'候选'),'default')).toBe('held');
    expect(gate.discard('t2')).toMatchObject({streams:[]});
    expect(gate.phase('t2')).toBe('DISCARDED');
    expect(gate.holdDeliveryStream(replyStream('d2',null,'晚到'),'default')).toBe('dropped');
    gate.begin('t3','default');
    expect(gate.holdDeliveryStream(replyStream('d3',null,'候选'),'default')).toBe('held');
    expect(gate.interrupt('t3')).toMatchObject({streams:[]});
    expect(gate.holdDeliveryStream(replyStream('d3',null,'晚到'),'default')).toBe('dropped');
    // 别的会话不受影响。
    expect(gate.holdDeliveryStream(replyStream('d9','other','别轮'),'other')).toBe('pass');
  });
});

// 语音层：一轮一份回答；旧 token/旧交付/agent_end/重连不能让被停掉的候选复活。
import {EventEmitter} from 'node:events';
import type WebSocket from 'ws';
import {StepVoiceSession,STEP_VOICE} from '../src/voice-session.js';

class VoiceSocket extends EventEmitter{
  readyState=1;bufferedAmount=0;sent:any[]=[];
  send=(data:string)=>{this.sent.push(JSON.parse(data));};
  close=vi.fn();
  server(event:object){this.emit('message',Buffer.from(JSON.stringify(event)));}
}
function voiceHarness(route:ConstructorParameters<typeof StepVoiceSession>[0]['route']){
  const socket=new VoiceSocket();
  const events:any[]=[];const diagnostics:any[]=[];
  const speeches:any[]=[];
  const snapshot:TaskProgressSnapshot={conversationId:'default',observedAt:Date.now(),state:'idle',goal:null,startedAt:1,runId:'run-1',active:[],lastAction:null,successVerified:false};
  const session=new StepVoiceSession({route,getSnapshot:()=>snapshot,emit:e=>events.push(e),connect:()=>socket as unknown as WebSocket,diagnostic:(event,fields)=>diagnostics.push({event,fields}),
    createSpeech:(_key:any,callbacks:any)=>{const output={push:(text:string)=>{callbacks.audio('AQABAA==');callbacks.end();},cancel:()=>{},finish:()=>{}};speeches.push(output);return output;}});
  session.start('synthetic');
  socket.server({type:'session.created',session:{model:'stepaudio-2.5-realtime'}});
  socket.server({type:'session.updated',session:{voice:STEP_VOICE,input_audio_format:'pcm16',turn_detection:{type:''}}});
  const input=(turn=1)=>{session.command({kind:'interrupt',turn});session.command({kind:'audio',turn,data:'AQABAA=='});session.command({kind:'commit',turn});};
  const speak=(turn:number,text:string)=>{input(turn);socket.server({type:'input_audio_buffer.committed',item_id:`u${turn}`});socket.server({type:'conversation.item.input_audio_transcription.completed',item_id:`u${turn}`,transcript:text});};
  return {socket,events,diagnostics,speeches,session,speak,input};
}
afterEach(()=>{sessions.forEach(s=>s.close());sessions.splice(0);});
const sessions:StepVoiceSession[]=[];

describe('语音层：一轮一份回答，被停掉的候选不复活',()=>{
  it('提交后只播一份正文；随后的旧交付、旧 agent_end 与重连事件都不补第二份',async()=>{
    const h=voiceHarness(async()=>({kind:'none',resumeReadOnly:'chat',spokenText:'晚上好，我在。',turn:{branch:'reply',phase:'COMMITTED'}}));
    h.speak(1,'嗨，晚上好。');
    await Promise.resolve();await Promise.resolve();
    expect(h.speeches).toHaveLength(1);
    expect(h.diagnostics.find(d=>d.event==='prepare_result')?.fields).toMatchObject({branch:'reply'});
    expect(h.diagnostics.some(d=>d.event==='route_start'||d.event==='route_result')).toBe(false);
    // 用户说停：这一轮翻篇。
    h.input(2);
    const answers=h.events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>e.text);
    // 注入旧 token、旧交付、旧 response.done 与断线重连：不产生第二份回答，也不重新出声。
    h.socket.server({type:'response.audio.delta',response_id:'old',item_id:'old-item',delta:'AQABAA=='});
    h.socket.server({type:'response.done',response:{id:'old',status:'completed'}});
    h.session.streamDelivery({id:'old-turn-delivery',runId:'run-1',kind:'reply',text:'旧候选的回答',phase:'streaming',voiceTurn:1});
    h.session.completeDelivery({id:'old-turn-delivery',runId:'run-1',kind:'reply',text:'旧候选的回答',voiceTurn:1});
    h.socket.emit('close',1006);
    await Promise.resolve();
    expect(h.speeches).toHaveLength(1);
    expect(h.events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>e.text)).toEqual(answers);
  });
  it('判定超时给确定的失败回执，不自动放行成执行',async()=>{
    const h=voiceHarness(async()=>{throw new VoiceIntentError('classifier_timeout');});
    h.speak(1,'嗨，晚上好。');
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const spoken=h.events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>e.text).join('');
    expect(spoken).toContain('未执行');
    expect(spoken).toContain('超时');
    expect(h.diagnostics.some(d=>d.event==='prepare_error')).toBe(true);
    expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
  });
});

describe('提案校验沿用既有语义：整句、分界、目标名称、页面归属',()=>{
  it('单个动作保留整句原文，多动作按分界切分且拼回原话',()=>{
    const whole=parseVoiceDecision(JSON.stringify({steps:[{action:'chat',target:null}]}),'嗯，嗯，晚上好呀。');
    expect(whole.steps).toHaveLength(1);
    expect(whole.steps[0]!.text).toBe('嗯，嗯，晚上好呀。');
    const split=parseVoiceDecision(JSON.stringify({steps:[{action:'steer',through:0},{action:'resume'}]}),'改六百，继续');
    expect(split.steps.map(s=>s.action)).toEqual(['steer','resume']);
    expect(split.steps.map(s=>s.text).join('')).toBe('改六百，继续');
  });
  it('未命名的“那个会话”不会被执行；澄清轮由应用按真实事实回答',async()=>{
    // 目标不明确：解析器把"暂停那个会话"改写成澄清，绝不当成现成的暂停执行。
    expect(parseVoiceDecision(JSON.stringify({steps:[{action:'pause',target:null}]}),'暂停那个会话').steps).toMatchObject([{action:'clarify'}]);
    const parsed=parseVoiceDecision(JSON.stringify({steps:[{action:'clarify',target:null}]}),'停');
    expect(parsed.steps).toMatchObject([{action:'clarify'}]);
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockResolvedValue({plan:parsed,replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    expect(await h.manager.routeVoiceInput('default','停',null,()=>true,{requestId:'turn-stop',voiceId:'v',turn:1,runId:null})).toMatchObject({kind:'clarify',message:'你是想停止播报，还是暂停任务？'});
    expect(deliveriesOf(h.emitted)).toHaveLength(0);
    expect(h.emitted.some(m=>m.type==='task_control')).toBe(false);
  });
  it('跨会话目标名称与当前页面归属仍按原规则解析',async()=>{
    const h=harness();await h.manager.ensureDefault();
    await h.manager.handleMessage({type:'conversation_create',requestId:'reading',title:'阅读'});
    const other=h.manager.list().find(c=>c.title==='阅读')!.id;
    h.event(other,{kind:'agent_start'});
    const session=h.session();
    const target=h.session(other);
    session.prepareVoiceTurn.mockResolvedValue(plan({action:'steer',target:'阅读'},'阅读会话用当前页面改成六百'));
    const context:RouteContext={requestId:'turn-target',voiceId:'v',turn:1,runId:h.manager.getTaskProgress(other)!.runId??null,targets:h.manager.voiceTargets(),input:{context:{tabId:7,title:'来源页',url:'https://source.test'}}};
    const receipt=await h.manager.routeVoiceInput('default','阅读会话用当前页面改成六百',null,()=>true,context);
    expect(receipt).toMatchObject({ok:true,turn:{branch:'control'}});
    expect(target.steerCurrentTask).toHaveBeenCalledWith('阅读会话用当前页面改成六百',{tabId:7,title:'来源页',url:'https://source.test'},undefined);
  });
});

describe('真实会话的闸门接线与已批准续跑文案',()=>{
  it('session.ts 的交付流与正式交付都先问闸门：PREPARING 扣住、终态不复活',async()=>{
    const {BrowserAgentSession}=await import('../src/session.js');
    const emitted:any[]=[];
    const gate=new VoiceTurnGate();
    const session:any=Object.assign(Object.create(BrowserAgentSession.prototype),{
      session:{model:{id:'fixture'}},modelRuntime:null,voiceTurnGate:null,voiceConversationId:'default',
      callbacks:{emit:(event:any)=>emitted.push(event)},runTrace:{record:()=>{}},
    });
    session.bindVoiceTurnGate(gate);
    gate.begin('turn-1','default');
    session.emitDeliveryStream(replyStream('d1',null,'候选前缀'));
    expect(emitted).toEqual([]);
    expect(gate.commit('turn-1')).toMatchObject({streams:[expect.objectContaining({id:'d1'})]});
    session.emitDeliveryStream(replyStream('d1',null,'候选前缀'));
    expect(emitted).toHaveLength(1);
    gate.begin('turn-2','default');
    session.emitDeliveryStream(replyStream('d2',null,'候选前缀'));
    expect(emitted).toHaveLength(1);
    gate.discard('turn-2');
    session.emitDeliveryStream(replyStream('d2',null,'晚到前缀'));
    expect(emitted).toHaveLength(1);
    // 别的会话在准备时，本会话的输出照常发出。
    gate.begin('turn-3','other');
    session.emitDeliveryStream(replyStream('d3',null,'本会话事实'));
    expect(emitted).toHaveLength(2);
  });
});

describe('第二轮要求7：observe 复用既有派发与页面预观察',()=>{
  it('真实会话在派发时先读当前页，把预观察结果交给主 Agent（不再另塞合成文案）',async()=>{
    const {BrowserAgentSession}=await import('../src/session.js');
    const prompt=vi.fn(async (_text?:string)=>{});
    const raw={model:{id:'fixture',provider:'fixture'},get isStreaming(){return false;},prompt,steer:vi.fn(async()=>{})};
    const rpc={call:vi.fn(async()=>({text:'ORIGINAL_PAGE_CONTENT',tabId:7})),setPageTarget:vi.fn(),getPageTarget:vi.fn(()=>null)};
    const Session=BrowserAgentSession as unknown as new (...args:any[])=>any;
    const session=new Session(raw,null,{emit:()=>{},setStatus:()=>{}},null,null,undefined,null,rpc);
    session.sendUserMessage('这页写了什么？',{tabId:7,title:'招聘页',url:'https://example.test'});
    await vi.waitFor(()=>expect(prompt).toHaveBeenCalledTimes(1));
    expect(rpc.call).toHaveBeenCalledWith('snapshot',{tabId:7},4000);
    const text=prompt.mock.calls[0]![0] as unknown as string;
    expect(text).toContain('这页写了什么？');
    expect(text).toContain('ORIGINAL_PAGE_CONTENT');
    expect(text).toContain('FRESH PAGE OBSERVATION');
    expect(text).not.toContain('approved');
  });
});

describe('第二轮要求8：控制句的精简协议与旧分类调用同形',()=>{
  it('控制句与停播报一律不走完整提案（默认走与旧分类同形的精简协议）',async()=>{
    const {isFactFreeClosedUtterance}=await import('../src/voice-intent.js');
    for(const control of ['暂停任务','先停','停一停','别读了','安静点','不用念了','先等等','别说了','停止播报','停','继续','交还给你','取消任务','终止','把任务暂停'])expect(isFactFreeClosedUtterance(control)).toBe(false);
  });
  it('复核官点名的控制措辞在真实路由里都拿到精简协议',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockImplementation(async(input:any,options:any)=>({plan:{steps:[{action:'clarify',text:input.text,target:null}]},replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:options?.protocol??'plan'}));
    const phrasings=['先停','停一停','别读了','安静点','不用念了','先等等'];
    for(const [index,text] of phrasings.entries()){
      const before=h.emitted.length;
      await h.manager.routeVoiceInput('default',text,null,()=>true,{requestId:`turn-phrase-${index}`,voiceId:'v',turn:index+1,runId:null});
      expect(session.prepareVoiceTurn.mock.calls.at(-1)![1]).toMatchObject({protocol:'plan'});
      expect(deliveriesOf(h.emitted.slice(before))).toHaveLength(0);
    }
  });
  it('控制句只发一次请求，且提示词、输出形状与预算和旧分类调用一致',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    session.prepareVoiceTurn.mockResolvedValue({plan:{steps:[{action:'pause',text:'暂停任务',target:null}]},replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    const pending=h.manager.routeVoiceInput('default','暂停任务',null,()=>true,{requestId:'turn-control',voiceId:'v',turn:1,runId});
    await vi.waitFor(()=>expect(h.emitted.some(m=>m.type==='task_control'&&m.action==='pause')).toBe(true));
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(1);
    expect(session.prepareVoiceTurn.mock.calls[0]![1]).toMatchObject({protocol:'plan'});
    expect(session.classifyVoiceInput).not.toHaveBeenCalled();
    await h.manager.handleMessage({type:'task_control_result',conversationId:'default',requestId:'turn-control',action:'pause',runId,ok:true});
    expect(await pending).toMatchObject({ok:true,turn:{branch:'control',phase:'COMMITTED'}});
    const {VOICE_INTENT_PROMPT,VOICE_PLAN_PROMPT}=await import('../src/voice-intent.js');
    expect(VOICE_PLAN_PROMPT).toBe(VOICE_INTENT_PROMPT);
  });
  it('精简协议的请求与旧分类调用逐项同形（提示词/预算/温度/解析）',async()=>{
    const {prepareVoiceTurn}=await import('../src/voice-model.js');
    const {VOICE_INTENT_PROMPT}=await import('../src/voice-intent.js');
    const completeSimple=vi.fn(async (_model:unknown,_context:unknown,_options:unknown)=>({stopReason:'stop',content:[{type:'text',text:'{"steps":[{"action":"pause","target":null}]}'}]}));
    const prepared=await prepareVoiceTurn(harnessModel(completeSimple),{text:'暂停任务',state:'running'},{protocol:'plan'});
    expect(prepared).toMatchObject({protocol:'plan',replyText:null});
    expect(prepared.plan.steps[0]!.action).toBe('pause');
    const [,,options]=completeSimple.mock.calls[0]!;
    expect(options).toMatchObject({maxTokens:1400,temperature:0});
    const context=completeSimple.mock.calls[0]![1] as unknown as {systemPrompt:string};
    expect(context.systemPrompt).toBe(VOICE_INTENT_PROMPT);
  });
});

describe('第二轮要求9：reply 只在不需要外部事实时使用',()=>{
  it('复核官列出的 13 句依赖页面/任务事实的问句全部不走 reply',async()=>{
    const {isFactFreeClosedUtterance}=await import('../src/voice-intent.js');
    const factDependent=['工资多少？','这个多少钱？','它要求几年经验？','公司叫什么名字？','招几年经验？','简历投了吗？','有没有回复？','面试流程是什么？','几点截止？','他回消息了吗？','要求什么学历？','需不需要作品集？','几号面试？'];
    for(const text of factDependent)expect(isFactFreeClosedUtterance(text)).toBe(false);
    // 验收句只是因为含"页面"两字被拦下，去掉后同样必须失败关闭。
    expect(isFactFreeClosedUtterance('它要求几年经验？')).toBe(false);
    expect(isFactFreeClosedUtterance('当前招聘页面要求几年经验？')).toBe(false);
  });
  it('只有问候/寒暄/致谢/告别/应答与纯算术允许直答',async()=>{
    const {isFactFreeClosedUtterance}=await import('../src/voice-intent.js');
    for(const text of ['嗨，晚上好。','你好。','你好呀','嗨，晚上好','谢谢','辛苦了','再见','晚安','在吗','收到','十加七等于多少？','12乘以8等于几','100减37是多少','三加五'])expect(isFactFreeClosedUtterance(text)).toBe(true);
    // 带任何外部事实指代或额外请求的句子都不算封闭。
    for(const text of ['你好，请问工资多少？','谢谢，帮我看看页面','十加七等于多少？顺便看下页面'])expect(isFactFreeClosedUtterance(text)).toBe(false);
  });
  it('计划协议照旧：需要事实的追问判成 chat 就走原派发，不产生正文',async()=>{
    const {parseVoiceDecision}=await import('../src/voice-intent.js');
    expect(parseVoiceDecision(JSON.stringify({steps:[{action:'chat',target:null}]}),'刚才那个呢')).toMatchObject({steps:[{action:'chat'}]});
  });
});

describe('第二轮：只有不需要外部事实的句子才走完整提案',()=>{
  it('问候/知识/闲聊走完整提案（可带正文），其余一律走与旧分类同形的精简协议',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockImplementation(async(input:any,options:any)=>options?.protocol==='free_reply'
      ?{plan:{steps:[{action:'chat',text:input.text,target:null}]},replyText:`回应：${input.text}`,requestId:'p',attempts:1,elapsedMs:1,protocol:'free_reply'}
      :{plan:{steps:[{action:'chat',text:input.text,target:null}]},replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    const asked:string[]=[];
    const run=async(text:string,turn:number)=>{const before=h.emitted.length;await h.manager.routeVoiceInput('default',text,null,()=>true,{requestId:`turn-${turn}`,voiceId:'v',turn,runId:null});asked.push(`${text}=>${session.prepareVoiceTurn.mock.calls.at(-1)![1]?.protocol}`);return h.emitted.slice(before);};
    await run('嗨，晚上好。',1);
    await run('十加七等于多少？',2);
    await run('暂停任务',3);
    await run('当前招聘页面要求几年经验？',4);
    await run('现在做到哪了？',5);
    expect(asked).toEqual(['嗨，晚上好。=>free_reply','十加七等于多少？=>free_reply','暂停任务=>plan','当前招聘页面要求几年经验？=>plan','现在做到哪了？=>plan']);
    expect(session.classifyVoiceInput).not.toHaveBeenCalled();
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(5);
  });
});

describe('第三轮必修1：reply 守卫失败关闭（模型不自律也编不出事实）',()=>{
  it('复核官 13 句事实问句即使模型硬写正文也不直答，一律交给能力会话',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    // 模拟"模型/实现不自律"：不管协议如何都返回带正文的结果。
    session.prepareVoiceTurn.mockImplementation(async(input:any)=>({plan:{steps:[{action:'chat',text:input.text,target:null}]},replyText:'我猜是三年经验。',requestId:'p',attempts:1,elapsedMs:1,protocol:'free_reply'}));
    const factDependent=['工资多少？','这个多少钱？','它要求几年经验？','公司叫什么名字？','招几年经验？','简历投了吗？','有没有回复？','面试流程是什么？','几点截止？','他回消息了吗？','要求什么学历？','需不需要作品集？','几号面试？'];
    for(const [index,text] of factDependent.entries()){
      // 每一轮都从闲置态开始：这些句子都应该被派给能力会话，而不是直答。
      if(index>0)h.event('default',{kind:'agent_end'});
      const before=h.emitted.length;
      const receipt=await h.manager.routeVoiceInput('default',text,null,()=>true,{requestId:`turn-fact-${index}`,voiceId:'v',turn:index+1,runId:null});
      expect(receipt).not.toMatchObject({turn:{branch:'reply'}});
      expect(deliveriesOf(h.emitted.slice(before))).toHaveLength(0);
      expect(session.prepareVoiceTurn.mock.calls.at(-1)![1]).toMatchObject({protocol:'plan'});
    }
    expect(session.startTask).toHaveBeenCalledTimes(factDependent.length);
    expect(session.classifyVoiceInput).not.toHaveBeenCalled();
  });
  it('白名单类别仍走完整提案并直答',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockImplementation(async(input:any)=>freeReply(input.text));
    for(const [index,text] of ['嗨，晚上好。','你好。','十加七等于多少？'].entries()){
      const receipt=await h.manager.routeVoiceInput('default',text,null,()=>true,{requestId:`turn-free-${index}`,voiceId:'v',turn:index+1,runId:null});
      expect(receipt).toMatchObject({turn:{branch:'reply',phase:'COMMITTED',protocol:'free_reply'}});
      expect(session.prepareVoiceTurn.mock.calls.at(-1)![1]).toMatchObject({protocol:'free_reply'});
    }
    expect(deliveriesOf(h.emitted)).toHaveLength(3);
    expect(session.startTask).not.toHaveBeenCalled();
  });
});

describe('第三轮必修4：reply 轮与旧闲置闲聊路径的授权行为一致',()=>{
  it('闲置态让旧授权失效；运行中的只读回答不动待确认',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    const consent=h.runtimes.get('default')!.runtime.consent;
    session.prepareVoiceTurn.mockResolvedValue(freeReply('嗨，晚上好。'));
    await h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{requestId:'turn-idle-consent',voiceId:'v',turn:1,runId:null});
    expect(consent.cancelAll).toHaveBeenCalledTimes(1);
    h.event('default',{kind:'agent_start'});
    const runId=h.manager.getTaskProgress('default')!.runId!;
    consent.cancelAll.mockClear();
    await h.manager.routeVoiceInput('default','你好。',null,()=>true,{requestId:'turn-running-consent',voiceId:'v',turn:2,runId});
    expect(consent.cancelAll).not.toHaveBeenCalled();
    expect(deliveriesOf(h.emitted)).toHaveLength(2);
  });
});

describe('第四轮：白名单走独立最小请求，非白名单永远不走',()=>{
  it('白名单句子用 free_reply 协议；复核官 13 句事实问句与 6 个控制措辞一律用 plan 协议',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockImplementation(async(input:any,options:any)=>options?.protocol==='free_reply'
      ?{plan:{steps:[{action:'chat',text:input.text,target:null}]},replyText:`回应：${input.text}`,requestId:'p',attempts:1,elapsedMs:1,protocol:'free_reply'}
      :{plan:{steps:[{action:'chat',text:input.text,target:null}]},replyText:null,requestId:'p',attempts:1,elapsedMs:1,protocol:'plan'});
    const protocols=new Map<string,string>();
    const run=async(text:string,turn:number)=>{if(turn>1)h.event('default',{kind:'agent_end'});await h.manager.routeVoiceInput('default',text,null,()=>true,{requestId:`turn-r4-${turn}`,voiceId:'v',turn,runId:null});protocols.set(text,String(session.prepareVoiceTurn.mock.calls.at(-1)![1]?.protocol));};
    const whitelisted=['嗨，晚上好。','你好。','谢谢','再见','晚安','十加七等于多少？','12乘以8等于几'];
    const factDependent=['工资多少？','这个多少钱？','它要求几年经验？','公司叫什么名字？','招几年经验？','简历投了吗？','有没有回复？','面试流程是什么？','几点截止？','他回消息了吗？','要求什么学历？','需不需要作品集？','几号面试？'];
    const controls=['先停','停一停','别读了','安静点','不用念了','先等等'];
    let turn=0;
    for(const text of [...whitelisted,...factDependent,...controls])await run(text,++turn);
    for(const text of whitelisted)expect(protocols.get(text)).toBe('free_reply');
    for(const text of [...factDependent,...controls])expect(protocols.get(text)).toBe('plan');
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(whitelisted.length+factDependent.length+controls.length);
  });
  it('最小请求失败给确定失败回执，不退回计划提示词、不拼假回答',async()=>{
    const h=harness();await h.manager.ensureDefault();const session=h.session();
    session.prepareVoiceTurn.mockRejectedValue(new VoiceIntentError('free_reply_failed'));
    const before=h.emitted.length;
    await expect(h.manager.routeVoiceInput('default','嗨，晚上好。',null,()=>true,{requestId:'turn-free-fail',voiceId:'v',turn:1,runId:null})).rejects.toMatchObject({code:'free_reply_failed'});
    expect(h.emitted.slice(before).filter(m=>m.type==='agent_event')).toEqual([]);
    expect(session.prepareVoiceTurn).toHaveBeenCalledTimes(1);
    expect(session.startTask).not.toHaveBeenCalled();
  });
  it('语音层把最小请求失败如实说成没答上来，不放行成执行',async()=>{
    const h=voiceHarness(async()=>{throw new VoiceIntentError('free_reply_failed');});
    h.speak(1,'嗨，晚上好。');
    await Promise.resolve();await Promise.resolve();await Promise.resolve();
    const spoken=h.events.filter(e=>e.kind==='text'&&e.role==='assistant').map(e=>e.text).join('');
    expect(spoken).toContain('没有答上来');
    expect(h.diagnostics.some(d=>d.event==='prepare_error')).toBe(true);
    expect(h.socket.sent.filter(e=>e.type==='response.create')).toHaveLength(0);
  });
});
