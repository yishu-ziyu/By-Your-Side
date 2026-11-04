export class MemoryHistoryOpen {
  private userOpen = false;

  shouldOpen(forced: boolean): boolean {
    return forced || this.userOpen;
  }

  recordToggle(open: boolean, forced: boolean): void {
    if (!forced) this.userOpen = open;
  }

  reset(): void {
    this.userOpen = false;
  }
}
