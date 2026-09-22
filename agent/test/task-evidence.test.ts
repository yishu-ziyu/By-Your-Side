import { expect, it } from 'vitest';
import { TaskEvidence } from '../src/task-evidence.js';

const source = { id: 'snapshot-1', runId: 'run-1', revision: 'revision-1', tabId: 3, url: 'https://video.example/watch', text: '第一条评论\n00:00 开始\n01:20 小雨\n第二条评论\n别的内容', truncated: false, at: 10 };

it('同一原始片段内只捕获指定句子，恢复后保留精确范围', () => {
  const store = new TaskEvidence();
  const first = 'Jev currently accepts text input only.';
  const raw = `${first} It evaluates strings and JSON. Images are not supported.`;
  const observation = {...source, fragments: {truncated:false, fragments:[{id:'note',kind:'text' as const,text:raw}]}};
  const material = store.prepareFragments('sentence', '第一句', observation, 'note', 'note', first);
  expect(material.value).toBe(first);
  expect(material.selection).toEqual({kind:'fragments',ids:['note'],range:{start:0,end:first.length}});
  store.restore(JSON.parse(JSON.stringify(material)));
  expect(store.list(source.runId,source.revision).materials[0]).toEqual(material);
  expect(() => store.restore({...material,sourceText:material.sourceText!.replace('Images','Pictures')})).toThrow('已绑定');
  expect(() => store.restore({...material,id:'invalid',selection:{...material.selection,range:{start:0,end:1}}})).toThrow('范围');
});

it('精确选句拒绝改写和有歧义的重复文本，不扩大范围或猜位置', () => {
  const store = new TaskEvidence();
  const observation = {...source,fragments:{truncated:false,fragments:[{id:'note',kind:'text' as const,text:'Same sentence. Another sentence. Same sentence.'}]}};
  expect(() => store.prepareFragments('m','句子',observation,'note','note','Invented sentence.')).toThrow('原文');
  expect(() => store.prepareFragments('m','句子',observation,'note','note','Same sentence.')).toThrow('多处');
  expect(store.prepareFragments('m','句子',observation,'note','note','Another sentence.').value).toBe('Another sentence.');
});

it('跨页取用原文，持久化恢复不需要旧节点引用', () => {
  const evidence = new TaskEvidence(); evidence.observe(source);
  const start = source.text.indexOf('00:00'), end = source.text.indexOf('\n第二条');
  const material = evidence.prepare('first-comment', '第一条评论正文', evidence.read(source.id, source.runId), [{ start, end }]);
  evidence.save(material);
  evidence.observe({ ...source, id: 'snapshot-2', tabId: 8, text: '空编辑器' });
  expect(evidence.list(source.runId, source.revision).materials[0]?.value).toBe('00:00 开始\n01:20 小雨');
  const restored = new TaskEvidence(); restored.restore(JSON.parse(JSON.stringify(material)));
  expect(restored.list(source.runId, source.revision).materials).toEqual([material]);
  expect(restored.list(source.runId, 'new-revision').materials).toEqual([material]);
  expect(restored.list('another-run','new-revision').materials).toEqual([]);
});

it('拒绝跨任务来源、截断、重叠与替换同名材料', () => {
  const evidence = new TaskEvidence(); evidence.observe(source);
  expect(() => evidence.read(source.id, 'other-run')).toThrow('当前任务');
  expect(() => evidence.prepare('comment', '正文', { ...source, truncated: true }, [{ start: 0, end: 3 }])).toThrow('截断');
  expect(() => evidence.prepare('comment', '正文', source, [{ start: 0, end: 6 }, { start: 5, end: 10 }])).toThrow('重叠');
  const material = evidence.prepare('comment', '正文', source, [{ start: 0, end: 6 }]); evidence.save(material);
  expect(() => evidence.save({ ...material, value: '伪造' })).toThrow('已绑定');
  expect(() => evidence.restore({ ...material, source: 'generated' })).toThrow('检查点');
});

it('同一份原文重核验可幂等恢复，不能用相同标识替换来源',()=>{
 const store=new TaskEvidence();
 const material=store.prepare('comment','第一条评论',source,[{start:6,end:23}]);
 const verified={...material,verification:{goalId:'source',revision:source.revision,description:'第一条评论',criterion:'第一条评论完整正文',probability:.9,at:10}};
 store.restore(verified);
 store.restore({...verified,purpose:'复用同一正文',verification:{...verified.verification,probability:.95,at:20}});
 expect(store.list(source.runId,source.revision).materials).toHaveLength(1);
 expect(()=>store.restore({...verified,observation:{...verified.observation,id:'different-read'}})).toThrow('已绑定');
});

it('凭据不会进入模型可读材料，普通段落的原始空白保留',()=>{
 const store=new TaskEvidence();store.observe({...source,text:'api_key: Abcd1234EFGH5678\n正文\n\n\n保留空白',fragments:{truncated:false,fragments:[{id:'key',kind:'text',text:'api_key: Abcd1234EFGH5678'},{id:'body',kind:'text',text:'正文\n\n\n保留空白'}]}});
 const read=store.read(source.id,source.runId);
 expect(JSON.stringify(read)).not.toContain('Abcd1234EFGH5678');
 expect(()=>store.prepareFragments('key','凭据',read,'key','key')).toThrow('凭据');
 expect(store.prepareFragments('body','正文',read,'body','body').value).toBe('正文\n\n\n保留空白');
});

it('单份原文超过 8000 字符时报错含实际字符数、上限与可行做法；空选区是另一条错误', () => {
  const evidence = new TaskEvidence();
  const long = { ...source, id: 'long-source', text: 'a'.repeat(9830) };
  let overLimit = '';

  try { evidence.prepare('long', '整篇正文', long, [{ start: 0, end: 9830 }]); }
  catch (error) { overLimit = (error as Error).message; }

  expect(overLimit).toContain('9830');
  expect(overLimit).toContain('8000');
  expect(overLimit).toContain('task_goals');
  const blank = { ...source, id: 'blank-source', text: '正文   结束' };
  expect(() => evidence.prepare('blank', '空白', blank, [{ start: 2, end: 5 }])).toThrow('为空');
  expect(overLimit).not.toContain('为空');
});

it('restore 仍拒绝超过 8000 字符的材料', () => {
  const evidence = new TaskEvidence();
  const oversized = { id: 'm', purpose: '正文', value: 'a'.repeat(8001), source: 'observed', observation: { id: 'o', runId: 'r', revision: 'rv', tabId: 1, truncated: false, at: 1 }, selection: { kind: 'text', spans: [{ start: 0, end: 8001 }] } };
  expect(() => evidence.restore(oversized)).toThrow('检查点');
});
