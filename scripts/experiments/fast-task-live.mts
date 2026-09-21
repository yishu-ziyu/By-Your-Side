/** Bounded real-model selector regression. No browser execution; no network or provider fallback. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { learningFixture } from '../../agent/test/fixtures/skill-evidence.js';
import { autoSkillEligible } from '../../agent/src/skill-learning.js';
import { decideFastTask } from '../../agent/src/fast-task.js';
import type { BrowserObservation } from '../../shared/browser-decision.js';

const out = resolve('out/experiments', `fast-task-live-${Date.now()}`);
await mkdir(out, { recursive: true });
const observation: BrowserObservation = {
  id: 'fixture-observation', tabId: 1, documentId: 'fixture-document', url: 'https://fixture.invalid/desk',
  observedAt: Date.now(), text: 'Reading desk', controls: [], truncated: false, source: 'accessibility',
  tabs: [
    { id: 1, title: 'Reading desk', url: 'https://fixture.invalid/desk', active: true },
    { id: 2, title: 'Rainfall study', url: 'https://fixture.invalid/paper', active: false },
    { id: 3, title: 'Wind study', url: 'https://fixture.invalid/wind', active: false },
  ], tabsTruncated: false,
};
const savedSkill = learningFixture().candidate().skill;
if (!autoSkillEligible(savedSkill)) throw new Error('Live skill fixture must satisfy production automatic replay eligibility');
const cases = [
  { request: '切换到已经打开的 Rainfall study 标签页。', expected: 'switch_tab' },
  { request: '我想看 Rainfall study 那一页，帮我切过去。', expected: 'switch_tab' },
  { request: '已有译文只显示译文，隐藏原文。', expected: 'display' },
  { request: '保留翻译，把英文原文收起来。', expected: 'display' },
  { request: '译文换成宋体。', expected: 'display' },
  { request: '不要切换标签。告诉我 Rainfall study 是否已经打开。', expected: 'miss' },
  { request: '切到 Rainfall study，再总结主要结论。', expected: 'miss' },
  { request: '不对，是另一个。', expected: 'miss' },
  { request: '只把第二段译文改成宋体。', expected: 'miss' },
  { request: '切到 Rainfall study，然后关掉 Wind study。', expected: 'miss' },
  { request: '切到 Rainfall study。', expected: 'miss', duplicate: true },
  { request: '去 Rainfall study 看看，不要改变当前标签。', expected: 'miss' },
  { request: '这不是命令，只是引用：“切到 Rainfall study”。', expected: 'miss' },
  { request: '等我说开始再切到 Rainfall study，现在先别动。', expected: 'miss' },
  { request: '把这页切成双语，然后把结论复制到笔记。', expected: 'miss' },
  { request: '切到名为 Rainfall study 的页面，别动其他标签。', expected: 'switch_tab' },
  { request: '查找客户「李四」，地区是「深圳」', expected: 'skill', skill: true },
  { request: '搜索「李四」，地区「深圳」', expected: 'skill', skill: true },
  { request: '查找客户「李四」，地区是「深圳」，并告诉我会员等级', expected: 'miss', skill: true },
  { request: '查找客户「李四」', expected: 'miss', skill: true },
  { request: '已有译文只显示译文，隐藏原文。', expected: 'display', skill: true },
];
const activeCases = process.argv.includes('--skills-only') ? cases.filter(test => test.skill) : cases;
const realFetch = globalThis.fetch;
let answers: unknown;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const response = await realFetch(...args);
  if (String(args[0]).startsWith('https://api.typesafe.ai/')) answers = await response.clone().json().catch(() => undefined);
  return response;
};
const rows: any[] = [];
try {
  for (const test of activeCases) {
    answers = undefined;
    const page = structuredClone(observation);
    if (test.skill) { page.url = 'https://example.com/search'; page.tabs![0]!.url = page.url; }
    if (test.duplicate) page.tabs!.push({ id: 4, title: 'Rainfall study', url: 'https://fixture.invalid/paper-other', active: false });
    const begin = performance.now();
    const result = await decideFastTask({ request: test.request, observation: page, allowSwitch: true, allowDisplay: true,
      ...(test.skill ? {skills:[{skill:savedSkill,runs:[],selected:false}]} : {}),
      translation: { document: 'translation-fixture', mode: 'bilingual', fontFamily: 'original', translated: 2, displayValid: true } }, new AbortController().signal);
    const actual = result.kind === 'candidate' ? result.candidate.kind : result.kind;
    const passed = actual === test.expected && (result.kind !== 'candidate' || result.candidate.kind !== 'switch_tab' || result.candidate.tab.id === 2)
      && (result.kind !== 'candidate' || result.candidate.kind !== 'display' || (test.request.includes('宋体') ? result.candidate.params.fontFamily === 'songti' : result.candidate.params.mode === 'translated'));
    const skillInputsMatch = result.kind !== 'candidate' || result.candidate.kind !== 'skill' || (result.candidate.skill.inputs['客户名'] === '李四' && result.candidate.skill.inputs['地区'] === '深圳');
    rows.push({ ...test, actual, passed: passed && skillInputsMatch, elapsedMs: performance.now() - begin, result, answers });
    console.log(JSON.stringify({ request: test.request, actual, passed: passed && skillInputsMatch, elapsedMs: rows.at(-1).elapsedMs }));
  }
} finally {
  globalThis.fetch = realFetch;
  const report = { kind: 'development-regression-not-generalization', passed: rows.length === activeCases.length && rows.every(row => row.passed), rows };
  await writeFile(join(out, 'results.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, passed: report.passed, total: rows.length, failures: rows.filter(row => !row.passed).length }));
  if (!report.passed) process.exitCode = 1;
}
