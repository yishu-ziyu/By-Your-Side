/**
 * 扩展内 agent 的会话目录（IndexedDB）。offscreen 文档崩溃、被 Chrome 回收或扩展重载后，
 * 新起的核心按这里重建会话，侧栏手里的会话编号仍然有效，重发不再落到不存在的会话上。
 *
 * 只存会话摘要和阅读交接；模型上下文（浏览器版 agent 循环的消息）仍只在内存里，重启后从空上下文继续。
 * 核心的 load() 是同步的，所以先用 openConversationStore() 读进内存；写入是后台的，失败只记日志。
 */
import type { ConversationPersistence } from "@sideagent/agent/browser-core";
import { validConversationId, type ConversationSummary } from "../../../shared/protocol.js";
import { isReadingTranscript, type ReadingTranscript } from "../../../shared/reading.js";

const DB_NAME = "sideagent-conversations";

const STORE = "kv";

const INDEX_KEY = "index";

const readingKey = (id: string) => `reading:${id}`;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("会话目录读写失败"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("会话目录打不开"));
  });
}

/** 与本机 ConversationStore.load 同样的形状校验；重启后一律回到空闲，不续跑旧的外部动作。 */
function validSummaries(value: unknown): ConversationSummary[] {
  if (!Array.isArray(value)) return [];

  return value.filter((entry): entry is ConversationSummary => entry && validConversationId(entry.id) && typeof entry.title === "string" && typeof entry.createdAt === "number" && typeof entry.updatedAt === "number" && (entry.mode === "act" || entry.mode === "teach"))
    .map((entry) => ({ ...entry, state: "idle" }));
}

export async function openConversationStore(log: (message: string) => void): Promise<ConversationPersistence> {
  let db: IDBDatabase | null = null;
  let summaries: ConversationSummary[] = [];
  const readings = new Map<string, ReadingTranscript>();

  try {
    db = await openDb();
    const tx = db.transaction(STORE);
    const store = tx.objectStore(STORE);
    const [index, keys] = await Promise.all([request(store.get(INDEX_KEY)), request(store.getAllKeys())]);
    summaries = validSummaries(index);

    for (const key of keys) {
      if (typeof key !== "string" || !key.startsWith("reading:")) continue;
      const value: unknown = await request(db.transaction(STORE).objectStore(STORE).get(key));

      if (isReadingTranscript(value)) readings.set(key.slice("reading:".length), value);
    }
  } catch (error) {
    // 打不开就退回只在内存里的会话（与改前相同），任务照常可用。
    log(`会话目录读取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const write = (key: string, value: unknown) => {
    if (!db) return;

    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.onerror = () => log(`会话目录写入失败：${tx.error?.message ?? "未知原因"}`);
    } catch (error) {
      log(`会话目录写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return {
    load: () => summaries,
    save(next) {
      summaries = next;
      write(INDEX_KEY, next);
    },
    saveReading(id, transcript) {
      if (!validConversationId(id) || !isReadingTranscript(transcript)) throw new Error("Invalid reading handoff");
      readings.set(id, transcript);
      write(readingKey(id), transcript);
    },
    readingFor: (id) => readings.get(id),
  };
}
