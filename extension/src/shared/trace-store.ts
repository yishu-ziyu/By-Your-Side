/**
 * 扩展内的诊断记录存储（IndexedDB，扩展源下 offscreen 与设置页共用）。
 * 行内容与本机 `~/.sideagent/traces/*.jsonl` 相同（格式由 shared/run-trace-core.ts 决定）；
 * 保留最近 TRACE_SESSIONS_KEPT 个会话，设置页可导出为一个 jsonl 文件或清空。
 */
import { TRACE_SESSIONS_KEPT, type TraceSink } from "../../../shared/run-trace-core.js";

const DB_NAME = "sideagent-diagnostics";

const SESSIONS = "trace-sessions";

const LINES = "trace-lines";

interface SessionRow { name: string }

interface LineRow { session: string; line: string }

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;

      db.createObjectStore(SESSIONS, { keyPath: "name" });
      db.createObjectStore(LINES, { autoIncrement: true }).createIndex("session", "session");
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

/** 全部行按写入顺序拼成一个 jsonl（每行自带 sessionId，可按会话拆回）；另给会话数与行数。 */
export async function exportTraces(): Promise<{ text: string; sessions: number; lines: number }> {
  const db = await openDb();
  const names = await sessionNames(db);
  // 一次请求读完：自增主键即写入顺序；分多次 await 会让只读事务中途失效。
  // SAFETY: LINES 里只写 LineRow（createTraceSink.append）。
  const rows = await result(db.transaction(LINES).objectStore(LINES).getAll()) as LineRow[];

  return { text: rows.map((row) => row.line).join(""), sessions: names.length, lines: rows.length };
}

export async function clearTraces(): Promise<void> {
  const tx = (await openDb()).transaction([SESSIONS, LINES], "readwrite");
  tx.objectStore(SESSIONS).clear();
  tx.objectStore(LINES).clear();
  await done(tx);
}
