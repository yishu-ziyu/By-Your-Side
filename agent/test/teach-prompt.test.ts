import { describe, expect, it } from "vitest";
import { TEACH_MODE_PROMPT, appendPromptForMode } from "../src/prompt.js";
import { getMode, setMode } from "../src/mode.js";

describe("appendPromptForMode（teach prompt 选择逻辑）", () => {
  it("teach 模式追加 TEACH_MODE_PROMPT，不动 base", () => {
    const base = ["existing-append"];
    const out = appendPromptForMode("teach", base);
    expect(out).toEqual(["existing-append", TEACH_MODE_PROMPT]);
    expect(base).toEqual(["existing-append"]); // 不原地修改
  });

  it("act 模式原样返回 base", () => {
    const base = ["existing-append"];
    expect(appendPromptForMode("act", base)).toBe(base);
    expect(appendPromptForMode("act", [])).toEqual([]);
  });

  it("教学段落是教学倾向而非禁令：引导步骤 + 保留全工具能力 + 危险动作前征得同意", () => {
    expect(TEACH_MODE_PROMPT).toContain("mark");
    expect(TEACH_MODE_PROMPT).toContain("Step N");
    expect(TEACH_MODE_PROMPT).toContain("clear_marks");
    expect(TEACH_MODE_PROMPT).toContain("FULL toolset");
    expect(TEACH_MODE_PROMPT).toContain("explicit consent");
    // 不再含执行层拦截的禁令表述
    expect(TEACH_MODE_PROMPT).not.toContain("blocked by the execution layer");
  });
});

describe("mode ref", () => {
  it("默认 act，setMode 可切换", () => {
    setMode("act"); // 隔离其他测试的残留状态
    expect(getMode()).toBe("act");
    setMode("teach");
    expect(getMode()).toBe("teach");
    expect(appendPromptForMode(getMode(), [])).toEqual([TEACH_MODE_PROMPT]);
    setMode("act");
    expect(appendPromptForMode(getMode(), [])).toEqual([]);
  });
});
