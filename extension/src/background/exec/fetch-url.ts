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
import { needsRequestConfirm } from "../../../../shared/request-confirm.js";

interface FetchResult {
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
  timingsMs: { confirmation: number; dispatch: number; response: number; body: number };
}

export async function fetchUrl(params: Record<string, unknown>, opts?: { signal?: AbortSignal; beforeDispatch?: (() => Promise<void>) & {checkNow?: () => void}; confirmPost?: (request: { url: string; body?: string }) => Promise<void> }): Promise<FetchResult & { sendConfirmed?: true }> {
  const request = normalizeFetchRequest(params);
  const started = performance.now();
  const confirmed = request.method !== "GET" && opts?.confirmPost && needsRequestConfirm(request) ? await opts.confirmPost({ url: request.url, body: request.body }).then(() => true, (error: unknown) => {
    throw error && typeof error === "object" && "executionFact" in error ? error : Object.assign(new Error(`POST 请求没能先问用户，没有发出：${oneLine(error)}`), { executionFact: "not_executed" as const });
  }) : false;
  const confirmation = Math.round(performance.now() - started);
  let dispatch = 0;
  let responseTime = 0;
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

      const dispatchStart = performance.now();
      await opts?.beforeDispatch?.();
      opts?.beforeDispatch?.checkNow?.();
      dispatch += performance.now() - dispatchStart;
      if (controller.signal.aborted) throw Object.assign(new Error("fetch 已取消，操作未执行。"), {executionFact: "not_executed"});
      try {
        dispatched = true;
        const responseStart = performance.now();
        response = await fetch(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          credentials: "include",
          redirect: "manual",
          signal: controller.signal,
        });
        responseTime += performance.now() - responseStart;
      } catch (error) {
        if (controller.signal.aborted) throw new Error(opts?.signal?.aborted ? "fetch 已取消，请求结果未知。" : `fetch 超时（${FETCH_READ_DEADLINE_MS / 1000} 秒没有回应），请求结果未知。`);
        throw new Error(`fetch 请求失败（送达情况未知或网络错误）：${oneLine(error)}。不是页面结果，不要据此判断接口不存在。`);
      }

      const next = redirectUrl(response, request.url);

      if (next) {
        hops += 1;

        if (hops > FETCH_MAX_REDIRECTS) throw new FetchRefused("fetch 重定向次数过多，后续请求未执行。");
        assertRedirectAllowed(request.url, next);
        if (request.method !== "GET" && !confirmed && opts?.confirmPost && needsRequestConfirm({ ...request, url: next })) throw new FetchRefused("POST 请求被重定向到需要用户确认的地址，后续请求未执行。");
        request.url = next;

        if (request.method === "GET") request.body = undefined;
        continue;
      }

      const bodyStart = performance.now();
      const capped = await readCappedText(response, FETCH_MAX_BYTES, {
        signal: controller.signal,
        deadlineMs: FETCH_READ_DEADLINE_MS,
      });

      return {
        ...(confirmed ? { sendConfirmed: true as const } : {}),
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
        timingsMs: { confirmation, dispatch: Math.round(dispatch), response: Math.round(responseTime), body: Math.round(performance.now() - bodyStart) },
      };
    }
  } catch (error) {
    if (!dispatched && error && typeof error === "object" && !("executionFact" in error)) throw Object.assign(error, { executionFact: "not_executed" as const });

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
