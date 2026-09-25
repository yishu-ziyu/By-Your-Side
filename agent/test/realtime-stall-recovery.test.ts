/**
 * StepFun 会话整体挂住（2026-09-25 实测：开口后不再回任何事件，约 60 秒才断线）：
 * - 发出一段像样的人声后，服务端 12 秒既没给出「说完/附和/转写」也没有任何事件 → 可恢复错误并带 sayAgain，只报一次；
 * - 服务端慢但在 12 秒内给出「说完」、很短的人声（咳嗽）、用户一直在说 → 都不算挂住。
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeVoiceConnection, MODEL, STEP_VOICE } from '../src/realtime-voice-connection.js';

class FakeSocket extends EventEmitter {
  sent: string[] = [];
  send(data: string): void { this.sent.push(String(data)); }
  close(): void { this.emit('close', 1000, Buffer.from('')); }
}

/** 测试里用到的供应商事件字段。 */
type ProviderFrame = {
  type: string; item_id?: string; transcript?: string;
  session?: { model: string; voice?: string; input_audio_format?: string; output_audio_format?: string; turn_detection?: { type: string } };
};

/** 连接发给前端的帧里，本测试核对的字段。 */
type ClientFrame = { type?: string; recoverable?: boolean; sayAgain?: boolean };

const deliver = (socket: FakeSocket, event: ProviderFrame): void => { void socket.emit('message', Buffer.from(JSON.stringify(event))); };

/** 20 ms、24 kHz 的一帧 PCM16：人声用大振幅，静音为 0。 */
const frame = (loud: boolean): string => {
  const pcm = Buffer.alloc(960);

  if (loud) for (let i = 0; i < 480; i++) pcm.writeInt16LE(i % 2 ? 12000 : -12000, i * 2);

  return pcm.toString('base64');
};

function readyConnection() {
  const sockets: FakeSocket[] = [];
  const client: ClientFrame[] = [];

  // SAFETY: 连接只调用假套接字的 send/close/on；选项只填本测试路径用到的字段。
  const connection = new RealtimeVoiceConnection({
    key: 'offline-key', voiceId: 'stall',
    // SAFETY: 同上，FakeSocket 实现了连接用到的 WebSocket 方法。
    connect: (() => { const socket = new FakeSocket(); sockets.push(socket);

      return socket; }) as never,
    send: (event: ClientFrame) => { client.push(event); },
    log: () => {},
    tools: {
      browser_request: async () => ({ ok: false }),
      read_page: async () => ({ ok: false }),
      task_status: async () => ({ ok: true, tasks: [] }),
    },
  } as never);

  connection.start();
  deliver(sockets[0]!, { type: 'session.created', session: { model: MODEL } });
  deliver(sockets[0]!, { type: 'session.updated', session: {
    model: MODEL, voice: STEP_VOICE, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: { type: 'server_vad' },
  } });

  /** 按实时节奏送 ms 毫秒的音频。 */
  const speak = (ms: number, loud: boolean): void => {
    for (let t = 0; t < ms; t += 20) {
      connection.handle({ type: 'audio', data: frame(loud) });
      vi.advanceTimersByTime(20);
    }
  };

  const stalls = () => client.filter(event => event.type === 'error' && event.recoverable === true && event.sayAgain === true);

  return { connection, socket: sockets[0]!, client, speak, stalls };
}

beforeEach(() => { vi.useFakeTimers(); });

afterEach(() => { vi.useRealTimers(); });

describe('StepFun 会话挂住的快速发现', () => {
  it('说完一句后服务端一点反应都没有：12 秒后报可恢复错误并请用户重说，只报一次', () => {
    const h = readyConnection();
    h.speak(1500, true);
    h.speak(11_000, false);
    expect(h.stalls()).toHaveLength(0);
    h.speak(2000, false);
    expect(h.stalls()).toHaveLength(1);
    h.speak(15_000, false);
    expect(h.stalls()).toHaveLength(1);
    h.connection.close();
  });

  it('服务端只给了「开始说话」就不动了：从最后一个事件起 12 秒后报挂住', () => {
    const h = readyConnection();
    h.speak(1500, true);
    deliver(h.socket, { type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    h.speak(11_000, false);
    expect(h.stalls()).toHaveLength(0);
    h.speak(2000, false);
    expect(h.stalls()).toHaveLength(1);
    h.connection.close();
  });

  it('后半句只有「开始说话」、随后到的是前半句的转写，然后不动了：仍报挂住（实测 06-37 漏判）', () => {
    const h = readyConnection();
    h.speak(3500, true);
    deliver(h.socket, { type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    deliver(h.socket, { type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
    deliver(h.socket, { type: 'input_audio_buffer.speech_started', item_id: 'u2' });
    deliver(h.socket, { type: 'conversation.item.input_audio_transcription.completed', item_id: 'u1', transcript: '帮我把保存按钮圈出来。' });
    h.speak(13_000, false);
    expect(h.stalls()).toHaveLength(1);
    h.connection.close();
  });

  it('挂住时服务端还在不停发转写片段却不给「说完」：片段不算回应，仍报挂住（实测 07-00）', () => {
    const h = readyConnection();
    h.speak(3000, true);
    deliver(h.socket, { type: 'input_audio_buffer.speech_started', item_id: 'u2' });

    for (let i = 0; i < 30; i++) {
      deliver(h.socket, { type: 'conversation.item.input_audio_transcription.delta', item_id: 'u2' });
      h.speak(500, false);
    }

    expect(h.stalls()).toHaveLength(1);
    h.connection.close();
  });

  it('服务端慢但 10 秒后给出「说完」：不算挂住', () => {
    const h = readyConnection();
    h.speak(1500, true);
    h.speak(8000, false);
    deliver(h.socket, { type: 'input_audio_buffer.speech_started', item_id: 'u1' });
    h.speak(2000, false);
    deliver(h.socket, { type: 'input_audio_buffer.speech_stopped', item_id: 'u1' });
    h.speak(20_000, false);
    expect(h.stalls()).toHaveLength(0);
    h.connection.close();
  });

  it('一声咳嗽（0.3 秒）服务端没理：不算挂住', () => {
    const h = readyConnection();
    h.speak(300, true);
    h.speak(20_000, false);
    expect(h.stalls()).toHaveLength(0);
    h.connection.close();
  });

  it('用户一直在说，超过 12 秒还没说完：不算挂住', () => {
    const h = readyConnection();
    h.speak(20_000, true);
    expect(h.stalls()).toHaveLength(0);
    h.connection.close();
  });

  it('服务端把短句当附和清掉：不算挂住', () => {
    const h = readyConnection();
    h.speak(1000, true);
    deliver(h.socket, { type: 'input_audio_buffer.speech_backchannel' });
    h.speak(20_000, false);
    expect(h.stalls()).toHaveLength(0);
    h.connection.close();
  });
});
