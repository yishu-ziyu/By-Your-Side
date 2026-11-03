import type { MossAudioChunk } from '../../../shared/voice.js';

type Source = { node: AudioBufferSourceNode; buffer: AudioBuffer; key: string; itemId: string; responseId: string; start: number; offset: number; duration: number; audible: boolean; moss?: MossAudioChunk; resumeFrom?: number };

/** Playback has its own generation and clock, independent of server response.done. */
export class VoicePlayer {
  private turn = 0;
  private nextTime = 0;
  private generation = 0;
  private sources = new Set<Source>();
  private paused = false;
  private offsets = new Map<string, number>();
  private mossProgress = new Map<string, number>();
  private ended = new Set<string>();
  private lastPlayed: { itemId: string; ms: number } | undefined;
  constructor(private readonly context: AudioContext, private readonly drained: (responseId: string) => void, private readonly output: AudioNode = context.destination, private readonly chunkPlayed?: (chunk: MossAudioChunk, audible: boolean) => void) {}
  begin(turn: number): { itemId: string; ms: number } | undefined {
    const played = this.stop(); this.turn = turn;

 return played;
  }
  /** Full-duplex input advances without cutting existing playback. */
  follow(turn: number): void { this.turn=turn; }
  enqueue(event: { turn: number; itemId: string; responseId: string; data: string; sampleRate?: 48000; moss?: MossAudioChunk }): void {
    if (event.turn !== this.turn) return;
    const bytes = Uint8Array.from(atob(event.data), x => x.charCodeAt(0));

    if (!bytes.length || bytes.length % 2) return;
    const samples = bytes.length / 2;
    const sampleRate = event.sampleRate ?? 24000;
    const buffer = this.context.createBuffer(1, samples, sampleRate);
    const data = buffer.getChannelData(0); const view = new DataView(bytes.buffer);
    const windowSamples = Math.floor(sampleRate / 100);
    let energy = 0, audible = false;
    for (let i = 0; i < samples; i++) {
      const sample = view.getInt16(i * 2, true) / 32768;
      data[i] = sample;
      energy += sample * sample;
      if ((i + 1) % windowSamples === 0) {
        audible ||= energy / windowSamples >= 0.0001;
        energy = 0;
      }
    }
    const duration = samples / sampleRate;
    const key = event.moss ? `${event.moss.runId}:${event.moss.turnId}` : event.itemId;
    const offset = this.offsets.get(key) ?? 0;
    this.offsets.set(key, offset + duration);
    const source: Source = { node: this.context.createBufferSource(), buffer, key, itemId: event.itemId, responseId: event.responseId, start: Infinity, duration, offset, audible, moss: event.moss };
    this.sources.add(source);
    // Paused audio keeps its place in line; it is scheduled when playback resumes.
    if (this.paused) source.resumeFrom = 0;
    else this.schedule(source, 0);
  }
  private schedule(source: Source, from: number): void {
    const node = this.context.createBufferSource(); node.buffer = source.buffer; node.connect(this.output);
    const at = Math.max(this.context.currentTime + 0.012, this.nextTime);
    source.node = node;
    source.start = at - from;
    delete source.resumeFrom;
    this.nextTime = at + source.duration - from;
    const generation = this.generation;
    node.onended = () => {
      if (generation !== this.generation) return;
      node.disconnect();
      this.sources.delete(source);
      this.lastPlayed = { itemId: source.itemId, ms: (source.offset + source.duration) * 1000 };
      if (source.moss) {
        this.mossProgress.set(source.key, (source.offset + source.duration) * 1000);
        this.chunkPlayed?.(source.moss, source.audible);
      }
      this.checkDrained(source.responseId);
    };
    node.start(at, from);
  }
  /** Stops output immediately but keeps every unplayed sample, so resume() continues where it stopped. */
  pause(): boolean {
    if (this.paused || this.sources.size === 0) return false;
    this.paused = true;
    const now = this.context.currentTime;
    for (const source of this.sources) {
      source.resumeFrom = Math.min(source.duration, Math.max(0, now - source.start));
      source.node.onended = null;
      try { source.node.stop(); } catch { /* not started or already ended */ }
      source.node.disconnect();
    }
    this.nextTime = now;
    return true;
  }
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.nextTime = this.context.currentTime;
    for (const source of [...this.sources].sort((a, b) => a.start - b.start)) this.schedule(source, source.resumeFrom ?? 0);
  }
  get isPaused(): boolean { return this.paused; }
  /** 还有排着或正在播的回答音频。 */
  get playing(): boolean { return this.sources.size > 0; }
  responseEnd(responseId: string): void { this.ended.add(responseId); this.checkDrained(responseId); }
  private checkDrained(id: string): void {
    if (this.ended.has(id) && ![...this.sources].some(s => s.responseId === id)) { this.ended.delete(id); this.drained(id); }
  }
  stopMoss(runId: string, turnId: string): number {
    const key = `${runId}:${turnId}`;
    let played = this.mossProgress.get(key) ?? 0;
    for (const source of this.sources) {
      if (source.moss?.runId !== runId || source.moss.turnId !== turnId) continue;
      if (source.resumeFrom !== undefined) played = Math.max(played, (source.offset + source.resumeFrom) * 1000);
      else if (source.start <= this.context.currentTime) played = Math.max(played, (source.offset + Math.min(source.duration, this.context.currentTime - source.start)) * 1000);
      source.node.onended = null;
      try { source.node.stop(); } catch { /* already ended */ }
      source.node.disconnect();
      this.sources.delete(source);
    }
    this.mossProgress.set(key, played);
    this.offsets.delete(key);
    if (this.sources.size === 0) this.paused = false;
    this.nextTime = Math.max(this.context.currentTime, ...[...this.sources].map(source => source.start + source.duration));
    return Math.round(played);
  }
  stop(): { itemId: string; ms: number } | undefined {
    let played = this.lastPlayed;

    for (const s of this.sources) if (s.resumeFrom !== undefined) played = { itemId: s.itemId, ms: (s.offset + s.resumeFrom) * 1000 };
    else if (s.start <= this.context.currentTime) played = { itemId: s.itemId, ms: (s.offset + Math.min(s.duration, this.context.currentTime - s.start)) * 1000 };
    this.generation++;

    for (const s of this.sources) { try { s.node.stop(); } catch { /* already ended */ }

 s.node.disconnect(); }

    this.paused = false;
    this.sources.clear(); this.offsets.clear(); this.ended.clear(); this.nextTime = this.context.currentTime; this.lastPlayed = undefined;

    return played;
  }
}
