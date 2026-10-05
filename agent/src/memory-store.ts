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
import { placeMemory, sameMemoryScope, validateMemoryDecision, type MemoryDecision } from "./memory-decision.js";
import type { DocumentPersistence } from "./document-persistence.js";

/**
 * format 3：每条带 factId（同一件事的所有版本共用），整份带递增版本号 rev。
 * format 1、2 读入时升级（替换链上的条目共用链上最早那条的 id），下次写入即为 3。
 * 更新的格式只读：能认的条目照常读出，写入一律拒绝，不覆盖原文件。
 */
interface StoreFile {
  format: typeof MEMORY_FORMAT_VERSION;
  /** 整份记忆的版本号：每次成功写入加 1；旧格式没有，按 0 算。 */
  rev: number;
  entries: MemoryEntry[];
  forgottenExperiences?: string[];
}

interface StoreState extends StoreFile {
  /** 文件来自更新的版本时记下它的格式号；此时只读。 */
  newerFormat?: number;
}

export interface MemoryQuery {
  text: string;
  url?: string;
}

/** 本机宿主的记忆文件名；扩展版存在 IndexedDB 里，内容格式相同。 */
export const MEMORY_STORE_FILE = "memories.json";

const randomUUID = () => globalThis.crypto.randomUUID();

/** saveMethod：要替换的那条在询问之后被改过、撤下或不再生效。 */
export class ReplaceTargetChanged extends Error {}

export class MemoryStore {
  constructor(private readonly doc: DocumentPersistence) {}

  async list(): Promise<MemoryEntry[]> {
    return cloneEntries(await this.read());
  }

  /** 整份记忆当前的版本号；从没写过为 0。 */
  async currentRev(): Promise<number> {
    return (await this.readState()).rev;
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

      // 忘记一条事实：连同它被替换 / 撤下的旧值一起删掉，之后无从恢复。
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
      // 新值归入被替换的那件事；一次替换几件事时并成一件，用其中最早那条的编号。
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

      // 同一事实换了新值：旧条目标为「被替换」留作历史（不再带给助手），面板可撤销。
      for (const target of targets) {
        const index = entries.findIndex(e => e.id === target.id);
        const entry = entries[index]!;

        // A user replacement must not be resurrected by an old experience job.
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

  /**
   * 用户点「记住」后存一条确认过的「做事的方法」（来源原话 = 用户那句纠正）。返回改动的条目：新条目在前，被替换的旧条目在后。
   * replaces 指向同一件事的旧做法：旧条目版本 +1、标「被替换」并指向新条目，新条目沿用它的 factId。
   * 要替换的那条已被删掉就只存新的；已被改过或不再生效则抛 ReplaceTargetChanged（不悄悄并存两条相反的做法）。
   * 同范围已有同样文字的生效做法时不写入（版本号 rev 不变），返回那一条并标 alreadySaved。
   */
  async saveMethod(input: { text: string; scope: MemoryScope; sourceConversationId: string; sourceQuote: string; replaces?: { id: string; version: number } }): Promise<{ entries: MemoryEntry[]; alreadySaved: boolean }> {
    assertCreateInput(input);

    if (typeof input.sourceQuote !== "string" || !input.sourceQuote.trim()) throw new Error("Memory quote is invalid");

    if (input.replaces && (!validMemoryId(input.replaces.id) || !validMemoryVersion(input.replaces.version))) throw new Error("Memory ID is invalid");

    let alreadySaved = false;

    const entries = await this.withWriteLock((entries, forgotten) => {
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
        createdAt: now, updatedAt: Math.max(now, (target?.updatedAt ?? 0) + 1), kind: "method", sourceQuote: input.sourceQuote.trim().slice(0, MEMORY_QUOTE_MAX),
        useCount: 0, status: "active", formatVersion: MEMORY_FORMAT_VERSION,
      };

      const changed = [next];

      if (target) {
        const index = entries.indexOf(target);

        // 用户换掉的自动总结不能被后台整理再写回来。
        if (target.experience) forgotten.push(target.experience.runId);
        entries[index] = { ...target, version: target.version + 1, status: "replaced", replacedBy: id, updatedAt: Math.max(now, target.updatedAt + 1) };
        changed.push(entries[index]!);
      }

      entries.push(next);

      return changed;
    }, undefined, () => alreadySaved);

    return { entries, alreadySaved };
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

  /** 返回删掉的条目（忘记生效的值时是整件事的全部版本），供 unforget 撤销。 */
  async forget(input: { id: string; expectedVersion: number }): Promise<MemoryEntry[]> {
    assertMutationIdentity(input.id, input.expectedVersion);

    return this.withWriteLock(async (entries, forgotten) => {
      const index = entries.findIndex((entry) => entry.id === input.id);

      if (index < 0) throw new Error("Memory entry was not found");

      const current = entries[index]!;

      if (current.version !== input.expectedVersion) throw new Error("Memory version conflict");

      // 忘记生效的值 = 忘记这条事实：整条历史一起删。
      if (current.status === "active") {
        const removed = entries.filter(entry => entry.factId === current.factId);
        removeFact(entries, forgotten, current.factId);

        return removed;
      }

      // 只删一条历史：指向它的旧值改指向它的下一条，链不断开。
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

  /**
   * 撤销「忘掉」：把 forget 删掉的条目原样放回（编号、版本、用过次数不变）。
   * 这件事这期间又有了值、或这些条目已经放回过时拒绝，不出现两个生效值。
   */
  async unforget(removed: MemoryEntry[]): Promise<MemoryEntry[]> {
    if (!Array.isArray(removed) || !removed.length || !removed.every(isMemoryEntry)) throw new Error("Memory entries are invalid");
    const factId = removed[0]!.factId;

    if (removed.some(entry => entry.factId !== factId)) throw new Error("只能撤销同一件事的条目");

    return this.withWriteLock(async (entries, forgotten) => {
      if (entries.some(entry => entry.factId === factId || removed.some(r => r.id === entry.id))) throw new Error("这条记忆已经恢复过，或已有新的值");
      const restored = cloneEntries(removed);
      entries.push(...restored);
      const runs = new Set(restored.flatMap(entry => (entry.experience ? [entry.experience.runId] : [])));

      for (let i = forgotten.length - 1; i >= 0; i--) if (runs.has(forgotten[i]!)) forgotten.splice(i, 1);

      return restored;
    });
  }

  /** 「这里别用」：off=true 在这个网站不再带这条，off=false 恢复。不删除、不改版本号（内容没变）。 */
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

  /**
   * 撤销：把一条被替换或失效的旧值恢复成这条事实唯一的生效值。链里当前生效的值改为失效，
   * 并指向恢复的这条（留在历史里，可再撤回去）。所有改动的条目版本 +1。返回改动的条目（恢复的在前）。
   */
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

    return cloneEntries((await this.read()).filter((entry) => entry.status === "active" && scopeAllows(entry.scope, hostname) && usableOnHost(entry, hostname) && isEntryRelevant(entry, query.text)));
  }

  async resolveSelected(selected: Array<{ id: string; version: number }>, query: MemoryQuery): Promise<MemoryEntry[]> {
    assertQuery(query);

    if (!Array.isArray(selected) || selected.some((item) => !item || !validMemoryId(item.id) || !validMemoryVersion(item.version))) {
      throw new Error("Selected memory identity is invalid");
    }

    const wanted = new Map(selected.map(({ id, version }) => [id, version]));
    const hostname = hostnameFromUrl(query.url);

    return cloneEntries((await this.read()).filter((entry) =>
      wanted.get(entry.id) === entry.version && entry.status === "active" && scopeAllows(entry.scope, hostname) && usableOnHost(entry, hostname) && isEntryRelevant(entry, query.text),
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
    const file = parsed as { format?: unknown; rev?: unknown; entries?: unknown; forgottenExperiences?: unknown };

    if (!file || !Number.isSafeInteger(file.format) || !Array.isArray(file.entries)) throw new Error("Memory store is corrupt");
    // SAFETY: 上一行已核对 format 是整数。
    const format = file.format as number;
    const rev = file.rev ?? 0;

    if (!isRev(rev)) throw new Error("Memory store is corrupt");

    // 更新的版本写的：尽量读出字段齐全的条目给面板看（只在内存里当作当前格式，从不写回），写入时拒绝（不覆盖）。
    if (format > MEMORY_FORMAT_VERSION) {
      const shown = file.entries.filter(hasMemoryDisplayFields).map((e): MemoryEntry => ({ ...e, factId: "factId" in e && validMemoryId(e.factId) ? e.factId : e.id, formatVersion: MEMORY_FORMAT_VERSION }));

      return { format: MEMORY_FORMAT_VERSION, rev, entries: cloneEntries(shown), forgottenExperiences: [], newerFormat: format };
    }

    // 升级前的条目补默认值；每种格式逐条严格核对。任何一条不对都按损坏报出，不当作空记忆覆盖。
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
    return { format: MEMORY_FORMAT_VERSION, rev, entries: cloneEntries(entries), forgottenExperiences: (file.forgottenExperiences as string[] | undefined) ?? [] };
  }

  /** unchanged 在改完后返回 true 时不写入（整份版本号不变）。 */
  private async withWriteLock<T>(mutate: (entries: MemoryEntry[], forgotten: string[]) => Promise<T> | T, commitGuard?: () => boolean, unchanged?: () => boolean): Promise<T> {
    return this.doc.exclusive(async () => {
      const state = await this.readState();

      if (state.newerFormat !== undefined) throw new Error(`Memory store was written by a newer version (format ${state.newerFormat}); it is read-only here`);
      const entries = state.entries;
      const forgotten = state.forgottenExperiences ?? [];
      const result = await mutate(entries, forgotten);

      if (unchanged?.()) return cloneValue(result);
      checkInvariants(entries);

      if (commitGuard && !commitGuard()) throw new Error("Memory save is no longer authorized");
      await this.doc.write(JSON.stringify({ format: MEMORY_FORMAT_VERSION, rev: state.rev + 1, entries, forgottenExperiences: forgotten } satisfies StoreFile) + "\n", commitGuard);

      return cloneValue(result);
    });
  }
}

function isRev(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

/**
 * 写入前必须成立，否则整次写入作废、原文件不动：
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

  // 顺着 replacedBy 走到头；走过的路都确认无环，后面的起点碰到就停。
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

/**
 * 旧格式（1、2）升级：先修复已经违反规则的数据，再分 factId。只改状态和链接、不删条目、不改版本号，
 * 结果只取决于数据本身（每次读到同一份旧文件修出来都一样）：
 * 1. replacedBy 指向不存在的条目：去掉这条链接。
 * 2. replacedBy 成环：在环上最早（createdAt 最小）的条目处断开。
 * 3. 因此没了后继的旧值改为失效（留在历史里，用户可以恢复）；从不把不生效的条目改成生效，免得旧值重新带给助手。
 * 4. 一件事多个生效值：留最近修改的那个，其余改为被它替换。
 * 格式 3 不修：违反规则就拒绝写入。
 */
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

/** 旧格式升级：顺着 replacedBy 连在一起的条目是同一件事，共用其中最早（createdAt 最小）那条的 id。 */
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
    // 根保留更早的那条（同一时刻按先出现的）。
    const [keep, drop] = created.get(b)! < created.get(a)! ? [b, a] : [a, b];
    parent.set(drop, keep);
  }

  return entries.map(e => ({ ...e, factId: root(e.id) }));
}

/** 忘记一件事：它的所有版本一起删，之后无从恢复。 */
function removeFact(entries: MemoryEntry[], forgotten: string[], factId: string): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;

    if (entry.factId !== factId) continue;

    if (entry.experience) forgotten.push(entry.experience.runId);
    entries.splice(i, 1);
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
  return memoryHostOfUrl(url);
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

