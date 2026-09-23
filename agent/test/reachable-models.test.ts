import { describe, expect, it } from "vitest";
import {
  annotateReachableModels,
  FEATURED_MODEL_IDS,
  filterReachableModels,
  REACHABLE_MODEL_IDS,
} from "../src/reachable-models.js";
import type { ModelOption } from "../../shared/protocol.js";

function option(id: string): ModelOption {
  const slash = id.indexOf("/");

  return { id, provider: id.slice(0, slash), modelId: id.slice(slash + 1), name: id.slice(slash + 1) };
}

const FEATURED = [
  "step-plan/step-5-preview",
  "cliproxy/mimo-v2.6-flash",
  "commandcode/xiaomi/mimo-v2.6-flash",
  "opencode-go/mimo-v2.6-flash",
];

describe("默认精选集（FEATURED_MODEL_IDS）", () => {
  it("是 2026-09-23 用户裁定的四项", () => {
    expect([...FEATURED_MODEL_IDS].sort()).toEqual([...FEATURED].sort());
  });

  it("REACHABLE_MODEL_IDS 是兼容别名，与精选集同一集合", () => {
    expect(REACHABLE_MODEL_IDS).toBe(FEATURED_MODEL_IDS);
  });
});

describe("filterReachableModels", () => {
  it("只留精选集，保持目录顺序", () => {
    const listed = [
      option("minimax-cn/MiniMax-M3"),
      option("xai/grok-4.6"),
      option("step-plan/step-5-preview"),
      option("cliproxy/mimo-v2.6-flash"),
      option("commandcode/xiaomi/mimo-v2.6-flash"),
      option("opencode-go/mimo-v2.6-flash"),
      option("cliproxy/grok-4.6"),
    ];

    expect(filterReachableModels(listed).map((m) => m.id)).toEqual(FEATURED);
  });

  it("保留会话当前模型，即使它不在精选集里（否则切走后无法切回）", () => {
    const listed = [option("kimi-coding/kimi-for-coding"), option("cliproxy/mimo-v2.6-flash")];
    expect(filterReachableModels(listed, "kimi-coding/kimi-for-coding").map((m) => m.id)).toEqual([
      "kimi-coding/kimi-for-coding",
      "cliproxy/mimo-v2.6-flash",
    ]);
  });
});

describe("annotateReachableModels", () => {
  it("下发全量并逐个打标，不删任何模型", () => {
    const listed = [
      option("step-plan/step-5-preview"),
      option("cliproxy/grok-4.6"),
      option("commandcode/xiaomi/mimo-v2.6-flash"),
      option("kimi-coding/kimi-for-coding"),
    ];

    expect(annotateReachableModels(listed).map((m) => ({ id: m.id, featured: m.featured }))).toEqual([
      { id: "step-plan/step-5-preview", featured: true },
      { id: "cliproxy/grok-4.6", featured: false },
      { id: "commandcode/xiaomi/mimo-v2.6-flash", featured: true },
      { id: "kimi-coding/kimi-for-coding", featured: false },
    ]);
  });

  it("当前会话模型一律算精选", () => {
    const listed = [option("kimi-coding/kimi-for-coding")];
    expect(annotateReachableModels(listed, "kimi-coding/kimi-for-coding")[0]!.featured).toBe(true);
  });

  it("不修改输入对象", () => {
    const listed = [option("cliproxy/mimo-v2.6-flash")];
    annotateReachableModels(listed);
    expect(listed[0]).not.toHaveProperty("featured");
  });
});
