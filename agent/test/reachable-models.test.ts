import { describe, expect, it } from "vitest";
import { annotateReachableModels } from "../src/reachable-models.js";
import type { ModelOption } from "../../shared/protocol.js";

function option(id: string): ModelOption {
  const slash = id.indexOf("/");

  return { id, provider: id.slice(0, slash), modelId: id.slice(slash + 1), name: id.slice(slash + 1) };
}

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
