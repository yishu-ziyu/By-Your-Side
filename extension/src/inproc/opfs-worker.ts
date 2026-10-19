/**
 * OPFS 的同步读写（createSyncAccessHandle）只在专用 Worker 里可用。它能原地追加和截断，
 * 不像页面里的 createWritable 那样每次复制整个文件。
 * 每次操作完立刻 close：句柄占着文件的独占锁，不关的话页面里的 getFile、move、removeEntry 都会失败。
 * offscreen 文档被关掉重开时，旧 Worker 的锁不一定已经放开，所以拿锁失败要等一会儿再试。
 */
type SyncHandle = {
  getSize(): number;
  write(buffer: Uint8Array, options: { at: number }): number;
  truncate(size: number): void;
  close(): void;
};
export type OpfsWorkerRequest = { id: number; op: "write" | "append" | "truncate"; path: string; data?: Uint8Array; size?: number };
export type OpfsWorkerResponse = { id: number; error?: { name: string; message: string } };

async function open(path: string): Promise<SyncHandle> {
  const segments = path.split("/").filter(Boolean);
  const name = segments.pop()!;
  let dir = await navigator.storage.getDirectory();
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  const file = await dir.getFileHandle(name, { create: true });
  for (let waited = 0; ; waited += 50) {
    try {
      // SAFETY: createSyncAccessHandle 只在 WebWorker 的类型库里，扩展按 DOM 库编译。
      return await (file as unknown as { createSyncAccessHandle(): Promise<SyncHandle> }).createSyncAccessHandle();
    } catch (error) {
      if ((error as { name?: string })?.name !== "NoModificationAllowedError" || waited >= 3000) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/** 规范允许 write 只写进一部分而不报错；没写完就当失败，pi-durable 不能把半条记录当成已保存。 */
function writeAll(handle: SyncHandle, data: Uint8Array, at: number) {
  for (let done = 0; done < data.length;) {
    const n = handle.write(data.subarray(done), { at: at + done });
    if (n <= 0) throw new Error(`short write at ${at + done}`);
    done += n;
  }
}

async function run({ op, path, data, size }: OpfsWorkerRequest) {
  const handle = await open(path);
  try {
    if (op === "write") {
      handle.truncate(0);
      writeAll(handle, data!, 0);
    } else if (op === "append") writeAll(handle, data!, handle.getSize());
    else handle.truncate(size!);
  } finally {
    handle.close();
  }
}

self.onmessage = async (event: MessageEvent<OpfsWorkerRequest>) => {
  const response: OpfsWorkerResponse = { id: event.data.id };
  try {
    await run(event.data);
  } catch (error) {
    const e = error as { name?: string; message?: string };
    response.error = { name: e?.name ?? "Error", message: e?.message ?? String(error) };
  }
  self.postMessage(response);
};
