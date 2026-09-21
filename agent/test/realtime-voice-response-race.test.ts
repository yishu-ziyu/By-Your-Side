// 复现 docs/evals/20260921-1441-log-review.md 第4节：server_vad 在 speech_stopped 后自动创建回复，
// 若客户端在 created 抵达前自己也发 response.create，会撞上 "ongoing response already exists"。
// Socket stub 与事件顺序抄自只读证据脚本 docs/evals/20260921-1441-log-review/replay.mts。
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection, MODEL, STEP_VOICE} from '../src/realtime-voice-connection.js';

class Socket extends EventEmitter {
  readyState = 1;
  sent: Array<Record<string, unknown>> = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

function createFixture() {
  const socket = new Socket();
  const client: Array<Record<string, unknown>> = [];
  const voiceLog: Array<Record<string, unknown>> = [];
  let resolveRead!: (value: unknown) => void;
  let browserRequestCalls = 0;
  const connection = new RealtimeVoiceConnection({
    key: 'offline-placeholder',
    connect: () => socket as any,
    send: event => client.push(event),
    log: event => voiceLog.push(event),
    tools: {
      browser_request: async () => { browserRequestCalls++; return {ok: true}; },
      task_status: async () => ({}),
      read_page: () => new Promise(resolve => { resolveRead = resolve; }),
    },
  });
  connection.start();
  socket.server({type: 'session.created', session: {model: MODEL}});
  socket.server({type: 'session.updated', session: {model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: {type: 'server_vad'}}});
  return {
    connection, socket, client, voiceLog,
    resolveRead: (value: unknown) => resolveRead(value),
    browserRequestCalls: () => browserRequestCalls,
  };
}

type Fixture = ReturnType<typeof createFixture>;
const sentToolOutputs = (socket: Socket) => socket.sent.filter(e => (e as any).item?.type === 'function_call_output').length;
const sentCreates = (socket: Socket) => socket.sent.filter(e => e.type === 'response.create').length;

/**
 * 重放事故的完整前半段：旧回合走完一次真实工具调用和 response.done，
 * 新回合开口又停止，工具结果在新回合停止说话前就已就绪——这正是与
 * 服务端自动回复相撞的临界点。事件顺序与 replay.mts 完全一致。
 */
async function driveToRace(fx: Fixture): Promise<void> {
  const {socket} = fx;
  socket.server({type: 'input_audio_buffer.speech_started', item_id: 'old'});
  socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'old'});
  socket.server({type: 'response.created', response: {id: 'old-response'}});
  socket.server({type: 'response.function_call_arguments.done', response_id: 'old-response', call_id: 'read', name: 'read_page', arguments: '{}'});
  socket.server({type: 'response.done', response: {id: 'old-response', status: 'completed'}});
  socket.server({type: 'input_audio_buffer.speech_started', item_id: 'new'});
  fx.resolveRead({ok: true, text: 'offline page'});
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  socket.server({type: 'conversation.item.input_audio_transcription.completed', item_id: 'old', transcript: '此前那一句'});
  socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'new'});
}

const live: RealtimeVoiceConnection[] = [];
afterEach(() => { live.splice(0).forEach(c => c.close()); vi.useRealTimers(); });

describe('voice response race: server_vad auto response pending gate', () => {
  it('never sends response.create while the auto response has not arrived, and forwards the retained late transcript without dispatching it', async () => {
    const fx = createFixture(); live.push(fx.connection);
    await driveToRace(fx);
    // 临界点：speech_stopped(new) 已到达，下一条 response.created 还没到——这里必须是 0 次，
    // 否则就是本次事故复现的竞争条件（agent.log 14:43:03.133~185）。
    expect(sentCreates(fx.socket)).toBe(0);
    expect(sentToolOutputs(fx.socket)).toBe(0); // 工具结果同样先扣住，等自动回复占用期结束
    expect(fx.client.some(e => e.type === 'transcript' && e.role === 'user' && e.itemId === 'old')).toBe(true);
    expect(fx.browserRequestCalls()).toBe(0); // 迟到转写不能被当成新请求派发
  });

  it('branch a: sends the withheld tool output once and exactly one response.create after the auto response finishes', async () => {
    const fx = createFixture(); live.push(fx.connection);
    await driveToRace(fx);
    fx.socket.server({type: 'response.created', response: {id: 'new-response'}});
    // 这条 created 是服务端自己在待启动期内发的，不是我们请求的——留痕区分两者，
    // 弥补本次事故日志从不记录 response.created、无法证明唯一根因的缺口。
    expect(fx.voiceLog).toContainEqual(expect.objectContaining({type: 'response_created', responseId: 'new-response', requested: false, autoPending: true}));
    expect(sentToolOutputs(fx.socket)).toBe(0); // 自动回复仍在生成，回传发生在 created 之后（本例即 done 之后）
    expect(sentCreates(fx.socket)).toBe(0);
    fx.socket.server({type: 'response.done', response: {id: 'new-response', status: 'completed'}});
    expect(sentToolOutputs(fx.socket)).toBe(1); // 恰好一次，覆盖自动回复结束后才回传
    expect(sentCreates(fx.socket)).toBe(1); // 恰好一次，紧跟在工具结果之后续答
  });

  it('branch b: falls back to response.create after the bounded timeout when no auto response ever arrives, without starving the tool result', async () => {
    vi.useFakeTimers();
    const fx = createFixture(); live.push(fx.connection);
    await driveToRace(fx);
    expect(sentCreates(fx.socket)).toBe(0);
    await vi.advanceTimersByTimeAsync(2500); // > AUTO_RESPONSE_WATCHDOG_MS(2000ms)，服务端始终没有 created
    expect(sentToolOutputs(fx.socket)).toBe(1);
    expect(sentCreates(fx.socket)).toBe(1);
    // create-watch（等我们自己那次 response.create 的 created 确认，12s）不该和已经清空的
    // auto-response-watchdog 互相误触，也不该在超时后重复补发第二次 response.create。
    await vi.advanceTimersByTimeAsync(12_000);
    expect(sentCreates(fx.socket)).toBe(1);
  });

  it('stop_speech during the pending window cancels the late-arriving auto response and never races it with our own create', () => {
    const fx = createFixture(); live.push(fx.connection);
    fx.socket.server({type: 'input_audio_buffer.speech_started', item_id: 'a'});
    fx.socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'a'}); // 置位 autoResponsePending，created 还没到
    fx.connection.handle({type: 'stop_speech'});
    expect(fx.socket.sent.some(e => e.type === 'response.cancel')).toBe(false); // 还没有 responseId 可取消，只能记账等
    fx.socket.server({type: 'response.created', response: {id: 'late-auto'}}); // 服务端自己的自动回复迟到才到
    expect(fx.socket.sent.some(e => e.type === 'response.cancel')).toBe(true); // 现有 pendingStop 逻辑：立即取消
    fx.socket.server({type: 'response.done', response: {id: 'late-auto', status: 'cancelled'}});
    expect(sentCreates(fx.socket)).toBe(0); // 全程没有我们自己抢发过 response.create
  });

  it('a background notice queued during the pending window waits for the auto response to resolve before being sent', () => {
    const fx = createFixture(); live.push(fx.connection);
    fx.socket.server({type: 'input_audio_buffer.speech_started', item_id: 'a'});
    fx.socket.server({type: 'input_audio_buffer.speech_stopped', item_id: 'a'});
    fx.connection.notifyTask('后台任务已完成', 'delivery1');
    expect(fx.socket.sent.some(e => (e as any).item?.id?.startsWith('bys-notice-'))).toBe(false); // 自动回复待启动，通知先扣住
    fx.socket.server({type: 'response.created', response: {id: 'auto-a'}});
    fx.socket.server({type: 'response.done', response: {id: 'auto-a', status: 'completed'}}); // 自动回复自己讲完了别的内容
    const notice = fx.socket.sent.find(e => (e as any).item?.id?.startsWith('bys-notice-'));
    expect(notice).toBeTruthy(); // 到这时才补发通知，不再和自动回复竞争
  });
});
