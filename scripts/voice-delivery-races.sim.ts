import assert from "node:assert/strict";
import { test } from "node:test";
import { VoiceService } from "../agent/src/voice-service.js";
import { RealtimeVoiceSession } from "../agent/src/realtime-voice-session.js";
import { VoiceRelay } from "../extension/src/background/voice-relay.js";
import type { TaskProgressSnapshot } from "../shared/voice.js";

const conversationId = "review-conversation";
const runId = "review-run";
function harness(key: () => Promise<string> = async () => "local-fixture") {
  let snapshot: TaskProgressSnapshot = {
    conversationId, runId, observedAt: Date.now(), startedAt: Date.now(), goal: "准备一段测试文字",
    state: "running", active: [], lastAction: null, successVerified: false, results: [],
    conversationContext: { recentTurns: [], latestResult: null, latestDelivery: null },
  };
  const connections: { send: (event: Record<string, unknown>) => void; queued: string[] }[] = [];
  const outgoing: Promise<void>[] = [];
  let relay: VoiceRelay;
  const voice = new VoiceService(() => snapshot, msg => {
    if (msg.type === "voice") relay.server(msg as never);
  }, key, deps => new RealtimeVoiceSession({
    ...deps,
    createConnection: options => {
      const connection = { send: options.send, queued: [] as string[] };
      connections.push(connection);
      return {
        start() {}, close() {},
        notifyTask(_text: string, id: string) { connection.queued.push(id); },
      } as never;
    },
  }));
  relay = new VoiceRelay(msg => {
    if (msg.type !== "voice") return false;
    outgoing.push(voice.handle(conversationId, msg));
    return true;
  }, () => conversationId);
  let fromPanel: (message: unknown) => void = () => {};
  relay.attach({
    onDisconnect: {addListener() {}},
    onMessage: {addListener(cb: typeof fromPanel) { fromPanel = cb; }},
    postMessage() {},
  } as never);

  return {
    connections,
    observeIdle() { voice.observe({ type:"status", conversationId, state:"idle" }); },
    start(voiceId: string, reconnectOf?: string) {
      fromPanel({ kind: "client", msg: {type:"voice", conversationId, voiceId, command:{ kind:"start", ...(reconnectOf ? {reconnectOf} : {}) }} });
      return Promise.all(outgoing.splice(0));
    },
    complete() {
      snapshot = {...snapshot, state:"idle", conversationContext:{
        ...snapshot.conversationContext!, latestDelivery:{
          id:"review-answer", conversationId, runId, composedAt:Date.now(), kind:"finding", status:"composed", text:"本机测试结果。",
        },
      }};
      voice.observe({ type:"status", conversationId, state:"idle" });
    },
  };
}
const ready = { type: "ready" };
const answer = "review-answer";

test("自动重连：第一轮超时后，下一轮就绪仍入队一次", async () => {
  const h = harness();
  await h.start("original");
  h.connections[0]!.send(ready);
  h.connections[0]!.send({ type: "closed" });
  h.complete();

  await h.start("retry-one", "original");
  await h.start("retry-two", "original"); // 连线计时器超时后的下一次 start
  h.connections[1]!.send(ready); // 已被替换的连接迟到
  assert.deepEqual(h.connections[1]!.queued, []);

  h.connections[2]!.send(ready);
  h.connections[2]!.send(ready);
  h.observeIdle();
  assert.deepEqual(h.connections[2]!.queued, [answer]);
});

test("语音启动：连接对象建立前完成的任务，就绪后入队一次", async () => {
  let release!: (key: string) => void;
  const key = new Promise<string>(resolve => { release = resolve; });
  const h = harness(() => key);
  const opening = h.start("opening");
  assert.equal(h.connections.length, 0);
  h.complete();

  release("local-fixture");
  await opening;
  h.connections[0]!.send(ready);
  h.observeIdle();
  h.connections[0]!.send(ready);
  assert.deepEqual(h.connections[0]!.queued, [answer]);
});

test("对照：首次重连成功会补播，手动新开会话不会补播", async () => {
  for (const reconnect of [true, false]) {
    const h = harness();
    await h.start("original");
    h.connections[0]!.send(ready);
    h.connections[0]!.send({ type: "closed" });
    h.complete();

    await h.start("next", reconnect ? "original" : undefined);
    h.connections[1]!.send(ready);
    h.observeIdle();
    assert.deepEqual(h.connections[1]!.queued, reconnect ? [answer] : []);
  }
});

test("对照：连接对象已建立但还没就绪，结果也只会入队一次", async () => {
  const h = harness();
  await h.start("opening");
  h.complete();
  h.connections[0]!.send(ready);
  h.observeIdle();
  assert.deepEqual(h.connections[0]!.queued, [answer]);
});
