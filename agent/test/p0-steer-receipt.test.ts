import {describe, expect, it} from 'vitest';
import {pairedAcceptedReceipt, roundFinding, type RoundReceipt} from '../../scripts/acceptance/round-evidence.mjs';

const steerAtMs = 2_000;

const runId = 'run-before';

describe('P0 receipt-loss 插话轮次证据窗口', () => {
  it('被拒绝的 steer 回执即使 requestId 配对也不算送达', () => {
    expect(pairedAcceptedReceipt([{requestId: 'steer-1', status: 'rejected'}], ['steer-1'])).toBeUndefined();
  });

  it('仅 action/会话相同、requestId 不配对的回执不算送达', () => {
    const receipts: RoundReceipt[] = [
      {requestId: 'start-1', status: 'accepted'},
      {requestId: 'steer-other', status: 'applied'},
    ];

    expect(pairedAcceptedReceipt(receipts, ['steer-1'])).toBeUndefined();
  });

  it('requestId 配对的 accepted/applied 回执才算送达', () => {
    expect(pairedAcceptedReceipt([{requestId: 'steer-1', status: 'accepted'}], ['steer-1'])).toMatchObject({status: 'accepted'});
    expect(pairedAcceptedReceipt([{requestId: 'steer-1', status: 'applied'}], ['steer-1'])).toMatchObject({status: 'applied'});
  });

  it('没有可配对的请求编号时不能判定送达', () => {
    expect(pairedAcceptedReceipt([{requestId: 'steer-1', status: 'accepted'}], [])).toBeUndefined();
  });

  it('插话前组合的旧 finding 不算插话轮次交付，插话后组合的才算', () => {
    const old = {kind: 'finding', runId, composedAt: steerAtMs - 30, text: '旧回答'};
    const fresh = {kind: 'finding', runId, composedAt: steerAtMs + 30, text: '查过服务端后的回答'};
    expect(roundFinding([old], runId, steerAtMs)).toBeUndefined();
    expect(roundFinding([old, fresh], runId, steerAtMs)).toBe(fresh);
  });
});
