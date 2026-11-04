import { shouldActivateForKey } from "./state.js";

type UserNeeded = "hand_to_user" | "send_confirm" | "pay_stop" | "user_asked" | "guide" | { trailReplay: string };

export async function bringForwardForUser(tabId: number, reason: UserNeeded): Promise<void> {
  if (typeof reason === "object" && !shouldActivateForKey(reason.trailReplay)) return;

  try {
    const tab = await chrome.tabs.get(tabId);
    const win = await chrome.windows.get(tab.windowId);

    if (win.focused !== true) return;
    await chrome.tabs.update(tabId, { active: true });
  } catch {  }
}

export async function putBackUserTab(userTabId: number): Promise<void> {
  await chrome.tabs.update(userTabId, { active: true });
}
