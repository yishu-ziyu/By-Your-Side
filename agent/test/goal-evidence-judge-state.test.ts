import { expect, it } from 'vitest';
import { goalReviewState } from '../src/goal-evidence-judge.js';

// Shape mirrors the real runtime bag: page.page nests the page-level snapshot, page.elements
// sits alongside it (see session.ts goalToolHost().read merging read_elements into data.elements).
const base = {
  requirements: [{ id: 'requirement-1', text: '在正文中圈出关键词' }],
  goal: { description: '在正文中圈出关键词', criterion: '每个关键词的实际出现位置都有可见标注' },
  target: 'article',
  executionAuditComplete: true,
  page: {
    value: '', textContent: '',
    page: { url: 'https://article.example', text: '正文', fields: undefined },
    elements: {
      selector: 'span.byys-hl', total: 3, truncated: false,
      elements: [
        { index: 0, tagName: 'SPAN', text: 'harness', visible: true, rect: { x: 1, y: 2, width: 3, height: 4 }, style: { backgroundColor: 'red' } },
        { index: 1, tagName: 'SPAN', text: 'harness', visible: true, rect: { x: 5, y: 6, width: 3, height: 4 }, style: { backgroundColor: 'red' } },
        { index: 2, tagName: 'SPAN', text: '  harnesses  ', visible: false, rect: { x: 9, y: 10, width: 3, height: 4 }, style: { backgroundColor: 'red' } },
      ],
    },
  },
};

it('condition 状态在有 elements 时给出选择器、样本与按归一文本计数的 textCounts', () => {
  const state = goalReviewState('condition', base) as any;
  expect(state.elements).toMatchObject({ selector: 'span.byys-hl', total: 3, truncated: false });
  expect(state.elements.samples).toHaveLength(3);
  expect(state.elements.samples[0]).toMatchObject({ text: 'harness', tagName: 'SPAN', visible: true });
  expect(state.elements.textCounts).toEqual({ harness: 2, harnesses: 1 });
});

it('condition 状态没有 elements 时不携带该字段，行为与此前一致', () => {
  const { elements, ...withoutElements } = base.page;
  const state = goalReviewState('condition', { ...base, page: withoutElements }) as any;
  expect(state.elements).toBeUndefined();
});

it('target 阶段不产出 elements：目标核验仍只看字段本身', () => {
  const state = goalReviewState('target', base) as any;
  expect(state.elements).toBeUndefined();
});

it('模型无法通过顶层 evidence 字段伪造证据，只有宿主给的 page.elements 会进入状态', () => {
  const spoofed = { ...base, evidence: { fabricated: true, matched: true } };
  const state = goalReviewState('condition', spoofed) as any;
  expect(state.evidence).toBeUndefined();
  expect(state.elements).toMatchObject({ selector: 'span.byys-hl', total: 3 });
});

// docs/evals/20260921-1441-log-review.md §3: the delivery review stage judges the exact partial
// text against pending/satisfied goals; it must never see transport ids, timestamps or evidence.
it('delivery 状态只保留 description/criterion/reason 与文本，不含 id/observationId/verifiedAt', () => {
  const input = {
    requirements: ['在这篇文章中圈出关键词，并圈出词频最高的词。'],
    satisfiedGoals: [{ id: 'article-source', description: '取得文章正文原文', criterion: '完整正文原文', status: 'satisfied', kind: 'material', requirements: ['requirement-1'], evidence: { observationId: 'obs-1', tabId: 1, verifiedAt: 999 } }],
    pendingGoals: [{ id: 'keywords-marked', description: '在页面上圈出文章的关键词', criterion: '每个关键词的实际出现位置都有可见标注', status: 'pending', kind: 'condition', requirements: ['requirement-1'], reason: '尚未确认当前页面对象满足这项目标' }],
    executionFacts: [{ tool: 'read_elements', target: 'article', status: 'ok' }],
    text: '页面已圈好。',
  };
  const state = goalReviewState('delivery', input) as any;
  expect(state.requirements).toEqual(input.requirements);
  expect(state.satisfiedGoals).toEqual([{ description: '取得文章正文原文', criterion: '完整正文原文' }]);
  expect(state.pendingGoals).toEqual([{ description: '在页面上圈出文章的关键词', criterion: '每个关键词的实际出现位置都有可见标注', reason: '尚未确认当前页面对象满足这项目标' }]);
  expect(state.executionFacts).toEqual([{ tool: 'read_elements', target: 'article', status: 'ok' }]);
  expect(state.text).toBe('页面已圈好。');
  for (const key of ['id', 'observationId', 'verifiedAt', 'evidence']) {
    expect(state.satisfiedGoals[0]).not.toHaveProperty(key);
    expect(state.pendingGoals[0]).not.toHaveProperty(key);
  }
});
