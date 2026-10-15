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
export const popoutSource = sourceWindow();

export const isPopout = popoutSource !== undefined;

/** 单独窗口打开时要显示的会话。 */
export const popoutConversation = isPopout ? params.get("conversation") ?? undefined : undefined;

export async function targetWindowId(): Promise<number | undefined> {
  if (popoutSource === undefined) return (await chrome.windows.getCurrent().catch(() => null))?.id;

  if (await chrome.windows.get(popoutSource).then(w => w.type === "normal", () => false)) return popoutSource;

  return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
}

/** 代替 chrome.tabs.query({ active: true, currentWindow: true })。 */
export async function activeTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  const windowId = await targetWindowId();
  const [tab] = await chrome.tabs.query(windowId == null ? { active: true, currentWindow: true } : { active: true, windowId });

  return tab;
}
