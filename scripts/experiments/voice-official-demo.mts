// Runs the upstream Console client unchanged; only supplies an authenticated
// browser-compatible WebSocket transport instead of its UI/Bun relay.
import { WebSocket } from 'ws';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readStepVoiceKey } from '../../agent/src/voice-service.js';

const mode = process.argv[2];
if (mode !== 'clone' && mode !== 'builtin') throw Error('Use clone or builtin');
const checkout = process.argv[3] ?? '/tmp/stepfun-doc-comparison/console';
const { RealtimeClient } = await import(pathToFileURL(resolve(checkout, 'src/lib/openai-realtime-api-beta/index.js')).href);
const model = 'stepaudio-3-realtime-preview';
const voice = mode === 'clone' ? 'voice-tone-T3kZb9MwL2' : 'qingchunshaonv';
const apiKey = await readStepVoiceKey();
// Upstream Node transport hardcodes an OpenAI URL. Use its browser branch,
// with the same URL/header authentication as the official Bun relay.
Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: class extends WebSocket {
  constructor(url: string) { super(url, { headers: { Authorization: `Bearer ${apiKey}` } }); }
} });
const client = new RealtimeClient({ url: `wss://api.stepfun.com/v1/realtime?model=${model}`, voice,
  instructions: '请只朗读用户指定的句子，保持配置的同一个说话人音色。' });
const out = resolve(`out/acceptance/20260921-official-demo/${mode}-${Date.now()}`);
await mkdir(out, { recursive: true });
const events: unknown[] = [];
const replies: { id: string; chunks: Buffer[]; text: string; status?: string }[] = [];
let configured = false;
let failure: string | undefined;
client.on('realtime.event', ({ source, event }: any) => {
  if (event.type !== 'response.audio.delta') events.push({ source, at: Date.now(), event });
  if (event.type === 'error') failure = JSON.stringify(event.error);
  if (event.type === 'session.updated') {
    configured = event.session?.voice === voice;
    if (!configured) failure = 'Session voice mismatch';
  }
  if (event.type === 'session.created' && event.session?.model !== model) failure = 'Model mismatch';
  if (event.type === 'response.created') replies.push({ id: event.response.id, chunks: [], text: '' });
  const reply = replies.find(r => r.id === (event.response_id ?? event.response?.id));
  if (event.type === 'response.audio.delta' && reply) reply.chunks.push(Buffer.from(event.delta, 'base64'));
  if (event.type === 'response.audio_transcript.delta' && reply) reply.text += event.delta;
  if (event.type === 'response.done' && reply) reply.status = event.response.status;
});
async function waitFor(check: () => boolean) {
  const deadline = Date.now() + 30000;
  while (!check()) {
    if (failure) throw Error(failure);
    if (Date.now() > deadline) throw Error('Timeout');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (failure) throw Error(failure);
}
function wav(pcm: Buffer) {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
try {
  await client.connect();
  await waitFor(() => configured);
  for (let round = 1; round <= 4; round++) {
    client.sendUserMessageContent([{ type: 'input_text', text: '请只说这句话：你好，我在这里，准备好了。' }]);
    await waitFor(() => replies.length === round && Boolean(replies[round - 1].status));
    if (replies[round - 1].status !== 'completed') throw Error('Reply did not complete');
  }
} catch (error) { failure = String(error); }
finally {
  client.disconnect();
  const recordings = [];
  const comparison: Buffer[] = [];
  for (const [index, reply] of replies.entries()) {
    const pcm = Buffer.concat(reply.chunks);
    const file = `reply-${index + 1}.wav`;
    await writeFile(join(out, file), wav(pcm));
    comparison.push(pcm, Buffer.alloc(48000));
    recordings.push({ id: reply.id, text: reply.text, status: reply.status, seconds: pcm.length / 48000, file });
  }
  await writeFile(join(out, 'comparison.wav'), wav(Buffer.concat(comparison)));
  const report = { mode, model, voice, failure, upstreamCommit: '0812a2dd82b94602ea380c73468abb1718e28053',
    transport: 'official browser SDK with header adapter; no UI, microphone, or player', recordings, events };
  await writeFile(join(out, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out, mode, failure, recordings }, null, 2));
  if (failure || recordings.length !== 4 || recordings.some(r => r.seconds === 0)) process.exitCode = 1;
}
