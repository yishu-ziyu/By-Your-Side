import { FLOAT_CARD_TO_PANEL, FLOAT_CARD_WHERE } from "../shared/float-card.js";

/** 浮动卡片的内容脚本只认顶层网页发来的消息；卡片里的会话页（iframe）走侧栏那条端口，不走这里。 */
export function installFloatCard(): void {
  chrome.runtime.onMessage.addListener((raw, sender, respond) => {
    const type = (raw as { type?: unknown } | null)?.type;

    if (sender.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0) return;

    if (type === FLOAT_CARD_WHERE) respond({ windowId: sender.tab.windowId });

    // 必须在这次点击的消息里同步打开：等异步之后浏览器就不认是用户动作了。
    if (type === FLOAT_CARD_TO_PANEL) void chrome.sidePanel.open({ tabId: sender.tab.id }).catch(() => { /* 侧栏已开 */ });
  });
}
