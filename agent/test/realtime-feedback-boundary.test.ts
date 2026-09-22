/**
 * V2.1 通用边界回归迁移：V2.3 不再进行事后音频裁决。
 * 链路与 realtime-feedback-adversarial.test.ts 相同：真实 ConversationManager → BrowserAgentSession
 * → ToolRpc → RealtimeVoiceSession → 内存 Socket；只模拟浏览器传输与 provider。
 * V2.3：本文件覆盖 gate 默认关闭时的反馈证据与正常续答；开启行为另由请求级测试覆盖。
 *
 * R1 gate 关闭时切页＋内部核验：结果照常回传，后续语音正常；
 * R2 切页与问题同句：胶囊确认操作，答案可听到；
 * R2b/A3 成功后真实阻碍：必要问题不被静音吞掉；
 * R3 缺失/矛盾证据不产生成功胶囊（对照：证据齐全仍成功一次）；
 * A5 新话轮不继承旧静音。
 */
import { afterEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BrowserAgentSession } from '../src/session.js';
import { ConversationManager } from '../src/conversation-manager.js';
import { createBrowserTools } from '../src/tools.js';
import { RealtimeVoiceSession } from '../src/realtime-voice-session.js';
import { RealtimeVoiceConnection, MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';
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

/** 可配置的浏览器回执：R3 的负例在这里构造，其余走真实分类与连接逻辑。 */
function browserStub() {
  const state = {
    // 默认：执行后读回核验通过（目标 8 是已聚焦窗口的活动页，工作目标一致）。
    switchReceipt: { tabId: 8, verification: { verified: true, activeTabId: 8, windowId: 1, windowFocused: true, workingTabId: 8 } } as Record<string, unknown>,
    fillReceipt: { filled: true } as Record<string, unknown>,
    snapshot: { tabId: 7, url: 'https://example.test', text: 'page' } as Record<string, unknown>,
  };
  const calls: Array<{ name: string; params: any }> = [];
  return {
    state, calls,
    async call(name: string, params: any, _t?: unknown, _m?: unknown, _p?: unknown, _e?: unknown, id?: string) {
      calls.push({ name, params });
      if (name === 'switch_tab') return { ...state.switchReceipt };
      if (name === 'list_tabs') return { tabs: [{ id: 7, url: 'https://example.test', title: 'page' }] };
      if (name === 'get_active_tab') return { tab: { id: 7, url: 'https://example.test', title: 'page' } };
      if (name === 'fill') return { ...state.fillReceipt };
      if (name === 'snapshot') return { ...state.snapshot };
      return {};
    },
  };
}

async function harness() {
  const messages: ServerMessage[] = [], voiceEvents: any[] = [], socket = new Socket();
  const prompt = vi.fn();
  const browser = browserStub();
  const facts = new Map<string, string>();
  const rpc: any = {
    setPageTarget: () => {}, getPageTarget: () => 7, resolvePageParams: (_n: string, params: object) => ({ tabId: 7, ...params }),
    ensureToolCall: () => {}, markCallRejected: (id: string) => facts.set(id, 'not_executed'),
    getExecutionFact: (id: string) => facts.get(id), noteToolFact: (id: string, fact: string) => facts.set(id, fact),
    call: vi.fn(async (name: string, params: any, ...rest: unknown[]) => {
      const id = rest[4] as string | undefined;
      if (id) facts.set(id, 'executed');
      return browser.call(name, params, ...rest);
    }),
  };
  const manager = new ConversationManager(async (_id, sink) => {
    const raw: any = { isStreaming: false, prompt, agent: { state: { tools: [], messages: [] } },
      sessionManager: { appendCustomEntry: vi.fn(), getBranch: () => [] } };
    const wrapper = new (BrowserAgentSession as any)(raw, null, {
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
    voiceId: 'boundary', getSnapshot: () => manager.getTaskProgress('default'),
    emit: (event: any) => voiceEvents.push(event),
    browserTool: (call: any, input: any, signal: any) => manager.executeRealtimeBrowserTool('default', call, input, signal),
    connect: () => socket as any,
  } as any);
  cleanup.push(() => voice.close());
  voice.start('offline-placeholder');
  socket.server({ type: 'session.created', session: { model: MODEL } });
  socket.server({ type: 'session.updated', session: { model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' } } });
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
    socket.server({ type: 'response.audio_transcript.done', response_id: id, transcript: text });
    finish(id);
  };
  const bareAudioInto = (id: string) => socket.server({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(960).toString('base64') });
  const outputs = () => socket.sent.filter(m => m.item?.type === 'function_call_output');
  const feedbacks = () => messages.flatMap(m => {
    const event = (m as { event?: { kind?: string; feedback?: any } }).event;
    return m.type === 'agent_event' && event?.kind === 'execution_feedback' && event.feedback ? [event.feedback] : [];
  });
  const audioFor = (id: string) => voiceEvents.filter(e => e.kind === 'audio' && e.responseId === id);
  const awaitCreate = async (count = 1) => { await vi.waitFor(() => expect(socket.sent.filter(m => m.type === 'response.create').length).toBeGreaterThanOrEqual(count)); };
  return { manager, messages, voiceEvents, socket, browser, beginTurn, callTool, finish, continuationCreated, speakInto, bareAudioInto, outputs, feedbacks, audioFor, awaitCreate };
}

// ── R1：只切页，内部gate 默认关闭时核验后正常续答 ─────────────────────────────

it('R1 核验照常执行、结果照常回传；gate 默认关闭时核验后正常续答，胶囊只出现一次', async () => {
  const h = await harness();
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ channel: 'capsule', kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true });
  // gate 默认关闭：前导音频与内部核验均沿用正常路径。
  await h.awaitCreate(1);
  h.continuationCreated('a1');
  h.bareAudioInto('a1');
  h.callTool('a1', 'c-verify', 'tabs', { action: 'active' });
  h.finish('a1');
  // 核验真实执行、结果照常回传（不禁止核验、不吞结果）
  await vi.waitFor(() => expect(h.browser.calls.some(c => c.name === 'get_active_tab')).toBe(true));
  await vi.waitFor(() => expect(h.outputs().some(m => m.item.call_id === 'c-verify')).toBe(true));
  await vi.waitFor(() => expect(h.audioFor('a1').length).toBeGreaterThan(0)); // 音频不依赖转写到达
  // 无反馈的观察批次不能单独结束用户要求，继续正常回答。
  await h.awaitCreate(2);
  h.continuationCreated('a2');
  h.speakInto('a2', '切好了');
  await vi.waitFor(() => expect(h.socket.sent.filter(m => m.type === 'response.create').length).toBeGreaterThanOrEqual(2));
  expect(h.audioFor('a1').length).toBeGreaterThan(0); // 无转写音频同样直接交付
  expect(h.audioFor('a2')).toHaveLength(1); // 默认关闭，不丢任何确认音频
  expect(h.feedbacks()).toHaveLength(1); // 胶囊只出现/回弹一次
});

// ── R2：切页与问题在同一句，答案可听到 ──────────────────────────────────────

it('R2 同句问答：胶囊确认操作，语音回答问题（不能只留转写当证据）', async () => {
  const h = await harness();
  h.beginTurn(1, '切到标签页 8，顺便告诉我一加一等于几');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'success', text: '切好了', bounce: true });
  await h.awaitCreate(1);
  h.continuationCreated('a1');
  h.speakInto('a1', '切好了，一加一等于二');
  await vi.waitFor(() => expect(h.audioFor('a1').length).toBeGreaterThan(0));
  const transcripts = h.voiceEvents.filter(e => e.kind === 'text' && e.role === 'assistant' && e.text);
  expect(transcripts.length).toBeGreaterThan(0);
});

// ── R2b/A3：成功后出现真实阻碍，必要问题不被静音吞掉 ────────────────────────

it('A3 切页后发现必须登录：必要说明可听到，不被前一个成功动作的静音状态吞掉', async () => {
  const h = await harness();
  h.browser.state.snapshot = { tabId: 8, url: 'https://example.test/login', text: '请登录后继续' };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1)); // 切页本身成功，胶囊照常
  await h.awaitCreate(1);
  h.continuationCreated('a1');
  h.callTool('a1', 'c-snap', 'snapshot', {}); // 模型核验时发现登录墙
  h.finish('a1');
  await vi.waitFor(() => expect(h.browser.calls.some(c => c.name === 'snapshot')).toBe(true));
  await h.awaitCreate(2);
  h.continuationCreated('a2');
  h.speakInto('a2', '这个页面需要先登录，你要现在登录吗');
  await vi.waitFor(() => expect(h.audioFor('a2').length).toBeGreaterThan(0));
});

// ── R3：缺失或矛盾的结果不触发成功胶囊；正常对照仍成功一次 ──────────────────

it('R3-1 切页 executed 但回执缺少具体结果：不显示切好了、不回弹、不静音，事实保持 executed', async () => {
  const h = await harness();
  h.browser.state.switchReceipt = {}; // 缺少足以确认目标达成的结果
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  const feedback = h.feedbacks()[0]!;
  expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
  expect(feedback.text).not.toContain('切好');
  expect(feedback.facts.executionFact).toBe('executed'); // 不篡改执行事实
  // 无成功回执 → 续答不静音，模型可以说明或继续核验
  await h.awaitCreate(1);
  h.continuationCreated('a1');
  h.speakInto('a1', '切换结果还没确认，我再核对一下');
  await vi.waitFor(() => expect(h.audioFor('a1').length).toBeGreaterThan(0));
});

it('R3-2 请求 tabId 8、回执指向 7：不产生成功胶囊，如实保留矛盾', async () => {
  const h = await harness();
  h.browser.state.switchReceipt = { tabId: 7 };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  const feedback = h.feedbacks()[0]!;
  expect(feedback.kind).not.toBe('success');
  expect(feedback).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
  expect(feedback.facts.executionFact).toBe('executed');
  expect(feedback.facts.tabId).toBe(7);
  expect(String(feedback.facts.detail ?? '')).toContain('8');
  expect(String(feedback.facts.detail ?? '')).toContain('7');
});

it('R3-3 fill 已执行但内容未核对/不匹配：不显示已填入；核对一致时成功胶囊仍出现一次', async () => {
  // 负例：回执只有 filled，没有内容核对
  const h = await harness();
  h.browser.state.fillReceipt = { filled: true };
  h.beginTurn(1, '把第 3 条评论填进笔记');
  h.callTool('t1', 'c-fill', 'fill', { target: '@4', value: '第 3 条评论' });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
  expect(h.feedbacks()[0]!.text).not.toContain('已填入');
  expect(h.feedbacks()[0]!.facts.executionFact).toBe('executed');
  // 负例：明确不匹配
  h.browser.state.fillReceipt = { filled: true, verified: false };
  h.beginTurn(2, '再填一次搜索框');
  h.callTool('t2', 'c-fill2', 'fill', { target: '@5', value: '关键词' });
  h.finish('t2');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(2));
  expect(h.feedbacks()[1]).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false });
  // 正常对照：内容核对一致 → 成功胶囊一次
  h.browser.state.fillReceipt = { filled: true, verified: true };
  h.beginTurn(3, '把标题填成新标题');
  h.callTool('t3', 'c-fill3', 'fill', { target: '@6', value: '新标题' });
  h.finish('t3');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(3));
  expect(h.feedbacks()[2]).toMatchObject({ kind: 'success', text: '已填入', bounce: true, capsuleCanCloseAction: false });
});

it('R3 正常对照：目标页确已激活（回执 tabId 与要求一致）时成功胶囊仍出现一次', async () => {
  const h = await harness();
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'success', text: '切好了', bounce: true, capsuleCanCloseAction: true });
});

it('R3-4 回显一致但实际未激活/窗口未聚焦/读回失败：均不产生成功胶囊', async () => {
  // 1) 请求 8、回包 8（回显一致），但读回显示实际活动页仍是 7。
  let h = await harness();
  h.browser.state.switchReceipt = { tabId: 8, verification: { verified: false, activeTabId: 7, windowId: 1, windowFocused: true, workingTabId: 8 } };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', bounce: false, capsuleCanCloseAction: false });
  expect(h.feedbacks()[0]!.facts.executionFact).toBe('executed');
  expect(String(h.feedbacks()[0]!.facts.detail ?? '')).toContain('7');

  // 2) 目标页已激活但窗口未聚焦（用户不在这个窗口）。
  h = await harness();
  h.browser.state.switchReceipt = { tabId: 8, verification: { verified: false, activeTabId: 8, windowId: 1, windowFocused: false, workingTabId: 8 } };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', capsuleCanCloseAction: false });
  expect(String(h.feedbacks()[0]!.facts.detail ?? '')).toContain('聚焦');

  // 3) 读回失败：只有 verified:false，无事实字段。
  h = await harness();
  h.browser.state.switchReceipt = { tabId: 8, verification: { verified: false } };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', capsuleCanCloseAction: false });
  expect(h.feedbacks()[0]!.facts.executionFact).toBe('executed');

  // 4) 旧形状回执（无核验事实）：仍服务工作目标，但不能授权成功胶囊。
  h = await harness();
  h.browser.state.switchReceipt = { tabId: 8 };
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  expect(h.feedbacks()[0]).toMatchObject({ kind: 'unknown', text: '结果待确认', capsuleCanCloseAction: false });
});

// ── A5：新话轮不继承旧静音 ──────────────────────────────────────────────────

it('A5 动作结束后，下一次真实用户要求的回答照常出声', async () => {
  const h = await harness();
  h.beginTurn(1, '切到标签页 8');
  h.callTool('t1', 'c-switch', 'tabs', { action: 'switch', tabId: 8 });
  h.finish('t1');
  await vi.waitFor(() => expect(h.feedbacks()).toHaveLength(1));
  await h.awaitCreate(1);
  h.continuationCreated('a1');
  h.speakInto('a1', '已经切换到标签页 8 了');
  // 新的真实话轮照常出声。
  h.beginTurn(2, '现在几点了');
  socketAudio(h, 't2');
  h.socket.server({ type: 'response.done', response: { id: 't2', status: 'completed' } });
  await vi.waitFor(() => expect(h.audioFor('t2').length).toBeGreaterThan(0));
});

function socketAudio(h: { socket: Socket }, id: string): void {
  h.socket.server({ type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(960).toString('base64') });
}
