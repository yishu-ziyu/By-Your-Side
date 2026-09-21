// Compare session-only voice selection with explicit per-response selection.
// This script uses synthetic text, no browser, microphone or product playback.
import { WebSocket } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readStepVoiceKey } from '../../agent/src/voice-service.js';

const model = 'stepaudio-3-realtime-preview';
const voice = 'voice-tone-T3kZb9MwL2';
const sentence = '你好，我在这里，准备好了。';
const mode = process.argv[2];
if (mode !== 'baseline' && mode !== 'explicit') throw new Error('Use baseline or explicit');
const out = resolve(`out/acceptance/20260921-voice-per-response/${mode}-${Date.now()}`);
await mkdir(out, { recursive: true });

interface Recording { round: number; id: string; text: string; chunks: Buffer[]; status?: string }
const logs: Record<string, unknown>[] = [];
const recordings: Recording[] = [];
let current: Recording | undefined;
let ready = false;
let round = 0;
let completed = 0;
let fatal: string | undefined;
const ws = new WebSocket(`wss://api.stepfun.com/v1/realtime?model=${model}`, {
  headers: { Authorization: `Bearer ${await readStepVoiceKey()}` },
});
function send(event: Record<string, unknown>): void {
  logs.push({ direction: 'sent', at: Date.now(), ...event });
  ws.send(JSON.stringify(event));
}
ws.on('error', error => { fatal = error.message; });
ws.on('close', () => { if (completed < 4) fatal ??= 'Socket closed before four replies'; });
ws.on('message', raw => {
  try {
    const event = JSON.parse(String(raw));
    if (event.type !== 'response.audio.delta') logs.push({ direction: 'received', at: Date.now(), ...event });
    switch (event.type) {
      case 'session.created':
        if (event.session?.model !== model) throw new Error('Unexpected model');
        send({ type: 'session.update', session: {
          modalities: ['text', 'audio'], voice,
          input_audio_format: 'pcm16', output_audio_format: 'pcm16',
          turn_detection: null,
          instructions: '请只朗读用户指定的句子，保持配置的同一个说话人音色。', tools: [],
        } });
        break;
      case 'session.updated':
        if (event.session?.voice !== voice) throw new Error('Unexpected session voice');
        ready = true;
        break;
      case 'conversation.item.created':
        if (event.item?.role === 'user') {
          send(mode === 'explicit'
            ? { type: 'response.create', response: { voice, modalities: ['text', 'audio'] } }
            : { type: 'response.create' });
        }
        break;
      case 'response.created':
        if (current) throw new Error('Overlapping responses');
        current = { round, id: event.response.id, text: '', chunks: [] };
        break;
      case 'response.audio.delta':
        if (!current || event.response_id !== current.id) throw new Error('Audio response ID mismatch');
        current.chunks.push(Buffer.from(event.delta, 'base64'));
        break;
      case 'response.audio_transcript.delta':
        if (current) current.text += event.delta;
        break;
      case 'response.done':
        if (!current || event.response.id !== current.id) throw new Error('Completed response ID mismatch');
        current.status = event.response.status;
        recordings.push(current);
        current = undefined;
        completed = round;
        if (event.response.status !== 'completed') throw new Error(`Response ${event.response.status}`);
        break;
      case 'error': throw new Error(JSON.stringify(event.error));
    }
  } catch (error) { fatal = String(error); }
});
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 25000;
  while (!predicate()) {
    if (fatal) throw new Error(fatal);
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (fatal) throw new Error(fatal);
}
function wav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8); header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
let error: string | undefined;
try {
  await waitFor(() => ready);
  for (round = 1; round <= 4; round++) {
    send({ type: 'conversation.item.create', item: {
      type: 'message', role: 'user',
      content: [{ type: 'input_text', text: `请只说这句话：${sentence}` }],
    } });
    await waitFor(() => completed === round);
  }
} catch (cause) { error = String(cause); }
finally {
  ws.close();
  const responses = [];
  for (const recording of recordings) {
    const pcm = Buffer.concat(recording.chunks);
    const file = `reply-${recording.round}.wav`;
    await writeFile(join(out, file), wav(pcm));
    responses.push({ round: recording.round, id: recording.id, text: recording.text,
      status: recording.status, seconds: pcm.length / 48000, file });
  }
  // Transport completion is not a speaker-consistency verdict.
  const transportCompleted = !error && responses.length === 4 && responses.every(r => r.seconds > 0 && r.status === 'completed');
  const report = { out, mode, model, voice, sentence, transportCompleted, error,
    speakerConsistency: 'requires listening; pitch statistics are supplementary', responses, logs };
  await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, mode, transportCompleted, error, responses }, null, 2));
  if (!transportCompleted) process.exitCode = 1;
}
