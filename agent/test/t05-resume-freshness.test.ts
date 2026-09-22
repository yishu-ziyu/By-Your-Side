import {describe, expect, it} from 'vitest';
import {pairedAcceptedReceipt, roundFinding, type RoundReceipt} from '../../scripts/acceptance/round-evidence.mjs';

const clickAtMs = 1_000;

const runId = 'run-current';

const delivery = (composedAt: number, extra: Record<string, unknown> = {}) => ({kind: 'finding', runId, composedAt, text: `answer@${composedAt}`, ...extra});

describe('T05 接续轮次证据窗口', () => {
  it('同 run 在点击前组合的旧 finding 不算本轮交付', () => {
    expect(roundFinding([delivery(clickAtMs - 1)], runId, clickAtMs)).toBeUndefined();
  });

  it('本轮组合的 finding 才被采用，且取窗口内最新一条', () => {
    const fresh = delivery(clickAtMs + 20);
    const newer = delivery(clickAtMs + 40);
    expect(roundFinding([delivery(clickAtMs - 5), fresh, newer], runId, clickAtMs)).toBe(newer);
  });

  it('其他 run 的 finding 与缺少组合时间的 finding 都不算本轮交付', () => {
    expect(roundFinding([delivery(clickAtMs + 5, {runId: 'run-old'})], runId, clickAtMs)).toBeUndefined();
    expect(roundFinding([delivery(clickAtMs + 5, {composedAt: undefined})], runId, clickAtMs)).toBeUndefined();
  });

  it('缺少任务身份或无效轮次时间不能采信交付', () => {
    expect(roundFinding([delivery(clickAtMs, {runId: undefined})], undefined, clickAtMs)).toBeUndefined();
    expect(roundFinding([delivery(clickAtMs)], runId, Number.NaN)).toBeUndefined();
  });

  it('点击前回放的 resume 回执（requestId 属于上一请求）不能充当本轮接收', () => {
    const replayed: RoundReceipt = {requestId: 'resume-old', status: 'accepted'};
    expect(pairedAcceptedReceipt([replayed], ['resume-clicked'])).toBeUndefined();
  });

  it('只有 requestId 与点击请求配对且 accepted/applied 的回执才算接收', () => {
    const receipts: RoundReceipt[] = [
      {requestId: 'resume-clicked', status: 'queued'},
      {requestId: 'resume-old', status: 'accepted'},
      {requestId: 'resume-clicked', status: 'accepted'},
    ];

    expect(pairedAcceptedReceipt(receipts, ['resume-clicked'])).toMatchObject({requestId: 'resume-clicked', status: 'accepted'});
    expect(pairedAcceptedReceipt([{requestId: 'resume-clicked', status: 'rejected'}], new Set(['resume-clicked']))).toBeUndefined();
  });
});
