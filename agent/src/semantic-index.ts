import type { MemoryEntry } from "../../shared/memory.js";
import type { TaskHistoryEntry } from "../../shared/task-history.js";
import type { MemoryQuery, SemanticMemoryHit, SemanticMemoryIndex } from "./memory-store.js";

export interface SemanticTaskHit { id: string; fingerprint: string; score?: number }
export interface SemanticDocument { kind: "memory" | "task"; id: string; fingerprint: string; version?: number; text: string; createdAt: number }

export function taskFingerprint(task: TaskHistoryEntry): string {
  return JSON.stringify([task.id, task.conversationId, task.goal, task.page, task.revisions, task.hosts, task.outcome, task.summary, task.done, task.unfinished, task.startedAt, task.endedAt, task.date, task.validity, task.notOnHosts, task.title, task.next]);
}

export function memoryFingerprint(entry: MemoryEntry): string {
  return JSON.stringify([entry.id, entry.version, entry.text, entry.scope, entry.kind, entry.status, entry.validity, entry.notOnHosts, entry.experience, entry.createdAt, entry.updatedAt]);
}

interface SemanticAdapter {
  warmup(): Promise<void>;
  replace(documents: SemanticDocument[], canWrite: () => boolean): Promise<void>;
  recall(query: MemoryQuery): Promise<SemanticMemoryHit[]>;
}

export class BackgroundSemanticIndex implements SemanticMemoryIndex {
  private tasks: TaskHistoryEntry[] = [];
  private documents: SemanticDocument[] = [];
  private wanted = "";
  private revision = "";
  private phase: "cold" | "building" | "idle" = "cold";

  constructor(private readonly adapter: SemanticAdapter, private readonly readOnly: () => boolean = () => false) {}

  async sync(entries: MemoryEntry[], tasks?: TaskHistoryEntry[]): Promise<void> {
    if (tasks !== undefined) this.tasks = tasks;
    this.documents = [
      ...entries.filter(entry => entry.status === "active").map(entry => ({ kind: "memory" as const, id: entry.id, fingerprint: memoryFingerprint(entry), version: entry.version, text: [entry.experience?.topic ?? "", entry.text].join("\n"), createdAt: entry.createdAt })),
      ...this.tasks.map(task => ({ kind: "task" as const, id: task.id, fingerprint: taskFingerprint(task), text: [task.goal, ...task.revisions, task.summary, task.done ?? "", ...task.unfinished].join("\n"), createdAt: task.endedAt })),
    ];
    this.wanted = JSON.stringify(this.documents.map(doc => [doc.kind, doc.id, doc.fingerprint]).sort());
    if (!this.documents.length && this.phase === "cold") { this.revision = this.wanted; this.phase = "idle"; return; }
    if (this.phase === "building" || this.readOnly() || this.wanted === this.revision) return;
    this.phase = "building";
    void Promise.resolve().then(() => this.rebuild()).catch(() => undefined).finally(() => { this.phase = this.revision ? "idle" : "cold"; });
  }

  private async rebuild(): Promise<void> {
    await this.adapter.warmup();
    while (!this.readOnly() && this.wanted !== this.revision) {
      const revision = this.wanted;
      try { await this.adapter.replace(this.documents, () => !this.readOnly() && revision === this.wanted); }
      catch (error) {
        if (this.readOnly()) return;
        if (revision !== this.wanted) continue;
        throw error;
      }
      if (this.readOnly()) return;
      this.revision = revision;
    }
  }

  async select(query: MemoryQuery): Promise<SemanticMemoryHit[]> {
    const hits = await this.adapter.recall(query);
    const current = new Map(this.documents.map(doc => [`${doc.kind}:${doc.id}`, doc]));
    return hits.filter(hit => {
      const document = current.get(`${hit.kind ?? "memory"}:${hit.id}`);
      return document !== undefined && hit.fingerprint === document.fingerprint;
    });
  }
}

interface SemanticClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: SemanticClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); },
  clearTimeout: cancel => { if (typeof cancel === "function") cancel(); },
};

export async function retrieveSemantic(index: SemanticMemoryIndex, entries: MemoryEntry[], tasks: TaskHistoryEntry[] | undefined, query: MemoryQuery, clock: SemanticClock = systemClock): Promise<SemanticMemoryHit[]> {
  const deadline = clock.now() + 1500;
  let timer: unknown;
  const timeout = new Promise<SemanticMemoryHit[]>(resolve => { timer = clock.setTimeout(() => resolve([]), 1500); });
  const work = Promise.resolve().then(async () => {
    await index.sync(entries, tasks);
    if (clock.now() >= deadline) return [];
    return index.select(query);
  }).catch(() => []);
  try { return await Promise.race([work, timeout]); }
  finally { clock.clearTimeout(timer); }
}
