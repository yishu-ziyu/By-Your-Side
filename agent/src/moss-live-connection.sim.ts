/**
 * MOSS-Live 连接的假时钟模拟测试：
 * 模拟播放器实际报告播放完成或停下的时间，不用墙上时钟推断播放进度。
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MossLiveConnection } from './moss-live-connection.js';

type Event = Record<string, unknown>;

function makePcm48k(durationMs: number): Uint8Array {
  return new Uint8Array(durationMs * 96); // 48 kHz * 2 bytes/sample = 96 bytes/ms
}

type RouteResult = { native: boolean; spokenText?: string };

function setup(t: TestContext, routeResult: RouteResult | { route: () => Promise<RouteResult> } = { native: true }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  const providerJson: Event[] = [];
  const providerBinary: Uint8Array[] = [];
  const client: Event[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();

  const socket = {
    readyState: 1,
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
    send(data: string | Uint8Array) {
      if (typeof data === 'string') providerJson.push(JSON.parse(data));
      else providerBinary.push(data);
    },
    close() {},
  };

  const connection = new MossLiveConnection({
    key: 'sim-key',
    connect: () => socket as never,
    captureScreen: async () => new Uint8Array([0xff, 0xd8, 0xff, 0xd9]),
    send: event => client.push(event),
    routeTranscript: 'route' in routeResult ? routeResult.route : async () => routeResult,
  });

  const serverJson = (event: Event) => listeners.get('message')!(JSON.stringify(event), false);
  const serverBinary = (bytes: Uint8Array) => listeners.get('message')!(bytes, true);

  connection.start();
  serverJson({ action: 'session_attached', data: { session_id: 'sess-1', delegation: 'client' } });
  serverJson({ action: 'session.updated', data: { error: '' } });

  return {
    connection,
    providerJson,
    providerBinary,
    client,
    serverJson,
    serverBinary,
  };
}

test('任务事实逐次确认，开口后冻结到这一轮结束', async t => {
  const sim = setup(t);
  const updates = () => sim.providerJson.filter(event => event.action === 'session.update');

  sim.connection.setTaskContext('第一家已读');
  assert.equal(updates().length, 2);
  assert.equal(sim.connection.taskContextSynchronized(), false);
  sim.connection.setTaskContext('第二家已读');
  assert.equal(updates().length, 2);
  sim.serverJson({ action: 'session.updated', data: { error: '' } });
  assert.equal(updates().length, 3);
  assert.equal(sim.connection.taskContextSynchronized(), false);
  sim.serverJson({ action: 'session.updated', data: { error: '' } });
  assert.equal(sim.connection.taskContextSynchronized(), true);

  const pcm = Buffer.alloc(960);
  for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(1000, at);
  sim.connection.handle({ type: 'audio', data: pcm.toString('base64') });
  sim.connection.setTaskContext('第三家已读');
  assert.equal(updates().length, 3);
  sim.serverJson({ action: 'input.speech.started', data: {} });
  assert.equal(sim.client.find(event => event.type === 'input_start')?.taskContextSynchronized, true);
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '做到哪一步了', turn: 'turn-1' } });
  await new Promise(resolve => setImmediate(resolve));
  sim.serverJson({ action: 'response.ended', data: { run_id: 'r1', turn_id: 'turn-1' } });
  assert.equal(updates().length, 4);
  assert.equal(sim.connection.taskContextSynchronized(), false);
  sim.serverJson({ action: 'session.updated', data: { error: '' } });
  assert.equal(sim.connection.taskContextSynchronized(), true);
  sim.connection.close();
});

test('同步被拒绝不能当作成功，重试前继续保持未确认', t => {
  const sim = setup(t);
  const updates = () => sim.providerJson.filter(event => event.action === 'session.update');
  sim.connection.setTaskContext('已读事实');
  sim.serverJson({ action: 'session.updated', data: { error: 'rejected' } });
  assert.equal(sim.connection.taskContextSynchronized(), false);
  sim.connection.setTaskContext('已读事实');
  assert.equal(updates().length, 3);
  assert.equal(sim.connection.taskContextSynchronized(), false);
  sim.serverJson({ action: 'session.updated', data: { error: '' } });
  assert.equal(sim.connection.taskContextSynchronized(), true);
  sim.connection.close();
});

test('短噪声没有触发服务端断句时，稍后恢复任务事实同步', t => {
  const sim = setup(t);
  const updates = () => sim.providerJson.filter(event => event.action === 'session.update');
  sim.connection.setTaskContext('已读一页');
  sim.serverJson({ action: 'session.updated', data: { error: '' } });
  const pcm = Buffer.alloc(960);
  for (let at = 0; at < pcm.length; at += 2) pcm.writeInt16LE(1000, at);
  sim.connection.handle({ type: 'audio', data: pcm.toString('base64') });
  sim.connection.setTaskContext('已读两页');
  assert.equal(updates().length, 2);
  t.mock.timers.tick(2000);
  assert.equal(updates().length, 3);
  sim.connection.close();
});

test('当前轮无声失败在分流后提示，旧轮迟到失败不覆盖新轮', async t => {
  const sim = setup(t, { native: true });
  const warnings = () => sim.client.filter(event => event.type === 'status' && String(event.text).includes('语音服务没有答上'));
  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '讲个故事', turn: 'turn-1' } });
  sim.serverJson({ action: 'response.ended', data: { run_id: 'failed-1', turn_id: 'turn-1', status: 'failed' } });
  assert.equal(warnings().length, 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings().length, 1);

  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '另一句', turn: 'turn-2' } });
  sim.serverJson({ action: 'response.ended', data: { run_id: 'failed-1', turn_id: 'turn-1', status: 'failed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(warnings().length, 1);
  sim.connection.close();
});

test('播放器报告块播放完成后才通知服务端，时钟前进不能代替播放', async t => {
  const sim = setup(t, { native: true });

  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '画面里有什么？', turn: 'turn-1' } });
  await new Promise(resolve => setImmediate(resolve));

  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c1', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(500));
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c2', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(500));
  sim.serverJson({ action: 'response.audio.done', data: { run_id: 'r1', turn_id: 'turn-1' } });

  t.mock.timers.tick(2000);
  assert.equal(sim.providerJson.filter(e => e.action === 'playback.chunk.completed').length, 0);

  sim.connection.handle({ type: 'moss_chunk_played', runId: 'r1', turnId: 'turn-1', chunkId: 'c1' });
  assert.deepEqual(
    sim.providerJson.filter(e => e.action === 'playback.chunk.completed').map(e => e.chunk_id),
    ['c1'],
  );
  assert.equal(sim.providerJson.filter(e => e.action === 'playback.completed').length, 0);

  sim.connection.handle({ type: 'moss_chunk_played', runId: 'r1', turnId: 'turn-1', chunkId: 'c2' });
  assert.deepEqual(
    sim.providerJson.filter(e => e.action === 'playback.chunk.completed').map(e => e.chunk_id),
    ['c1', 'c2'],
  );
  assert.deepEqual(
    sim.providerJson.filter(e => e.action === 'playback.completed'),
    [{ action: 'playback.completed', run_id: 'r1', turn_id: 'turn-1' }],
  );

  sim.connection.close();
});

test('播放中途收到 response.audio.stop (barge-in) 时取消未播完块并回传 played_audio_ms 与 reason', async t => {
  const sim = setup(t, { native: true });

  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '详细介绍一下', turn: 'turn-1' } });
  await new Promise(resolve => setImmediate(resolve));

  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c1', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(1000));
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c2', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(1000));

  t.mock.timers.tick(350);
  sim.serverJson({ action: 'response.audio.stop', data: { run_id: 'r1', turn_id: 'turn-1', reason: 'barge-in' } });
  assert.equal(sim.providerJson.filter(e => e.action === 'playback.stopped').length, 0);
  sim.connection.handle({ type: 'moss_playback_stopped', runId: 'r1', turnId: 'turn-1', playedMs: 350 });

  const stopped = sim.providerJson.find(e => e.action === 'playback.stopped');
  assert.deepEqual(stopped, {
    action: 'playback.stopped',
    run_id: 'r1',
    turn_id: 'turn-1',
    reason: 'barge-in',
    played_audio_ms: 350,
  });

  t.mock.timers.tick(3000);
  assert.equal(sim.providerJson.filter(e => e.action === 'playback.chunk.completed').length, 0);
  assert.equal(sim.providerJson.filter(e => e.action === 'playback.completed').length, 0);

  sim.connection.close();
});

test('MOSS 无声失败但这句判为任务时，不提示语音服务没答上', async t => {
  const sim = setup(t, { native: false });
  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '帮我把保存按钮圈出来', turn: 'turn-1' } });
  sim.serverJson({ action: 'response.ended', data: { run_id: 'failed-1', turn_id: 'turn-1', status: 'failed' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sim.client.filter(event => event.type === 'status' && String(event.text).includes('语音服务没有答上')).length, 0);
  sim.connection.close();
});

test('已停播那一轮之后到达的字幕不显示', async t => {
  const sim = setup(t);
  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '讲个故事', turn: 'turn-1' } });
  await new Promise(resolve => setImmediate(resolve));
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c1', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(1000));

  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'response.audio.stop', data: { run_id: 'r1', turn_id: 'turn-1', reason: 'barge-in' } });
  sim.serverJson({ action: 'output.transcript.updated', data: { run_id: 'r1', turn_id: 'turn-1', text: '上一轮的故事' } });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '页面写了什么', turn: 'turn-2' } });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sim.client.filter(e => e.type === 'transcript' && e.role === 'assistant' && e.responseId === 'r1').length, 0);
  sim.connection.close();
});

test('附和没有停播时仍显示原回答字幕', async t => {
  const sim = setup(t);
  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '讲个故事', turn: 'turn-1' } });
  await new Promise(resolve => setImmediate(resolve));
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c1', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(1000));
  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'output.transcript.updated', data: { run_id: 'r1', turn_id: 'turn-1', text: '继续讲故事' } });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '嗯', turn: 'turn-2' } });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(sim.client.filter(e => e.type === 'transcript' && e.role === 'assistant' && e.responseId === 'r1').length, 1);
  sim.connection.close();
});

test('MOSS 不等分流先出声；判为非原生回答后停播并丢弃后续语音和字幕', async t => {
  let decide!: (result: { native: boolean }) => void;
  const sim = setup(t, { route: () => new Promise(resolve => { decide = resolve; }) });

  sim.serverJson({ action: 'input.speech.started', data: {} });
  sim.serverJson({ action: 'input.speech.stopped', data: {} });
  sim.serverJson({ action: 'input.transcript.done', data: { text: '帮我把保存按钮圈出来', turn: 'turn-1' } });
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c1', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(600));
  sim.serverJson({ action: 'output.transcript.updated', data: { run_id: 'r1', turn_id: 'turn-1', text: '好的' } });
  const audioBefore = sim.client.filter(e => e.type === 'audio' && e.responseId === 'r1').length;
  assert.ok(audioBefore > 0);
  assert.equal(sim.client.filter(e => e.type === 'transcript' && e.role === 'assistant' && e.responseId === 'r1').length, 1);

  decide({ native: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(sim.client.some(e => e.type === 'moss_stop_audio' && e.runId === 'r1'));
  sim.serverJson({ action: 'response.audio.context', data: { chunk_id: 'c2', run_id: 'r1', turn_id: 'turn-1' } });
  sim.serverBinary(makePcm48k(600));
  sim.serverJson({ action: 'output.transcript.done', data: { run_id: 'r1', turn_id: 'turn-1', text: '好的，我来点保存' } });
  assert.equal(sim.client.filter(e => e.type === 'audio' && e.responseId === 'r1').length, audioBefore);
  assert.equal(sim.client.filter(e => e.type === 'transcript' && e.role === 'assistant' && e.responseId === 'r1').length, 1);

  sim.connection.close();
});
