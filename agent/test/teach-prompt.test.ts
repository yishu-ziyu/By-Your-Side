import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT, TEACH_MODE_PROMPT, appendPromptForMode, workerSystemPrompt } from "../src/prompt.js";
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

  it("危险确认要求 mark 带框外 confirm/cancel 按钮，click held 后停手", () => {
    expect(SYSTEM_PROMPT).toContain('id:"confirm"');
    expect(SYSTEM_PROMPT).toContain('id:"cancel"');
    expect(SYSTEM_PROMPT).toContain("actions");
    expect(SYSTEM_PROMPT).toContain("held");
    expect(SYSTEM_PROMPT).toContain("Do not click the site's own delete control again");
  });

  it("教学段落是教学倾向而非禁令：引导步骤 + 保留全工具能力 + 危险动作前征得同意", () => {
    expect(TEACH_MODE_PROMPT).toContain("mark");
    expect(TEACH_MODE_PROMPT).toContain("Step N");
    expect(TEACH_MODE_PROMPT).toContain("clear_marks");
    expect(TEACH_MODE_PROMPT).toContain("FULL toolset");
    expect(TEACH_MODE_PROMPT).toContain("explicit consent");
    expect(TEACH_MODE_PROMPT).toContain("confirm/cancel");
    // 不再含执行层拦截的禁令表述
    expect(TEACH_MODE_PROMPT).not.toContain("blocked by the execution layer");
  });
});

describe("parallel worker prompts", () => {
  it("Lead prompt 讲清拆/不拆，不含站点特判", () => {
    expect(SYSTEM_PROMPT).toContain("spawn_worker");
    expect(SYSTEM_PROMPT).toContain("independent prefixes");
    expect(SYSTEM_PROMPT).toContain("MUST spawn");
    expect(SYSTEM_PROMPT).toContain("Doing both sites yourself");
    expect(SYSTEM_PROMPT).not.toMatch(/wikipedia|feishu|维基|飞书/i);
  });

  it("工人 prompt 含邮箱与 need_confirm，不含 spawn", () => {
    const p = workerSystemPrompt({ id: "wiki", peers: ["feishu"], tabId: 3 });
    expect(p).toContain('named "wiki"');
    expect(p).toContain("feishu");
    expect(p).toContain("post");
    expect(p).toContain("await_message");
    expect(p).toContain("need_confirm");
    expect(p).not.toContain("spawn_worker");
  });
});

describe("SYSTEM_PROMPT working tab", () => {
  it("要求插话延续已认领的 working tab，不重新询问", () => {
    expect(SYSTEM_PROMPT).toContain("Mid-run steering");
    expect(SYSTEM_PROMPT).toContain("Do not ask which tab");
    expect(SYSTEM_PROMPT).toContain("working tab you already claimed");
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
