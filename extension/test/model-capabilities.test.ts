/**
 * 扩展注册与解析模型时用的能力（docs/evals/20261001-model-effort-and-side-judgments.md 标准 1、6）。
 * 走扩展真实的模型运行时（createModelRuntime → resolveModel），只看解析出的模型能力，不发请求、不读凭据。
 *
 * 先列出会出错的方式：
 * C1 阶跃 step-3.7-flash 仍登记为只收文字，截图发不过去。
 * C2 阶跃开了思考后系统提示词改用 developer 角色（实测会被忽略，直接和用户聊天）。
 * C3 目录里没有的 MiniMax-M3.1-Flash-Preview 解析不出来，或被套成 OpenAI 兼容协议、错的地址。
 * C4 M3.1 的能力表允许「关闭思考」（服务端 400 requires adaptive thinking），或最低档不是 low。
 * C5 未登记的新模型照搬同服务商某个模型的思考与看图能力（按名字/邻居猜），而不是保守默认。
 */
import { describe, expect, it } from "vitest";
import { createModelRuntime } from "../src/inproc/model-runtime.js";

import { thinkingProfile } from "../../shared/model-capabilities.js";

const runtime = createModelRuntime(() => {});

const resolve = (provider: string, modelId: string) => runtime.resolveModel({ provider, modelId });

describe("model capabilities in the extension's model registration", () => {
  it("registers step-3.7-flash as image-capable, always thinking, with its system prompt in the system role (C1, C2)", () => {
    const step = resolve("stepfun", "step-3.7-flash");
    expect(step.input).toContain("image");
    expect(step.baseUrl).toBe("https://api.stepfun.com/step_plan/v1");
    expect(thinkingProfile(step)).toEqual({ levels: ["minimal", "low", "medium", "high"], canDisable: false, image: true });
    // SAFETY: 阶跃注册为 OpenAI 兼容协议，compat 是该协议的兼容项（可能缺省）。
    expect((step.compat as { supportsDeveloperRole?: boolean } | undefined)?.supportsDeveloperRole).toBe(false);
  });

  it("resolves MiniMax-M3.1-Flash-Preview on MiniMax's Anthropic endpoint; thinking cannot be disabled and starts at low (C3, C4)", () => {
    const m31 = resolve("minimax-cn", "MiniMax-M3.1-Flash-Preview");
    expect(m31).toMatchObject({ id: "MiniMax-M3.1-Flash-Preview", provider: "minimax-cn", api: "anthropic-messages", baseUrl: "https://api.minimaxi.com/anthropic", reasoning: true });
    expect(thinkingProfile(m31)).toEqual({ levels: ["low", "medium", "high", "xhigh", "max"], canDisable: false, image: true });
  });

  it("gives an unregistered model the conservative default instead of a sibling's capabilities (C5)", () => {
    const unknown = resolve("minimax-cn", "MiniMax-M9-Unreleased");
    expect(unknown).toMatchObject({ provider: "minimax-cn", api: "anthropic-messages", reasoning: false, input: ["text"] });
    expect(thinkingProfile(unknown)).toEqual({ levels: ["off"], canDisable: true, image: false });
  });
});
