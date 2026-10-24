/**
 * 停声的规则：假时钟、假语音服务，只判连接发给服务端和侧栏的动作。
 * 被停的那一轮不再开口（含它在途工具回来后的续答），之后的任务通知照常念，通话不因停声断掉。
 * 真的停声、真的出声由 inproc-voice.mts --case=stop-task 验。
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MODEL, RealtimeVoiceConnection } from './realtime-voice-connection.js';

type Event = Record<string, unknown>;

/** 两秒的回答声音。 */
const AUDIO = Buffer.alloc(2 * 24_000 * 2).toString('base64');

function setup(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const provider: Event[] = [];
  const client: Event[] = [];
  const listeners = new Map<string, (data: string) => void>();
  let finishRead: (value: unknown) => void = () => {};
  const socket = {
    readyState: 1,
    on(event: string, listener: (data: string) => void) { listeners.set(event, listener); },
    send(data: string) { provider.push(JSON.parse(data)); },
    close() {},
    removeAllListeners() {},
  };
  const connection = new RealtimeVoiceConnection({
    key: 'sim',
    connect: () => socket as never,
    send: event => client.push(event),
    tools: {
      browser_request: async () => ({ ok: true }),
      read_page: () => new Promise(resolve => { finishRead = resolve; }),
      task_status: async () => ({ ok: true }),
    },
  });
  const server = (event: Event) => listeners.get('message')!(JSON.stringify(event));

  connection.start();
  server({ type: 'session.created', session: { model: MODEL } });
  server({ type: 'session.updated', session: provider.find(e => e.type === 'session.update')!.session });

  return {
    connection,
    server,
    /** 从 from 起发给服务端的事件类型。 */
    sentSince: (from: number) => provider.slice(from).map(e => e.type === 'conversation.item.create' ? `item:${String((e.item as Event).type)}` : String(e.type)),
    providerCount: () => provider.length,
    noticeItem: (text: string) => provider.find(e => e.type === 'conversation.item.create' && JSON.stringify(e.item).includes(text))?.item as Event | undefined,
    clientErrors: () => client.filter(e => e.type === 'error' || e.type === 'closed'),
    clientAudio: (responseId: string) => client.filter(e => e.type === 'audio' && e.responseId === responseId).length,
    finishRead: async (value: unknown) => { finishRead(value); await new Promise(resolve => setImmediate(resolve)); },
  };
}

/** 用户问一句，服务端自动回复：先调 read_page，再说一句「我看看」的声音。 */
function askAndReply(sim: ReturnType<typeof setup>, done: boolean) {
  sim.server({ type: 'input_audio_buffer.speech_started', item_id: 'u1' });
  sim.server({ type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
  sim.server({ type: 'response.created', response: { id: 'r1' } });
  sim.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '这个页面写了什么' });
  sim.server({ type: 'response.function_call_arguments.done', response_id: 'r1', call_id: 'c1', name: 'read_page', arguments: '{}' });
  sim.server({ type: 'response.audio.delta', response_id: 'r1', delta: AUDIO });

  if (done) sim.server({ type: 'response.done', response: { id: 'r1', status: 'completed' } });
}

/** 任务完成通知交给连接，服务端确认收到这条通知。 */
function notifyAndAccept(sim: ReturnType<typeof setup>, text: string) {
  sim.connection.notifyTask(text);
  const item = sim.noticeItem(text);

  assert.ok(item, '任务通知没有发给语音服务');
  sim.server({ type: 'conversation.item.created', item });
}

test('生成已结束、声音还在播时停声：工具回来不续答，之后的任务通知照常念，通话不断', async t => {
  const sim = setup(t);

  askAndReply(sim, true);
  sim.connection.handle({ type: 'stop_speech' });
  const stopped = sim.providerCount();

  await sim.finishRead({ ok: true, title: '订单', text: '已付款' });
  assert.ok(!sim.sentSince(stopped).includes('response.create'), '被停的这一轮又请求了回答');

  t.mock.timers.tick(120_000);
  assert.deepEqual(sim.clientErrors(), [], '停声后通话被判死');

  const before = sim.providerCount();

  notifyAndAccept(sim, '机票已经订好');
  assert.deepEqual(sim.sentSince(before), ['item:message', 'response.create']);
});

test('回答还在生成时停声：它发起的工具回来后不续答', async t => {
  const sim = setup(t);

  askAndReply(sim, false);
  sim.connection.handle({ type: 'stop_speech' });
  sim.server({ type: 'response.done', response: { id: 'r1', status: 'cancelled' } });
  const stopped = sim.providerCount();

  await sim.finishRead({ ok: true, title: '订单', text: '已付款' });
  assert.deepEqual(sim.sentSince(stopped), ['item:function_call_output'], '被停的这一轮又请求了回答');

  const before = sim.providerCount();

  notifyAndAccept(sim, '机票已经订好');
  assert.deepEqual(sim.sentSince(before), ['item:message', 'response.create']);
});

test('已请求回答、还没开始时停声：迟到的那次被取消且不出声，之后的任务通知照常念', async t => {
  const sim = setup(t);

  sim.connection.handle({ type: 'text', text: '讲个笑话' });
  assert.deepEqual(sim.sentSince(0).slice(-2), ['item:message', 'response.create']);
  sim.connection.handle({ type: 'stop_speech' });
  const stopped = sim.providerCount();

  sim.server({ type: 'response.created', response: { id: 'r2' } });
  sim.server({ type: 'response.audio.delta', response_id: 'r2', delta: AUDIO });
  sim.server({ type: 'response.done', response: { id: 'r2', status: 'cancelled' } });
  assert.deepEqual(sim.sentSince(stopped), ['response.cancel']);
  assert.equal(sim.clientAudio('r2'), 0, '被拦的回答出声了');

  const before = sim.providerCount();

  notifyAndAccept(sim, '机票已经订好');
  assert.deepEqual(sim.sentSince(before), ['item:message', 'response.create']);
});
