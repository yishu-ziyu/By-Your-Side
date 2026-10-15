import { CURSOR_SPOT_SAVE, CURSOR_SPOT_TAKE, isCursorSpots, type CursorSpot } from "../shared/cursor-spot.js";
import { litInstances } from "./page-glow.js";

/** 标签页 → 旧网页离开时光标停的位置。只交给紧接着的下一个网页，取过就删。 */
const spots = new Map<number, CursorSpot[]>();

export function installCursorSpots(): void {
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const tabId = sender.tab?.id;

    if (sender.id !== chrome.runtime.id || tabId == null || sender.frameId !== 0) return;

    if (raw?.type === CURSOR_SPOT_SAVE && isCursorSpots(raw.spots)) spots.set(tabId, raw.spots);

    if (raw?.type === CURSOR_SPOT_TAKE) {
      const saved = spots.get(tabId) ?? [];
      spots.delete(tabId);
      // 这一轮已经结束（边缘光熄了）的成员不接力：失败后停在原处的光标，不跟着用户自己换的网页走。
      const working = litInstances(tabId);
      respond({ spots: saved.filter((spot) => working.has(spot.id)) });
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => spots.delete(tabId));
}
