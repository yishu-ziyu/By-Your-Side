const NOTICE_DELAY_MS = 8_000;

export class VoiceConnectionNotice {
  private cancelTimer: (() => void) | null = null;
  notified = false;

  constructor(
    private readonly notify: () => void,
    private readonly schedule: (callback: () => void, delay: number) => () => void = (callback, delay) => {
      const timer = setTimeout(callback, delay);
      return () => clearTimeout(timer);
    },
  ) {}

  start(): void {
    if (this.cancelTimer || this.notified) return;
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null;
      this.notified = true;
      this.notify();
    }, NOTICE_DELAY_MS);
  }

  reset(): void {
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.notified = false;
  }
}
