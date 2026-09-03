import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../shared/protocol.js";
import { groupModelsByProvider, humanizeModelError, providerLabel } from "../src/sidepanel/models.js";

const m = (provider: string, modelId: string): ModelOption => ({
  id: `${provider}/${modelId}`,
  provider,
  modelId,
  name: modelId,
});

describe("groupModelsByProvider", () => {
  it("groups by provider preserving first-seen order", () => {
    const groups = groupModelsByProvider([
      m("kimi-coding", "k3"),
      m("openai-codex", "gpt-5.5"),
      m("kimi-coding", "kimi-for-coding"),
      m("openai-codex", "gpt-5.6-luna"),
    ]);
    expect(groups.map((g) => g.provider)).toEqual(["kimi-coding", "openai-codex"]);
    expect(groups[0]!.models.map((x) => x.modelId)).toEqual(["k3", "kimi-for-coding"]);
    expect(groups[1]!.models.map((x) => x.modelId)).toEqual(["gpt-5.5", "gpt-5.6-luna"]);
  });

  it("returns an empty array for no models", () => {
    expect(groupModelsByProvider([])).toEqual([]);
  });

  it("keeps a single-provider list in one group", () => {
    const groups = groupModelsByProvider([m("xai", "grok-4.5"), m("xai", "grok-4.6")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.models).toHaveLength(2);
  });
});

describe("providerLabel", () => {
  it("maps cliproxy to its display name", () => {
    expect(providerLabel("cliproxy")).toBe("本地池");
  });

  it("passes through unknown providers", () => {
    expect(providerLabel("minimax-cn")).toBe("minimax-cn");
  });
});

describe("humanizeModelError", () => {
  it("rewrites a bare Not Found model failure with actionable guidance", () => {
    expect(humanizeModelError("模型请求最终失败：Not Found")).toBe(
      "模型不可用（Not Found）：模型可能已下线或当前账号无访问权限，请在顶栏切换模型后重试",
    );
  });

  it("rewrites 404-shaped model failures", () => {
    expect(humanizeModelError("模型请求最终失败：HTTP 404: model not found")).toContain("请在顶栏切换模型");
  });

  it("leaves other errors untouched", () => {
    expect(humanizeModelError("模型请求最终失败：Connection error.")).toBe("模型请求最终失败：Connection error.");
    expect(humanizeModelError("切换模型失败：模型不存在或未配置凭据：foo/bar")).toBe(
      "切换模型失败：模型不存在或未配置凭据：foo/bar",
    );
    expect(humanizeModelError("Not Found")).toBe("Not Found");
  });
});
