import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserObservation } from '../../shared/browser-decision.js';
import { decideFastTask, type FastTaskDecisionInput } from '../src/fast-task.js';
import { learningFixture } from './fixtures/skill-evidence.js';

const fetchMock = vi.fn();

const observation: BrowserObservation = {
  id: 'observation-one',
  tabId: 7,
  documentId: 'document-one',
  url: 'https://example.com/current',
  observedAt: 1,
  text: 'Current page',
  controls: [],
  truncated: false,
  source: 'accessibility',
  tabs: [
    { id: 7, title: 'Desk', url: 'https://example.com/current', active: true, windowId: 1, working: true },
    { id: 8, title: 'Rainfall study', url: 'https://example.com/paper', active: false, windowId: 1, working: false },
  ],
};

function response(answers: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => ({ answers }) };
}

function baseInput(overrides: Partial<FastTaskDecisionInput> = {}): FastTaskDecisionInput {
  return {
    request: '切换到已经打开的 Rainfall study 标签页。',
    observation,
    translation: null,
    allowSwitch: true,
    allowDisplay: true,
    ...overrides,
  };
}

beforeEach(() => {
  process.env.TYPESAFE_API_KEY = 'test-key';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TYPESAFE_API_KEY;
});

describe('whole-task fast selector', () => {
  it('returns the exact observed tab and preserves raw route diagnostics', async () => {
    fetchMock.mockResolvedValue(response({
      action_requested: { noul: .98 },
      complete: { noul: .96 },
      route: {
        choice: 'tab_1',
        confidence: .97,
        probabilities: { tab_0: .01, tab_1: .97, normal: .02 },
      },
    }));
    const result = await decideFastTask(baseInput(), new AbortController().signal);
    expect(result).toMatchObject({
      kind: 'candidate',
      candidate: { kind: 'switch_tab', tab: { id: 8, title: 'Rainfall study' } },
      diagnostics: { complete: .96, route: { choice: 'tab_1', selectedProbability: .97 } },
    });
  });

  it('does not accept a compound request even when one route is confident', async () => {
    fetchMock.mockResolvedValue(response({
      action_requested: { noul: .99 },
      complete: { noul: .42 },
      route: { choice: 'tab_1', confidence: .97, probabilities: { tab_1: .97, normal: .03 } },
    }));

    const result = await decideFastTask(baseInput({
      request: '切换到 Rainfall study，然后总结页面。',
    }), new AbortController().signal);

    expect(result).toMatchObject({ kind: 'miss', reason: 'coverage_uncertain' });
  });

  it('ignores an unused uncertain font branch for a mode-only display request', async () => {
    fetchMock.mockResolvedValue(response({
      action_requested: { noul: .99 },
      complete: { noul: .95 },
      route: {
        choice: 'display_translated',
        confidence: .96,
        probabilities: { display_translated: .96, display_songti: .02, normal: .02 },
      },
      display_extra: { noul: .02 },
      display_partial: { noul: .01 },
      font_requested: { noul: .04 },
      mode_requested: { noul: .98 },
      font: { choice: 'unspecified', probabilities: { unspecified: .45 } },
      mode: { choice: 'translated', probabilities: { translated: .97 } },
    }));

    const result = await decideFastTask(baseInput({
      request: '只显示译文，隐藏原文。',
      allowSwitch: false,
      translation: {
        document: 'document-one',
        translated: 4,
        displayValid: true,
        mode: 'bilingual',
        fontFamily: 'original',
      },
    }), new AbortController().signal);

    expect(result).toMatchObject({
      kind: 'candidate',
      candidate: { kind: 'display', params: { action: 'display', mode: 'translated' } },
    });
  });

  it('retains semantic saved-skill paraphrase matching in the same judgment', async () => {
    const skill = learningFixture().candidate().skill;
    fetchMock.mockResolvedValue(response({
      action_requested: { noul: .99 },
      complete: { noul: .97 },
      route: { choice: 'skill_0', confidence: .96, probabilities: { skill_0: .96, normal: .04 } },
      skill_input_0_0: { choice: 'value_0', probabilities: { value_0: .99, missing: .01 } },
      skill_input_0_1: { choice: 'value_1', probabilities: { value_1: .99, missing: .01 } },
    }));

    const result = await decideFastTask(baseInput({
      request: '请在客户查询里查找「李四」，地区设为「深圳」',
      allowSwitch: false,
      skills: [{ skill, runs: [], selected: false }],
    }), new AbortController().signal);

    expect(result).toMatchObject({
      kind: 'candidate',
      candidate: {
        kind: 'skill',
        skill: { id: skill.id, version: skill.version, inputs: { 客户名: '李四', 地区: '深圳' } },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let an explicitly selected skill erase an extra requirement', async () => {
    const skill = learningFixture().candidate().skill;
    fetchMock.mockResolvedValue(response({
      action_requested: { noul: .99 },
      complete: { noul: .35 },
      route: { choice: 'skill_0', confidence: .96, probabilities: { skill_0: .96, normal: .04 } },
    }));

    const result = await decideFastTask(baseInput({
      request: '搜索「李四」，地区「深圳」，然后导出结果。',
      allowSwitch: false,
      skills: [{
        skill,
        runs: [],
        selected: true,
        suppliedInputs: { 客户名: '李四', 地区: '深圳' },
      }],
    }), new AbortController().signal);

    expect(result).toMatchObject({ kind: 'miss', reason: 'coverage_uncertain' });
  });
});
