/**
 * 这份网页脚本还连着扩展吗。扩展重载或更新后，旧脚本还留在网页里，只是和扩展断开了（chrome.runtime.id 变成 undefined）；
 * 后台会给已打开的网页补装新脚本（background/reinject.ts），旧脚本就不能再接按键和鼠标，否则会出现两个胶囊、两个把手。
 */
export function extensionAlive(): boolean {
  try {
    return !!chrome.runtime?.id;
  } catch {
    return false;
  }
}
