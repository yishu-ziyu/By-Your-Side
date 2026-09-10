/**
 * `fetch` 工具的执行：带浏览器登录态取接口。
 * 边界判定在 shared/fetch.ts（纯函数）；这里只负责发请求与读回。
 * 只读接口，不改页面；响应体经 RPC 回给伴随进程，不回侧栏。
 */
import { readCappedText, normalizeFetchRequest } from "../../../../shared/fetch.js";
import { oneLine } from "../util.js";

export interface FetchResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  truncated: boolean;
  text: string;
}

export async function fetchUrl(params: Record<string, unknown>): Promise<FetchResult> {
  const request = normalizeFetchRequest(params);
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      // 带登录态：扩展有 <all_urls> 主机权限，Cookie 只在扩展与目标站点之间流动。
      credentials: "include",
      redirect: "follow",
    });
  } catch (error) {
    throw new Error(`fetch 请求失败（未送达或网络错误）：${oneLine(error)}。不是页面结果，不要据此判断接口不存在。`);
  }
  const { text, bytes, truncated } = await readCappedText(response);
  return {
    url: response.url || request.url,
    status: response.status,
    ok: response.ok,
    contentType: response.headers.get("content-type") ?? "",
    bytes,
    truncated,
    text,
  };
}
