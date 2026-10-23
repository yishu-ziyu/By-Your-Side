export type SiteName = "youtube" | "bilibili" | "x" | "flomo";

export interface SiteMethod {
  id: string;
  site: SiteName;
  version: number;
  purpose: string;
  operation: "search" | "captions" | "post" | "write";
  inputs: readonly string[];
  outcome: string;
}

/** Release-owned methods are separate from unverified notes learned from page content. */
export const SITE_METHODS: readonly SiteMethod[] = [
  { id: "youtube.search", site: "youtube", version: 1, purpose: "Search YouTube videos", operation: "search", inputs: ["query"], outcome: "The results page contains the requested query; read actual results before choosing a video." },
  { id: "youtube.captions", site: "youtube", version: 1, purpose: "Read the current YouTube video's caption tracks", operation: "captions", inputs: ["language (optional code such as en or zh-CN; pass the language the user asked for)"], outcome: "Tracks belong to the current video; no captions and unavailable evidence are separate outcomes." },
  { id: "bilibili.search", site: "bilibili", version: 1, purpose: "Search Bilibili videos", operation: "search", inputs: ["query"], outcome: "The results page contains the requested query; read actual results before choosing a video." },
  { id: "bilibili.captions", site: "bilibili", version: 1, purpose: "Read the current Bilibili video's caption tracks", operation: "captions", inputs: ["language (optional code such as en or zh-CN; pass the language the user asked for)"], outcome: "Only the current video's player data is used; do not guess unsigned player API addresses." },
  { id: "x.search", site: "x", version: 1, purpose: "Search public posts on X", operation: "search", inputs: ["query"], outcome: "Read results or report a login/access barrier; opening the search URL alone is not success." },
  { id: "x.read-post", site: "x", version: 1, purpose: "Read the specific X post open in this tab", operation: "post", inputs: [], outcome: "The post permalink matches the page's status ID; recommendations and replies are not the requested post." },
  { id: "flomo.add-memo", site: "flomo", version: 1, purpose: "Save a new memo to the user's flomo (opens flomo in a new tab when needed)", operation: "write", inputs: ["text (the memo exactly as the user wants it saved)", "source (optional true: the method appends the title and link of the page the user is reading)"], outcome: "observed only when the new memo is read back from the user's memo list; unconfirmed means do not send again, tell the user to check flomo." },
];

export function siteOfUrl(value: string): SiteName | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const domain = (name: string) => host === name || host.endsWith(`.${name}`);
  if (domain("youtube.com") || host === "youtu.be") return "youtube";
  if (domain("bilibili.com")) return "bilibili";
  if (domain("x.com") || domain("twitter.com")) return "x";
  if (domain("flomoapp.com")) return "flomo";
  return null;
}

export function siteMethodsFor(value: string): readonly SiteMethod[] {
  const site = siteOfUrl(value);
  return site ? SITE_METHODS.filter(method => method.site === site) : [];
}

/** 「记下来」记到哪里：flomo 一条笔记、记忆里一条「对……感兴趣」，或两个都记。 */
export interface RecordIntent { flomo: boolean; memory: boolean; /** 用户点名了 flomo 或记忆。 */ named: boolean }

const NAMES_FLOMO = /flomo|浮墨/i;
const NAMES_MEMORY = /记住|记(?:在|到|进)\s*(?:你的)?记忆|\bremember\b/i;
const RECORD_VERB = /记下|记一下|记一笔|记录(?:下来|一下)|帮我记|存下来|note (?:this|it|that) down|write (?:this|it|that) down/i;
const NOT_RECORD = /(?:不用|不要|别|无需|不必)(?:再)?(?:帮我)?(?:记|存)/;
/** 点名了 flomo 和记忆以外的地方（备忘录、Notion、文档）：不是这里的默认去处。 */
const OTHER_PLACE = /(?:记|存)(?:到|进|在|入)(?!\s*(?:flomo|浮墨|记忆|你的记忆|这|那|里|下))\s*\S/i;
/** 电话、账号、地址这类个人资料：照记忆原有的规矩处理，不额外写成兴趣。 */
const PERSONAL_DATA = /电话|手机|号码|邮箱|地址|密码|口令|验证码|身份证|护照|银行卡|卡号|账号|@|\d{5,}/;

/**
 * 用户直接说的这句里有没有「记下来」：没点名去处时 flomo 和记忆两个都记（用户 10-23 定）；
 * 点名 flomo 只记 flomo，点名记忆只记记忆。点名别处、否定或不是在要求记，返回 null。
 */
export function recordIntent(text: string): RecordIntent | null {
  if (!text.trim() || NOT_RECORD.test(text)) return null;
  const flomo = NAMES_FLOMO.test(text), memory = NAMES_MEMORY.test(text);
  if (flomo || memory) return flomo || !PERSONAL_DATA.test(text) ? { flomo, memory: memory && !PERSONAL_DATA.test(text), named: true } : null;
  if (!RECORD_VERB.test(text) || OTHER_PLACE.test(text)) return null;
  return { flomo: true, memory: !PERSONAL_DATA.test(text), named: false };
}

/** 不在这个网站上、但这句话要用到的服务：任务开始时也提供它的方法（「记进 flomo」，或没说去处的「记下来」）。 */
export function mentionedServiceUrls(text: string): string[] {
  return NAMES_FLOMO.test(text) || recordIntent(text)?.flomo ? ["https://v.flomoapp.com/mine"] : [];
}

export function siteMethodHint(value: string): string | null {
  const methods = siteMethodsFor(value);
  if (!methods.length) return null;
  const input = methods[0]!.inputs[0]?.split(" ")[0];
  return `# Built-in website methods\nUse a matching method through browser_run: await browser.siteMethod({id:"${methods[0]!.id}"${input ? `,${input}:"..."` : ""}}). Methods are bundled with this extension, use the normal browser permissions, and verify the current site before acting. Read methods accept optional tabId; searches act on the current working tab. Only use a method when its purpose matches the user's request. Inspect its outcome and source; unavailable/partial results are not completion. If it fails, observe the page and change approach rather than repeating it.\n` + methods.map(method => `- ${method.id} v${method.version}: ${method.purpose}; inputs: ${method.inputs.join(", ") || "none"}; verify: ${method.outcome}`).join("\n");
}
