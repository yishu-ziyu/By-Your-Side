/**
 * Output lifecycle: waiting → ready → playing → done/interrupted/failed.
 * Cancelling playback is not cancelling the task. This module has no task API.
 */
export interface PlaybackStream {
  id: string;
  runId: string | null;
  kind: string;
  voiceTurn?: number;
}

export interface QueuedSpeech<T extends PlaybackStream = PlaybackStream> {
  stream: T;
  complete: boolean;
  controlVersion: number;
}

export class VoicePlayback<T extends PlaybackStream = PlaybackStream> {
  private epoch = 0;
  private readonly waiting = new Set<string>();
  private readonly ignored = new Set<string>();
  private readonly deliveryByResponse = new Map<string, string>();
  private readonly silenced = new Set<string>();
  private readonly queue = new Map<string, QueuedSpeech<T>>();

  interrupt(): number {
    this.epoch += 1;
    for (const responseId of this.deliveryByResponse.keys()) this.ignored.add(responseId);
    this.deliveryByResponse.clear();
    this.waiting.clear();
    return this.epoch;
  }

  bind(responseId: string, deliveryId: string | null): void {
    if (!deliveryId) return;
    this.deliveryByResponse.set(responseId, deliveryId);
    this.waiting.add(responseId);
  }

  wait(responseId: string): void {
    this.waiting.add(responseId);
  }

  get waitingCount(): number {
    return this.waiting.size;
  }

  clearWaiting(): void {
    this.waiting.clear();
  }

  dropWaiting(responseId: string): void {
    this.waiting.delete(responseId);
  }

  forget(responseId: string): void {
    this.waiting.delete(responseId);
    this.deliveryByResponse.delete(responseId);
  }

  done(responseId: string): { deliveryId: string | null; ignored: boolean; epoch: number } {
    this.waiting.delete(responseId);
    const ignored = this.ignored.has(responseId);
    const deliveryId = this.deliveryByResponse.get(responseId) ?? null;
    this.deliveryByResponse.delete(responseId);
    this.ignored.delete(responseId);
    return { deliveryId, ignored, epoch: this.epoch };
  }

  currentEpoch(): number {
    return this.epoch;
  }

  isSilenced(id: string): boolean {
    return this.silenced.has(id);
  }

  silence(id: string): void {
    this.queue.delete(id);
    this.silenced.add(id);
    if (this.silenced.size > 100) this.silenced.delete(this.silenced.values().next().value!);
  }

  enqueue(stream: T, controlVersion: number, complete = false): void {
    const previous = this.queue.get(stream.id);
    this.queue.set(stream.id, {
      stream,
      complete: previous?.complete || complete,
      controlVersion: previous?.controlVersion ?? controlVersion,
    });
    // Accepted results remain pending until consumed or explicitly silenced.
    // A new result must never evict an older unplayed answer.
  }

  getQueued(id: string): QueuedSpeech<T> | undefined {
    return this.queue.get(id);
  }

  hasQueued(id: string): boolean {
    return this.queue.has(id);
  }

  markComplete(id: string): boolean {
    const queued = this.queue.get(id);
    if (!queued) return false;
    queued.complete = true;
    return true;
  }

  *takeQueued(): IterableIterator<[string, QueuedSpeech<T>]> {
    // A caller stops after starting one output. Leave the remaining results
    // queued until that output finishes, instead of draining them all at once.
    for (const [id, item] of [...this.queue]) {
      this.queue.delete(id);
      yield [id, item];
    }
  }

  silenceQueued(): void {
    for (const id of this.queue.keys()) this.silenced.add(id);
    this.queue.clear();
  }

  someQueued(pred: (item: QueuedSpeech<T>) => boolean): boolean {
    for (const item of this.queue.values()) if (pred(item)) return true;
    return false;
  }

  clear(): void {
    this.queue.clear();
    this.waiting.clear();
    this.deliveryByResponse.clear();
    this.ignored.clear();
  }
}
