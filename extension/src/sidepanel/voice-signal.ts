/** 20 ms frames; all audio, including the utterance's silence tail, is streamed. */
export class VoiceTurnDetector {
  private prefix: Int16Array[] = [];
  private voiced = 0;
  private silence = 0;
  private frames = 0;
  private active = false;
  private turn = 0;
  constructor(private readonly callbacks: {
    start: (turn: number) => void;
    audio: (turn: number, pcm: Int16Array) => void;
    end: (turn: number) => void;
  }) {}
  push(pcm: Int16Array, rms: number): void {
    const speaking = rms >= 0.015;
    if (!this.active) {
      this.prefix.push(pcm);
      if (this.prefix.length > 10) this.prefix.shift();
      this.voiced = speaking ? this.voiced + 1 : 0;
      if (this.voiced < 4) return;
      this.active = true; this.silence = 0; this.frames = 0; this.turn++;
      this.callbacks.start(this.turn);
      for (const frame of this.prefix) this.callbacks.audio(this.turn, frame);
      this.prefix = [];
      return;
    }
    this.callbacks.audio(this.turn, pcm);
    this.frames++;
    this.silence = speaking ? 0 : this.silence + 1;
    if (this.silence >= 35 || this.frames >= 3000) {
      this.active = false; this.voiced = 0; this.silence = 0;
      this.callbacks.end(this.turn);
    }
  }
}

export function pcmBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i]!, true);
  return btoa(String.fromCharCode(...bytes));
}
