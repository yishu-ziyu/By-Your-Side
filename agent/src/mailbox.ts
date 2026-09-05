/**
 * 进程内工人邮箱：只传类型化工件（from/to/kind/body），不传活页面状态。
 * post 非阻塞；await_message 按 to=self + kind（可选 from）FIFO 匹配，先到先得。
 */

export interface Artifact {
  from: string;
  to: string;
  kind: string;
  body: string;
  ts: number;
}

export const DEFAULT_AWAIT_MS = 180_000;

interface Waiter {
  self: string;
  from?: string;
  kind: string;
  resolve: (a: Artifact) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  abort?: () => void;
}

export class Mailbox {
  private queue: Artifact[] = [];
  private waiters: Waiter[] = [];

  post(input: { from: string; to: string; kind: string; body: string }): Artifact {
    const to = input.to.trim();
    const kind = input.kind.trim();
    if (!to) throw new Error("post 需要 to");
    if (!kind) throw new Error("post 需要 kind");
    const art: Artifact = {
      from: input.from,
      to,
      kind,
      body: input.body,
      ts: Date.now(),
    };
    const idx = this.waiters.findIndex((w) => matches(w, art));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.abort?.();
      w.resolve(art);
      return art;
    }
    this.queue.push(art);
    return art;
  }

  awaitMessage(opts: {
    self: string;
    from?: string;
    kind: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<Artifact> {
    const kind = opts.kind.trim();
    if (!kind) return Promise.reject(new Error("await_message 需要 kind"));
    const from = opts.from?.trim() || undefined;
    const queued = this.queue.findIndex((a) => matches({ self: opts.self, from, kind }, a));
    if (queued >= 0) {
      return Promise.resolve(this.queue.splice(queued, 1)[0]!);
    }
    if (opts.signal?.aborted) return Promise.reject(new Error("await_message 已中止"));
    const timeoutMs = opts.timeoutMs ?? DEFAULT_AWAIT_MS;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        self: opts.self,
        from,
        kind,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeWaiter(waiter);
          reject(new Error(`await_message timed out after ${timeoutMs}ms (kind=${kind})`));
        }, timeoutMs),
      };
      const onAbort = (): void => {
        this.removeWaiter(waiter);
        reject(new Error("await_message 已中止"));
      };
      waiter.abort = () => opts.signal?.removeEventListener("abort", onAbort);
      opts.signal?.addEventListener("abort", onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get waiterCount(): number {
    return this.waiters.length;
  }

  waitingSessionIds(): string[] {
    return [...new Set(this.waiters.map((w) => w.self))];
  }

  clear(): void {
    for (const w of this.waiters) {
      clearTimeout(w.timer);
      w.abort?.();
      w.reject(new Error("mailbox cleared"));
    }
    this.waiters = [];
    this.queue = [];
  }

  private removeWaiter(waiter: Waiter): void {
    const i = this.waiters.indexOf(waiter);
    if (i >= 0) {
      const w = this.waiters.splice(i, 1)[0]!;
      clearTimeout(w.timer);
      w.abort?.();
    }
  }
}

function matches(w: { self: string; from?: string; kind: string }, a: Artifact): boolean {
  if (a.to !== w.self) return false;
  if (a.kind !== w.kind) return false;
  if (w.from && a.from !== w.from) return false;
  return true;
}
