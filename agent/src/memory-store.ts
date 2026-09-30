import {
  isMemoryEntry,
  isMemoryScope,
  isMemoryValidity,
  MEMORY_FORMAT_VERSION,
  MEMORY_QUOTE_MAX,
  normalizeMemoryHostname,
  isStoredMemoryEntry,
  upgradeMemoryEntry,
  validLocalDate,
  validMemoryId,
  validMemoryText,
  validMemoryVersion,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryValidity,
} from "../../shared/memory.js";
import { isRelevantExperience, isRelevantMemory } from "./memory-relevance.js";
import { placeMemory, sameMemoryScope, validateMemoryDecision, type MemoryDecision } from "./memory-decision.js";
import type { DocumentPersistence } from "./document-persistence.js";

/** format 2：每条带种类、有效期、来源原话、用过几次、状态和格式版本号；format 1 读入时补默认值，下次写入即为 2。 */
interface StoreFile {
  format: 2;
  entries: MemoryEntry[];
  forgottenExperiences?: string[];
}

export interface MemoryQuery {
  text: string;
  url?: string;
}

/** 本机宿主的记忆文件名；扩展版存在 IndexedDB 里，内容格式相同。 */
export const MEMORY_STORE_FILE = "memories.json";

const randomUUID = () => globalThis.crypto.randomUUID();

export class MemoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

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

      // 被替换或失效的旧值只作历史，不能再被判断当作要改的那条。
      if (targets.some(e => e.status !== "active")) throw new Error("记忆目标或版本无效");

      if (decision.action === "forget") {
        for (const entry of targets) {
          if (entry.experience) forgotten.push(entry.experience.runId);
          entries.splice(entries.indexOf(entry), 1);
        }

        return cloneEntries(targets);
      }

      const placement = placeMemory(decision, entries);

      if (!placement.store) throw new Error("这句话不记成长期记忆");

      if (decision.action === "save") {
        const identical = entries.find(e => e.status === "active" && e.text === decision.text.trim() && sameMemoryScope(e.scope, decision.scope));

        if (identical) return cloneEntries([identical]);
      }

      const now = Date.now();
      const quote = decision.evidence.trim().slice(0, MEMORY_QUOTE_MAX);

      const next: MemoryEntry = {
        id: randomUUID(), version: 1, text: decision.text.trim(), scope: cloneScope(decision.scope), sourceConversationId,
        createdAt: now, updatedAt: Math.max(now, ...targets.map(e => e.updatedAt + 1)),
        kind: placement.kind, useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION,
      };

      if (quote) next.sourceQuote = quote;

      if (placement.validity) next.validity = { ...placement.validity };

      if (placement.date) next.date = placement.date;

      // 同一事实换了新值：旧条目标为「被替换」留作历史（不再带给助手），面板可撤销。
      for (const entry of targets) {
        // A user replacement must not be resurrected by an old experience job.
        if (entry.experience) forgotten.push(entry.experience.runId);
        entries[entries.indexOf(entry)] = { ...entry, version: entry.version + 1, status: "replaced", replacedBy: next.id, updatedAt: Math.max(now, entry.updatedAt + 1) };
      }

      entries.push(next);

      return cloneEntries([next]);
    }, guard);
  }

  async create(input: { text: string; scope: MemoryScope; sourceConversationId: string; guard?: () => boolean; kind?: MemoryKind; validity?: MemoryValidity; date?: string; sourceQuote?: string }): Promise<MemoryEntry> {
    assertCreateInput(input);

    if (input.validity !== undefined && !isMemoryValidity(input.validity)) throw new Error("Memory validity is invalid");

    if (input.date !== undefined && !validLocalDate(input.date)) throw new Error("Memory date is invalid");

    if (input.sourceQuote !== undefined && (typeof input.sourceQuote !== "string" || !input.sourceQuote || input.sourceQuote.length > MEMORY_QUOTE_MAX)) throw new Error("Memory quote is invalid");

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
        kind: input.kind ?? "profile",
        useCount: 0,
        status: "active",
        formatVersion: MEMORY_FORMAT_VERSION,
      };

      if (input.validity) entry.validity = { ...input.validity };

      if (input.date) entry.date = input.date;

      if (input.sourceQuote) entry.sourceQuote = input.sourceQuote;
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
      const entry: MemoryEntry = { id: randomUUID(), version: 1, text: input.text.trim(), scope: cloneScope(input.scope), sourceConversationId: input.sourceConversationId, createdAt: now, updatedAt: now, experience, kind: "method", useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
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

      if (current.status !== "active") throw new Error("只能修改生效的记忆");

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

  /**
   * 撤销替换：被替换的旧值恢复生效，替换它的新值改为失效（留在历史里）。两条都按版本号核对，版本 +1。
   * 返回改动的条目（恢复的在前）。
   */
  async restore(input: { id: string; expectedVersion: number }): Promise<MemoryEntry[]> {
    assertMutationIdentity(input.id, input.expectedVersion);

    return this.withWriteLock(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");
      const current = entries[index]!;

      if (current.version !== input.expectedVersion) throw new Error("Memory version conflict");

      if (current.status !== "replaced") throw new Error("这条记忆没有被替换，无需撤销");
      const now = Date.now();
      const restored: MemoryEntry = { ...current, version: current.version + 1, status: "active", updatedAt: Math.max(now, current.updatedAt + 1) };
      delete restored.replacedBy;
      entries[index] = restored;
      const changed = [restored];
      const replacerIndex = entries.findIndex((entry) => entry.id === current.replacedBy && entry.status === "active");

      if (replacerIndex >= 0) {
        const replacer = entries[replacerIndex]!;
        entries[replacerIndex] = { ...replacer, version: replacer.version + 1, status: "invalid", updatedAt: Math.max(now, replacer.updatedAt + 1) };
        changed.push(entries[replacerIndex]!);
      }

      return changed;
    });
  }

  /**
   * 这一轮带给了助手：用过次数 +1、记下时间，返回仍然生效且版本没变的那些（挑选之后被忘记、修改或替换的不再带）。
   * 不改版本号（不和用户的修改抢版本）。
   */
  async markUsed(picked: Array<{ id: string; version: number }>): Promise<MemoryEntry[]> {
    if (!picked.length) return [];
    const wanted = new Map(picked.map(({ id, version }) => [id, version]));
    const now = Date.now();

    return this.withWriteLock(async (entries) => {
      const used: MemoryEntry[] = [];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;

        if (wanted.get(entry.id) !== entry.version || entry.status !== "active") continue;
        entries[i] = { ...entry, useCount: entry.useCount + 1, lastUsedAt: now };
        used.push(entries[i]!);
      }

      return used;
    });
  }

  async select(query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) => entry.status === "active" && scopeAllows(entry.scope, hostname) && isEntryRelevant(entry, query.text)));
  }

  async resolveSelected(selected: Array<{ id: string; version: number }>, query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);

    if (!Array.isArray(selected) || selected.some((item) => !item || !validMemoryId(item.id) || !validMemoryVersion(item.version))) {
      throw new Error("Selected memory identity is invalid");
    }

    const wanted = new Map(selected.map(({ id, version }) => [id, version]));
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) =>
      wanted.get(entry.id) === entry.version && entry.status === "active" && scopeAllows(entry.scope, hostname) && isEntryRelevant(entry, query.text),
    ));
  }

  private async read(): Promise<MemoryEntry[]> { return (await this.readState()).entries; }

  private async readState(): Promise<StoreFile> {
    const raw = await this.doc.read();

    if (raw === null) return { format: MEMORY_FORMAT_VERSION, entries: [] };

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Memory store is corrupt");
    }

    // SAFETY: 只读 format / entries / forgottenExperiences，下面逐条核对后才使用。
    const file = parsed as { format?: unknown; entries?: unknown; forgottenExperiences?: unknown };

    if ((file?.format !== 1 && file?.format !== MEMORY_FORMAT_VERSION) || !Array.isArray(file.entries)) throw new Error("Memory store is corrupt");
    // 升级前（format 1）的条目补默认值；当前格式逐条严格核对。任何一条不对都按损坏报出，不当作空记忆覆盖。
    const valid = file.format === 1 ? file.entries.every(isStoredMemoryEntry) : file.entries.every(isMemoryEntry);

    if (!valid) throw new Error("Memory store is corrupt");
    const upgraded = file.entries.filter(isStoredMemoryEntry).map(upgradeMemoryEntry);
    const ids = new Set<string>();

    for (const entry of upgraded) {
      if (ids.has(entry.id)) throw new Error("Memory store contains duplicate IDs");
      ids.add(entry.id);
    }

    if (file.forgottenExperiences !== undefined && (!Array.isArray(file.forgottenExperiences) || file.forgottenExperiences.some(id => !validMemoryId(id)))) throw new Error("Memory store is corrupt");

    // SAFETY: 上面已核对 forgottenExperiences 缺省或是合法编号组成的数组。
    return { format: MEMORY_FORMAT_VERSION, entries: cloneEntries(upgraded), forgottenExperiences: (file.forgottenExperiences as string[] | undefined) ?? [] };
  }

  private async withWriteLock<T>(mutate: (entries: MemoryEntry[], forgotten: string[]) => Promise<T> | T, commitGuard?: () => boolean): Promise<T> {
    return this.doc.exclusive(async () => {
      const state = await this.readState();
      const entries = state.entries;
      const forgotten = state.forgottenExperiences ?? [];
      const result = await mutate(entries, forgotten);

      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await this.doc.write(JSON.stringify({ format: MEMORY_FORMAT_VERSION, entries, forgottenExperiences: forgotten } satisfies StoreFile) + "\n", commitGuard);

      return cloneValue(result);
    });
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

    if (entry.validity) cloned.validity = { ...entry.validity };

    if (entry.experience) cloned.experience = { ...entry.experience, evidence: [...entry.experience.evidence] };

    return cloned;
  });
}

function cloneValue<T>(value: T): T {
  if (value && typeof value === "object" && isMemoryEntry(value)) return cloneEntries([value])[0] as T;

  // SAFETY: 每个元素都已核对是记忆条目，克隆后形状不变。
  if (Array.isArray(value) && value.every(isMemoryEntry)) return cloneEntries(value) as T;

  return value;
}

