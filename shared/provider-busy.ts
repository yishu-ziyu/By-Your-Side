import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

/**
 * 服务商「忙」：限流（429）或同账号同时请求数超限。等一下再试就能好，不能当失败交给用户。
 * 实测 2026-09-27：Kimi 编程套餐在主模型与快速模型（记忆判断）同时请求时回 403「concurrent request limit」，
 * 原来的自动重试不认它，接续的那一轮直接空着结束。
 */
export function isProviderBusyError(message: string | undefined): boolean {
  return !!message && /concurrent request limit|too many concurrent|rate.?limit|\b429\b|overloaded|请求过于频繁|并发/i.test(message);
}

type Completion = { stopReason: string; errorMessage?: string };

/**
 * 模型调用的暂时失败（服务忙、5xx、网络断）：主任务据此重试或换快速模型。
 * pi-ai 只认 Node 的「fetch failed」；扩展跑在 Chrome 里，断网报「Failed to fetch」（10-06 实测，代理断开连接时整轮直接报错）。
 */
export function isTransientModelError(message: AssistantMessage): boolean {
  return isRetryableAssistantError(message) || (message.stopReason === "error" && (isProviderBusyError(message.errorMessage) || /failed to fetch/i.test(message.errorMessage ?? "")));
}

/** 快速模型的短调用（记忆判断、目标核对、接续判断）遇到「忙」时等 1.5 s、3 s 各再试一次。 */
export async function retryWhenBusy<T extends Completion>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  let result = await run();

  for (const delayMs of [1_500, 3_000]) {
    if (result.stopReason !== "error" || !isProviderBusyError(result.errorMessage) || signal?.aborted) return result;
    await new Promise<void>((done) => {
      const timer = setTimeout(done, delayMs);
      signal?.addEventListener("abort", () => { clearTimeout(timer); done(); }, { once: true });
    });

    if (signal?.aborted) return result;
    result = await run();
  }

  return result;
}
