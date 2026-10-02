/** Pi owns log format, sequencing, branch semantics and context recovery.
 * Its injected JSONL backend addresses virtual records in IndexedDB, not OS files. */
import { FileError, JsonlSessionRepo, type JsonlSessionRepoFileSystem, type FileInfo } from '@earendil-works/pi-agent-core';
import { durableTransaction, readRequest } from '../shared/durable-store.js';

type Item = { text: string; directory: boolean; modifiedAt: number };

const key = (path: string) => `pi:${path}`;

const normalize = (path: string) => {
  const parts: string[] = [];

  for (const part of path.split('/')) { if (part === '..') parts.pop(); else if (part && part !== '.') parts.push(part); }

  return '/'+parts.join('/');
};

const info = (path: string, item: Item): FileInfo => ({ path, name: path.split('/').at(-1)!, kind: item.directory ? 'directory' : 'file', size: new TextEncoder().encode(item.text).length, mtimeMs: item.modifiedAt });

async function result<T>(path: string, fn: () => Promise<T>) {
  try { return {ok: true as const, value: await fn()}; }
  catch (error) { return {ok: false as const, error: error instanceof FileError ? error : new FileError('unknown', String(error), path)}; }
}

const get = (store: IDBObjectStore, path: string) => readRequest<Item | undefined>(store.get(key(normalize(path))));

const requireItem = async (store: IDBObjectStore, path: string) => {
  const item = await get(store, path);

  if (!item) throw new FileError('not_found', '会话记录不存在', path);

  return item;
};

const text = (value: string | Uint8Array) => value instanceof Uint8Array ? new TextDecoder().decode(value) : value;

const fs: JsonlSessionRepoFileSystem = {
  absolutePath: path => result(path, async () => normalize(path)),
  joinPath: parts => result(parts.join('/'), async () => normalize(parts.join('/'))),
  readTextFile: path => result(path, () => durableTransaction(false, async store => (await requireItem(store,path)).text)),
  readTextLines: (path, options) => result(path, () => durableTransaction(false, async store => (await requireItem(store,path)).text.split('\n').slice(0, options?.maxLines))),
  writeFile: (path, content) => result(path, () => durableTransaction(true, async store => { await readRequest(store.put({text:text(content),directory:false,modifiedAt:Date.now()},key(normalize(path)))); })),
  appendFile: (path, content) => result(path, () => durableTransaction(true, async store => {
    const old = await get(store,path);

    if (old?.directory) throw new FileError('is_directory','不能向目录追加会话',path);
    await readRequest(store.put({text:(old?.text??'')+text(content),directory:false,modifiedAt:Date.now()},key(normalize(path))));
  })),
  renameFile: (source, destination) => result(source, () => durableTransaction(true, async store => {
    const item = await requireItem(store,source);
    await readRequest(store.put(item,key(normalize(destination)))); await readRequest(store.delete(key(normalize(source))));
  })),
  fileInfo: path => result(path, () => durableTransaction(false, async store => info(normalize(path), await requireItem(store,path)))),
  listDir: path => result(path, () => durableTransaction(false, async store => {
    const prefix=key(normalize(path))+'/';
    const range=IDBKeyRange.bound(prefix,prefix+'\uffff');
    const [keys, values]=await Promise.all([readRequest(store.getAllKeys(range)),readRequest<Item[]>(store.getAll(range))]);

    return keys.flatMap((k,i) => String(k).slice(prefix.length).includes('/') ? [] : [info(String(k).slice(3),values[i]!)]);
  })),
  exists: path => result(path, () => durableTransaction(false, async store => !!await get(store,path))),
  createDir: path => result(path, () => durableTransaction(true, async store => {
    const parts=normalize(path).split('/').filter(Boolean);

    for(let n=0;n<=parts.length;n++)await readRequest(store.put({text:'',directory:true,modifiedAt:Date.now()},key('/'+parts.slice(0,n).join('/'))));
  })),
  remove: (path, options) => result(path, () => durableTransaction(true, async store => {
    const normalized=normalize(path), item=await get(store,normalized);

    if(!item&&!options?.force)throw new FileError('not_found','会话记录不存在',path);

    if(item?.directory){
      const prefix=key(normalized)+'/', keys=await readRequest(store.getAllKeys(IDBKeyRange.bound(prefix,prefix+'\uffff')));

      if(keys.length&&!options?.recursive)throw new FileError('invalid','目录非空',path);

      for(const k of keys)await readRequest(store.delete(k));
    }

    await readRequest(store.delete(key(normalized)));
  })),
};

const repo = new JsonlSessionRepo({ fs, sessionsRoot: '/sessions' });

export async function openPiSession(conversationId: string) {
  const metadata = (await repo.list({cwd:'/'})).find(item => item.id === conversationId);

  return metadata ? repo.open(metadata) : repo.create({id:conversationId,cwd:'/'});
}
