/**
 * 用户教过「以后我说 X，就打开这几个网址」：再说 X 时，宿主直接打开，不等模型。
 * 只认用户原话（来源原话）里的那句话和网址：模型写的记忆摘要可能改写措辞，网址也可能被它补全成别的。
 */
export interface SavedOpen { trigger: string; urls: string[] }

/** 「说 X」「提到 X」「听到 X」后面那句，引号可有可无；到「时 / 就 / ，」为止。 */
const TRIGGER = /(?:我说|说到|提到|听到|一说|说起)\s*[“"「『]?([^“”"「」『』，,。；;\n]{2,24}?)[”"」』]?\s*(?:的时候|时|，|,|就|你就)/u;

const URL = /https?:\/\/[^\s"'<>，。；、）)\]」”]+/gu;

const plain = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

export function parseSavedOpen(quote: string): SavedOpen | null {
  // 原话里有排除（「不要打开 b」「除了 c」）时，哪些网址算授权要靠理解整句：交给模型，宿主不自动打开。
  if (!/打开|open/i.test(quote) || /不要|别|不用|除了|除外|不包括|不含|except|don'?t|not\b/i.test(quote)) return null;
  const trigger = TRIGGER.exec(quote)?.[1]?.trim();
  const urls = [...new Set((quote.match(URL) ?? []).map(url => url.replace(/[.,]+$/, "")))].slice(0, 8);
  if (!trigger || plain(trigger).length < 2 || !urls.length) return null;
  return { trigger, urls };
}

/** 那句话之外只能有这些口头词；多出别的（「吗」「先别」「帮我总结」「改成」）就交给模型。 */
const FILLER = /听说|据说|好像|似乎|刚刚|刚才|今天|又|了|啊|呀|哦|噢|吧|嗯|诶|欸|哇|对了|好的|好|ok|okay/gu;

/** 用户这句话是不是正好在说那句话；带网址、说「记住 / 以后」的是在教或改这条做法，不算。 */
export function matchesSavedOpen(message: string, saved: SavedOpen): boolean {
  if (/https?:\/\//.test(message) || /记住|以后/.test(message)) return false;
  const said = plain(message), trigger = plain(saved.trigger);
  const at = said.indexOf(trigger);
  return at >= 0 && (said.slice(0, at) + said.slice(at + trigger.length)).replace(FILLER, "") === "";
}
