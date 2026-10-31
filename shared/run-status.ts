/**
 * 过程行给人看的那一句：正在做什么、已经几秒、卡住时怎么说。
 * 时钟从外面传入，方便假时钟验收。
 */

/** 有动作就要写出秒数：人在 1 秒内要知道系统还在。 */
export const LIVE_SHOW_MS = 1_000;

/** 超过这个要能插手：跳过或换方法。 */
export const LIVE_ESCALATE_MS = 10_000;

/** 失败步很少、或一步都没有时，不占第二行。 */
export const RUN_META_MIN_STEPS = 2;

export interface LiveStatus {
  title: string;
  time: string;
  escalated: boolean;
}

export function liveStatus(input: { step?: string; from?: number; now: number }): LiveStatus | null {
  if (!Number.isFinite(input.from)) return null;
  const from = input.from!;
  const ms = input.now - from;
  if (ms < 0) return null;
  const sec = Math.max(0, Math.round(ms / 1000));
  const step = (input.step ?? "思考").trim() || "思考";
  const time = sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;

  if (ms > LIVE_ESCALATE_MS) {
    return { title: "仍在处理", time: `已 ${time}`, escalated: true };
  }

  return { title: `正在：${step}`, time, escalated: false };
}

/** 默认折叠的那一行。没有失败或步数太少时不写。 */
export function runMetaLine(done: number, failed: number): string | null {
  if (failed <= 0 || done < RUN_META_MIN_STEPS) return null;
  return `已试了 ${done} 步，其中 ${failed} 次没做成，已换别的方法`;
}

export const STEER_SKIP = "跳过这一步，继续后面的。";
export const STEER_OTHER_WAY = "刚才这一步换个方法，不要再重复同样的做法。";
