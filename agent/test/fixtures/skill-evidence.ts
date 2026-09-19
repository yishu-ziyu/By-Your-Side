import { SkillLearningTrace, type SkillEvidence } from "../../src/skill-learning.js";
import type { ToolContract } from "../../../shared/protocol.js";

export const skillPage = { tabId: 7, title: "客户查询", url: "https://example.com/search" };
export function target(name: string, tag = "input", type = "text"): ToolContract["read_element"]["data"] {
  return { tabId: 7, target: "@1", tagName: tag, textContent: "", documentId: "document-one",
    anchorSource: { tag, type, ariaLabel: name } };
}
export function searchEvidence(query = "张三", region = "北京"): SkillEvidence[] {
  return [
    { toolCallId: "step-1", name: "fill", params: { tabId: 7, target: "@1", value: query }, target: target("客户名", "input", "search"), result: { filled: true } },
    { toolCallId: "step-2", name: "fill", params: { tabId: 7, target: "@2", value: region }, target: target("地区"), result: { filled: true } },
    { toolCallId: "step-3", name: "click", params: { tabId: 7, target: "@3" }, target: target("搜索", "button"), result: { clicked: true } },
    { toolCallId: "step-4", name: "read_element", params: { tabId: 7, target: "@4", expect: { property: "textContent", contains: query } },
      result: { ...target("查询结果", "div"), textContent: `找到客户 ${query} / ${region}`, check: { matched: true, property: "textContent", elapsedMs: 0 } } },
  ];
}
export function learningFixture(query = "张三", region = "北京", runId = "run-one") {
  const trace = new SkillLearningTrace();
  trace.begin(runId, `搜索「${query}」，地区「${region}」`, skillPage);
  const events = searchEvidence(query, region);
  for (const event of events) trace.observe(event);
  // Production marks this only after the deliverable-contract judgment passes
  // (BrowserAgentSession.completeSkillLearning); the fixture stands in for that verified learn.
  const candidate = () => {
    const value = trace.finish(runId, true)!;
    return value && { ...value, skill: { ...value.skill, learnedOutputChecked: true as const } };
  };
  return { trace, events, candidate };
}
