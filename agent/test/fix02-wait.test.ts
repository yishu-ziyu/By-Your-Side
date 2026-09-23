/**
 * FIX-02 等待反例：期望值来自任务书外部判据，不用实现重算。
 * 覆盖：在途未结束不 idle、失败/重定向、ring/clear、捕获不完整、abort/权限、
 * 页面身份串扰、子调用身份、等待状态不冒充。
 */
import { describe, expect, it, vi } from "vitest";
import { runBrowserProgram, type ProgramStep } from "../src/browser-program.js";
import {
  NETWORK_IDLE_EXCLUDED_TYPES,
  appendNetworkEntry,
  applyNetworkLifecycle,
  clearNetworkDisplay,
  createNetworkLifecycle,
  idleObservation,
  markCaptureDetached,
  markCaptureEnabled,
  markCaptureGap,
  markCaptureRestart,
  networkEventToUpdate,
  patchNetworkEntry,
  restartNetworkEntry,
  type NetworkEntry,
} from "../../shared/network.js";

/**
 * Host tool arguments `runBrowserProgram` forwards to `call` (ProgramOptions.call in
 * browser-program.ts): composed helpers pass fixed shapes, while browser.* aliases forward the
 * user's own JSON arguments, so one stub sees a per-call object carrying a subset of these.
 */
interface BrowserProgramToolParams {
  code?: string;
  tabId?: number;
  target?: string;
  properties?: readonly string[];
  expect?: { property: string; equals: boolean | string };
  types?: string;
  limit?: number;
  downloadId?: string;
  paths?: readonly string[];
}

const entry = (overrides: Partial<NetworkEntry> = {}): NetworkEntry => ({
  requestId: "r1",
  method: "GET",
  url: "https://api.example.com/slow",
  resourceType: "xhr",
  startedAt: 1_000,
  ...overrides,
});

describe("FIX-02 network-idle 生命周期（纯函数）", () => {
  it("在途请求未结束时不能判定 idle，即使 total/dropped 不变", () => {
    let life = createNetworkLifecycle();
    life = markCaptureEnabled(life, { mode: "fresh" });

    const start = networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "slow",
      type: "XHR",
      timestamp: 1,
      request: { url: "https://api.example.com/slow", method: "GET" },
    }, 1_000)!;

    life = applyNetworkLifecycle(life, start, 1_000);
    const obs = idleObservation(life, { now: 1_000 + 5_000, idleMs: 500 });
    expect(obs.inFlight).toBe(1);
    expect(obs.idle).toBe(false);
    expect(obs.reason).not.toBe("idle");
  });

  it("请求结束后满足静默窗口才 idle；失败结束也算结束", () => {
    let life = createNetworkLifecycle();
    life = markCaptureEnabled(life, { mode: "fresh" });
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "f", type: "Fetch", timestamp: 1,
      request: { url: "https://api.example.com/x", method: "GET" },
    }, 1_000)!, 1_000);
    expect(idleObservation(life, { now: 1_200, idleMs: 500 }).idle).toBe(false);
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.loadingFailed", {
      requestId: "f", errorText: "net::ERR_FAILED", canceled: false, timestamp: 1.2,
    }, 1_200)!, 1_200);
    expect(idleObservation(life, { now: 1_200, idleMs: 500 }).idle).toBe(false);
    expect(idleObservation(life, { now: 1_200 + 500, idleMs: 500 }).idle).toBe(true);
  });

  it("重定向期间同一 requestId 仍算在途，直到最终 loadingFinished", () => {
    let life = createNetworkLifecycle();
    life = markCaptureEnabled(life, { mode: "fresh" });
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "redir", type: "Document", timestamp: 1,
      request: { url: "https://example.com/a", method: "GET" },
    }, 1_000)!, 1_000);
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "redir", type: "Document", timestamp: 1.1,
      request: { url: "https://example.com/b", method: "GET" },
    }, 1_100)!, 1_100);
    expect(life.ring.entries).toHaveLength(1);
    expect(life.ring.entries[0]?.redirects).toBe(1);
    expect(idleObservation(life, { now: 2_000, idleMs: 100 }).inFlight).toBe(1);
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.loadingFinished", {
      requestId: "redir", encodedDataLength: 10, timestamp: 2,
    }, 2_000)!, 2_000);
    expect(idleObservation(life, { now: 2_100, idleMs: 100 }).idle).toBe(true);
  });

  it("ring 满丢弃展示条目时，未结束请求仍留在在途集合", () => {
    let life = createNetworkLifecycle({ capacity: 2 });
    life = markCaptureEnabled(life, { mode: "fresh" });

    for (const id of ["a", "b", "slow"]) {
      life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
        requestId: id, type: "XHR", timestamp: 1,
        request: { url: `https://api.example.com/${id}`, method: "GET" },
      }, 1_000)!, 1_000);
    }

    expect(life.ring.entries.map((e) => e.requestId)).toEqual(["b", "slow"]);
    expect(life.ring.dropped).toBe(1);
    // a 已从 ring 消失但仍未结束 → 在途仍计入
    expect(idleObservation(life, { now: 5_000, idleMs: 100 }).inFlight).toBeGreaterThanOrEqual(1);
    expect(idleObservation(life, { now: 5_000, idleMs: 100 }).idle).toBe(false);
  });

  it("clear 展示记录不能抹掉仍在途的请求", () => {
    let life = createNetworkLifecycle();
    life = markCaptureEnabled(life, { mode: "fresh" });
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "pending", type: "XHR", timestamp: 1,
      request: { url: "https://api.example.com/pending", method: "GET" },
    }, 1_000)!, 1_000);
    life = clearNetworkDisplay(life);
    expect(life.ring.entries).toHaveLength(0);
    expect(idleObservation(life, { now: 2_000, idleMs: 100 }).inFlight).toBe(1);
    expect(idleObservation(life, { now: 2_000, idleMs: 100 }).idle).toBe(false);
  });

  it("长连接排除类别显式可测，慢 xhr 不得被同类忽略", () => {
    expect([...NETWORK_IDLE_EXCLUDED_TYPES].sort()).toEqual(["eventsource", "websocket"]);
    let life = createNetworkLifecycle();
    life = markCaptureEnabled(life, { mode: "fresh" });
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "ws", type: "WebSocket", timestamp: 1,
      request: { url: "https://example.com/socket", method: "GET" },
    }, 1_000)!, 1_000);
    // websocket 可排除在 idle 计数外，但慢 xhr 不行
    life = applyNetworkLifecycle(life, networkEventToUpdate("Network.requestWillBeSent", {
      requestId: "slow", type: "XHR", timestamp: 1.1,
      request: { url: "https://api.example.com/slow", method: "GET" },
    }, 1_100)!, 1_100);
    const obs = idleObservation(life, { now: 5_000, idleMs: 100 });
    expect(obs.excludedInFlight).toBe(1);
    expect(obs.inFlight).toBe(1);
    expect(obs.idle).toBe(false);
  });

  it("detach / gap / restart / late 证据不全时不能 idle", () => {
    const cases = [
      (s: ReturnType<typeof createNetworkLifecycle>) => markCaptureDetached(s),
      (s: ReturnType<typeof createNetworkLifecycle>) => markCaptureGap(s),
      (s: ReturnType<typeof createNetworkLifecycle>) => markCaptureRestart(s),
      (s: ReturnType<typeof createNetworkLifecycle>) => markCaptureEnabled(s, { mode: "late" }),
    ];

    for (const apply of cases) {
      let life = createNetworkLifecycle();
      life = apply(life);
      const obs = idleObservation(life, { now: 10_000, idleMs: 100 });
      expect(obs.idle).toBe(false);
      expect(["incomplete", "detached", "late", "gap", "restart"]).toContain(obs.reason);
    }
  });

  it("append/patch/restart 辅助仍保持对外 ring 语义", () => {
    const first = appendNetworkEntry({ entries: [], dropped: 0 }, entry({ status: 302 }));
    const second = restartNetworkEntry(first, entry({ url: "https://cdn.example.com/a.js", resourceType: "script" }));
    expect(second.entries[0]).toMatchObject({ redirects: 1 });
    expect(patchNetworkEntry(second, "missing", { status: 500 })).toBe(second);
  });
});

describe("FIX-02 waitForNetworkIdle helper", () => {
  it("有一个未结束请求超过 idleMs 时不提前返回 idle", async () => {
    const call = vi.fn(async (_name: string, _params: BrowserProgramToolParams = {}, _id?: string) => ({
      total: 1,
      dropped: 0,
      inFlight: 1,
      lastActivityAt: Date.now() - 10_000,
      generation: 1,
      integrity: "ok",
      excludedInFlight: 0,
      attached: true,
    }));

    await expect(runBrowserProgram({
      code: 'return await browser.waitForNetworkIdle({idleMs:100,timeoutMs:1000});',
      call,
      timeoutMs: 3_000,
    })).rejects.toThrow(/incomplete|timed out|in-flight|inFlight|CAPTURE/i);
    expect(call.mock.calls.some((c) => c[0] === "network")).toBe(true);
  });

  it("在途归零且静默窗口满足后返回 idle:true，且不声称业务完成", async () => {
    let n = 0;
    const started = Date.now();

    const call = vi.fn(async (_name: string, _params: BrowserProgramToolParams = {}, _id?: string) => {
      n += 1;

      if (n < 3) {
        return { total: 1, dropped: 0, inFlight: 1, lastActivityAt: started, generation: 1, integrity: "ok", excludedInFlight: 0 };
      }

      return { total: 1, dropped: 0, inFlight: 0, lastActivityAt: Date.now() - 200, generation: 1, integrity: "ok", excludedInFlight: 0 };
    });

    const result = await runBrowserProgram({
      code: 'return await browser.waitForNetworkIdle({idleMs:100,timeoutMs:3000});',
      call,
    });

    expect(result.value).toMatchObject({ idle: true });
    expect(JSON.stringify(result.value)).not.toMatch(/业务完成|page complete|navigation complete/i);
    expect(result.value).not.toHaveProperty("approximation");
  });

  it("捕获不完整（late/detach）不冒充空闲", async () => {
    for (const integrity of ["late", "detached", "gap", "restart"] as const) {
      const call = vi.fn(async () => ({
        total: 0, dropped: 0, inFlight: 0, lastActivityAt: Date.now() - 1_000,
        generation: 1, integrity, excludedInFlight: 0, attached: integrity !== "detached" && integrity !== "restart",
      }));

      await expect(runBrowserProgram({
        code: 'return await browser.waitForNetworkIdle({idleMs:100,timeoutMs:1000});',
        call,
        timeoutMs: 3_000,
      })).rejects.toThrow(/CAPTURE_INCOMPLETE|incomplete|timed out/i);
    }
  });
});

describe("FIX-02 等待取消/权限/身份与子调用", () => {
  it("等待期间 abort 立即停，不吞成目标尚未出现", async () => {
    const controller = new AbortController();

    const call = vi.fn(async (_name: string, _params: BrowserProgramToolParams = {}, _id?: string) => {
      controller.abort();
      throw new Error("NOT_READY: 条件未满足");
    });

    await expect(runBrowserProgram({
      code: 'try { await browser.waitFor({selector:"#x",timeoutMs:2000}); } catch (e) { return String(e); } await browser.click({target:"#y"});',
      call,
      signal: controller.signal,
    })).rejects.toThrow(/abort/i);
    expect(call.mock.calls.every((c) => c[0] !== "click")).toBe(true);
  });

  it("权限拒绝与传输故障按类型抛出，不重试到超时", async () => {
    const permission = vi.fn(async () => { throw new Error("PERMISSION_DENIED: 该标签页正被 DevTools 或其他调试器占用"); });
    await expect(runBrowserProgram({
      code: 'await browser.waitFor({selector:"#a",timeoutMs:2000});',
      call: permission,
    })).rejects.toThrow(/PERMISSION_DENIED/);
    expect(permission.mock.calls.length).toBe(1);

    const transport = vi.fn(async () => { throw new Error("TRANSPORT_ERROR: Extension disconnected"); });
    await expect(runBrowserProgram({
      code: 'await browser.waitFor({selector:"#a",timeoutMs:2000});',
      call: transport,
    })).rejects.toThrow(/TRANSPORT_ERROR/);
    expect(transport.mock.calls.length).toBe(1);
  });

  it("只有 NOT_FOUND/NOT_READY 可重试；歧义立即失败", async () => {
    const ambiguous = vi.fn(async () => { throw new Error("AMBIGUOUS: 选择器匹配 3 个元素: button。操作未执行。"); });
    await expect(runBrowserProgram({
      code: 'await browser.waitFor({selector:"button",timeoutMs:2000});',
      call: ambiguous,
    })).rejects.toThrow(/AMBIGUOUS/);
    expect(ambiguous.mock.calls.length).toBe(1);

    const call = vi.fn()
      .mockRejectedValueOnce(new Error("NOT_FOUND: 未找到目标元素"))
      .mockRejectedValueOnce(new Error("NOT_READY: 条件未满足"))
      .mockResolvedValue({ check: { matched: true } });

    const result = await runBrowserProgram({
      code: 'await browser.waitFor({selector:"#edit",timeoutMs:2000}); return "ok";',
      call,
    });

    expect(result.value).toBe("ok");
    expect(call.mock.calls.length).toBeGreaterThan(2);
  });

  it("pageInfo 在 list_tabs 与 js 之间工作页变化时拒绝混合身份", async () => {
    let n = 0;

    const call = vi.fn(async (name: string) => {
      if (name === "list_tabs") {
        n += 1;

        return n === 1
          ? { tabs: [{ id: 1, title: "A", url: "https://a.example/", working: true }] }
          : { tabs: [{ id: 2, title: "B", url: "https://b.example/", working: true }] };
      }

      return { value: { href: "https://b.example/", title: "B", readyState: "complete", viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 } } };
    });

    await expect(runBrowserProgram({ code: "return await browser.pageInfo();", call })).rejects.toThrow(/IDENTITY_CHANGED|身份/);
  });

  it("waitForLoad 不能因旧文档 complete 立刻结束；文档替换后继续等新文档", async () => {
    let n = 0;

    const call = vi.fn(async () => {
      n += 1;

      if (n === 1) return { value: { readyState: "complete", href: "https://old.example/", timeOrigin: 100 } };

      if (n === 2) return { value: { readyState: "loading", href: "https://new.example/", timeOrigin: 200 } };

      return { value: { readyState: "complete", href: "https://new.example/", timeOrigin: 200 } };
    });

    const result = await runBrowserProgram({
      code: 'return await browser.waitForLoad({state:"load",timeoutMs:3000});',
      call,
    });

    expect(result.value).toMatchObject({ readyState: "complete", timeOrigin: 200 });
    expect(n).toBeGreaterThanOrEqual(3);
  });

  it("组合 helper 的真实 RPC 有可区分子调用身份，并保留父 programId", async () => {
    const steps: ProgramStep[] = [];
    const ids: string[] = [];

    const call = vi.fn(async (name: string, _p: BrowserProgramToolParams, stepId?: string) => {
      if (stepId) ids.push(stepId);

      if (name === "list_tabs") return { tabs: [{ id: 7, title: "T", url: "https://x/", working: true }] };

      return { value: { href: "https://x/", title: "T", readyState: "complete", viewport: { width: 1, height: 1 }, scroll: { x: 0, y: 0 }, timeOrigin: 1 } };
    });

    await runBrowserProgram({
      id: "parent-fix02",
      code: "return await browser.pageInfo();",
      call,
      onStep: (s) => steps.push(s),
    });
    expect(steps.every((s) => s.parentId === "parent-fix02")).toBe(true);
    expect(new Set(ids).size).toBeGreaterThanOrEqual(2);
    expect(ids.every((id) => id.startsWith("parent-fix02/"))).toBe(true);
  });

  it("纯宿主 sleep 不伪造浏览器动作；不登记假 RPC", async () => {
    const call = vi.fn();
    const steps: ProgramStep[] = [];

    const result = await runBrowserProgram({
      code: 'return await browser.sleep({ms:20});',
      call,
      onStep: (s) => steps.push(s),
    });

    expect(result.value).toMatchObject({ waitedMs: 20 });
    expect(call).not.toHaveBeenCalled();
    expect(steps.some((s) => s.name === "sleep")).toBe(true);
  });

  it.each(["hidden", "detached"])("%s wait propagates document/permission/transport errors instead of declaring the target gone", async state => {
    for (const code of ["IDENTITY_CHANGED", "PERMISSION_DENIED", "TRANSPORT_ERROR", "CANCELLED"]) {
      const call = vi.fn(async () => { throw new Error(`${code}: fixture boundary changed`); });
      await expect(runBrowserProgram({ code: `return await browser.waitFor({selector:'#a',state:'${state}',timeoutMs:500});`, call })).rejects.toThrow(code);
    }
  });

  it("hidden wait cannot treat an empty read response as a hidden element", async () => {
    const call = vi.fn(async () => ({}));
    await expect(runBrowserProgram({ code: "return await browser.waitFor({selector:'#a',state:'hidden',timeoutMs:500});", call })).rejects.toThrow(/READ_RESULT_INVALID/);
  });

  it("新增 hidden/detached 等待只在实际隐藏或缺失时通过，未知状态仍拒绝", async () => {
    const hidden = await runBrowserProgram({ code: "return await browser.waitFor({selector:'#a',state:'hidden',timeoutMs:500});", call: async () => ({properties:{visible:false}}) });
    expect(hidden.value).toMatchObject({ready:true,state:"hidden"});
    const detached = await runBrowserProgram({ code: "return await browser.waitFor({selector:'#a',state:'detached',timeoutMs:500});", call: async () => { throw new Error("NOT_FOUND: missing"); } });
    expect(detached.value).toMatchObject({ready:true,state:"detached"});
    const call = vi.fn();
    await expect(runBrowserProgram({
      code: 'await browser.waitFor({selector:"#a",state:"invisible-magic",timeoutMs:500});',
      call,
    })).rejects.toThrow(/UNSUPPORTED_WAIT_STATE|不支持|hidden|detached/i);
    expect(call).not.toHaveBeenCalled();
  });
});
