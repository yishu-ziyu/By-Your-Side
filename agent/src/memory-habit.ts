interface HabitObservation {
  key: string;
  text: string;
  conversationId: string;
  at: number;
}

interface Habit {
  text: string;
  seen: Record<string, number>;
  closed?: boolean;
  last: number;
}

export interface HabitState {
  habits: Record<string, Habit>;
}

interface HabitAsk {
  key: string;
  text: string;
}

const DISTINCT_CONVERSATIONS = 3;

const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_KEYS = 200;

export function emptyHabitState(): HabitState {
  return { habits: {} };
}

interface HabitStep {
  state: HabitState;
  ask: HabitAsk | null;
}

export function observe(state: HabitState, obs: HabitObservation): HabitStep {
  const old = state.habits[obs.key];
  const seen: Record<string, number> = {};

  for (const [id, at] of Object.entries(old?.seen ?? {})) if (obs.at - at <= EXPIRE_MS) seen[id] = at;
  seen[obs.conversationId] = obs.at;
  const ask = !old?.closed && Object.keys(seen).length >= DISTINCT_CONVERSATIONS;
  const habit: Habit = { text: obs.text, seen, last: obs.at };

  if (old?.closed || ask) habit.closed = true;

  return { state: trim({ habits: { ...state.habits, [obs.key]: habit } }), ask: ask ? { key: obs.key, text: obs.text } : null };
}

export function dismiss(state: HabitState, key: string, at = 0): HabitState {
  const old = state.habits[key];
  const habit: Habit = old ? { ...old, closed: true } : { text: "", seen: {}, closed: true, last: at };

  return trim({ habits: { ...state.habits, [key]: habit } });
}

function trim(state: HabitState): HabitState {
  const keys = Object.keys(state.habits);

  if (keys.length <= MAX_KEYS) return state;
  keys.sort((a, b) => (state.habits[a]?.last ?? 0) - (state.habits[b]?.last ?? 0));
  const drop = new Set(keys.slice(0, keys.length - MAX_KEYS));

  return { habits: Object.fromEntries(Object.entries(state.habits).filter(([k]) => !drop.has(k))) };
}
