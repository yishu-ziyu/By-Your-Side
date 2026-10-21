import { isPanelUrl } from "../shared/panel-url.js";

/**
 * 「用户正在看的页面」在哪个窗口。会话单独开在一个小窗口里时，用户在小窗口里打字，最后获得焦点的是小窗口本身，
 * 里面只有扩展页；它要读、要操作的是打开它的那个浏览器窗口。那个窗口关了，就用最近获得焦点的普通窗口。
 */

export { isPanelUrl };

/** 会话小窗口的来源窗口号；侧栏和别的页面是 undefined。 */
export function popoutSource(url: string | undefined): number | undefined {
  if (!isPanelUrl(url)) return undefined;
  const raw = new URL(url!).searchParams.get("window");
  const id = raw === null ? NaN : Number(raw);

  return Number.isInteger(id) ? id : undefined;
}

async function targetWindowId(): Promise<number | undefined> {
  const last = await chrome.windows.getLastFocused().catch(() => undefined);

  if (last?.id == null) return undefined;

  if (last.type !== "popup") return last.id;
  const [page] = await chrome.tabs.query({ windowId: last.id }).catch(() => []);
  const source = popoutSource(page?.url);

  // 别的弹出窗口（不是我们的会话小窗口）照旧。
  if (source === undefined) return last.id;

  if (await chrome.windows.get(source).then(w => w.type === "normal", () => false)) return source;

  return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined))?.id;
}

/**
 * 用户正在看的那个标签页。扩展自己的侧栏页永远不算：会话小窗口里只有它，一个普通窗口都没开时也不能把它当网页去读、去跳转。
 */
export async function activeTargetTabs(): Promise<chrome.tabs.Tab[]> {
  const windowId = await targetWindowId();
  const tabs = await chrome.tabs.query(windowId == null ? { active: true, lastFocusedWindow: true } : { active: true, windowId });

  return tabs.filter(tab => !isPanelUrl(tab.url));
}
