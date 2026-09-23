import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  isMemoryEntry,
  isMemoryScope,
  normalizeMemoryHostname,
  validMemoryId,
  validMemoryText,
  validMemoryVersion,
  type MemoryEntry,
  type MemoryScope,
} from "../../shared/memory.js";
import { isRelevantExperience, isRelevantMemory } from "./memory-relevance.js";
import { sameMemoryScope, validateMemoryDecision, type MemoryDecision } from "./memory-decision.js";

interface StoreFile {
  format: 1;
  entries: MemoryEntry[];
  forgottenExperiences?: string[];
}

export interface MemoryQuery {
  text: string;
  url?: string;
}

const STORE_FILE = "memories.json";

const LOCK_DIR = ".memories.lock";

const LOCK_WAIT_MS = 10_000;

const STALE_LOCK_MS = 30_000;

export class MemoryStore {
  private readonly file: string;
  private readonly lockDirectory: string;

  constructor(private readonly directory: string) {
    if (typeof directory !== "string" || directory.trim().length === 0) throw new Error("Memory directory is required");
    this.file = join(directory, STORE_FILE);
    this.lockDirectory = join(directory, LOCK_DIR);
  }

  async list(): Promise<MemoryEntry[]> {
    return cloneEntries(await this.read());
  }

  /** One direct user operation, checked again under the lock; no partial duplicate updates. */
  async applyDecision(decision: MemoryDecision, userMessage: string, sourceConversationId: string, guard: () => boolean): Promise<MemoryEntry[]> {
    if (!["save", "update", "forget"].includes(decision.action)) throw new Error("Not a memory mutation");
    assertCreateInput({ text: decision.text || "forget", scope: decision.scope, sourceConversationId });

    return this.withWriteLock((entries, forgotten) => {
      if (!guard()) throw new Error("Memory operation is no longer authorized");
      validateMemoryDecision(decision, userMessage, entries);
      const targets = entries.filter(e => decision.targets.some(t => t.id === e.id));

      if (decision.action === "forget") {
        for (const entry of targets) {
          if (entry.experience) forgotten.push(entry.experience.runId);
          entries.splice(entries.indexOf(entry), 1);
        }

        return cloneEntries(targets);
      }

      if (decision.action === "save") {
        const identical = entries.find(e => e.text === decision.text.trim() && sameMemoryScope(e.scope, decision.scope));

        if (identical) return cloneEntries([identical]);
      }

      const prior = targets[0];
      const now = Date.now();

      const next: MemoryEntry = {
        id: prior?.id ?? randomUUID(), version: prior ? prior.version + 1 : 1,
        text: decision.text.trim(), scope: cloneScope(decision.scope), sourceConversationId,
        createdAt: prior?.createdAt ?? now, updatedAt: Math.max(now, (prior?.updatedAt ?? 0) + 1),
      };

      for (const entry of targets) {
        // A user replacement must not be resurrected by an old experience job.
        if (entry.experience) forgotten.push(entry.experience.runId);
        entries.splice(entries.indexOf(entry), 1);
      }

      entries.push(next);

      return cloneEntries([next]);
    }, guard);
  }

  async create(input: { text: string; scope: MemoryScope; sourceConversationId: string; guard?: () => boolean }): Promise<MemoryEntry> {
    assertCreateInput(input);

    return this.withWriteLock(async (entries) => {
      if (input.guard && !input.guard()) throw new Error("Memory save is no longer authorized");
      const now = Date.now();

      const entry: MemoryEntry = {
        id: randomUUID(),
        version: 1,
        text: input.text.trim(),
        scope: cloneScope(input.scope),
        sourceConversationId: input.sourceConversationId,
        createdAt: now,
        updatedAt: now,
      };

      entries.push(entry);

      if (input.guard && !input.guard()) throw new Error("Memory save is no longer authorized");

      return entry;
    }, input.guard);
  }

  /** Retrying a background job never overwrites a user edit or resurrects a forgotten experience. */
  async createExperience(input: { runId: string; text: string; scope: MemoryScope; sourceConversationId: string; evidence: string[]; topic?: string }): Promise<MemoryEntry | null> {
    assertCreateInput(input);

    if (input.topic !== undefined && (typeof input.topic !== "string" || !input.topic.trim() || input.topic.length > 200)) throw new Error("Invalid experience topic");

    if (!validMemoryId(input.runId) || !input.evidence.length || input.evidence.length > 8 || input.evidence.some(e => typeof e !== "string" || !e || e.length > 600)) throw new Error("Invalid experience evidence");

    return this.withWriteLock((entries, forgotten) => {
      if (forgotten.includes(input.runId)) return null;
      const existing = entries.find(e => e.experience?.runId === input.runId);

      if (existing) return existing;
      const now = Date.now();
      const experience: NonNullable<MemoryEntry["experience"]> = { runId: input.runId, evidence: [...input.evidence] };

      if (input.topic) experience.topic = input.topic;
      const entry: MemoryEntry = { id: randomUUID(), version: 1, text: input.text.trim(), scope: cloneScope(input.scope), sourceConversationId: input.sourceConversationId, createdAt: now, updatedAt: now, experience };
      entries.push(entry);

      return entry;
    });
  }

  async update(input: { id: string; expectedVersion: number; text: string; scope: MemoryScope }): Promise<MemoryEntry> {
    assertMutationIdentity(input.id, input.expectedVersion);

    if (!validMemoryText(input.text)) throw new Error("Memory text is invalid");

    if (!isMemoryScope(input.scope)) throw new Error("Memory scope is invalid");

    return this.withWriteLock(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");
      const current = entries[index]!;

      if (current.version !== input.expectedVersion) throw new Error("Memory version conflict");

      const entry: MemoryEntry = {
        ...current,
        version: current.version + 1,
        text: input.text.trim(),
        scope: cloneScope(input.scope),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };

      entries[index] = entry;

      return entry;
    });
  }

  async forget(input: { id: string; expectedVersion: number }): Promise<void> {
    assertMutationIdentity(input.id, input.expectedVersion);
    await this.withWriteLock(async (entries, forgotten) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");

      if (entries[index]!.version !== input.expectedVersion) throw new Error("Memory version conflict");

      if (entries[index]!.experience) forgotten.push(entries[index]!.experience!.runId);
      entries.splice(index, 1);
    });
  }

  async select(query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) => scopeAllows(entry.scope, hostname) && isEntryRelevant(entry, query.text)));
  }

  async resolveSelected(selected: Array<{ id: string; version: number }>, query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);

    if (!Array.isArray(selected) || selected.some((item) => !item || !validMemoryId(item.id) || !validMemoryVersion(item.version))) {
      throw new Error("Selected memory identity is invalid");
    }

    const wanted = new Map(selected.map(({ id, version }) => [id, version]));
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) =>
      wanted.get(entry.id) === entry.version && scopeAllows(entry.scope, hostname) && isEntryRelevant(entry, query.text),
    ));
  }

  private async read(): Promise<MemoryEntry[]> { return (await this.readState()).entries; }

  private async readState(): Promise<StoreFile> {
    let raw: string;

    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return { format: 1, entries: [] };
      throw error;
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Memory store is corrupt");
    }

    const file = parsed as Partial<StoreFile>;

    if (file?.format !== 1 || !Array.isArray(file.entries) || file.entries.some((entry) => !isMemoryEntry(entry))) {
      throw new Error("Memory store is corrupt");
    }

    const ids = new Set<string>();

    for (const entry of file.entries) {
      if (ids.has(entry.id)) throw new Error("Memory store contains duplicate IDs");
      ids.add(entry.id);
    }

    if (file.forgottenExperiences !== undefined && (!Array.isArray(file.forgottenExperiences) || file.forgottenExperiences.some(id => !validMemoryId(id)))) throw new Error("Memory store is corrupt");

    return { format: 1, entries: cloneEntries(file.entries), forgottenExperiences: file.forgottenExperiences ?? [] };
  }

  private async withWriteLock<T>(mutate: (entries: MemoryEntry[], forgotten: string[]) => Promise<T> | T, commitGuard?: () => boolean): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    await access(this.directory, constants.R_OK | constants.W_OK);
    const release = await acquireDirectoryLock(this.lockDirectory);

    try {
      const state = await this.readState();
      const entries = state.entries;
      const forgotten = state.forgottenExperiences ?? [];
      const result = await mutate(entries, forgotten);

      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await this.write(entries, forgotten, commitGuard);

      return cloneValue(result);
    } finally {
      await release();
    }
  }

  private async write(entries: MemoryEntry[], forgottenExperiences: string[], commitGuard?: () => boolean): Promise<void> {
    const temporary = join(this.directory, `.${STORE_FILE}.${process.pid}.${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o600);

    try {
      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await handle.writeFile(JSON.stringify({ format: 1, entries, forgottenExperiences } satisfies StoreFile) + "\n", "utf8");
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }

    await handle.close();

    try {
      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await rename(temporary, this.file);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

async function acquireDirectoryLock(directory: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  let delay = 4;

  for (;;) {
    try {
      await mkdir(directory);

      return async () => { await rm(directory, { recursive: true, force: true }); };
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;

      try {
        const info = await stat(directory);

        if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
          await rm(directory, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (isCode(statError, "ENOENT")) continue;
        throw statError;
      }

      if (Date.now() - startedAt >= LOCK_WAIT_MS) throw new Error("Timed out waiting for the memory store lock");
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 64);
    }
  }
}

function assertCreateInput(input: { text: string; scope: MemoryScope; sourceConversationId: string }): void {
  if (!input || !validMemoryText(input.text)) throw new Error("Memory text is invalid");

  if (!isMemoryScope(input.scope)) throw new Error("Memory scope is invalid");

  if (typeof input.sourceConversationId !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(input.sourceConversationId)) {
    throw new Error("Source conversation ID is invalid");
  }
}

function assertMutationIdentity(id: unknown, expectedVersion: unknown): asserts id is string {
  if (!validMemoryId(id)) throw new Error("Memory ID is invalid");

  if (!validMemoryVersion(expectedVersion)) throw new Error("Memory version is invalid");
}

function assertQuery(query: MemoryQuery): void {
  if (!query || typeof query.text !== "string" || query.text.trim().length === 0) throw new Error("Memory query text is invalid");

  if (query.url !== undefined && typeof query.url !== "string") throw new Error("Memory query URL is invalid");
}

function hostnameFromUrl(url?: string): string | null {
  if (!url) return null;

  try {
    return normalizeMemoryHostname(new URL(url).hostname);
  } catch {
    return null;
  }
}

function scopeAllows(scope: MemoryScope, hostname: string | null): boolean {
  return scope.kind === "all" || (hostname !== null && scope.hostname === hostname);
}

/**
 * A user edit (version > 1) replaces the topic with the user's own wording, so
 * edited entries keep the permissive rule like any other personal entry.
 * Automatic, unedited experiences match by task object instead.
 */
function isEntryRelevant(entry: MemoryEntry, query: string): boolean {
  if (entry.version === 1 && entry.experience) return isRelevantExperience(entry.experience.topic ?? entry.text, query);

  return isRelevantMemory(entry.text, query);
}

function cloneScope(scope: MemoryScope): MemoryScope {
  return scope.kind === "all" ? { kind: "all" } : { kind: "site", hostname: scope.hostname };
}

function cloneEntries(entries: MemoryEntry[]): MemoryEntry[] {
  return entries.map((entry) => {
    const cloned = { ...entry, scope: cloneScope(entry.scope) };

    if (entry.experience) cloned.experience = { ...entry.experience, evidence: [...entry.experience.evidence] };

    return cloned;
  });
}

function cloneValue<T>(value: T): T {
  if (value && typeof value === "object" && isMemoryEntry(value)) return cloneEntries([value])[0] as T;

  return value;
}

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === code;
}
