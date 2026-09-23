import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FetchConsentBroker, FETCH_CONSENT_BODY_LIMIT, FETCH_CONSENT_LIST_BYTES_LIMIT, FETCH_CONSENT_LIST_LIMIT, type ConsentOutcome } from "../src/fetch-consent.js";
import { workerExecution } from "../src/fleet.js";
import { ToolRpc, type ToolCallFrame } from "../src/rpc.js";
import { createBrowserTools, type ConsumeConsent } from "../src/tools.js";
import { CONSENT_REQUIRED_ERROR, ConsentLedger } from "../src/consent-ticket.js";
import { installFetchTestOrigin } from "../../shared/fetch.js";
import type { FetchConsentRequest } from "../../shared/consent.js";
import type { ServerMessage } from "../../shared/protocol.js";

/** 只用来通过 fetch 的私网拒绝；测试从不真的发请求（RPC 是替身）。 */
const ORIGIN = "http://127.0.0.1:7799";

const URL_ = `${ORIGIN}/count`;

const POST = { url: URL_, method: "POST", body: '{"n":1}' } as const;

let restoreTestOrigin = (): void => {};

beforeEach(() => { restoreTestOrigin = installFetchTestOrigin(ORIGIN); });

afterEach(() => restoreTestOrigin());

type Frames = ServerMessage[];

const consentRequests = (frames: Frames): FetchConsentRequest[] =>
  frames.flatMap((frame) => (frame.type === "consent_request" && frame.request.kind !== 'write' ? [frame.request] : []));

const consentResults = (frames: Frames) => frames.flatMap((frame) => (frame.type === "consent_result" ? [frame] : []));

/** request() 未获确认前不会落定；用 0ms 计时器区分「立刻拒绝」与「进入等待」。 */
const settle = <T,>(promise: Promise<T>): Promise<T | "pending"> =>
  Promise.race([promise, new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 0))]);

function harness(options: { conversationId?: string; ttlMs?: number; wired?: boolean } = {}) {
  const frames: Frames = [];
  const calls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const state = { runId: "run-1" as string | null, controlVersion: 1, epoch: 1, canWrite: true };

  const brokerOptions: ConstructorParameters<typeof FetchConsentBroker>[0] = {
    conversationId: options.conversationId ?? "conv-a",
    emit: (message) => frames.push(message),
    ledger: new ConsentLedger(),
  };

  if (options.ttlMs !== undefined) brokerOptions.ttlMs = options.ttlMs;
  const broker = new FetchConsentBroker(brokerOptions);

  broker.bindContext(() => ({ runId: state.runId, controlVersion: state.controlVersion }));

  const rpc = {
    call: async (name: string, params: Record<string, unknown>) => {
      calls.push({ name, params: JSON.parse(JSON.stringify(params)) as Record<string, unknown> });

      return {
        url: String(params.url), status: 200, ok: true, contentType: "application/json",
        bytes: 2, readBytes: 2, totalBytes: 2, truncated: false, stoppedReason: "complete", text: "{}",
      };
    },
    ensureToolCall: vi.fn(),
    markCallRejected: vi.fn(),
    noteToolFact: vi.fn(),
  };

  const consumeConsent: ConsumeConsent = (_name, params, opts) => broker.request(params, opts);

  const execution = options.wired === false
    ? { epoch: () => state.epoch, canWrite: () => state.canWrite }
    : { epoch: () => state.epoch, canWrite: () => state.canWrite, consumeConsent };

  const tools = createBrowserTools(rpc as never, undefined, undefined, () => true, execution);

  return {
    frames, calls, broker, state, rpc,
    fetch: tools.find((tool) => tool.name === "fetch")!,
    program: tools.find((tool) => tool.name === "browser_run")!,
  };
}

/** 等侧栏卡片出现，返回它的 id。 */
async function waitForRequest(frames: Frames): Promise<FetchConsentRequest> {
  await vi.waitFor(() => expect(consentRequests(frames)).toHaveLength(1));

  return consentRequests(frames)[0]!;
}

describe("fetch consent broker", () => {
  it("未获许可 0 次调用，获许可后恰好 1 次，重复点击不重发", async () => {
    const h = harness();
    let steps = 0;
    const pending = h.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never);
    void pending.then(() => { steps += 1; }, () => { steps += 1; });
    const request = await waitForRequest(h.frames);
    expect(h.calls).toHaveLength(0);
    expect(steps).toBe(0);
    expect(request).toMatchObject({ conversationId: "conv-a", runId: "run-1", controlVersion: 1, method: "POST", url: URL_, body: '{"n":1}' });
    expect(h.broker.decide(request.id, true)).toBe(true);
    await pending;
    expect(h.calls).toEqual([{ name: "fetch", params: { url: URL_, method: "POST", headers: {}, body: '{"n":1}' } }]);
    expect(h.broker.decide(request.id, true)).toBe(false);
    expect(h.calls).toHaveLength(1);
    expect(consentResults(h.frames).at(-1)).toMatchObject({ requestId: request.id, status: "allowed", message: "已允许本次请求。" });
    expect(h.broker.list()).toEqual([]);
  });

  it("拒绝、超时、等待期间换 run 或控制版本、signal 中止：都不放行", async () => {
    for (const mutate of ["reject", "run", "control", "abort"] as const) {
      const h = harness();
      const controller = new AbortController();
      const pending = h.fetch.execute("call-1", { ...POST }, controller.signal, undefined, {} as never);
      const request = await waitForRequest(h.frames);

      if (mutate === "reject") h.broker.decide(request.id, false);

      if (mutate === "run") { h.state.runId = "run-2"; h.broker.decide(request.id, true); }

      if (mutate === "control") { h.state.controlVersion = 8; h.broker.decide(request.id, true); }

      if (mutate === "abort") controller.abort();
      await expect(pending).rejects.toThrow(/未发送|未执行/);
      expect(h.calls).toHaveLength(0);
      expect(consentResults(h.frames).at(-1)?.status).toBe(mutate === "reject" ? "rejected" : "cancelled");
    }
  });

  it("确认超时后不放行", async () => {
    const h = harness({ ttlMs: 20 });
    const pending = h.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never);
    await waitForRequest(h.frames);
    await expect(pending).rejects.toThrow(/过期/);
    expect(h.calls).toHaveLength(0);
    expect(consentResults(h.frames).at(-1)?.status).toBe("expired");
  });

  it("到期时刻即使定时器尚未回调也不能放行", async () => {
    let now = 1000;
    const broker = new FetchConsentBroker({ conversationId: "expiry", emit: () => {}, now: () => now });
    broker.bindContext(() => ({ runId: "run", controlVersion: 1 }));
    const pending = broker.request({ ...POST });
    const request = broker.list()[0]!;
    now = request.expiresAt;
    expect(broker.decide(request.id, true)).toBe(true);
    await expect(pending).resolves.toMatchObject({ allowed: false });
    expect(broker.list()).toEqual([]);
    broker.dispose();
  });

  it("已允许但尚未发 RPC 时收到取消，独立工具与组合程序都不发送", async () => {
    for (const program of [false, true]) {
      const h = harness();
      const controller = new AbortController();
      const tool = program ? h.program : h.fetch;

      const params = program
        ? { code: `return await browser.fetch(${JSON.stringify(POST)});` }
        : { ...POST };

      const pending = tool.execute("cancel-after-allow", params as never, controller.signal, undefined, {} as never);
      const request = await waitForRequest(h.frames);
      h.broker.decide(request.id, true);
      controller.abort();
      await expect(pending).rejects.toThrow();
      expect(h.calls).toHaveLength(0);
    }
  });

  it("获准之后重新核对执行闸门（epoch/canWrite），不留 TOCTOU", async () => {
    for (const mutate of ["epoch", "canWrite"] as const) {
      const h = harness();
      const pending = h.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never);
      const request = await waitForRequest(h.frames);

      if (mutate === "epoch") h.state.epoch = 2;
      else h.state.canWrite = false;
      h.broker.decide(request.id, true);
      await expect(pending).rejects.toThrow(/旧步骤未执行/);
      expect(h.calls).toHaveLength(0);
    }
  });

  it("确认的是发起时那份参数：等待期间外部对象被改也不影响真正发送的内容", async () => {
    const h = harness();
    const params: Record<string, unknown> = { url: URL_, method: "POST", body: '{"n":1}' };
    const pending = h.fetch.execute("call-1", params, undefined, undefined, {} as never);
    const request = await waitForRequest(h.frames);
    params.body = '{"n":999}';
    params.url = `${ORIGIN}/evil`;
    h.broker.decide(request.id, true);
    await pending;
    expect(h.calls).toEqual([{ name: "fetch", params: { url: URL_, method: "POST", headers: {}, body: '{"n":1}' } }]);
  });

  it("侧栏看不到敏感 header 的原值，但票据仍按原值绑定", async () => {
    const h = harness();

    const pending = h.fetch.execute("call-1", {
      url: URL_, method: "POST", body: "{}",
      headers: { Authorization: "Bearer secret-token", "X-Trace": "keep", Cookie: "sid=1", Host: "evil.example" },
    }, undefined, undefined, {} as never);

    const request = await waitForRequest(h.frames);
    expect(request.headers).toEqual({ Authorization: "[已隐藏]", "X-Trace": "keep" });
    h.broker.decide(request.id, true);
    await pending;
    // fetch 本来就不发的 Cookie/Host 不会因为确认而变成可发送；Authorization 按原值发出。
    expect(h.calls[0]!.params.headers).toEqual({ Authorization: "Bearer secret-token", "X-Trace": "keep" });
  });

  it("body 超过上限：明确拒绝、不展示、不发送、不截断", async () => {
    const h = harness();
    const body = "x".repeat(FETCH_CONSENT_BODY_LIMIT + 1);
    await expect(h.fetch.execute("call-1", { url: URL_, method: "POST", body }, undefined, undefined, {} as never))
      .rejects.toThrow(new RegExp(String(FETCH_CONSENT_BODY_LIMIT)));
    expect(consentRequests(h.frames)).toHaveLength(0);
    expect(h.calls).toHaveLength(0);
  });

  it("待确认展示总量超限：拒绝新增、不展示、不发网络，也不截断后发送", async () => {
    const h = harness();
    const body = "z".repeat(60_000);
    let refused: ConsentOutcome | null = null;
    let created = 0;

    for (let index = 0; index < 40 && !refused; index += 1) {
      const state = await settle(h.broker.request({ url: `${ORIGIN}/n${index}`, method: "POST", body }));

      if (state === "pending") created += 1;
      else refused = state;
    }

    expect(created).toBeGreaterThan(1);
    expect(refused).toMatchObject({ allowed: false });
    expect(refused!.reason).toMatch(new RegExp(`KiB|${FETCH_CONSENT_LIST_LIMIT} 条`));
    expect(h.broker.list()).toHaveLength(created);
    expect(consentRequests(h.frames)).toHaveLength(created);
    expect(h.calls).toHaveLength(0);
    h.broker.dispose();
  });

  it("待确认请求条数超限也会拒绝新增", async () => {
    const h = harness();

    for (let index = 0; index < FETCH_CONSENT_LIST_LIMIT; index += 1) {
      expect(await settle(h.broker.request({ url: `${ORIGIN}/c${index}`, method: "POST", body: "{}" }))).toBe("pending");
    }

    const overflow = await h.broker.request({ url: `${ORIGIN}/over`, method: "POST", body: "{}" });
    expect(overflow).toMatchObject({ allowed: false });
    expect(overflow.reason).toContain(`${FETCH_CONSENT_LIST_LIMIT} 条`);
    expect(h.broker.list()).toHaveLength(FETCH_CONSENT_LIST_LIMIT);
    expect(consentRequests(h.frames)).toHaveLength(FETCH_CONSENT_LIST_LIMIT);
    expect(h.calls).toHaveLength(0);
    h.broker.dispose();
  });

  it("请求 id 是随机 UUID：同会话重建 broker 后旧 id 命中不了新请求", async () => {
    const first = harness({ conversationId: "conv-same" });
    const previous = first.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never);
    const oldRequest = await waitForRequest(first.frames);
    expect(oldRequest.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    first.broker.dispose();
    await expect(previous).rejects.toThrow("会话已关闭");
    expect(first.calls).toHaveLength(0);

    const next = harness({ conversationId: "conv-same" });
    const pending = next.fetch.execute("call-2", { url: `${ORIGIN}/two`, method: "POST", body: '{"n":2}' }, undefined, undefined, {} as never);
    const newRequest = await waitForRequest(next.frames);
    expect(newRequest.id).not.toBe(oldRequest.id);
    // 旧 id 放行不了重建后的新请求，新请求也不会被旧 id 的批准带出去。
    expect(next.broker.decide(oldRequest.id, true)).toBe(false);
    expect(next.broker.list()).toEqual([newRequest]);
    expect(next.calls).toHaveLength(0);
    expect(next.broker.decide(newRequest.id, true)).toBe(true);
    await pending;
    expect(next.calls).toEqual([{ name: "fetch", params: { url: `${ORIGIN}/two`, method: "POST", headers: {}, body: '{"n":2}' } }]);
  });

  it("browser_run 里的 fetch 与独立 fetch 走同一条确认路", async () => {
    const h = harness();

    const pending = h.program.execute(
      "call-prog",
      { code: `return await browser.fetch({url: ${JSON.stringify(URL_)}, method: "POST", body: "{}"});` },
      undefined, undefined, {} as never,
    );

    const request = await waitForRequest(h.frames);
    expect(h.calls).toHaveLength(0);
    h.broker.decide(request.id, true);
    await pending;
    expect(h.calls).toEqual([{ name: "fetch", params: { url: URL_, method: "POST", headers: {}, body: "{}" } }]);
  });

  it("不同会话各自独立：别的会话的 id 放行不了本会话的请求", async () => {
    const a = harness({ conversationId: "conv-a" });
    const b = harness({ conversationId: "conv-b" });
    const pending = a.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never);
    const request = await waitForRequest(a.frames);
    expect(b.broker.decide(request.id, true)).toBe(false);
    expect(b.broker.decide(request.id, false)).toBe(false);
    expect(a.calls).toHaveLength(0);
    expect(a.broker.decide(request.id, true)).toBe(true);
    await pending;
    expect(a.calls).toHaveLength(1);
  });

  it("没有进行中的任务、或没接线确认入口：拒绝且不放行", async () => {
    const h = harness();
    h.state.runId = null;
    await expect(h.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never)).rejects.toThrow(/没有进行中的任务/);
    expect(consentRequests(h.frames)).toHaveLength(0);
    expect(h.calls).toHaveLength(0);

    const unwired = harness({ wired: false });
    await expect(unwired.fetch.execute("call-1", { ...POST }, undefined, undefined, {} as never)).rejects.toThrow(CONSENT_REQUIRED_ERROR);
    expect(consentRequests(unwired.frames)).toHaveLength(0);
    expect(unwired.calls).toHaveLength(0);
  });

  it("同会话 worker 与 Lead 共用同一个授权等待区；没有等待区时明确拒绝", async () => {
    const h = harness();
    const shared = workerExecution(() => undefined, () => h.broker);
    const outcome = shared.consumeConsent("fetch", { ...POST }, {});
    const request = await waitForRequest(h.frames);
    h.broker.decide(request.id, true);
    await expect(Promise.resolve(outcome)).resolves.toMatchObject({ allowed: true, params: { url: URL_, method: "POST", body: '{"n":1}' } });
    expect(h.broker.list()).toEqual([]);

    const unwired = workerExecution(() => undefined);
    await expect(Promise.resolve(unwired.consumeConsent("fetch", { ...POST }, {}))).resolves.toMatchObject({ allowed: false, reason: CONSENT_REQUIRED_ERROR });
  });

  it("等待确认期间不发 tool_call 帧，获准后才真正发出（不落入 30 秒 RPC 超时）", async () => {
    const frames: Frames = [];
    const sent: ToolCallFrame[] = [];
    const rpc = new ToolRpc((frame) => sent.push(frame));
    const broker = new FetchConsentBroker({ conversationId: "conv-a", emit: (message) => frames.push(message) });
    broker.bindContext(() => ({ runId: "run-1", controlVersion: 0 }));

    const tools = createBrowserTools(rpc, undefined, undefined, () => true, {
      epoch: () => 1,
      canWrite: () => true,
      consumeConsent: (_name, params, opts) => broker.request(params, opts),
    });

    const fetchTool = tools.find((tool) => tool.name === "fetch")!;
    const pending = fetchTool.execute("call-1", { ...POST }, undefined, undefined, {} as never);
    const request = await waitForRequest(frames);
    expect(sent).toHaveLength(0);
    expect(rpc.pendingCount).toBe(0);
    broker.decide(request.id, true);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ type: "tool_call", name: "fetch" });
    expect(sent[0]!.params).toMatchObject({ url: URL_, method: "POST", body: '{"n":1}' });
    rpc.handleResult(sent[0]!.id, true, {
      url: URL_, status: 200, ok: true, contentType: "application/json",
      bytes: 2, readBytes: 2, totalBytes: 2, truncated: false, stoppedReason: "complete", text: "{}",
    });
    await expect(pending).resolves.toBeTruthy();
  });
});
