// docs/evals/20260925-sitegeist-parity.md: the calculator run answered "换算器已经就位" while page JS
// was blocked and browser_run ran zero steps. The answer is still delivered (never withheld); when
// the host saw page-change attempts this run and none took effect, a model claim of "complete" is
// recorded as partial and the host appends that fact.
import { describe, expect, it } from 'vitest';
import { deliverUserMessage, type SendUserMessageOptions } from '../src/user-delivery.js';

const CLAIM = '已在这页做好了换算器，你可以直接在上面试用。';

function options(pageChanges: { attempts: number; changes: number } | null): SendUserMessageOptions {
  return { conversationId: 'default', getRunId: () => 'run-1', emit: () => {}, getPageChanges: () => pageChanges };
}

function deliver(pageChanges: { attempts: number; changes: number } | null, outcome: 'complete' | 'partial' = 'complete') {
  return deliverUserMessage(options(pageChanges), { id: 'd-1', kind: 'finding', content: CLAIM, outcome });
}

describe('页面没变却说做完了', () => {
  it('试过改页面、一次都没生效：照常交付，记为部分完成，并补上页面没有变化', () => {
    const result = deliver({ attempts: 2, changes: 0 });

    expect(result.outcome).toBe('partial');
    expect(result.delivery.text).toBe(`${CLAIM}\n\n页面没有变化：本轮 2 次改动页面的尝试都没有生效。`);
  });

  it('至少一次生效：不补这句，仍按完成交付', () => {
    const result = deliver({ attempts: 2, changes: 1 });

    expect(result.outcome).toBe('complete');
    expect(result.delivery.text).toBe(CLAIM);
  });

  it('没尝试改页面（纯问答）：不补这句', () => {
    const result = deliver({ attempts: 0, changes: 0 });

    expect(result.outcome).toBe('complete');
    expect(result.delivery.text).toBe(CLAIM);
  });

  it('模型自己已说没做完：正文不动，由侧栏的未完成行说明', () => {
    const result = deliver({ attempts: 3, changes: 0 }, 'partial');

    expect(result.outcome).toBe('partial');
    expect(result.delivery.text).toBe(CLAIM);
  });
});
