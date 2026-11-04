import { FLOAT_CARD_TO_PANEL, FLOAT_CARD_WHERE } from "../shared/float-card.js";

export function installFloatCard(): void {
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const type = (raw as { type?: unknown } | null)?.type;

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) return;

    if (type === FLOAT_CARD_WHERE) respond({ windowId: sender.tab.windowId });

    if (type === FLOAT_CARD_TO_PANEL) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => {  });
  });
}
