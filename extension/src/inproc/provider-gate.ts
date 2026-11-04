import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

export type QueuePurpose = "main" | "side";

export interface ModelQueueWait { provider: string; purpose: QueuePurpose; waitedMs: number }

const QUEUE_RECORD_MS = 200;

const MAIN_FIRST_MS = 200;

type Release = () => void;

interface Waiter { purpose: QueuePurpose; grant: () => void }

interface Lane { limit: number; active: number; queue: Waiter[]; idle: Array<() => void>; sideTimer?: ReturnType<typeof setTimeout> }

export class ProviderGate {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly limitOf: (provider: string) => number | undefined) {}

  limited(provider: string): boolean {
    return this.limitOf(provider) !== undefined;
  }

  tryAcquire(provider: string): Release | undefined {
    const lane = this.lane(provider);

    if (!lane) return () => {};

    if (lane.active >= lane.limit) return undefined;
    lane.active += 1;

    return this.releaser(lane);
  }

  async acquire(provider: string, purpose: QueuePurpose, signal: AbortSignal | undefined): Promise<Release | undefined> {
    const lane = this.lane(provider);

    if (!lane) return () => {};

    if (purpose === "main") {
      const now = this.tryAcquire(provider);

      if (now) return now;
    }

    if (signal?.aborted) return undefined;

    return new Promise(resolve => {
      const cancel = () => {
        const at = lane.queue.indexOf(waiter);

        if (at >= 0) lane.queue.splice(at, 1);
        resolve(undefined);
        this.wakeIfIdle(lane);
      };

      const waiter: Waiter = {
        purpose,
        grant: () => {
          signal?.removeEventListener("abort", cancel);
          lane.active += 1;
          resolve(this.releaser(lane));
        },
      };

      signal?.addEventListener("abort", cancel, { once: true });
      const firstSide = purpose === "main" ? lane.queue.findIndex(w => w.purpose === "side") : -1;

      if (firstSide < 0) lane.queue.push(waiter);
      else lane.queue.splice(firstSide, 0, waiter);
      this.grantNext(lane);
    });
  }

  busy(provider: string): boolean {
    const lane = this.lanes.get(provider);

    return !!lane && (lane.active > 0 || lane.queue.length > 0);
  }

  idle(provider: string, signal: AbortSignal | undefined): Promise<void> {
    const lane = this.lanes.get(provider);

    if (!lane || (lane.active === 0 && !lane.queue.length) || signal?.aborted) return Promise.resolve();

    return new Promise(resolve => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        const at = lane.idle.indexOf(done);

        if (at >= 0) lane.idle.splice(at, 1);
        resolve();
      };

      lane.idle.push(done);
      signal?.addEventListener("abort", done, { once: true });
    });
  }

  private lane(provider: string): Lane | undefined {
    const limit = this.limitOf(provider);

    if (limit === undefined) return undefined;
    let lane = this.lanes.get(provider);

    if (!lane) {
      lane = { limit, active: 0, queue: [], idle: [] };
      this.lanes.set(provider, lane);
    }

    return lane;
  }

  private grantNext(lane: Lane): void {
    while (lane.active < lane.limit && lane.queue.length) {
      if (lane.queue[0]!.purpose === "side") {
        lane.sideTimer ??= setTimeout(() => {
          lane.sideTimer = undefined;

          while (lane.active < lane.limit && lane.queue.length) lane.queue.shift()!.grant();
        }, MAIN_FIRST_MS);

        return;
      }

      lane.queue.shift()!.grant();
    }

    this.wakeIfIdle(lane);
  }

  private wakeIfIdle(lane: Lane): void {
    if (lane.active === 0 && !lane.queue.length) for (const wake of [...lane.idle]) wake();
  }

  private releaser(lane: Lane): Release {
    let released = false;

    return () => {
      if (released) return;
      released = true;
      lane.active -= 1;
      this.grantNext(lane);
    };
  }
}

const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function unsentReply(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: structuredClone(NO_USAGE), stopReason, errorMessage, timestamp: Date.now() };
}

const ABORT_RELEASE_MS = 2_000;

function holdUntilDone(release: Release, signal: AbortSignal | undefined): () => void {
  let forced: ReturnType<typeof setTimeout> | undefined;
  const onAbort = () => { forced = setTimeout(release, ABORT_RELEASE_MS); };

  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });

  return () => {
    signal?.removeEventListener("abort", onAbort);
    clearTimeout(forced);
    release();
  };
}

export function gatedStream(
  gate: ProviderGate, model: Model<Api>, purpose: QueuePurpose, signal: AbortSignal | undefined,
  start: () => AssistantMessageEventStream, onWait: (wait: ModelQueueWait) => void, onQueued?: (sent: Promise<void>) => void,
): AssistantMessageEventStream {
  if (!gate.limited(model.provider)) return start();
  const out = createAssistantMessageEventStream();
  const now = purpose === "main" ? gate.tryAcquire(model.provider) : undefined;

  const run = (release: Release) => {
    const done = holdUntilDone(release, signal);
    let source: AssistantMessageEventStream;

    try { source = start(); } catch (error) {
      done();
      throw error;
    }

    void (async () => {
      try {
        for await (const event of source) out.push(event);
      } finally {
        done();
        out.end();
      }
    })();
  };

  if (now) {
    run(now);

    return out;
  }

  const queuedAt = Date.now();
  let markSent = () => {};
  const sent = new Promise<void>(resolve => { markSent = resolve; });

  try { onQueued?.(sent); } catch {  }

  void gate.acquire(model.provider, purpose, signal).then(release => {
    if (!release) {
      noteWait(onWait, model.provider, purpose, queuedAt);
      out.push({ type: "error", reason: "aborted", error: unsentReply(model, "aborted", "Request was aborted") });
      out.end();

      return;
    }

    try {
      markSent();
      noteWait(onWait, model.provider, purpose, queuedAt);
      run(release);
    } catch (error) {
      release();
      out.push({ type: "error", reason: "error", error: unsentReply(model, "error", error instanceof Error ? error.message : String(error)) });
      out.end();
    }
  });

  return out;
}

export async function gatedCall(
  gate: ProviderGate, model: Model<Api>, purpose: QueuePurpose, signal: AbortSignal | undefined,
  call: () => Promise<AssistantMessage>, onWait: (wait: ModelQueueWait) => void,
): Promise<AssistantMessage> {
  if (!gate.limited(model.provider)) return call();
  const queuedAt = Date.now();
  const release = await gate.acquire(model.provider, purpose, signal);

  if (!release) {
    noteWait(onWait, model.provider, purpose, queuedAt);

    return unsentReply(model, "aborted", "Request was aborted");
  }

  const done = holdUntilDone(release, signal);

  try {
    noteWait(onWait, model.provider, purpose, queuedAt);

    return await call();
  } finally { done(); }
}

function noteWait(onWait: (wait: ModelQueueWait) => void, provider: string, purpose: QueuePurpose, queuedAt: number): void {
  const waitedMs = Date.now() - queuedAt;

  if (waitedMs <= QUEUE_RECORD_MS + (purpose === "side" ? MAIN_FIRST_MS : 0)) return;

  try { onWait({ provider, purpose, waitedMs }); } catch {  }
}
