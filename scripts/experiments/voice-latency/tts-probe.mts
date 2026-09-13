/** 定点实验：TTS 首帧里有多少是“连接/握手”，有多少是“送字到出声”。
 *
 * 只连真实 Step TTS，用生产音色与固定文本；不启动扩展、不播声音到扬声器。
 * 运行：npx tsx scripts/experiments/voice-latency/tts-probe.mts
 */
import {StepTtsStream} from '../../../agent/src/streaming-tts.js';
import {readStepVoiceKey} from '../../../agent/src/voice-service.js';

const TEXT = '晚上好，今天想聊点什么？';
const key = await readStepVoiceKey();
const runs: any[] = [];

async function once(label: string, warmFirst: boolean) {
  const t: Record<string, number> = {};
  const t0 = Date.now();
  let resolveFirst: (() => void) | undefined;
  const first = new Promise<void>(r => (resolveFirst = r));
  let bytes = 0;
  const stream = new StepTtsStream(key, 'voice-tone-T3kZb9MwL2', {
    audio: data => {
      if (!bytes) {
        t.firstAudio = Date.now() - t0;
        resolveFirst?.();
      }
      bytes += Buffer.from(data, 'base64').length;
    },
    end: () => (t.end = Date.now() - t0),
    error: () => (t.error = Date.now() - t0),
  });
  t.constructed = 0;
  // 预热 = 建连和 tts.create 先跑完，再送字；冷启动 = 立刻送字（现状）。
  if (warmFirst) await new Promise(r => setTimeout(r, 900));
  t.pushAt = Date.now() - t0;
  stream.push(TEXT);
  await Promise.race([first, new Promise(r => setTimeout(r, 6000))]);
  stream.finish();
  await new Promise(r => setTimeout(r, 1500));
  stream.cancel();
  runs.push({ label, bytes, ...t });
}

for (let i = 0; i < 3; i++) await once(`cold-${i + 1}`, false);
for (let i = 0; i < 2; i++) await once(`warm-${i + 1}`, true);
console.log(JSON.stringify({ text: TEXT, runs }, null, 1));
