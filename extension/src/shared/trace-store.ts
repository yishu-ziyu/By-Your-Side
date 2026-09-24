/**
 * 扩展内的诊断记录存储（IndexedDB，扩展源下 offscreen 与设置页共用）。
 * - 任务记录：行内容与本机 `~/.sideagent/traces/*.jsonl` 相同（shared/run-trace-core.ts），保留最近 TRACE_SESSIONS_KEPT 个会话。
 * - 语音记录：行内容与本机 `~/.sideagent/voice-capture/<日期>.jsonl` 相同（shared/voice-capture-core.ts），保留 VOICE_CAPTURE_MAX_AGE_DAYS 天；
 *   扩展不保存音频（本机也只在用户开启诊断时保存）。
 * 设置页可以导出（任务、语音各一个 jsonl）或清空。
 */
import { TRACE_SESSIONS_KEPT, type TraceSink } from "../../../shared/run-trace-core.js";
import { VOICE_CAPTURE_MAX_AGE_DAYS, voiceCaptureDayKey, type VoiceCaptureSink } from "../../../shared/voice-capture-core.js";

const DB_NAME = "sideagent-diagnostics";

const SESSIONS = "trace-sessions";

const LINES = "trace-lines";

const VOICE = "voice-lines";

interface VoiceRow { day: string; line: string }

interface SessionRow { name: string }

interface LineRow { session: string; line: string }

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    // 版本 1：任务记录；版本 2：加语音记录。按表名补建，旧库升级不丢任务记录。
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "name" });

      if (!db.objectStoreNames.contains(LINES)) db.createObjectStore(LINES, { autoIncrement: true }).createIndex("session", "session");

      if (!db.objectStoreNames.contains(VOICE)) db.createObjectStore(VOICE, { autoIncrement: true }).createIndex("day", "day");
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("诊断记录库打不开"));
  });
  // 打开失败时清掉缓存，下一次写入重新尝试；失败照样交给调用方（诊断写入会吞掉它）。
  opening.catch(() => { opening = null; });

  return opening;
}

/** 一次事务里的全部请求完成（或失败）时结束。 */
function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("诊断记录写入失败"));
    tx.onabort = () => reject(tx.error ?? new Error("诊断记录写入中止"));
  });
}

function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("诊断记录读取失败"));
  });
}

/** 删掉这些会话及其全部行。 */
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

/** 会话名以开始毫秒开头，按名字排序即按时间排序。 */
async function sessionNames(db: IDBDatabase): Promise<string[]> {
  // SAFETY: SESSIONS 的主键是 name 字符串（onupgradeneeded 里建的 keyPath）。
  const keys = await result(db.transaction(SESSIONS).objectStore(SESSIONS).getAllKeys()) as string[];

  return keys.sort();
}

export function createTraceSink(sessionName: string): TraceSink {
  return {
    async prepare() {
      const db = await openDb();
      const older = (await sessionNames(db)).filter((name) => name < sessionName);
      const tx = db.transaction([SESSIONS, LINES], "readwrite");
      deleteSessions(tx, older.slice(0, Math.max(0, older.length - (TRACE_SESSIONS_KEPT - 1))));
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
  };
}

/**
 * 语音记录的存储端。写入是异步的：appendLine 立即返回，失败只进日志，不影响语音链路。
 * 扩展不保存音频，writeAudio 抛错由记录器记成一条 gap（正常路径不会调用：会话开始时不开 persistAudio）。
 */
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

export interface DiagnosticsExport { traces: string; sessions: number; traceLines: number; voice: string; voiceLines: number }

/** 任务记录与语音记录各拼成一个 jsonl，按写入顺序；每行自带会话或语音编号，可再拆开。 */
export async function exportDiagnostics(): Promise<DiagnosticsExport> {
  const db = await openDb();
  const names = await sessionNames(db);
  // 一次事务、每张表一次请求读完：自增主键即写入顺序；分多次 await 会让只读事务中途失效。
  const tx = db.transaction([LINES, VOICE]);
  // SAFETY: 两张表里只写 LineRow / VoiceRow（见本文件的写入函数）。
  const [traceRows, voiceRows] = await Promise.all([result(tx.objectStore(LINES).getAll()) as Promise<LineRow[]>, result(tx.objectStore(VOICE).getAll()) as Promise<VoiceRow[]>]);

  return {
    traces: traceRows.map((row) => row.line).join(""), sessions: names.length, traceLines: traceRows.length,
    voice: voiceRows.map((row) => row.line).join(""), voiceLines: voiceRows.length,
  };
}

export async function clearDiagnostics(): Promise<void> {
  const tx = (await openDb()).transaction([SESSIONS, LINES, VOICE], "readwrite");
  tx.objectStore(SESSIONS).clear();
  tx.objectStore(LINES).clear();
  tx.objectStore(VOICE).clear();
  await done(tx);
}
