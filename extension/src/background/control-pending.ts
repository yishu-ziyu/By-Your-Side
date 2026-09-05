/** 连接断开时可暂停、重连后重新计时的控制确认期限。 */
export class PendingControlTimeout {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
  ) {}

  arm(): void {
    this.pause();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.onTimeout();
    }, this.timeoutMs);
  }

  pause(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  clear(): void {
    this.pause();
  }
}
