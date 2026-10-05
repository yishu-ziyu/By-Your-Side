/** 主动建议卡（#52）：后台、内容脚本、设置页共用的消息与开关。 */

/** chrome.storage.local 键：是否开启主动建议。默认关，只有明确存了 true 才算开。 */
export const NUDGE_KEY = 'sideagent_nudge';

export function isNudgeOn(stored: unknown): stored is true {
  return stored === true;
}

/**
 * 页面 → 后台：这一页已在前台停留够久。interacted 表示用户滚动过或选过文字。
 * 回复 { again: true } 表示这次没判断（冷却中、任务在跑、没连上），之后有新动作可以再报。
 */
export const NUDGE_PAGE = 'NUDGE_PAGE';

export type NudgePageMessage = { type: typeof NUDGE_PAGE; title: string; text: string; selection?: string; interacted: boolean };

/** 后台 → 页面：显示一张建议卡。 */
export const NUDGE_SHOW = 'NUDGE_SHOW';

export type NudgeCard = { id: string; sentence: string; evidence: string; source: string; actionLabel: string };

/** 页面收到的卡片来自消息，字段先核对再显示。 */
export function isNudgeCard(v: unknown): v is NudgeCard {
  return !!v && typeof v === 'object'
    && 'id' in v && typeof v.id === 'string' && 'sentence' in v && typeof v.sentence === 'string'
    && 'evidence' in v && typeof v.evidence === 'string' && 'source' in v && typeof v.source === 'string'
    && 'actionLabel' in v && typeof v.actionLabel === 'string';
}

/** 页面 → 后台：点了卡上的按钮（id 指向后台记着的那条建议）。 */
export const NUDGE_ACT = 'NUDGE_ACT';

/** 页面 → 后台：点了 ×，这一页本次会话不再建议。 */
export const NUDGE_DISMISS = 'NUDGE_DISMISS';

/** 页面要在前台停留这么久，才算在读。 */
export const NUDGE_DWELL_MS = 15_000;

/** 两张卡之间至少隔这么久。 */
export const NUDGE_COOLDOWN_MS = 3 * 60_000;

/** 卡片不被悬停时多久自动收起。 */
export const NUDGE_AUTO_HIDE_MS = 12_000;

export function nudgeableUrl(raw: string | undefined): boolean {
  if (!raw) return false;

  try {
    const url = new URL(raw);

    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
