/**
 * V2 执行反馈翻译层定点测试：简单成功进胶囊且当轮续答不出声；问答与部分成果保留语音。
 * 走真实链路：ConversationManager → BrowserAgentSession → ToolRpc → RealtimeVoiceSession → 内存 Socket。
 * 只模拟扩展传输与 provider Socket；不 mock 反馈分类、续答政策与工具执行入口。
 */
import { afterEach, expect, it, vi } from 'vitest';

type Json = string | number | boolean | null | undefined | Json[] | { [key: string]: Json };

import { EventEmitter } from 'node:events';
import { BrowserAgentSession } from '../src/session.js';
import { ConversationManager } from '../src/conversation-manager.js';
import { createBrowserTools } from '../src/tools.js';
import { RealtimeVoiceSession } from '../src/realtime-voice-session.js';
import { RealtimeVoiceConnection } from '../src/realtime-voice-connection.js';
import { MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';
import type { ServerMessage } from '../../shared/protocol.js';
import type { ExecutionFeedback } from '../../shared/execution-feedback.js';

const cleanup: Array<() => void> = [];

afterEach(() => cleanup.splice(0).forEach(close => close()));

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

async function harness(gate = false) {
  const messages: ServerMessage[] = [], voiceEvents: any[] = [], socket = new Socket();
  const prompt = vi.fn();
  let wrapper!: BrowserAgentSession;
  const facts = new Map<string, string>();
  let unknownFill = false;

  const rpc: any = {
    setPageTarget: () => {}, getPageTarget: () => 7, resolvePageParams: (_name: string, params: Record<string, Json>) => ({ tabId: 7, ...params }),
    ensureToolCall: () => {}, markCallRejected: (id: string) => facts.set(id, 'not_executed'),
    getExecutionFact: (id: string) => facts.get(id), noteToolFact: (id: string, fact: string) => facts.set(id, fact),
    call: vi.fn(async (name: string, params: any, _timeout?: unknown, _member?: unknown, _program?: unknown, _epoch?: unknown, id?: string) => {
      if (id) facts.set(id, 'executed');

      if (name === 'fill' && unknownFill) {
        const error = Object.assign(new Error('receipt timeout'), { executionFact: 'unknown' });
        throw error;
      }

      if (name === 'switch_tab') return { tabId: typeof params?.tabId === 'number' ? params.tabId : 8,
        verification: { verified: true, activeTabId: typeof params?.tabId === 'number' ? params.tabId : 8, windowId: 1, windowFocused: true,
          workingTabId: typeof params?.tabId === 'number' ? params.tabId : 8 } };

      if (name === 'list_tabs') return { tabs: [{ id: 7, url: 'https://example.test', title: 'page' }] };

      if (name === 'get_active_tab') return { tab: { id: 7, url: 'https://example.test', title: 'page' } };

      if (name === 'fill') return { filled: true, verified: true };

      if (name === 'read_element') return { text: '第 3 条评论原文' };

      return {};
    }),
  };

  const manager = new ConversationManager(async (_id, sink) => {
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

  await manager.ensureDefault();
  cleanup.push(() => manager.dispose());
  const started: RealtimeVoiceSession[] = [];
  let live: RealtimeVoiceSession | null = null;

  const voice = async (turn = 1) => {
    if (!live) {
      live = new RealtimeVoiceSession({
        voiceSpokenResultGate: gate,
        shadow: {judge: async (input: any) => ({...input,lane:'task',pageChange:0.95,spokenResult:0.1,requestMs:1,completedAt:Date.now()}),actual:()=>{}},
        voiceId: 'feedback', getSnapshot: () => manager.getTaskProgress('default'),
        emit: (event: any) => voiceEvents.push(event),
        browserTool: (call: any, input: any, signal: any) => manager.executeRealtimeBrowserTool('default', call, input, signal),
        connect: () => socket as any,
        // 判断数据是供应商边界替身，工具、反馈与续答出口使用生产实现。
      } as any);
      started.push(live); cleanup.push(() => live?.close());
      live.start('offline-placeholder');
      socket.server({ type: 'session.created', session: { model: MODEL } });
      socket.server({ type: 'session.updated', session: { model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' } } });
    }

    socket.server({ type: 'input_audio_buffer.speech_started', item_id: `u${turn}` });
    live.command({ kind: 'commit', turn: turn + 1, input: { context: { tabId: 7, url: 'https://example.test', title: 'Example' } } });
    socket.server({ type: 'input_audio_buffer.speech_stopped', item_id: `u${turn}` });
    socket.server({ type: 'response.created', response: { id: `r${turn}` } });
    socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: `u${turn}`, transcript: '本轮要求' });

    return live;
  };

  const call = (seq: number, id: string, name: string, args: unknown) => socket.server({ type: 'response.function_call_arguments.done', response_id: `r${seq}`, call_id: id, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  const done = (seq: number) => socket.server({ type: 'response.done', response: { id: `r${seq}`, status: 'completed' } });

  const speak = (seq: number, text = '好的') => {
    socket.server({ type: 'response.audio.delta', response_id: `r${seq}`, delta: Buffer.from(text).toString('base64') });
    socket.server({ type: 'response.audio_transcript.delta', response_id: `r${seq}`, delta: text });
    socket.server({ type: 'response.done', response: { id: `r${seq}`, status: 'completed' } });
  };

  const outputs = () => socket.sent.filter(m => m.item?.type === 'function_call_output');

  const feedbacks = () => messages.flatMap(m => {
    const event = (m as { event?: { kind?: string; feedback?: ExecutionFeedback } }).event;

    return m.type === 'agent_event' && event?.kind === 'execution_feedback' && event.feedback ? [event.feedback] : [];
  });

  const audioFor = (responseId: string) => voiceEvents.filter(e => e.kind === 'audio' && e.responseId === responseId);
  const transcriptsFor = () => voiceEvents.filter(e => e.kind === 'text' && e.role === 'assistant' && e.text);

  return { manager, messages, voiceEvents, socket, prompt, rpc, voice, call, done, speak, outputs, feedbacks, audioFor, transcriptsFor, unknownFill: (value: boolean) => { unknownFill = value; } };
}

it('A1 切标签成功：只发一次胶囊、不创建语音续答，工具结果照常回传', async () => {
  const h = await harness(true);
  await h.voice(1);
  h.call(1, 'provider-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.done(1);
  await vi.waitFor(() => expect(h.outputs()).toHaveLength(1));
  // 工具结果仍回传（不吞结果）；模型只看到回执文案，宿主静音/身份标记不外泄
  const toolOutput = JSON.parse(h.outputs()[0]!.item.output);
  expect(toolOutput).toMatchObject({ ok: true, executionFact: 'executed', hostFeedback: { text: '切好了' } });
  expect(toolOutput).not.toHaveProperty('feedback');
  expect(toolOutput).not.toHaveProperty('capsuleCanCloseAction');
  // 胶囊反馈恰好一次，身份是真实宿主调用
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  const feedback = h.feedbacks()[0]!;
  expect(feedback).toMatchObject({ channel: 'capsule', kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true });
  expect(feedback.id).toMatch(/tool:display-/);
  expect(feedback.facts).toMatchObject({ tool: 'tabs', action: 'switch', executionFact: 'executed', tabId: 8 });
  // V2.3：不创建续答，因此不让供应商生成成功确认音频。
  expect(h.socket.sent.filter(m => m.type === 'response.create')).toHaveLength(0);
  expect(h.audioFor('r2')).toHaveLength(0);
  // 下一次真实问答仍然出声（不是全局静音）
  await h.voice(2);
  h.socket.server({ type: 'response.created', response: { id: 'r3' } });
  h.speak(3, '一加一等于二');
  expect(h.audioFor('r3').length).toBeGreaterThan(0);
});

it('A2 查询标签页：正常回答，不出胶囊、不静音', async () => {
  const h = await harness();
  await h.voice(1);
  h.call(1, 'provider-list', 'tabs', { action: 'list' });
  h.done(1);
  await vi.waitFor(() => expect(h.outputs()).toHaveLength(1));
  await vi.waitFor(() => expect(h.socket.sent.some(m => m.type === 'response.create')).toBe(true));
  h.socket.server({ type: 'response.created', response: { id: 'r2' } });
  h.speak(2, '现在有两个标签页');
  expect(h.feedbacks()).toHaveLength(0);
  expect(h.audioFor('r2').length).toBeGreaterThan(0);
});

it('A3 填入成功：胶囊给动作回执，语音保留（还没保存这类部分成果仍能说）', async () => {
  const h = await harness();
  await h.voice(1);
  h.call(1, 'provider-fill', 'fill', { target: '@4', value: '第 3 条评论' });
  h.done(1);
  await vi.waitFor(() => expect(h.outputs()).toHaveLength(1));
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  const feedback = h.feedbacks()[0]!;
  expect(feedback).toMatchObject({ channel: 'capsule', kind: 'success', text: '已填入', bounce: true, capsuleCanCloseAction: false });
  await vi.waitFor(() => expect(h.socket.sent.some(m => m.type === 'response.create')).toBe(true));
  h.socket.server({ type: 'response.created', response: { id: 'r2' } });
  h.speak(2, '已经放进笔记，还没保存');
  expect(h.audioFor('r2').length).toBeGreaterThan(0);
});

it('A4 结果未知或被拦：绝不显示成功文案、不回弹，语音保留说明缺口', async () => {
  const h = await harness();
  h.unknownFill(true);
  await h.voice(1);
  h.call(1, 'provider-unknown', 'fill', { target: '@4', value: 'x' });
  h.done(1);
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false });
  expect(h.feedbacks()[0]!.text).not.toContain('已填入');
  expect(h.feedbacks()[0]!.text).not.toContain('完成');
  await vi.waitFor(() => expect(h.socket.sent.some(m => m.type === 'response.create')).toBe(true));
  h.socket.server({ type: 'response.created', response: { id: 'r2' } });
  h.speak(2, '这次填写结果还没确认');
  expect(h.audioFor('r2').length).toBeGreaterThan(0);
});

it('A5 重复回执只反馈一次；两次独立操作各反馈一次', async () => {
  const h = await harness();
  await h.voice(1);
  h.call(1, 'provider-dup', 'tabs', { action: 'switch', tabId: 8 });
  h.call(1, 'provider-dup', 'tabs', { action: 'switch', tabId: 8 });
  h.done(1);
  await vi.waitFor(() => expect(h.rpc.call.mock.calls.filter((c: unknown[]) => c[0] === 'switch_tab')).toHaveLength(1));
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  await h.voice(2);
  h.call(2, 'provider-second', 'tabs', { action: 'switch', tabId: 8 });
  h.done(2);
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(2));
  expect(h.feedbacks()[0]!.id).not.toBe(h.feedbacks()[1]!.id);
  expect(h.feedbacks().every(f => f.text === '切好了')).toBe(true);
});

// 普通 Realtime 回归：created 超时、busy 与通知后用户仍可听到回答。

function normalConnection() {
  const socket = new Socket();
  const client: any[] = [];

  const connection = new RealtimeVoiceConnection({
    key: 'offline-placeholder',
    connect: () => socket as any,
    send: (event: any) => client.push(event),
    log: () => {},
    tools: {
      browserTool: async () => ({
        ok: true,
        content: [{ type: 'text', text: 'Working tab is now 8.' }],
        toolCallId: 'display-q1',
        executionFact: 'executed',
        feedback: {
          id: 'tool:display-q1', channel: 'capsule', kind: 'success', text: '切好了', bounce: true,
          capsuleCanCloseAction: true, facts: { tool: 'tabs', action: 'switch', executionFact: 'executed', tabId: 8 }, createdAt: 1,
        },
      }),
      browser_request: async () => ({ ok: true }),
      task_status: async () => ({}),
      read_page: async () => ({}),
    },
  });

  cleanup.push(() => connection.close());
  connection.start();
  socket.server({ type: 'session.created', session: { model: MODEL } });
  socket.server({ type: 'session.updated', session: { model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' } } });
  // 一次完整话轮 + 一次 tabs switch：工具回执生成胶囊反馈，默认保持正常续答。
  socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  socket.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  socket.server({ type: 'response.created', response: { id: 'r1' } });
  socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '切到标签页 8' });
  socket.server({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'tabs', arguments: '{"action":"switch","tabId":8}' });
  socket.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
  const audioFor = (responseId: string) => client.filter(e => e.type === 'audio' && e.responseId === responseId);
  const notice = () => socket.sent.find(m => String((m as any).item?.id ?? '').startsWith('bys-notice-')) as any;

  return { connection, socket, client, audioFor, notice };
}

it('缺陷1-a 续答 created 超时后，用户下一句的回答不再被静音', async () => {
  vi.useFakeTimers();

  try {
    const f = normalConnection();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.socket.sent.filter(m => (m as any).item?.type === 'function_call_output')).toHaveLength(1);
    expect(f.socket.sent.filter(m => m.type === 'response.create')).toHaveLength(1); // 正常续答已请求
    await vi.advanceTimersByTimeAsync(12_500); // create-watch 超时不影响下一句
    // 用户下一句由服务端自动创建回复
    f.socket.server({ type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    f.socket.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u2' });
    f.socket.server({ type: 'response.created', response: { id: 'r2' } });
    f.socket.server({ type: 'response.audio.delta', response_id: 'r2', delta: Buffer.alloc(960).toString('base64') });
    expect(f.audioFor('r2')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('缺陷1-c 只有 create-watch 超时（没有新话轮）时，后续音频仍直接交付', async () => {
  vi.useFakeTimers();

  try {
    const f = normalConnection();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.socket.sent.filter(m => m.type === 'response.create')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_500); // 只让 watchdog 触发，不发新的 speech_started
    f.socket.server({ type: 'response.created', response: { id: 'r4' } });
    f.socket.server({ type: 'response.audio.delta', response_id: 'r4', delta: Buffer.alloc(960).toString('base64') });
    expect(f.audioFor('r4')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

it('缺陷1-b 续答被 busy 拒绝后，排队中的交付通知仍然出声', async () => {
  vi.useFakeTimers();

  try {
    const f = normalConnection();
    await vi.advanceTimersByTimeAsync(50);
    expect(f.socket.sent.filter(m => m.type === 'response.create')).toHaveLength(1);
    f.socket.server({ type: 'error', error: { code: 'busy', message: 'session busy' } });
    f.connection.notifyTask('后台结果：两项已完成，一项未完成');
    expect(f.notice()).toBeDefined();
    f.socket.server({ type: 'conversation.item.created', item: f.notice().item });
    const creates = f.socket.sent.filter(m => m.type === 'response.create');
    expect(creates.length).toBeGreaterThanOrEqual(2);
    f.socket.server({ type: 'response.created', response: { id: 'r9' } });
    f.socket.server({ type: 'response.audio.delta', response_id: 'r9', delta: Buffer.alloc(960).toString('base64') });
    expect(f.audioFor('r9')).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});
