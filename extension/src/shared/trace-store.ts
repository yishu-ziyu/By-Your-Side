import { expiredSessions, type TraceSink } from "../../../shared/run-trace-core.js";
import { redactStoredTrace } from "../../../shared/trace-sanitize.js";
import { VOICE_CAPTURE_MAX_AGE_DAYS, voiceCaptureDayKey, type VoiceCaptureSink } from "../../../shared/voice-capture-core.js";

const DB_NAME = "sideagent-diagnostics";

const SESSIONS = "trace-sessions";

const LINES = "trace-lines";

const VOICE = "voice-lines";

const PROMPTS = "trace-prompts";

interface VoiceRow { day: string; line: string }

interface SessionRow { name: string }

interface LineRow { session: string; line: string }

interface PromptRow { hash: string; text: string }

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "name" });

      if (!db.objectStoreNames.contains(LINES)) db.createObjectStore(LINES, { autoIncrement: true }).createIndex("session", "session");

      if (!db.objectStoreNames.contains(VOICE)) db.createObjectStore(VOICE, { autoIncrement: true }).createIndex("day", "day");

      if (!db.objectStoreNames.contains(PROMPTS)) db.createObjectStore(PROMPTS, { keyPath: "hash" });
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("诊断记录没能打开"));
  });
  opening.catch(() => { opening = null; });

  return opening;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("诊断记录没能保存"));
    tx.onabort = () => reject(tx.error ?? new Error("诊断记录没能保存"));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("诊断记录没能读出"));
  });
}

function deleteSessions(tx: IDBTransaction, names: readonly string[]): void {
  const lines = tx.objectStore(LINES).index("session");

  for (const name of names) {
    tx.objectStore(SESSIONS).delete(name);
    const cursor = lines.openKeyCursor(IDBKeyRange.only(name));
    cursor.onsuccess = () => {
      const at = cursor.result;

      if (!at) return;
      tx.objectStore(LINES).delete(at.primaryKey);
      at.continue();
    };
  }
}

async function sessionNames(db: IDBDatabase): Promise<string[]> {
  const keys = await result(db.transaction(SESSIONS).objectStore(SESSIONS).getAllKeys()) as string[];

  return keys.sort();
}

export function createTraceSink(sessionName: string): TraceSink {
  return {
    async prepare() {
      const db = await openDb();
      const older = (await sessionNames(db)).filter((name) => name < sessionName);
      const tx = db.transaction([SESSIONS, LINES], "readwrite");
      deleteSessions(tx, expiredSessions(older));
      const row: SessionRow = { name: sessionName };
      tx.objectStore(SESSIONS).put(row);
      await done(tx);
    },
    async append(line) {
      const tx = (await openDb()).transaction(LINES, "readwrite");
      const row: LineRow = { session: sessionName, line };
      tx.objectStore(LINES).add(row);
      await done(tx);
    },
    async savePrompt(hash, text) {
      const tx = (await openDb()).transaction(PROMPTS, "readwrite");
      const row: PromptRow = { hash, text };
      tx.objectStore(PROMPTS).put(row);
      await done(tx);
    },
  };
}

export function createVoiceCaptureSink(log: (message: string) => void): VoiceCaptureSink {
  const fail = (error: Error) => log(`[voice-capture] 写入失败：${error.message}`);

  return {
    appendLine(day, line) {
      void openDb().then((db) => {
        const tx = db.transaction(VOICE, "readwrite");
        const row: VoiceRow = { day, line };
        tx.objectStore(VOICE).add(row);

        return done(tx);
      }).catch(fail);
    },
    writeAudio() {
      throw new Error("扩展暂不保存语音音频");
    },
    cleanup(now) {
      const cutoff = voiceCaptureDayKey(now - VOICE_CAPTURE_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

      void openDb().then((db) => {
        const tx = db.transaction(VOICE, "readwrite");
        const cursor = tx.objectStore(VOICE).index("day").openKeyCursor(IDBKeyRange.upperBound(cutoff, true));
        cursor.onsuccess = () => {
          const at = cursor.result;

          if (!at) return;
          tx.objectStore(VOICE).delete(at.primaryKey);
          at.continue();
        };

        return done(tx);
      }).catch(fail);
    },
  };
}

interface DiagnosticsExport { traces: string; sessions: number; traceLines: number; voice: string; voiceLines: number }

function redactLine(line: string): string {
  let event: unknown;

  try {
    event = JSON.parse(line);
  } catch {
    return `${JSON.stringify(redactStoredTrace(line.trimEnd()))}\n`;
  }

  const record = event as Record<string, unknown> | null;

  return `${JSON.stringify(record && typeof record === "object" && !Array.isArray(record) && "data" in record ? { ...record, data: redactStoredTrace(record.data) } : redactStoredTrace(event))}\n`;
}

export async function exportDiagnostics(): Promise<DiagnosticsExport> {
  const db = await openDb();
  const names = await sessionNames(db);
  const tx = db.transaction([LINES, VOICE]);
  const [traceRows, voiceRows] = await Promise.all([result(tx.objectStore(LINES).getAll()) as Promise<LineRow[]>, result(tx.objectStore(VOICE).getAll()) as Promise<VoiceRow[]>]);

  return {
    traces: traceRows.map((row) => redactLine(row.line)).join(""), sessions: names.length, traceLines: traceRows.length,
    voice: voiceRows.map((row) => row.line).join(""), voiceLines: voiceRows.length,
  };
}

export async function clearDiagnostics(): Promise<void> {
  const tx = (await openDb()).transaction([SESSIONS, LINES, VOICE, PROMPTS], "readwrite");
  tx.objectStore(SESSIONS).clear();
  tx.objectStore(LINES).clear();
  tx.objectStore(VOICE).clear();
  tx.objectStore(PROMPTS).clear();
  await done(tx);
}
