/**
 * T05 接续入口：摘要投影、恢复按钮能力边界、重复点击与呈现时序，外加
 * 上行重连不会掐断刚建立的连接（A04/A05-02 挂起的根因回归）。
 *
 * 断言口径：按钮只对应真实恢复依据；继续只提交现有 resume 任务动作；
 * 未知/取消/检查点损坏不制造按钮也不复活任务；性能采样只采本轮样本。
 */
import {afterEach, describe, expect, it, vi} from 'vitest';
import {ResumeEntry, buildResumeSummary, resumeAvailability, waitingText} from '../src/sidepanel/resume-entry.js';
import type {TaskView} from '../../shared/task-view.js';
import { projectTaskView } from '../../shared/task-view.js';
import { TaskProgress } from '../../agent/src/task-progress.js';
import { ConversationManager } from '../../agent/src/conversation-manager.js';
import type {TaskActionRequest} from '../../shared/task-actions.js';
import type {ClientMessage, ServerMessage} from '../../shared/protocol.js';
import { Uplink } from '../src/background/uplink.js';

// ── 轻量 DOM 替身：只为组件真实走 createElement/append/replaceChildren ──

interface MockEl {
  tagName: string; id: string; children: MockEl[]; dataset: Record<string, string>;
  className: string; textContent: string; hidden: boolean; disabled: boolean; type: string; title?: string;
  onclick: (() => void) | null;
  append(...nodes: MockEl[]): void;
  replaceChildren(...nodes: MockEl[]): void;
}

function el(tag: string): MockEl {
  return {
    tagName: tag.toUpperCase(), id: '', children: [], dataset: {}, className: '', textContent: '',
    hidden: false, disabled: false, type: '', onclick: null,
    append(...nodes: MockEl[]) { this.children.push(...nodes); },
    replaceChildren(...nodes: MockEl[]) { this.children = nodes; },
  };
}

function installDom(): void {
  vi.stubGlobal('document', {
    createElement: (tag: string) => el(tag),
    getElementById: () => null,
    head: { append: () => {} },
  });
  vi.stubGlobal('performance', { now: () => Date.now() });
}

function find(root: MockEl, className: string): MockEl | undefined {
  return root.children.find((child) => child.className === className);
}

const PAGE = { tabId: 7, title: '登记表', url: 'https://fixture.test/form' };

const viewOf = (over: Partial<TaskView> = {}): TaskView => ({
  conversationId: 'default',
  runId: 'run-1',
  controlVersion: 0,
  observedAt: 1000,
  state: 'interrupted',
  goal: '帮我填登记表：姓名林夏，邮箱linxia@example.com，城市杭州。先不要提交。',
  revisions: [],
  page: { tabId: 7, urlHash: 'a'.repeat(64) },
  active: [],
  lastAction: null,
  waiting: { reason: 'restart_checkpoint', detail: 'host_restart' },
  results: [{ id: 'r1', description: '填写姓名', status: 'satisfied' }],
  outstanding: [{ id: 'r2', description: '填写邮箱', status: 'pending' }],
  latestDelivery: null,
  resumable: true,
  ...over,
});

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('A05-02/A05-03 正向接续摘要与恢复入口', () => {
  it('中断可继续：摘要给出目标/已完成/剩余/原因/下一步，按钮提交一次现有 resume 动作且不含旧工具参数', async () => {
    installDom();
    const sent: TaskActionRequest[] = [];
    const root = el('div');

    const entry = new ResumeEntry({
      root: root as unknown as HTMLElement,
      sendResume: (request) => { sent.push(request);

 return true; },
      getContext: async () => ({ ...PAGE }),
      scheduleFrame: (callback) => callback(),
    });

    entry.apply(viewOf());
    const section = root.children[0]!;
    const text = section.children.map((child) => child.textContent).join('\n');
    // 只一行：还要用户处理什么；目标、已完成清单、下一步说明不再铺在侧栏上。
    expect(find(section, 'resume-line')!.textContent).toBe('任务中断了，还没做：填写邮箱');
    expect(text).not.toContain('已完成');
    expect(find(section, 'resume-line')!.title).toContain('先重新读取当前页面');
    const button = find(section, 'resume-action')!;
    expect(button.textContent).toBe('继续');
    button.onclick!();
    await flush();
    expect(sent).toHaveLength(1);
    const request = sent[0]!;
    expect(request).toMatchObject({ conversationId: 'default', source: 'text', action: 'resume', expectedRunId: 'run-1', expectedControlVersion: 0, text: '继续原任务', context: PAGE });

    // 不直接执行旧工具参数：恢复请求只携带身份/版本/上下文。
    for (const forbidden of ['params', 'target', 'value', 'tool', 'toolCallId']) expect(request).not.toHaveProperty(forbidden);
    expect(new Set(Object.keys(request))).toEqual(new Set(['requestId', 'conversationId', 'source', 'action', 'expectedRunId', 'expectedControlVersion', 'text', 'context']));
    // 读回/启动期间按钮去重：再次点击不产生第二个请求。
    const pendingButton = find(root.children[0]!, 'resume-action')!;
    expect(pendingButton.disabled).toBe(true);
    expect(pendingButton.textContent).toBe('正在继续…');
    pendingButton.onclick!();
    await flush();
    expect(sent).toHaveLength(1);
    // 收到真实 rejected 回执：解除等待，按原样显示缺口，按钮可重试。
    entry.noteReceipt({ requestId: request.requestId, status: 'rejected', message: '当前页面不是原任务保留的页面，请先打开原任务页面再继续；没有在另一页执行。' });
    const refreshed = root.children[0]!;
    const retry = find(refreshed, 'resume-action')!;
    expect(retry.disabled).toBe(false);
    expect(refreshed.children.map((child) => child.textContent).join('\n')).toContain('当前页面不是原任务保留的页面');
    entry.dispose();
  });

  it('idle/error 但只交付了部分结果：视图有真实可恢复依据时按钮仍出现；aborted 不出现', () => {
    const progress = new TaskProgress('default', () => 1000);
    progress.request('填写登记表，先不要提交', PAGE);
    progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } } as ServerMessage);
    progress.observe({ type: 'agent_event', event: { kind: 'tool_start', toolCallId: 'c1', name: 'fill', params: { target: '@1', value: '林夏' } } } as ServerMessage);
    progress.observe({ type: 'agent_event', event: { kind: 'tool_end', toolCallId: 'c1', name: 'fill', isError: false, executionFact: 'executed' } } as ServerMessage);
    progress.registerResults([{ id: 'r2', description: '填写邮箱', tool: 'fill', target: '@2' }] as never);
    progress.observe({ type: 'agent_event', event: { kind: 'agent_end' } } as ServerMessage);
    const idle = projectTaskView(progress.snapshot());
    expect(idle.state).toBe('idle');
    expect(idle.resumable).toBe(true);
    expect(resumeAvailability(idle, false).available).toBe(true);
    progress.abort();
    const aborted = projectTaskView(progress.snapshot());
    expect(aborted.resumable).toBe(false);
    expect(resumeAvailability(aborted, false)).toMatchObject({ available: false });
    expect(resumeAvailability(aborted, false).reason).toContain('不会把它复活');
  });
});

describe('A05-04/A05-05/D10 诚实阻塞与缺口说明', () => {
  it('真实读取失败后结束：空账本不能显示已完成', () => {
    const progress = new TaskProgress('default');
    progress.request('读取页面', PAGE);

    for (const event of [
      { kind: 'agent_start' },
      { kind: 'tool_start', toolCallId: 'failed-read', name: 'snapshot', params: {} },
      { kind: 'tool_end', toolCallId: 'failed-read', name: 'snapshot', isError: true, executionFact: 'not_executed' },
      { kind: 'agent_end' },
    ]) progress.observe({ type: 'agent_event', event } as ServerMessage);
    const summary = buildResumeSummary(projectTaskView(progress.snapshot()));
    expect(summary.headline).toBe('任务已结束 · 仍需处理');
    expect(summary.blocking).toContain('失败');
    expect(summary.nextStep).not.toContain('没有未完成项');
    expect(buildResumeSummary(viewOf({state: 'idle', waiting: null, outstanding: [], resumable: false})).headline).toBe('任务已结束');
  });
  it('未知写入：摘要区分已完成与未知，不出现全任务成功或自动重做承诺', () => {
    const summary = buildResumeSummary(viewOf({
      state: 'idle',
      waiting: { reason: 'unknown_without_baseline', detail: null },
      results: [
        { id: 'r1', description: '填写姓名', status: 'satisfied' },
        { id: 'r2', description: '保存登记表', status: 'unknown' },
      ],
      outstanding: [{ id: 'r2', description: '保存登记表', status: 'unknown' }],
    }));

    expect(summary.done.map((item) => item.id)).toEqual(['r1']);
    expect(summary.remaining[0]).toMatchObject({ id: 'r2', statusLabel: '结果未知' });
    expect(summary.blocking).toContain('未知');
    expect(summary.nextStep).toContain('不会重复提交');
    const text = JSON.stringify(summary);
    expect(text).not.toContain('全部完成');
    expect(text).not.toContain('已成功');
    expect(text).not.toMatch(/\d+%/);
  });

  it('检查点损坏：无按钮，具体说明不会自动重做且未覆盖原记录', () => {
    installDom();
    const root = el('div');
    const entry = new ResumeEntry({ root: root as unknown as HTMLElement, sendResume: () => true, getContext: async () => null, scheduleFrame: (callback) => callback() });
    entry.apply(viewOf(), { checkpointUnavailable: true });
    const section = root.children[0]!;
    expect(section.children.map((child) => child.textContent).join('\n')).toContain('检查点无法恢复');
    expect(find(section, 'resume-action')).toBeUndefined();
    expect(buildResumeSummary(viewOf(), true).gaps.join('；')).toContain('检查点无法恢复');
    entry.dispose();
  });

  it('取消后：不制造继续按钮，下一步明确不会复活', () => {
    installDom();
    const root = el('div');
    const entry = new ResumeEntry({ root: root as unknown as HTMLElement, sendResume: () => true, getContext: async () => null, scheduleFrame: (callback) => callback() });
    entry.apply(viewOf({ state: 'aborted', waiting: { reason: 'cancelled', detail: null }, resumable: false }));
    const section = root.children[0]!;
    expect(find(section, 'resume-action')).toBeUndefined();
    const text = section.children.map((child) => child.textContent).join('\n');
    expect(text).toContain('已停止');
    expect(text).toContain('不会自动继续');
    // 迟到的旧中断视图不得把停止状态改回可继续（agent 侧视图本身以真实状态为准；
    // 这里验证 UI 只按当前视图说话——重新 apply 旧快照才会画旧状态，由协议身份过滤负责）。
    expect(buildResumeSummary(viewOf({ state: 'aborted', resumable: false })).resume.available).toBe(false);
    entry.dispose();
  });

  it('等待原因映射：读回/失败上限/未知各说各的，不合并成含糊状态', () => {
    expect(waitingText('restart_checkpoint', 'connection_lost')).toContain('连接断开');
    expect(waitingText('readback_required', null)).toContain('读回');
    expect(waitingText('failure_limit', null)).toContain('失败');
    expect(waitingText('unknown_with_baseline', null)).toContain('未知');
    expect(waitingText('human_control', null)).toContain('交还');
  });

  it('继续被拒后：同一任务的同一状态里保留真实原因；换任务/真正开跑后清除', async () => {
    installDom();
    const sent: TaskActionRequest[] = [];
    const root = el('div');

    const entry = new ResumeEntry({ root: root as unknown as HTMLElement, sendResume: (request) => { sent.push(request);

 return true; }, getContext: async () => ({ ...PAGE }), scheduleFrame: (callback) => callback() });

    const idlePartial = viewOf({ state: 'idle', waiting: { reason: 'unknown_without_baseline', detail: null }, results: [{ id: 'r1', description: '填写姓名', status: 'satisfied' }, { id: 'r2', description: '保存', status: 'unknown' }], outstanding: [{ id: 'r2', description: '保存', status: 'unknown' }] });
    entry.apply(idlePartial);
    find(root.children[0]!, 'resume-action')!.onclick!();
    await flush();
    entry.noteReceipt({ requestId: sent[0]!.requestId, status: 'rejected', message: '原任务需要的附件尚未恢复，请重新附上原图；检查点保留，没有用其他图片替代。' });
    entry.apply(idlePartial);
    expect(root.children[0]!.children.map((child) => child.textContent).join('\n')).toContain('原任务需要的附件尚未恢复');
    entry.apply(viewOf({ runId: 'run-2', state: 'idle', waiting: null, results: [], outstanding: [] }));
    expect(root.children[0] === undefined || root.hidden || !root.children[0]!.children.map((child) => child.textContent).join('\n').includes('原任务需要的附件尚未恢复')).toBe(true);
    entry.dispose();
  });
});

describe('A05-08 呈现时序与请求去重', () => {
  it('50 次最新恢复快照到可见摘要（下一帧）P95 ≤200ms', () => {
    installDom();
    const root = el('div');

    const entry = new ResumeEntry({
      root: root as unknown as HTMLElement,
      sendResume: () => true,
      getContext: async () => ({ ...PAGE }),
      scheduleFrame: (callback) => callback(),
      now: () => performance.now(),
    });

    for (let i = 0; i < 50; i += 1) entry.apply(viewOf({ observedAt: 1000 + i }));
    const timing = entry.timing();
    expect(timing.count).toBe(50);
    expect(timing.p95).not.toBeNull();
    expect(timing.p95!).toBeLessThanOrEqual(200);
    entry.dispose();
  });

  it('继续受理后再次点击仍不重复；状态进入 running 才解除等待，回到中断可重新请求', async () => {
    installDom();
    const sent: TaskActionRequest[] = [];
    const root = el('div');

    const entry = new ResumeEntry({
      root: root as unknown as HTMLElement,
      sendResume: (request) => { sent.push(request);

 return true; },
      getContext: async () => ({ ...PAGE }),
      scheduleFrame: (callback) => callback(),
    });

    entry.apply(viewOf());
    find(root.children[0]!, 'resume-action')!.onclick!();
    await flush();
    entry.noteReceipt({ requestId: sent[0]!.requestId, status: 'accepted', message: '已从检查点继续原任务' });
    // accepted 之后、running 之前：仍然不允许再点（避免第二次启动）。
    const stillPending = find(root.children[0]!, 'resume-action')!;
    expect(stillPending.disabled).toBe(true);
    stillPending.onclick!();
    await flush();
    expect(sent).toHaveLength(1);
    // 状态真的开始执行：本地等待解除。
    entry.apply(viewOf({ state: 'running', waiting: null, outstanding: [{ id: 'r2', description: '填写邮箱', status: 'pending' }] }));
    // 运行中由顶部任务条讲进度，接续卡收起。
    expect(root.hidden).toBe(true);
    expect(root.children).toHaveLength(0);
    // 之后再次中断：新一次请求是允许的（新 requestId，不重放旧动作）。
    entry.apply(viewOf({ observedAt: 2000 }));
    find(root.children[0]!, 'resume-action')!.onclick!();
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.requestId).not.toBe(sent[0]!.requestId);
    expect(sent[1]!.action).toBe('resume');
    entry.dispose();
  });

  it('拿不到当前页面时不发送，并说明是页面缺口而不是已继续', async () => {
    installDom();
    const sent: TaskActionRequest[] = [];
    const root = el('div');

    const entry = new ResumeEntry({ root: root as unknown as HTMLElement, sendResume: (request) => { sent.push(request);

 return true; }, getContext: async () => null, scheduleFrame: (callback) => callback() });

    entry.apply(viewOf());
    find(root.children[0]!, 'resume-action')!.onclick!();
    await flush();
    expect(sent).toHaveLength(0);
    expect(root.children[0]!.children.map((child) => child.textContent).join('\n')).toContain('看不到当前浏览器页面');
    entry.dispose();
  });

  it('连接不可用：不宣布已发送，原任务记录不变', async () => {
    installDom();
    const root = el('div');
    const entry = new ResumeEntry({ root: root as unknown as HTMLElement, sendResume: () => false, getContext: async () => ({ ...PAGE }), scheduleFrame: (callback) => callback() });
    entry.apply(viewOf());
    find(root.children[0]!, 'resume-action')!.onclick!();
    await flush();
    expect(root.children[0]!.children.map((child) => child.textContent).join('\n')).toContain('连接不可用');
    entry.dispose();
  });
});

describe('A05-02 重连不得掐断刚建立的连接（A04 挂起根因）', () => {
  interface FakePort { name: string; sent: unknown[]; disconnectCalls: number; onMessage: { addListener: () => void }; onDisconnect: { addListener: () => void }; postMessage: (m: unknown) => void; disconnect: () => void; }

  class FakeWebSocket {
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) { FakeWebSocket.instances.push(this); }
    send(data: string): void { this.sent.push(data); }
    open(): void { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
    close(): void { if (this.readyState === FakeWebSocket.CLOSED) return; this.readyState = FakeWebSocket.CLOSED; this.onclose?.(); }
  }

  function nativePort(): FakePort {
    return {
      name: 'com.sideagent.host', sent: [], disconnectCalls: 0,
      onMessage: { addListener: () => {} }, onDisconnect: { addListener: () => {} },
      postMessage(m: unknown) { this.sent.push(m); },
      disconnect() { this.disconnectCalls += 1; },
    };
  }

  it('旧连接留下的重连定时器不会把已建立的新传输拆掉', async () => {
    const ports: FakePort[] = [];
    let nativeAvailable = false;
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('chrome', {
      runtime: { connectNative: () => { if (!nativeAvailable) throw new Error('native host 不可用'); const port = nativePort(); ports.push(port);

 return port; }, lastError: undefined },
      // de381b0 起 Uplink.start 会监听设置变化（改模型时推给扩展内 agent）；这里不测那条路径，只补上入口。
      storage: { local: { get: async () => ({ sideagent_token: 'fixture-token' }) }, onChanged: { addListener: () => {} } },
    });
    const states: string[] = [];
    const uplink = new Uplink({ onServerMessage: () => {}, onConnState: (state) => { states.push(state); } });
    FakeWebSocket.instances = [];
    uplink.start();

    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    const first = FakeWebSocket.instances[0]!;
    first.open();
    first.close(); // 旧连接断开 → 留下 1s 后的重连定时器
    // 新连接从另一条通道先建立（生产里 panel retry / native 通道）
    nativeAvailable = true;
    uplink.start();
    expect(ports).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    // 定时器到点时不得拆掉活连接，也不得再开第二条通道。
    expect(ports[0]!.disconnectCalls).toBe(0);
    expect(ports).toHaveLength(1);
    expect(states).toContain('connecting');
    expect(uplink.sendClientMessage({ type: 'conversation_list' } as ClientMessage)).toBe(true);
  }, 10_000);

  it('显式 retry 仍然重连：先有意拆掉活连接再建立新的', async () => {
    const ports: FakePort[] = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('chrome', {
      runtime: { connectNative: () => { const port = nativePort(); ports.push(port);

 return port; }, lastError: undefined },
      // de381b0 起 Uplink.start 会监听设置变化（改模型时推给扩展内 agent）；这里不测那条路径，只补上入口。
      storage: { local: { get: async () => ({ sideagent_token: 'fixture-token' }) }, onChanged: { addListener: () => {} } },
    });
    const uplink = new Uplink({ onServerMessage: () => {}, onConnState: () => {} });
    uplink.start();

    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(ports).toHaveLength(1);
    uplink.retry();

    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    expect(ports[0]!.disconnectCalls).toBe(1);
    expect(ports).toHaveLength(2);
  });
});

// ── agent 侧连接：重复继续去重与视图补取 ──

describe('A05-08 接续请求去重与视图补取（真实 ConversationManager 边界）', () => {
  const page = { tabId: 7, title: 'Fixture', url: 'https://fixture.test/form' };

  function managerHarness() {
    const progress = new TaskProgress('default', () => 1000);
    progress.request('填写测试表单，先不要提交', page);
    progress.observe({ type: 'agent_event', event: { kind: 'agent_start' } } as ServerMessage);
    progress.observe({ type: 'agent_event', event: { kind: 'tool_start', toolCallId: 'call_1', name: 'fill', params: { target: '@1', value: '林夏' } } } as ServerMessage);
    progress.observe({ type: 'agent_event', event: { kind: 'tool_end', toolCallId: 'call_1', name: 'fill', isError: false, executionFact: 'executed' } } as ServerMessage);
    const before = progress.snapshot();
    const messages: ServerMessage[] = [];
    const resume = vi.fn(async () => {});

    const manager = new ConversationManager(async (_id, _emit) => ({
      session: {
        available: true, modelName: () => 'fixture/model', isStreaming: () => false, isHeld: () => false,
        readPersistedTaskResults: () => before, persistTaskResults: vi.fn(), resumeInterruptedTask: resume, waitForStop: async () => {},
      },
      fleet: { teamView: () => null, isGroupHeld: () => false, reset: vi.fn(), setTabCoordinator: vi.fn(), list: () => [] },
      rpc: { rejectAll: vi.fn() },
      consent: { cancelAll: vi.fn(), bindContext: vi.fn(), list: () => [] },
      dispose: vi.fn(),
      handleMessage: vi.fn(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any), (message) => messages.push(message));

    return { manager, before, resume, messages };
  }

  it('两次继续只启动一次；第二次明确说正在恢复而不是重放', async () => {
    const h = managerHarness();

    try {
      await h.manager.ensureDefault();
      expect(h.manager.getTaskProgress('default')).toMatchObject({ state: 'interrupted', runId: h.before.runId });
      const request = { requestId: 'resume-1', conversationId: 'default', source: 'text' as const, action: 'resume' as const, expectedRunId: h.before.runId ?? null, expectedControlVersion: 0, text: '继续原任务', context: page };
      const first = await h.manager.dispatchTaskAction(request);
      expect(first).toMatchObject({ status: 'accepted', runId: h.before.runId });
      const second = await h.manager.dispatchTaskAction({ ...request, requestId: 'resume-2' });
      expect(second.status).toBe('rejected');
      expect(second.message).toContain('正在从检查点恢复');
      expect(h.resume).toHaveBeenCalledTimes(1);
    } finally { h.manager.dispose(); }
  });

  it('task_view_query 补取当前只读视图；中断态带 resumable=true 和原身份', async () => {
    const h = managerHarness();

    try {
      await h.manager.ensureDefault();
      h.messages.length = 0;
      await h.manager.handleMessage({ type: 'task_view_query', requestId: 'q1', conversationId: 'default' } as never);
      const view = h.messages.filter((message) => message.type === 'task_view').at(-1);
      expect(view).toBeTruthy();
      expect(view!.type === 'task_view' && view!.view).toMatchObject({ conversationId: 'default', runId: h.before.runId, state: 'interrupted', resumable: true });
      // 补取是只读投影：不新增任务动作、不再启动模型。
      expect(h.resume).not.toHaveBeenCalled();
      expect(h.messages.filter((message) => message.type === 'agent_event').every((message) => message.type !== 'agent_event' || message.event.kind !== 'agent_start')).toBe(true);
    } finally { h.manager.dispose(); }
  });
});
