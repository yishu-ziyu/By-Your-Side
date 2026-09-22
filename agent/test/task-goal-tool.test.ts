import { expect, it, vi } from 'vitest';
import { TaskProgress } from '../src/task-progress.js';
import { createCapturePageMaterialTool, createTaskGoalsTool, type GoalToolHost } from '../src/task-goal-tool.js';
import { TaskEvidence } from '../src/task-evidence.js';

function fixture() {
  const progress = new TaskProgress('copy'); progress.request('复制第一条评论到笔记编辑器。');
  const snapshot = progress.snapshot(), revision = snapshot.goalPlan!.revision, runId = snapshot.runId!;
  const evidence = new TaskEvidence(); evidence.observe({ id: 'source', runId, revision, tabId: 3, text: '第一条评论\n00:00 开始\n01:20 小雨\n第二条评论', truncated: false, at: 1 });
  const completeSimple = vi.fn(async () => ({ stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ matched: true, reason: '证据满足' }) }] }));
  const read = vi.fn(async (): Promise<{ id: string; data: Record<string, unknown> }> => ({ id: 'fresh', data: { value: '', page: { url: 'https://notes.example', text: '笔记编辑器' } } }));
  const reviewCalls: Array<{ stage: string; data: unknown }> = [];
  let current = true;

  const host: GoalToolHost = { snapshot: () => progress.snapshot(), book: () => progress.goals, evidence, review: async(stage,data)=>{reviewCalls.push({stage,data});const r=await completeSimple();

return {...JSON.parse(r.content[0]!.text),probability:1};}, current: () => () => current, persist: vi.fn(), read };

  const tool = createTaskGoalsTool(() => host);
  const captureTool=createCapturePageMaterialTool(()=>host);
  const capture=(params:Parameters<typeof captureTool.execute>[1])=>captureTool.execute("capture",params,new AbortController().signal,undefined,{} as never);
  const call = (params: Parameters<typeof tool.execute>[1]) => tool.execute('call', params, new AbortController().signal, undefined, {} as never);

  return { progress, evidence, completeSimple, read, host, call, capture, reviewCalls, cancel: () => { current = false; } };
}

const goals = [
  { id: 'source-goal', description: '取得第一条评论', criterion: '第一条评论完整正文', kind: 'material' as const, requirements: ['requirement-1'], materialId: 'comment' },
  { id: 'paste-goal', description: '粘贴评论', criterion: '笔记编辑器与评论正文完全一致', kind: 'field' as const, requirements: ['requirement-1'], materialId: 'comment' },
];

it('一句原文加真实来源网址能够核验，额外内容与遗漏网址仍不通过', async () => {
  const f = fixture();
  const snap=f.progress.snapshot();
  const sourceUrl='https://article.example/source';
  f.evidence.observe({id:'note',runId:snap.runId!,revision:snap.goalPlan!.revision,tabId:3,url:sourceUrl,text:'短句。 后续内容。',truncated:false,at:1,fragments:{truncated:false,fragments:[{id:'p',kind:'text',text:'短句。 后续内容。'}]}});
  await f.call({action:'plan',goals:[goals[0]!,{...goals[1]!,appendSourceUrl:true}]});
  const captured=await f.capture({observationId:'note',materialId:'comment',purpose:'第一句',selection:{kind:'fragments',first:'p',last:'p',quote:'短句。'}});
  const value=`短句。\n${sourceUrl}`;
  expect(captured.details).toMatchObject({value:'短句。',fieldValues:[{goalId:'paste-goal',materialId:'comment',value}]});
  expect((await f.call({action:'inspect'})).details).toMatchObject({fieldValues:[{goalId:'paste-goal',value}]});
  f.read.mockResolvedValue({id:'fresh',data:{tagName:'div',editableText:value,textContent:value.replace('\n',''),page:{url:'https://notes.example',text:'笔记编辑器'}}});
  await f.call({action:'verify',goalId:'paste-goal',tabId:8,target:'#editor'});
  expect(f.progress.snapshot().goalPlan!.goals[1]!.status).toBe('satisfied');

  for(const wrong of ['短句。',`${value}\n未经要求的文本`]) {
    f.read.mockResolvedValue({id:'wrong',data:{value:wrong,page:{url:'https://notes.example',text:'笔记编辑器'}}});
    await f.call({action:'verify',goalId:'paste-goal',tabId:8,target:'#editor'});
    expect(f.progress.snapshot().goalPlan!.goals[1]!.status).toBe('pending');
  }
});

it('原文取得后目标仍未完成，空字段与错误字段拒绝，正确字段才完成', async () => {
  const f = fixture(); await f.call({ action: 'plan', goals });
  await f.capture({ observationId: 'source', materialId: 'comment', purpose: '第一条评论正文', selection:{kind:'text',spans: [{ start: 6, end: 23 }]} });
  const material = f.evidence.list(f.progress.snapshot().runId!, f.progress.snapshot().goalPlan!.revision).materials[0]!;
  await f.call({ action: 'verify', goalId: 'source-goal' });
  await f.call({ action: 'verify', goalId: 'paste-goal', tabId: 8, target: '#editor' });
  expect(f.progress.snapshot().resultState).toBe('pending');
  expect(f.progress.snapshot().goalPlan!.goals[1]!.reason).toContain('为空');
  f.read.mockResolvedValue({ id: 'fresh', data: { value: material.value, page: { url: 'https://wrong.example', text: '另一个对象' } } });
  f.completeSimple.mockResolvedValueOnce({ stopReason: 'stop', content: [{ type: 'text', text: '{"matched":false,"reason":"对象不符"}' }] });
  await f.call({ action: 'verify', goalId: 'paste-goal', tabId: 8, target: '#editor' });
  expect(f.progress.snapshot().resultState).toBe('pending');
  f.read.mockResolvedValue({ id: 'fresh', data: { value: material.value, page: { url: 'https://notes.example', text: '笔记编辑器' } } });
  await f.call({ action: 'verify', goalId: 'paste-goal', tabId: 8, target: '#editor' });
  expect(f.progress.snapshot().resultState).toBe('satisfied');
  expect(f.progress.deliveryFacts().remaining).toEqual([]);
});

it('遗漏目标不能通过审核，迟到的计划不能覆盖改口或取消', async () => {
  const f = fixture(); f.completeSimple.mockResolvedValueOnce({ stopReason: 'stop', content: [{ type: 'text', text: '{"matched":false,"reason":"缺少目的地"}' }] });
  await f.call({ action: 'plan', goals: goals.slice(0, 1) });
  expect(f.progress.snapshot().goalPlan!.coverage).toBe('unplanned');
  f.completeSimple.mockImplementationOnce(async () => { f.cancel();

 return { stopReason: 'stop', content: [{ type: 'text', text: '{"matched":true,"reason":"匹配"}' }] }; });
  await expect(f.call({ action: 'plan', goals })).rejects.toThrow('任务已变化');
  expect(f.progress.snapshot().goalPlan!.coverage).toBe('unplanned');
});

it('未取得材料时仍能如实记录目标未完成，不把无材料核验当成已完成',async()=>{
 const f=fixture();await f.call({action:'plan',goals});
 await f.call({action:'verify',goalId:'paste-goal',tabId:8,target:'#editor'});
 expect(f.progress.snapshot().goalPlan!.goals[1]!.status).toBe('pending');
 expect(f.progress.snapshot().goalPlan!.goals[1]!.reason).toContain('缺少');
});

it('改口选第二条时保留旧原文，宿主更新待完成目标的材料引用',async()=>{
 const f=fixture();await f.call({action:'plan',goals});
 await f.capture({observationId:'source',materialId:'comment',purpose:'第一条评论正文',selection:{kind:'text',spans:[{start:6,end:23}]}});
 f.progress.recordRequirement('改成复制第二条评论到同一个编辑器');
 const revision=f.progress.snapshot().goalPlan!.revision,runId=f.progress.snapshot().runId!;
 f.evidence.observe({id:'second-read',runId,revision,tabId:3,text:'第二条评论\n新正文',truncated:false,at:2});
 await f.call({action:'plan',goals:goals.map(goal=>({...goal,description:goal.description.replace('第一条','第二条'),criterion:goal.criterion.replace('第一条','第二条'),requirements:['requirement-1','requirement-2']}))});
 await f.capture({observationId:'second-read',materialId:'comment',purpose:'第二条评论正文',selection:{kind:'text',spans:[{start:6,end:9}]}});
 const plan=f.progress.snapshot().goalPlan!;
 expect(plan.goals[0]!.materialId).not.toBe('comment');
 expect(plan.goals[1]!.materialId).toBe(plan.goals[0]!.materialId);
 expect(plan.goals.map(goal=>goal.status)).toEqual(['satisfied','pending']);
 expect(f.evidence.list(runId,revision).materials.map(material=>material.value)).toEqual(['00:00 开始\n01:20 小雨','新正文']);
});

it('已固定方案的修订缺 reason 时拒绝，不调用 Jev，也不改动当前方案',async()=>{
 const f=fixture();await f.call({action:'plan',goals});
 const before=f.progress.snapshot().goalPlan;
 f.completeSimple.mockClear();
 await expect(f.call({action:'plan',goals})).rejects.toThrow('理由');
 expect(f.completeSimple).not.toHaveBeenCalled();
 expect(f.progress.snapshot().goalPlan).toEqual(before);
});

it('修订试图删除仍被字段引用的材料时先被代码拒绝，不调用 Jev',async()=>{
 const f=fixture();await f.call({action:'plan',goals});
 f.completeSimple.mockClear();
 await expect(f.call({action:'plan',goals:[goals[1]!],reason:'去掉来源目标'})).rejects.toThrow('source-goal');
 expect(f.completeSimple).not.toHaveBeenCalled();
});

const removableGoals = [
  { id: 'scratch-source', description: '临时保存页面日志作为内部依据', criterion: '完整保存当前页面日志', kind: 'material' as const, requirements: ['requirement-1'], materialId: 'scratch-log' },
  { id: 'body-marked', description: '在正文中圈出关键词', criterion: '关键词的实际出现位置都有可见标注', kind: 'condition' as const, requirements: ['requirement-1'] },
];

it('已固定方案带 reason 且核验通过时移除未引用的内部材料，条件目标原样保留',async()=>{
 const f=fixture();await f.call({action:'plan',goals:removableGoals});
 await f.call({action:'plan',goals:[{...removableGoals[1]!,criterion:'改写后的条件描述'}],reason:'内部日志保存反复超限，改为直接核对页面'});
 const plan=f.progress.snapshot().goalPlan!;
 expect(plan.goals.map(g=>g.id)).toEqual(['body-marked']);
 expect(plan.goals[0]!.criterion).toBe('关键词的实际出现位置都有可见标注');
 expect(plan.amendments).toMatchObject([{reason:expect.stringContaining('反复超限'),removed:['scratch-source'],added:[]}]);
});

it('修订未通过 Jev 审核时不应用，原方案保留',async()=>{
 const f=fixture();await f.call({action:'plan',goals:removableGoals});
 f.completeSimple.mockResolvedValueOnce({stopReason:'stop',content:[{type:'text',text:'{"matched":false,"reason":"仍需要原文"}'}]});
 const result=await f.call({action:'plan',goals:[removableGoals[1]!],reason:'尝试移除来源'});
 expect(JSON.parse((result as any).content[0].text).matched).toBe(false);
 expect(f.progress.snapshot().goalPlan!.goals.map(g=>g.id)).toEqual(['scratch-source','body-marked']);
});

it('condition 核验带 elements 时，host.read 收到选择器，证据并入交给 Jev 的状态',async()=>{
 const f=fixture();
 const conditionGoals=[{id:'marked',description:'在正文中圈出关键词',criterion:'每个关键词的实际出现位置都有可见标注',kind:'condition' as const,requirements:['requirement-1']}];
 await f.call({action:'plan',goals:conditionGoals});
 f.read.mockResolvedValueOnce({id:'fresh',data:{value:'',page:{url:'https://article.example',text:'正文'},elements:{selector:'span.byys-hl',total:2,truncated:false,elements:[{index:0,tagName:'SPAN',text:'harness',visible:true,rect:{},style:{}},{index:1,tagName:'SPAN',text:'harness',visible:true,rect:{},style:{}}]}}});
 await f.call({action:'verify',goalId:'marked',tabId:8,target:'article',elements:{selector:'span.byys-hl'}});
 expect(f.read).toHaveBeenLastCalledWith(8,'article',expect.anything(),{selector:'span.byys-hl'});
 const conditionReview=f.reviewCalls.find(c=>c.stage==='condition')!;
 expect((conditionReview.data as any).page.elements).toMatchObject({selector:'span.byys-hl',total:2});
});

it('condition 核验不带 elements 时行为与现在一致，host.read 收到 undefined',async()=>{
 const f=fixture();
 const conditionGoals=[{id:'marked',description:'在正文中圈出关键词',criterion:'每个关键词的实际出现位置都有可见标注',kind:'condition' as const,requirements:['requirement-1']}];
 await f.call({action:'plan',goals:conditionGoals});
 f.read.mockResolvedValueOnce({id:'fresh',data:{value:'',page:{url:'https://article.example',text:'正文'}}});
 await f.call({action:'verify',goalId:'marked',tabId:8,target:'article'});
 expect(f.read).toHaveBeenLastCalledWith(8,'article',expect.anything(),undefined);
 const conditionReview=f.reviewCalls.find(c=>c.stage==='condition')!;
 expect((conditionReview.data as any).page.elements).toBeUndefined();
});
