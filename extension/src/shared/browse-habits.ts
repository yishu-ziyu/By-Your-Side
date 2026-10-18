import { isBrowseHabit, type BrowseHabit } from '../../../shared/browse-habits.js';

/** 从用户自己的浏览里学习习惯：网页、后台、侧栏、设置页共用的键和消息。 */

/** chrome.storage.local：开关。默认开，只有明确存了 false 才算关（关掉＝暂停，已记的保留）。 */
export const BROWSE_ON_KEY = 'sideagent_browse_habits';

/** chrome.storage.local：操作记录 { events: BrowseEvent[], since: number, lastAt: number }，只有后台写。 */
export const BROWSE_LOG_KEY = 'sideagent_browse_log';

/** chrome.storage.local：最近一次归纳出的事 BrowseHabit[]，只有后台写；侧栏「看到的操作」照此显示。 */
export const BROWSE_FOUND_KEY = 'sideagent_browse_found';

/** chrome.storage.local：用户在「看到的操作」里删掉的 key：不再显示、不再问。 */
export const BROWSE_DISMISSED_KEY = 'sideagent_browse_dismissed';

/** 页面 → 后台：用户做了一步。 */
export const BROWSE_EVENT = 'BROWSE_EVENT';

export type BrowseStep =
  | { kind: 'visit'; title: string }
  | { kind: 'click'; label: string; href?: string }
  | { kind: 'fill'; label: string; value: string }
  | { kind: 'submit'; label: string; value: string };

/** 后台存的一步：line 是已经写成一行的人话，交给模型和侧栏都用它。 */
export interface BrowseEvent { at: number; day: string; host: string; line: string }

export const isBrowseOn = (stored: unknown) => stored !== false;

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

export function isBrowseStep(v: unknown): v is BrowseStep {
  if (!v || typeof v !== 'object' || !('kind' in v)) return false;
  const s = v as Record<string, unknown>;

  if (s.kind === 'visit') return text(s.title, 300);

  if (s.kind === 'click') return text(s.label, 120) && (s.href === undefined || text(s.href, 500));

  return (s.kind === 'fill' || s.kind === 'submit') && text(s.label, 120) && text(s.value, 200);
}

export function readBrowseEvents(v: unknown): BrowseEvent[] {
  const events = v && typeof v === 'object' && 'events' in v && Array.isArray(v.events) ? v.events : [];

  return events.filter((e): e is BrowseEvent => !!e && typeof e === 'object' && typeof e.at === 'number' && typeof e.day === 'string' && typeof e.host === 'string' && typeof e.line === 'string');
}

export function readBrowseFound(v: unknown): BrowseHabit[] {
  return Array.isArray(v) ? v.filter(isBrowseHabit) : [];
}

export function readDismissed(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : [];
}

/** 本地日期 YYYY-MM-DD。 */
export function localDay(at: number): string {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
