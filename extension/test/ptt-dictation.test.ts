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
 * 计时（docs/evals/20261008-ptt-timeout.md R1、R2）：
 * D6 松开时还没连上，等过 15 秒还在等，或报成「没回应」，用户分不清是连不上。
 * D7 服务端还在一个个回事件，却按固定时长判超时，把慢而正常的听写丢掉。
 * D8 服务端一直不回，等过 8 秒还在等；或一直零星回事件，过了 30 秒还不结束。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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

function setup(timing?: { connectMs: number; idleMs: number; capMs: number }) {
  const sockets: FakeSocket[] = [];

  const open = (url: string) => {
    const socket = new FakeSocket(url);
    sockets.push(socket);

    return socket;
  };

  const dictation = createDictation({ open, ...timing });

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

  });

  describe("timers count from release, not from connecting (D6–D8)", () => {
    afterEach(() => { vi.useRealTimers(); });

    /** 连上、配好、松开：返回 socket 与结果。 */
    const released = () => {
      vi.useFakeTimers();
      const { sockets, dictation } = setup();
      dictation.start();
      const socket = sockets[0]!;
      socket.serve({ type: "session.created" });
      socket.serve({ type: "session.updated" });
      const result = dictation.stop();
      let settled: unknown = null;
      void result.then(value => { settled = value; });

      return { socket, result, settled: () => settled };
    };

    it("a connection that is not ready 15 s after release fails as 'cannot connect', not as no reply (D6)", async () => {
      vi.useFakeTimers();
      const { sockets, dictation } = setup();
      dictation.start();
      const result = dictation.stop();
      let settled: unknown = null;
      void result.then(value => { settled = value; });
      await vi.advanceTimersByTimeAsync(14_900);
      expect(settled).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(settled).toEqual({ ok: false, reason: "failed", message: "连不上听写服务（网络慢或代理）" });
      expect(sockets[0]!.closed).toBe(true);
    });

    it("a connection ready 12 s after release still gets its own idle window and succeeds (D6, D7)", async () => {
      vi.useFakeTimers();
      const { sockets, dictation } = setup();
      dictation.start();
      const result = dictation.stop();
      await vi.advanceTimersByTimeAsync(12_000);
      sockets[0]!.serve({ type: "session.created" });
      sockets[0]!.serve({ type: "session.updated" });
      await vi.advanceTimersByTimeAsync(7_000);
      sockets[0]!.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "慢慢连上了" });
      await expect(result).resolves.toEqual({ ok: true, text: "慢慢连上了" });
    });

    it("each server event after commit restarts the 8 s wait, so a slow but answering server is not cut off (D7)", async () => {
      const { socket, result } = released();
      await vi.advanceTimersByTimeAsync(7_500);
      socket.serve({ type: "input_audio_buffer.committed" });
      await vi.advanceTimersByTimeAsync(7_500);
      socket.serve({ type: "conversation.item.created" });
      await vi.advanceTimersByTimeAsync(7_500);
      socket.serve({ type: "conversation.item.input_audio_transcription.completed", transcript: "一直在回" });
      await expect(result).resolves.toEqual({ ok: true, text: "一直在回" });
    });

    it("8 s with no event after commit is a timeout (D8)", async () => {
      const { socket, settled } = released();
      await vi.advanceTimersByTimeAsync(7_900);
      expect(settled()).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(settled()).toMatchObject({ ok: false, reason: "timeout" });
      expect(socket.closed).toBe(true);
    });

    it("events keep coming but no transcript: gives up 30 s after commit (D8)", async () => {
      const { socket, settled } = released();

      for (let at = 5_000; at <= 25_000; at += 5_000) {
        await vi.advanceTimersByTimeAsync(5_000);
        socket.serve({ type: "conversation.item.created" });
      }

      await vi.advanceTimersByTimeAsync(4_900);
      expect(settled()).toBeNull();
      await vi.advanceTimersByTimeAsync(200);
      expect(settled()).toMatchObject({ ok: false, reason: "timeout" });
    });
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
