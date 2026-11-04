export interface SavedOpen { trigger: string; urls: string[] }

const TRIGGER = /(?:我说|说到|提到|听到|一说|说起)\s*[“"「『]?([^“”"「」『』，,。；;\n]{2,24}?)[”"」』]?\s*(?:的时候|时|，|,|就|你就)/u;

const URL = /https?:\/\/[^\s"'<>，。；、）)\]」”]+/gu;

const plain = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu, "");

export function parseSavedOpen(quote: string): SavedOpen | null {
  if (!/打开|open/i.test(quote) || /不要|别|不用|除了|除外|不包括|不含|except|don'?t|not\b/i.test(quote)) return null;
  const trigger = TRIGGER.exec(quote)?.[1]?.trim();
  const urls = [...new Set((quote.match(URL) ?? []).map(url => url.replace(/[.,]+$/, "")))].slice(0, 8);
  if (!trigger || plain(trigger).length < 2 || !urls.length) return null;
  return { trigger, urls };
}

const FILLER = /听说|据说|好像|似乎|刚刚|刚才|今天|又|了|啊|呀|哦|噢|吧|嗯|诶|欸|哇|对了|好的|好|ok|okay/gu;

export function matchesSavedOpen(message: string, saved: SavedOpen): boolean {
  if (/https?:\/\//.test(message) || /记住|以后/.test(message)) return false;
  const said = plain(message), trigger = plain(saved.trigger);
  const at = said.indexOf(trigger);
  return at >= 0 && (said.slice(0, at) + said.slice(at + trigger.length)).replace(FILLER, "") === "";
}
