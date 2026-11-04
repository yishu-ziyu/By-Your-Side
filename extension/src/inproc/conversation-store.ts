import type { ConversationPersistence, QueuedTask } from "@sideagent/agent/browser-core";
import { isConversationSummary, validConversationId, type ConversationSummary } from "../../../shared/protocol.js";
import { isReadingTranscript, type ReadingTranscript } from "../../../shared/reading.js";

const DB_NAME = "sideagent-conversations";

const STORE = "kv";

const INDEX_KEY = "index";

const READINGS_KEY = "readings";

const QUEUE_KEY = "queue";

const QUEUE_LIMIT = 200;

const ENDED: ReadonlyArray<QueuedTask["state"]> = ["completed", "cancelled", "failed"];

function trimQueue(jobs: QueuedTask[]): QueuedTask[] {
  const ended = jobs.filter((job) => ENDED.includes(job.state));
  const keep = new Set(ended.slice(-QUEUE_LIMIT));

  return jobs.filter((job) => !ENDED.includes(job.state) || keep.has(job));
}

type StoredValue = ConversationSummary[] | Record<string, ReadingTranscript> | QueuedTask[];

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("会话列表没能保存"));
  });
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };

    req.onsuccess = () => resolve(req.result);

    req.onerror = () => reject(req.error ?? new Error("会话列表没能打开"));
  });
}

function validSummaries(value: ConversationSummary[] | undefined): ConversationSummary[] {
  if (!Array.isArray(value)) return [];

  return value.filter(isConversationSummary).map((entry) => ({ ...entry, mode: "act", state: "idle" }));
}

export async function openConversationStore(log: (message: string) => void): Promise<ConversationPersistence> {
  let db: IDBDatabase | null = null;
  let summaries: ConversationSummary[] = [];
  let queue: readonly unknown[] = [];
  const readings = new Map<string, ReadingTranscript>();

  try {
    db = await openDb();
    const store = db.transaction(STORE).objectStore(STORE);
    const [index, stored, queued] = await Promise.all([request(store.get(INDEX_KEY)) as Promise<ConversationSummary[] | undefined>, request(store.get(READINGS_KEY)) as Promise<Record<string, ReadingTranscript> | undefined>, request(store.get(QUEUE_KEY)) as Promise<unknown>]);
    summaries = validSummaries(index);
    if (Array.isArray(queued)) queue = queued;

    for (const [id, transcript] of Object.entries(stored ?? {})) {
      if (validConversationId(id) && isReadingTranscript(transcript)) readings.set(id, transcript);
    }
  } catch (error) {
    log(`会话目录读取失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const write = (key: string, value: StoredValue) => {
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
      write(READINGS_KEY, Object.fromEntries(readings));
    },
    readingFor: (id) => readings.get(id),
    taskQueue: {
      load: () => queue,
      save: (jobs) => write(QUEUE_KEY, trimQueue(jobs)),
    },
  };
}
