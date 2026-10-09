import { normalizeMemoryHostname, withNotOnHost } from "../../shared/memory.js";
import { isTaskHistoryEntry, TASK_HISTORY_MAX, type TaskHistoryEntry } from "../../shared/task-history.js";
import type { DocumentPersistence } from "./document-persistence.js";
import { isRelevantMemory } from "./memory-relevance.js";

/** 过往任务里替代密码、验证码、卡号等具体值的文字。 */
export const TASK_SECRET_PLACEHOLDER = "（已隐去）";

/**
 * 密码类关键词后面跟着分隔（是 / 为 / 应该是 / 改成 / 冒号 / 空格）的那个值，例如「密码应该是 Abc12345」里的 Abc12345。
 * 只提到关键词、后面没有值的（「忘记密码的入口」「需要你提供短信验证码」）不算；值至少要有一个字母或数字（「密码是什么」不算）。
 */
const SECRET_KEYWORD = "(?:密码|口令|验证码|校验码|动态码|安全码|(?<![A-Za-z])(?:cvv|password|passcode|passwd|pin|otp|code)(?![A-Za-z]))";

const SECRET_AFTER_KEYWORD = new RegExp(`${SECRET_KEYWORD}(?:\\s*(?:应该是|应当是|应该|改成|改为|换成|是|为|[:：=]))+\\s*|${SECRET_KEYWORD}\\s+`, "giu");

const VALUE_TOKEN = /^[^\s，。,；;！!？?、）)】]+/u;

/** 卡号、证件号：15–19 位数字，且前面不远处就是卡、证件的关键词；订单号等别的长数字不动。 */
const CARD_NUMBER = /(?:银行卡|借记卡|信用卡|卡号|身份证号?|证件号|护照号?)[^\d]{0,12}?(\d(?:[\s-]?\d){14,18})(?!\d)/gu;

/** 用户原话里的秘密值：密码类关键词后的值与卡号证件号。 */
function secretValues(text: string): string[] {
  const values: string[] = [];

  for (const match of text.matchAll(SECRET_AFTER_KEYWORD)) {
    const value = VALUE_TOKEN.exec(text.slice(match.index + match[0].length))?.[0];

    if (value && /[A-Za-z0-9]/u.test(value)) values.push(value);
  }

  for (const match of text.matchAll(CARD_NUMBER)) values.push(match[1]!);

  return values;
}

/**
 * 过往任务不留密码、验证码、卡号这类具体值（记忆模型规则 2）：只把值换成「（已隐去）」，其余文字照常留下。
 * 值只从用户的话（目标、补充）里找；摘要、页面标题、没做完的事只换掉其中复述的这些值，不按关键词整段删。
 */
export function redactTaskSecrets(entry: TaskHistoryEntry): TaskHistoryEntry {
  const values = [...new Set([entry.goal, ...entry.revisions].flatMap(secretValues))].sort((a, b) => b.length - a.length);

  if (!values.length) return entry;
  const scrub = (text: string) => values.reduce((out, value) => out.split(value).join(TASK_SECRET_PLACEHOLDER), text);
  const redacted: TaskHistoryEntry = { ...entry, goal: scrub(entry.goal), revisions: entry.revisions.map(scrub), summary: scrub(entry.summary), unfinished: entry.unfinished.map(scrub) };

  if (entry.page !== undefined) redacted.page = scrub(entry.page);

  return redacted;
}

/** 旧版「照上次的做法」（YIS-105 已删）在条目里存的 route：存档里原样留着，读出时去掉，不给模型、侧栏或别处。 */
function withoutRoute(task: TaskHistoryEntry): TaskHistoryEntry {
  if (!("route" in task)) return task;
  // SAFETY: 只去掉旧字段 route；其余字段已由 isTaskHistoryEntry 核对。
  const { route: _old, ...rest } = task as TaskHistoryEntry & { route?: unknown };

  return rest;
}

/** 本机宿主的过往任务文件名；扩展版存在 IndexedDB 里，格式相同。 */
export const TASK_HISTORY_FILE = "tasks.json";

interface HistoryFile { format: 1; tasks: TaskHistoryEntry[] }

/** 过往任务：整份存取，按结束时间从新到旧，超过上限丢最旧的。 */
export class TaskHistoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<TaskHistoryEntry[]> {
    return (await this.read()).map(withoutRoute).sort((a, b) => b.endedAt - a.endedAt);
  }

  /** 同一任务（同一 runId）接着做完时覆盖原条目；用过次数与时间沿用，新条目没带日期时沿用原日期与有效期。 */
  async record(entry: TaskHistoryEntry): Promise<void> {
    if (!isTaskHistoryEntry(entry)) throw new Error("Task history entry is invalid");
    entry = redactTaskSecrets(entry);
    await this.mutate(tasks => {
      const prev = tasks.find(task => task.id === entry.id);
      const kept = tasks.filter(task => task.id !== entry.id);
      const carried: TaskHistoryEntry = { ...entry };

      // 旧版存的 route 读出时被去掉：忘掉后撤销、同一任务再写回时，从存档里原样带回，不丢旧数据。
      if (prev && "route" in prev && !("route" in carried)) Object.assign(carried, { route: (prev as TaskHistoryEntry & { route?: unknown }).route });

      if (prev?.useCount !== undefined) carried.useCount = prev.useCount;

      if (prev?.lastUsedAt !== undefined) carried.lastUsedAt = prev.lastUsedAt;

      if (entry.date === undefined && entry.validity === undefined) {
        if (prev?.date !== undefined) carried.date = prev.date;

        if (prev?.validity !== undefined) carried.validity = prev.validity;
      }

      kept.push(carried);

      return kept.sort((a, b) => b.endedAt - a.endedAt).slice(0, TASK_HISTORY_MAX);
    });
  }

  /**
   * 补上「这件事关于哪天」：只改仍存在、且 endedAt 相同的那条。
   * 已被删除的不重建，已被同一任务更新的记录覆盖过的不动（慢的日期判断晚到时）。
   */
  async patchDate(id: string, endedAt: number, dated: { date: string; validity: NonNullable<TaskHistoryEntry["validity"]> }): Promise<void> {
    await this.mutate(tasks => tasks.map(task => (task.id === id && task.endedAt === endedAt ? { ...task, date: dated.date, validity: dated.validity } : task)));
  }

  /** 没做完的任务：补上短主题与下一步（晚到时只改这两个字段）。 */
  async patchLabel(id: string, endedAt: number, label: { title: string; next: string }): Promise<void> {
    await this.mutate(tasks => tasks.map(task => (task.id === id && task.endedAt === endedAt ? { ...task, title: label.title, next: label.next } : task)));
  }

  /** 这几条刚被带给助手：用过次数加 1、记下时间；已不存在的 id 跳过。 */
  async markUsed(ids: readonly string[], now: number): Promise<void> {
    if (!ids.length) return;
    const wanted = new Set(ids);

    await this.mutate(tasks => tasks.map(task => (wanted.has(task.id) ? { ...task, useCount: (task.useCount ?? 0) + 1, lastUsedAt: now } : task)));
  }

  /** 「这里别用」：off=true 在这个网站不再带这条，off=false 恢复。返回全部过往任务。 */
  async setNotHere(id: string, hostname: string, off: boolean): Promise<TaskHistoryEntry[]> {
    if (normalizeMemoryHostname(hostname) !== hostname) throw new Error("Task history hostname is invalid");

    return this.mutate(tasks => {
      if (!tasks.some(task => task.id === id)) throw new Error("这条过往任务已不在");

      return tasks.map(task => (task.id === id ? withNotOnHost(task, hostname, off) : task));
    });
  }

  /** 删一条；id 为 null 时全部清空。 */
  async forget(id: string | null): Promise<TaskHistoryEntry[]> {
    return this.mutate(tasks => (id === null ? [] : tasks.filter(task => task.id !== id)), id === null);
  }

  /** 与这次请求或当前网站有关的过往任务，从新到旧。 */
  async search(query: { text?: string; hostname?: string | null; limit?: number }): Promise<TaskHistoryEntry[]> {
    const text = query.text?.trim() ?? "";
    const tasks = await this.list();

    const matched = tasks.filter(task =>
      (query.hostname && task.hosts.includes(query.hostname))
      || (text && isRelevantMemory([task.page ?? "", task.goal, ...task.revisions, task.summary, ...task.hosts].join(" "), text)));

    return matched.slice(0, query.limit ?? 8);
  }

  private async read(): Promise<TaskHistoryEntry[]> {
    return (await this.load()).tasks;
  }

  /** 读存档：无数据 → 空；format 1 → 有效条目，坏条目的原文另留；未知或损坏的格式 → 只读（写入会被拒绝，不覆盖原文）。 */
  private async load(): Promise<{ tasks: TaskHistoryEntry[]; invalid: unknown[]; readOnly: boolean }> {
    const raw = await this.doc.read();

    if (raw === null) return { tasks: [], invalid: [], readOnly: false };

    try {
      // SAFETY: 只读 format 与 tasks 两个字段，tasks 里每条再用 isTaskHistoryEntry 核对。
      const file = JSON.parse(raw) as Partial<HistoryFile> | null;

      if (file?.format === 1 && Array.isArray(file.tasks)) {
        const items: unknown[] = file.tasks;

        return { tasks: items.filter(isTaskHistoryEntry), invalid: items.filter(item => !isTaskHistoryEntry(item)), readOnly: false };
      }
    } catch { /* 当作不可读，落到下面 */ }

    return { tasks: [], invalid: [], readOnly: true };
  }

  private mutate(change: (tasks: TaskHistoryEntry[]) => TaskHistoryEntry[], dropInvalid = false): Promise<TaskHistoryEntry[]> {
    return this.doc.exclusive(async () => {
      const { tasks, invalid, readOnly } = await this.load();

      if (readOnly) throw new Error("Task history was saved in an unknown or unreadable format; it is read-only to protect it");
      const next = change(tasks);
      // 读不懂的条目原样写回，不因一次改动丢数据。
      await this.doc.write(JSON.stringify({ format: 1, tasks: [...next, ...(dropInvalid ? [] : invalid)] }) + "\n");

      return next.map(withoutRoute);
    });
  }
}

/** 给模型看的过往任务，一行一条。 */
export function formatTaskHistory(tasks: TaskHistoryEntry[]): string {
  return tasks.map(task => {
    const date = new Date(task.endedAt).toISOString().slice(0, 10);
    const outcome = { complete: "done", partial: "partly done", stopped: "stopped by user", error: "failed" }[task.outcome];
    const rest = task.unfinished.length ? `; still open: ${task.unfinished.join(" / ")}` : "";

    return `- ${date} [${outcome}] ${task.page ? `(on page "${task.page}") ` : ""}${task.goal}${task.revisions.length ? ` (+ ${task.revisions.join(" / ")})` : ""} @ ${task.hosts.join(", ") || "no site"} → ${task.summary}${rest}`;
  }).join("\n");
}
