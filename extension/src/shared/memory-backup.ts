/**
 * 记忆备份：卸载扩展时 Chrome 会删掉它的全部存储，记忆只在这里另存一份到下载文件夹，重装后从设置页选文件恢复。
 * 后台、离屏宿主、设置页共用的键、文件格式和读写。凭据（inproc_cred:*、settings_connection:*）从不进备份。
 */
import { BROWSE_ON_KEY } from "./browse-habits.js";

/** 离屏宿主 → 后台：记忆库刚写过，排一次备份。 */
export const MEMORY_CHANGED = "memory_backup_changed";

/** chrome.storage.local：这次安装的开始时间（毫秒）。备份文件名带上它，重装后的新安装不会覆盖旧安装留下的那份。 */
export const BACKUP_INSTALL_KEY = "memory_backup_install";

/** chrome.storage.local：最近一次备份 { at, file }，设置页显示。 */
export const BACKUP_LAST_KEY = "memory_backup_last";

export const BACKUP_FOLDER = "By-Your-Side";

/** 自定义类型只用来认出自己发起的下载：网页操作的下载记录要排除它。 */
const BACKUP_URL_PREFIX = "data:application/x-by-your-side-memory-backup+json;base64,";

/**
 * 备份文件明文落在下载文件夹：浏览记录、习惯归纳和删除名单都由网页内容生成（网址查询串、输入框的值可能带 token），
 * 只带开关；习惯在重装后重新从浏览里学。
 */
export const BACKUP_STORAGE_KEYS = [BROWSE_ON_KEY] as const;

/**
 * 只备份用户已经确认或做成的内容。pending-memory 存着还没判完的原话，habits 存着从浏览里数出来的计数，都不出这个扩展。
 * 恢复时也只认这几份，别的键一律拒绝。
 */
const BACKUP_DOCUMENTS = ["memories", "tasks", "site-notes"] as const;

const FORMAT = "by-your-side-memory-backup";
const VERSION = 1;

/** 与 inproc/document-idb.ts 同一个库；那边的锁名是 `${DB_NAME}:${key}`，恢复时用同名锁，避免和宿主的读改写交错。 */
const DB_NAME = "sideagent-memory";
const STORE = "kv";

export interface MemoryBackup {
  format: typeof FORMAT;
  version: typeof VERSION;
  savedAt: number;
  extensionVersion: string;
  /** IndexedDB 里每一份文档的原文（记忆、过往任务、站点笔记、习惯计数等）。 */
  documents: Record<string, string>;
  storage: Partial<Record<(typeof BACKUP_STORAGE_KEYS)[number], unknown>>;
}

export function isOwnBackupDownload(item: { url?: string; finalUrl?: string }): boolean {
  return (item.url ?? "").startsWith(BACKUP_URL_PREFIX) || (item.finalUrl ?? "").startsWith(BACKUP_URL_PREFIX);
}

export function backupFileName(installAt: number): string {
  const d = new Date(installAt);
  const pad = (n: number) => String(n).padStart(2, "0");

  return `${BACKUP_FOLDER}/记忆备份-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);

    req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("记忆没能打开"));
  });
}

function settle<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("记忆没能读出"));
  });
}

/** 记忆库里的全部文档；只收字符串值，和 IdbDocument 存的形状一致。 */
export async function readMemoryDocuments(): Promise<Record<string, string>> {
  const db = await openDb();

  try {
    const store = db.transaction(STORE).objectStore(STORE);
    const [keys, values] = await Promise.all([settle(store.getAllKeys()), settle(store.getAll())]);
    const out: Record<string, string> = {};

    keys.forEach((key, i) => { if (isBackupDocument(key) && typeof values[i] === "string") out[key] = values[i]; });

    return out;
  } finally {
    db.close();
  }
}

/** 逐份整体替换，每份都在宿主同名的锁里写。 */
async function writeMemoryDocuments(documents: Record<string, string>): Promise<void> {
  const db = await openDb();

  try {
    for (const [key, text] of Object.entries(documents)) {
      await navigator.locks.request(`${DB_NAME}:${key}`, () => new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite", { durability: "strict" });
        tx.objectStore(STORE).put(text, key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error("记忆没能保存"));
        tx.onabort = () => reject(tx.error ?? new Error("记忆没能保存"));
      }));
    }
  } finally {
    db.close();
  }
}

export async function collectBackup(): Promise<MemoryBackup> {
  const documents = await readMemoryDocuments();
  const stored = await chrome.storage.local.get([...BACKUP_STORAGE_KEYS]);
  const storage: MemoryBackup["storage"] = {};

  for (const key of BACKUP_STORAGE_KEYS) if (stored[key] !== undefined) storage[key] = stored[key];

  return { format: FORMAT, version: VERSION, savedAt: Date.now(), extensionVersion: chrome.runtime.getManifest().version, documents, storage };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function isBackupDocument(key: unknown): key is (typeof BACKUP_DOCUMENTS)[number] {
  return typeof key === "string" && (BACKUP_DOCUMENTS as readonly string[]).includes(key);
}

/** 每份文档都必须是 JSON 对象；宿主读到不认识的版本会只读不写，但损坏的文本会让它报错。 */
function isDocumentText(text: string): boolean {
  try {
    return isRecord(JSON.parse(text));
  } catch {
    return false;
  }
}

/** 用户选的文件：形状不对就返回原因，不写任何东西。 */
export function parseBackup(text: string): MemoryBackup | string {
  let raw: unknown;

  try {
    raw = JSON.parse(text);
  } catch {
    return "这不是 JSON 文件。";
  }

  if (!isRecord(raw) || raw.format !== FORMAT) return "这不是 By Your Side 的记忆备份。";

  if (raw.version !== VERSION) return "这份备份来自更新的版本，先把扩展更新到最新再恢复。";

  if (!isRecord(raw.documents) || !isRecord(raw.storage)) return "备份文件不完整。";
  const documents: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw.documents)) {
    if (!isBackupDocument(key) || typeof value !== "string" || !isDocumentText(value)) return "备份文件里有看不懂的内容。";
    documents[key] = value;
  }

  const storage: MemoryBackup["storage"] = {};

  if (typeof raw.storage[BROWSE_ON_KEY] === "boolean") storage[BROWSE_ON_KEY] = raw.storage[BROWSE_ON_KEY];

  return {
    format: FORMAT, version: VERSION,
    savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
    extensionVersion: typeof raw.extensionVersion === "string" ? raw.extensionVersion : "",
    documents, storage,
  };
}

/** 生效中的记忆条数与过往任务条数；读不懂的文档按 0 算。 */
export function countBackup(documents: Record<string, string>): { memories: number; tasks: number } {
  const entries = (text: string | undefined, field: string): unknown[] => {
    try {
      const parsed: unknown = JSON.parse(text ?? "null");
      const list = isRecord(parsed) ? parsed[field] : undefined;

      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  };

  return {
    memories: entries(documents.memories, "entries").filter(e => isRecord(e) && e.status === "active").length,
    tasks: entries(documents.tasks, "tasks").length,
  };
}

export async function restoreBackup(backup: MemoryBackup): Promise<void> {
  await writeMemoryDocuments(backup.documents);

  if (Object.keys(backup.storage).length) await chrome.storage.local.set(backup.storage);
}

/** UTF-8 文本 → base64；大文本分段转，避免 String.fromCharCode 参数过多。 */
export function backupDataUrl(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";

  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));

  return BACKUP_URL_PREFIX + btoa(binary);
}
