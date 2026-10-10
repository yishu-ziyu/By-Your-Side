/**
 * 助手引起的前台变化都在这里（docs/evals/20261010-keep-foreground.md）。
 * 助手平常的动作都在后台标签里做，不把任何标签页切到前台。
 * 只有「需要用户」的时刻才把工作页切到前台：交给用户、发送前确认、付款前停下，以及回放鼠标轨迹（只对用户正在看的对话）。
 * 从不聚焦或抬起窗口：只在窗口已经聚焦时切换窗口里的标签页；窗口没聚焦说明人在别的 Space 或别的应用，不抢。
 * 助手点开的新页被 Chrome 设成活动页时，在这里把用户原来在看的页放回去。
 * 用户自己发起的跳转（侧栏、网页上的提示、设置页）不归这里管。
 */
import { shouldActivateForKey } from "./state.js";

/** 需要用户的时刻。回放轨迹带着会话 key：只有用户正在看的对话才切。 */
export type UserNeeded = "hand_to_user" | "send_confirm" | "pay_stop" | { trailReplay: string };

/** 因为需要用户，把工作页切到其窗口内前台。窗口没聚焦、页或窗口已关时什么都不做。 */
export async function bringForwardForUser(tabId: number, reason: UserNeeded): Promise<void> {
  if (typeof reason === "object" && !shouldActivateForKey(reason.trailReplay)) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);

    if (win.focused !== true) return;
    await chrome.tabs.update(tabId, { active: true });
  } catch { /* tab/window disappeared */ }
}

/** 助手点开的新页成了活动页：把用户原来在看的页放回活动页。从不聚焦窗口。 */
export async function putBackUserTab(userTabId: number): Promise<void> {
  await chrome.tabs.update(userTabId, { active: true });
}
