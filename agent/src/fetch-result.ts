/**
 * `fetch` 回执的格式化：扩展里没有本机文件，响应正文有界内联，超出部分明确说截断。
 */
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { redactUrlCredentials } from "../../shared/network.js";

/** 内联给模型的正文上限；超出就截断并说明，不假装存了文件。 */
const FETCH_BROWSER_INLINE_LIMIT = 16_000;

export interface FetchReply {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

/** 模型可见回执：状态行 + 内容。内容一律过不可信边界与凭据隐去。 */
export function formatFetchReply(reply: FetchReply): string {
  // Response metadata is untrusted too: retain provenance without URL credentials
  // or arbitrary Content-Type parameters, including short/low-entropy secrets.
  const url = redactUrlCredentials(reply.url);
  const mediaType = reply.contentType.split(";", 1)[0]!.trim();
  const shownType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType) ? mediaType : "unknown content-type";
  const head = `HTTP ${reply.status}${reply.ok ? "" : " (not ok)"} ${shownType}; ${reply.bytes} bytes${reply.truncated ? " (truncated at the extension cap; the rest was not read)" : ""}.`;
  const safe = redactCredentialText(reply.text).trim();
  const cut = safe.length > FETCH_BROWSER_INLINE_LIMIT;
  const note = ` Browser runtime: response not saved to a local file.${cut ? " Inline body truncated; use snapshot/read_element on the current page for the required section." : ""}`;

  return `${head}${note}\n${wrapPageContent(safe.slice(0, FETCH_BROWSER_INLINE_LIMIT), { url })}`;
}

/**
 * fetch 回执的失败判定：对方答了非 2xx，这一步算失败，并给侧栏一句人话原因。
 * 不算失败的：2xx 但正文空（如 204），对方正常答了「没有内容」；status 0，扩展不跟随跳转（redirect:"manual"）时
 * 拿到的就是它，常见于 POST 成功后 302，当失败会让模型重交。网络错误不走这里，fetch-url.ts 直接抛错。返回 null 表示成功。
 */
export function fetchFailureReason(reply: FetchReply): string | null {
  if (reply.ok || reply.status === 0) return null;

  if (reply.status === 401 || reply.status === 403) return "要登录才能下";
  if (reply.status === 404) return "页面不存在（404）";
  if (reply.status >= 500) return `对方服务器出错（${reply.status}）`;

  return `没拿到内容（${reply.status}）`;
}
