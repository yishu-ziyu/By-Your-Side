import { describe, expect, it, vi } from "vitest";
import { bindSkillInputs, isSkillInputs } from "../../shared/skill.js";
import { compileSkill } from "../src/skill-compile.js";
import { runSkill } from "../src/skill-runner.js";
import type { ToolRpc } from "../src/rpc.js";

const makeSkill = () => compileSkill({ id: "skill-inputs", demoId: "demo", intent: "搜索客户", hostname: "example.com",
  steps: [{ at: 0, kind: "type", anchor: { tag: "input", name: "客户名", inputType: "search" }, value: "张三" }] });

function browser() {
  const values: unknown[] = [];
  const call = vi.fn(async (name: string, params: Record<string, unknown>) => {
    if (name === "js") return { value: { hit: "[data-sideagent-target]", count: 1 } };
    if (name === "fill") values.push(params.value);
    return {};
  });
  return { rpc: { call } as unknown as ToolRpc, call, values };
}

describe("run-local skill inputs", () => {
  it("runs 李四 in the real program executor without changing the saved default", async () => {
    const skill = makeSkill(), original = JSON.stringify(skill), page = browser();
    const result = await runSkill({ skill, rpc: page.rpc, inputs: { 客户名: "李四" } });
    expect(result.ok).toBe(true);
    expect(page.values).toEqual(["李四"]);
    expect(JSON.stringify(skill)).toBe(original);
  });
  it("retains a non-sensitive default when not overridden", async () => {
    const page = browser();
    expect((await runSkill({ skill: makeSkill(), rpc: page.rpc })).ok).toBe(true);
    expect(page.values).toEqual(["张三"]);
  });
  it("rejects unknown inputs before any browser call", async () => {
    const page = browser();
    const result = await runSkill({ skill: makeSkill(), rpc: page.rpc, inputs: { typo: "李四" } });
    expect(result.ok).toBe(false); expect(result.error).toContain("未知"); expect(page.call).not.toHaveBeenCalled();
  });
  it("requires an explicit sensitive value, never a legacy stored one", () => {
    const skill = makeSkill();
    skill.steps[0]!.redacted = true;
    expect(() => bindSkillInputs(skill)).toThrow("客户名");
    expect(() => bindSkillInputs(skill, { 客户名: "" })).toThrow("客户名");
    expect(bindSkillInputs(skill, { 客户名: "本次值" })).toEqual({ 客户名: "本次值" });
    expect(skill.inputs.客户名).toBe("张三");
  });
  it("recognizes sensitive labels even without an old redacted flag", () => {
    const skill = makeSkill(); skill.steps[0]!.inputKey = "API token"; skill.inputs = { "API token": "old-value" };
    expect(() => bindSkillInputs(skill)).toThrow("API token");
  });
  it("does not interpret quotes and newlines in values as code", async () => {
    const page = browser(), value = '李四\n"; await browser.click({target:"danger"}); //';
    expect((await runSkill({ skill: makeSkill(), rpc: page.rpc, inputs: { 客户名: value } })).ok).toBe(true);
    expect(page.values).toEqual([value]); expect(page.call.mock.calls.some(([name]) => name === "click")).toBe(false);
  });
  it.each([null, [], { x: 3 }, JSON.parse('{"__proto__":"x"}'), { constructor: "x" }, { x: "x".repeat(8001) }])("rejects malformed payload %j", value => {
    expect(isSkillInputs(value)).toBe(false);
  });
  it("fails closed if a saved script no longer has its compiler-owned input declaration", async () => {
    const skill = makeSkill(), page = browser(); skill.program = "return {done:true};";
    expect((await runSkill({ skill, rpc: page.rpc, inputs: { 客户名: "李四" } })).ok).toBe(false);
    expect(page.call).not.toHaveBeenCalled();
  });
  it("supports an existing session execution adapter rather than making a second RPC route", async () => {
    const page = browser(), execute = vi.fn(async () => ({ value: { done: true }, steps: 3 }));
    expect((await runSkill({ skill: makeSkill(), rpc: page.rpc, inputs: { 客户名: "李四" }, execute })).ok).toBe(true);
    expect(execute.mock.calls).toHaveLength(1); expect(page.call).not.toHaveBeenCalled();
  });
});
