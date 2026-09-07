import { USER_BLOCKED_ERROR } from "../../../shared/control.js";

type PageQueueState = {
  blocked: boolean;
  generation: number;
  tail: Promise<void>;
  running: Promise<unknown> | null;
};

/** 同一 tab 的完整短动作串行；思考和文案生成发生在调用本队列之前。 */
export class PageOperationQueue {
  private readonly pages = new Map<number, PageQueueState>();

  private state(tabId: number): PageQueueState {
    let state = this.pages.get(tabId);
    if (!state) {
      state = { blocked: false, generation: 0, tail: Promise.resolve(), running: null };
      this.pages.set(tabId, state);
    }
    return state;
  }

  run<T>(tabId: number, operation: () => Promise<T>, canWrite: () => boolean = () => true): Promise<T> {
    const state = this.state(tabId);
    if (state.blocked) return Promise.reject(new Error(USER_BLOCKED_ERROR));
    const generation = state.generation;
    const result = state.tail.then(async () => {
      if (state.blocked || state.generation !== generation || !canWrite()) throw new Error(USER_BLOCKED_ERROR);
      const running = operation();
      state.running = running;
      try { return await running; }
      finally { if (state.running === running) state.running = null; }
    });
    state.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  /** 先冻结新请求，再只等待已经开始的短动作到安全结束点。 */
  async takeover(tabId: number): Promise<void> {
    const state = this.state(tabId);
    state.blocked = true;
    state.generation += 1;
    const running = state.running;
    if (running) await Promise.allSettled([running]);
  }

  handback(tabId: number): void { this.state(tabId).blocked = false; }
  isBlocked(tabId: number): boolean { return this.state(tabId).blocked; }
}

export const pageOperationQueue = new PageOperationQueue();
export function takeoverTab(tabId: number): Promise<void> { return pageOperationQueue.takeover(tabId); }
export function handbackTab(tabId: number): void { pageOperationQueue.handback(tabId); }
