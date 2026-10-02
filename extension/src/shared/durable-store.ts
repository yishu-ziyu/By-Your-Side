/** 本扩展的会话日志与文件。事务完成后才报告保存成功；不访问用户文件系统。 */
export const DURABLE_DB = 'sideagent-session-data';

const STORE = 'items';

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DURABLE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch(error => { database = undefined; throw error; });

  return database;
}

export function readRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

export async function durableTransaction<T>(write: boolean, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  const db = await open();
  const tx = db.transaction(STORE, write ? 'readwrite' : 'readonly', { durability: 'strict' });

  const committed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error ?? new Error('会话保存失败'));
  });

  // Attach immediately, including callback failures that abort before awaiting commit.
  void committed.catch(() => {});

  try {
    const value = await fn(tx.objectStore(STORE));
    await committed;

    return value;
  } catch (error) {
    try { tx.abort(); } catch { /* Already finished. */ }

    throw error;
  }
}

export type StoredArtifact = { filename: string; content: string; encoding?: 'base64' };

const artifactKey = (conversationId: string, filename: string) => `artifact:${JSON.stringify([conversationId, filename])}`;

export async function readArtifact(conversationId: string, filename: string): Promise<StoredArtifact | undefined> {
  return durableTransaction(false, store => readRequest<StoredArtifact | undefined>(store.get(artifactKey(conversationId, filename))));
}

export function writeArtifact(conversationId: string, item: StoredArtifact): Promise<void> {
  return durableTransaction(true, async store => { await readRequest(store.put(item, artifactKey(conversationId, item.filename))); });
}

export function deleteArtifact(conversationId: string, filename: string): Promise<void> {
  return durableTransaction(true, async store => { await readRequest(store.delete(artifactKey(conversationId, filename))); });
}

export async function listArtifacts(conversationId: string): Promise<StoredArtifact[]> {
  const prefix = `artifact:${JSON.stringify([conversationId]).slice(0,-1)},`;

  return durableTransaction(false, store => readRequest<StoredArtifact[]>(store.getAll(IDBKeyRange.bound(prefix, prefix+'\uffff'))));
}
