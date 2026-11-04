import { normalizeMemoryHostname, withNotOnHost } from "../../shared/memory.js";
import { isTaskHistoryEntry, TASK_HISTORY_MAX, type TaskHistoryEntry } from "../../shared/task-history.js";
import type { DocumentPersistence } from "./document-persistence.js";
import { isRelevantMemory } from "./memory-relevance.js";

const TASK_SECRET_PLACEHOLDER = "（已隐去）";

const SECRET_KEYWORD = "(?:密码|口令|验证码|校验码|动态码|安全码|(?<![A-Za-z])(?:cvv|password|passcode|passwd|pin|otp|code)(?![A-Za-z]))";

const SECRET_AFTER_KEYWORD = new RegExp(`${SECRET_KEYWORD}(?:\\s*(?:应该是|应当是|应该|改成|改为|换成|是|为|[:：=]))+\\s*|${SECRET_KEYWORD}\\s+`, "giu");

const VALUE_TOKEN = /^[^\s，。,；;！!？?、）)】]+/u;

const CARD_NUMBER = /(?:银行卡|借记卡|信用卡|卡号|身份证号?|证件号|护照号?)[^\d]{0,12}?(\d(?:[\s-]?\d){14,18})(?!\d)/gu;

function secretValues(text: string): string[] {
  const values: string[] = [];

  for (const match of text.matchAll(SECRET_AFTER_KEYWORD)) {
    const value = VALUE_TOKEN.exec(text.slice(match.index + match[0].length))?.[0];

    if (value && /[A-Za-z0-9]/u.test(value)) values.push(value);
  }

  for (const match of text.matchAll(CARD_NUMBER)) values.push(match[1]!);

  return values;
}

export function redactTaskSecrets(entry: TaskHistoryEntry): TaskHistoryEntry {
  const values = [...new Set([entry.goal, ...entry.revisions].flatMap(secretValues))].sort((a, b) => b.length - a.length);

  if (!values.length) return entry;
  const scrub = (text: string) => values.reduce((out, value) => out.split(value).join(TASK_SECRET_PLACEHOLDER), text);
  const redacted: TaskHistoryEntry = { ...entry, goal: scrub(entry.goal), revisions: entry.revisions.map(scrub), summary: scrub(entry.summary), unfinished: entry.unfinished.map(scrub) };

  if (entry.page !== undefined) redacted.page = scrub(entry.page);

  if (entry.done !== undefined) redacted.done = scrub(entry.done);

  return redacted;
}

function withoutRoute(task: TaskHistoryEntry): TaskHistoryEntry {
  if (!("route" in task)) return task;
  // SAFETY: 只去掉旧字段 route；其余字段已由 isTaskHistoryEntry 核对。
  const { route: _old, ...rest } = task as TaskHistoryEntry & { route?: unknown };

  return rest;
}

interface HistoryFile { format: 1; tasks: TaskHistoryEntry[] }

export class TaskHistoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<TaskHistoryEntry[]> {
    return (await this.read()).map(withoutRoute).sort((a, b) => b.endedAt - a.endedAt);
  }

  async record(entry: TaskHistoryEntry): Promise<void> {
    if (!isTaskHistoryEntry(entry)) throw new Error("Task history entry is invalid");
    entry = redactTaskSecrets(entry);
    await this.mutate(tasks => {
      const prev = tasks.find(task => task.id === entry.id);
      const kept = tasks.filter(task => task.id !== entry.id);
      const carried: TaskHistoryEntry = { ...entry };

      if (prev && "route" in prev && !("route" in carried)) Object.assign(carried, { route: (prev as TaskHistoryEntry & { route?: unknown }).route });

      if (prev?.useCount !== undefined) carried.useCount = prev.useCount;

      if (prev?.lastUsedAt !== undefined) carried.lastUsedAt = prev.lastUsedAt;

      if (entry.done === undefined && prev?.done !== undefined) carried.done = prev.done;

      if (entry.date === undefined && entry.validity === undefined) {
        if (prev?.date !== undefined) carried.date = prev.date;

        if (prev?.validity !== undefined) carried.validity = prev.validity;
      }

      kept.push(carried);

      return kept.sort((a, b) => b.endedAt - a.endedAt).slice(0, TASK_HISTORY_MAX);
    });
  }

  async patchDate(id: string, endedAt: number, dated: { date: string; validity: NonNullable<TaskHistoryEntry["validity"]> }): Promise<void> {
    await this.mutate(tasks => tasks.map(task => (task.id === id && task.endedAt === endedAt ? { ...task, date: dated.date, validity: dated.validity } : task)));
  }

  async patchDone(id: string, endedAt: number, done: string): Promise<void> {
    await this.mutate(tasks => tasks.map(task => {
      if (task.id !== id || task.endedAt !== endedAt) return task;
      const redacted = redactTaskSecrets({ ...task, done });

      return redacted.done && redacted.done.length > 200 ? { ...redacted, done: `${redacted.done.slice(0, 199)}…` } : redacted;
    }));
  }

  async patchLabel(id: string, endedAt: number, label: { title: string; next: string }): Promise<void> {
    await this.mutate(tasks => tasks.map(task => (task.id === id && task.endedAt === endedAt ? { ...task, title: label.title, next: label.next } : task)));
  }

  async markUsed(ids: readonly string[], now: number): Promise<void> {
    if (!ids.length) return;
    const wanted = new Set(ids);

    await this.mutate(tasks => tasks.map(task => (wanted.has(task.id) ? { ...task, useCount: (task.useCount ?? 0) + 1, lastUsedAt: now } : task)));
  }

  async setNotHere(id: string, hostname: string, off: boolean): Promise<TaskHistoryEntry[]> {
    if (normalizeMemoryHostname(hostname) !== hostname) throw new Error("Task history hostname is invalid");

    return this.mutate(tasks => {
      if (!tasks.some(task => task.id === id)) throw new Error("这条过往任务已不在");

      return tasks.map(task => (task.id === id ? withNotOnHost(task, hostname, off) : task));
    });
  }

  async forget(id: string | null): Promise<TaskHistoryEntry[]> {
    return this.mutate(tasks => (id === null ? [] : tasks.filter(task => task.id !== id)), id === null);
  }

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
    } catch {  }

    return { tasks: [], invalid: [], readOnly: true };
  }

  private mutate(change: (tasks: TaskHistoryEntry[]) => TaskHistoryEntry[], dropInvalid = false): Promise<TaskHistoryEntry[]> {
    return this.doc.exclusive(async () => {
      const { tasks, invalid, readOnly } = await this.load();

      if (readOnly) throw new Error("Task history was saved in an unknown or unreadable format; it is read-only to protect it");
      const next = change(tasks);
      await this.doc.write(JSON.stringify({ format: 1, tasks: [...next, ...(dropInvalid ? [] : invalid)] }) + "\n");

      return next.map(withoutRoute);
    });
  }
}

export function formatTaskHistory(tasks: TaskHistoryEntry[], withReply = false): string {
  return tasks.map(task => {
    const date = new Date(task.endedAt).toISOString().slice(0, 10);
    const outcome = { complete: "done", partial: "partly done", stopped: "stopped by user", error: "failed" }[task.outcome];
    const rest = task.unfinished.length ? `; still open: ${task.unfinished.join(" / ")}` : "";

    const done = task.done ? ` → ${task.done}` : "";
    const reply = withReply && task.summary ? `; your reply then (page facts in it may be outdated): ${task.summary}` : "";

    return `- ${date} [${outcome}] ${task.page ? `(on page "${task.page}") ` : ""}${task.goal}${task.revisions.length ? ` (+ ${task.revisions.join(" / ")})` : ""} @ ${task.hosts.join(", ") || "no site"}${done}${reply}${rest}`;
  }).join("\n");
}
