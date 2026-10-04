/**
 * 受信任网站：用户在读取/打开卡上点“以后这个网站不再问”授予（10-04，见 docs/evals/20261004-trusted-read-sites.md）。
 * 只免只看不动的动作：读当前页内容、截图、开新标签。写入、页面脚本、网络请求、在当前页跳转仍逐次批准。
 * 范围按整个域名，用公共后缀表计算：wikipedia.org 含各语言版；alice.github.io 与 bob.github.io 是两个网站。
 */
import { getDomain } from "tldts";

/** chrome.storage.local 键：只由侧栏确认卡（经后台）与设置页写入。 */
export const TRUSTED_SITES_KEY = "trustedReadSites";

/** 按当前页所在网站判断的读取动作。 */
export const TRUSTABLE_READ_TOOLS: ReadonlySet<string> = new Set(["snapshot", "read_element", "read_elements", "screenshot"]);

/** 网址所属的可信任单位；非 http(s)、IP、没有可注册域名的返回 null（永远逐次批准）。 */
export function siteOfUrl(url: string): string | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  return getDomain(parsed.hostname, { allowPrivateDomains: true }) ?? null;
}

/**
 * 这一步若可因信任免批，返回要核对的网站；否则 null。
 * openUrl：开新标签的目标网址；currentUrl：读取类动作执行时所在页面的网址。
 */
export function trustSiteFor(name: string, openUrl: string | undefined, currentUrl: string | undefined): string | null {
  if (name === "open_tab") return openUrl ? siteOfUrl(openUrl) : null;

  if (TRUSTABLE_READ_TOOLS.has(name)) return currentUrl ? siteOfUrl(currentUrl) : null;

  return null;
}

const isSiteName = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 253;

/** 存储里的列表：只认去重后的域名字符串，坏数据当空。 */
export function parseTrustedSites(value: {} | null | undefined): string[] {
  return Array.isArray(value) ? [...new Set(value.filter(isSiteName))] : [];
}
