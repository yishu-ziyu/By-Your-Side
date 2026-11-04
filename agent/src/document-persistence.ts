export interface DocumentPersistence {
  read(): Promise<string | null>;
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  write(text: string, commitGuard?: () => boolean): Promise<void>;
}

export class InProcessLock {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => {});

    return next;
  }
}
