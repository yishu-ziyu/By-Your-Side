/**
 * V2 独立验收（只读复核）补充反例。验证性测试，不改产品代码。
 * 反例一：同一个 tabs 工具——「查询标签」要回答（有声、无胶囊），「切换标签」只轻反馈（胶囊、当轮无声）。
 * 反例二：「只粘贴，不保存」——宿主不新增保存审批、不生成保存/完成文案，语音通道保留（模型能按要求说明未保存）。
 * 反例三：正常续答里模型继续调用工具不被阻断，后续结果有声。
 * 链路与 realtime-feedback-translation.test.ts 相同：真实 ConversationManager → BrowserAgentSession → ToolRpc
 * → RealtimeVoiceSession → 内存 Socket；只模拟扩展传输与 provider。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserAgentSession } from '../src/session.js';
import { ConversationManager } from '../src/conversation-manager.js';
import { createBrowserTools } from '../src/tools.js';
import { RealtimeVoiceSession } from '../src/realtime-voice-session.js';
import { MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';
import type { ServerMessage } from '../../shared/protocol.js';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach(close => close()));

class Socket extends EventEmitter {
  readyState = 1;
  sent: any[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

async function harness() {
  const messages: ServerMessage[] = [], voiceEvents: any[] = [], socket = new Socket();
  const prompt = vi.fn();
  let wrapper!: BrowserAgentSession;
  const facts = new Map<string, string>();
  const rpc: any = {
    setPageTarget: () => {}, getPageTarget: () => 7, resolvePageParams: (_n: string, params: object) => ({ tabId: 7, ...params }),
    ensureToolCall: () => {}, markCallRejected: (id: string) => facts.set(id, 'not_executed'),
    getExecutionFact: (id: string) => facts.get(id), noteToolFact: (id: string, fact: string) => facts.set(id, fact),
    call: vi.fn(async (name: string, _params: any, _t?: unknown, _m?: unknown, _p?: unknown, _e?: unknown, id?: string) => {
      if (id) facts.set(id, 'executed');
      if (name === 'switch_tab') return { tabId: 8,
        verification: { verified: true, activeTabId: 8, windowId: 1, windowFocused: true, workingTabId: 8 } };
      if (name === 'list_tabs') return { tabs: [{ id: 7, url: 'https://example.test', title: 'page' }] };
      if (name === 'get_active_tab') return { tab: { id: 7, url: 'https://example.test', title: 'page' } };
      if (name === 'fill') return { filled: true, verified: true };
      if (name === 'snapshot') return { tabId: 7, url: 'https://example.test', text: 'page' };
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
  const voice = new RealtimeVoiceSession({
    voiceId: 'acceptance', getSnapshot: () => manager.getTaskProgress('default'),
    emit: (event: any) => voiceEvents.push(event),
    browserTool: (call: any, input: any, signal: any) => manager.executeRealtimeBrowserTool('default', call, input, signal),
    connect: () => socket as any,
  } as any);
  cleanup.push(() => voice.close());
  voice.start('offline-placeholder');
  socket.server({ type: 'session.created', session: { model: MODEL } });
  socket.server({ type: 'session.updated', session: { model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' } } });
  // 一次用户话轮：开口 → 页面资料 → VAD 停 → 服务端创建本轮回复 t{n} → 转写
  const beginTurn = (n: number, text: string) => {
    socket.server({ type: 'input_audio_buffer.speech_started', item_id: `u${n}` });
    voice.command({ kind: 'commit', turn: n + 1, input: { context: { tabId: 7, url: 'https://example.test', title: 'Example' } } });
    socket.server({ type: 'input_audio_buffer.speech_stopped', item_id: `u${n}` });
    socket.server({ type: 'response.created', response: { id: `t${n}` } });
    socket.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: `u${n}`, transcript: text });
  };
  const callTool = (responseId: string, callId: string, name: string, args: unknown) =>
    socket.server({ type: 'response.function_call_arguments.done', response_id: responseId, call_id: callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) });
  const finish = (responseId: string) => socket.server({ type: 'response.done', response: { id: responseId, status: 'completed' } });
  const continuationCreated = (id: string) => socket.server({ type: 'response.created', response: { id } });
  const speakInto = (id: string, text: string) => {
    socket.server({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(960).toString('base64') });
    socket.server({ type: 'response.audio_transcript.delta', response_id: id, delta: text });
    finish(id);
  };
  const outputs = () => socket.sent.filter(m => m.item?.type === 'function_call_output');
  const feedbacks = () => messages.flatMap(m => {
    const event = (m as { event?: { kind?: string; feedback?: any } }).event;
    return m.type === 'agent_event' && event?.kind === 'execution_feedback' && event.feedback ? [event.feedback] : [];
  });
  const audioFor = (id: string) => voiceEvents.filter(e => e.kind === 'audio' && e.responseId === id);
  const transcriptsFor = (id: string) => voiceEvents.filter(e => e.kind === 'text' && e.role === 'assistant' && e.text);
  const awaitCreate = async () => { await vi.waitFor(() => expect(socket.sent.some(m => m.type === 'response.create')).toBe(true)); };
  return { manager, messages, voiceEvents, socket, rpc, beginTurn, callTool, finish, continuationCreated, speakInto, outputs, feedbacks, audioFor, transcriptsFor, awaitCreate };
}

it('反例一：tabs 查询不出胶囊、切换出胶囊；gate 关闭时两者均有声', async () => {
  const h = await harness();
  // 第一句：问标签页 → tabs list → 有声回答、无胶囊
  h.beginTurn(1, '现在有哪些标签页？');
  h.callTool('t1', 'c-list', 'tabs', { action: 'list' });
  h.finish('t1');
  await vi.waitFor(() => expect(h.outputs()).toHaveLength(1));
  await h.awaitCreate();
  h.continuationCreated('a1');
  h.speakInto('a1', '现在有两个标签页');
  expect(h.feedbacks()).toHaveLength(0);                       // 查询不进胶囊
  expect(h.audioFor('a1').length).toBeGreaterThan(0);          // 回答有声
  // 第二句：switch 胶囊一次，默认关闭 gate 时语音仍在
  h.beginTurn(2, '切到标签页 8');
  h.callTool('t2', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t2');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ channel: 'capsule', kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true });
  await vi.waitFor(() => expect(h.socket.sent.filter(m => m.type === 'response.create').length).toBeGreaterThanOrEqual(2));
  h.continuationCreated('a2');
  h.speakInto('a2', '已经切换到标签页 8 了');
  expect(h.audioFor('a2')).toHaveLength(1); // gate 默认关闭：胶囊不擅自吞语音
  expect(h.transcriptsFor('a2').length).toBeGreaterThan(0);    // 文字仍在
});

it('反例二：「只粘贴，不保存」不新增保存审批、不生成保存/完成文案，语音保留', async () => {
  const h = await harness();
  h.beginTurn(1, '把第 3 条评论粘到笔记，不要保存');
  h.callTool('t1', 'c-fill', 'fill', { target: '@4', value: '第 3 条评论' });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  const feedback = h.feedbacks()[0]!;
  expect(feedback).toMatchObject({ kind: 'success', text: '已填入', bounce: true, capsuleCanCloseAction: false });
  expect(feedback.text).not.toContain('保存');
  expect(feedback.text).not.toContain('完成');
  // 模型可见的工具回执：只有动作回执文案，没有保存询问，也没有宿主静音/身份标记
  await vi.waitFor(() => expect(h.outputs()).toHaveLength(1));
  const wire = h.outputs()[0]!.item.output as string;
  const parsed = JSON.parse(wire);
  expect(parsed.hostFeedback).toEqual({ text: '已填入' });
  expect(wire).not.toContain('保存吗');
  expect(wire).not.toContain('已保存');
  expect(wire).not.toContain('全部完成');
  expect(wire).not.toContain('capsuleCanCloseAction');
  // 宿主没有派发任何保存/提交类动作，也没有新增确认/审批流
  expect(h.rpc.call.mock.calls.map((c: unknown[]) => c[0])).toEqual(['fill']);
  expect(h.messages.some(m => m.type === 'consent_request' || m.type === 'task_control')).toBe(false);
  // 语音通道保留：模型仍能按原话说明「未保存」
  await h.awaitCreate();
  h.continuationCreated('a1');
  h.speakInto('a1', '已经粘进笔记了，按你的要求没有保存');
  expect(h.audioFor('a1').length).toBeGreaterThan(0);
});

it('反例三：gate 默认关闭时继续调用工具不被阻断，后续结果有声', async () => {
  const h = await harness();
  h.beginTurn(1, '切到标签页 8，然后读一下页面');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  await h.awaitCreate();
  h.continuationCreated('a1');
  socketAudio(h, 'a1'); // 无转写时音频也直接交付
  h.callTool('a1', 'c-snap', 'snapshot', {});
  h.finish('a1');
  await vi.waitFor(() => expect(h.rpc.call.mock.calls.some((c: unknown[]) => c[0] === 'snapshot')).toBe(true));
  await vi.waitFor(() => expect(h.socket.sent.filter(m => m.type === 'response.create').length).toBeGreaterThanOrEqual(2));
  h.continuationCreated('a2');
  h.speakInto('a2', '页面读到了');
  await vi.waitFor(() => expect(h.audioFor('a1').length).toBeGreaterThan(0));           // 无转写音频直接交付
  await vi.waitFor(() => expect(h.audioFor('a2').length).toBeGreaterThan(0));           // 后续续答有声
  expect(h.outputs().some(m => m.item.call_id === 'c-snap')).toBe(true); // 工具结果未被吞
});

function socketAudio(h: { socket: Socket }, id: string): void {
  h.socket.server({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(960).toString('base64') });
}
