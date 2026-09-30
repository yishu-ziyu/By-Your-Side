import { isTaskHistoryEntry, TASK_HISTORY_MAX, type TaskHistoryEntry } from "../../shared/task-history.js";
import type { DocumentPersistence } from "./document-persistence.js";
import { isRelevantMemory } from "./memory-relevance.js";

/** 本机宿主的过往任务文件名；扩展版存在 IndexedDB 里，格式相同。 */
export const TASK_HISTORY_FILE = "tasks.json";

interface HistoryFile { format: 1; tasks: TaskHistoryEntry[] }

/** 过往任务：整份存取，按结束时间从新到旧，超过上限丢最旧的。 */
export class TaskHistoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<TaskHistoryEntry[]> {
    return (await this.read()).sort((a, b) => b.endedAt - a.endedAt);
  }

  /** 同一任务（同一 runId）接着做完时覆盖原条目。 */
  async record(entry: TaskHistoryEntry): Promise<void> {
    if (!isTaskHistoryEntry(entry)) throw new Error("Task history entry is invalid");
    await this.mutate(tasks => {
      const kept = tasks.filter(task => task.id !== entry.id);
      kept.push(entry);

      return kept.sort((a, b) => b.endedAt - a.endedAt).slice(0, TASK_HISTORY_MAX);
    });
  }

  /** 这几条刚被带给助手：用过次数加 1、记下时间；已不存在的 id 跳过。 */
  async markUsed(ids: readonly string[], now: number): Promise<void> {
    if (!ids.length) return;
    const wanted = new Set(ids);

    await this.mutate(tasks => tasks.map(task => (wanted.has(task.id) ? { ...task, useCount: (task.useCount ?? 0) + 1, lastUsedAt: now } : task)));
  }

  /** 删一条；id 为 null 时全部清空。 */
  async forget(id: string | null): Promise<TaskHistoryEntry[]> {
    return this.mutate(tasks => (id === null ? [] : tasks.filter(task => task.id !== id)));
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
    const raw = await this.doc.read();

    if (raw === null) return [];

    try {
      // SAFETY: 只读 format 与 tasks 两个字段，tasks 里每条再用 isTaskHistoryEntry 核对。
      const file = JSON.parse(raw) as Partial<HistoryFile>;

      // 坏条目逐条丢掉，不让一条坏数据让整个历史不可用。
      return file?.format === 1 && Array.isArray(file.tasks) ? file.tasks.filter(isTaskHistoryEntry) : [];
    } catch {
      return [];
    }
  }

  private mutate(change: (tasks: TaskHistoryEntry[]) => TaskHistoryEntry[]): Promise<TaskHistoryEntry[]> {
    return this.doc.exclusive(async () => {
      const next = change(await this.read());
      await this.doc.write(JSON.stringify({ format: 1, tasks: next } satisfies HistoryFile) + "\n");

      return next;
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
