/**
 * `fetch` 工具的执行：带浏览器登录态取接口。
 * 边界判定在 shared/fetch.ts（纯函数）；这里只负责发请求与流式读回。
 * 默认不跟随跨源重定向；响应按上限流式读取，不整份 arrayBuffer。
 */
import {
  FETCH_MAX_BYTES,
  FETCH_MAX_REDIRECTS,
  FETCH_READ_DEADLINE_MS,
  FetchRefused,
  assertRedirectAllowed,
  normalizeFetchRequest,
  readCappedText,
  redirectUrl,
} from "../../../../shared/fetch.js";
import { oneLine } from "../util.js";

export interface FetchResult {
  url: string;
  status: number;
  ok: boolean;
  contentType: string;
  bytes: number;
  readBytes: number;
  totalBytes: number | null;
  truncated: boolean;
  stoppedReason: "complete" | "limit" | "deadline" | "abort";
  text: string;
}

export async function fetchUrl(params: Record<string, unknown>, opts?: { signal?: AbortSignal; beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void} }): Promise<FetchResult> {
  const request = normalizeFetchRequest(params);
  let dispatched = false;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (opts?.signal?.aborted) controller.abort();
  opts?.signal?.addEventListener("abort", onAbort);
  const timer = setTimeout(() => controller.abort(), FETCH_READ_DEADLINE_MS);

  try {
    let hops = 0;

    for (;;) {
      let response: Response;

      await opts?.beforeDispatch?.();
      opts?.beforeDispatch?.checkNow?.();
      if (controller.signal.aborted) throw Object.assign(new Error("fetch 已取消，操作未执行。"), {executionFact: "not_executed"});
      try {
        dispatched = true;
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: "include",
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) throw new Error("fetch 已取消或超时，请求结果未知。");
        throw new Error(`fetch 请求失败（送达情况未知或网络错误）：${oneLine(error)}。不是页面结果，不要据此判断接口不存在。`);
      }

      const next = redirectUrl(response, request.url);
      if (next && opts?.beforeDispatch) throw new Error("重定向目标未经单独展示批准，请以新URL重新请求；首请求已发送，结果未知。");

      if (next) {
        hops += 1;

        if (hops > FETCH_MAX_REDIRECTS) throw new FetchRefused("fetch 重定向次数过多，后续请求未执行。");
        assertRedirectAllowed(request.url, next);
        // 重定向累计在同一份 request 上原地改，避免每跳都复制一份对象。
        request.url = next;

        if (request.method === "GET") request.body = undefined;
        continue;
      }

      const capped = await readCappedText(response, FETCH_MAX_BYTES, {
        signal: controller.signal,
        deadlineMs: FETCH_READ_DEADLINE_MS,
      });

      return {
        url: response.url || request.url,
        status: response.status,
        ok: response.ok,
        contentType: response.headers.get("content-type") ?? "",
        bytes: capped.retainedBytes,
        readBytes: capped.readBytes,
        totalBytes: capped.totalBytes,
        truncated: capped.truncated,
        stoppedReason: capped.stoppedReason,
        text: capped.text,
      };
    }
  } catch (error) {
    if (dispatched) {
      const detail = oneLine(error).replace(/操作未执行/g, "后续请求未执行");
      throw Object.assign(new Error(`fetch 请求已发出，结果未知：${detail}`), {executionFact: "unknown"});
    }
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onAbort);
  }
}
