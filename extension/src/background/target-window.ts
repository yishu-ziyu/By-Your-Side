import { isPanelUrl } from "../shared/panel-url.js";

export { isPanelUrl };

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

  if (source === undefined) return last.id;

  if (await chrome.windows.get(source).then(w => w.type === "normal", () => false)) return source;

  return (await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => undefined))?.id;
}

export async function activeTargetTabs(): Promise<chrome.tabs.Tab[]> {
  const windowId = await targetWindowId();
  const tabs = await chrome.tabs.query(windowId == null ? { active: true, lastFocusedWindow: true } : { active: true, windowId });

  return tabs.filter(tab => !isPanelUrl(tab.url));
}
