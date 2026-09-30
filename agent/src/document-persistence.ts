/**
 * 一份整存整取的小文档（记忆、过往任务）的存放处。
 * 逻辑层只认这个接口：本机宿主用文件（document-file.ts），扩展用 IndexedDB（extension/src/inproc/document-idb.ts）。
 */
export interface DocumentPersistence {
  /** 读当前内容；从没写过时为 null。 */
  read(): Promise<string | null>;
  /** 独占执行一段「读-改-写」：同一文档的其他写入者等它结束。 */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  /** 整份替换。commitGuard 返回 false 时不落盘并抛错（例如这轮已被取消）。 */
  write(text: string, commitGuard?: () => boolean): Promise<void>;
}

/** 单进程内的简单互斥；扩展里只有一个核心实例时够用。 */
export class InProcessLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});

    return next;
  }
}
