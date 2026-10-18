/**
 * 从用户自己的浏览里发现习惯：扩展后台把按天整理的操作记录交给宿主，宿主用快速模型归纳出反复做的事。
 * 同一件事出现在 BROWSE_HABIT_DAYS 个不同日子里，就用「要我记住吗」问一次。
 */

/** 一天的记录：day 是本地日期 YYYY-MM-DD，lines 是这一天按时间排好的操作，一行一步。 */
export interface BrowseDay { day: string; lines: string[] }

/** 归纳出的一件事。days 只留记录里确实有、而且这件事涉及的网站在那天出现过的日子。 */
export interface BrowseHabit { key: string; habit: string; hosts: string[]; days: string[]; times: number }

export type BrowseHabitClientMessage = { type: 'browse_habit_request'; requestId: string; days: BrowseDay[]; dismissed: string[] };

export type BrowseHabitResult = { type: 'browse_habit_result'; requestId: string; habits: BrowseHabit[] };

export const BROWSE_HABIT_DAYS = 2;

export const BROWSE_DAY_LIMIT = 14;

export const BROWSE_LINE_LIMIT = 300;

export const BROWSE_HABIT_LIMIT = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

export const BROWSE_HABIT_KEY = /^[a-z0-9][a-z0-9:.-]{1,63}$/;

export function isBrowseHabit(v: unknown): v is BrowseHabit {
  if (!v || typeof v !== 'object') return false;
  const h = v as Partial<BrowseHabit>;

  return typeof h.key === 'string' && BROWSE_HABIT_KEY.test(h.key) && short(h.habit, 80)
    && Array.isArray(h.hosts) && h.hosts.length <= 16 && h.hosts.every(host => short(host, 253))
    && Array.isArray(h.days) && h.days.length <= BROWSE_DAY_LIMIT && h.days.every(day => typeof day === 'string' && DAY.test(day))
    && typeof h.times === 'number' && Number.isSafeInteger(h.times) && h.times >= 0;
}

export function isBrowseHabitClientMessage(v: BrowseHabitClientMessage): boolean {
  return id(v.requestId) && Array.isArray(v.days) && v.days.length <= BROWSE_DAY_LIMIT
    && v.days.every(d => !!d && typeof d.day === 'string' && DAY.test(d.day) && Array.isArray(d.lines) && d.lines.length <= BROWSE_LINE_LIMIT && d.lines.every(line => short(line, 400)))
    && Array.isArray(v.dismissed) && v.dismissed.length <= 500 && v.dismissed.every(key => typeof key === 'string' && BROWSE_HABIT_KEY.test(key));
}

export function isBrowseHabitResult(v: BrowseHabitResult): boolean {
  return id(v.requestId) && Array.isArray(v.habits) && v.habits.length <= BROWSE_HABIT_LIMIT && v.habits.every(isBrowseHabit);
}
