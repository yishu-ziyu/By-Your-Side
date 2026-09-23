// 用户在设置页选的音色：随 start 命令进来，写进 session.update；服务端回显不一致就失败，不用错的音色说话。
import {describe, expect, it} from 'vitest';
import {EventEmitter} from 'node:events';
import {RealtimeVoiceConnection, MODEL, STEP_VOICE} from '../src/realtime-voice-connection.js';
import {DEFAULT_STEP_VOICE, isStepVoice, type TaskProgressSnapshot} from '../../shared/voice.js';
import {VoiceService} from '../src/voice-service.js';

interface SentEvent { type: string; session?: { voice?: string } }

interface ProviderEvent { type: string; session: { model: string; voice?: string; input_audio_format?: string; output_audio_format?: string; turn_detection?: { type: string } } }

class Socket extends EventEmitter {
  readyState = 1;
  sent: SentEvent[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  server(event: ProviderEvent) { this.emit('message', Buffer.from(JSON.stringify(event))); }
}

function open(voice?: string) {
  const socket = new Socket();
  const client: string[] = [];

  const connection = new RealtimeVoiceConnection({
    key: 'offline-placeholder', voice,
    // SAFETY: Socket 实现了连接用到的 ws 子集：readyState、send、close 与 message 事件。
    connect: () => socket as any,
    send: event => client.push(JSON.stringify(event)),
    tools: {browser_request: async () => ({ok: true}), task_status: async () => ({}), read_page: async () => ({})},
  });

  connection.start();
  socket.server({type: 'session.created', session: {model: MODEL}});
  const requestedVoice = socket.sent.find(e => e.type === 'session.update')?.session?.voice;
  const echo = (echoed: string) => socket.server({type: 'session.updated', session: {model: MODEL, voice: echoed, input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: {type: 'server_vad'}}});

  return {requestedVoice, echo, client};
}

describe('voice timbre', () => {
  it('requests the chosen voice and becomes ready when the provider confirms it', () => {
    const fx = open('jingdiannvsheng');
    expect(fx.requestedVoice).toBe('jingdiannvsheng');
    fx.echo('jingdiannvsheng');
    expect(fx.client.some(e => e.includes('"type":"ready"'))).toBe(true);
  });

  it('fails instead of speaking when the provider echoes a different voice', () => {
    const fx = open('jingdiannvsheng');
    fx.echo('qingchunshaonv');
    expect(fx.client.some(e => e.includes('"type":"ready"'))).toBe(false);
    expect(fx.client.join('\n')).toContain('音色未生效');
  });

  it('defaults to wenroushunv and rejects unknown ids', () => {
    expect(STEP_VOICE).toBe('wenroushunv');
    expect(open().requestedVoice).toBe(DEFAULT_STEP_VOICE);
    expect(isStepVoice('qingchunshaonv')).toBe(true);
    expect(isStepVoice('some-other-voice')).toBe(false);
    expect(isStepVoice(undefined)).toBe(false);
  });

  it('carries the voice from the start command into the session', async () => {
    const idleSnapshot: TaskProgressSnapshot = {conversationId: 'c1', observedAt: 0, state: 'idle', goal: null, startedAt: null, runId: null, active: [], lastAction: null, successVerified: false};
    const seen: Array<string | undefined> = [];

    const service = new VoiceService(() => idleSnapshot, () => {}, async () => 'key', deps => {
      seen.push(deps.voice);

      // SAFETY: 这条用例只看 createSession 收到的音色，服务只会调用这里列出的会话方法。
      return {start() {}, command() {}, close() {}, notify() {}, streamDelivery() {}, completeDelivery() {}} as never;
    });

    await service.handle('c1', {type: 'voice', voiceId: 'v1', command: {kind: 'start', voice: 'jingdiannvsheng'}});
    await service.handle('c1', {type: 'voice', voiceId: 'v2', command: {kind: 'start', voice: 'not-a-voice'}});
    expect(seen).toEqual(['jingdiannvsheng', DEFAULT_STEP_VOICE]);
  });
});
