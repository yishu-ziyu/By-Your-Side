/** Review regressions: scripted responses, production manager/tool gates, no model APIs. */
import {beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('../src/display-fast-path.js', () => ({
  displayFastPathEnabled: () => true, displaySteerFastPathEnabled: () => true, decideDisplay: vi.fn(),
}));
vi.mock('../src/run-trace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/run-trace.js')>();
  return {...actual, RunTrace: class {begin() {} record() {} event() {}}};
});
import {decideDisplay} from '../src/display-fast-path.js';
import {candidate, context, managerHarness, pageHarness} from './fixtures/display-steering-harness.js';

beforeEach(() => vi.mocked(decideDisplay).mockReset());
describe('Jev display review regressions', () => {
  it('R1: rejects a stale edit instead of sending it to the model on the replacement document', async () => {
    const {h, manager} = await managerHarness();
    vi.mocked(decideDisplay).mockImplementation(async () => {
      h.pageState.document = 'replacement'; return candidate({fontFamily: 'songti'});
    });
    const receipt = await manager.dispatchTaskAction({requestId: 'refresh', conversationId: 'default', source: 'text', action: 'steer',
      expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    if (h.steers.length) {
      h.messageStart(h.steers.at(-1)!);
      await h.tool('page_translation').execute('fallback-write', {action: 'display', fontFamily: 'songti', tabId: 7, document: h.pageState.document});
    }
    expect(h.translationCalls).toHaveLength(0);
    expect(h.steers).toHaveLength(0);
    expect(receipt.status).toBe('rejected');
    expect(h.wrapper.canWriteCurrentInput()).toBe(true);
    expect(manager.getTaskProgress('default')!.recoveryInput?.requirements).not.toContain('把译文改成宋体');
    manager.dispose();
  });

  it('R2: keeps old writes fenced when the applied fact cannot be delivered', async () => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    h.raw.steer.mockRejectedValueOnce(new Error('Pi steering unavailable'));
    const outcome = await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    await expect(h.tool('page_translation').execute('old-plan', {action: 'display', fontFamily: 'original', tabId: 7, document: 'one'})).rejects.toThrow();
    expect(h.pageState.fontFamily).toBe('songti');
    expect(h.translationCalls).toHaveLength(1);
    expect(outcome.kind).not.toBe('display-applied');
    expect(h.wrapper.canWriteCurrentInput()).toBe(false);
  });

  it('R3: a readback arriving after cancellation cannot report applied-and-continuing', async () => {
    const {h, manager} = await managerHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const original = h.rpc.call.getMockImplementation()!;
    let count = 0;
    let release: (() => void) | undefined;
    h.rpc.call.mockImplementation(async (name: string, params: any, ...rest: any[]) => {
      const result = await original(name, params, ...rest);
      if (name === 'snapshot' && ++count === 3) await new Promise<void>(resolve => {release = resolve;});
      return result;
    });
    const pending = manager.dispatchTaskAction({requestId: 'late-readback', conversationId: 'default', source: 'text', action: 'steer',
      expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await manager.handleMessage({type: 'abort', conversationId: 'default'} as never);
    h.wrapper.abort(); h.setStreaming(false); h.agentEnd(); release!();
    const receipt = await pending;
    expect(receipt.status).not.toBe('applied');
    expect(receipt.message).not.toContain('原任务继续');
    expect(h.translationCalls).toHaveLength(1);
    expect(h.emitted.some(event => event.kind === 'tool_end' && event.name === 'page_translation' && !event.isError)).toBe(true);
    manager.dispose();
  });

  it('R4: unknown execution is never advertised as verified at task end', async () => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    h.failNextPageTranslation(new Error('回执丢失'), 'unknown'); h.forceFact('page_translation', 'unknown');
    expect(await h.wrapper.steerCurrentTask('把译文改成宋体', context)).toMatchObject({kind: 'display-unknown'});
    h.setStreaming(false); h.agentEnd();
    const notices = h.emitted.filter((event: any) => event.kind === 'notice').map((event: any) => event.message as string);
    expect(notices.some(text => text.includes('显示修改已由运行时直接执行并核对'))).toBe(false);
    expect(notices.some(text => text.includes('结果未知'))).toBe(true);
  });

  it.each(['timeout', 'direct_uncertain'] as const)('R1: a %s fallback also expires on refresh, and a fresh request remains usable', async reason => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockImplementationOnce(async () => {
      h.pageState.document = 'new-document'; return {kind: 'fallback', reason};
    });
    await expect(h.wrapper.steerCurrentTask('把译文改成宋体', context)).rejects.toThrow('页面实例已变化');
    expect(h.steers).toHaveLength(0);
    expect(h.wrapper.canWriteCurrentInput()).toBe(true);
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    expect(await h.wrapper.steerCurrentTask('把当前页面译文改成宋体', context)).toMatchObject({kind: 'display-applied'});
    expect(h.translationCalls).toHaveLength(1);
    expect(h.translationCalls[0]?.document).toBe('new-document');
  });

  it('R2: existing takeover/handback recovers only the lost handoff, not the page write', async () => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    h.raw.steer.mockRejectedValueOnce(new Error('Pi steering unavailable'));
    expect(await h.wrapper.steerCurrentTask('把译文改成宋体', context)).toMatchObject({kind: 'display-handoff-failed'});
    h.wrapper.holdForUser();
    h.raw.prompt.mockImplementation(async (text: string) => {
      h.setStreaming(true); h.messageStart(text); h.agentStart();
    });
    expect(await h.wrapper.continueAfterHandback(context, '当前译文已经是宋体')).toBe(true);
    const prompt = h.raw.prompt.mock.calls[0]?.[0];
    expect(prompt).toContain('已经直接执行并核对');
    expect(prompt).toContain('不需要再由你执行一次');
    expect(h.translationCalls).toHaveLength(1);
    expect(h.wrapper.canWriteCurrentInput()).toBe(true);
    h.wrapper.abort();
  });

  it('R3: cancellation during member handoff cannot announce that the original task continues', async () => {
    const {h, manager, entry} = await managerHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    let release: (() => void) | undefined;
    vi.mocked(entry.runtime.fleet.reviseSharedRequirement).mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {release = resolve;});
      return {notified: [], queued: [], skipped: [], failed: []};
    });
    const pending = manager.dispatchTaskAction({requestId: 'late-members', conversationId: 'default', source: 'text', action: 'steer',
      expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await manager.handleMessage({type: 'abort', conversationId: 'default'} as never);
    h.wrapper.abort(); h.setStreaming(false); h.agentEnd(); release!();
    const receipt = await pending;
    expect(receipt.status).not.toBe('applied');
    expect(receipt.message).not.toContain('原任务继续');
    expect(h.translationCalls).toHaveLength(1);
    manager.dispose();
  });

  it.each(['ended', 'stopped'] as const)('R4: %s preserves verified and unexecuted facts separately', async reason => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({fontFamily: 'songti'}));
    await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    vi.mocked(decideDisplay).mockResolvedValueOnce({kind: 'fallback', reason: 'extra_or_uncertain'});
    await h.wrapper.steerCurrentTask('稍后告诉我文章标题', context);
    if (reason === 'ended') {h.setStreaming(false); h.agentEnd();} else h.wrapper.abort();
    const notices = h.emitted.filter((event: any) => event.kind === 'notice').map((event: any) => event.message as string).join('\n');
    expect(notices).toContain('显示修改已核验');
    expect(notices).toContain('其他补充尚未执行：稍后告诉我文章标题');
    expect(notices).not.toContain('尚未被模型读到的补充没有执行：把译文改成宋体');
  });
});
