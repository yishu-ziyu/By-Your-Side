import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { isProviderBusyError, isQuotaError } from "./user-facing.js";

type Completion = { stopReason: string; errorMessage?: string };

export function isTransientModelError(message: AssistantMessage): boolean {
  if (isQuotaError(message.errorMessage)) return false;

  return isRetryableAssistantError(message) || (message.stopReason === "error" && (isProviderBusyError(message.errorMessage) || /failed to fetch|runaway tool call/i.test(message.errorMessage ?? "")));
}

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
