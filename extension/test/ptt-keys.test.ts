/**
 * docs/evals/20261007-ptt-dictation.md R1（按键判定）。
 *
 * 先列出会出错的方式：
 * K1 轻点一下右 ⌥（不到 0.15 秒）也开始录音。
 * K2 ⌥ 当修饰键用（⌥+字母打特殊字符、⌥+方向键）时开始录音，或已开始的录音照常发出。
 * K3 按住时的自动重复按键事件让录音重复开始。
 * K4 按住时按 Esc、或窗口失焦，录音没有取消，松开后照样发出。
 * K5 左 ⌥ 也触发（左 ⌥ 常用于快捷键，只认右 ⌥）。
 * K6 松开后再按，第二次不能开始。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPttKeys, PTT_HOLD_MS } from "../src/content/ptt-keys.js";

const down = (code: string, repeat = false) => ({ type: "keydown" as const, code, repeat });

const up = (code: string) => ({ type: "keyup" as const, code, repeat: false });

function setup() {
  const calls: string[] = [];
  const keys = createPttKeys({ onStart: () => calls.push("start"), onStop: () => calls.push("stop"), onCancel: () => calls.push("cancel") });

  return { calls, keys };
}

describe("push-to-talk key detection", () => {
  beforeEach(() => { vi.useFakeTimers(); });

  afterEach(() => { vi.useRealTimers(); });

  it("holding right Option past the threshold starts; releasing stops (R1)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS + 1);
    expect(calls).toEqual(["start"]);
    keys.handle(up("AltRight"));
    expect(calls).toEqual(["start", "stop"]);
  });

  it("a short tap does nothing (K1)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS - 20);
    keys.handle(up("AltRight"));
    vi.advanceTimersByTime(1_000);
    expect(calls).toEqual([]);
  });

  it("Option used as a modifier never records, before or after the threshold (K2)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltRight"));
    keys.handle(down("KeyE"));
    vi.advanceTimersByTime(1_000);
    keys.handle(up("AltRight"));
    expect(calls).toEqual([]);

    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS + 1);
    keys.handle(down("ArrowLeft"));
    keys.handle(up("AltRight"));
    expect(calls).toEqual(["start", "cancel"]);
  });

  it("auto-repeat keydowns while held do not restart (K3)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS + 1);

    for (let i = 0; i < 5; i++) keys.handle(down("AltRight", true));
    keys.handle(up("AltRight"));
    expect(calls).toEqual(["start", "stop"]);
  });

  it("Escape or losing focus while recording cancels (K4)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS + 1);
    keys.handle(down("Escape"));
    keys.handle(up("AltRight"));
    expect(calls).toEqual(["start", "cancel"]);

    keys.handle(down("AltRight"));
    vi.advanceTimersByTime(PTT_HOLD_MS + 1);
    keys.reset();
    keys.handle(up("AltRight"));
    expect(calls).toEqual(["start", "cancel", "start", "cancel"]);
  });

  it("left Option is ignored (K5) and a second hold works again (K6)", () => {
    const { calls, keys } = setup();
    keys.handle(down("AltLeft"));
    vi.advanceTimersByTime(1_000);
    keys.handle(up("AltLeft"));
    expect(calls).toEqual([]);

    for (let round = 0; round < 2; round++) {
      keys.handle(down("AltRight"));
      vi.advanceTimersByTime(PTT_HOLD_MS + 1);
      keys.handle(up("AltRight"));
    }

    expect(calls).toEqual(["start", "stop", "start", "stop"]);
  });
});
