/**
 * 建连阶段的供应商瞬时错误（试用问题 2 反例）：
 * - 未 ready 且尚无用户输入：静默、有界地重建握手，不向客户端抛致命错、不断会话；
 * - 重建预算耗尽后按原样 fatal 收场（面板恢复仍作兑底）；
 * - ready 后的普通报错维持既有提示路径，绝不重建连接。
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RealtimeVoiceConnection, MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(data: string): void { this.sent.push(String(data)); }
  close(): void { this.emit('close', 1000, Buffer.from('')); }
}

const deliver = (socket: FakeSocket, event: unknown): void => { void socket.emit('message', Buffer.from(JSON.stringify(event))); };

function harness() {
  const sockets: FakeSocket[] = [];

  const connect = vi.fn(() => { const socket = new FakeSocket(); sockets.push(socket);

 return socket as never; });

  const client: Array<Record<string, unknown>> = [];
  const logs: Array<Record<string, unknown>> = [];

  const connection = new RealtimeVoiceConnection({
    key: 'offline-key', voiceId: 'handshake', connect: connect as never,
    send: (event: Record<string, unknown>) => { client.push(event); },
    log: (event: Record<string, unknown>) => { logs.push(event); },
    tools: {
      browser_request: async () => ({ ok: false }),
      read_page: async () => ({ ok: false }),
      task_status: async () => ({ ok: true, tasks: [] }),
    },
  } as never);

  return { connection, sockets, connect, client, logs };
}

const cleanups: Array<() => void> = [];

afterEach(() => cleanups.splice(0).forEach(fn => fn()));

describe('建连阶段的瞬时供应商错误', () => {
  it('第一次报错静默重建握手：不发致命错、旧套接字被拆掉', () => {
    const h = harness();
    cleanups.push(() => h.connection.close());
    h.connection.start();
    deliver(h.sockets[0]!, { type: 'session.created', session: { model: MODEL } });
    deliver(h.sockets[0]!, { type: 'error', error: { message: 'server error' } });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.client.filter(event => event.type === 'error')).toHaveLength(0);
    expect(h.logs.some(log => log.type === 'handshake_retry')).toBe(true);
  });

  it('重建预算耗尽后按原样 fatal 收场', () => {
    const h = harness();
    cleanups.push(() => h.connection.close());
    h.connection.start();
    deliver(h.sockets[0]!, { type: 'error', error: { message: 'server error' } });
    deliver(h.sockets[1]!, { type: 'error', error: { message: 'server error' } });
    deliver(h.sockets[2]!, { type: 'error', error: { message: 'server error' } });
    expect(h.connect).toHaveBeenCalledTimes(3);
    expect(h.client.some(event => event.type === 'error' && String(event.message).includes('语音服务出错'))).toBe(true);
  });

  it('ready 后的普通报错维持既有提示路径，不重建连接', () => {
    const h = harness();
    cleanups.push(() => h.connection.close());
    h.connection.start();
    deliver(h.sockets[0]!, { type: 'session.created', session: { model: MODEL } });
    deliver(h.sockets[0]!, { type: 'session.updated', session: {
      model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16',
      turn_detection: { type: 'server_vad' },
    } });
    expect(h.logs.some(log => log.type === 'ready')).toBe(true);
    deliver(h.sockets[0]!, { type: 'error', error: { message: 'server error' } });
    expect(h.connect).toHaveBeenCalledTimes(1);
    expect(h.client.some(event => event.type === 'status' && String(event.text).includes('语音服务提示'))).toBe(true);
    expect(h.client.filter(event => event.type === 'error')).toHaveLength(0);
  });
});
