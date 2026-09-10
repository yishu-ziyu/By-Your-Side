import * as ort from 'onnxruntime-web/wasm';
import { SileroV5 } from '@ricky0123/vad-web/dist/models/v5.js';

/** Silero sees 16k audio; the original 24k PCM is retained for transcription. */
export async function createSpeechModel(assetBase: string) {
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  ort.env.wasm.wasmPaths = assetBase;
  const model = await SileroV5.new(ort, async () => {
    const response = await fetch(new URL('silero_vad_v5.onnx', assetBase));
    if (!response.ok) throw new Error('Speech model asset unavailable');
    return response.arrayBuffer();
  });
  return {
    async probability(pcm: Int16Array): Promise<number> {
      if (pcm.length !== 768) throw new Error('Expected 32ms of 24k audio');
      const frame = new Float32Array(512);
      for (let i = 0, j = 0; i < pcm.length; i += 3, j += 2) {
        frame[j] = (pcm[i]! * 2 + pcm[i + 1]!) / (3 * 32768);
        frame[j + 1] = (pcm[i + 1]! + pcm[i + 2]! * 2) / (3 * 32768);
      }
      return (await model.process(frame)).isSpeech;
    },
    release: () => model.release(),
  };
}
