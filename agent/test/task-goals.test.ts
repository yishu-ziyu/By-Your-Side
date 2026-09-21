import { expect, it } from 'vitest';
import { TaskGoalBook, goalRevision } from '../src/task-goals.js';
import { goalsSatisfied } from '../../shared/task-goals.js';
import { TaskProgress } from '../src/task-progress.js';

const request = ['复制第一条评论，粘贴到笔记编辑器，不要保存。'];
const definitions = [
  { id: 'comment', description: '取得第一条评论正文', criterion: '当前第一条评论正文完整', requirements: ['requirement-1'], kind: 'material' as const, materialId: 'comment-text' },
  { id: 'paste', description: '将评论粘贴到笔记编辑器', criterion: '笔记编辑器内容与评论正文一致，未保存', requirements: ['requirement-1'], kind: 'field' as const, materialId: 'comment-text' },
];
function fixture() {
  const book = new TaskGoalBook(); book.require(request);
  const revision = goalRevision(request); book.install(revision, definitions, 1);
  const evidence = { observationId: 'read', tabId: 7, verifiedAt: 10, materialId: 'comment-text' };
  return { book, revision, evidence };
}
it('取得材料不代表已经粘贴，空编辑器核验仍保留未完成目标', () => {
  const { book, revision, evidence } = fixture();
  book.verify(revision, 'comment', { matched: true, reason: '来源正文完整', evidence });
  book.verify(revision, 'paste', { matched: false, reason: '编辑器为空', evidence: { ...evidence, tabId: 9 } });
  expect(goalsSatisfied(book.snapshot()!)).toBe(false);
  expect(book.snapshot()!.goals.map(g => g.status)).toEqual(['satisfied', 'pending']);
});
it('改口令旧版核验失效，不能用重新登记删去本版未完成项', () => {
  const { book, revision, evidence } = fixture();
  expect(() => book.install(revision, definitions.slice(0, 1), 1)).toThrow('固定');
  book.require([...request, '改成第二条评论']);
  expect(() => book.verify(revision, 'paste', { matched: true, reason: '旧核验', evidence })).toThrow('变化');
  expect(book.snapshot()!.coverage).toBe('unplanned');
});
it('跨页保留材料，恢复或后续修改要求重新核对目标页', () => {
  const { book, revision, evidence } = fixture();
  for (const id of ['comment', 'paste']) book.verify(revision, id, { matched: true, reason: '匹配', evidence });
  book.invalidatePage(8); expect(goalsSatisfied(book.snapshot()!)).toBe(true);
  const restored = new TaskGoalBook(); restored.restore(book.snapshot());
  expect(restored.snapshot()!.goals.map(g => g.status)).toEqual(['satisfied', 'pending']);
  book.invalidatePage(7); expect(goalsSatisfied(book.snapshot()!)).toBe(false);
});

// Real payloads from trace 1789972957328-301bc278-8936-41c4-8912-7b11f4a32da8, lines 42 (first plan) and 82 (rejected second plan).
const traceRequest = ['在这篇文章中圈出关键词，并圈出词频最高的词。'];
const tracePlan1Goals = [
  { id: 'article-source', description: '取得文章正文原文，作为词频统计与关键词标注的唯一来源', criterion: '用 capture_page_material 按本次页面观察的片段范围保存完整正文原文（含标题与各小节段落，不含页头/页脚导航）', requirements: ['requirement-1'], kind: 'material' as const, materialId: 'article-body' },
  { id: 'keywords-marked', description: '在页面上圈出文章的关键词', criterion: '页面正文中对每个选定关键词的实际出现位置都有可见标注（mark 圈出/高亮），并有可读的标注文字', requirements: ['requirement-1'], kind: 'condition' as const },
  { id: 'top-word-marked', description: '统计全文词频并圈出词频最高的词', criterion: '基于正文原文统计出词频最高的词及其次数，并在页面正文中圈出该词的实际出现位置，标注其词频', requirements: ['requirement-1'], kind: 'condition' as const },
];
const tracePlan2Goals = [
  { id: 'keywords-marked', description: '在页面上圈出文章关键词', criterion: '页面正文（article）中每类关键词的每一处实际出现都被高亮标注，并在每类首次出现处以 mark 圈出且带可读标签（关键词名 + 出现次数）', requirements: ['requirement-1'], kind: 'condition' as const },
  { id: 'top-word-marked', description: '统计全文词频并圈出词频最高的词', criterion: '基于正文全文（共 1724 个词）统计出词频最高的实义词及其次数（harness 40 次；含 harnesses 共 56 次），并以区别于关键词的样式（红底红框 + mark 圈注）在正文中标注该词的全部出现位置', requirements: ['requirement-1'], kind: 'condition' as const },
];
it('真实 trace 回归：带 reason 的修订移除未引用的内部保存目标，用户可见的条件目标原样保留', () => {
  const book = new TaskGoalBook(); book.require(traceRequest);
  const revision = goalRevision(traceRequest);
  book.install(revision, tracePlan1Goals, 1);
  // The real second plan call (trace:82) carried no reason and was rejected exactly like install() still rejects it directly.
  expect(() => book.install(revision, tracePlan2Goals, 1)).toThrow('固定');
  expect(() => book.amend(revision, tracePlan2Goals, 1, '')).toThrow('理由');
  book.amend(revision, tracePlan2Goals, 1, '内部保存目标反复触发原文预算超限，改为直接在页面圈注并核验，不再要求整篇原文材料。');
  const plan = book.snapshot()!;
  expect(plan.goals.map(g => g.id)).toEqual(['keywords-marked', 'top-word-marked']);
  // The proposal rewrote both criteria; the stored goals keep the ORIGINAL plan1 text untouched.
  expect(plan.goals[0]).toMatchObject({ id: 'keywords-marked', status: 'pending', criterion: tracePlan1Goals[1]!.criterion });
  expect(plan.goals[1]).toMatchObject({ id: 'top-word-marked', status: 'pending', criterion: tracePlan1Goals[2]!.criterion });
  expect(plan.amendments).toEqual([{ at: expect.any(Number), reason: expect.stringContaining('原文预算'), removed: ['article-source'], added: [] }]);
});
it('修订不能删除或改动仍被字段引用的材料，缺 reason 时也拒绝，两者都不改变当前方案', () => {
  const { book, revision } = fixture();
  const before = book.snapshot();
  // 'comment' is still referenced by the pending 'paste' field goal: not eligible for removal.
  expect(() => book.amend(revision, [definitions[1]!], 1, '去掉来源目标')).toThrow('comment');
  expect(() => book.amend(revision, definitions, 1, '   ')).toThrow('理由');
  expect(book.snapshot()).toEqual(before);
});
it('修订不能删除或改动 condition 目标，即使仍 pending', () => {
  const book = new TaskGoalBook(); const soloRequest = ['核对页面条件']; book.require(soloRequest);
  const revision = goalRevision(soloRequest);
  book.install(revision, [{ id: 'body', description: '页面条件满足', criterion: '页面条件满足', kind: 'condition' as const, requirements: ['requirement-1'] }], 1);
  const before = book.snapshot();
  expect(() => book.amend(revision, [], 1, '不再需要这个条件')).toThrow('body');
  expect(book.snapshot()).toEqual(before);
});
it('修订可以新增目标，不影响仍被引用的已有材料', () => {
  const { book, revision } = fixture();
  const extra = [...definitions, { id: 'log', description: '记录一次日志', criterion: '日志已记录', requirements: ['requirement-1'], kind: 'condition' as const }];
  book.amend(revision, extra, 1, '补充一个记录日志的条件目标');
  const plan = book.snapshot()!;
  expect(plan.goals.map(g => g.id)).toEqual(['comment', 'paste', 'log']);
  expect(plan.goals[2]).toMatchObject({ id: 'log', status: 'pending' });
  expect(plan.amendments).toEqual([{ at: expect.any(Number), reason: '补充一个记录日志的条件目标', removed: [], added: ['log'] }]);
});
it('修订记录随检查点持久化并被 restore 接受', () => {
  const { book, revision } = fixture();
  book.amend(revision, [...definitions, { id: 'log', description: '记录一次日志', criterion: '日志已记录', requirements: ['requirement-1'], kind: 'condition' as const }], 1, '补充记录');
  const restored = new TaskGoalBook();
  restored.restore(JSON.parse(JSON.stringify(book.snapshot())));
  expect(restored.snapshot()!.amendments).toEqual(book.snapshot()!.amendments);
});

it('真实失败回归：切标签和点击成功不能清空用户目标', () => {
  const p = new TaskProgress('copy'); p.request(request[0]!);
  p.observe({ type: 'agent_event', event: { kind: 'agent_start' } });
  for (const [id, name, params] of [['switch', 'tabs', { action: 'switch', tabId: 9 }], ['click', 'click', { target: '#editor' }]] as const) {
    p.observe({ type: 'agent_event', event: { kind: 'tool_start', toolCallId: id, name, params } });
    p.observe({ type: 'agent_event', event: { kind: 'tool_end', toolCallId: id, name, resultText: 'ok', isError: false, executionFact: 'executed' } });
  }
  p.observe({ type: 'agent_event', event: { kind: 'agent_end' } });
  expect(p.deliveryFacts().delivered).toEqual([]);
  expect(p.deliveryFacts().remaining.length).toBeGreaterThan(0);
  expect(p.snapshot().nextStep?.delivery).toBe('partial');
});

it('空字段读回是有效观察，但不是复制目标已完成',()=>{
 const p=new TaskProgress('empty');p.request('粘贴评论到编辑器');
 const emit=(event:any)=>p.observe({type:'agent_event',event});
 emit({kind:'agent_start'});
 for(const [id,name,params] of [['click','click',{target:'#editor',tabId:9}],['read','read_element',{target:'#editor',tabId:9}]] as const){
  emit({kind:'tool_start',toolCallId:id,name,params});emit({kind:'tool_end',toolCallId:id,name,isError:false,executionFact:'executed',resultText:'ok'});
 }
 emit({kind:'tool_observation',toolCallId:'read',name:'read_element',target:'#editor',tabId:9,workingTab:true,text:'',truncated:false});
 expect(p.snapshot().nextStep).toMatchObject({reason:'remaining',delivery:'partial'});
 expect(p.snapshot().resultState).toBe('pending');
});

it('已完成历史任务重开不变回待办，中断任务恢复仍须核对当前页',()=>{
 const p=new TaskProgress('history');p.request('取得正文');p.observe({type:'agent_event',event:{kind:'agent_start'}});
 const revision=p.snapshot().goalPlan!.revision;
 p.goals.install(revision,[{id:'done',description:'页面条件满足',criterion:'页面条件满足',kind:'condition',requirements:['requirement-1']}],1);
 p.goals.verify(revision,'done',{matched:true,reason:'已核对',evidence:{observationId:'read',tabId:7,verifiedAt:1}});
 const interrupted=new TaskProgress('history');interrupted.restoreResults(p.snapshot());
 expect(interrupted.snapshot().goalPlan!.goals[0]!.status).toBe('pending');
 p.observe({type:'agent_event',event:{kind:'agent_end'}});
 const history=new TaskProgress('history');history.restoreResults(p.snapshot());
 expect(history.snapshot().goalPlan!.goals[0]!.status).toBe('satisfied');
 expect(history.snapshot().nextStep?.delivery).toBe('report');
});

it('实际目标已核验时，失败的旧方法不再阻塞；未知写入仍优先',()=>{
 const p=new TaskProgress('alternate');p.request('找到指定正文');p.observe({type:'agent_event',event:{kind:'agent_start'}});
 p.registerResults([{id:'old-method',description:'旧方法定位',tool:'click',target:'#missing'}]);
 p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'failed',name:'click',params:{target:'#missing'}}});
 p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'failed',name:'click',isError:true,executionFact:'not_executed',resultText:'not found'}});
 const revision=p.snapshot().goalPlan!.revision;
 p.goals.install(revision,[{id:'body',description:'取得正文',criterion:'正文已读到',kind:'condition',requirements:['requirement-1']}],1);
 p.goals.verify(revision,'body',{matched:true,reason:'另一方法读取成功',evidence:{observationId:'fresh',tabId:7,verifiedAt:2}});
 expect(p.snapshot().nextStep?.delivery).toBe('report');
 expect(p.snapshot().results![0]!.status).toBe('blocked');
});

it('审计完整性不能把成功的通用脚本冒充没有其他变更',()=>{
 const p=new TaskProgress('audit');p.request('核对未保存');p.observe({type:'agent_event',event:{kind:'agent_start'}});
 expect(p.snapshot().executionAuditComplete).toBe(true);
 p.observe({type:'agent_event',event:{kind:'tool_start',toolCallId:'script',name:'js',params:{code:'opaque'}}});
 p.observe({type:'agent_event',event:{kind:'tool_end',toolCallId:'script',name:'js',isError:false,executionFact:'executed',resultText:'ok'}});
 expect(p.snapshot().executionAuditComplete).toBe(false);
 const restored=new TaskProgress('audit');restored.restoreResults(p.snapshot());
 expect(restored.snapshot().executionAuditComplete).toBe(false);
});

it('明确继续旧任务时用完整原要求建立目标，旧回执仍保留',()=>{
 const p=new TaskProgress('legacy');p.request('取得第一条评论并粘贴到笔记');p.observe({type:'agent_event',event:{kind:'agent_start'}});
 const old=p.snapshot();delete old.goalPlan;
 const restored=new TaskProgress('legacy');restored.restoreResults(old);
 expect(restored.snapshot().goalPlan).toBeUndefined();
 restored.prepareResume();
 expect(restored.snapshot().goalPlan).toMatchObject({coverage:'unplanned',goals:[{status:'pending',description:'取得第一条评论并粘贴到笔记'}]});
 expect(restored.snapshot().results).toEqual(old.results);
});
