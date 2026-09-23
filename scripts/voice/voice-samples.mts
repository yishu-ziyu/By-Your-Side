/**
 * 试听样本：对每个音色开一条真实的 Realtime 3 会话，确认 session.updated 回显的音色就是请求的音色，
 * 再让模型念同一句话，存成 WAV。用法：npx tsx scripts/voice/voice-samples.mts [输出目录] [音色...]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { MODEL } from '../../agent/src/realtime-voice-connection.js';
import { STEP_VOICES } from '../../shared/voice.js';

const LINE = '嗨，我在。你想看哪一页，我陪你一起看。';

const out = process.argv[2] ?? '/tmp/byside-voice-samples';

const voices = process.argv.length > 3 ? process.argv.slice(3) : STEP_VOICES.map(v => v.id);

const key = process.env.STEPFUN_API_KEY?.trim() || readFileSync(join(homedir(), '.sideagent', 'stepfun-api.key'), 'utf8').trim();

function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24); header.writeUInt32LE(48_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

interface ProviderEvent { type: string; delta?: string; session?: { voice?: string }; error?: { message?: string } }

function sample(voice: string): Promise<{ voice: string; echoed: string | null; seconds: number; file?: string; error?: string }> {
  return new Promise(resolve => {
    const socket = new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${MODEL}`, { headers: { Authorization: `Bearer ${key}` } });
    const chunks: Buffer[] = [];
    let echoed: string | null = null;

    const finish = (error?: string) => {
      clearTimeout(timer);
      socket.close();
      const pcm = Buffer.concat(chunks);
      const file = pcm.length ? join(out, `${voice}.wav`) : undefined;

      if (file) writeFileSync(file, wav(pcm));
      resolve({ voice, echoed, seconds: +(pcm.length / 48_000).toFixed(1), file, error });
    };

    const timer = setTimeout(() => finish('timeout'), 30_000);

    socket.on('message', raw => {
      const event: ProviderEvent = JSON.parse(String(raw));

      if (event.type === 'session.created') {
        socket.send(JSON.stringify({ type: 'session.update', session: { modalities: ['text', 'audio'], voice, instructions: '你是温柔的陪伴助手。只把用户给的句子原样念出来，不要加任何字。', input_audio_format: 'pcm16', output_audio_format: 'pcm16', turn_detection: null } }));
      } else if (event.type === 'session.updated') {
        echoed = event.session?.voice ?? null;
        socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `请原样念：${LINE}` }] } }));
        socket.send(JSON.stringify({ type: 'response.create' }));
      } else if (event.type === 'response.audio.delta' && event.delta !== undefined) {
        chunks.push(Buffer.from(event.delta, 'base64'));
      } else if (event.type === 'response.done') {
        finish();
      } else if (event.type === 'error') {
        finish(JSON.stringify(event.error ?? event));
      }
    });
    socket.on('error', e => finish(String(e)));
  });
}

mkdirSync(out, { recursive: true });

for (const voice of voices) console.log(JSON.stringify(await sample(voice)));
