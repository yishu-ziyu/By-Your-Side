/**
 * 习惯计数：同一偏好出现在 3 个不同对话里，才提出「你好像总是…，要我记住吗」。
 * 纯逻辑，不读时钟（时间由调用方的 `at` 给出），状态是纯 JSON，可直接存取。
 * 习惯不会自动保存；问过或被拒绝的 key 不再问。
 */

export interface HabitObservation {
  key: string;
  text: string;
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
const EXPIRE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_KEYS = 200;

export function emptyHabitState(): HabitState {
  return { habits: {} };
}

export function observe(state: HabitState, obs: HabitObservation): { state: HabitState; ask: HabitAsk | null } {
  const old = state.habits[obs.key];
  const seen: Record<string, number> = {};
  for (const [id, at] of Object.entries(old?.seen ?? {})) {
    if (obs.at - at <= EXPIRE_MS) seen[id] = at; // 过期的观察不再计数
  }
  seen[obs.conversationId] = obs.at;
  const closed = old?.closed;
  const ask = !closed && Object.keys(seen).length >= DISTINCT_CONVERSATIONS;
  const habit: Habit = { text: obs.text, seen, last: obs.at, ...(closed || ask ? { closed: true } : {}) };
  return { state: trim({ habits: { ...state.habits, [obs.key]: habit } }), ask: ask ? { key: obs.key, text: obs.text } : null };
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
  keys.sort((a, b) => state.habits[a].last - state.habits[b].last);
  const drop = new Set(keys.slice(0, keys.length - MAX_KEYS));
  return { habits: Object.fromEntries(Object.entries(state.habits).filter(([k]) => !drop.has(k))) };
}
