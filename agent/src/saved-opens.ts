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
  if (!/打开|open/i.test(quote)) return null;
  const trigger = TRIGGER.exec(quote)?.[1]?.trim();
  const urls = [...new Set((quote.match(URL) ?? []).map(url => url.replace(/[.,]+$/, "")))].slice(0, 8);
  if (!trigger || plain(trigger).length < 2 || !urls.length) return null;
  return { trigger, urls };
}

/**
 * 用户这句话是不是在说那句话：去掉标点后包含它，而且没有多出一件别的事（多出的字不超过 12 个）。
 * 带网址、又说「记住 / 以后」的是在教或改这条做法，不算；「新模型发布了，帮我总结 GPT 的变化」交给模型。
 */
export function matchesSavedOpen(message: string, saved: SavedOpen): boolean {
  if (/https?:\/\//.test(message) || /记住|以后|别再|不要|不用|取消|删掉/.test(message)) return false;
  const said = plain(message), trigger = plain(saved.trigger);
  return said.includes(trigger) && said.length - trigger.length <= 12;
}
