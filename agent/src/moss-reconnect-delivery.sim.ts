/**
 * 网络重试期间的待播交接。假时钟和假语音服务只检查动作，不代表真实语音验收。
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { VoiceService } from './voice-service.js';
import { RealtimeVoiceSession } from './realtime-voice-session.js';
import { MOSS_LIVE_MODEL, type TaskProgressSnapshot, type UserDelivery, type VoiceRouteContext } from '../../shared/voice.js';
import type { ServerMessage } from '../../shared/protocol.js';

type Event = Record<string, unknown>;

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const sockets: Array<{
    sent: Event[];
    server: (event: Event) => void;
    disconnect: () => void;
  }> = [];
  const events: ServerMessage[] = [];
  const requests: string[] = [];
  const contexts: VoiceRouteContext[] = [];
  const delivery: UserDelivery = {
    conversationId: 'fixture', id: 'delivery-1', runId: 'run-1', kind: 'finding',
    text: '已核对的虚构结果', composedAt: Date.now(), status: 'composed',
  };
  const snapshot: TaskProgressSnapshot = {
    conversationId: 'fixture', observedAt: Date.now(), state: 'running', goal: '虚构任务',
    startedAt: Date.now(), runId: 'run-1', controlVersion: 1, active: [], lastAction: null, successVerified: false,
    conversationContext: { recentTurns: [], latestResult: null, latestDelivery: null },
  };
  const voice = new VoiceService(
    () => snapshot,
    msg => events.push(msg),
    async () => 'fixture-key',
    deps => {
      const session = new RealtimeVoiceSession({
        ...deps,
        model: MOSS_LIVE_MODEL,
        connect: () => {
          const sent: Event[] = [];
          const listeners = new Map<string, (...args: unknown[]) => void>();
          const socket = {
            readyState: 1,
            on(event: string, listener: (...args: unknown[]) => void) { listeners.set(event, listener); },
            send(data: string | Uint8Array) { if (typeof data === 'string') sent.push(JSON.parse(data) as Event); },
            close() {},
          };
          sockets.push({
            sent,
            server: event => listeners.get('message')!(JSON.stringify(event), false),
            disconnect: () => listeners.get('close')!(1006, ''),
          });
          return socket as never;
        },
        synthesizeNotice: async (text, signal, audio) => {
          if (!signal.aborted) {
            requests.push(text);
            audio(new Uint8Array([1, 0]));
          }
        },
      });
      if (process.env.MOSS_SIM_DISABLE_RESTORE === '1') session.restoreMossDeliveries = () => {};
      return session;
    },
    async (_id, _text, _startedAt, _current, context) => {
      contexts.push(context);
      return { kind: 'none', nativeChat: true };
    },
    undefined,
    undefined,
    (_conversationId, id, status) => {
      if (id === delivery.id && status === 'played') delivery.status = 'played';
    },
  );

  async function start(id: string, resume = false) {
    await voice.handle('fixture', { type: 'voice', voiceId: id, command: { kind: 'start', ...(resume ? { resume: true } : {}) } });
    const socket = sockets.at(-1)!;
    socket.server({ action: 'session_attached', data: { session_id: 'fixture-session' } });
    socket.server({ action: 'session.updated', data: { error: '' } });
    return socket;
  }

  function deliver(item: UserDelivery = delivery) {
    snapshot.state = 'idle';
    snapshot.goalCheck = { status: 'done', remaining: null, at: Date.now() };
    snapshot.conversationContext!.latestDelivery = item;
    voice.observe({ type: 'agent_event', conversationId: 'fixture', event: {
      kind: 'user_delivery_stream', stream: { id: item.id, runId: item.runId, kind: 'finding', text: '', phase: 'streaming' },
    } } as ServerMessage);
    voice.observe({ type: 'agent_event', conversationId: 'fixture', event: { kind: 'user_delivery', delivery: item } } as ServerMessage);
  }

  async function consent(id: string) {
    const socket = sockets.at(-1)!;
    socket.server({ action: 'input.speech.started', data: {} });
    await voice.handle('fixture', { type: 'voice', voiceId: id, command: { kind: 'commit', turn: 2 } });
    socket.server({ action: 'input.speech.stopped', data: {} });
    socket.server({ action: 'input.transcript.done', data: { text: '说吧', turn: 'consent-turn' } });
    await new Promise(resolve => setImmediate(resolve));
  }

  return { voice, start, deliver, consent, sockets, requests, contexts, events, snapshot, delivery };
}

test('待同意的结果经过连续重试不自动朗读，同意后只请求一次', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.server({ action: 'input.speech.started', data: {} });
  sim.deliver();
  assert.deepEqual(sim.requests, []);
  first.disconnect();
  t.mock.timers.tick(5000);
  const second = await sim.start('voice-2', true);
  assert.equal(second.sent.find(event => event.action === 'attach_session')?.session_id, 'fixture-session');
  assert.deepEqual(sim.requests, []);
  second.disconnect();
  t.mock.timers.tick(5000);
  await sim.start('voice-3', true);
  assert.deepEqual(sim.requests, []);
  await sim.consent('voice-3');
  assert.equal(sim.contexts.at(-1)?.awaitingResultConsent, true);
  assert.deepEqual(sim.requests, ['已核对的虚构结果']);
  sim.voice.close();
});

test('播放已开始时断线，不自动重复，明确同意后才重播', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  sim.deliver();
  assert.deepEqual(sim.requests, ['已核对的虚构结果']);
  first.disconnect();
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, ['已核对的虚构结果']);
  await sim.consent('voice-2');
  assert.deepEqual(sim.requests, ['已核对的虚构结果', '已核对的虚构结果']);
  sim.voice.close();
});

test('已经播完的结果，重连不补播也不提示说吧', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.server({ action: 'input.speech.started', data: {} });
  sim.deliver();
  sim.delivery.status = 'played';
  first.disconnect();
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, []);
  assert.ok(!sim.events.some(msg => msg.type === 'voice' && msg.voiceId === 'voice-2'
    && msg.event.kind === 'state' && msg.event.detail?.includes('说吧')));
  sim.voice.close();
});

test('只有任务改变时，重连不补播旧结果', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.disconnect();
  sim.deliver();
  sim.snapshot.runId = 'run-2';
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, []);
  assert.ok(!sim.events.some(msg => msg.type === 'voice' && msg.voiceId === 'voice-2'
    && msg.event.kind === 'state' && msg.event.detail?.includes('说吧')));
  sim.voice.close();
});

test('只有控制版本改变时，重连不补播旧结果', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.disconnect();
  sim.deliver();
  sim.snapshot.controlVersion = 2;
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, []);
  assert.ok(!sim.events.some(msg => msg.type === 'voice' && msg.voiceId === 'voice-2'
    && msg.event.kind === 'state' && msg.event.detail?.includes('说吧')));
  sim.voice.close();
});

test('排队等自动播报时断线，重连后仍自动播报，不改成要同意', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  const earlier: UserDelivery = { ...sim.delivery, id: 'delivery-0', text: '先到的虚构结果' };
  sim.deliver(earlier);
  assert.deepEqual(sim.requests, ['先到的虚构结果']);
  sim.deliver();
  assert.deepEqual(sim.requests, ['先到的虚构结果']);
  first.disconnect();
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, ['先到的虚构结果', '已核对的虚构结果']);
  sim.voice.close();
});

test('断线到重连之间任务完成，重连后自动播报一次', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.disconnect();
  sim.deliver();
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  assert.deepEqual(sim.requests, ['已核对的虚构结果']);
  sim.voice.close();
});

test('断线期间任务被取消，重连不补播也不提示说吧', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.disconnect();
  sim.deliver();
  sim.snapshot.state = 'aborted';
  sim.voice.observe({ type: 'agent_event', conversationId: 'fixture', event: {
    kind: 'user_delivery_stream', stream: { id: sim.delivery.id, runId: sim.delivery.runId, kind: 'finding', text: '', phase: 'cancelled' },
  } } as ServerMessage);
  t.mock.timers.tick(5000);
  await sim.start('voice-2', true);
  sim.snapshot.state = 'idle';
  sim.voice.observe({ type: 'agent_event', conversationId: 'fixture', event: { kind: 'notice', text: '' } } as unknown as ServerMessage);
  assert.deepEqual(sim.requests, []);
  assert.ok(!sim.events.some(msg => msg.type === 'voice' && msg.voiceId === 'voice-2'
    && msg.event.kind === 'state' && msg.event.detail?.includes('说吧')));
  sim.voice.close();
});

test('主动结束后开启新通话，不恢复旧待播结果', async t => {
  const sim = setup(t);
  const first = await sim.start('voice-1');
  first.server({ action: 'input.speech.started', data: {} });
  sim.deliver();
  await sim.voice.handle('fixture', { type: 'voice', voiceId: 'voice-1', command: { kind: 'stop' } });
  t.mock.timers.tick(5000);
  await sim.start('voice-2');
  assert.deepEqual(sim.requests, []);
  assert.ok(!sim.events.some(msg => msg.type === 'voice' && msg.voiceId === 'voice-2'
    && msg.event.kind === 'state' && msg.event.detail?.includes('说吧')));
  sim.voice.close();
});
