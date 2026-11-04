import { redactCredentialText, wrapPageContent } from "../../shared/untrusted.js";
import { redactUrlCredentials } from "../../shared/network.js";

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

export function formatFetchReply(reply: FetchReply): string {
  const url = redactUrlCredentials(reply.url);
  const mediaType = reply.contentType.split(";", 1)[0]!.trim();
  const shownType = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(mediaType) ? mediaType : "unknown content-type";
  const head = `HTTP ${reply.status}${reply.ok ? "" : " (not ok)"} ${shownType}; ${reply.bytes} bytes${reply.truncated ? " (truncated at the extension cap; the rest was not read)" : ""}.`;
  const safe = redactCredentialText(reply.text).trim();
  const cut = safe.length > FETCH_BROWSER_INLINE_LIMIT;
  const note = ` Browser runtime: response not saved to a local file.${cut ? " Inline body truncated; use snapshot/read_element on the current page for the required section." : ""}`;

  return `${head}${note}\n${wrapPageContent(safe.slice(0, FETCH_BROWSER_INLINE_LIMIT), { url })}`;
}

export function fetchFailureReason(reply: FetchReply): string | null {
  if (reply.ok || reply.status === 0) return null;

  if (reply.status === 401 || reply.status === 403) return "要登录才能下";
  if (reply.status === 404) return "页面不存在（404）";
  if (reply.status >= 500) return `对方服务器出错（${reply.status}）`;

  return `没拿到内容（${reply.status}）`;
}
