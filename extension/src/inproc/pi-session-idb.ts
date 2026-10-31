/** Conversation logs in IndexedDB. Keys and item shape are the ones Pi 0.84.4's JSONL store wrote, so old conversations still open. */
import { SessionLog } from '@sideagent/agent/browser-core';
import { durableTransaction, readRequest } from '../shared/durable-store.js';

type Item = { text: string; directory: boolean; modifiedAt: number };

const DIRECTORY = 'pi:/sessions/----';

const put = (store: IDBObjectStore, key: string, item: Item) => readRequest(store.put(item, key));

const appendLine = (key: string) => (line: string) => durableTransaction(true, async store => {
  const old = await readRequest<Item | undefined>(store.get(key));

  await put(store, key, { text: (old?.text ?? '') + line, directory: false, modifiedAt: Date.now() });
});

export async function openPiSession(conversationId: string): Promise<SessionLog> {
  const started = performance.now();
  const found = await durableTransaction(false, async store => {
    const range = IDBKeyRange.bound(`${DIRECTORY}/`, `${DIRECTORY}/￿`);
    const keys = await readRequest(store.getAllKeys(range));
    // 恢复某个会话时不能把其他会话正文也搬进内存；同 id 的多个旧文件仍按修改时间取最新。
    const candidates = keys.map(String)
      .filter(key => !key.slice(DIRECTORY.length + 1).includes('/') && key.endsWith(`_${conversationId}.jsonl`));
    const matches = (await Promise.all(candidates.map(async key => ({ key, item: await readRequest<Item>(store.get(key)) }))))
      .filter(({ item }) => !item.directory);

    return matches.sort((left, right) => right.item.modifiedAt - left.item.modifiedAt)[0];
  });

  performance.measure('sideagent.startup.session-read', { start: started });

  if (found) {
    const { log, repaired } = SessionLog.load(found.item.text, appendLine(found.key));

    if (repaired !== undefined) await durableTransaction(true, store => put(store, found.key, { text: repaired, directory: false, modifiedAt: Date.now() }));

    return log;
  }

  const createdAt = Date.now();
  const key = `${DIRECTORY}/${new Date(createdAt).toISOString().replace(/[:.]/g, '-')}_${conversationId}.jsonl`;
  const header = SessionLog.header(conversationId, createdAt);

  await durableTransaction(true, async store => {
    // Pi also stored its parent directories as items; keep them so an older build still lists this log.
    for (const directory of ['pi:/', 'pi:/sessions', DIRECTORY]) await put(store, directory, { text: '', directory: true, modifiedAt: createdAt });
    await put(store, key, { text: header, directory: false, modifiedAt: createdAt });
  });

  return SessionLog.load(header, appendLine(key)).log;
}
