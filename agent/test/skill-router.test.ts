import { describe, expect, it, vi } from "vitest";
import { compileSkill } from "../src/skill-compile.js";
import { composeSkillJudgment, matchSkillTemplate, routeSkill, type SkillJudge } from "../src/skill-router.js";
import { skillSourceValues } from "../src/skill-judge.js";

const skill = compileSkill({ id: "search", demoId: "demo", hostname: "example.com", intent: "搜索张三", requestTemplate: "搜索{{客户名}}",
  steps: [{ at: 0, kind: "type", anchor: { tag: "input", name: "客户名", inputType: "search" }, value: "张三" }] });
const input = (userText: string) => ({ userText, hostname: "example.com", skills: [skill] });

describe("skill router policy fixtures", () => {
  it.each(["搜索「李四」", "搜索「张三」", '搜索"Alice Smith"'])("quoted exact request stays a zero-model local match: %s", async text => {
    const judge = vi.fn();
    const result = await routeSkill(input(text), { judge });
    expect(result.status).toBe("match");
    expect(judge).not.toHaveBeenCalled();
  });
  it.each(["搜索张三", "搜索李四", "搜索王五", "搜索 Alice", "搜索 Bob", "请搜索李四", "帮我搜索李四", "搜索李四。"])("unquoted free text is decided by the semantic judge, not the local regex: %s", async text => {
    // The judge supplies the value; the local regexer is never allowed to guess an unbounded tail.
    const material = text.replace(/^(?:请|帮我)?\s*搜索\s*/, "").replace(/。$/, "");
    const judge: SkillJudge = vi.fn(async () => ({ direct: 1, complete: 1, candidates: [{ skillId: "search", probability: .99, inputs: { 客户名: material } }] }));
    const result = await routeSkill(input(text), { judge });
    expect(result.status, text).toBe("match");
    expect(judge).toHaveBeenCalledTimes(1);
  });
  it("an extra action after a quoted material goes to the judge instead of the local regex", async () => {
    const judge: SkillJudge = vi.fn(async () => ({ direct: 1, complete: .1, candidates: [{ skillId: "search", probability: .1, inputs: {} }] }));
    const result = await routeSkill(input("搜索「李四」后导出"), { judge });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("no_match");
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
  it("same-domain www normalization remains compatible", async () => { expect((await routeSkill({ ...input("搜索「李四」"), hostname: "www.EXAMPLE.com" })).status).toBe("match"); });
  it("multiple exact recipes remain ambiguous", async () => { expect((await routeSkill({ ...input("搜索「李四」"), skills: [skill, { ...skill, id: "another" }] })).status).toBe("ambiguous"); });
  it("stale recipes are excluded", async () => {
    const fail = { at: 0, ok: false, elapsedMs: 1, steps: 1, failedStep: 1 };
    expect((await routeSkill({ ...input("搜索李四"), runs: { search: [fail, fail, fail] } })).status).toBe("no_match");
  });
  it("a legacy exact intent does not silently inherit the old material", async () => { expect((await routeSkill({ ...input("搜索张三"), skills: [{ ...skill, requestTemplate: undefined }] })).status).toBe("needs_input"); });
  it("sensitive skills cannot auto-fill a credential even when a value was supplied", async () => {
    expect((await routeSkill({ ...input("搜索「李四」"), skills: [{ ...skill, steps: skill.steps.map(step => ({ ...step, redacted: true })) }] })).status).toBe("needs_input");
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
  it("treats regex characters in a saved template literally", () => { expect(matchSkillTemplate('find(a)+"Bob"', "find(a)+{{name}}")).toEqual({ name: "Bob" }); });
});

describe("a deterministic local match needs an explicit slot boundary", () => {
  const recipe = "搜索{{姓名}}，地区{{地区}}";
  it("does not treat a fixed suffix as proof that an unquoted material has no extra action", () => {
    expect(matchSkillTemplate("搜索李四后导出，地区深圳，完成后核对", "搜索{{姓名}}，地区{{地区}}，完成后核对")).toBeNull();
    expect(matchSkillTemplate("搜索李四，地区深圳后导出，完成后核对", "搜索{{姓名}}，地区{{地区}}，完成后核对")).toBeNull();
    expect(matchSkillTemplate("搜索「李四后导出」，地区「深圳」，完成后核对", "搜索「{{姓名}}」，地区「{{地区}}」，完成后核对")).toEqual({ 姓名: "李四后导出", 地区: "深圳" });
  });
  it.each(["后导出", "再发送", "后把结果发给我", "并且只显示未跟进的", "然后导出", "then export", "and export", "后写入备注"])("does not let the trailing free-text slot swallow: %s", tail => {
    expect(matchSkillTemplate(`搜索李四，地区深圳${tail}`, recipe)).toBeNull();
  });
  it("keeps a quoted material that itself contains action words", () => {
    expect(matchSkillTemplate("搜索「李四然后导出」，地区「深圳」", recipe)).toEqual({ 姓名: "李四然后导出", 地区: "深圳" });
    expect(matchSkillTemplate('搜索"导出全部"并说明，地区「深圳」', "搜索{{姓名}}并说明，地区{{地区}}")).toEqual({ 姓名: "导出全部", 地区: "深圳" });
  });
  it("defers free text even with a literal terminator, while retaining quoted values", () => {
    expect(matchSkillTemplate("从北京到上海的客户，导出", "从{{起点}}到{{终点}}的客户，导出")).toBeNull();
    expect(matchSkillTemplate("从「北京」到「上海」的客户，导出", "从{{起点}}到{{终点}}的客户，导出")).toEqual({ 起点: "北京", 终点: "上海" });
  });
  it("defers an unquoted trailing slot instead of treating the whole tail as a value", () => {
    expect(matchSkillTemplate("搜索李四，地区深圳", recipe)).toBeNull();
    expect(matchSkillTemplate("搜索李四，地区=深圳", recipe)).toBeNull();
  });
});

describe("clarification is judged apart from execution", () => {
  const two = compileSkill({ id: "search2", demoId: "demo", hostname: "example.com", intent: "按客户名和地区搜索客户",
    requestTemplate: "搜索「{{客户名}}」，地区「{{地区}}」",
    steps: [{ at: 0, kind: "type", anchor: { tag: "input", name: "客户名", inputType: "search" }, value: "张三" },
      { at: 1, kind: "type", anchor: { tag: "input", name: "地区", inputType: "text" }, value: "北京" }] });
  const partial = { userText: "查找客户「李四」", hostname: "example.com", skills: [two] };
  const gap = { direct: .93, complete: .8, candidates: [{ skillId: "search2", probability: .47, waiting: .94, inputs: { 客户名: "李四" } }] };
  it("asks for the missing material when the workflow itself is identified", () => {
    expect(composeSkillJudgment(partial, gap)).toMatchObject({ status: "needs_input", skillId: "search2", missing: ["地区"] });
  });
  it("does not run the skill just because the clarification judgment is high", () => {
    const ready = { ...gap, candidates: [{ ...gap.candidates[0]!, inputs: { 客户名: "李四", 地区: "深圳" } }] };
    expect(composeSkillJudgment({ ...partial, userText: "查找客户「李四」，地区「深圳」" }, ready).status).not.toBe("match");
  });
  it("a below-gate clarification judgment still falls back", () => {
    expect(composeSkillJudgment(partial, { ...gap, candidates: [{ ...gap.candidates[0]!, waiting: .5 }] }).status).toBe("no_match");
  });
  it("the clarification gate stays separate from the execution gate", () => {
    // .86 identifies a workflow that only lacks materials; .8 does not. Neither executes.
    expect(composeSkillJudgment(partial, { ...gap, candidates: [{ ...gap.candidates[0]!, waiting: .86 }] }).status).toBe("needs_input");
    expect(composeSkillJudgment(partial, { ...gap, candidates: [{ ...gap.candidates[0]!, waiting: .8 }] }).status).toBe("no_match");
    // An execution match still needs the full .9 gate even when clarification is high.
    expect(composeSkillJudgment({ ...partial, userText: "查找客户「李四」，地区「深圳」" },
      { ...gap, complete: .95, candidates: [{ ...gap.candidates[0]!, probability: .89, waiting: .95, inputs: { 客户名: "李四", 地区: "深圳" } }] }).status).toBe("no_match");
  });
  it("two unclear workflows are not auto-answered", () => {
    expect(composeSkillJudgment({ ...partial, skills: [two, { ...two, id: "other" }] }, { ...gap,
      candidates: [gap.candidates[0]!, { ...gap.candidates[0]!, skillId: "other" }] }).status).toBe("ambiguous");
  });
  it("clarification never runs for a different site", () => {
    expect(composeSkillJudgment({ ...partial, hostname: "other.example" }, gap).status).toBe("no_match");
  });
});
