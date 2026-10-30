/**
 * 「切到某标签 / 打开某页」小意图的确定性识别。识别和匹配都不调模型：
 * 说法里附带别的要求、匹配不到或匹配到多个标签，一律返回 null，调用方走完整智能体路径。
 * 覆盖的是用户等不起的瞬间——目标标签已经开着，一句话就要它到眼前；
 * 匹配只凭开着的标签本身（标题分段、域名主干），不认识的说法交给完整路径去澄清。
 */

export interface QuickNavTabInfo {
  id: number;
  title: string;
  url: string;
}

export interface QuickNavIntent {
  /** 剥掉动词和客气话之后的目标名，如「x」「耳机比价」。 */
  target: string;
}

const SWITCH_VERB = /^(?:(?:请|帮我|麻烦你?|给我|我想|我要)\s*)*(?:(?:把|将)\s*(?:页面|网页|标签页|这个页面|那个页面)\s*)?(切换到|切到|转到|跳到|打开|开一下|开开)\s*(.+?)\s*$/;
const TRAILING_POLITENESS = /(?:一下|吧|哈|哦|呀|啊|谢谢|pls|please)+$/;
/** 目标里出现这些就说明不只是切换：标点（另起一句）、后续动作、数量词、方位词。 */
const EXTRA_CLAUSE = /[，,。、；;！!？?]|然后|顺便|接着|再|帮我|帮忙|搜索|搜|看看|看一下|看|找|查|读|翻|等|和|与|或者|第|行|个|条|张|篇/;
const WRAPPERS = /^[\s「」『』""''《》<>()（）]+|[\s「」『』""''《》<>()（）]+$/g;
const SEGMENT_SPLIT = /\s*[\/|｜·•‥—–\-_:：~]\s*/;

function normalizeToken(value: string): string {
  return value.toLowerCase().replace(/[\s\u3000]+/g, "");
}

/** 域名去掉 www/m/mobile 和 TLD 后的主干：x.com → x。解析失败返回 null。 */
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

  // 剥掉客气尾巴（「打开 youtube 吧」「帮我切到 x 谢谢」）。
  let previous: string;
  do {
    previous = target;
    target = target.replace(TRAILING_POLITENESS, "").trim();
  } while (target !== previous);

  target = target.replace(WRAPPERS, "").trim();

  // 只剩一个名词性目标才算数；任何附加动作或标点都交回完整路径。
  if (!target || target.length > 24) return null;
  if (EXTRA_CLAUSE.test(target)) return null;

  return { target };
}

/** 目标与唯一一个已开标签相符才返回它；零个或多个都返回 null（不猜）。 */
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
