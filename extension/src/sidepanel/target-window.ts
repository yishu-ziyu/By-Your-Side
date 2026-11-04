import { isPanelUrl } from "../shared/panel-url.js";

const params = new URLSearchParams(location.search);

function sourceWindow(): number | undefined {
  const raw = params.get("window");
  const id = raw === null ? NaN : Number(raw);

  return Number.isInteger(id) ? id : undefined;
}

const popoutSource = sourceWindow();

export const isPopout = popoutSource !== undefined;

export const isFloat = isPopout && params.has("float");

export const popoutConversation = isPopout ? params.get("conversation") ?? undefined : undefined;

export async function targetWindowId(): Promise<number | undefined> {
  if (popoutSource === undefined) return (await chrome.windows.getCurrent().catch(() => null))?.id;

  if (await chrome.windows.get(popoutSource).then(w => w.type === "normal", () => false)) return popoutSource;

  return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null))?.id;
}

export async function activeTargetTab(opts: { lastFocused?: boolean } = {}): Promise<chrome.tabs.Tab | undefined> {
  const windowId = isPopout ? await targetWindowId() : opts.lastFocused ? undefined : await targetWindowId();

  if (isPopout && windowId == null) return undefined;
  const [tab] = await chrome.tabs.query(windowId == null ? { active: true, lastFocusedWindow: true } : { active: true, windowId });

  return isPanelUrl(tab?.url) ? undefined : tab;
}
