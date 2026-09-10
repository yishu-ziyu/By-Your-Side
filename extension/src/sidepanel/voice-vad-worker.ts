import { createSpeechModel } from './voice-vad-model.js';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ArrayBuffer>) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
};
const queue: Int16Array[] = [];
let processing = false;
let stopped = false;
let pending = new Int16Array(0);

void createSpeechModel(new URL('./vad/', import.meta.url).href).then(model => {
  scope.onmessage = event => {
    if (stopped) return;
    queue.push(new Int16Array(event.data));
    if (queue.length > 50) { fail(); return; }
    void drain();
  };
  scope.postMessage({ kind: 'ready' });
  async function drain() {
    if (processing || stopped) return;
    processing = true;
    try {
      while (queue.length && !stopped) {
        const input = queue.shift()!;
        const joined = new Int16Array(pending.length + input.length);
        joined.set(pending); joined.set(input, pending.length);
        let offset = 0;
        while (joined.length - offset >= 768) {
          const pcm = joined.slice(offset, offset + 768);
          const probability = await model.probability(pcm);
          if (stopped) return;
          scope.postMessage({ kind: 'frame', pcm: pcm.buffer, probability }, [pcm.buffer]);
          offset += 768;
        }
        pending = joined.slice(offset);
      }
    } catch (error) { fail(error); }
    finally { processing = false; }
  }
}).catch(fail);

function fail(error?: unknown) {
  if (stopped) return;
  stopped = true; queue.length = 0; pending = new Int16Array(0);
  scope.postMessage({ kind: 'error', detail: error instanceof Error ? error.message.slice(0, 500) : 'Speech worker overloaded' });
}
