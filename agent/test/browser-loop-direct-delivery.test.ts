import {afterEach,describe,expect,it,vi} from 'vitest';

vi.mock('../src/display-fast-path.js',()=>({displayFastPathEnabled:vi.fn(()=>false),displaySteerFastPathEnabled:()=>false,decideDisplay:vi.fn()}));

vi.mock('../src/skill-fast-loop.js',()=>({trySkillFastLoop:vi.fn(async()=>({kind:'miss',reason:'no saved skill'})),loadFastSkillOptions:vi.fn(async()=>[])}));

vi.mock('../src/fast-task.js',()=>({decideFastTask:vi.fn(async()=>({kind:'miss',reason:'no_candidate'}))}));

// 合成会话不写用户真实 trace（与 session-pre-observation.test.ts 同策略）。
vi.mock('../src/run-trace.js',()=>({RunTrace:class{begin(){}correlate(){}record(){}event(){}stage(){return{end(){}}}},
  sanitizeTrace:(text:string)=>String(text)}));

vi.mock('../src/jev-client.js',async original=>({...await original<typeof import('../src/jev-client.js')>(),askJev:vi.fn()}));

// 语义复核替身：直接交付不得新增一次裁决调用（只计调用，不改变交付门槛）。
vi.mock('../src/goal-reasoning-review.js',()=>({reviewTaskGoal:vi.fn(async()=>({matched:true,probability:.99,reason:'test'}))}));

import {BrowserAgentSession} from '../src/session.js';
import {TaskProgress} from '../src/task-progress.js';
import {createBrowserTools} from '../src/tools.js';
import {createSendUserMessageTool} from '../src/user-delivery.js';
import {askJev,type JevAnswers,type JevRequest} from '../src/jev-client.js';
import {reviewTaskGoal} from '../src/goal-reasoning-review.js';
import type {AgentUiEvent,PageContext} from '../../shared/protocol.js';
import type {TaskGoalDefinition} from '../../shared/task-goals.js';
import type {TaskProgressSnapshot} from '../../shared/voice.js';

/**
 * 这些回归从真实生产入口 sendUserMessage → promptWithFreshPageObservation → generalEligible
 * → runInitialBrowserLoop → 正式交付 走一遍，账本是真 TaskProgress，循环是真 browser_loop 工具，
 * 交付是真 createSendUserMessageTool；只有 Jev 决策与浏览器 RPC 用替身。
 * 目标方案由 task_goals 工具写入账本的同一组 API 建立（install/verify），不构造无法产生的新状态。
 */

afterEach(()=>{vi.unstubAllEnvs();vi.clearAllMocks();vi.mocked(askJev).mockReset();vi.mocked(reviewTaskGoal).mockClear();});

const REQUEST='把当前页第一条置顶评论的正文填到笔记编辑器，不要保存';

const CONTEXT:PageContext={tabId:77,title:'评论页',url:'https://test.invalid/comments'};

const page={id:'obs-1',tabId:77,documentId:'doc-1',url:CONTEXT.url,observedAt:Date.now(),source:'accessibility' as const,text:'页面文本',truncated:false,controls:[{ref:'@1',role:'button',name:'保存',disabled:false},{ref:'@2',role:'checkbox',name:'只看可用项目',disabled:false,checked:true}]};

interface Wrapped {
  explicitDelivery:boolean;
  skillStore:unknown;
  modeState:{value:string};
  bindConversationContext(fn:()=>TaskProgressSnapshot|null):void;
  bindTaskResults(host:unknown):void;
  bindDeliveryRun(fn:()=>string|null):void;
  executionEpoch():number;
  observeProgramStep(step:unknown):void;
  assertTaskResultExecution(name:string,params:Record<string,unknown>,id?:string):void;
  sendUserMessage(text:string,context?:PageContext):void;
  abort():void;
}

/** done = 循环看到要求已满足（复选框已勾选，不点）；click = 先点「保存」再判定完成。 */
type DecisionKind='done'|'click';

/** satisfied-conditions=已规划且全部满足；material-*=带原文材料目标的复制任务；pending=仍有未完成项。 */
type PlanVariant='satisfied-conditions'|'material-captured'|'material-missing'|'pending';

interface HarnessOptions {
  /** 目标方案：
   *  satisfied-conditions=已规划且全部满足；pending=已规划但仍有未完成项；
   *  material-captured/material-missing=带材料目标的复制任务，材料在本轮材料库/不在；
   *  none=没有目标方案。 */
  plan?:PlanVariant|'none';
  /** 循环里 Jev 的判断；默认看到要求已满足、不写页面。 */
  decisions?:DecisionKind[];
  /** 点击后 Jev 的完成判断概率（默认 0.95）。 */
  doneAfterClick?:number;
  /** 每次决策前的钩子：用于在循环中途取消/接管。 */
  onDecide?:(h:ReturnType<typeof harness>)=>void;
}

function harness(options:HarnessOptions={}){
  vi.stubEnv('SIDEAGENT_GENERAL_BROWSER_LOOP','1');
  const progress=new TaskProgress('default');
  const events:AgentUiEvent[]=[];
  const toolNames:string[]=[];
  const statuses:string[]=[];

  const record=(event:AgentUiEvent)=>{
    events.push(event);

    if(event.kind==='tool_start')toolNames.push(event.name);
    progress.observe({type:'agent_event',sessionId:'main',event});
  };

  const callbacks={emit:vi.fn(record),setStatus:vi.fn((state:string)=>{statuses.push(state);progress.observe({type:'status',state} as never);})};

  const rpc={
    call:vi.fn(async(name:string,params:Record<string,unknown>)=>{
      if(name==='snapshot'&&params.decision===true)return {tabId:CONTEXT.tabId,text:'页面文本',observation:{...page,observedAt:Date.now()}};

      if(name==='snapshot')return {tabId:CONTEXT.tabId,url:CONTEXT.url,text:'页面文本'};

      if(name==='click')return {clicked:true,effect:{changed:false}};
      throw new Error(`unexpected rpc ${name}`);
    }),
    setPageTarget:vi.fn(),
    getPageTarget:vi.fn(()=>CONTEXT.tabId),
    getExecutionFact:vi.fn(()=>'executed'),
    noteToolFact:vi.fn(),
    ensureToolCall:vi.fn(),
    markCallRejected:vi.fn(),
  };

  const Session=BrowserAgentSession as unknown as new (...args:unknown[])=>BrowserAgentSession;

  const raw={
    get isStreaming(){return false;},
    model:{id:'test'},
    sessionId:'session-test',
    agent:{state:{messages:[],tools:[] as Array<{name:string}>}},
    abort:vi.fn(async()=>{}),
    prompt:vi.fn(async (_text?:unknown)=>{}),
    steer:vi.fn(async (_text?:unknown)=>{}),
    sendCustomMessage:vi.fn(async (_message?:unknown)=>{}),
    subscribe:vi.fn(()=>()=>{}),
  };

  const wrapped=new Session(raw,null,callbacks,null,null,undefined,null,rpc) as unknown as Wrapped;

  wrapped.explicitDelivery=true;
  wrapped.skillStore=null;
  wrapped.modeState={value:'act'};
  wrapped.bindConversationContext(()=>progress.snapshot());
  wrapped.bindTaskResults({
    getSnapshot:()=>progress.snapshot(),
    goals:progress.goals,
    register:()=>{},
    verify:()=>({ok:true}),
    deliveryFacts:()=>progress.deliveryFacts(),
  });
  wrapped.bindDeliveryRun(()=>progress.snapshot().runId??null);
  raw.agent.state.tools=[
    ...createBrowserTools(rpc as never,undefined,undefined,undefined,{
      goal:()=>REQUEST,
      userText:()=>REQUEST,
      reserveDecision:vi.fn(),
      epoch:()=>wrapped.executionEpoch(),
      canWrite:()=>true,
      assertCall:(name,params,id)=>wrapped.assertTaskResultExecution(name,params,id),
      onStep:step=>wrapped.observeProgramStep(step),
    },undefined),
    createSendUserMessageTool({
      conversationId:'default',
      getRunId:()=>progress.snapshot().runId??null,
      emit:event=>record(event),
      getNextStep:()=>progress.snapshot().nextStep??null,
      getDeliveryFacts:()=>progress.deliveryFacts(),
    }),
  ];
  const decisions=options.decisions??['done'];
  const kind=decisions[0]!;
  // 按问题名作答的 Jev 替身：只能选各问题 criteria 里的选项，与真实接口一致。
  vi.mocked(askJev).mockImplementation(async(request:JevRequest)=>{
    options.onDecide?.(handle);
    const answers:JevAnswers={};

    for(const [name,question] of Object.entries(request.questions)){
      const criteria=((question as {criteria?:Record<string,string>}).criteria??{}) as Record<string,string>;
      const id=(label:string)=>Object.entries(criteria).find(([key,d])=>key!=='none'&&d.includes(`"${label}"`))?.[0]??'none';
      const acted=((request.state.actions_done??[]) as string[]).length>0;
      answers[name]=({
        target:{choice:id(kind==='click'?'保存':'只看可用项目'),confidence:.99},
        target_listed:{noul:.99},
        opener:{choice:'none',confidence:.99},
        risky:{noul:.03},
        turn_on:{noul:.98},
        goal_done:{noul:acted?(options.doneAfterClick??.95):.02},
      } as JevAnswers)[name]!;
    }

    return answers;
  });

  /** task_goals 写账本的同一组 API（install/verify）建立目标方案；材料与 capture_page_material 落账形状一致。 */
  const plan=(variant:PlanVariant)=>{
    const snapshot=progress.snapshot();
    const revision=snapshot.goalPlan!.revision;
    const runId=snapshot.runId!;

    const definitions:TaskGoalDefinition[]=variant==='satisfied-conditions'
      ? [
          {id:'g-editor',description:'「笔记」编辑器含完整评论正文，未保存',criterion:'编辑器读回等于已核验原文材料，且没有点击保存',requirements:['requirement-1'],kind:'condition'},
          {id:'g-check',description:'「只看可用项目」已勾选',criterion:'同一页面上该复选框读回为已勾选',requirements:['requirement-1'],kind:'condition'},
        ]
      : [
          {id:'g-source',description:'来源：当前页第一条置顶评论的完整正文',criterion:'原文材料与页面选定正文逐字一致',requirements:['requirement-1'],kind:'material',materialId:'comment'},
          {id:'g-editor',description:'目标：「笔记」编辑器含完整评论正文，未保存',criterion:'编辑器读回等于原文材料，且没有点击保存',requirements:['requirement-1'],kind:'field',materialId:'comment'},
        ];

    progress.goals.install(revision,definitions,1);
    const evidence={observationId:'obs-proof',tabId:CONTEXT.tabId,verifiedAt:Date.now()};

    if(variant==='satisfied-conditions'){
      progress.goals.verify(revision,'g-editor',{matched:true,reason:'编辑器读回与已核验原文一致',evidence});
      progress.goals.verify(revision,'g-check',{matched:true,reason:'复选框读回为已勾选',evidence});

      return;
    }

    if(variant==='material-captured')captureMaterial(runId,revision);
    progress.goals.verify(revision,'g-source',{matched:true,reason:'已捕获并核对本项目标的完整原文',evidence:{...evidence,materialId:'comment'}});

    if(variant!=='pending')progress.goals.verify(revision,'g-editor',{matched:true,reason:'编辑器读回与原文材料一致',evidence:{...evidence,materialId:'comment'}});
  };

  /** 与检查点恢复相同入口写入本轮材料库：runId/revision 取当前任务，不新建第二份存储。 */
  const captureMaterial=(runId:string,revision:string)=>{
    (wrapped as unknown as {taskEvidence:{restore(value:unknown):void}}).taskEvidence.restore({
      id:'comment',purpose:'复制来源：第一条置顶评论正文',value:'第一条置顶评论正文',source:'observed',
      observation:{id:'obs-1',runId,revision,tabId:CONTEXT.tabId,url:CONTEXT.url,truncated:false,at:Date.now()},
      selection:{kind:'text',spans:[{start:0,end:9}]},
    });
  };

  const settle=async()=>{for(let i=0;i<40;i++)await new Promise(resolve=>setTimeout(resolve,0));};

  const send=async(text=REQUEST,context:PageContext|undefined=CONTEXT)=>{
    wrapped.sendUserMessage(text,context);
    await settle();
  };

  const deliveries=()=>events.filter(event=>event.kind==='user_delivery');
  const handle={progress,raw,wrapped,events,toolNames,deliveries,settle,send,plan,captureMaterial,statuses:()=>statuses};

  return handle;
}

/** 目标要求的原话就是 REQUEST，所以账本覆盖的正是本轮请求。 */
function started(options:HarnessOptions={}){
  const h=harness(options);
  h.progress.request(REQUEST,CONTEXT);
  const plan=options.plan??'satisfied-conditions';

  if(plan==='none')h.progress.goals.clear();
  else h.plan(plan);

  return h;
}

describe('浏览器循环收尾：已有完整有效宿主证据时直接交付',()=>{
  it('已规划且全部要求有有效宿主证据：真实入口直接交付，主模型 prompt 为 0',async()=>{
    const h=started({plan:'satisfied-conditions'});
    const before=h.progress.snapshot();
    expect(before.goalPlan?.coverage).toBe('verified');
    expect(before.nextStep).toMatchObject({action:'deliver',reason:'receipts_reviewed',delivery:'report'});

    await h.send();

    // 循环真的从生产入口跑过，且提议核验（循环没有 completed 状态）。
    expect(h.toolNames[0]).toBe('browser_loop');
    expect(h.raw.prompt).not.toHaveBeenCalled();
    const deliveries=h.deliveries();
    expect(deliveries).toHaveLength(1);
    const delivery=deliveries[0]!;
    expect(delivery.kind==='user_delivery'&&delivery.delivery.kind).toBe('finding');

    if(delivery.kind!=='user_delivery')throw new Error('expected a delivery');
    expect(delivery.delivery.text).toContain('已核对完成');
    expect(delivery.delivery.text).toContain('「笔记」编辑器含完整评论正文，未保存');
    expect(delivery.delivery.facts?.outcome).toBe('complete');
    expect(delivery.delivery.facts?.remaining).toEqual([]);
    // 没有新增裁决调用来假装省下主模型：只有循环自己的 Jev 判断（找控件、开关方向、完成判断），目标/材料复核一次没调。
    expect(vi.mocked(askJev)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(reviewTaskGoal)).not.toHaveBeenCalled();
    // 正式交付走既有通道：同一轮只交付一次（已发出的交付不会因后续记录失败改成重复交付），交付后本轮结束。
    expect(h.toolNames.filter(name=>name==='send_user_message')).toHaveLength(1);
    expect(h.raw.sendCustomMessage).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toContain('idle');
    expect(h.events.filter(event=>event.kind==='agent_end')).toHaveLength(1);
  });

  it('带原文材料的复制任务：材料证书在本轮材料库里，仍直接交付',async()=>{
    const h=started({plan:'material-captured'});
    await h.send();
    expect(h.raw.prompt).not.toHaveBeenCalled();
    expect(h.deliveries()).toHaveLength(1);
  });

  it('材料证据已不在本轮材料库：不直接交付',async()=>{
    const h=started({plan:'material-missing'});
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('已有完整证据但要求仍有未完成项：不直接交付，把剩余目标交主模型',async()=>{
    const h=started({plan:'pending'});
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(String(h.raw.prompt.mock.calls.at(0)?.[0])).toContain('[Browser execution handoff]');
    expect(h.deliveries()).toHaveLength(0);
  });

  it('没有目标方案：循环可以跑，但不拿不存在的证据直接交付',async()=>{
    const h=started({plan:'none'});
    expect(h.progress.snapshot().goalPlan).toBeUndefined();
    await h.send();
    expect(h.toolNames).toContain('browser_loop');
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('未规划占位目标不进入通用循环：保持现有目标门槛，交主模型先规划',async()=>{
    const h=harness();
    h.progress.request(REQUEST,CONTEXT);
    expect(h.progress.snapshot().goalPlan?.coverage).toBe('unplanned');
    await h.send();
    expect(h.toolNames).not.toContain('browser_loop');
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('循环本轮执行过页面写入：不直接交付，交主模型按真实事实处理',async()=>{
    const h=started({plan:'satisfied-conditions',decisions:['click','done']});
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
    // 写入只执行一次；两条旧证据已按既有失效规则回到未核验，没有被当成完成。
    expect(h.progress.snapshot().goalPlan?.goals.map(goal=>goal.status)).toEqual(['pending','pending']);
  });

  it('已有未知写入时，即使目标看似满足也不直接交付',async()=>{
    const h=started({plan:'satisfied-conditions'});
    h.progress.observe({type:'agent_event',sessionId:'main',event:{kind:'tool_start',toolCallId:'w1',name:'fill',params:{tabId:99,target:'@9',value:'x'}}});
    h.progress.observe({type:'agent_event',sessionId:'main',event:{kind:'tool_end',toolCallId:'w1',name:'fill',isError:true,resultText:'填写失败，结果未知。',executionFact:'executed'}});
    expect(h.progress.snapshot().results?.some(item=>item.status==='unknown')).toBe(true);
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('证据已被页面变化失效：不直接交付',async()=>{
    const h=started({plan:'satisfied-conditions'});
    h.progress.invalidatePage(CONTEXT.tabId,CONTEXT.url);
    expect(h.progress.snapshot().goalPlan?.goals.map(goal=>goal.status)).toEqual(['pending','pending']);
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('本轮请求不是账本覆盖的那条要求（新说法尚未登记）：不拿旧证据交付',async()=>{
    const h=started({plan:'satisfied-conditions'});
    await h.send('改成第二条评论的正文，同样不要保存');
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('循环期间取消或接管：不交付，也不触发过期的主模型 prompt',async()=>{
    const h=started({plan:'satisfied-conditions',onDecide:host=>{host.wrapped.abort();}});
    await h.send();
    expect(h.raw.prompt).not.toHaveBeenCalled();
    expect(h.deliveries()).toHaveLength(0);
  });

  it('循环中途被新任务替换（runId 变化）：旧循环不交付',async()=>{
    const h=started({plan:'satisfied-conditions',onDecide:host=>{
      const before=host.progress.snapshot().runId;
      host.progress.abort();
      host.progress.request('另一个新任务',CONTEXT);
      expect(host.progress.snapshot().runId).not.toBe(before);
    }});

    await h.send();
    expect(h.raw.prompt).not.toHaveBeenCalled();
    expect(h.deliveries()).toHaveLength(0);
  });
});

describe('开关打开时：循环自己判定完成的低风险点击直接交付',()=>{
  // 失败方式：开关关着也直接交付；完成判断不到 0.85 仍交付；交付文字说成别的控件；交付后又 prompt 主模型。
  it('开关关闭（默认）：点击后仍交主模型核对',async()=>{
    const h=started({plan:'none',decisions:['click']});
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });

  it('开关打开、完成判断达到门槛：真实入口直接交付，主模型 prompt 为 0',async()=>{
    vi.stubEnv('SIDEAGENT_BROWSER_LOOP_DIRECT_DELIVERY','1');
    const h=started({plan:'none',decisions:['click']});
    await h.send();
    expect(h.raw.prompt).not.toHaveBeenCalled();
    const deliveries=h.deliveries();
    expect(deliveries).toHaveLength(1);
    const delivery=deliveries[0]!;

    if(delivery.kind!=='user_delivery')throw new Error('expected a delivery');
expect(delivery.delivery.text).toContain('已完成：点击了「保存」。');
    expect(h.events.filter(event=>event.kind==='agent_end')).toHaveLength(1);
  });

  it('开关打开、完成判断不到门槛：交主模型核对，不交付',async()=>{
    vi.stubEnv('SIDEAGENT_BROWSER_LOOP_DIRECT_DELIVERY','1');
    const h=started({plan:'none',decisions:['click'],doneAfterClick:.84});
    await h.send();
    expect(h.raw.prompt).toHaveBeenCalledTimes(1);
    expect(h.deliveries()).toHaveLength(0);
  });
});
