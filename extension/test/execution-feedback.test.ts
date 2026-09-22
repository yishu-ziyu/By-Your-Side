/**
 * V2 执行反馈出口（extension 侧）：
 * - 纯状态：同一结果重绘不回弹、两次独立成功各回弹一次、待处理保留更久、旧结果不覆盖新结果；
 * - background 路由：画到用户当前页与动作落点页；重复/迟到丢弃；受限页返回 false 交调用方降级。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type ScriptDetails = { target: { tabId: number }; files?: string[]; func?: unknown; args?: unknown[] };

function installChrome(opts: { activeId?: number | null } = {}) {
  const executeScript = vi.fn(async (_details: ScriptDetails) => [{ frameId: 0, result: undefined }]);
  vi.stubGlobal('chrome', {
    debugger: { onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } },
    scripting: { executeScript },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      query: vi.fn(async () => (opts.activeId == null ? [] : [{ id: opts.activeId }])),
      get: vi.fn(async (tabId: number) => ({ id: tabId, title: 'page' })),
      update: vi.fn(async () => ({})),
    },
    windows: { update: vi.fn(async () => ({})) },
  });

  return { executeScript };
}

function feedbackPaints(executeScript: ReturnType<typeof vi.fn>) {
  return executeScript.mock.calls.filter(([details]) => {
    const view = (details as ScriptDetails).args?.[0];

    return Boolean(view && typeof view === 'object' && 'text' in (view as object));
  });
}

const feedback = {
  id: 'tool:display-1',
  channel: 'capsule' as const,
  kind: 'success' as const,
  text: '切好了',
  bounce: true,
  capsuleCanCloseAction: true,
  facts: { tool: 'tabs', action: 'switch', executionFact: 'executed' as const, tabId: 21 },
  createdAt: 1_000,
};

describe('执行反馈胶囊（background 路由）', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('画到用户当前页与动作落点页，并给出已显示信号', async () => {
    const env = installChrome({ activeId: 5 });
    const { showExecutionFeedback } = await import('../src/background/cursor-status.js');

    await expect(showExecutionFeedback(feedback)).resolves.toBe(true);

    const targets = feedbackPaints(env.executeScript).map(([details]) => (details as ScriptDetails).target.tabId).sort((a, b) => a - b);
    expect(targets).toEqual([5, 21]);
    const view = feedbackPaints(env.executeScript)[0]?.[0].args?.[0];
    expect(view).toMatchObject({ id: 'tool:display-1', text: '切好了', kind: 'success' });
  });

  it('同一结果重复到达不重发；更旧的迟到结果不覆盖新结果', async () => {
    const env = installChrome({ activeId: 5 });
    const { showExecutionFeedback } = await import('../src/background/cursor-status.js');

    await showExecutionFeedback(feedback);
    const afterFirst = feedbackPaints(env.executeScript).length;
    await showExecutionFeedback(feedback);
    expect(feedbackPaints(env.executeScript)).toHaveLength(afterFirst);

    await showExecutionFeedback({ ...feedback, id: 'tool:display-2', createdAt: 2_000 });
    const afterSecond = feedbackPaints(env.executeScript).length;
    await showExecutionFeedback({ ...feedback, id: 'tool:display-old', createdAt: 1_500 });
    expect(feedbackPaints(env.executeScript)).toHaveLength(afterSecond);
  });

  it('受限页画不上时返回 false，交调用方用侧栏文字降级', async () => {
    const env = installChrome({ activeId: 5 });
    env.executeScript.mockRejectedValue(new Error('cannot access contents of the page'));
    const { showExecutionFeedback } = await import('../src/background/cursor-status.js');

    await expect(showExecutionFeedback(feedback)).resolves.toBe(false);
  });

  it('用户当前可见页受限、只有落点页画上时仍返回 false（可见页需要侧栏降级）', async () => {
    const env = installChrome({ activeId: 5 });
    env.executeScript.mockImplementation(async (details: ScriptDetails) => {
      if (details.target.tabId === 5) throw new Error('cannot access contents of the page');

      return [{ frameId: 0, result: undefined }];
    });
    const { showExecutionFeedback } = await import('../src/background/cursor-status.js');

    await expect(showExecutionFeedback(feedback)).resolves.toBe(false);
    // 落点页仍然画上了，只是用户当前看不到
    expect(feedbackPaints(env.executeScript).map(([details]) => (details as ScriptDetails).target.tabId)).toEqual([21]);
  });

  it('新一轮工作开始：收掉可见反馈（含动作落点页）并忘掉已见身份', async () => {
    const env = installChrome({ activeId: 5 });
    const { showExecutionFeedback, retireExecutionFeedback } = await import('../src/background/cursor-status.js');

    await showExecutionFeedback(feedback);
    const before = env.executeScript.mock.calls.length;
    await retireExecutionFeedback();
    const hides = env.executeScript.mock.calls.slice(before).filter(([details]) => (details as ScriptDetails).args?.length === 0);
    expect(hides.map(([details]) => (details as ScriptDetails).target.tabId).sort((a, b) => a - b)).toEqual([5, 21]);
    // 收掉之后再画同一 id 仍可显示（新的一轮不是去重对象）
    const seen = feedbackPaints(env.executeScript).length;
    await showExecutionFeedback(feedback);
    expect(feedbackPaints(env.executeScript).length).toBeGreaterThan(seen);
  });
});
