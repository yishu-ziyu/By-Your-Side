/** One local classifier per capture session. Closing it discards all late frames. */
export class SpeechClassifier {
  private closed = false;
  private constructor(private readonly worker: Worker) {}
  static async create(onFrame: (pcm: Int16Array, probability: number) => void, onError: () => void): Promise<SpeechClassifier> {
    const worker = new Worker(chrome.runtime.getURL('voice-vad-worker.js'), { type: 'module' });
    const classifier = new SpeechClassifier(worker);
    return new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(failed, 10000);
      function failed(detail?: unknown) {
        if (classifier.closed) return;
        clearTimeout(timer); classifier.close();
        if (ready) onError(); else reject(new Error(typeof detail === 'string' ? 'Speech detection unavailable: ' + detail : 'Speech detection unavailable'));
      }
      worker.onerror = failed;
      worker.onmessage = ({ data }) => {
        if (classifier.closed) return;
        if (data.kind === 'ready') { ready = true; clearTimeout(timer); resolve(classifier); }
        else if (data.kind === 'error') failed(data.detail);
        else if (ready && data.kind === 'frame') onFrame(new Int16Array(data.pcm), data.probability);
      };
    });
  }
  push(pcm: Int16Array): void {
    if (!this.closed) this.worker.postMessage(pcm.buffer, [pcm.buffer]);
  }
  close(): void {
    this.closed = true; this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate();
  }
}
