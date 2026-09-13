/**
 * Voice input identity: committed turns, late transcripts, playback-interrupt bookkeeping.
 * Does not own routing or task cancellation.
 */
export const LATE_TRANSCRIPT_MERGE_MS = 2500;

export class VoiceInputLedger {
  turn = 0;
  private committed = new Set<number>();
  private mergeLateFrom: number | null = null;
  private lateText = "";
  private turnStartedAt = 0;

  interrupt(nextTurn: number, answerWasCut: boolean): void {
    const cutOffTurn = this.turn;
    this.mergeLateFrom = answerWasCut && nextTurn === cutOffTurn + 1 ? cutOffTurn : null;
    this.lateText = "";
    this.turn = nextTurn;
    this.turnStartedAt = Date.now();
  }

  commit(turn: number): boolean {
    if (this.committed.has(turn)) return false;
    this.committed.add(turn);
    return true;
  }

  hasCommitted(turn: number): boolean {
    return this.committed.has(turn);
  }

  mergeLate(fromTurn: number, spoken: string, now = Date.now()): boolean {
    if (!spoken) return false;
    if (fromTurn !== this.mergeLateFrom) return false;
    if (now - this.turnStartedAt > LATE_TRANSCRIPT_MERGE_MS) return false;
    this.lateText = [this.lateText, spoken].filter(Boolean).join(" ");
    return true;
  }

  takeTranscript(spoken: string): string {
    const transcript = [this.lateText, spoken].filter(Boolean).join(" ").trim();
    this.lateText = "";
    this.mergeLateFrom = null;
    return transcript;
  }
}
