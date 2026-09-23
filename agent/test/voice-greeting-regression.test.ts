/**
 * 正确行为回归：2026-09-13 用户说“嗨，晚上好。”后，面板出现固定“任务已收到。”、
 * 后台跑了一整轮页面任务。原诊断断言（空计划）在本文件改写成应然行为，不再把 bug 当契约。
 *
 * idle 闲聊（chat）仍交给有能力的会话处理，但真实发生的隐式派发要写进计划：
 * 不再是空计划，也不假装“零步=已知单步”。
 */
import {describe,expect,it,vi} from 'vitest';
import {ConversationManager} from '../src/conversation-manager.js';
import type {ServerMessage} from '../../shared/protocol.js';

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

    runtimes.set(id,runtime);

return runtime;
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
    expect(session.startTask).toHaveBeenCalledWith('嗨，晚上好。',undefined,undefined,{pageObservation:'on-demand',conversationOnly:true});
    expect(result).toMatchObject({kind:'action',ok:true,awaitDelivery:true});
    // 计划记录真实发生的隐式派发（一步 start），不再是空计划。
    expect(result.plan?.steps).toHaveLength(1);
    expect(result.plan?.steps[0]).toMatchObject({action:'start',status:'complete'});
    expect(result.plan?.steps[0].receipt).toMatchObject({action:'start',status:'accepted',text:'嗨，晚上好。'});
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

it('does not dispatch an incomplete request through the production manager',async()=>{
 const h=managerHarness();

try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'listen',text:'我想',target:null}]});
  expect(await h.manager.routeVoiceInput('default','我想',null,()=>true,{...greetingRoute,requestId:'unfinished-1'})).toMatchObject({kind:'listening'});
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('accepts conversational feedback without another model call or task action',async()=>{
 const h=managerHarness();

try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  const result=await h.manager.routeVoiceInput('default','嗯，对。',null,()=>true,{...greetingRoute,requestId:'backchannel',interruptedSpeech:true});
  expect(result).toMatchObject({kind:'silent'});expect('quiet' in result&&result.quiet).toBeFalsy();
  expect(runtime.session.classifyVoiceInput).not.toHaveBeenCalled();
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('returns an unfinished-input decision without waiting for the next turn decision',async()=>{
 const h=managerHarness();

try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  runtime.session.classifyVoiceInput.mockResolvedValue({steps:[{action:'listen',text:'我想',target:null}]});
  const wait=vi.fn(()=>new Promise<void>(()=>{}));
  const result=await h.manager.routeVoiceInput('default','我想',null,()=>true,{...greetingRoute,requestId:'unfinished-race',awaitInputDecision:wait});
  expect(result).toMatchObject({kind:'listening'});expect(wait).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('silences explicit speech-only control without waiting on a classifier',async()=>{
 const h=managerHarness();

try{
  await h.manager.ensureDefault();const runtime=h.runtimes.get('default');
  const result=await h.manager.routeVoiceInput('default','先别说了。',null,()=>true,{...greetingRoute,requestId:'speech-stop'});
  expect(result).toMatchObject({kind:'silent',quiet:true});
  expect(runtime.session.classifyVoiceInput).not.toHaveBeenCalled();
  expect(runtime.session.startTask).not.toHaveBeenCalled();
 }finally{h.manager.dispose()}
});

it('does not let an older idle chat start a task after a newer page question',async()=>{
 const h=managerHarness();

try{
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
