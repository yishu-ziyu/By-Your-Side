import { describe, expect, it } from "vitest";
import { dismiss, emptyHabitState, observe, type HabitState } from "../src/memory-habit.js";

const DAY = 86_400_000;
const T0 = 1_000_000_000_000;

function run(state: HabitState, convs: string[], key = "seat:aisle", start = T0) {
  const asks: unknown[] = [];
  convs.forEach((c, i) => {
    const r = observe(state, { key, text: "喜欢靠过道", conversationId: c, at: start + i * 1000 });
    state = r.state;
    if (r.ask) asks.push(r.ask);
  });
  return { state, asks };
}

describe("memory-habit", () => {
  it("3 个不同对话 -> 只问一次", () => {
    const { asks } = run(emptyHabitState(), ["a", "b", "c"]);
    expect(asks).toEqual([{ key: "seat:aisle", text: "喜欢靠过道" }]);
  });

  it("2 个不同对话 -> 不问", () => {
    expect(run(emptyHabitState(), ["a", "b"]).asks).toHaveLength(0);
  });

  it("同一对话重复 3 次 -> 不问", () => {
    expect(run(emptyHabitState(), ["a", "a", "a"]).asks).toHaveLength(0);
  });

  it("问过之后第 4 个对话不再问", () => {
    expect(run(emptyHabitState(), ["a", "b", "c", "d", "e"]).asks).toHaveLength(1);
  });

  it("拒绝后永远不问", () => {
    let s = run(emptyHabitState(), ["a", "b"]).state;
    s = dismiss(s, "seat:aisle");
    expect(run(s, ["c", "d", "e"]).asks).toHaveLength(0);
  });

  it("超过 30 天的观察不算", () => {
    let s = run(emptyHabitState(), ["a", "b"]).state;
    const r = observe(s, { key: "seat:aisle", text: "x", conversationId: "c", at: T0 + 31 * DAY });
    expect(r.ask).toBeNull();
    // 新窗口内再凑够 3 个才问
    const more = run(r.state, ["d", "e"], "seat:aisle", T0 + 31 * DAY + 5000);
    expect(more.asks).toHaveLength(1);
  });

  it("状态经 JSON 往返后行为不变", () => {
    let s = run(emptyHabitState(), ["a", "b"]).state;
    s = JSON.parse(JSON.stringify(s));
    const r = observe(s, { key: "seat:aisle", text: "喜欢靠过道", conversationId: "c", at: T0 + 5000 });
    expect(r.ask).not.toBeNull();
    const again = JSON.parse(JSON.stringify(r.state));
    expect(run(again, ["d"]).asks).toHaveLength(0);
  });

  it("最多保留 200 个 key，丢最旧的", () => {
    let s = emptyHabitState();
    for (let i = 0; i < 205; i++) {
      s = observe(s, { key: `k${i}`, text: "t", conversationId: "a", at: T0 + i }).state;
    }
    expect(Object.keys(s.habits)).toHaveLength(200);
    expect(s.habits["k0"]).toBeUndefined();
    expect(s.habits["k204"]).toBeDefined();
  });
});
