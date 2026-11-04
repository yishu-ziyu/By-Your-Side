export interface BrowseDay { day: string; lines: string[]; hosts: string[] }

export interface BrowseHabit { key: string; habit: string; hosts: string[]; days: string[]; times: number; ready?: boolean }

export type BrowseHabitClientMessage =
  | { type: 'browse_habit_request'; requestId: string; days: BrowseDay[]; dismissed: string[] }
  | { type: 'browse_habit_ask'; requestId: string; key: string };

export type BrowseHabitResult = { type: 'browse_habit_result'; requestId: string; habits: BrowseHabit[] };

export const BROWSE_HABIT_DAYS = 2;

export const BROWSE_DAY_LIMIT = 14;

export const BROWSE_LINE_LIMIT = 300;

export const BROWSE_HABIT_LIMIT = 20;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

const id = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);

const short = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;

const BROWSE_HABIT_KEY = /^[a-z0-9][a-z0-9:.-]{1,63}$/;

export function isBrowseHabit(v: unknown): v is BrowseHabit {
  if (!v || typeof v !== 'object') return false;
  const h = v as Partial<BrowseHabit>;

  return typeof h.key === 'string' && BROWSE_HABIT_KEY.test(h.key) && short(h.habit, 80)
    && Array.isArray(h.hosts) && h.hosts.length <= 16 && h.hosts.every(host => short(host, 253))
    && Array.isArray(h.days) && h.days.length <= BROWSE_DAY_LIMIT && h.days.every(day => typeof day === 'string' && DAY.test(day))
    && typeof h.times === 'number' && Number.isSafeInteger(h.times) && h.times >= 0 && (h.ready === undefined || typeof h.ready === 'boolean');
}

export function isBrowseHabitClientMessage(v: BrowseHabitClientMessage): boolean {
  if (v.type === 'browse_habit_ask') return id(v.requestId) && typeof v.key === 'string' && BROWSE_HABIT_KEY.test(v.key);

  return id(v.requestId) && Array.isArray(v.days) && v.days.length <= BROWSE_DAY_LIMIT
    && v.days.every(d => !!d && typeof d.day === 'string' && DAY.test(d.day) && Array.isArray(d.lines) && d.lines.length <= BROWSE_LINE_LIMIT && d.lines.every(line => short(line, 400)) && Array.isArray(d.hosts) && d.hosts.length <= 200 && d.hosts.every(host => short(host, 253)))
    && Array.isArray(v.dismissed) && v.dismissed.length <= 500 && v.dismissed.every(key => typeof key === 'string' && BROWSE_HABIT_KEY.test(key));
}

export function isBrowseHabitResult(v: BrowseHabitResult): boolean {
  return id(v.requestId) && Array.isArray(v.habits) && v.habits.length <= BROWSE_HABIT_LIMIT && v.habits.every(isBrowseHabit);
}
