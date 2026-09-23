import { afterEach, expect, it, vi } from 'vitest';

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

import { BrowserAgentSession } from '../src/session.js';
import { ConversationManager } from '../src/conversation-manager.js';
import { createBrowserTools } from '../src/tools.js';
import type { ServerMessage } from '../../shared/protocol.js';

const cleanup: Array<() => void> = [];

afterEach(() => cleanup.splice(0).forEach(close => close()));

async function harness() {
  const messages: ServerMessage[] = [], facts = new Map<string, string>();
  const prompt = vi.fn();
  let unknownWrite = false, wrapper!: BrowserAgentSession, emit!: (message: any) => void;

  const rpc: any = {
    setPageTarget: vi.fn(), getPageTarget: () => 7,
    resolvePageParams: (_: string, params: Record<string, Json>) => ({ tabId: 7, ...params }),
    ensureToolCall: vi.fn(), markCallRejected: (id: string) => facts.set(id, 'not_executed'),
    getExecutionFact: (id: string) => facts.get(id), noteToolFact: (id: string, fact: string) => facts.set(id, fact),
    call: vi.fn(async (name: string, _params: unknown, _timeout: unknown, _member: unknown, _program: unknown, _epoch: unknown, id: string) => {
      facts.set(id, unknownWrite && name === 'fill' ? 'unknown' : 'executed');

      if (unknownWrite && name === 'fill') throw Object.assign(new Error('receipt timeout'), { executionFact: 'unknown' });

      if (name === 'snapshot') return { tabId: 7, url: 'https://example.test', text: 'page' };

      if (name === 'list_tabs') return { tabs: [{ id: 7, url: 'https://example.test', title: 'page' }] };

      if (name === 'get_active_tab') return { tab: { id: 7, url: 'https://example.test', title: 'page' } };

      return { tabId: 8 };
    }),
  };

  const manager = new ConversationManager(async (_id, sink) => {
    emit = sink;

    const raw: any = { isStreaming: false, prompt, agent: { state: { tools: [], messages: [] } },
      sessionManager: { appendCustomEntry: vi.fn(), getBranch: () => [] } };

    wrapper = new (BrowserAgentSession as any)(raw, null, {
      emit: (event: any) => sink({ type: 'agent_event', event }),
      setStatus: (state: any) => sink({ type: 'status', state }),
    }, null, null, undefined, null, rpc);
    raw.agent.state.tools = createBrowserTools(rpc, undefined, undefined, undefined, {
      epoch: () => wrapper.executionEpoch(), canWrite: id => wrapper.canWriteCurrentInput(id),
      assertCall: (name, params, id) => wrapper.assertTaskResultExecution(name, params, id),
    });

    return { session: wrapper, rpc, fleet: { teamView: () => null, isGroupHeld: () => false }, dispose: vi.fn() } as any;
  }, message => messages.push(message));

  cleanup.push(() => manager.dispose());
  await manager.ensureDefault();

  const call = (inputId: string, name: string, args = {}, signal = new AbortController().signal) => manager.executeRealtimeBrowserTool('default',
    { inputId, callId: `${inputId}-${name}`, name, args, text: '本轮操作' }, {}, signal);

  return { manager, messages, prompt, rpc, call, emit: (event: any) => emit({ type: 'agent_event', event }),
    snap: () => manager.getTaskProgress('default')!, unknown: (value: boolean) => { unknownWrite = value; } };
}

it('A: successful scroll, next-input read and next-input tab switch remain usable with real progress and direct execution', async () => {
  const h = await harness();
  await h.call('one', 'scroll', { dy: 500 });
  const firstRun = h.snap().runId;
  await h.call('one', 'hover', { target: '#menu' });
  expect(h.snap().runId).toBe(firstRun);
  await h.call('two', 'snapshot');
  expect(h.snap().runId).not.toBe(firstRun);
  await h.call('three', 'tabs', { action: 'switch', tabId: 8 });
  expect(h.snap()).toMatchObject({ state: 'idle', executionAuditComplete: true, successVerified: false });
  expect(h.snap().startedAt).not.toBeNull();
  expect(h.messages.some(m => m.type === 'status' && m.state === 'running')).toBe(true);
  expect(h.prompt).not.toHaveBeenCalled();
  const stopped = new AbortController(); stopped.abort();
  await expect(h.call('cancelled', 'scroll', { dy: 500 }, stopped.signal)).rejects.toThrow();
  expect(h.snap().state).toBe('idle');
});

it('B: unknown write allows inspection but retains its run and blocks writes until the original receipt arrives', async () => {
  const h = await harness(); h.unknown(true);
  await expect(h.call('write', 'fill', { target: '#name', value: 'x' })).rejects.toThrow('receipt timeout');
  const runId = h.snap().runId, item = h.snap().results!.find(r => r.status === 'unknown')!;
  expect(item?.evidence?.toolCallId).toBeTruthy();

  for (const [name, args] of [['snapshot', {}], ['tabs', { action: 'list' }], ['tabs', { action: 'active' }]] as const) {
    await h.call(`inspect-${JSON.stringify(args)}`, name, args);
    expect(h.snap().runId).toBe(runId);
    expect(h.snap().results!.find(r => r.id === item.id)?.status).toBe('unknown');
  }

  for (const action of ['open', 'switch', 'close']) {
    await expect(h.call(`blocked-${action}`, 'tabs', { action, tabId: 8 })).rejects.toThrow();
    expect(h.snap().runId).toBe(runId);
  }

  await expect(h.call('retry', 'fill', { target: '#name', value: 'x' })).rejects.toThrow();
  h.emit({ kind: 'tool_late_result', toolCallId: 'unrelated', name: 'fill', ok: true, executionFact: 'executed' });
  expect(h.snap().results!.find(r => r.id === item.id)?.status).toBe('unknown');
  h.emit({ kind: 'tool_late_result', toolCallId: item.evidence!.toolCallId, name: 'fill', ok: true, executionFact: 'executed' });
  expect(h.snap().results!.find(r => r.id === item.id)?.status).toBe('satisfied');
  await h.call('after-receipt', 'tabs', { action: 'switch', tabId: 8 });
  expect(h.snap().runId).not.toBe(runId);
  expect(h.rpc.call.mock.calls.filter((c: unknown[]) => c[0] === 'fill')).toHaveLength(1);
  // Non-Realtime JS still has real write risk and must get an attributable receipt.
  h.emit({ kind: 'tool_start', toolCallId: 'js-unknown', name: 'js', params: { code: 'document.querySelector("form").submit()' } });
  h.emit({ kind: 'tool_end', toolCallId: 'js-unknown', name: 'js', isError: true, executionFact: 'unknown' });
  expect(h.snap().executionAuditComplete).toBe(true);
  await h.call('inspect-js', 'snapshot');
  await expect(h.call('after-js', 'tabs', { action: 'switch', tabId: 7 })).rejects.toThrow('js-unknown');
  h.emit({ kind: 'tool_late_result', toolCallId: 'js-unknown', name: 'js', ok: true, executionFact: 'executed' });
  await h.call('resolved-js', 'tabs', { action: 'switch', tabId: 7 });
  // Legacy global gaps cannot be attributed retrospectively: inspect, but never silently clear.
  const progress = (h.manager as any).progress.get('default');
  progress.restoreResults({ ...h.snap(), executionAuditComplete: false });
  const legacyRun = h.snap().runId;
  await h.call('legacy-read', 'snapshot');
  await expect(h.call('legacy-write', 'tabs', { action: 'switch', tabId: 8 })).rejects.toThrow('缺少可关联的执行记录');
  expect(h.snap()).toMatchObject({ runId: legacyRun, executionAuditComplete: false });
  progress.restoreResults({ ...h.snap(), state: 'none', startedAt: null });
  await h.call('restored-legacy-read', 'tabs', { action: 'list' });
  expect(h.snap()).toMatchObject({ state: 'interrupted', runId: legacyRun, executionAuditComplete: false });
  await expect(h.call('restored-legacy-write', 'tabs', { action: 'close' })).rejects.toThrow('等待恢复');
});
