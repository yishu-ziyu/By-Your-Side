import { expect, it } from 'vitest';
import { axTextEvidence } from '../src/background/ax-text-evidence.js';
import { axTreeToText, type AxNodeLite } from '../src/background/axtree.js';

it('原始 AX 文字按节点分段保留长段落，紧凑快照不带全文', () => {
  const body=`原始  空格\t${'长段落'.repeat(90)}`;

  const nodes: AxNodeLite[]=[
    {nodeId:'root',role:{value:'RootWebArea'},childIds:['author','body','break','tail','other']},
    {nodeId:'author',parentId:'root',role:{value:'StaticText'},name:{value:'作者甲 置顶'}},
    {nodeId:'body',parentId:'root',role:{value:'StaticText'},name:{value:body},childIds:['inline']},
    {nodeId:'inline',parentId:'body',role:{value:'InlineTextBox'},name:{value:body}},
    {nodeId:'break',parentId:'root',role:{value:'LineBreak'},name:{value:'\n'}},
    {nodeId:'tail',parentId:'root',role:{value:'StaticText'},name:{value:'评论最后一句。'}},
    {nodeId:'other',parentId:'root',role:{value:'StaticText'},name:{value:'第二条评论'}},
  ];

  const compact=axTreeToText(nodes), fragments=axTextEvidence(nodes);
  expect(compact.text).not.toContain(body);
  expect(fragments.fragments.map(f=>f.id)).toEqual(['ax-author','ax-body','ax-break','ax-tail','ax-other']);
  expect(fragments.fragments.find(f=>f.id==='ax-body')?.text).toBe(body);
});

it('片段预算不足时明确标记，不能把缺口当成完整原文', () => {
  const fragments=axTextEvidence([{nodeId:'large',role:{value:'StaticText'},name:{value:'a'.repeat(65000)}}]);
  expect(fragments.truncated).toBe(true);
});
