/**
 * background service worker 入口：接收 side panel 转发的工具调用并分发执行。
 * 任何异常都收敛为 {ok:false, error}，绝不允许不回。
 */
import type { ToolName } from "../../../shared/protocol.js";
import { closeTab, listTabs, openTab, switchTab } from "./exec/tabs.js";
import { navigate } from "./exec/navigate.js";
import { snapshot } from "./exec/snapshot.js";
import { click, fill, pressKey, scroll, typeText } from "./exec/input.js";
import { evaluateJs } from "./exec/evaluate.js";
import { screenshot } from "./exec/screenshot.js";
import { oneLine } from "./util.js";

type Handler = (params: any) => Promise<unknown>;

const handlers: Record<ToolName, Handler> = {
  list_tabs: () => listTabs(),
  open_tab: (p) => openTab(p),
  switch_tab: (p) => switchTab(p),
  close_tab: (p) => closeTab(p),
  navigate: (p) => navigate(p),
  snapshot: (p) => snapshot(p),
  click: (p) => click(p),
  fill: (p) => fill(p),
  type_text: (p) => typeText(p),
  press_key: (p) => pressKey(p),
  scroll: (p) => scroll(p),
  js: (p) => evaluateJs(p),
  screenshot: () => screenshot(),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.channel !== "sideagent-tool") return;
  const name = msg.name as ToolName;
  const params = (msg.params ?? {}) as Record<string, unknown>;

  void (async () => {
    try {
      const handler = handlers[name];
      if (!handler) throw new Error(`未知工具: ${String(name)}`);
      const data = await handler(params);
      sendResponse({ ok: true, data });
    } catch (e) {
      sendResponse({ ok: false, error: oneLine(e) });
    }
  })();

  return true; // 异步 sendResponse
});

// 点击工具栏图标即打开 side panel
try {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* 忽略 */
    });
} catch {
  /* API 不可用时忽略 */
}
