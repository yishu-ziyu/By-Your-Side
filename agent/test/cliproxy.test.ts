import { describe, expect, it } from "vitest";
import {
  CLIPROXY_MODELS,
  parseClientEnvKey,
  selectCliproxyModels,
} from "../src/cliproxy.js";

describe("parseClientEnvKey", () => {
  it("parses plain assignment", () => {
    expect(parseClientEnvKey("OPENAI_API_KEY=sk-test-123\n")).toBe("sk-test-123");
  });

  it("parses export-prefixed assignment and strips quotes", () => {
    expect(parseClientEnvKey('export OPENAI_API_KEY="sk-quoted"\n')).toBe("sk-quoted");
    expect(parseClientEnvKey("export OPENAI_API_KEY='sk-single'\n")).toBe("sk-single");
  });

  it("ignores unrelated lines and picks the first match", () => {
    const content = [
      "export OPENAI_BASE_URL=http://127.0.0.1:8317/v1",
      "export OPENAI_API_KEY=sk-first",
      "OPENAI_API_KEY=sk-second",
    ].join("\n");
    expect(parseClientEnvKey(content)).toBe("sk-first");
  });

  it("returns null when missing or empty", () => {
    expect(parseClientEnvKey("")).toBeNull();
    expect(parseClientEnvKey("OPENAI_BASE_URL=x\n")).toBeNull();
    expect(parseClientEnvKey("OPENAI_API_KEY=\n")).toBeNull();
    expect(parseClientEnvKey('OPENAI_API_KEY=""\n')).toBeNull();
  });

  it("tolerates CRLF and surrounding whitespace", () => {
    expect(parseClientEnvKey("export OPENAI_API_KEY = sk-crlf\r\n")).toBe("sk-crlf");
  });
});

describe("CLIPROXY_MODELS 静态清单", () => {
  it("含 gemini 对话模型（2026-09-04 区域限制恢复后注册）", () => {
    expect(CLIPROXY_MODELS.some((s) => s.id === "gemini-3-flash")).toBe(true);
    expect(CLIPROXY_MODELS.some((s) => s.id === "gemini-3.1-flash-lite")).toBe(true);
    expect(CLIPROXY_MODELS.some((s) => s.id === "gemini-3.1-pro-low")).toBe(true);
  });

  it("不含图像/视频生成模型", () => {
    expect(CLIPROXY_MODELS.some((s) => s.id.startsWith("gpt-image"))).toBe(false);
    expect(CLIPROXY_MODELS.some((s) => s.id.startsWith("grok-imagine"))).toBe(false);
    expect(CLIPROXY_MODELS.some((s) => s.id.includes("flash-image"))).toBe(false);
  });

  it("id 无重复", () => {
    const ids = CLIPROXY_MODELS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("selectCliproxyModels", () => {
  it("只保留清单与池子通告的交集，顺序跟清单走", () => {
    const selected = selectCliproxyModels(["kimi-k2", "gpt-5.4-mini", "gpt-5.4"]);
    expect(selected.map((s) => s.id)).toEqual(["gpt-5.4", "gpt-5.4-mini", "kimi-k2"]);
  });

  it("图像/视频模型即使被通告也不注册", () => {
    const selected = selectCliproxyModels([
      "gemini-3.1-flash-image",
      "gpt-image-1.5",
      "grok-imagine-video",
      "gemini-3-flash",
      "kimi-k2",
    ]);
    expect(selected.map((s) => s.id)).toEqual(["kimi-k2", "gemini-3-flash"]);
  });

  it("池子里未实测过的模型不注册", () => {
    const selected = selectCliproxyModels(["codex-auto-review", "gpt-oss-120b-medium", "kimi-k3"]);
    expect(selected).toEqual([]);
  });

  it("空通告返回空数组", () => {
    expect(selectCliproxyModels([])).toEqual([]);
  });
});
