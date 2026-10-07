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

/**
 * actionLabel 是句首动词，sentence 是它后面的宾语，party 是对象是谁。
 * 侧栏卡还用 url（出处页，取站点图标）和 seenAt（出处页什么时候看的，毫秒；当前页没有）写出处行。
 */
export type NudgeCard = { id: string; sentence: string; evidence: string; source: string; actionLabel: string; party?: string; url?: string; seenAt?: number };

const optional = (v: object, key: string, type: 'string' | 'number') => !(key in v) || (v as Record<string, unknown>)[key] === undefined || typeof (v as Record<string, unknown>)[key] === type;

/** 页面和侧栏收到的卡片来自消息或存储，字段先核对再显示。 */
export function isNudgeCard(v: unknown): v is NudgeCard {
  return !!v && typeof v === 'object'
    && 'id' in v && typeof v.id === 'string' && 'sentence' in v && typeof v.sentence === 'string'
    && 'evidence' in v && typeof v.evidence === 'string' && 'source' in v && typeof v.source === 'string'
    && 'actionLabel' in v && typeof v.actionLabel === 'string'
    && optional(v, 'party', 'string') && optional(v, 'url', 'string') && optional(v, 'seenAt', 'number');
}

/**
 * chrome.storage.session 键：侧栏开着时，建议卡不出在页角，而是放进侧栏对话流（YIS-106）。
 * 值是 { conversationId, card, at }，另带只有后台读的指令和出处页；只有后台 nudge.ts 写，侧栏点 × 或按动词后由后台删。
 * 放在存储里而不是后台内存：后台重启后卡还能按、还能收。
 */
export const NUDGE_PANEL_KEY = 'sideagent_nudge_panel';

/** at：出卡的时间（毫秒）。 */
export type NudgePanelOffer = { conversationId: string; card: NudgeCard; at: number };

/** 侧栏卡放久了就不再画：那一页多半早就不在看了。 */
export const NUDGE_PANEL_TTL_MS = 30 * 60_000;

export function isNudgePanelOffer(v: unknown): v is NudgePanelOffer {
  return !!v && typeof v === 'object' && 'conversationId' in v && typeof v.conversationId === 'string' && 'card' in v && isNudgeCard(v.card) && 'at' in v && typeof v.at === 'number';
}

/** 侧栏按动词后后台的回复：busy 是这个会话正有任务在做，offline 是没交给助手，gone 是这张卡已经不在了。 */
export type NudgePanelReply = { ok: true } | { ok: false; reason: 'busy' | 'offline' | 'gone' };

/** 页面或侧栏 → 后台：点了卡上的按钮（id 指向后台记着的那条建议）。 */
export const NUDGE_ACT = 'NUDGE_ACT';

/**
 * chrome.storage.session 键：点了卡上的按钮后，后台把建议的话放在这里，侧栏取走填进输入框（YIS-74：只填草稿，由用户发送）。
 * 侧栏可能还没打开，所以不用消息而用存储。
 */
export const NUDGE_DRAFT_KEY = 'sideagent_nudge_draft';

/** 页面或侧栏 → 后台：点了 ×，这一页本次会话不再建议。 */
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
