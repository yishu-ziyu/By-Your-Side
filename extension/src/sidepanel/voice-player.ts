/** Playback has its own generation and clock, independent of server response.done. */
export class VoicePlayer {
  private turn = 0;
  private nextTime = 0;
  private generation = 0;
  private sources = new Set<{ node: AudioBufferSourceNode; itemId: string; responseId: string; start: number; offset: number; duration: number }>();
  private offsets = new Map<string, number>();
  private ended = new Set<string>();
  private lastPlayed: { itemId: string; ms: number } | undefined;
  constructor(private readonly context: AudioContext, private readonly drained: (responseId: string) => void, private readonly output: AudioNode = context.destination) {}
  begin(turn: number): { itemId: string; ms: number } | undefined {
    const played = this.stop(); this.turn = turn; return played;
  }
  enqueue(event: { turn: number; itemId: string; responseId: string; data: string }): void {
    if (event.turn !== this.turn) return;
    const bytes = Uint8Array.from(atob(event.data), x => x.charCodeAt(0));
    if (!bytes.length || bytes.length % 2) return;
    const samples = bytes.length / 2;
    const buffer = this.context.createBuffer(1, samples, 24000);
    const data = buffer.getChannelData(0); const view = new DataView(bytes.buffer);
    for (let i = 0; i < samples; i++) data[i] = view.getInt16(i * 2, true) / 32768;
    const node = this.context.createBufferSource(); node.buffer = buffer; node.connect(this.output);
    const start = Math.max(this.context.currentTime + 0.012, this.nextTime);
    const duration = samples / 24000;
    const offset = this.offsets.get(event.itemId) ?? 0;
    this.offsets.set(event.itemId, offset + duration);
    const source = { node, itemId: event.itemId, responseId: event.responseId, start, duration, offset };
    const generation = this.generation;
    this.sources.add(source); this.nextTime = start + duration;
    node.onended = () => {
      if (generation !== this.generation) return;
      node.disconnect();
      this.sources.delete(source);
      this.lastPlayed = { itemId: source.itemId, ms: (source.offset + source.duration) * 1000 };
      this.checkDrained(source.responseId);
    };
    node.start(start);
  }
  responseEnd(responseId: string): void { this.ended.add(responseId); this.checkDrained(responseId); }
  private checkDrained(id: string): void {
    if (this.ended.has(id) && ![...this.sources].some(s => s.responseId === id)) { this.ended.delete(id); this.drained(id); }
  }
  stop(): { itemId: string; ms: number } | undefined {
    let played = this.lastPlayed;
    for (const s of this.sources) if (s.start <= this.context.currentTime) played = { itemId: s.itemId, ms: (s.offset + Math.min(s.duration, this.context.currentTime - s.start)) * 1000 };
    this.generation++;
    for (const s of this.sources) { try { s.node.stop(); } catch { /* already ended */ } s.node.disconnect(); }
    this.sources.clear(); this.offsets.clear(); this.ended.clear(); this.nextTime = this.context.currentTime; this.lastPlayed = undefined;
    return played;
  }
}
