import { isMemoryValidity, validLocalDate, validNotOnHosts, type MemoryValidity } from "./memory.js";

export interface TaskHistoryEntry {
  id: string;
  conversationId: string;
  goal: string;
  page?: string;
  revisions: string[];
  hosts: string[];
  outcome: "complete" | "partial" | "stopped" | "error";
  summary: string;
  done?: string;
  unfinished: string[];
  startedAt: number | null;
  endedAt: number;
  date?: string;
  validity?: MemoryValidity;
  useCount?: number;
  lastUsedAt?: number;
  notOnHosts?: string[];
  title?: string;
  next?: string;
}

const TASK_LABEL_MAX = 24;

export const TASK_HISTORY_MAX = 200;

const OUTCOMES = new Set(["complete", "partial", "stopped", "error"]);

function isTextList(value: unknown, max: number, each: number): value is string[] {
  if (!Array.isArray(value) || value.length > max) return false;

  for (const item of value) if (typeof item !== "string" || item.length > each) return false;

  return true;
}

export function validTaskLabel(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= TASK_LABEL_MAX && !/[\n\r]/.test(value);
}

export function isTaskHistoryEntry(value: unknown): value is TaskHistoryEntry {
  if (!value || typeof value !== "object") return false;
  // SAFETY: 只把它当成待核对的对象读字段，下面逐个检查类型后才返回 true。
  const e = value as TaskHistoryEntry;

  return typeof e.id === "string" && /^[a-zA-Z0-9_-]{1,96}$/.test(e.id)
    && typeof e.conversationId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(e.conversationId)
    && typeof e.goal === "string" && e.goal.length > 0 && e.goal.length <= 600
    && isTextList(e.revisions, 16, 600) && isTextList(e.hosts, 16, 253) && isTextList(e.unfinished, 16, 300)
    && OUTCOMES.has(e.outcome) && typeof e.summary === "string" && e.summary.length <= 600
    && (e.page === undefined || (typeof e.page === "string" && e.page.length <= 200))
    && (e.date === undefined || validLocalDate(e.date)) && (e.validity === undefined || isMemoryValidity(e.validity))
    && (e.useCount === undefined || (Number.isInteger(e.useCount) && e.useCount >= 0)) && (e.lastUsedAt === undefined || Number.isFinite(e.lastUsedAt))
    && (e.notOnHosts === undefined || validNotOnHosts(e.notOnHosts))
    && (e.done === undefined || (typeof e.done === "string" && e.done.length > 0 && e.done.length <= 200))
    && (e.title === undefined || validTaskLabel(e.title)) && (e.next === undefined || validTaskLabel(e.next))
    && (e.startedAt === null || Number.isFinite(e.startedAt)) && Number.isFinite(e.endedAt);
}
