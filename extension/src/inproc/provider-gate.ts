/**
 * 按服务商计数的并发闸门：同一服务商同时在途的模型请求不超过能力表登记的上限，多出来的在扩展里排队，
 * 不发出去撞服务商的「concurrent request limit」。没登记上限的服务商直接放行。
 * 主任务请求排在后台请求前面；正在跑的请求不打断。排队中被取消的请求当场出队，之后不会再发出。
 */
import { createAssistantMessageEventStream, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model } from "@earendil-works/pi-ai";

export type QueuePurpose = "main" | "side";

export interface ModelQueueWait { provider: string; purpose: QueuePurpose; waitedMs: number }

/** 排队超过这么久才记进诊断：更短的等待用户感觉不到，记了只添噪音。 */
export const QUEUE_RECORD_MS = 200;

/**
 * 后台请求遇到空名额也先让这么久：任务开头记忆判断比主任务请求早几十毫秒发出，先占了名额就要挡住用户等的回答。
 * 窗口内来了主任务请求就让它先走；窗口过后仍没有，后台请求照常发出。
 */
export const MAIN_FIRST_MS = 200;

type Release = () => void;

interface Waiter { purpose: QueuePurpose; grant: () => void }

interface Lane { limit: number; active: number; queue: Waiter[]; idle: Array<() => void>; sideTimer?: ReturnType<typeof setTimeout> }

export class ProviderGate {
  private readonly lanes = new Map<string, Lane>();

  constructor(private readonly limitOf: (provider: string) => number | undefined) {}

  limited(provider: string): boolean {
    return this.limitOf(provider) !== undefined;
  }

  /** 主任务请求：有空名额就当场占用；没有返回 undefined。 */
  tryAcquire(provider: string): Release | undefined {
    const lane = this.lane(provider);

    if (!lane) return () => {};

    if (lane.active >= lane.limit) return undefined;
    lane.active += 1;

    return this.releaser(lane);
  }

  /** 等到名额；排队中 signal 取消则出队并返回 undefined。 */
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

  /** 本扩展里这家服务商有在途或排着的请求。 */
  busy(provider: string): boolean {
    const lane = this.lanes.get(provider);

    return !!lane && (lane.active > 0 || lane.queue.length > 0);
  }

  /** 等到本扩展里这家服务商没有在途请求，也没有排着的。 */
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

  /** 没登记上限的服务商返回 undefined。 */
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

  /** 有空名额时放行队首：主任务请求当场放行；队首是后台请求（说明没有主任务请求在等）就先等主任务优先窗口。 */
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

/** 没发出去就结束的一次调用：形状同服务商适配层的取消或出错结局，调用方按原路处理。 */
export function unsentReply(model: Model<Api>, stopReason: "aborted" | "error", errorMessage: string): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: structuredClone(NO_USAGE), stopReason, errorMessage, timestamp: Date.now() };
}

/**
 * 取消后最多等适配层这么久收尾：名额在被取消的请求真正结束后才放，免得下一个请求在服务端还没收掉上一个时就到；
 * 适配层卡住不结束也一定放，名额不会漏掉。
 */
export const ABORT_RELEASE_MS = 2_000;

/** 请求结束时释放名额；被取消后超过 ABORT_RELEASE_MS 仍没结束就强制释放。返回「已结束」的回调。 */
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

/**
 * 流式调用过闸门：有空名额就当场发出（同步抛出的错误照旧交给调用方），否则先返回一条空流，拿到名额再发。
 * 要排队时同步调用 onQueued，交出一个在真正发出时兑现的 Promise：调用方的首字计时从那时算起。
 * 名额在源流读完时释放，不管结局是完成、出错、取消还是中途断开。
 */
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
  let sent!: () => void;
  onQueued?.(new Promise<void>(resolve => { sent = resolve; }));

  void gate.acquire(model.provider, purpose, signal).then(release => {
    noteWait(onWait, model.provider, purpose, queuedAt);

    if (!release) {
      out.push({ type: "error", reason: "aborted", error: unsentReply(model, "aborted", "Request was aborted") });
      out.end();

      return;
    }

    sent();

    try { run(release); } catch (error) {
      out.push({ type: "error", reason: "error", error: unsentReply(model, "error", error instanceof Error ? error.message : String(error)) });
      out.end();
    }
  });

  return out;
}

/** 一次性调用过闸门：拿到名额才发，结束（含出错、取消）即释放。排队中被取消返回取消结局，不发出。 */
export async function gatedCall(
  gate: ProviderGate, model: Model<Api>, purpose: QueuePurpose, signal: AbortSignal | undefined,
  call: () => Promise<AssistantMessage>, onWait: (wait: ModelQueueWait) => void,
): Promise<AssistantMessage> {
  if (!gate.limited(model.provider)) return call();
  const queuedAt = Date.now();
  const release = await gate.acquire(model.provider, purpose, signal);
  noteWait(onWait, model.provider, purpose, queuedAt);

  if (!release) return unsentReply(model, "aborted", "Request was aborted");
  const done = holdUntilDone(release, signal);

  try { return await call(); } finally { done(); }
}

function noteWait(onWait: (wait: ModelQueueWait) => void, provider: string, purpose: QueuePurpose, queuedAt: number): void {
  const waitedMs = Date.now() - queuedAt;

  // 后台请求每次都要让过主任务优先窗口，那段不算排队，否则每个后台判断都记一条。
  if (waitedMs <= QUEUE_RECORD_MS + (purpose === "side" ? MAIN_FIRST_MS : 0)) return;

  try { onWait({ provider, purpose, waitedMs }); } catch { /* Diagnostics only. */ }
}
