import { isPanelUrl } from "../shared/panel-url.js";

/**
 * 这个页面要读、要操作的网页在哪个窗口。侧栏住在浏览器窗口里，就是自己的窗口；
 * 会话单独开的小窗口里只有扩展页，要看的是打开它的那个窗口（地址里的 window=），那个窗口关了就用最近获得焦点的普通窗口。
 */

const params = new URLSearchParams(location.search);

function sourceWindow(): number | undefined {
  const raw = params.get("window");
  const id = raw === null ? NaN : Number(raw);

  return Number.isInteger(id) ? id : undefined;
}

/** 单独窗口里打开的会话；侧栏里是 undefined。 */
const popoutSource = sourceWindow();

export const isPopout = popoutSource !== undefined;

/** 会话页挂在网页上的浮动卡片里（iframe），不是单独窗口。 */
export const isFloat = isPopout && params.has("float");

/** 单独窗口打开时要显示的会话。 */
export const popoutConversation = isPopout ? params.get("conversation") ?? undefined : undefined;

export async function targetWindowId(): Promise<number | undefined> {
  if (popoutSource === undefined) return (await chrome.windows.getCurrent().catch(() => null))?.id;

  if (await chrome.windows.get(popoutSource).then(w => w.type === "normal", () => false)) return popoutSource;

  return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
}

/**
 * 用户正在看的那个标签页。lastFocused：侧栏里按最近获得焦点的窗口找，和后台给模型带页面时的找法一致。
 * 会话小窗口里只看来源窗口；一个普通窗口都没开时没有可看的页，不拿小窗口自己顶替。
 */
export async function activeTargetTab(opts: { lastFocused?: boolean } = {}): Promise<chrome.tabs.Tab | undefined> {
  const windowId = isPopout ? await targetWindowId() : opts.lastFocused ? undefined : await targetWindowId();

  if (isPopout && windowId == null) return undefined;
  const [tab] = await chrome.tabs.query(windowId == null ? { active: true, lastFocusedWindow: true } : { active: true, windowId });

  return isPanelUrl(tab?.url) ? undefined : tab;
}
