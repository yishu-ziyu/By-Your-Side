/**
 * 记忆面板「历史」折叠区的展开状态。
 * 面板每次刷新都会重建 <details>：用户自己展开过就保持展开；
 * 正在对历史里某条做删除确认/撤销时强制展开，否则确认框被收起，点删除像没反应。
 */
export class MemoryHistoryOpen {
  private userOpen = false;

  /** forced 为真时是程序强制展开，不算用户的选择。 */
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
