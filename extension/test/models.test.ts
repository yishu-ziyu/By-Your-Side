import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../shared/protocol.js";
import {
  chipLabel,
  displayName,
  filterModels,
  groupModelsByProvider,
  humanizeModelError,
  providerLabel,
  providerMark,
} from "../src/sidepanel/models.js";

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

  it("maps known cloud providers to short names", () => {
    expect(providerLabel("minimax-cn")).toBe("MiniMax");
    expect(providerLabel("kimi-coding")).toBe("Kimi");
  });

  it("passes through unknown providers", () => {
    expect(providerLabel("some-new-lab")).toBe("some-new-lab");
  });
});

describe("displayName / chipLabel", () => {
  it("uses SDK name and strips a provider prefix", () => {
    expect(displayName({ id: "minimax-cn/MiniMax-M3", provider: "minimax-cn", modelId: "MiniMax-M3", name: "MiniMax-M3" })).toBe(
      "MiniMax-M3",
    );
    expect(displayName({ id: "x/y", provider: "x", modelId: "y", name: "openai-codex/gpt-5.6-luna" })).toBe("gpt-5.6-luna");
  });

  it("shows a human chip label instead of provider/id", () => {
    const models = [m("minimax-cn", "MiniMax-M3")];
    expect(chipLabel("minimax-cn/MiniMax-M3", models)).toBe("MiniMax-M3");
    expect(chipLabel("minimax-cn/MiniMax-M3", [])).toBe("MiniMax-M3");
    expect(chipLabel(undefined, [])).toBe("选择模型");
  });
});

describe("filterModels", () => {
  const list = [m("minimax-cn", "MiniMax-M3"), m("kimi-coding", "kimi-for-coding"), m("openai-codex", "gpt-5.6-luna")];

  it("returns a copy when the query is empty", () => {
    expect(filterModels(list, "  ").map((x) => x.id)).toEqual(list.map((x) => x.id));
  });

  it("matches name, id, and provider label", () => {
    expect(filterModels(list, "minimax").map((x) => x.modelId)).toEqual(["MiniMax-M3"]);
    expect(filterModels(list, "Kimi").map((x) => x.modelId)).toEqual(["kimi-for-coding"]);
    expect(filterModels(list, "luna").map((x) => x.modelId)).toEqual(["gpt-5.6-luna"]);
  });

  it("returns an empty list when nothing matches", () => {
    expect(filterModels(list, "zzz-nope")).toEqual([]);
  });
});

describe("providerMark", () => {
  it("takes the first letter of the display label and is stable", () => {
    expect(providerMark("minimax-cn").letter).toBe("M");
    expect(providerMark("cliproxy").letter).toBe("本");
    expect(providerMark("minimax-cn").hue).toBe(providerMark("minimax-cn").hue);
    expect(providerMark("minimax-cn").hue).not.toBe(providerMark("kimi-coding").hue);
  });
});

describe("humanizeModelError", () => {
  it("rewrites a bare Not Found model failure with actionable guidance", () => {
    expect(humanizeModelError("模型请求最终失败：Not Found")).toBe(
      "模型不可用（Not Found）：模型可能已下线或当前账号无访问权限，请在输入区切换模型后重试",
    );
  });

  it("rewrites 404-shaped model failures", () => {
    expect(humanizeModelError("模型请求最终失败：HTTP 404: model not found")).toContain("请在输入区切换模型");
  });

  it("leaves other errors untouched", () => {
    expect(humanizeModelError("模型请求最终失败：Connection error.")).toBe("模型请求最终失败：Connection error.");
    expect(humanizeModelError("切换模型失败：模型不存在或未配置凭据：foo/bar")).toBe(
      "切换模型失败：模型不存在或未配置凭据：foo/bar",
    );
    expect(humanizeModelError("Not Found")).toBe("Not Found");
  });
});
