/**
 * 侧栏和宿主共用的等待上限。数字只在这里改；界面文案按类别说「等了多久」。
 *
 * 取值跟着人能感到的停顿：1 秒要有动静，10 秒要能插手，半分钟还没回音就换路。
 * 发送确认比工具期限短，总是确认先结束，避免点了「发送」却被记成结果未知。
 */

/** 点「发送」后用户多久没理就按不发处理。 */
export const SEND_CONFIRM_MS = 120_000;

/** 模型发出后还没有第一个事件（文字、思考、工具或结束）。 */
export const MODEL_FIRST_EVENT_MS = 15_000;

/** 服务端已受理、却一直不出内容。 */
export const MODEL_STALL_AFTER_START_MS = 10_000;

/** 流已经出过内容，随后这么久没有进展。 */
export const MODEL_STALL_MID_STREAM_MS = 30_000;

/** 能力表没登记时：原请求这么久没受理就再发一份相同请求。 */
export const MODEL_HEDGE_MS = 8_000;

/** 普通工具一步的上限。 */
export const TOOL_DEFAULT_MS = 30_000;

/** 打开页面、截图这类会等加载的工具。 */
export const TOOL_SLOW_MS = 60_000;

/** 等用户确认发送时，宿主放宽到的工具期限（比 SEND_CONFIRM_MS 长）。 */
export const TOOL_USER_CONFIRM_MS = 130_000;

/** fetch 读响应体的上限。 */
export const FETCH_READ_MS = 30_000;

export type TimeoutKind = "model" | "page" | "tool";

export interface TimeoutCopy {
  kind: TimeoutKind;
  title: string;
  copy: string;
  waitedSec: number;
  /** 请求可能已经发出、结果未知时为 false：重做可能重复提交。 */
  retry: boolean;
}

const SEC = (ms: number) => Math.max(1, Math.round(ms / 1000));

/** 超时原文 → 给用户看的一类说明。认不出就返回 null，由调用方说笼统的话。 */
export function describeTimeout(raw: string): TimeoutCopy | null {
  const text = raw.trim();
  if (!text) return null;

  const waited = Number((/(\d+(?:\.\d+)?)\s*(?:s|秒| ms|ms)\b/i.exec(text) ?? [])[1]);
  const ms = /ms\b/i.test(text) && Number.isFinite(waited) ? waited : Number.NaN;
  const sec = Number.isFinite(ms) ? SEC(ms) : Number.isFinite(waited) ? Math.max(1, Math.round(waited)) : 0;

  if (/结果未知|送达情况未知/.test(text)) {
    const n = sec || SEC(FETCH_READ_MS);
    return { kind: "page", title: "不知道做成没有", copy: `等了 ${n} 秒没有回音，请求可能已经发出。先看一眼网页上的结果，再决定要不要重做。`, waitedSec: n, retry: false };
  }

  if (/first response timeout|模型没有回应|accepted the request but sent nothing|sent nothing within/i.test(text)) {
    const n = sec || SEC(MODEL_FIRST_EVENT_MS);
    return { kind: "model", title: "模型没有回应", copy: `已经等了 ${n} 秒，模型还没有开始回答。可以重试，或换个方法。`, waitedSec: n, retry: true };
  }

  if (/stream idle timeout|sent nothing for \d+ s mid-response|模型中途没了声音/i.test(text)) {
    const n = sec || SEC(MODEL_STALL_MID_STREAM_MS);
    return { kind: "model", title: "模型中途没了声音", copy: `回答写到一半停住，已经 ${n} 秒没有新内容。可以重试，或换个方法。`, waitedSec: n, retry: true };
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
