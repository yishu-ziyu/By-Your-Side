export const SEND_CONFIRM_MS = 120_000;

export const MODEL_FIRST_EVENT_MS = 15_000;

export const MODEL_STALL_AFTER_START_MS = 10_000;

export const MODEL_STALL_MID_STREAM_MS = 30_000;

export const MODEL_HEDGE_MS = 8_000;

export const TOOL_DEFAULT_MS = 30_000;

export const TOOL_SLOW_MS = 60_000;

export const TOOL_USER_CONFIRM_MS = 130_000;

export const FETCH_READ_MS = 30_000;

export function programDeadlineExpired(deadline: number | undefined, now: number): boolean {
  return deadline !== undefined && now >= deadline;
}

export type TimeoutKind = "model" | "page" | "tool";

export interface TimeoutCopy {
  kind: TimeoutKind;
  title: string;
  copy: string;
  waitedSec: number;
  retry: boolean;
}

const SEC = (ms: number) => Math.max(1, Math.round(ms / 1000));

export function describeTimeout(raw: string): TimeoutCopy | null {
  const text = raw.trim();
  if (!text) return null;

  const waited = Number((/(\d+(?:\.\d+)?)\s*(?:s|秒| ms|ms)\b/i.exec(text) ?? [])[1]);
  const ms = /ms\b/i.test(text) && Number.isFinite(waited) ? waited : Number.NaN;
  const sec = Number.isFinite(ms) ? SEC(ms) : Number.isFinite(waited) ? Math.max(1, Math.round(waited)) : 0;

  if (/结果未知|送达情况未知/.test(text) && /超时|timed out|timeout|没有回应/i.test(text)) {
    const n = sec || SEC(FETCH_READ_MS);
    return { kind: "page", title: "不知道做成没有", copy: `等了 ${n} 秒没有回音，请求可能已经发出。先看一眼网页上的结果，再决定要不要重做。`, waitedSec: n, retry: false };
  }

  if (/first response timeout|模型没有回应|accepted the request but sent nothing|sent nothing within/i.test(text)) {
    const n = sec || SEC(MODEL_FIRST_EVENT_MS);
    return { kind: "model", title: "模型没有回应", copy: `已经等了 ${n} 秒，模型还没有开始回答。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  if (/stream idle timeout|sent nothing for \d+ s mid-response|模型中途没了声音/i.test(text)) {
    const n = sec || SEC(MODEL_STALL_MID_STREAM_MS);
    return { kind: "model", title: "模型中途没了声音", copy: `回答写到一半断了，已经 ${n} 秒没有新内容。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  if (/Tool call ".+" timed out after|这一步超时了/i.test(text) || /工具.{0,6}超时/i.test(text)) {
    const n = sec || SEC(TOOL_DEFAULT_MS);
    return { kind: "tool", title: "这一步超时了", copy: `已经等了 ${n} 秒，这一步还没有结果。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  if (/fetch 超时|FETCH_READ|没有回应/i.test(text) && /fetch|网页|页面|网站/i.test(text)) {
    const n = sec || SEC(FETCH_READ_MS);
    return { kind: "page", title: "网页没有回应", copy: `已经等了 ${n} 秒，这个地址还没有回。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  if (/timed out|超时/i.test(text)) {
    const n = sec || SEC(TOOL_DEFAULT_MS);
    return { kind: "tool", title: "等太久了", copy: `已经等了 ${n} 秒还没有结果。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  return null;
}
