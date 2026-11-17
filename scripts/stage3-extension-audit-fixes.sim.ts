import assert from "node:assert/strict";
import { test } from "node:test";
import { installPttCapsule } from "../extension/src/background/ptt-capsule.js";
import { VoiceRelay } from "../extension/src/background/voice-relay.js";
import { createOpfsFileSystem } from "../extension/src/inproc/opfs-fs.js";
import { saveConnection } from "../extension/src/settings/connections.js";

test("S3-4: OPFS worker 超时终止卡死 worker 并清理计时器", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const prevChrome = (globalThis as { chrome?: unknown }).chrome;
  const prevNavigator = globalThis.navigator;
  const prevWorker = (globalThis as { Worker?: unknown }).Worker;

  let terminated = 0;
  let lastWorker: { postMessage: (msg: unknown) => void; terminate: () => void; onmessage: ((ev: unknown) => void) | null } | null = null;
  class StubWorker {
    onmessage: ((ev: unknown) => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    constructor() {
      lastWorker = this;
    }
    postMessage(_msg: unknown) {}
    terminate() {
      terminated += 1;
    }
  }

  Object.defineProperty(globalThis, "chrome", { value: { runtime: { getURL: (p: string) => p } }, configurable: true });
  Object.defineProperty(globalThis, "navigator", { value: { storage: { getDirectory: async () => ({}) } }, configurable: true });
  Object.defineProperty(globalThis, "Worker", { value: StubWorker, configurable: true });

  try {
    const fs = createOpfsFileSystem();
    const writePromise = fs.writeFile("/log.txt", "line-1\n", {} as never);
    await Promise.resolve();
    assert.ok(lastWorker, "应创建 opfs worker");

    t.mock.timers.tick(15_000);
    const result = await writePromise;
    assert.equal(result.ok, false);
    assert.equal(terminated, 1, "OPFS worker 超时后必须调用 worker.terminate() 终止卡死 worker");
  } finally {
    Object.defineProperty(globalThis, "chrome", { value: prevChrome, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
    Object.defineProperty(globalThis, "Worker", { value: prevWorker, configurable: true });
  }
});

test("S3-6: 切到新标签页触发语音/交办时立即隐藏旧标签页的胶囊", async () => {
  const prevChrome = (globalThis as { chrome?: unknown }).chrome;
  const sent: Array<{ tabId: number; message: unknown }> = [];
  Object.defineProperty(globalThis, "chrome", {
    value: {
      tabs: {
        sendMessage: async (tabId: number, message: unknown) => {
          sent.push({ tabId, message });
        },
      },
    },
    configurable: true,
  });

  try {
    const capsule = installPttCapsule(
      () => {},
      {
        prepare: () => {},
        speak: () => null,
        hush: () => {},
      },
    );

    capsule.handedOff(101, "conv-1", "帮我填第一页");
    sent.length = 0;

    capsule.recording(202);
    assert.ok(
      sent.some((entry) => entry.tabId === 101),
      `在标签页 202 开始录音时应通知隐藏旧标签页 101 的胶囊，实际消息：${JSON.stringify(sent)}`,
    );
    assert.equal(capsule.tabId(), 202);

    capsule.handedOff(202, "conv-2", "看第二页");
    sent.length = 0;
    capsule.recording(101);
    assert.ok(
      sent.some((entry) => entry.tabId === 202),
      "从标签页 202 切回 101 录音时应隐藏标签页 202 的胶囊",
    );
  } finally {
    Object.defineProperty(globalThis, "chrome", { value: prevChrome, configurable: true });
  }
});

test("S3-7a: VoiceRelay 因新窗口接管 stop(new_voice) 时向旧窗口发送不可恢复错误而非 closed", () => {
  const postedA: unknown[] = [];
  let messageHandlerA: ((raw: unknown) => void) | null = null;
  const portA = {
    onDisconnect: { addListener: () => {} },
    onMessage: { addListener: (fn: (raw: unknown) => void) => { messageHandlerA = fn; } },
    postMessage: (msg: unknown) => { postedA.push(msg); },
  } as unknown as Parameters<VoiceRelay["attach"]>[0];

  const relay = new VoiceRelay(() => true, () => "conv-1");
  relay.attach(portA);
  messageHandlerA!({
    kind: "client",
    msg: { type: "voice", conversationId: "conv-1", voiceId: "v-1", command: { kind: "start" } },
  });

  relay.stop("new_voice");
  const lastMsg = postedA.at(-1) as { msg?: { event?: { kind: string; state: string; recoverable?: boolean } } } | undefined;
  assert.equal(lastMsg?.msg?.event?.kind, "state");
  assert.equal(lastMsg?.msg?.event?.state, "error", "new_voice 挤掉旧窗口时不应发送可触发自动重连的 closed");
  assert.equal(lastMsg?.msg?.event?.recoverable, false);
});

test("S3-8: 自定义接口更换不同源的 baseUrl 且未输入新密钥时不应复用旧源密钥", async () => {
  const prevChrome = (globalThis as { chrome?: unknown }).chrome;
  const prevNavigator = globalThis.navigator;
  const storageData: Record<string, unknown> = {
    "settings_connection:custom": { provider: "custom", modelId: "m1", baseUrl: "https://endpoint-a.example/v1" },
    "inproc_cred:custom": {
      type: "api_key",
      key: "secret-from-a",
      env: { SIDEAGENT_CUSTOM_ENDPOINT: "https://endpoint-a.example/v1" },
    },
  };

  Object.defineProperty(globalThis, "chrome", {
    value: {
      storage: {
        local: {
          get: async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, storageData[k]])),
          set: async (patch: Record<string, unknown>) => { Object.assign(storageData, patch); },
        },
      },
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: {
      locks: {
        request: async (_name: string, fn: () => Promise<unknown>) => fn(),
      },
    },
    configurable: true,
  });

  try {
    const prevConfig = structuredClone(storageData["settings_connection:custom"]) as { provider: string; modelId: string; baseUrl: string };
    const prevCred = structuredClone(storageData["inproc_cred:custom"]);

    const okCrossOrigin = await saveConnection(
      { provider: "custom", modelId: "m1", baseUrl: "https://endpoint-b.example/v1" },
      "",
      "passed",
      prevConfig,
      prevCred,
    );
    assert.equal(okCrossOrigin, true);
    assert.equal(
      (storageData["inproc_cred:custom"] as { key?: string }).key,
      "",
      "更改到不同 origin 的自定义接口时，空白密钥输入框不得把旧站点的 API key 复制到新接口",
    );

    storageData["settings_connection:custom"] = { provider: "custom", modelId: "m1", baseUrl: "https://endpoint-a.example/v1" };
    storageData["inproc_cred:custom"] = {
      type: "api_key",
      key: "secret-from-a",
      env: { SIDEAGENT_CUSTOM_ENDPOINT: "https://endpoint-a.example/v1" },
    };
    const okSameOrigin = await saveConnection(
      { provider: "custom", modelId: "m2", baseUrl: "https://endpoint-a.example/v2" },
      "",
      "passed",
      structuredClone(storageData["settings_connection:custom"]) as { provider: string; modelId: string; baseUrl: string },
      structuredClone(storageData["inproc_cred:custom"]),
    );
    assert.equal(okSameOrigin, true);
    assert.equal((storageData["inproc_cred:custom"] as { key?: string }).key, "secret-from-a");
  } finally {
    Object.defineProperty(globalThis, "chrome", { value: prevChrome, configurable: true });
    Object.defineProperty(globalThis, "navigator", { value: prevNavigator, configurable: true });
  }
});
