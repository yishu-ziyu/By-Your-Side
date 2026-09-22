// 回归：docs/evals/20260921-voice-root-cause-audit.md C1/C2 与本票 R1/R2。
// R1：无 deliveryId 的普通通知在 response.created 被重新入队，同一条通知在没有新通知的情况下反复播报。
// R2：第一条通知等待回复创建期间，后一条通知抢占发送并覆盖 creatingNotice，回复只绑定最后一条。
// Socket stub 与事件重放方式同 realtime-voice-response-race.test.ts；只从公开入口
// （notifyTask / socket.server / connection.handle）输入，断言 wire 消息与客户端回调，不碰私有变量。
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection, MODEL, STEP_VOICE} from '../src/realtime-voice-connection.js';
import {RealtimeVoiceSession} from '../src/realtime-voice-session.js';
import type {TaskProgressSnapshot, VoiceEvent} from '../../shared/voice.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

/** deferReady=true 用于复现“ready 前排队”的批次场景。 */
function createFixture(deferReady = false) {
  const socket = new Socket();
  const client: Array<Record<string, unknown>> = [];
  const voiceLog: Array<Record<string, unknown>> = [];
  const connection = new RealtimeVoiceConnection({
    key: 'offline-placeholder',
    connect: () => socket as any,
    send: event => client.push(event),
    log: event => voiceLog.push(event),
    tools: {
      browser_request: async () => ({ok: true}),
      task_status: async () => ({}),
      read_page: async () => ({}),
    },
  });
  connection.start();
  const ready = () => {
    socket.server({type: 'session.created', session: {model: MODEL}});
    socket.server({type: 'session.updated', session: {model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: {type: 'server_vad'}}});
  };
  if (!deferReady) ready();
  return {connection, socket, client, voiceLog, ready};
}

const noticeItems = (socket: Socket): any[] => socket.sent.filter(e => String((e as any).item?.id ?? '').startsWith('bys-notice-'));
const sessionNotice = (socket: Socket) => (socket.sent as any[]).find(x => String(x.item?.id ?? '').startsWith('bys-notice-'));
const creates = (socket: Socket) => socket.sent.filter(e => e.type === 'response.create');
const deliveryBindings = (client: Array<Record<string, unknown>>) => client.filter(e => e.type === 'delivery_response');
const ackNotice = (socket: Socket, index: number, eventId?: string) => {
  const item = noticeItems(socket)[index]?.item;
  if (!item) throw new Error(`notice ${index} not sent yet`);
  socket.server({type: 'conversation.item.created', ...(eventId ? {event_id: eventId} : {}), item});
};
const finishResponse = (socket: Socket, id: string, audio: boolean, eventId?: string) => {
  socket.server({type: 'response.created', ...(eventId ? {event_id: `${eventId}-created`} : {}), response: {id}});
  if (audio) socket.server({type: 'response.audio.delta', response_id: id, delta: Buffer.alloc(960).toString('base64')});
  socket.server({type: 'response.done', ...(eventId ? {event_id: `${eventId}-done`} : {}), response: {id, status: 'completed'}});
};

function createSessionFixture() {
  const socket = new Socket();
  const events: VoiceEvent[] = [];
  const snapshot: TaskProgressSnapshot = {conversationId: 'A', runId: null, state: 'none', goal: null, startedAt: null, observedAt: 1, active: [], lastAction: null, successVerified: false};
  const onPlayback = vi.fn();
  const session = new RealtimeVoiceSession({voiceId: 'voice3', getSnapshot: () => snapshot, emit: e => events.push(e), onPlayback, connect: () => socket as any});
  session.start('offline-placeholder');
  const ready = () => {
    socket.server({type: 'session.created', session: {model: MODEL}});
    socket.server({type: 'session.updated', session: {model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: {type: 'server_vad'}}});
  };
  return {session, socket, events, onPlayback, ready, snapshot};
}

const live: Array<{close: () => void}> = [];
afterEach(() => { live.splice(0).forEach(c => c.close()); vi.useRealTimers(); });

describe('A1 普通通知只消费一次（不依赖可选 deliveryId）', () => {
  it.each([{audio: true}, {audio: false}])('audio=$audio: 确认→创建→生成结束→播放回执后，虚拟时钟推进 30 秒计数不变', async ({audio}) => {
    vi.useFakeTimers();
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask('当前任务状态：idle'); // 无 deliveryId 的普通状态通知
    expect(noticeItems(fx.socket)).toHaveLength(1);
    ackNotice(fx.socket, 0);
    expect(creates(fx.socket)).toHaveLength(1); // 确认后先为这条通知请求回复，而不是重发通知
    finishResponse(fx.socket, 'one', audio);
    fx.connection.handle({type: 'playback_done', responseId: 'one'});
    await vi.advanceTimersByTimeAsync(30_000);
    expect(noticeItems(fx.socket)).toHaveLength(1); // R1 修前：response.created 后重新入队，done 时第二次发送
    expect(creates(fx.socket)).toHaveLength(1);
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });
});

describe('A2 批量通知按入队顺序处理，不覆盖前一条的回复关联', () => {
  it('ready 前排入 A、B：A 确认后先为 A 发 response.create；A 生成并播完后才轮到 B；各自绑定自己的 responseId', async () => {
    vi.useFakeTimers();
    const fx = createFixture(true); live.push(fx.connection);
    fx.connection.notifyTask('A 的结果', 'delivery-a');
    fx.connection.notifyTask('B 的结果', 'delivery-b');
    fx.ready();
    expect(noticeItems(fx.socket)).toHaveLength(1); // 只有 A 上路
    ackNotice(fx.socket, 0);
    expect(creates(fx.socket)).toHaveLength(1); // R2 修前：这里先发送 B 而不是为 A 请求回复
    expect(noticeItems(fx.socket)).toHaveLength(1);
    fx.socket.server({type: 'response.created', response: {id: 'resp-a'}});
    expect(deliveryBindings(fx.client)).toEqual([{type: 'delivery_response', deliveryId: 'delivery-a', responseId: 'resp-a'}]);
    fx.socket.server({type: 'response.audio.delta', response_id: 'resp-a', delta: Buffer.alloc(960).toString('base64')});
    fx.socket.server({type: 'response.done', response: {id: 'resp-a', status: 'completed'}});
    expect(noticeItems(fx.socket)).toHaveLength(1); // A 的音频还没播完，B 不能开始
    fx.connection.handle({type: 'playback_done', responseId: 'resp-a'});
    expect(noticeItems(fx.socket)).toHaveLength(2); // A 播完才轮到 B
    ackNotice(fx.socket, 1);
    expect(creates(fx.socket)).toHaveLength(2);
    fx.socket.server({type: 'response.created', response: {id: 'resp-b'}});
    expect(deliveryBindings(fx.client)).toContainEqual({type: 'delivery_response', deliveryId: 'delivery-b', responseId: 'resp-b'});
    fx.socket.server({type: 'response.done', response: {id: 'resp-b', status: 'completed'}});
    expect(noticeItems(fx.socket)).toHaveLength(2);
    expect(creates(fx.socket)).toHaveLength(2);
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });

  it.each([
    {label: '先普通后正式', first: {text: '普通状态通知'}, second: {text: '正式结果', id: 'delivery-b'}},
    {label: '先正式后普通', first: {text: '正式结果', id: 'delivery-a'}, second: {text: '普通状态通知'}},
  ])('混排（$label）：逐条完成，普通通知有完整消费，正式通知各自绑定', ({first, second}) => {
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask(first.text, first.id);
    fx.connection.notifyTask(second.text, second.id);
    expect(noticeItems(fx.socket)).toHaveLength(1);
    expect(noticeItems(fx.socket)[0].item.content[0].text).toContain(first.text);
    ackNotice(fx.socket, 0);
    expect(creates(fx.socket)).toHaveLength(1); // 第一条确认后先请求自己的回复
    expect(noticeItems(fx.socket)).toHaveLength(1);
    finishResponse(fx.socket, 'first-response', false); // 第一条（无音频）完成
    expect(noticeItems(fx.socket)).toHaveLength(2); // 第二条才上路
    expect(noticeItems(fx.socket)[1].item.content[0].text).toContain(second.text);
    ackNotice(fx.socket, 1);
    expect(creates(fx.socket)).toHaveLength(2);
    finishResponse(fx.socket, 'second-response', false);
    const bindings = deliveryBindings(fx.client);
    expect(bindings).toHaveLength(second.id ? 1 : 1); // 只有正式通知产生绑定；数量恒为 1
    if (second.id) expect(bindings[0]).toMatchObject({deliveryId: 'delivery-b', responseId: 'second-response'});
    else expect(bindings[0]).toMatchObject({deliveryId: 'delivery-a', responseId: 'first-response'});
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });

  it('第一条的 response.create 迟迟没有 created：重试请求而不是发送下一条', async () => {
    vi.useFakeTimers();
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask('A 的结果', 'delivery-a');
    fx.connection.notifyTask('B 的结果', 'delivery-b');
    ackNotice(fx.socket, 0);
    expect(creates(fx.socket)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(12_500); // 超过 create-watch 12s，服务端始终没回 created
    expect(creates(fx.socket)).toHaveLength(2); // 为 A 重试
    expect(noticeItems(fx.socket)).toHaveLength(1); // B 仍然不能抢占
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });
});

describe('A3 正式交付不假报已播放', () => {
  it('仅通知确认与 response.done 不标记 played；有音频且收到对应 playback_done 才标记', () => {
    const f = createSessionFixture(); live.push(f.session);
    f.ready();
    f.snapshot.runId = 'run1';
    f.session.completeDelivery({id: 'delivery1', runId: 'run1', kind: 'finding', text: '实际结果'});
    const notice = sessionNotice(f.socket);
    expect(notice).toBeTruthy();
    f.socket.server({type: 'conversation.item.created', item: notice.item});
    f.socket.server({type: 'response.created', response: {id: 'notice-response'}});
    f.socket.server({type: 'response.audio.delta', response_id: 'notice-response', delta: Buffer.alloc(960).toString('base64')});
    f.socket.server({type: 'response.done', response: {id: 'notice-response', status: 'completed'}});
    expect(f.onPlayback).not.toHaveBeenCalledWith('delivery1', 'played'); // done ≠ 实际播完
    f.session.command({kind: 'playback_done', responseId: 'notice-response'});
    expect(f.onPlayback).toHaveBeenCalledWith('delivery1', 'played');
  });

  it('无音频回复：即使收到 playback_done 也不得伪造 played', () => {
    const f = createSessionFixture(); live.push(f.session);
    f.ready();
    f.snapshot.runId = 'run1';
    f.session.completeDelivery({id: 'delivery2', runId: 'run1', kind: 'finding', text: '实际结果'});
    const notice = sessionNotice(f.socket);
    f.socket.server({type: 'conversation.item.created', item: notice.item});
    finishResponse(f.socket, 'silent-response', false);
    f.session.command({kind: 'playback_done', responseId: 'silent-response'});
    expect(f.onPlayback).not.toHaveBeenCalledWith('delivery2', 'played');
  });

  it('通知确认超时：可见失败，不标记 played', async () => {
    vi.useFakeTimers();
    const f = createSessionFixture(); live.push(f.session);
    f.ready();
    f.snapshot.runId = 'run1';
    f.session.completeDelivery({id: 'delivery3', runId: 'run1', kind: 'finding', text: '实际结果'});
    expect(sessionNotice(f.socket)).toBeTruthy();
    await vi.advanceTimersByTimeAsync(5_100); // 超过 notice-ack 5s，服务端没有确认
    expect(f.events.some(e => e.kind === 'state' && e.state === 'error')).toBe(true);
    expect(f.onPlayback).not.toHaveBeenCalled();
  });
});

describe('A4 重复事件与相同文本不是一回事', () => {
  it('同一 provider event_id 的确认/结束事件重放，不新增通知发送、回复创建或交付回调', () => {
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask('正式结果', 'delivery-1');
    ackNotice(fx.socket, 0, 'echo-1');
    finishResponse(fx.socket, 'r1', false, 'r1');
    // 重放同一 event_id 的确认与结束事件
    fx.socket.server({type: 'conversation.item.created', event_id: 'echo-1', item: noticeItems(fx.socket)[0]!.item});
    fx.socket.server({type: 'response.done', event_id: 'r1-done', response: {id: 'r1', status: 'completed'}});
    fx.socket.server({type: 'response.created', event_id: 'r1-created', response: {id: 'r1'}});
    expect(noticeItems(fx.socket)).toHaveLength(1);
    expect(creates(fx.socket)).toHaveLength(1);
    expect(deliveryBindings(fx.client)).toHaveLength(1);
  });

  it('两次独立入队的相同文本各处理一次，不被文本去重误删', () => {
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask('任务已完成'); // 第一次独立入队
    ackNotice(fx.socket, 0);
    finishResponse(fx.socket, 'r1', false);
    fx.connection.notifyTask('任务已完成'); // 第二次独立入队，文字相同
    expect(noticeItems(fx.socket)).toHaveLength(2); // 不被文本去重
    ackNotice(fx.socket, 1);
    finishResponse(fx.socket, 'r2', false);
    expect(noticeItems(fx.socket)).toHaveLength(2);
    expect(creates(fx.socket)).toHaveLength(2);
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });
});

describe('A5 失效通知不堵队列', () => {
  it('发送前 valid 变 false：失效通知不上 wire、不触发播报请求；后续有效通知照常处理', () => {
    const fx = createFixture(); live.push(fx.connection);
    fx.connection.notifyTask('过期通知', 'delivery-a', () => false); // 入队时已失效
    fx.connection.notifyTask('有效通知', 'delivery-b', () => true);
    const items = noticeItems(fx.socket);
    expect(items).toHaveLength(1); // 失效通知被丢弃，只有有效通知上路
    expect(items[0].item.content[0].text).toContain('有效通知');
    ackNotice(fx.socket, 0);
    finishResponse(fx.socket, 'r-b', false);
    expect(creates(fx.socket)).toHaveLength(1);
    expect(deliveryBindings(fx.client).some(e => e.deliveryId === 'delivery-a')).toBe(false);
    expect(deliveryBindings(fx.client).some(e => e.deliveryId === 'delivery-b' && e.responseId === 'r-b')).toBe(true);
  });

  it('等待通知确认期间 valid 变 false：该通知不请求播报、不被标记 played；后续通知继续', () => {
    const fx = createFixture(); live.push(fx.connection);
    let aValid = true;
    fx.connection.notifyTask('通知A', 'delivery-a', () => aValid);
    fx.connection.notifyTask('通知B', 'delivery-b', () => true);
    expect(noticeItems(fx.socket)).toHaveLength(1); // A 在路上，B 排队
    aValid = false; // A 等待确认期间失效
    ackNotice(fx.socket, 0);
    expect(creates(fx.socket)).toHaveLength(0); // 不为失效的 A 请求回复
    expect(noticeItems(fx.socket)).toHaveLength(2); // B 继续处理，队列不堵
    ackNotice(fx.socket, 1);
    finishResponse(fx.socket, 'r-b', false);
    expect(creates(fx.socket)).toHaveLength(1);
    expect(deliveryBindings(fx.client).some(e => e.deliveryId === 'delivery-a')).toBe(false);
    expect(deliveryBindings(fx.client).some(e => e.deliveryId === 'delivery-b' && e.responseId === 'r-b')).toBe(true);
    expect(fx.client.some(e => e.type === 'error')).toBe(false);
  });
});
