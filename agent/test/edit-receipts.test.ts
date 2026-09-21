/**
 * Ticket T04：可核对的修改回执。
 * 覆盖 A04-01（阶段分层）、A04-04（乱序不覆盖）、A04-05（同文本新请求）、
 * A04-09（契约精确销账／裸原文不放行）、A04-10（差异证据＋原任务保留＋查询）
 * 以及回执差异字段的宿主事实来源与旧数据兼容。
 * 浏览器工具层走真实 createBrowserTools 闸门；Jev 决策脚本化，无模型调用。
 */
import {beforeEach, describe, expect, it, vi} from 'vitest';
vi.mock('../src/display-fast-path.js', () => ({
  displayFastPathEnabled: () => true, displaySteerFastPathEnabled: () => true, decideDisplay: vi.fn(),
}));
vi.mock('../src/run-trace.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/run-trace.js')>();
  return {...actual, RunTrace: class {begin() {} correlate() {} record() {} event() {} stage() {return {end() {}}}}};
});
import {decideDisplay} from '../src/display-fast-path.js';
import {STEER_CONTRACT_NOTE} from '../src/session.js';
import {TaskActionRejected} from '../src/task-dispatcher.js';
import {isTaskReceipt, type TaskReceipt} from '../../shared/task-actions.js';
import {candidate, context, managerHarness, pageHarness} from './fixtures/display-steering-harness.js';

beforeEach(() => vi.mocked(decideDisplay).mockReset());

describe('A04-01 回执阶段分层：accepted 不冒充 applied', () => {
  it('模型路径修改的回执只声明送达，不出现已完成/已应用', async () => {
    const {h, manager} = await managerHarness();
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    vi.mocked(decideDisplay).mockResolvedValue({kind: 'fallback', reason: 'extra_or_uncertain'});
    const receipt = await manager.dispatchTaskAction({requestId: 'stage-delivered', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '把译文改成宋体并总结标题', context});
    expect(receipt.status).toBe('accepted');
    expect(receipt.message).toContain('已送达当前任务');
    expect(receipt.message).not.toContain('已完成');
    expect(receipt.message).not.toContain('已应用');
    expect(receipt.diff).toBeUndefined();
    expect(h.translationCalls).toHaveLength(0);
    manager.dispose();
  });
  it('接管期间保存的修改回执声明交还后生效，仍不声称执行', async () => {
    const {h, manager} = await managerHarness();
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    h.wrapper.holdForUser();
    const receipt = await manager.dispatchTaskAction({requestId: 'stage-queued', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '改成宋体', context});
    expect(receipt.status).toBe('accepted');
    expect(receipt.message).toContain('继续后生效');
    expect(receipt.message).not.toContain('已应用');
    manager.dispose();
  });
  it('直达显示修改的回执才是 applied，且文案明确「已直接应用并核对」', async () => {
    const {h, manager, emitted} = await managerHarness();
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const receipt = await manager.dispatchTaskAction({requestId: 'stage-applied', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '把译文改成宋体', context});
    expect(receipt.status).toBe('applied');
    expect(receipt.message).toContain('已直接应用并核对');
    // 指标：目标明确、范围已授权的普通修改不新增确认轮次。
    expect(emitted.some(message => message.type === 'consent_list' && (message.requests?.length ?? 0) > 0)).toBe(false);
    manager.dispose();
  });
});

describe('A04-02 只改字体：模式保留、内容不重译', () => {
  it('初始仅译文，只要求宋体：字体正确、模式仍为仅译文、没有重新翻译', async () => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const outcome = await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    expect(outcome).toMatchObject({kind: 'display-applied'});
    expect(h.pageState).toMatchObject({fontFamily: 'songti', mode: 'translated'});
    expect(h.translationCalls).toHaveLength(1);
    expect(h.translationCalls[0]).toMatchObject({action: 'display', fontFamily: 'songti'});
    expect(h.translationCalls.some(call => call.action === 'translate')).toBe(false);
  });
  it('初始双语，只要求宋体：双语模式保留', async () => {
    const h = pageHarness();
    h.pageState.mode = 'bilingual';
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    expect(h.pageState).toMatchObject({fontFamily: 'songti', mode: 'bilingual'});
    expect(h.translationCalls.some(call => call.action === 'translate')).toBe(false);
  });
});

describe('A04-03 只切模式：字体保留；明确组合不越改', () => {
  it('初始宋体，只要求切双语：字体仍为宋体', async () => {
    const h = pageHarness();
    h.pageState.fontFamily = 'songti';
    vi.mocked(decideDisplay).mockResolvedValue(candidate({mode: 'bilingual'}));
    const outcome = await h.wrapper.steerCurrentTask('切回双语', context);
    expect(outcome).toMatchObject({kind: 'display-applied'});
    expect(h.pageState).toMatchObject({fontFamily: 'songti', mode: 'bilingual'});
  });
  it('明确同时改两项：两项都执行，差异列出两笔真实变化', async () => {
    const h = pageHarness();
    h.pageState.mode = 'bilingual';
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti', mode: 'translated'}));
    const outcome = await h.wrapper.steerCurrentTask('换成宋体并只显示译文', context);
    expect(outcome).toMatchObject({kind: 'display-applied'});
    expect(h.pageState).toMatchObject({fontFamily: 'songti', mode: 'translated'});
    expect((outcome as {diff?: {changed: unknown[]; preserved: string[]}}).diff?.changed).toHaveLength(2);
    expect((outcome as {diff?: {preserved: string[]}}).diff?.preserved).toEqual([]);
  });
});

describe('A04-04 异步乱序：旧请求不能覆盖新结果', () => {
  it('先挂起的旧修改在新修改应用后恢复，被取消且不产生页面写入', async () => {
    const h = pageHarness();
    let releaseA!: (value: Awaited<ReturnType<typeof decideDisplay>>) => void;
    vi.mocked(decideDisplay).mockImplementationOnce(() => new Promise<Awaited<ReturnType<typeof decideDisplay>>>(resolve => {releaseA = resolve;}));
    const first = h.wrapper.steerCurrentTask('把译文改成宋体', context);
    await vi.waitFor(() => expect(decideDisplay).toHaveBeenCalled());
    vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode: 'bilingual'}));
    const second = await h.wrapper.steerCurrentTask('切回双语', context);
    expect(second).toMatchObject({kind: 'display-applied'});
    releaseA(candidate({fontFamily: 'songti'}));
    await expect(first).rejects.toBeInstanceOf(TaskActionRejected);
    expect(h.translationCalls).toHaveLength(1);
    expect(h.pageState.mode).toBe('bilingual');
    expect(h.pageState.fontFamily).toBe('original');
    expect(h.wrapper.canWriteCurrentInput()).toBe(false);
  });
  it('连续不同属性修改：各自回执的保留项互相证明不丢失', async () => {
    const {h, manager} = await managerHarness();
    const request = (id: string, text: string) => ({requestId: id, conversationId: 'default', source: 'text' as const, action: 'steer' as const, expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text, context});
    vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({mode: 'bilingual'}));
    const first = await manager.dispatchTaskAction(request('o1', '切回双语'));
    h.messageStart(h.steers.at(-1)!);
    vi.mocked(decideDisplay).mockResolvedValueOnce(candidate({fontFamily: 'songti'}));
    const second = await manager.dispatchTaskAction(request('o2', '字体改成宋体'));
    h.messageStart(h.steers.at(-1)!);
    expect(h.pageState).toMatchObject({mode: 'bilingual', fontFamily: 'songti'});
    expect(first.diff).toMatchObject({changed: [{attribute: '显示模式', from: '仅译文', to: '双语'}], preserved: ['字体']});
    expect(second.diff).toMatchObject({changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['显示模式']});
    manager.dispose();
  });
});

describe('A04-05 去重：重放不重做，同文本新请求不误吞', () => {
  it('同文本、不同 requestId 是两条真实请求，各自执行', async () => {
    const {h, manager} = await managerHarness();
    const request = (id: string) => ({requestId: id, conversationId: 'default', source: 'text' as const, action: 'steer' as const, expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    expect((await manager.dispatchTaskAction(request('fresh-1'))).status).toBe('applied');
    h.messageStart(h.steers.at(-1)!);
    expect((await manager.dispatchTaskAction(request('fresh-2'))).status).toBe('applied');
    expect(h.translationCalls).toHaveLength(2);
    manager.dispose();
  });
  it('同 requestId 重放返回原回执（含差异字段），不再次执行', async () => {
    const {h, manager} = await managerHarness();
    const request = {requestId: 'replay-diff', conversationId: 'default', source: 'text' as const, action: 'steer' as const, expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context};
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const first = await manager.dispatchTaskAction(request);
    const replay = await manager.dispatchTaskAction(request);
    expect(replay).toEqual(first);
    expect(h.translationCalls).toHaveLength(1);
    expect(replay.diff?.changed[0]).toMatchObject({attribute: '字体', to: '宋体'});
    manager.dispose();
  });
});

describe('A04-09 契约销账：原样回显精确匹配，裸原文不误放行', () => {
  it('Pi 只回显裸原文时写入闸门不放行；整条载荷回显才销账', async () => {
    const h = pageHarness();
    vi.mocked(decideDisplay).mockResolvedValue({kind: 'fallback', reason: 'extra_or_uncertain'});
    await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    const payload = h.steers[0]!;
    expect(payload).toContain(STEER_CONTRACT_NOTE);
    h.messageStart('把译文改成宋体');
    expect(h.wrapper.canWriteCurrentInput()).toBe(false);
    h.messageStart(payload);
    expect(h.wrapper.canWriteCurrentInput()).toBe(true);
  });
  it('回执与差异字段不携带内部契约文本', async () => {
    const {h, manager} = await managerHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const receipt = await manager.dispatchTaskAction({requestId: 'no-contract', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    expect(JSON.stringify(receipt.diff ?? {})).not.toContain('任务早期的限制');
    expect(JSON.stringify(receipt.diff ?? {})).not.toContain('User\'s current page');
    expect(receipt.message + receipt.text).not.toContain(STEER_CONTRACT_NOTE);
    manager.dispose();
  });
});

describe('T04 差异展示：只来自宿主读回事实', () => {
  it('只改字体时给出字体前后值，模式作为读回核验过的保留项', async () => {
    const {h, manager} = await managerHarness();
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const receipt = await manager.dispatchTaskAction({requestId: 'diff-font', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: manager.getTaskProgress('default')!.runId ?? null, text: '把译文改成宋体', context});
    expect(receipt.diff).toEqual({target: '文章', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['显示模式']});
    expect(h.pageState.mode).toBe('translated');
    manager.dispose();
  });
  it('只切模式时字体作为读回核验过的保留项，不因展示差异而改动', async () => {
    const h = pageHarness();
    h.pageState.fontFamily = 'songti';
    vi.mocked(decideDisplay).mockResolvedValue(candidate({mode: 'bilingual'}));
    const outcome = await h.wrapper.steerCurrentTask('切回双语', context);
    expect(outcome).toMatchObject({kind: 'display-applied', diff: {target: '文章', changed: [{attribute: '显示模式', from: '仅译文', to: '双语'}], preserved: ['字体']}});
  });
  it('要求值读回后与旧值相同不算变化，不制造「宋体 → 宋体」假差异', async () => {
    const h = pageHarness();
    h.pageState.fontFamily = 'songti';
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const outcome = await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    expect(outcome).toMatchObject({kind: 'display-applied'});
    expect((outcome as {diff?: unknown}).diff).toBeUndefined();
  });
  it('未要求改变的属性被改动时不核对为成功，回执 failed 且无差异', async () => {
    const h = pageHarness();
    const original = h.rpc.call.getMockImplementation()!;
    h.rpc.call.mockImplementation(async (name: string, params: any, ...rest: unknown[]) => {
      const result = await original(name, params, ...rest);
      if (name === 'page_translation' && params?.action === 'display' && params.fontFamily && !params.mode) h.pageState.mode = 'bilingual';
      return result;
    });
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const outcome = await h.wrapper.steerCurrentTask('把译文改成宋体', context);
    expect(outcome).toMatchObject({kind: 'display-failed', reason: expect.stringContaining('未要求改变')});
    expect('diff' in outcome && outcome.diff).toBeFalsy();
    expect(h.translationCalls).toHaveLength(1);
  });
});

describe('A04-10 原任务义务与修改成果同任务保留', () => {
  it('修改不取消原任务成果义务；原任务完成后查询仍拿到带差异的 applied 回执', async () => {
    const {h, manager, emitted} = await managerHarness();
    // 模拟宿主持有的原任务检查点（比较／数段落）：目标与成果义务属于这条运行中的任务。
    const originalTask = (manager as any).progress.get('default');
    originalTask.restoreResults({...originalTask.snapshot(), goal: '比较两段并数段落'});
    originalTask.observe({type: 'agent_event', event: {kind: 'agent_start'}});
    expect(manager.getTaskProgress('default')!.state).toBe('running');
    const runId = manager.getTaskProgress('default')!.runId ?? null;
    vi.mocked(decideDisplay).mockResolvedValue(candidate({fontFamily: 'songti'}));
    const receipt = await manager.dispatchTaskAction({requestId: 'duty-1', conversationId: 'default', source: 'text', action: 'steer', expectedRunId: runId, text: '把译文改成宋体', context});
    expect(receipt.status).toBe('applied');
    const during = manager.getTaskProgress('default')!;
    // 原任务目标与 run 身份没有被这条修改顶掉，修改作为补充要求登记。
    expect(during.runId).toBe(runId);
    expect(during.state).toBe('running');
    expect(during.goal).toBe('比较两段并数段落');
    expect(during.recoveryInput?.requirements).toContain('把译文改成宋体');
    expect((during.results ?? []).some(item => item.tool === 'page_translation')).toBe(true);
    // 原任务读到修改事实后继续，并在稍后正常结束；修改不产生新任务。
    h.messageStart(h.steers.at(-1)!);
    h.agentEnd();
    const after = manager.getTaskProgress('default')!;
    expect(after.runId).toBe(runId);
    expect(after.goal).toBe('比较两段并数段落');
    expect(after.state).toBe('idle');
    expect((after.results ?? []).some(item => item.tool === 'page_translation')).toBe(true);
    // 完成后按 requestId 查询：同一条 applied 回执与差异仍可核对。
    await manager.handleMessage({type: 'task_receipt_query', conversationId: 'default', requestId: 'duty-1'} as never);
    const queried = emitted.flatMap(message => message.type === 'agent_event' ? [message.event] : []).map(event => event as {kind?: string; receipt?: TaskReceipt}).filter(event => event.kind === 'notice' && event.receipt?.requestId === 'duty-1').at(-1)?.receipt;
    expect(queried).toMatchObject({status: 'applied', runId, diff: {target: '文章', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['显示模式']}});
    manager.dispose();
  });
});

describe('旧数据兼容与字段校验', () => {
  const legacy: TaskReceipt = {requestId: 'old', conversationId: 'c', source: 'text', action: 'steer', runId: null, text: '改字体', targetTitle: '旧任务', status: 'accepted', message: '修改已送达当前任务', updatedAt: 1};
  it('无差异字段的旧回执仍有效', () => {
    expect(isTaskReceipt(legacy)).toBe(true);
  });
  it.each([
    [{target: '', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: []}],
    [{target: '页', changed: [], preserved: []}],
    [{target: '页', changed: [{attribute: '字体', from: '', to: '宋体'}], preserved: []}],
    [{target: '页', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['x'.repeat(33)]}],
  ])('畸形差异字段被拒绝：%j', diff => {
    expect(isTaskReceipt({...legacy, diff: diff as never})).toBe(false);
  });
  it('合法差异字段通过校验', () => {
    expect(isTaskReceipt({...legacy, status: 'applied', diff: {target: '文章', changed: [{attribute: '字体', from: '原字体', to: '宋体'}], preserved: ['显示模式']}})).toBe(true);
  });
});

describe('差异构造不变量（复核 P2-3）', () => {
  it('changed 只含 params 内的属性，preserved 只含 params 外的属性', async () => {
    const { receiptDisplayDiff } = await import('../src/session.js');
    const before = { fontFamily: 'original', mode: 'translation' } as never;
    const afterBoth = { fontFamily: 'songti', mode: 'bilingual' } as never;
    // params 只要求字体：即使模式也变了，changed 只能列字体；模式不进 preserved（因为它确实变了，不能说「保持不变」）
    const diff = receiptDisplayDiff(before, { fontFamily: 'songti' }, afterBoth, '文章')!;
    expect(diff.changed.map((c) => c.attribute)).toEqual(['字体']);
    expect(diff.preserved).toEqual([]);
    // params 外属性未变才进 preserved
    const diff2 = receiptDisplayDiff(before, { fontFamily: 'songti' }, { fontFamily: 'songti', mode: 'translation' } as never, '文章')!;
    expect(diff2.changed.map((c) => c.attribute)).toEqual(['字体']);
    expect(diff2.preserved).toEqual(['显示模式']);
    // params 内的属性若读回与旧值相同，不造假差异
    expect(receiptDisplayDiff(before, { fontFamily: 'original' }, before, '文章')).toBeUndefined();
  });
});
