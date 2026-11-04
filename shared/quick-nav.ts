export interface QuickNavTabInfo {
  id: number;
  title: string;
  url: string;
}

export interface QuickNavIntent {
  target: string;
}

const SWITCH_VERB = /^(?:(?:请|帮我|麻烦你?|给我|我想|我要)\s*)*(?:(?:把|将)\s*(?:页面|网页|标签页|这个页面|那个页面)\s*)?(切换到|切到|转到|跳到|打开|开一下|开开)\s*(.+?)\s*$/;
const TRAILING_POLITENESS = /(?:一下|吧|哈|哦|呀|啊|谢谢|pls|please)+$/;
const EXTRA_CLAUSE = /[，,。、；;！!？?]|然后|顺便|接着|再|帮我|帮忙|搜索|搜|看看|看一下|看|找|查|读|翻|等|和|与|或者|第|行|个|条|张|篇/;
const WRAPPERS = /^[\s「」『』""''《》<>()（）]+|[\s「」『』""''《》<>()（）]+$/g;
const SEGMENT_SPLIT = /\s*[\/|｜·•‥—–\-_:：~]\s*/;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[\s\u3000]+/g, "");
}

function hostStem(url: string): string | null {
  try {
    const host = new URL(url).hostname.toLowerCase();

    if (!host) return null;

    return host.replace(/^(www|m|mobile)\./, "").split(".")[0] ?? null;
  } catch {
    return null;
  }
}

export function parseQuickNavIntent(text: string): QuickNavIntent | null {
  const raw = text.trim();

  if (!raw || raw.length > 40) return null;

  const match = SWITCH_VERB.exec(raw);
  const targetGroup = match?.[2];

  if (typeof targetGroup !== "string") return null;

  let target = targetGroup.trim();

  let previous: string;
  do {
    previous = target;
    target = target.replace(TRAILING_POLITENESS, "").trim();
  } while (target !== previous);

  target = target.replace(WRAPPERS, "").trim();

  if (!target || target.length > 24) return null;
  if (EXTRA_CLAUSE.test(target)) return null;

  return { target };
}

export function matchQuickNavTab(target: string, tabs: readonly QuickNavTabInfo[]): QuickNavTabInfo | null {
  const needle = normalizeToken(target);

  if (!needle) return null;

  let hit: QuickNavTabInfo | null = null;

  for (const tab of tabs) {
    if (!/^https?:/.test(tab.url)) continue;

    const segments = [hostStem(tab.url), ...tab.title.split(SEGMENT_SPLIT).map(normalizeToken)].filter((segment): segment is string => !!segment);

    if (!segments.includes(needle)) continue;
    if (hit) return null;

    hit = tab;
  }

  return hit;
}
