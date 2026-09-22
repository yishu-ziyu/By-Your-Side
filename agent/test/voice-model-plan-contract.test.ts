/**
 * 计划流程契约：classifyVoiceInput 与 prepareVoiceTurn({protocol:'plan'}) 是同一份计划流程的
 * 两个公开入口——同一套请求组装、同一份提示词、同一 15s 总预算与 6s→9s 子预算、同一次重试、
 * 同一 parseVoiceDecision 校验，各自的返回值与诊断前缀不变。
 *
 * 断言只从两个生产入口观察：模型参数、payload 形状、重试原因回灌、错误码、诊断键与元数据。
 * 期望值（payload/诊断键序、拒绝原因回灌文案、错误码）在重构前捕获，不由重构后的实现反向生成。
 * free_reply 路径的既有用例在 voice-model.test.ts，本文件不重复。
 */
import {afterEach,describe,expect,it,vi} from 'vitest';
import type {VoiceConversationContext} from '../../shared/voice.js';
import {VOICE_INTENT_PROMPT,type VoiceIntentPlan} from '../src/voice-intent.js';
import {classifyVoiceInput,prepareVoiceTurn,type VoiceModelCall} from '../src/voice-model.js';

const model={id:'fixture'} as unknown as VoiceModelCall['model'];

const headers={'x-opencode-session':'session-1','x-opencode-client':'pi'};

const harness=(completeSimple:unknown):VoiceModelCall=>({runtime:{completeSimple} as VoiceModelCall['runtime'],model,sessionId:'session-1',headers});

const stop=(text:string)=>({stopReason:'stop',content:[{type:'text',text}]});

const ERROR_REPLY={stopReason:'error',content:[]};

const ABORTED_REPLY={stopReason:'aborted',content:[]};

const VALID_PAUSE='{"steps":[{"action":"pause","target":null}]}';

/** 对"不要停"这类否定句，动作 pause 会被解析器拒绝，reason 固定为 non_immediate_control。 */
const REJECTED_BY_SEMANTICS='non_immediate_control';

/** 重构前捕获的拒绝原因回灌文案：reason 原样嵌入，后接固定说明。 */
const REJECTION_HINT_FIXTURE=`\n上次拒绝原因：${REJECTED_BY_SEMANTICS}。non_immediate_control表示把否定、引用或未来条件当作现在控制；必须并入前一步或作为非操作。`;

/** 强化提示由 voice-model.ts 单点维护，这里只锁它的定位标记。 */
const RETRY_HINT_MARKER='上次候选或请求没有通过应用校验，请重新判断整句。';

interface PlanInput{text:string;state:string;conversationTitles?:string[];task?:{goal:string|null;requestId?:string};conversation?:VoiceConversationContext}

interface PlanRun{plan:VoiceIntentPlan;requestId?:string;attempts?:number;elapsedMs?:number;protocol?:string}

interface Entry{name:string;prefix:string;protocolInDiagnosis:boolean;run:(call:VoiceModelCall,input:PlanInput,options:{cancel?:AbortSignal})=>Promise<PlanRun>}

/** 两个入口统一成一个观察面：同一批断言各跑一遍，避免复制两套用例。 */
const entries:Entry[]=[
  {
    name:'classifyVoiceInput',
    prefix:'[voice-classifier]',
    protocolInDiagnosis:false,
    run:async(call,input)=>({plan:await classifyVoiceInput(call,input.text,input.state,input.conversationTitles,input.task,input.conversation)}),
  },
  {
    name:'prepareVoiceTurn(plan)',
    prefix:'[voice-turn]',
    protocolInDiagnosis:true,
    run:(call,input,options)=>prepareVoiceTurn(call,input,{protocol:'plan',cancel:options.cancel}),
  },
];

type CapturedContext={systemPrompt:string;messages:Array<{role:string;content:string;timestamp:number}>};

type CapturedOptions=Record<string,unknown>&{signal:AbortSignal};

type Stub={mock:{calls:Array<[unknown,CapturedContext,CapturedOptions]>}};

const callsOf=(stub:unknown)=>(stub as Stub).mock.calls;

const contextAt=(stub:unknown,index=0)=>callsOf(stub)[index]![1];

const optionsAt=(stub:unknown,index=0)=>callsOf(stub)[index]![2];

const payloadAt=(stub:unknown,index=0)=>JSON.parse(contextAt(stub,index).messages[0]!.content) as Record<string,unknown>;

afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();});

/** 断言行首前缀后取出诊断 JSON；两个入口的前缀不同但结构必须同形。 */
function diagnosisLines(lines:string[],entry:Entry):Array<Record<string,unknown>>{
  return lines.map(line=>{
    expect(line.startsWith(`${entry.prefix} `)).toBe(true);

    return JSON.parse(line.slice(entry.prefix.length+1)) as Record<string,unknown>;
  });
}

/** 收集 console.error 输出，成功与失败都要能取到诊断。 */
async function capture<T>(run:()=>Promise<T>):Promise<{result:T|undefined;error:unknown;lines:string[]}>{
  const lines:string[]=[];
  const spy=vi.spyOn(console,'error').mockImplementation((...args:unknown[])=>{lines.push(String(args[0]));});
  let result:T|undefined,error:unknown;

  try{result=await run();}catch(caught){error=caught;}finally{spy.mockRestore();}

  return {result,error,lines};
}

describe.each(entries)('$name',entry=>{
  const stub=(impl:(model:unknown,context:unknown,options:unknown)=>unknown=async()=>stop(VALID_PAUSE))=>vi.fn(impl);

  it('首轮成功：提示词、模型参数与 payload 形状一致，任务目标截断到 600 字',async()=>{
    const conversation:VoiceConversationContext={recentTurns:[{role:'user',text:'先看地图'},{role:'assistant',text:'好的'}],latestResult:null};
    const completeSimple=stub(async()=>stop(VALID_PAUSE));
    const result=await entry.run(harness(completeSimple),{text:'暂停任务。',state:'running',conversationTitles:['阅读'],task:{goal:`打开地图${'。'.repeat(1000)}`,requestId:'req-1'},conversation},{});
    expect(result.plan.steps[0]!.action).toBe('pause');
    expect(completeSimple).toHaveBeenCalledTimes(1);
    expect(callsOf(completeSimple)[0]![0]).toBe(model);
    expect(optionsAt(completeSimple)).toMatchObject({maxTokens:1400,temperature:0,sessionId:'session-1',headers});
    expect(optionsAt(completeSimple).signal).toBeInstanceOf(AbortSignal);
    // 首轮提示词与旧分类调用逐字相同，不带任何附加段。
    expect(contextAt(completeSimple).systemPrompt).toBe(VOICE_INTENT_PROMPT);
    expect(contextAt(completeSimple).systemPrompt).toContain('你只分类用户本轮语音，不执行、不回答问题。');
    const message=contextAt(completeSimple).messages[0]!;
    expect(message.role).toBe('user');
    expect(typeof message.timestamp).toBe('number');
    const payload=payloadAt(completeSimple);
    // payload 键序 fixture：可选上下文只在提供时出现，顺序固定。
    expect(Object.keys(payload)).toEqual(['state','text','clauses','conversationTitles','task','conversation']);
    expect(payload.state).toBe('running');
    expect(payload.text).toBe('暂停任务。');
    expect(payload.clauses).toEqual(['暂停任务。']);
    expect(payload.conversationTitles).toEqual(['阅读']);
    const task=payload.task as {goal:string};
    expect(task.goal).toHaveLength(600);
    expect(task.goal.startsWith('打开地图')).toBe(true);
    expect(payload.conversation).toEqual(conversation);
  });

  it('未提供的上下文不进 payload；task 存在但 goal 为 null 时保留 task.goal=null',async()=>{
    const bare=stub();
    await entry.run(harness(bare),{text:'暂停任务。',state:'idle'},{});
    expect(Object.keys(payloadAt(bare))).toEqual(['state','text','clauses']);

    const emptyTitles=stub();
    await entry.run(harness(emptyTitles),{text:'暂停任务。',state:'idle',conversationTitles:[],task:{goal:null}},{});
    const payload=payloadAt(emptyTitles);
    expect(Object.keys(payload)).toEqual(['state','text','clauses','conversationTitles','task']);
    expect(payload.conversationTitles).toEqual([]);
    expect(payload.task).toEqual({goal:null});
  });

  it('候选被校验拒绝后重试一次：第二轮带上拒绝原因与强化提示',async()=>{
    const completeSimple=stub();
    completeSimple.mockImplementationOnce(async()=>stop(VALID_PAUSE));
    completeSimple.mockImplementationOnce(async()=>stop('{"steps":[{"action":"chat","target":null}]}'));
    const result=await entry.run(harness(completeSimple),{text:'不要停',state:'running',task:{goal:null,requestId:'req-2'}},{});
    expect(result.plan.steps.map(step=>step.action)).toEqual(['chat']);
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(contextAt(completeSimple,0).systemPrompt).toBe(VOICE_INTENT_PROMPT);
    const second=contextAt(completeSimple,1).systemPrompt;
    expect(second.startsWith(VOICE_INTENT_PROMPT)).toBe(true);
    expect(second).toContain(REJECTION_HINT_FIXTURE);
    // 强化提示只在拒绝原因之后出现一次。
    expect(second.slice(VOICE_INTENT_PROMPT.length+REJECTION_HINT_FIXTURE.length)).toContain(RETRY_HINT_MARKER);
    expect(second.match(/上次拒绝原因/g)).toHaveLength(1);
  });

  it('两次候选都不过校验：给 classifier_invalid_reply，不做第三次请求',async()=>{
    const completeSimple=stub();
    const {error}=await capture(()=>entry.run(harness(completeSimple),{text:'不要停',state:'running'},{}));
    expect(error).toMatchObject({code:'classifier_invalid_reply',reason:REJECTED_BY_SEMANTICS});
    expect(completeSimple).toHaveBeenCalledTimes(2);
  });

  it('请求抛异常：总预算内重试一次，仍失败给 classifier_failed',async()=>{
    const completeSimple=stub(async()=>{throw new Error('socket down');});
    const {error,lines}=await capture(()=>entry.run(harness(completeSimple),{text:'暂停任务',state:'idle',task:{goal:null,requestId:'req-err'}},{}));
    expect(error).toMatchObject({code:'classifier_failed'});
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(diagnosisLines(lines,entry).map(record=>record.outcome)).toEqual(['request_failed','request_failed']);
  });

  it('供应商 error/aborted：首轮重试，第二轮成功才算成功',async()=>{
    const completeSimple=stub();
    completeSimple.mockImplementationOnce(async()=>ERROR_REPLY);
    completeSimple.mockImplementationOnce(async()=>stop(VALID_PAUSE));
    const {result,lines}=await capture(()=>entry.run(harness(completeSimple),{text:'暂停任务。',state:'idle'},{}));
    expect(result!.plan.steps[0]!.action).toBe('pause');
    expect(diagnosisLines(lines,entry).map(record=>record.outcome)).toEqual(['provider_failed','accepted']);
  });

  it('供应商连续失败（含 aborted 终止标记）：给 classifier_failed，不误报超时',async()=>{
    const completeSimple=stub(async()=>ABORTED_REPLY);
    const {error,lines}=await capture(()=>entry.run(harness(completeSimple),{text:'暂停任务。',state:'idle'},{}));
    expect(error).toMatchObject({code:'classifier_failed'});
    expect(completeSimple).toHaveBeenCalledTimes(2);
    expect(diagnosisLines(lines,entry).map(record=>record.outcome)).toEqual(['provider_failed','provider_failed']);
  });

  it('第一轮 6s 子预算超时后在总预算内重试成功',async()=>{
    vi.useFakeTimers();

    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation((ms:number)=>{const controller=new AbortController();setTimeout(()=>controller.abort(),ms);

return controller.signal;});

    try{
      const completeSimple=vi.fn()
        .mockImplementationOnce((_model:unknown,_context:unknown,options:{signal:AbortSignal})=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('stalled')))))
        .mockImplementationOnce(async()=>stop(VALID_PAUSE));

      const pending=entry.run(harness(completeSimple),{text:'暂停任务。',state:'running'},{});
      await vi.advanceTimersByTimeAsync(5_900);
      expect(completeSimple).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(completeSimple).toHaveBeenCalledTimes(2);
      expect((await pending).plan.steps[0]!.action).toBe('pause');
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });

  it('总预算 15s 耗尽：给 classifier_timeout，只请求两次',async()=>{
    vi.useFakeTimers();

    const timeout=vi.spyOn(AbortSignal,'timeout').mockImplementation((ms:number)=>{const controller=new AbortController();setTimeout(()=>controller.abort(),ms);

return controller.signal;});

    try{
      const completeSimple=vi.fn().mockImplementation((_model:unknown,_context:unknown,options:{signal:AbortSignal})=>new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new Error('stalled')))));
      let settled='pending';
      const failure=entry.run(harness(completeSimple),{text:'暂停任务。',state:'idle'},{}).then(()=>'ok',error=>error);
      void failure.then(()=>{settled='settled';});
      await vi.advanceTimersByTimeAsync(14_000);
      expect(completeSimple).toHaveBeenCalledTimes(2);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(failure).resolves.toMatchObject({code:'classifier_timeout'});
      expect(completeSimple).toHaveBeenCalledTimes(2);
    }finally{timeout.mockRestore();vi.useRealTimers();}
  });

  it('诊断形状与元数据：前缀、键序、requestId、尝试号与耗时',async()=>{
    const completeSimple=stub();
    const {lines}=await capture(()=>entry.run(harness(completeSimple),{text:'暂停任务。',state:'running',task:{goal:null,requestId:'req-1'}},{}));
    expect(lines).toHaveLength(1);
    const records=diagnosisLines(lines,entry);
    expect(Object.keys(records[0]!)).toEqual(entry.protocolInDiagnosis?['requestId','attempt','elapsedMs','outcome','protocol','actions']:['requestId','attempt','elapsedMs','outcome','actions']);
    expect(records[0]).toMatchObject({requestId:'req-1',attempt:1,outcome:'accepted',actions:['pause']});
    expect(records[0]!.elapsedMs).toBeGreaterThanOrEqual(0);

    if(entry.protocolInDiagnosis)expect(records[0]!.protocol).toBe('plan');else expect(records[0]!.protocol).toBeUndefined();

    const generated=stub();
    const withoutRequestId=await capture(()=>entry.run(harness(generated),{text:'暂停任务。',state:'running'},{}));
    expect(String(diagnosisLines(withoutRequestId.lines,entry)[0]!.requestId)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('诊断形状：被拒绝的候选带 reason、不带 actions',async()=>{
    const completeSimple=stub();
    completeSimple.mockImplementationOnce(async()=>stop(VALID_PAUSE));
    completeSimple.mockImplementationOnce(async()=>stop(VALID_PAUSE));
    const {lines}=await capture(()=>entry.run(harness(completeSimple),{text:'不要停',state:'running'},{}));
    const records=diagnosisLines(lines,entry);
    expect(Object.keys(records[0]!)).toEqual(entry.protocolInDiagnosis?['requestId','attempt','elapsedMs','outcome','protocol','reason']:['requestId','attempt','elapsedMs','outcome','reason']);
    expect(records[0]).toMatchObject({attempt:1,outcome:'candidate_rejected',reason:REJECTED_BY_SEMANTICS});
    expect(records[1]).toMatchObject({attempt:2,outcome:'candidate_rejected',reason:REJECTED_BY_SEMANTICS});
  });
});

describe('两个入口共用一份计划流程',()=>{
  it('同一输入与同一模型应答脚本下，两轮请求的提示词与 payload 逐字节相同',async()=>{
    // timestamp 来自 Date.now()，跨毫秒采样会让逐字节比较偶发失败；这里固定时钟，仍比较完整请求。
    vi.spyOn(Date,'now').mockReturnValue(1_700_000_000_000);
    const input:PlanInput={text:'其实我要看YouTube。',state:'running',conversationTitles:['阅读'],task:{goal:'打开地图',requestId:'req-shared'},conversation:{recentTurns:[{role:'user',text:'先看地图'}],latestResult:null}};

    const requests=entries.map(entry=>{
      const completeSimple=vi.fn()
        .mockImplementationOnce(async()=>stop(VALID_PAUSE))
        .mockImplementationOnce(async()=>stop('{"steps":[{"action":"steer","target":null}]}'));

      return entry.run(harness(completeSimple),input,{}).then(result=>({
        actions:result.plan.steps.map(step=>step.action),
        calls:callsOf(completeSimple).map(([passedModel,context,options])=>JSON.stringify({model:passedModel,context,options:{...options,signal:undefined}})),
      }));
    });

    const [classify,turn]=await Promise.all(requests);
    expect(classify!.actions).toEqual(['steer']);
    expect(turn!.actions).toEqual(['steer']);
    expect(classify!.calls).toHaveLength(2);
    expect(turn!.calls).toEqual(classify!.calls);
  });

  it('prepareVoiceTurn 仍是计划协议：返回计划、正文为 null、attempts/elapsedMs/requestId 齐备',async()=>{
    const completeSimple=vi.fn(async(_model:unknown,_context:unknown,_options:unknown)=>stop(VALID_PAUSE));
    const prepared=await prepareVoiceTurn(harness(completeSimple),{text:'暂停任务。',state:'running',task:{goal:null,requestId:'req-meta'}},{protocol:'plan'});
    expect(prepared).toMatchObject({replyText:null,protocol:'plan',requestId:'req-meta',attempts:1});
    expect(prepared.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(prepared.plan.steps[0]!.action).toBe('pause');
    // classifyVoiceInput 的返回值保持"只有计划"，不因合并多出元数据字段。
    const classified=await classifyVoiceInput(harness(vi.fn(async(_model:unknown,_context:unknown,_options:unknown)=>stop(VALID_PAUSE))),'暂停任务。','running');
    expect(Object.keys(classified)).toEqual(['steps']);
  });

  it('计划取消只给一次请求、诊断记为 cancelled，不重试',async()=>{
    const controller=new AbortController();

    const completeSimple=vi.fn(async(_model:unknown,_context:unknown,_options:unknown)=>{
      controller.abort();
      throw new Error('superseded');
    });

    const {error,lines}=await capture(()=>prepareVoiceTurn(harness(completeSimple),{text:'暂停任务。',state:'running',task:{goal:null,requestId:'req-cancel'}},{protocol:'plan',cancel:controller.signal}));
    expect(error).toMatchObject({code:'classifier_failed'});
    expect(completeSimple).toHaveBeenCalledTimes(1);
    const records=diagnosisLines(lines,entries[1]!);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({requestId:'req-cancel',attempt:1,outcome:'cancelled',protocol:'plan'});
  });
});
