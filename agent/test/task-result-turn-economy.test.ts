/**
 * 记账下沉（P0-1）：账本项由真实执行事实产生，观察与操作不再先花一轮登记。
 * 标准与依据见 docs/evals/20260911-turn-economy-ledger.md。
 *
 * 反事实来源：2026-09-10 「浏览器环境状态」真实自主任务的隔离 harness 运行
 * /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-harness-s2-6xRcXX/task-events.json
 * （对应 docs/evals/20260910-browser-environment-state.md 的样本记录）
 * 原始序列为 4 次 record_task_results + 1 次 click：记账占了 4 个模型回合。
 * 下面的 fixture 原样抄录其余调用，去掉记账调用，用来验证新规则下同样顺序全部放行。
 */
import {describe, expect, it} from 'vitest';
import {TaskProgress} from '../src/task-progress.js';
import {deriveResultDescription} from '../../shared/task-results.js';

function setup(goal = '测试任务'): TaskProgress {
  const p = new TaskProgress('default');
  p.request(goal);
  p.observe({type: 'agent_event', event: {kind: 'agent_start'}} as any);
  return p;
}

function start(p: TaskProgress, toolCallId: string, name: string, params: Record<string, unknown> = {}): void {
  p.observe({type: 'agent_event', event: {kind: 'tool_start', toolCallId, name, params}} as any);
}

function end(p: TaskProgress, toolCallId: string, name: string, opts: {failed?: boolean; executionFact?: string} = {}): void {
  p.observe({type: 'agent_event', event: {
    kind: 'tool_end', toolCallId, name, isError: opts.failed ?? false, resultText: 'receipt', executionFact: opts.executionFact,
  }} as any);
}

async function executionGate(p: TaskProgress): Promise<(name: string, params?: Record<string, unknown>) => void> {
  const {BrowserAgentSession} = await import('../src/session.js');
  const session: any = new (BrowserAgentSession as any)(null, null, {emit: () => {}, setStatus: () => {}}, null, null);
  session.bindConversationContext(() => p.snapshot());
  return (name, params = {}) => session.assertTaskResultExecution(name, params);
}

const itemsOf = (p: TaskProgress) => p.snapshot().results ?? [];

describe('记账下沉：执行事实驱动账本', () => {
  it('观察和写操作都不再需要预先登记', async () => {
    const p = setup();
    const gate = await executionGate(p);
    expect(() => gate('snapshot', {})).not.toThrow();
    expect(() => gate('read_element', {target: '#a'})).not.toThrow();
    expect(() => gate('click', {target: '#follow'})).not.toThrow();
    expect(itemsOf(p)).toHaveLength(0);
  });

  it('0 次登记下写操作自动成项，并只按真实回执判定完成', async () => {
    const p = setup('点击关注');
    const gate = await executionGate(p);
    expect(() => gate('click', {target: '#follow'})).not.toThrow();
    start(p, 'call-1', 'click', {target: '#follow', label: '关注'});
    expect(itemsOf(p)).toHaveLength(1);
    expect(itemsOf(p)[0]).toMatchObject({tool: 'click', target: '#follow', status: 'pending'});
    expect(itemsOf(p)[0]!.description).toContain('关注');
    expect(itemsOf(p)[0]!.description.length).toBeGreaterThan(1);
    end(p, 'call-1', 'click');
    expect(itemsOf(p)[0]).toMatchObject({status: 'satisfied'});
    expect(p.snapshot().resultState).toBe('satisfied');
  });

  it('预登记 target:null 的写项在执行时自动改绑实际目标，id 与说明保持', async () => {
    const p = setup();
    p.registerResults([{id: 'follow', description: '关注 UP 主', tool: 'click', target: null}]);
    start(p, 'call-1', 'click', {target: '#follow', label: '关注'});
    expect(itemsOf(p)).toHaveLength(1);
    expect(itemsOf(p)[0]).toMatchObject({id: 'follow', description: '关注 UP 主', target: '#follow', status: 'pending'});
    end(p, 'call-1', 'click');
    expect(p.snapshot().resultState).toBe('satisfied');
  });

  it('同工具两个无证据待办：不误绑，另建自动项', async () => {
    const p = setup();
    p.registerResults([
      {id: 'first', description: '处理 X', tool: 'click', target: '#x'},
      {id: 'second', description: '处理 Y', tool: 'click', target: '#y'},
    ]);
    start(p, 'call-1', 'click', {target: '#z', label: '处理 Z'});
    end(p, 'call-1', 'click');
    const items = itemsOf(p);
    expect(items).toHaveLength(3);
    expect(items.find(i => i.id === 'first')).toMatchObject({target: '#x', status: 'pending'});
    expect(items.find(i => i.id === 'second')).toMatchObject({target: '#y', status: 'pending'});
    expect(items.find(i => i.tool === 'click' && i.target === '#z')).toMatchObject({status: 'satisfied'});
    expect(p.snapshot().resultState).toBe('pending');
  });

  it('自动项在模型随后登记同工具同目标时被吸收，不出现两条同名待办', async () => {
    const p = setup();
    start(p, 'call-1', 'click', {target: '#follow', label: '关注'});
    end(p, 'call-1', 'click');
    p.registerResults([{id: 'follow', description: '关注 UP 主', tool: 'click', target: '#follow'}]);
    expect(itemsOf(p)).toHaveLength(1);
    expect(itemsOf(p)[0]).toMatchObject({id: 'follow', description: '关注 UP 主', status: 'satisfied'});
  });

  it('同一 (tool,target) 已完成的写不重复执行，其它目标不受影响', async () => {
    const p = setup();
    const gate = await executionGate(p);
    start(p, 'call-1', 'click', {target: '#follow'});
    end(p, 'call-1', 'click');
    expect(() => gate('click', {target: '#follow'})).toThrow(/已有成功回执/);
    expect(() => gate('click', {target: '#other'})).not.toThrow();
  });

  it('未决写入仍暂停同 run 的后续写入', async () => {
    const p = setup();
    const gate = await executionGate(p);
    start(p, 'call-1', 'click', {target: '#a'});
    end(p, 'call-1', 'click', {failed: true, executionFact: 'unknown'});
    expect(p.snapshot().resultState).toBe('unknown');
    expect(() => gate('fill', {target: '#b'})).toThrow(/尚未确认结果/);
    expect(() => gate('click', {target: '#a'})).toThrow(/执行结果未知/);
  });

  it('被拦下的点击仍按未执行上报，不当作完成', async () => {
    const p = setup();
    const gate = await executionGate(p);
    start(p, 'call-1', 'click', {target: '#delete'});
    end(p, 'call-1', 'click', {executionFact: 'not_executed'});
    expect(itemsOf(p)[0]).toMatchObject({status: 'unknown'});
    expect(p.snapshot().resultState).toBe('unknown');
    expect(() => gate('click', {target: '#delete'})).toThrow(/执行结果未知/);
  });

  it('协调/探针类工具不产生用户可见待办', () => {
    const p = setup();
    start(p, 'call-1', 'js', {});
    end(p, 'call-1', 'js');
    start(p, 'call-2', 'worker_tabs', {action: 'claim', tabId: 7});
    end(p, 'call-2', 'worker_tabs');
    start(p, 'call-3', 'scroll', {dy: 400});
    end(p, 'call-3', 'scroll');
    expect(itemsOf(p)).toHaveLength(0);
  });
});

describe('真实调用序列重放（A 候选：4 次记账只服务 1 次 click）', () => {
  const traceCalls = [
    {name: 'snapshot', params: {}},
    {name: 'click', params: {target: '@18', label: '暂停视频'}},
    {name: 'read_element', params: {target: '@3'}},
    {name: 'js', params: {}},
    {name: 'send_user_message', params: {}},
  ];

  /** 旧规则 1（观察也要先登记）的反事实实现，逐字对应改前的 session.ts。 */
  const legacyRegistrationRejections = (items: unknown[], name: string): number =>
    items.length === 0 && !['get_active_tab', 'list_tabs', 'worker_tabs', 'switch_tab', 'resolve_unknown_result'].includes(name) ? 1 : 0;

  it('去掉记账调用后：旧规则先拒掉观察与点击，新规则全部放行且账本自建', async () => {
    const p = setup('暂停视频');
    const gate = await executionGate(p);
    let legacyRejections = 0;
    for (const [index, call] of traceCalls.entries()) {
      legacyRejections += legacyRegistrationRejections(itemsOf(p), call.name);
      expect(() => gate(call.name, call.params)).not.toThrow();
      start(p, `call-${index}`, call.name, call.params);
      end(p, `call-${index}`, call.name);
    }
    // 旧规则下前两个调用（snapshot、click）都被拒：模型必须先花一轮登记才能动。
    // 原始运行为此花了 4 次 record_task_results（都在同一个 click 上）；新规则下 0 次。
    expect(legacyRejections).toBe(2);
    const items = itemsOf(p);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({tool: 'click', target: '@18', status: 'satisfied'});
    expect(items[0]!.description).toContain('暂停视频');
    expect(p.snapshot().resultState).toBe('satisfied');
  });
});

describe('自动项说明', () => {
  it('优先用调用自带的 label，其次目标，最后动作名', () => {
    expect(deriveResultDescription('click', {label: '暂停视频'}, '@18')).toBe('点击「暂停视频」');
    expect(deriveResultDescription('click', {target: '#follow'}, '#follow')).toBe('点击 #follow');
    expect(deriveResultDescription('fill', {target: '#name'}, '#name')).toBe('填写 #name');
    expect(deriveResultDescription('navigate', {url: 'https://example.com/a'}, null)).toBe('打开页面 https://example.com/a');
    expect(deriveResultDescription('press_key', {key: 'Enter'}, null)).toBe('按键 Enter');
    expect(deriveResultDescription('page_operation', {}, null)).toBe('修改字段');
  });
});
