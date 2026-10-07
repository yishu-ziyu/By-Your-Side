import { describe, expect, it } from "vitest";
import type { ModelOption } from "../../shared/protocol.js";
import {
  chipLabel,
  displayName,
  filterModels,
  groupModelsByProvider,
  modelReasoningMeta,
  providerLabel,
  providerMark,
} from "../src/sidepanel/models.js";
import { describeModelError } from "../../shared/user-facing.js";

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

describe("describeModelError", () => {
  it("sorts failures into the kind that decides the card's buttons", () => {
    expect(describeModelError("模型请求最终失败：401 Unauthorized")?.kind).toBe("auth");
    expect(describeModelError('模型请求最终失败：429: {"error":{"message":"quota exceeded"}}')?.kind).toBe("busy");
    expect(describeModelError('模型请求最终失败：503: {"message":"upstream overloaded"}')?.kind).toBe("busy");
    expect(describeModelError("模型请求最终失败：Not Found")?.kind).toBe("missing");
    expect(describeModelError("模型请求最终失败：HTTP 404: model not found")?.kind).toBe("missing");
    expect(describeModelError("模型请求最终失败：Connection error.")?.kind).toBe("network");
  });

  it("never shows status codes or raw provider JSON outside the details", () => {
    const shown = describeModelError('模型请求最终失败：503: {"message":"upstream overloaded"}')!;
    expect(`${shown.title}${shown.copy}`).not.toMatch(/503|\{|message/);
    expect(shown.detail).toContain("upstream overloaded");
  });

  it("names the failed model (docs/evals/20261004-model-failover.md F3)", () => {
    expect(describeModelError("模型请求最终失败（stepfun/step-5-preview）：Connection error.")?.copy).toContain("stepfun/step-5-preview");
    expect(describeModelError("模型请求最终失败（stepfun/step-5-preview）：first response timeout: stepfun/step-5-preview sent nothing within 15 s")?.title).toContain("太久没有回应");
  });

  it("leaves other errors to the plain message", () => {
    expect(describeModelError("切换模型失败：模型不存在或未配置凭据：foo/bar")).toBeNull();
    expect(describeModelError("Not Found")).toBeNull();
  });
});

// issue #2 / 验收 B1：能力标签不得凭 provider/modelId 字符串猜测。
// 下面的反例在旧实现里分别会被判成「支持档位调节」「内置深度思考」「极速直接响应」；
// 没有可信能力证据来源（ModelOption 不携带能力字段，协议无调档链路）时必须一律中性。
describe("modelReasoningMeta 不凭名称/供应商输出肯定能力结论", () => {
  const cases: ReadonlyArray<{ provider: string; modelId: string; why: string }> = [
    { provider: "unknown-provider", modelId: "unseen-model", why: "未知供应商 + 未知模型" },
    { provider: "openai", modelId: "unseen-model", why: "已知供应商不足以推出档位能力" },
    { provider: "openai-codex", modelId: "totally-new-model-v9", why: "codex 供应商同样无能力证据" },
    { provider: "cliproxy", modelId: "vendor-proxy-alias-x", why: "本地池代理别名不携带能力语义" },
    { provider: "cliproxy", modelId: "o1-mini", why: "供应商名也不得兜底为档位能力" },
    { provider: "minimax-cn", modelId: "brand-new-series", why: "供应商名不足以推出内置思考" },
    { provider: "anthropic", modelId: "claude-x-thinking", why: "名称含 thinking 关键字无证据" },
    { provider: "google", modelId: "gemini-9-flash-high", why: "名称含档位样式后缀无证据" },
    { provider: "minimax-o1-thinking-pro", modelId: "", why: "多类特征混杂 + 缺省字段也不输出肯定结论" },
    { provider: "", modelId: "", why: "空字段（旧服务端缺省）不崩溃且保持中性" },
  ];

  it.each(cases)("$why：$provider/$modelId → 无肯定标签", ({ provider, modelId }) => {
    const meta = modelReasoningMeta(provider, modelId);
    expect(meta.tag).toBeNull();
  });

  it("无状态：任何查询序列下同一输入的结果一致，不残留上一模型的标签", () => {
    const first = modelReasoningMeta("minimax-cn", "MiniMax-M3");
    const second = modelReasoningMeta("openai", "unseen-model");
    expect(second).toEqual(first);
    expect(modelReasoningMeta("openai", "unseen-model")).toEqual(second);
  });

  it("协议未携带能力字段（ModelOption 四字段）的目录模型查询也一律中性", () => {
    const directory: ReadonlyArray<ModelOption> = [
      m("openai", "gpt-5.6-luna"),
      m("minimax-cn", "MiniMax-M3"),
      m("kimi-coding", "kimi-for-coding"),
    ];

    for (const option of directory) {
      const meta = modelReasoningMeta(option.provider, option.modelId);
      expect(meta.tag).toBeNull();
    }
  });
});
