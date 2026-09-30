import { isMemoryValidity, validLocalDate, type MemoryValidity } from "./memory.js";

/**
 * 过往任务：每个动手做过事的任务结束时留一条摘要，助手之后能想起「之前做过什么、在哪做的、做成没有」。
 * 只存在本机（扩展 IndexedDB / 本机宿主文件），侧栏「技能与记忆 → 过往任务」可删除。
 */
export interface TaskHistoryEntry {
  /** 任务的 runId；同一任务接着做时覆盖同一条 */
  id: string;
  conversationId: string;
  /** 用户原话目标 */
  goal: string;
  /** 说出目标时所在页面的标题：「订阅这个页面的邮件」里的「这个页面」。旧条目缺省。 */
  page?: string;
  /** 目标之后的补充（原话） */
  revisions: string[];
  /** 任务涉及的网站主机名 */
  hosts: string[];
  outcome: "complete" | "partial" | "stopped" | "error";
  /** 最后给用户的回答，截短 */
  summary: string;
  /** 没做完的事（用户口吻） */
  unfinished: string[];
  startedAt: number | null;
  endedAt: number;
  /** 结果关联的日子（本地日期 YYYY-MM-DD），如订的机票是哪天飞；任务结束时判断，旧条目与无日期的任务缺省。 */
  date?: string;
  /** 有效期：到那天结束前每轮都带给助手；缺省时只在当前网站或被问起时带。 */
  validity?: MemoryValidity;
  /** 被带给助手的次数与最近一次时间；旧条目缺省为没用过。 */
  useCount?: number;
  lastUsedAt?: number;
}

export const TASK_HISTORY_MAX = 200;

const OUTCOMES = new Set(["complete", "partial", "stopped", "error"]);

function isTextList(value: unknown, max: number, each: number): value is string[] {
  if (!Array.isArray(value) || value.length > max) return false;

  for (const item of value) if (typeof item !== "string" || item.length > each) return false;

  return true;
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
    && (e.startedAt === null || Number.isFinite(e.startedAt)) && Number.isFinite(e.endedAt);
}
