import { describe, expect, it, vi } from "vitest";
import { compileSkill } from "../src/skill-compile.js";
import { composeSkillJudgment, matchSkillTemplate, routeSkill, type SkillJudge } from "../src/skill-router.js";
import { skillSourceValues } from "../src/skill-judge.js";

const skill = compileSkill({ id: "search", demoId: "demo", hostname: "example.com", intent: "搜索张三", requestTemplate: "搜索{{客户名}}",
  steps: [{ at: 0, kind: "type", anchor: { tag: "input", name: "客户名", inputType: "search" }, value: "张三" }] });
const input = (userText: string) => ({ userText, hostname: "example.com", skills: [skill] });

describe("skill router policy fixtures", () => {
  it.each(["搜索张三", "搜索李四", "搜索王五", "搜索 Alice", "搜索 Bob", "请搜索李四", "帮我搜索李四", "搜索李四。", "搜索「李四」", '搜索"Alice Smith"'])("exact complete request: %s", async text => {
    const judge = vi.fn();
    const result = await routeSkill(input(text), { judge });
    expect(result.status).toBe("match");
    expect(judge).not.toHaveBeenCalled();
  });
  it.each(["不要搜索李四", "取消搜索", "解释搜索功能", "如何搜索李四", "如果明天下雨就搜索李四", "明天搜索李四", "搜索李四然后导出", "搜索李四；删除结果", "搜索李四\n发送邮件", "搜索李四并且只显示北京客户", "打开邮箱", "只要未跟进的客户", "搜索李四但是不要提交", "搜索李四同时搜索张三", ""])("never partially match: %s", async text => {
    expect((await routeSkill(input(text))).status).toBe("no_match");
  });
  it("same-site different task stays unmatched", async () => { expect((await routeSkill(input("导出客户李四"))).status).toBe("no_match"); });
  it("cross-site skills are not sent to the judge", async () => {
    const judge = vi.fn();
    expect((await routeSkill({ ...input("搜索李四"), hostname: "other.example" }, { judge })).status).toBe("no_match");
    expect(judge).not.toHaveBeenCalled();
  });
  it("same-domain www normalization remains compatible", async () => { expect((await routeSkill({ ...input("搜索李四"), hostname: "www.EXAMPLE.com" })).status).toBe("match"); });
  it("multiple exact recipes remain ambiguous", async () => { expect((await routeSkill({ ...input("搜索李四"), skills: [skill, { ...skill, id: "another" }] })).status).toBe("ambiguous"); });
  it("stale recipes are excluded", async () => {
    const fail = { at: 0, ok: false, elapsedMs: 1, steps: 1, failedStep: 1 };
    expect((await routeSkill({ ...input("搜索李四"), runs: { search: [fail, fail, fail] } })).status).toBe("no_match");
  });
  it("a legacy exact intent does not silently inherit the old material", async () => { expect((await routeSkill({ ...input("搜索张三"), skills: [{ ...skill, requestTemplate: undefined }] })).status).toBe("needs_input"); });
  it("sensitive skills cannot auto-fill a credential even when a value was supplied", async () => {
    expect((await routeSkill({ ...input("搜索李四"), skills: [{ ...skill, steps: skill.steps.map(step => ({ ...step, redacted: true })) }] })).status).toBe("needs_input");
  });
  it("a bounded injected judge cannot hang the normal agent", async () => {
    const judge: SkillJudge = () => new Promise(() => {});
    const start = Date.now();
    expect((await routeSkill(input("查找「李四」"), { judge, timeoutMs: 20 })).status).toBe("no_match");
    expect(Date.now() - start).toBeLessThan(500);
  });
  it("service errors fall back without retries", async () => {
    const judge = vi.fn(async () => { throw new Error("offline"); });
    expect((await routeSkill(input("查找「李四」"), { judge })).status).toBe("no_match"); expect(judge).toHaveBeenCalledTimes(1);
  });
  it("cancellation ignores a late semantic answer", async () => {
    const controller = new AbortController(); controller.abort();
    const judge = vi.fn(); expect((await routeSkill(input("查找「李四」"), { judge, signal: controller.signal })).status).toBe("no_match"); expect(judge).not.toHaveBeenCalled();
  });
});

describe("structured semantic composition", () => {
  const query = input("帮忙查找「李四」");
  const accepted = { direct: 1, complete: 1, candidates: [{ skillId: "search", probability: .99, inputs: { 客户名: "李四" } }] };
  it("binds only a provided source value", () => { expect(composeSkillJudgment(query, accepted)).toMatchObject({ status: "match", inputs: { 客户名: "李四" } }); });
  it("rejects invented arguments", () => { expect(composeSkillJudgment(query, { ...accepted, candidates: [{ ...accepted.candidates[0]!, inputs: { 客户名: "王五" } }] }).status).toBe("no_match"); });
  it("does not confuse confidence with permission", () => { expect(composeSkillJudgment(query, { ...accepted, direct: .5 }).status).toBe("no_match"); });
  it("rejects partial task coverage", () => { expect(composeSkillJudgment(query, { ...accepted, complete: .7 }).status).toBe("no_match"); });
  it("requires all calibrated judgment gates, not just one high score", () => {
    expect(composeSkillJudgment(query, { ...accepted, direct: .91, complete: .91, candidates: [{ ...accepted.candidates[0]!, probability: .91 }] }).status).toBe("match");
    for (const partial of [{ direct: .89 }, { complete: .89 }, { candidates: [{ ...accepted.candidates[0]!, probability: .89 }] }]) {
      expect(composeSkillJudgment(query, { ...accepted, ...partial }).status).toBe("no_match");
    }
  });
  it("missing material returns needs_input", () => { expect(composeSkillJudgment(query, { ...accepted, candidates: [{ ...accepted.candidates[0]!, inputs: {} }] }).status).toBe("needs_input"); });
  it("two confident proposals do not choose a winner", () => { expect(composeSkillJudgment(query, { ...accepted, candidates: [accepted.candidates[0]!, accepted.candidates[0]!] }).status).toBe("ambiguous"); });
  it("supports source quotes and explicit assignments without generating values", () => { expect(skillSourceValues('查找「李四」，地区=北京')).toEqual(["李四", "北京"]); });
  it("does not swallow an assignment key into its value after a heading", () => { expect(skillSourceValues('查询条件：客户名=高原，地区=南京')).toEqual(["高原", "南京"]); });
  it("does not guess the boundary between adjacent material slots", () => {
    expect(matchSkillTemplate('查张三北京', '查{{姓名}}{{地区}}')).toBeNull();
    expect(matchSkillTemplate('随便什么', '{{姓名}}')).toBeNull();
  });
  it("treats regex characters in a saved template literally", () => { expect(matchSkillTemplate("find(a)+Bob", "find(a)+{{name}}")).toEqual({ name: "Bob" }); });
});
