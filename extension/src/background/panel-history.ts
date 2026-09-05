import type { PanelHistoryEntry, PanelHistoryItem } from "../relay.js";

export const DEFAULT_PANEL_HISTORY_LIMIT = 5_000;

/**
 * Service worker 生命周期内的侧栏回放日志。
 *
 * seq 永不复用；超过上限时只淘汰最旧条目。因此面板持有的旧游标即使落在
 * 已截断区间，since() 也会返回当前仍保留的完整窗口。
 */
export class PanelHistory {
  private readonly entries: PanelHistoryEntry[] = [];
  private nextSeq = 1;

  constructor(private readonly limit = DEFAULT_PANEL_HISTORY_LIMIT) {
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new RangeError("PanelHistory limit must be a positive integer");
    }
  }

  record(item: PanelHistoryItem): PanelHistoryEntry {
    const entry = { seq: this.nextSeq++, item };
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return entry;
  }

  since(afterSeq = 0): PanelHistoryEntry[] {
    return this.entries.filter((entry) => entry.seq > afterSeq);
  }

  clear(): void {
    this.entries.length = 0;
  }
}
