/**
 * Ticket 3: a running task's explicit display change goes through the same registered tools,
 * keeps the original run/task, records the verified fact back into the original task, and
 * never starts a new task or ends the current one.
 *
 * The browser tool layer is the real `createBrowserTools` gate, so the correction fence
 * ("旧步骤未执行") is exercised for real rather than asserted on a private queue.
 */
import {beforeEach,describe,expect,it,vi} from 'vitest';

vi.mock('../src/display-fast-path.js',()=>({
  displayFastPathEnabled:()=>true,
  displaySteerFastPathEnabled:vi.fn(()=>true),
  decideDisplay:vi.fn(),
}));

vi.mock('../src/run-trace.js',async(importOriginal)=>{
 const actual=await importOriginal<typeof import('../src/run-trace.js')>();

 return {...actual,RunTrace:class{begin(){}correlate(){}record(){}event(){}stage(){return{end(){}}}}};
});

import {decideDisplay,displaySteerFastPathEnabled} from '../src/display-fast-path.js';
import {TaskActionRejected} from '../src/task-dispatcher.js';
import {candidate,context,managerHarness,pageHarness} from './fixtures/display-steering-harness.js';

beforeEach(()=>{
 vi.mocked(decideDisplay).mockReset();
 vi.mocked(displaySteerFastPathEnabled).mockReturnValue(true);
});

describe('运行中显示修改（文字）',()=>{
 it('applies an explicit font change in the original run and hands the verified fact back to the task',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-applied',text:'译文已改成宋体。'});
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls).toHaveLength(1);
  expect(h.translationCalls[0]).toMatchObject({action:'display',fontFamily:'songti',document:'one',tabId:7});
  expect(h.raw.prompt).not.toHaveBeenCalled();
  expect(h.emitted.some(event=>event.kind==='agent_end')).toBe(false);
  expect(h.wrapper.isStreaming()).toBe(true);
  expect(h.steers).toHaveLength(1);
  expect(h.steers[0]).toContain('译文已改成宋体');
  expect(h.steers[0]).toContain('不需要再由你执行一次');
  // 模型读到这条要求之前旧写入仍被挡住；读到时闸门放开，原任务可以继续完成剩余步骤。
  expect(h.wrapper.canWriteCurrentInput()).toBe(false);
  h.messageStart(h.steers[0]!);
  expect(h.wrapper.canWriteCurrentInput()).toBe(true);
  await h.tool('page_translation').execute('next-plan',{action:'display',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState.mode).toBe('bilingual');
 });

 it('keeps the old plan write blocked until the corrected requirement is actually consumed',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  await expect(h.tool('page_translation').execute('old-plan',{action:'display',mode:'bilingual',tabId:7,document:'one'}))
   .rejects.toThrow(/已补充或改变要求/);
  release({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const outcome=await steering;
  expect(outcome).toMatchObject({kind:'display-applied'});
  expect(h.pageState.mode).toBe('translated');
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls.map(call=>call.action)).toEqual(['display']);
 });

 it('uses normal steering once the model is running even if the new-task display work is still pending',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  h.wrapper.displayWork=Promise.resolve();
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-applied'});
  expect(h.translationCalls).toHaveLength(1);
  expect(h.raw.prompt).not.toHaveBeenCalled();
 });

 it('merges the requirement into one prompt only when the model has not started yet',async()=>{
  const h=pageHarness({streaming:false});
  let release!:()=>void;
  h.wrapper.displayWork=new Promise<void>(resolve=>{release=resolve;});
  h.wrapper.activeGoal='读取这篇文章';
  const steering=h.wrapper.steerCurrentTask('改成宋体',context);
  release();
  const outcome=await steering;
  expect(outcome).toEqual({kind:'model'});
  expect(h.raw.prompt).toHaveBeenCalledTimes(1);
  const promptText=h.raw.prompt.mock.calls[0]![0] as string;
  expect(promptText).toContain('原任务：读取这篇文章');
  expect(promptText).toContain('用户最新修改：改成宋体');
  expect(h.translationCalls).toHaveLength(0);
 });

 it('falls back to the original model path for mixed or uncertain requests',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason:'extra_or_uncertain'});
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体并总结一下标题',context);
  expect(outcome).toEqual({kind:'model'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers[0]).toContain('把译文改成宋体并总结一下标题');
 });

 it('does not call Jev or the display tool when the steering switch is off',async()=>{
  const h=pageHarness();
  vi.mocked(displaySteerFastPathEnabled).mockReturnValue(false);
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toEqual({kind:'model'});
  expect(decideDisplay).not.toHaveBeenCalled();
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers).toHaveLength(1);
 });

 it('does not write when the user takes over while Jev is still deciding',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  h.wrapper.holdForUser({abortStream:false});
  release({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  await expect(steering).rejects.toBeInstanceOf(TaskActionRejected);
  expect(h.translationCalls).toHaveLength(0);
  expect(h.pageState.fontFamily).toBe('original');
  h.wrapper.abort();
 });

 it('reports an unknown receipt as unknown, never retries it, and tells the task not to redo it',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  h.failNextPageTranslation(Object.assign(new Error('回执丢失'),{executionFact:'unknown'}),'unknown');
  h.forceFact('page_translation','unknown');
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-unknown',reason:'回执丢失'});
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers[0]).toContain('结果未知');
  expect(h.steers[0]).toContain('不要自动重做');
 });

 it('does not notify a partial-scope fallback as if the whole page had been changed',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason:'partial_or_uncertain',partialScope:true});
  const outcome=await h.wrapper.steerCurrentTask('把这段标题改成宋体',context);
  expect(outcome).toEqual({kind:'model'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.wrapper.displayScopeBlockedRun).toBe('run-1');
 });
});

describe('运行中显示修改的调度归属',()=>{
 it('keeps the same run id, keeps the task running, and lets the original task finish later',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',mode:'translated'},reason:'accepted'});
  const receipt=await manager.dispatchTaskAction({requestId:'steer-1',conversationId:'default',source:'text',action:'steer',expectedRunId:before.runId??null,text:'只显示译文',context});
  expect(receipt.status).toBe('applied');
  expect(receipt.message).toContain('已直接应用并核对');
  const during=manager.getTaskProgress('default')!;
  expect(during.runId).toBe(before.runId);
  expect(during.state).toBe('running');
  expect(h.pageState.mode).toBe('translated');
  // 原任务读到事实后继续，并在稍后正常结束；这不是新任务。
  h.messageStart(h.steers.at(-1)!);
  h.agentEnd();
  const after=manager.getTaskProgress('default')!;
  expect(after.runId).toBe(before.runId);
  expect(after.state).toBe('idle');
 });

 it('replaying the same request does not execute the display change twice',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  const request={requestId:'steer-replay',conversationId:'default',source:'text' as const,action:'steer' as const,expectedRunId:before.runId??null,text:'把译文改成宋体',context};
  const first=await manager.dispatchTaskAction(request);
  const replay=await manager.dispatchTaskAction(request);
  expect(first.status).toBe('applied');
  expect(replay.status).toBe('applied');
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers).toHaveLength(1);
 });

 it('routes a plain steer client message through the same scheduling entry as voice',async()=>{
  const {h,manager,emitted}=await managerHarness();
  const runId=manager.getTaskProgress('default')!.runId;
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  await manager.handleMessage({type:'steer',text:'把译文改成宋体',context,conversationId:'default'} as never);
  expect(h.pageState.fontFamily).toBe('songti');
  expect(h.translationCalls).toHaveLength(1);
  expect(manager.getTaskProgress('default')!.runId).toBe(runId);
  expect(manager.getTaskProgress('default')!.recoveryInput?.requirements).toContain('把译文改成宋体');
  expect(emitted.some(message=>message.type==='agent_event'&&(message as any).event?.kind==='notice'&&String((message as any).event.message).includes('已直接应用并核对'))).toBe(true);
 });

 it('keeps the requirement and the action itself visible in the task progress',async()=>{
  const {h,manager}=await managerHarness();
  const before=manager.getTaskProgress('default')!;
  vi.mocked(decideDisplay).mockResolvedValue({kind:'candidate',params:{action:'display',fontFamily:'songti'},reason:'accepted'});
  await manager.dispatchTaskAction({requestId:'steer-record',conversationId:'default',source:'text',action:'steer',expectedRunId:before.runId??null,text:'把译文改成宋体',context});
  const progress=manager.getTaskProgress('default')!;
  expect(progress.recoveryInput?.requirements).toContain('把译文改成宋体');
  expect(progress.conversationContext?.recentTurns?.some(turn=>turn.role==='user'&&turn.text==='把译文改成宋体')).toBe(true);
  // 显示工具的真实回执进入结果账本，原任务继续时不会把它当成待办重做。
  expect((progress.results??[]).some(item=>item.tool==='page_translation')).toBe(true);
 });
});

describe('连续修改与竞态（Ticket 4）',()=>{
 it('later same-property request wins while a different property is preserved',async()=>{
  const {h,manager}=await managerHarness();
  const request=(id:string,text:string)=>({requestId:id,conversationId:'default',source:'text' as const,action:'steer' as const,expectedRunId:manager.getTaskProgress('default')!.runId??null,text,context});
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode:'bilingual'}));
  expect((await manager.dispatchTaskAction(request('c1','切回双语'))).status).toBe('applied');
  h.messageStart(h.steers.at(-1)!);
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode:'translated'}));
  expect((await manager.dispatchTaskAction(request('c2','还是只显示译文'))).status).toBe('applied');
  expect(h.pageState.mode).toBe('translated');
  h.messageStart(h.steers.at(-1)!);
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({fontFamily:'songti'}));
  expect((await manager.dispatchTaskAction(request('c3','字体改成宋体'))).status).toBe('applied');
  expect(h.pageState.mode).toBe('translated');
  expect(h.pageState.fontFamily).toBe('songti');
  expect(manager.getTaskProgress('default')!.runId).toBe(request('x','x').expectedRunId);
 });

 it('preserves a partial-scope fallback while a later whole-page request clears it',async()=>{
  const {h,manager}=await managerHarness();
  const runId=manager.getTaskProgress('default')!.runId??null;
  vi.mocked(decideDisplay).mockResolvedValueOnce({kind:'fallback',reason:'partial_or_uncertain',partialScope:true});
  const partial=await manager.dispatchTaskAction({requestId:'p1',conversationId:'default',source:'text',action:'steer',expectedRunId:runId,text:'只把标题改成宋体',context});
  expect(partial.status).toBe('accepted');
  expect(h.wrapper.displayScopeBlockedRun).toBe(runId);
  // 模型读到这条要求之前，旧写入先被补充闸门挡住。
  await expect(h.tool('page_translation').execute('before-consume',{action:'display',fontFamily:'songti',tabId:7,document:'one'})).rejects.toThrow(/已补充或改变要求/);
  h.messageStart(h.steers.at(-1)!);
  // 读到之后整页写入仍被局部范围约束挡住；约束随回退保留。
  await expect(h.tool('page_translation').execute('old-plan',{action:'display',fontFamily:'songti',tabId:7,document:'one'})).rejects.toThrow(/整页/);
  expect(h.pageState.fontFamily).toBe('original');
  vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({fontFamily:'songti'}));
  const whole=await manager.dispatchTaskAction({requestId:'p2',conversationId:'default',source:'text',action:'steer',expectedRunId:runId,text:'把整页译文都改成宋体',context});
  expect(whole.status).toBe('applied');
  expect(h.pageState.fontFamily).toBe('songti');
 });

 it('invalidates the request, without a model fallback, when the same-URL document changes while Jev decides',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockImplementation(async()=>{h.pageState.document='two';

return candidate({fontFamily:'songti'});});
  await expect(h.wrapper.steerCurrentTask('把译文改成宋体',context)).rejects.toThrow('页面实例已变化');
  expect(h.translationCalls).toHaveLength(0);
  expect(h.steers).toHaveLength(0);
  expect(h.wrapper.canWriteCurrentInput()).toBe(true);
  expect(h.pageState.fontFamily).toBe('original');
 });

 it('reports a failed verification instead of success when the document changes after the write',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const original=h.rpc.call.getMockImplementation()!;
  let snapshots=0;
  h.rpc.call.mockImplementation(async(name:string,params:any,...rest:any[])=>{
   const result=await original(name,params,...rest);

   if(name==='snapshot'){
    snapshots+=1;

    if(snapshots===3)return {...result,translation:{...result.translation,document:'two'}};
   }

   return result;
  });
  const outcome=await h.wrapper.steerCurrentTask('把译文改成宋体',context);
  expect(outcome).toMatchObject({kind:'display-failed'});
  expect(h.translationCalls).toHaveLength(1);
  expect(h.steers.at(-1)).toContain('没有通过读回核对');
 });

 it('does not write after the user aborted while Jev was deciding',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  h.wrapper.abort();
  release(candidate({fontFamily:'songti'}));
  await expect(steering).rejects.toBeInstanceOf(TaskActionRejected);
  expect(h.translationCalls).toHaveLength(0);
  expect(h.pageState.fontFamily).toBe('original');
 });

 it('does not write when the original run ended while Jev was deciding',async()=>{
  const h=pageHarness();
  let release!:(value:any)=>void;
  vi.mocked(decideDisplay).mockImplementation(()=>new Promise(resolve=>{release=resolve;}));
  const steering=h.wrapper.steerCurrentTask('把译文改成宋体',context);
  await vi.waitFor(()=>expect(decideDisplay).toHaveBeenCalled());
  h.setStreaming(false);
  h.agentEnd();
  release(candidate({fontFamily:'songti'}));
  await expect(steering).rejects.toBeInstanceOf(TaskActionRejected);
  expect(h.translationCalls).toHaveLength(0);
 });

 it.each([
  ['你能把译文改成宋体吗','direct_uncertain'],
  ['不要把译文改成宋体','no_positive_change'],
  ['把字体恢复成网站原来的','unsupported_original_font'],
  ['把译文改成宋体，然后告诉我标题','extra_or_uncertain'],
  ['把译文改成宋体','timeout'],
 ])('falls back to the original model path for %s (%s)',async(text,reason)=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue({kind:'fallback',reason} as never);
  const outcome=await h.wrapper.steerCurrentTask(text,context);
  expect(outcome).toEqual({kind:'model'});
  expect(h.translationCalls).toHaveLength(0);
  expect(h.pageState.fontFamily).toBe('original');
  expect(h.steers[0]).toContain(text);
 });

 it('consumes the decision once before executing so the same candidate cannot run twice',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  const wrapperAny=h.wrapper as any;
  const record={id:'manual',input:null as string|null,text:'把译文改成宋体'};
  const run=()=>wrapperAny.tryDisplaySteering(wrapperAny.session,record,'把译文改成宋体',context,()=>true);
  expect(await run()).toMatchObject({kind:'applied'});
  expect(await run()).toMatchObject({kind:'cancelled'});
  expect(h.translationCalls).toHaveLength(1);
  expect(h.pageState.fontFamily).toBe('songti');
 });

 it('records the write receipt before the readback observation',async()=>{
  const h=pageHarness();
  vi.mocked(decideDisplay).mockResolvedValue(candidate({mode:'translated'}));
  const original=h.rpc.call.getMockImplementation()!;
  let snapshots=0;
  h.rpc.call.mockImplementation(async(name:string,params:any,...rest:any[])=>{
   const result=await original(name,params,...rest);

   if(name==='snapshot'){
    snapshots+=1;

    if(snapshots===3)throw new Error('核对读数失败');
   }

   return result;
  });
  const outcome=await h.wrapper.steerCurrentTask('只显示译文',context);
  expect(outcome).toMatchObject({kind:'display-failed',reason:'核对读数失败'});
  expect(h.emitted.some((event:any)=>event.kind==='tool_end'&&event.name==='page_translation'&&event.isError===false)).toBe(true);
  expect(h.pageState.mode).toBe('translated');
 });

 it('keeps an unknown display result as an unresolved write instead of retrying',async()=>{
  const {h,manager}=await managerHarness();
  const runId=manager.getTaskProgress('default')!.runId??null;
  vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily:'songti'}));
  h.failNextPageTranslation(Object.assign(new Error('回执丢失'),{executionFact:'unknown'}),'unknown');
  h.forceFact('page_translation','unknown');
  const receipt=await manager.dispatchTaskAction({requestId:'unknown-1',conversationId:'default',source:'text',action:'steer',expectedRunId:runId,text:'把译文改成宋体',context});
  expect(receipt.status).toBe('unknown');
  expect(h.translationCalls).toHaveLength(1);
  const progress=manager.getTaskProgress('default')!;
  expect((progress.results??[]).some(item=>item.tool==='page_translation'&&item.status==='unknown')).toBe(true);
  expect(progress.nextStep?.allowWrites).toBe(false);
 });
});

/**
 * Ticket 7：显示修改不得改变未指定属性。
 * 反例来自 out/acceptance/jev-display-steering-1789734088114 pair-0-off：用户只要求宋体，
 * 模型却提交 {mode:'bilingual',fontFamily:'songti'}。两个检查分开：执行层省略字段必须保留原值；
 * 模型面（工具说明＋插话契约）必须要求只提交本次要求改变的字段。
 */
describe('显示修改不得改变未指定属性（Ticket 7）',()=>{
 it('执行层：只带字体时不改模式，只带模式时不改字体，组合请求两项都生效',async()=>{
  const h=pageHarness();
  // 行1：仅译文＋原字体 → 只改宋体 → 仍为仅译文。
  await h.tool('page_translation').execute('row1',{action:'display',fontFamily:'songti',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'translated'});
  // 行2：双语＋宋体 → 再要求切回仅译文 → 字体仍是宋体（本夹具初始模式固定 translated，这里先显式切双语）。
  await h.tool('page_translation').execute('row2a',{action:'display',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'bilingual'});
  await h.tool('page_translation').execute('row2b',{action:'display',mode:'translated',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'translated'});
  // 行4：明确组合请求两项都生效。
  await h.tool('page_translation').execute('row4',{action:'display',fontFamily:'songti',mode:'bilingual',tabId:7,document:'one'});
  expect(h.pageState).toMatchObject({fontFamily:'songti',mode:'bilingual'});
 });
});
