import { expect, it, vi } from "vitest";
import { VoiceRelay } from "../src/background/voice-relay.js";

function panel() {
  let message: (m: any) => void = () => {}; let disconnected = () => {};
  const port = { postMessage: vi.fn(), onMessage: { addListener: (f: typeof message) => { message = f; } }, onDisconnect: { addListener: (f: typeof disconnected) => { disconnected = f; } } };
  return { port: port as unknown as chrome.runtime.Port, received: port.postMessage, send: (m: any) => message(m), close: () => disconnected() };
}
it("binds one panel and conversation; selection/disconnect stop only voice, never task", () => {
  const send = vi.fn((_msg: unknown) => true); let selected = "A";
  const relay = new VoiceRelay(send, () => selected); const a = panel(), b = panel();
  relay.attach(a.port); relay.attach(b.port);
  const start = { kind: "client", msg: { type: "voice", voiceId: "v1", conversationId: "A", command: { kind: "start" } } };
  a.send(start); a.send(start); expect(send).toHaveBeenCalledTimes(1);
  b.send({ ...start, msg: { ...start.msg, command: { kind: "stop" } } });
  expect(send).toHaveBeenCalledTimes(1);
  relay.server({ type: "voice", voiceId: "v1", conversationId: "A", event: { kind: "state", state: "ready" } });
  expect(a.received).toHaveBeenCalledTimes(1); expect(b.received).not.toHaveBeenCalled();
  selected = "B"; relay.selectionChanged(selected);
  expect(send.mock.calls.at(-1)?.[0]).toMatchObject({ type: "voice", conversationId: "A", command: { kind: "stop" } });
  relay.server({ type: "voice", voiceId: "v1", conversationId: "A", event: { kind: "state", state: "ready" } });
  expect(a.received).toHaveBeenCalledTimes(2);
  a.close(); expect(send).toHaveBeenCalledTimes(2);
});
