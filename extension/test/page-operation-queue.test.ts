import { describe, expect, it } from "vitest";
import { PageOperationQueue } from "../src/background/page-operation-queue.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });

  return { promise, resolve };
}

describe("page operation queue", () => {
  it("完整短动作结束后才让下一位操作者开始", async () => {
    const queue = new PageOperationQueue();
    const releaseFirst = deferred<void>();
    const events: string[] = [];

    const first = queue.run(7, async () => {
      events.push("甲:核对", "甲:focus", "甲:输入");
      await releaseFirst.promise;
      events.push("甲:读回");

      return "甲";
    });

    const second = queue.run(7, async () => {
      events.push("乙:核对", "乙:focus", "乙:输入", "乙:读回");

      return "乙";
    });

    await Promise.resolve();
    expect(events).toEqual(["甲:核对", "甲:focus", "甲:输入"]);
    releaseFirst.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual(["甲", "乙"]);
    expect(events).toEqual(["甲:核对", "甲:focus", "甲:输入", "甲:读回", "乙:核对", "乙:focus", "乙:输入", "乙:读回"]);
  });

  it("接管立即挡住排队与迟到写，只等待在途短动作", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    const events: string[] = [];
    const inflight = queue.run(9, async () => { events.push("inflight"); await release.promise; events.push("safe"); });
    await Promise.resolve();
    const queued = queue.run(9, async () => { events.push("queued"); });
    const takeover = queue.takeover(9);
    await expect(queue.run(9, async () => { events.push("late"); })).rejects.toThrow(/页面现在归你/);
    release.resolve();
    await inflight;
    await takeover;
    await expect(queued).rejects.toThrow(/页面现在归你/);
    expect(events).toEqual(["inflight", "safe"]);

    queue.handback(9);
    await expect(queue.run(9, async () => "restored")).resolves.toBe("restored");
  });

  it("接管后立刻交还也不会复活接管前已排队的写", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    const first = queue.run(10, async () => { await release.promise; });
    await Promise.resolve();
    const oldQueued = queue.run(10, async () => "stale");
    const takeover = queue.takeover(10);
    queue.handback(10);
    release.resolve();
    await first;
    await takeover;
    await expect(oldQueued).rejects.toThrow(/页面现在归你/);
    await expect(queue.run(10, async () => "fresh")).resolves.toBe("fresh");
  });

  it("不同页可并行，控制门在真正获锁后复查", async () => {
    const queue = new PageOperationQueue();
    const release = deferred<void>();
    let allowed = true;
    const first = queue.run(1, async () => { await release.promise; });
    const stale = queue.run(1, async () => "must-not-run", () => allowed);
    const other = queue.run(2, async () => "other-conversation");
    await expect(other).resolves.toBe("other-conversation");
    allowed = false;
    release.resolve();
    await first;
    await expect(stale).rejects.toThrow(/页面现在归你/);
  });
});
