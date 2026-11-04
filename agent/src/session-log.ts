import { uuidv7 } from '@earendil-works/pi-ai';
import type { AgentMessage } from '@earendil-works/pi-agent-core';

export type SessionLogEntry = { type: string; id: string; parentId: string | null; seq: number; timestamp: number; customType?: string; data?: unknown; message?: unknown };

export interface SessionLogPort {
  findEntriesOnBranch(query: { order: 'oldestFirst' }): Promise<SessionLogEntry[]>;
  getEntry(id: string): Promise<SessionLogEntry | undefined>;
  appendMessage(message: AgentMessage): Promise<string>;
  appendCustomEntry(customType: string, data?: JsonValue): Promise<string>;
}

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type StoredLine = Partial<SessionLogEntry> & { kind: 'header' | 'entry' | 'lane' | 'record' | 'fact'; version?: number; lane?: string; leafId?: string | null };

type NewEntry = { type: 'message'; id: string; message: AgentMessage } | { type: 'custom'; id: string; customType: string; data?: JsonValue };

const parse = (text: string): StoredLine => JSON.parse(text);

export class SessionLog implements SessionLogPort {
  private readonly entries = new Map<string, SessionLogEntry>();
  private seq = 0;
  private leaf: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private constructor(private readonly write: (line: string) => Promise<void>) {}

  static header(id: string, createdAt: number): string {
    return `${JSON.stringify({ kind: 'header', version: 4, id, createdAt, cwd: '/' })}\n`;
  }

  static load(text: string, write: (line: string) => Promise<void>) {
    const log = new SessionLog(write);
    const lines = text.split('\n');

    if (lines.at(-1) === '') lines.pop();
    const header = lines[0] ? parse(lines[0]) : undefined;

    if (header?.kind !== 'header' || header.version !== 4) throw new Error('会话记录缺少有效的开头');

    for (let index = 1; index < lines.length; index++) {
      let line: StoredLine;

      try { line = parse(lines[index]!); } catch (error) {
        if (index === lines.length - 1) return { log, repaired: `${lines.slice(0, index).join('\n')}\n` };

        throw error;
      }

      log.apply(line);
    }

    return { log, repaired: text.endsWith('\n') ? undefined : `${text}\n` };
  }

  async findEntriesOnBranch(_query: { order: 'oldestFirst' }): Promise<SessionLogEntry[]> {
    const branch: SessionLogEntry[] = [];

    for (let id = this.leaf; id !== null;) {
      const entry = this.entries.get(id);

      if (!entry || branch.length > this.entries.size) throw new Error(`会话记录分支损坏：${id}`);
      branch.push(entry);
      id = entry.parentId;
    }

    return structuredClone(branch.reverse());
  }

  async getEntry(id: string): Promise<SessionLogEntry | undefined> {
    const entry = this.entries.get(id);

    return entry && structuredClone(entry);
  }

  appendMessage(message: AgentMessage): Promise<string> {
    return this.append({ type: 'message', id: uuidv7(), message });
  }

  appendCustomEntry(customType: string, data?: JsonValue): Promise<string> {
    return this.append(data === undefined ? { type: 'custom', id: uuidv7(), customType } : { type: 'custom', id: uuidv7(), customType, data });
  }

  private append(fields: NewEntry): Promise<string> {
    const run = this.tail.then(async () => {
      const line = { kind: 'entry' as const, lane: 'main', ...structuredClone(fields), parentId: this.leaf, seq: this.seq + 1, timestamp: Date.now() };

      await this.write(`${JSON.stringify(line)}\n`);
      this.apply(line);

      return fields.id;
    });

    this.tail = run.catch(() => {});

    return run;
  }

  private apply(line: StoredLine) {
    if (line.seq !== undefined) this.seq = line.seq;

    if (line.kind === 'entry') {
      const { kind: _kind, lane, ...fields } = line;
      const entry = fields as SessionLogEntry;

      this.entries.set(entry.id, entry);

      if (lane === 'main') this.leaf = entry.id;
    } else if (line.kind === 'lane' && line.lane === 'main') this.leaf = line.leafId ?? null;
  }
}
