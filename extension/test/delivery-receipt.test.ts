import { beforeAll, describe, expect, it, vi } from "vitest";
import type { BgToPanel, PanelHistoryEntry, PanelToBg } from "../src/relay.js";

/**
 * 生产 background 路由回归（issue #4 C1/C3）。
 * 直接导入真实 extension/src/background/index.ts，在其注册的真实
 * chrome.runtime.onConnect 处理器上驱动 Port 消息；chrome.* 只做最小替身。
 * 测试环境 native host 不可用（connectNative 抛错）且无 ws token，
 * uplink 上行确定失败 —— 即「面板已连接但 background→agent 上行不可用」边界。
 */

interface FakePanelPort {
  name: string;
  sent: BgToPanel[];
  postMessage: (m: BgToPanel) => void;
  onMessage: { addListener: (l: (raw: unknown) => void) => void };
  onDisconnect: { addListener: (l: () => void) => void };
  deliver(raw: PanelToBg): void;
}

function fakePanelPort(): FakePanelPort {
  const sent: BgToPanel[] = [];
  const listeners: ((raw: unknown) => void)[] = [];
  return {
    name: "sideagent-panel",
    sent,
    postMessage: (m) => {
      sent.push(m);
    },
    onMessage: { addListener: (l) => listeners.push(l) },
    onDisconnect: { addListener: () => {} },
    deliver(raw) {
      for (const l of [...listeners]) l(raw);
    },
  };
}

function installChromeStub() {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const toObject = (map: Map<string, unknown>, keys: string | string[] | null | undefined) => {
    const out: Record<string, unknown> = {};
    if (typeof keys === "string") {
      if (map.has(keys)) out[keys] = map.get(keys);
    } else if (Array.isArray(keys)) {
      for (const k of keys) if (map.has(k)) out[k] = map.get(k);
    } else {
      for (const [k, v] of map) out[k] = v;
    }
    return out;
  };
  const onConnectListeners: ((port: FakePanelPort) => void)[] = [];
  const stub = {
    runtime: {
      onInstalled: { addListener: () => {} },
      onConnect: { addListener: (l: (port: FakePanelPort) => void) => onConnectListeners.push(l) },
      onMessage: { addListener: () => {} },
      connectNative: () => {
        throw new Error("native host not registered in test");
      },
    },
    storage: {
      local: {
        get: async (keys: string | string[] | null) => toObject(local, keys),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) local.set(k, v);
        },
      },
      session: {
        get: async (keys: string | string[] | null) => toObject(session, keys),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, v);
        },
        remove: async (keys: string | string[] | null) => {
          const list = keys == null ? [] : Array.isArray(keys) ? keys : [keys];
          for (const k of list) session.delete(k);
        },
      },
    },
    tabs: {
      query: async () => [],
      get: async () => {
        throw new Error("no tab in test");
      },
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
      onRemoved: { addListener: () => {} },
      sendMessage: async () => {},
    },
    debugger: { onDetach: { addListener: () => {} } },
    sidePanel: {
      open: async () => {},
      setPanelBehavior: async () => {},
    },
  };
  return { stub, onConnectListeners };
}

function firstUserEntry(sent: BgToPanel[], text?: string): PanelHistoryEntry {
  for (const e of sent) {
    if (e.kind === "history") {
      const entry = e.entries.find((x) => x.item.kind === "user" && (!text || x.item.text === text));
      if (entry) return entry;
    }
  }
  throw new Error("没有收到用户消息的 history 回显");
}

describe("background 面板路由 × 上行不可用（issue #4）", () => {
  let connectPanel: (port: FakePanelPort) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromeStub: any;

  /** 把 stub 的 connectNative 换成返回假 native port，使 uplink 传输层打开。 */
  function installActiveNativeHost(nativeSent: unknown[]): void {
    chromeStub.runtime.connectNative = () => ({
      postMessage: (m: unknown) => {
        nativeSent.push(m);
      },
      onMessage: { addListener: () => {} },
      onDisconnect: { addListener: () => {} },
    });
  }

  beforeAll(async () => {
    const built = installChromeStub();
    chromeStub = built.stub;
    vi.stubGlobal("chrome", built.stub);
    await import("../src/background/index.js");
    connectPanel = (port) => {
      for (const l of [...built.onConnectListeners]) l(port);
    };
  });

  it("user_message：background 层接受（history 回显）后上行失败要回执 delivery ok:false", async () => {
    const port = fakePanelPort();
    connectPanel(port);
    port.deliver({
      kind: "client",
      msg: { type: "user_message", text: "E2E 普通问题", context: undefined },
    });

    const entry = await vi.waitFor(() => firstUserEntry(port.sent));
    expect(entry.item).toMatchObject({ kind: "user", text: "E2E 普通问题" });

    // 上行传输不可用 = 确定未发给伴随进程；回执携带原文供面板重试
    await vi.waitFor(
      () => {
        expect(port.sent).toContainEqual({
          kind: "delivery",
          conversationId: "default",
          seq: entry.seq,
          ok: false,
          original: { type: "user_message", text: "E2E 普通问题", conversationId: "default" },
        });
      },
      { timeout: 3_000 },
    );
  });

  it("steer：同样回执 delivery ok:false，original 保留 steer 类型与上下文", async () => {
    const port = fakePanelPort();
    connectPanel(port);
    const context = {
      tabId: 1,
      title: "测试页",
      url: "https://example.com/page",
      selection: { text: "E2E 引用" },
    };
    port.deliver({ kind: "client", msg: { type: "steer", text: "E2E 插话", context } });

    const entry = await vi.waitFor(() => firstUserEntry(port.sent, "E2E 插话"));
    await vi.waitFor(
      () => {
        expect(port.sent).toContainEqual({
          kind: "delivery",
          conversationId: "default",
          seq: entry.seq,
          ok: false,
          original: { type: "steer", text: "E2E 插话", context, conversationId: "default" },
        });
      },
      { timeout: 3_000 },
    );
  });

  it("连续两条消息的回执按各自 seq 对应，互不串扰", async () => {
    const port = fakePanelPort();
    connectPanel(port);
    port.deliver({ kind: "client", msg: { type: "user_message", text: "第一条", context: undefined } });
    port.deliver({ kind: "client", msg: { type: "user_message", text: "第二条", context: undefined } });

    await vi.waitFor(
      () => {
        const receipts = port.sent.filter((e) => e.kind === "delivery");
        expect(receipts).toHaveLength(2);
      },
      { timeout: 3_000 },
    );
    const receipts = port.sent.filter((e) => e.kind === "delivery");
    const seqByText = new Map<string, number>();
    for (const r of receipts) {
      if (r.original.type === "user_message" || r.original.type === "steer") {
        seqByText.set(r.original.text, r.seq);
      }
    }
    const userEntries = port.sent
      .filter((e): e is Extract<BgToPanel, { kind: "history" }> => e.kind === "history")
      .flatMap((e) => e.entries)
      .filter((x) => x.item.kind === "user") as PanelHistoryEntry[];
    const first = userEntries.find((x) => x.item.kind === "user" && x.item.text === "第一条");
    const second = userEntries.find((x) => x.item.kind === "user" && x.item.text === "第二条");
    expect(seqByText.get("第一条")).toBe(first?.seq);
    expect(seqByText.get("第二条")).toBe(second?.seq);
  });

  it("未知/畸形 PanelToBg 消息被忽略，不崩溃", () => {
    const port = fakePanelPort();
    connectPanel(port);
    expect(() => {
      port.deliver({ kind: "made_up_kind" } as unknown as PanelToBg);
      port.deliver(null as unknown as PanelToBg);
      port.deliver({ kind: "client" } as PanelToBg);
    }).not.toThrow();
  });

  it("不同会话的回执保持隔离，失败状态持久保存", async () => {
    const port = fakePanelPort(); connectPanel(port);
    for (const id of ["delivery-A", "delivery-B"]) {
      port.deliver({ kind: "select_conversation", conversationId: id });
      port.deliver({ kind: "client", msg: { type: "user_message", conversationId: id, text: id } });
    }
    await vi.waitFor(() => expect(port.sent.filter(e => e.kind === "delivery")).toHaveLength(2));
    for (const id of ["delivery-A", "delivery-B"]) {
      expect(port.sent).toContainEqual(expect.objectContaining({kind:"delivery",conversationId:id,original:expect.objectContaining({conversationId:id,text:id})}));
      const stored = await chromeStub.storage.local.get(`history:${id}`);
      expect(stored[`history:${id}`].entries).toContainEqual(expect.objectContaining({item:expect.objectContaining({kind:"user",text:id,undelivered:{original:{type:"user_message",conversationId:id,text:id}}})}));
    }
    port.deliver({ kind: "select_conversation", conversationId: "default" });
  });

  it("上行传输可用（native port 在线）时不发失败回执，不误报未送达", async () => {
    // 本文件共享一次模块导入，前面用例已把 transport 留在失败态；
    // 这里经真实 retry 语义重新 connectNative，使 stub 返回假 native port 打开传输。
    const nativeSent: unknown[] = [];
    installActiveNativeHost(nativeSent);
    const port = fakePanelPort();
    connectPanel(port);
    port.deliver({
      kind: "retry", // 面板「保存并连接」同款信封：uplink.retry() → 重新 connectNative
    });
    // 等传输层建立（connectNative 同步返回，hello 已发出）
    await new Promise((r) => setTimeout(r, 50));
    expect(nativeSent.length).toBeGreaterThan(0);

    port.deliver({
      kind: "client",
      msg: { type: "user_message", text: "E2E 上行可用", context: undefined },
    });
    await vi.waitFor(
      () => {
        expect(port.sent).toContainEqual(
          expect.objectContaining({ kind: "history" }),
        );
      },
      { timeout: 3_000 },
    );
    await new Promise((r) => setTimeout(r, 300));
    const receipts = port.sent.filter((e) => e.kind === "delivery");
    expect(receipts).toHaveLength(0);
  });
});
