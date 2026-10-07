/**
 * docs/evals/20261007-ptt-dictation.md R3（只连套餐、只听写）、R4（失败说清楚）。
 * 用假的 WebSocket 记下发出的地址与每条事件，服务端回应按 10-07 实测的事件序列手写。
 *
 * 先列出会出错的方式：
 * D1 连到按量的 /v1/realtime，或换了模型。
 * D2 发了 response.create（模型会回话、多扣额度），或没关掉服务端 VAD（会自己分轮）。
 * D3 会话还没配好就发音频，开头几个字丢了。
 * D4 松开后没提交，或提交了却不等最终转写就结束。
 * D5 连接失败、超时、服务端报错、没听到话时，给出空文字当成功。
 */
import { describe, expect, it } from "vitest";
import { createDictation, DICTATION_URL, type DictationSocket } from "../src/inproc/ptt-dictation.js";

/** 测试里收发的 JSON 事件。 */
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

type Event = { [key: string]: Json };

class FakeSocket implements DictationSocket {
  sent: Event[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: string) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  send(data: string): void { this.sent.push(JSON.parse(data)); }

  close(): void { this.closed = true; }

  serve(event: Event): void { this.onmessage?.(JSON.stringify(event)); }

  types(): unknown[] { return this.sent.map(event => event.type); }
}

function setup(timeoutMs = 2_000) {
  const sockets: FakeSocket[] = [];

  const open = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);

    return socket;
  };

  const dictation = createDictation({ open, timeoutMs });

  return { sockets, dictation };
}

const frame = (n: number) => new Int16Array(480).fill(n).buffer;

describe("push-to-talk dictation over the Step Plan realtime socket", () => {
  it("connects only to the plan URL, configures text-only manual turns, buffers early audio, commits and returns the transcript (D1–D4)", async () => {
    const { sockets, dictation } = setup();
    dictation.start();
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://api.stepfun.com/step_plan/v1/realtime?model=stepaudio-2.5-realtime");
    expect(DICTATION_URL.startsWith("wss://api.stepfun.com/step_plan/v1/")).toBe(true);

    dictation.push(frame(1));
    socket.onopen?.();
    socket.serve({ type: "session.created", session: { model: "stepaudio-2.5-realtime" } });
    expect(socket.types()).toEqual(["session.update"]);
    expect(socket.sent[0]).toMatchObject({ session: { modalities: ["text"], turn_detection: null } });

    dictation.push(frame(2));
    socket.serve({ type: "session.updated" });
    // 配好之前的那一帧补发在前，之后的按顺序跟上。
    expect(socket.types()).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.append"]);

    const result = dictation.stop();
    expect(socket.types().at(-1)).toBe("input_audio_buffer.commit");
    socket.serve({ type: "input_audio_buffer.committed" });
    socket.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "把这三家公司，整理成一张表。" });

    await expect(result).resolves.toEqual({ ok: true, text: "把这三家公司，整理成一张表。" });
    expect(socket.types()).not.toContain("response.create");
    expect(socket.closed).toBe(true);
  });

  it("stop before the session is configured still commits once it is (D3, D4)", async () => {
    const { sockets, dictation } = setup();
    dictation.start();
    const socket = sockets[0]!;
    dictation.push(frame(1));
    const result = dictation.stop();
    socket.onopen?.();
    socket.serve({ type: "session.created" });
    socket.serve({ type: "session.updated" });
    expect(socket.types()).toEqual(["session.update", "input_audio_buffer.append", "input_audio_buffer.commit"]);
    socket.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "停一下" });
    await expect(result).resolves.toEqual({ ok: true, text: "停一下" });
  });

  it("reports failures instead of an empty success (D5)", async () => {
    const empty = setup();
    empty.dictation.start();
    empty.sockets[0]!.onopen?.();
    empty.sockets[0]!.serve({ type: "session.created" });
    empty.sockets[0]!.serve({ type: "session.updated" });
    const silent = empty.dictation.stop();
    empty.sockets[0]!.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "  " });
    await expect(silent).resolves.toMatchObject({ ok: false, reason: "empty" });

    const broken = setup();
    broken.dictation.start();
    broken.sockets[0]!.onopen?.();
    broken.sockets[0]!.serve({ type: "error", error: { message: "invalid api key" } });
    await expect(broken.dictation.stop()).resolves.toMatchObject({ ok: false, reason: "failed" });

    const slow = setup(30);
    slow.dictation.start();
    await expect(slow.dictation.stop()).resolves.toMatchObject({ ok: false, reason: "timeout" });
    expect(slow.sockets[0]!.closed).toBe(true);
  });

  it("cancel closes the socket and never commits", () => {
    const { sockets, dictation } = setup();
    dictation.start();
    sockets[0]!.onopen?.();
    sockets[0]!.serve({ type: "session.created" });
    sockets[0]!.serve({ type: "session.updated" });
    dictation.push(frame(1));
    dictation.cancel();
    expect(sockets[0]!.types()).not.toContain("input_audio_buffer.commit");
    expect(sockets[0]!.closed).toBe(true);
  });
});
