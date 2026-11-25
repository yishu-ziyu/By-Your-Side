export interface OpenTabSummary {
  tabId: number;
  url: string;
  title: string;
}

export interface TabCluster {
  key: string;
  label: string;
  tabs: OpenTabSummary[];
}

function pathBucket(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    const host = parsed.host.replace(/^www\./, "");
    const segments = parsed.pathname.split("/").filter(Boolean);
    const firstSegment = segments[0] ?? "";
    return `${host}/${segments.length === 1 ? firstSegment.replace(/\d+/g, "#") : firstSegment}`;
  } catch {
    return null;
  }
}

export function detectComparableCluster(tabs: OpenTabSummary[], minSize = 3): TabCluster | null {
  const byBucket = new Map<string, OpenTabSummary[]>();

  for (const tab of tabs) {
    const bucket = pathBucket(tab.url);
    if (!bucket) continue;
    const list = byBucket.get(bucket) ?? [];
    if (!list.some((existing) => existing.url === tab.url)) {
      list.push(tab);
      byBucket.set(bucket, list);
    }
  }

  let best: { key: string; tabs: OpenTabSummary[] } | null = null;
  for (const [key, list] of byBucket.entries()) {
    if (list.length >= minSize && (!best || list.length > best.tabs.length)) {
      best = { key, tabs: list };
    }
  }

  if (!best) return null;
  return {
    key: `compare:${best.key}`,
    label: `对比这 ${best.tabs.length} 个标签页`,
    tabs: best.tabs,
  };
}
