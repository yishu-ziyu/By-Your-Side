import { isBrowseHabit, type BrowseHabit } from '../../../shared/browse-habits.js';

export const BROWSE_ON_KEY = 'sideagent_browse_habits';
export const BROWSE_INDUCE_AFTER_STEPS = 5;
export const BROWSE_INDUCE_EVERY_MS = 30 * 60_000;

export const BROWSE_LOG_KEY = 'sideagent_browse_log';

export const BROWSE_FOUND_KEY = 'sideagent_browse_found';

export const BROWSE_DISMISSED_KEY = 'sideagent_browse_dismissed';

export const BROWSE_EVENT = 'BROWSE_EVENT';

export const BROWSE_CONTROL = 'BROWSE_CONTROL';

export type BrowseStep =
  | { kind: 'visit'; title: string }
  | { kind: 'click'; label: string; href?: string }
  | { kind: 'fill'; label: string; value: string }
  | { kind: 'submit'; label: string; value: string };

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

export function localDay(at: number): string {
  const d = new Date(at);

  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
