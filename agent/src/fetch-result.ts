/**
 * `fetch` 回执的格式化：扩展里没有本机文件，响应正文有界内联，超出部分明确说截断。
 * 依据 docs/evals/20260911-fetch-tool.md。
 */
import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { redactUrlCredentials } from "../../shared/network.js";

/** 内联给模型的正文上限；超出就截断并说明，不假装存了文件。 */
export const FETCH_BROWSER_INLINE_LIMIT = 16_000;

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
