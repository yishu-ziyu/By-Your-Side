import {
  hasMemoryDisplayFields,
  isFormat2MemoryEntry,
  isMemoryEntry,
  isMemoryScope,
  isMemoryValidity,
  MEMORY_FORMAT_VERSION,
  MEMORY_QUOTE_MAX,
  memoryHostOfUrl,
  isStoredMemoryEntry,
  normalizeMemoryHostname,
  upgradeMemoryEntry,
  usableOnHost,
  validLocalDate,
  validMemoryId,
  validMemoryText,
  validMemoryVersion,
  withNotOnHost,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
  type MemoryValidity,
} from "../../shared/memory.js";
import { isRelevantExperience, isRelevantMemory } from "./memory-relevance.js";
import { parseSavedOpen } from "./saved-opens.js";
import { placeMemory, sameMemoryScope, validateMemoryDecision, type MemoryDecision } from "./memory-decision.js";
import type { DocumentPersistence } from "./document-persistence.js";

interface StoreFile {
  format: typeof MEMORY_FORMAT_VERSION;
  rev: number;
  entries: MemoryEntry[];
  forgottenExperiences?: string[];
  methodRev?: number;
}

interface StoreState extends StoreFile {
  newerFormat?: number;
}

export interface MemoryQuery {
  text: string;
  url?: string;
}

export interface SemanticMemoryIndex {
  sync(entries: MemoryEntry[]): Promise<void>;
  select(query: MemoryQuery): Promise<Array<{ id: string; version: number }>>;
}

const semanticIndexes = new WeakMap<MemoryStore, SemanticMemoryIndex>();

export function useSemanticMemory(store: MemoryStore, index: SemanticMemoryIndex): MemoryStore {
  semanticIndexes.set(store, index);
  return store;
}

const randomUUID = () => globalThis.crypto.randomUUID();

export class ReplaceTargetChanged extends Error {}

export class MemoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<MemoryEntry[]> {
    return cloneEntries(await this.read());
  }

  async methodRevision(): Promise<number> { return (await this.readState()).methodRev ?? 0; }

  async currentRev(): Promise<number> {
    return (await this.readState()).rev;
  }

  async applyDecision(decision: MemoryDecision, userMessage: string, sourceConversationId: string, guard: () => boolean): Promise<MemoryEntry[]> {
    if (!["save", "update", "forget"].includes(decision.action)) throw new Error("Not a memory mutation");
    assertCreateInput({ text: decision.text || "forget", scope: decision.scope, sourceConversationId });

    return this.withWriteLock((entries, forgotten) => {
      if (!guard()) throw new Error("Memory operation is no longer authorized");
      validateMemoryDecision(decision, userMessage, entries);
      const targets = entries.filter(e => decision.targets.some(t => t.id === e.id));

      if (targets.some(e => e.status !== "active")) throw new Error("记忆目标或版本无效");

      if (decision.action === "forget") {
        for (const entry of targets) removeFact(entries, forgotten, entry.factId);

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
      const id = randomUUID();
      const oldest = targets.reduce<MemoryEntry | undefined>((min, e) => (!min || e.createdAt < min.createdAt ? e : min), undefined);
      const factId = oldest?.factId ?? id;
      const merged = new Set(targets.map(e => e.factId));

      for (let i = 0; i < entries.length; i++) {
        if (merged.has(entries[i]!.factId)) entries[i] = { ...entries[i]!, factId };
      }

      const next: MemoryEntry = {
        id, factId, version: 1, text: decision.text.trim(), scope: cloneScope(decision.scope), sourceConversationId,
        createdAt: now, updatedAt: Math.max(now, ...targets.map(e => e.updatedAt + 1)),
        kind: placement.kind, useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION,
      };

      if (quote) next.sourceQuote = quote;

      if (placement.validity) next.validity = { ...placement.validity };

      if (placement.date) next.date = placement.date;

      for (const target of targets) {
        const index = entries.findIndex(e => e.id === target.id);
        const entry = entries[index]!;

        if (entry.experience) forgotten.push(entry.experience.runId);
        entries[index] = { ...entry, version: entry.version + 1, status: "replaced", replacedBy: next.id, updatedAt: Math.max(now, entry.updatedAt + 1) };
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
      const id = randomUUID();

      const entry: MemoryEntry = {
        id,
        factId: id,
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

  async saveInterest(input: { topic: string; sourceQuote: string; sourceConversationId: string; guard: () => boolean }): Promise<{ status: "saved" | "already" | "forgotten"; entry: MemoryEntry | null }> {
    const text = interestText(input.topic);
    assertCreateInput({ text, scope: { kind: "all" }, sourceConversationId: input.sourceConversationId });
    let wrote = false;

    return this.withWriteLock((entries, forgotten) => {
      if (!input.guard()) throw new Error("Memory save is no longer authorized");

      if (forgotten.includes(interestMark(input.topic))) return { status: "forgotten" as const, entry: null };
      const same = entries.find(e => e.status === "active" && e.text === text);

      if (same) return { status: "already" as const, entry: cloneEntries([same])[0]! };
      const now = Date.now();
      const id = randomUUID();
      const entry: MemoryEntry = { id, factId: id, version: 1, text, scope: { kind: "all" }, sourceConversationId: input.sourceConversationId, createdAt: now, updatedAt: now, kind: "profile", useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
      const quote = input.sourceQuote.trim().slice(0, MEMORY_QUOTE_MAX);

      if (quote) entry.sourceQuote = quote;
      entries.push(entry);
      wrote = true;

      return { status: "saved" as const, entry: cloneEntries([entry])[0]! };
    }, input.guard, () => !wrote);
  }

  async saveMethod(input: { text: string; scope: MemoryScope; sourceConversationId: string; sourceQuote?: string; replaces?: { id: string; version: number }; guard?: () => boolean; expectedMethodRev?: number }): Promise<{ entries: MemoryEntry[]; alreadySaved: boolean; methodRev: number }> {
    assertCreateInput(input);

    if (input.sourceQuote !== undefined && (typeof input.sourceQuote !== "string" || !input.sourceQuote.trim())) throw new Error("Memory quote is invalid");

    if (input.replaces && (!validMemoryId(input.replaces.id) || !validMemoryVersion(input.replaces.version))) throw new Error("Memory ID is invalid");

    let alreadySaved = false;
    let methodRev = 0;

    const entries = await this.withWriteLock((entries, forgotten, revision) => {
      if (input.guard && !input.guard()) throw new Error("Memory save is no longer authorized");
      if (input.expectedMethodRev !== undefined && input.expectedMethodRev !== revision) throw new ReplaceTargetChanged("做法在学习期间已经改过");
      methodRev = revision;
      const text = input.text.trim();
      const identical = entries.find(e => e.status === "active" && e.kind === "method" && e.text === text && sameMemoryScope(e.scope, input.scope));

      if (identical) {
        alreadySaved = true;

        return [identical];
      }

      const target = input.replaces ? entries.find(e => e.id === input.replaces!.id) : undefined;

      if (target && (target.version !== input.replaces!.version || target.status !== "active")) throw new ReplaceTargetChanged("要替换的那条做法已经改过");
      const now = Date.now();
      const id = randomUUID();

      const next: MemoryEntry = {
        id, factId: target?.factId ?? id, version: 1, text, scope: cloneScope(input.scope), sourceConversationId: input.sourceConversationId,
        createdAt: now, updatedAt: Math.max(now, (target?.updatedAt ?? 0) + 1), kind: "method",
        ...(input.sourceQuote ? { sourceQuote: input.sourceQuote.trim().slice(0, MEMORY_QUOTE_MAX) } : {}),
        useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION,
      };

      const changed = [next];

      if (target) {
        const index = entries.indexOf(target);

        if (target.experience) forgotten.push(target.experience.runId);
        entries[index] = { ...target, version: target.version + 1, status: "replaced", replacedBy: id, updatedAt: Math.max(now, target.updatedAt + 1) };
        changed.push(entries[index]!);
      }

      entries.push(next);
      methodRev += 1;

      return changed;
    }, input.guard, () => alreadySaved);

    return { entries, alreadySaved, methodRev };
  }

  /** WHY: Retrying a background job never overwrites a user edit or resurrects a forgotten experience. */
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
      const id = randomUUID();
      const entry: MemoryEntry = { id, factId: id, version: 1, text: input.text.trim(), scope: cloneScope(input.scope), sourceConversationId: input.sourceConversationId, createdAt: now, updatedAt: now, experience, kind: "method", useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION };
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

      const text = input.text.trim();
      const entry: MemoryEntry = {
        ...current,
        version: current.version + 1,
        text,
        scope: cloneScope(input.scope),
        updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      };

      if (current.sourceQuote && text !== current.text && parseSavedOpen(current.sourceQuote)) {
        if (parseSavedOpen(text)) entry.sourceQuote = text.slice(0, MEMORY_QUOTE_MAX);
        else delete entry.sourceQuote;
      }

      entries[index] = entry;

      return entry;
    });
  }

  async forget(input: { id: string; expectedVersion: number }): Promise<MemoryEntry[]> {
    assertMutationIdentity(input.id, input.expectedVersion);

    return this.withWriteLock(async (entries, forgotten) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");

      const current = entries[index]!;

      if (current.version !== input.expectedVersion) throw new Error("Memory version conflict");

      if (current.status === "active") {
        const removed = entries.filter(entry => entry.factId === current.factId);
        removeFact(entries, forgotten, current.factId);

        return removed;
      }

      const now = Date.now();

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;

        if (entry.replacedBy !== current.id) continue;
        const relinked: MemoryEntry = { ...entry, version: entry.version + 1, updatedAt: Math.max(now, entry.updatedAt + 1) };

        if (current.replacedBy) relinked.replacedBy = current.replacedBy;
        else delete relinked.replacedBy;
        entries[i] = relinked;
      }

      if (current.experience) forgotten.push(current.experience.runId);
      entries.splice(entries.indexOf(current), 1);

      return [current];
    });
  }

  async unforget(removed: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (!Array.isArray(removed) || !removed.length || !removed.every(isMemoryEntry)) throw new Error("Memory entries are invalid");
    const factId = removed[0]!.factId;

    if (removed.some(entry => entry.factId !== factId)) throw new Error("只能撤销同一件事的条目");

    return this.withWriteLock(async (entries, forgotten) => {
      if (entries.some(entry => entry.factId === factId || removed.some(r => r.id === entry.id))) throw new Error("这条记忆已经恢复过，或已有新的值");
      const restored = cloneEntries(removed);
      entries.push(...restored);
      const runs = new Set(restored.flatMap(entry => [...(entry.experience ? [entry.experience.runId] : []), ...interestMarks(entry)]));

      for (let i = forgotten.length - 1; i >= 0; i--) if (runs.has(forgotten[i]!)) forgotten.splice(i, 1);

      return restored;
    });
  }

  async setNotHere(input: { id: string; expectedVersion: number; hostname: string; off: boolean }): Promise<MemoryEntry> {
    assertMutationIdentity(input.id, input.expectedVersion);

    if (normalizeMemoryHostname(input.hostname) !== input.hostname) throw new Error("Memory hostname is invalid");

    return this.withWriteLock(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");

      if (entries[index]!.version !== input.expectedVersion) throw new Error("Memory version conflict");
      entries[index] = withNotOnHost(entries[index]!, input.hostname, input.off);

      return entries[index]!;
    });
  }

  async restore(input: { id: string; expectedVersion: number }): Promise<MemoryEntry[]> {
    assertMutationIdentity(input.id, input.expectedVersion);

    return this.withWriteLock(async (entries) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");
      const current = entries[index]!;

      if (current.version !== input.expectedVersion) throw new Error("Memory version conflict");

      if (current.status === "active") throw new Error("这条记忆正在生效，无需撤销");
      const now = Date.now();
      const restored: MemoryEntry = { ...current, version: current.version + 1, status: "active", updatedAt: Math.max(now, current.updatedAt + 1) };
      delete restored.replacedBy;
      entries[index] = restored;
      const changed = [restored];

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;

        if (entry.id === current.id || entry.status !== "active" || entry.factId !== current.factId) continue;
        entries[i] = { ...entry, version: entry.version + 1, status: "invalid", replacedBy: current.id, updatedAt: Math.max(now, entry.updatedAt + 1) };
        changed.push(entries[i]!);
      }

      return changed;
    });
  }

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
    const entries = await this.read();
    const applicable = entries.filter(entry => entry.status === "active" && scopeAllows(entry.scope, hostname) && usableOnHost(entry, hostname));
    const literal = applicable.filter(entry => isEntryRelevant(entry, query.text));
    const index = semanticIndexes.get(this);

    if (!index) return cloneEntries(literal);

    try {
      await index.sync(entries);
      const semantic = new Map((await index.select(query)).map(hit => [hit.id, hit.version]));
      return cloneEntries(applicable.filter(entry => isEntryRelevant(entry, query.text) || semantic.get(entry.id) === entry.version));
    } catch {
      return cloneEntries(literal);
    }
  }

  async resolveSelected(selected: Array<{ id: string; version: number }>, query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);

    if (!Array.isArray(selected) || selected.some((item) => !item || !validMemoryId(item.id) || !validMemoryVersion(item.version))) {
      throw new Error("Selected memory identity is invalid");
    }

    const wanted = new Map(selected.map(({ id, version }) => [id, version]));
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) =>
      wanted.get(entry.id) === entry.version && entry.status === "active" && scopeAllows(entry.scope, hostname) && usableOnHost(entry, hostname),
    ));
  }

  private async read(): Promise<MemoryEntry[]> { return (await this.readState()).entries; }

  private async readState(): Promise<StoreState> {
    const raw = await this.doc.read();

    if (raw === null) return { format: MEMORY_FORMAT_VERSION, rev: 0, entries: [] };

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Memory store is corrupt");
    }

    // SAFETY: 只读 format / rev / entries / forgottenExperiences，下面逐条核对后才使用。
    const file = parsed as { format?: unknown; rev?: unknown; entries?: unknown; forgottenExperiences?: unknown; methodRev?: unknown };

    if (!file || !Number.isSafeInteger(file.format) || !Array.isArray(file.entries)) throw new Error("Memory store is corrupt");
    // SAFETY: 上一行已核对 format 是整数。
    const format = file.format as number;
    const rev = file.rev ?? 0;

    if (!isRev(rev) || (file.methodRev !== undefined && !isRev(file.methodRev))) throw new Error("Memory store is corrupt");

    if (format > MEMORY_FORMAT_VERSION) {
      const shown = file.entries.filter(hasMemoryDisplayFields).map((e): MemoryEntry => ({ ...e, factId: "factId" in e && validMemoryId(e.factId) ? e.factId : e.id, formatVersion: MEMORY_FORMAT_VERSION }));

      return { format: MEMORY_FORMAT_VERSION, rev, entries: cloneEntries(shown), forgottenExperiences: [], newerFormat: format };
    }

    const check = format === 1 ? isStoredMemoryEntry : format === 2 ? isFormat2MemoryEntry : format === MEMORY_FORMAT_VERSION ? isMemoryEntry : null;

    if (!check || !file.entries.every(check)) throw new Error("Memory store is corrupt");
    const upgraded = file.entries.filter(isStoredMemoryEntry).map(upgradeMemoryEntry);
    const ids = new Set<string>();

    for (const entry of upgraded) {
      if (ids.has(entry.id)) throw new Error("Memory store contains duplicate IDs");
      ids.add(entry.id);
    }

    if (file.forgottenExperiences !== undefined && (!Array.isArray(file.forgottenExperiences) || file.forgottenExperiences.some(id => !validMemoryId(id)))) throw new Error("Memory store is corrupt");

    const entries = format < MEMORY_FORMAT_VERSION ? upgradeLegacyEntries(upgraded) : upgraded;

    // SAFETY: 上面已核对 forgottenExperiences 缺省或是合法编号组成的数组。
    return { format: MEMORY_FORMAT_VERSION, rev, methodRev: typeof file.methodRev === "number" ? file.methodRev : 0, entries: cloneEntries(entries), forgottenExperiences: (file.forgottenExperiences as string[] | undefined) ?? [] };
  }

  private async withWriteLock<T>(mutate: (entries: MemoryEntry[], forgotten: string[], methodRev: number) => Promise<T> | T, commitGuard?: () => boolean, unchanged?: () => boolean): Promise<T> {
    return this.doc.exclusive(async () => {
      const state = await this.readState();

      if (state.newerFormat !== undefined) throw new Error(`Memory store was written by a newer version (format ${state.newerFormat}); it is read-only here`);
      const entries = state.entries;
      const forgotten = state.forgottenExperiences ?? [];
      const beforeMethods = methodIdentity(entries);
      const result = await mutate(entries, forgotten, state.methodRev ?? 0);

      if (unchanged?.()) return cloneValue(result);
      checkInvariants(entries);

      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await this.doc.write(JSON.stringify({ format: MEMORY_FORMAT_VERSION, rev: state.rev + 1, methodRev: (state.methodRev ?? 0) + Number(beforeMethods !== methodIdentity(entries)), entries, forgottenExperiences: forgotten } satisfies StoreFile) + "\n", commitGuard);

      return cloneValue(result);
    });
  }
}

function isRev(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * WHY: 写入前必须成立，否则整次写入作废、原文件不动：
 * 一件事（factId）至多一个生效值；replacedBy 指向存在且属于同一件事的条目；replacedBy 不成环。
 */
function checkInvariants(entries: MemoryEntry[]): void {
  const byId = new Map(entries.map(e => [e.id, e]));
  const activeFacts = new Set<string>();

  for (const entry of entries) {
    if (entry.status === "active") {
      if (activeFacts.has(entry.factId)) throw new Error(`Memory invariant violated: fact ${entry.factId} has more than one active value`);
      activeFacts.add(entry.factId);
    }

    if (entry.replacedBy === undefined) continue;
    const next = byId.get(entry.replacedBy);

    if (!next) throw new Error(`Memory invariant violated: ${entry.id} is replaced by a missing entry`);

    if (next.factId !== entry.factId) throw new Error(`Memory invariant violated: ${entry.id} is replaced by an entry of another fact`);
  }

  const acyclic = new Set<string>();

  for (const start of entries) {
    const path = new Set<string>();
    let cursor: MemoryEntry | undefined = start;

    while (cursor && !acyclic.has(cursor.id)) {
      if (path.has(cursor.id)) throw new Error(`Memory invariant violated: replacement cycle through ${cursor.id}`);
      path.add(cursor.id);
      cursor = cursor.replacedBy === undefined ? undefined : byId.get(cursor.replacedBy);
    }

    for (const id of path) acyclic.add(id);
  }
}

function upgradeLegacyEntries(input: MemoryEntry[]): MemoryEntry[] {
  const entries = input.map(e => ({ ...e }));
  const byId = new Map(entries.map(e => [e.id, e]));
  const orphaned = new Set<string>();
  const older = (a: MemoryEntry, b: MemoryEntry) => (a.createdAt === b.createdAt ? a.id < b.id : a.createdAt < b.createdAt);

  for (const entry of entries) {
    if (entry.replacedBy === undefined || byId.has(entry.replacedBy)) continue;
    delete entry.replacedBy;
    orphaned.add(entry.id);
  }

  for (const start of entries) {
    const path: MemoryEntry[] = [];
    let cursor: MemoryEntry | undefined = start;

    while (cursor && !path.includes(cursor)) {
      path.push(cursor);
      cursor = cursor.replacedBy === undefined ? undefined : byId.get(cursor.replacedBy);
    }

    if (!cursor) continue;
    const oldest = path.slice(path.indexOf(cursor)).reduce((min, e) => (older(e, min) ? e : min));

    delete oldest.replacedBy;
    orphaned.add(oldest.id);
  }

  const grouped = assignFactIds(entries);
  const facts = new Map<string, MemoryEntry[]>();

  for (const entry of grouped) facts.set(entry.factId, [...(facts.get(entry.factId) ?? []), entry]);

  for (const members of facts.values()) {
    for (const entry of members) {
      if (orphaned.has(entry.id) && entry.status !== "active") entry.status = "invalid";
    }

    const active = members.filter(e => e.status === "active");

    if (active.length < 2) continue;
    const keep = active.reduce((max, e) => (e.updatedAt > max.updatedAt || (e.updatedAt === max.updatedAt && e.id > max.id) ? e : max));

    delete keep.replacedBy;

    for (const entry of active) {
      if (entry === keep) continue;
      entry.status = "replaced";
      entry.replacedBy = keep.id;
    }
  }

  return grouped;
}

function assignFactIds(entries: MemoryEntry[]): MemoryEntry[] {
  const parent = new Map(entries.map(e => [e.id, e.id]));
  const created = new Map(entries.map(e => [e.id, e.createdAt]));

  const root = (id: string): string => {
    let r = id;

    while (parent.get(r) !== r) r = parent.get(r)!;

    return r;
  };

  for (const entry of entries) {
    if (entry.replacedBy === undefined || !parent.has(entry.replacedBy)) continue;
    const a = root(entry.id);
    const b = root(entry.replacedBy);

    if (a === b) continue;
    const [keep, drop] = created.get(b)! < created.get(a)! ? [b, a] : [a, b];
    parent.set(drop, keep);
  }

  return entries.map(e => ({ ...e, factId: root(e.id) }));
}

function removeFact(entries: MemoryEntry[], forgotten: string[], factId: string): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;

    if (entry.factId !== factId) continue;

    if (entry.experience) forgotten.push(entry.experience.runId);
    forgotten.push(...interestMarks(entry));
    entries.splice(i, 1);
  }
}

export function interestText(topic: string): string {
  return `对${topic.trim()}感兴趣`;
}

function interestMarks(entry: MemoryEntry): string[] {
  const topic = /^对(.+)感兴趣$/su.exec(entry.text)?.[1];

  return topic ? [interestMark(topic)] : [];
}

function interestMark(topic: string): string {
  const key = topic.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  let a = 0x811c9dc5, b = 0x01000193;

  for (const char of key) {
    const code = char.codePointAt(0)!;
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x85ebca6b) >>> 0;
  }

  return `interest-${a.toString(16).padStart(8, "0")}${b.toString(16).padStart(8, "0")}`;
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
  return memoryHostOfUrl(url);
}

function scopeAllows(scope: MemoryScope, hostname: string | null): boolean {
  return scope.kind === "all" || (hostname !== null && scope.hostname === hostname);
}

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

    if (entry.notOnHosts) cloned.notOnHosts = [...entry.notOnHosts];

    return cloned;
  });
}

function cloneValue<T>(value: T): T {
  if (value && typeof value === "object" && isMemoryEntry(value)) return cloneEntries([value])[0] as T;

  // SAFETY: 每个元素都已核对是记忆条目，克隆后形状不变。
  if (Array.isArray(value) && value.every(isMemoryEntry)) return cloneEntries(value) as T;

  return value;
}

function methodIdentity(entries: MemoryEntry[]): string {
  return JSON.stringify(entries.filter(entry => entry.kind === "method").map(entry => [entry.id, entry.version, entry.status, entry.text, entry.scope, entry.factId, entry.replacedBy, entry.notOnHosts]));
}
