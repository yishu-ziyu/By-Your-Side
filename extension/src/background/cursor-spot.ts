import { CURSOR_SPOT_SAVE, CURSOR_SPOT_TAKE, isCursorSpots, type CursorSpot } from "../shared/cursor-spot.js";
import { litInstances } from "./page-glow.js";

const spots = new Map<number, CursorSpot[]>();

export function installCursorSpots(): void {
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const tabId = sender.tab?.id;

    if (sender.id !== chrome.runtime.id || tabId == null || sender.frameId !== 0) return;

    if (raw?.type === CURSOR_SPOT_SAVE && isCursorSpots(raw.spots)) spots.set(tabId, raw.spots);

    if (raw?.type === CURSOR_SPOT_TAKE) {
      const saved = spots.get(tabId) ?? [];
      spots.delete(tabId);
      const working = litInstances(tabId);
      respond({ spots: saved.filter((spot) => working.has(spot.id)) });
    }
  });
  chrome.tabs.onRemoved.addListener((tabId) => spots.delete(tabId));
}
