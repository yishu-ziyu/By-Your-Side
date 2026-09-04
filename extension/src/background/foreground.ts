/**
 * 是否允许把工作标签页切到其窗口内前台。
 * 窗口未聚焦 = 人在别的 Space / 别的应用，禁止抢；否则会把 macOS Space 拽回来。
 */
export function mayActivateTabInWindow(focused: boolean | undefined): boolean {
  return focused === true;
}
