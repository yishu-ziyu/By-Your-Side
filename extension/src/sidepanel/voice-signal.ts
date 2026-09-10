/** Local speech probabilities decide turns; original PCM, including preroll, is streamed. */
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
  push(pcm: Int16Array, probability: number): void {
    const duration = pcm.length / 24;
    // Recurrent models can retain speech confidence briefly after digital silence.
    // This floor is far below quiet speech; volume alone can never start a turn.
    const energy = pcm.reduce((sum, value) => sum + (value / 32768) ** 2, 0) / pcm.length;
    const speaking = energy > 0.0001 ** 2 && probability >= (this.active ? 0.35 : 0.6);
    if (!this.active) {
      this.prefix.push(pcm);
      while (this.prefix.reduce((sum, frame) => sum + frame.length, 0) > 24000 * 0.32) this.prefix.shift();
      this.voiced = speaking ? this.voiced + duration : 0;
      if (this.voiced < 96) return;
      this.active = true; this.silence = 0; this.frames = 0; this.turn++;
      this.callbacks.start(this.turn);
      for (const frame of this.prefix) this.callbacks.audio(this.turn, frame);
      this.prefix = [];
      return;
    }
    this.callbacks.audio(this.turn, pcm);
    this.frames += duration;
    this.silence = speaking ? 0 : this.silence + duration;
    if (this.silence >= 700 || this.frames >= 60000) {
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
