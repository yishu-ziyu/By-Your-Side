/**
 * 习惯计数：同一偏好出现在 3 个不同对话里（来自用户自己的浏览时是 2 个不同日子），才提出「你好像每次都这样做：…。要我记住吗」。
 * 纯逻辑，不读时钟（时间由调用方的 `at` 给出），状态是纯 JSON，可直接存取。
 * 习惯不会自动保存；问过或被拒绝的 key 不再问。
 */

export interface HabitObservation {
  key: string;
  text: string;
  /** 计数单位：对话 id，或用户自己浏览的那一天（`day:YYYY-MM-DD`）。 */
  conversationId: string;
  at: number;
}

interface Habit {
  text: string;
  /** 对话 id -> 该对话里最近一次出现的时间 */
  seen: Record<string, number>;
  /** 已问过或已拒绝，不再问 */
  closed?: boolean;
  /** 最近一次更新时间，用于超出上限时丢最旧的 */
  last: number;
}

export interface HabitState {
  habits: Record<string, Habit>;
}

export interface HabitAsk {
  key: string;
  text: string;
}

const DISTINCT_CONVERSATIONS = 3;

/** 用户自己浏览的那一天作为计数单位时的前缀。 */
export const BROWSING_DAY = "day:";

const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;

const MAX_KEYS = 200;

export function emptyHabitState(): HabitState {
  return { habits: {} };
}

/** 一次观察的结果：新状态，以及这次要不要问。 */
export interface HabitStep {
  state: HabitState;
  ask: HabitAsk | null;
}

export function observe(state: HabitState, obs: HabitObservation, need = DISTINCT_CONVERSATIONS): HabitStep {
  const old = state.habits[obs.key];
  const seen: Record<string, number> = {};

  // 过期的观察不再计数。
  for (const [id, at] of Object.entries(old?.seen ?? {})) if (obs.at - at <= EXPIRE_MS) seen[id] = at;
  seen[obs.conversationId] = obs.at;
  // 对话和浏览的日子各数各的：混在一起会让 1 个对话 + 1 天浏览就够数。
  const browsing = obs.conversationId.startsWith(BROWSING_DAY);
  const ask = !old?.closed && Object.keys(seen).filter(id => id.startsWith(BROWSING_DAY) === browsing).length >= need;
  const habit: Habit = { text: obs.text, seen, last: obs.at };

  if (old?.closed || ask) habit.closed = true;

  return { state: trim({ habits: { ...state.habits, [obs.key]: habit } }), ask: ask ? { key: obs.key, text: obs.text } : null };
}

/** 数够了、还没问过：只看和 unit 同一来源（对话或浏览的日子）的计数。 */
export function habitReady(state: HabitState, key: string, browsing: boolean, need: number): boolean {
  const habit = state.habits[key];

  return !!habit && !habit.closed && Object.keys(habit.seen).filter(id => id.startsWith(BROWSING_DAY) === browsing).length >= need;
}

/** 问过了：之后不再问这个 key。 */
export function close(state: HabitState, key: string): HabitState {
  const habit = state.habits[key];

  return habit ? { habits: { ...state.habits, [key]: { ...habit, closed: true } } } : state;
}

/** 用户删了浏览记录：去掉浏览的日子，对话的计数不动。key 为 null 时所有习惯都去掉。 */
export function forgetBrowsing(state: HabitState, key: string | null): HabitState {
  const habits = Object.fromEntries(Object.entries(state.habits).map(([k, habit]) => key !== null && k !== key ? [k, habit]
    : [k, { ...habit, seen: Object.fromEntries(Object.entries(habit.seen).filter(([id]) => !id.startsWith(BROWSING_DAY))) }]));

  return { habits };
}

/** 用户回答「不要」：之后不再问这个 key。 */
export function dismiss(state: HabitState, key: string): HabitState {
  const old = state.habits[key];
  const habit: Habit = old ? { ...old, closed: true } : { text: "", seen: {}, closed: true, last: 0 };

  return trim({ habits: { ...state.habits, [key]: habit } });
}

function trim(state: HabitState): HabitState {
  const keys = Object.keys(state.habits);

  if (keys.length <= MAX_KEYS) return state;
  keys.sort((a, b) => (state.habits[a]?.last ?? 0) - (state.habits[b]?.last ?? 0));
  const drop = new Set(keys.slice(0, keys.length - MAX_KEYS));

  return { habits: Object.fromEntries(Object.entries(state.habits).filter(([k]) => !drop.has(k))) };
}
