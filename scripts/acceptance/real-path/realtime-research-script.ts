import type { Rule } from "./scripted-model.mts";
import { RESEARCH_COMPANIES } from "./realtime-research-page.ts";

/** Script only the page task; voice routing and replies use the configured real models. */
export function researchTaskRule(origin: string, goal: string, finalText?: string): Rule {
  const result = [
    "| 公司 | 业务 | 融资 |",
    "| --- | --- | --- |",
    ...RESEARCH_COMPANIES.map(company => `| ${company.name} | ${company.business} | ${company.funding} |`),
  ].join("\n");
  return { match: goal, steps: [
    { tool: { name: "navigate", args: { url: `${origin}/research` } }, delayMs: 2000 },
    { tool: { name: "click", args: { target: "#research-search button", label: "搜索" } }, delayMs: 2000 },
    { tool: { name: "snapshot", args: {} }, delayMs: 1000 },
    { tool: { name: "navigate", args: { url: `${origin}/research/jia` } }, delayMs: 4000 },
    { tool: { name: "snapshot", args: {} }, delayMs: 1000 },
    { tool: { name: "read_element", args: { target: "#business" } }, delayMs: 4000 },
    { tool: { name: "read_element", args: { target: "#funding" } }, delayMs: 1000 },
    { tool: { name: "navigate", args: { url: `${origin}/research/yi` } }, delayMs: 5000 },
    { tool: { name: "snapshot", args: {} }, delayMs: 1000 },
    { tool: { name: "read_element", args: { target: "#business" } }, delayMs: 5000 },
    { tool: { name: "read_element", args: { target: "#funding" } }, delayMs: 5000 },
    { tool: { name: "read_element", args: { target: "h1" } }, delayMs: 5000 },
    { tool: { name: "navigate", args: { url: `${origin}/research/bing` } }, delayMs: 6000 },
    { tool: { name: "snapshot", args: {} }, delayMs: 3000 },
    { tool: { name: "read_element", args: { target: "#business" } }, delayMs: 4000 },
    { tool: { name: "read_element", args: { target: "#funding" } }, delayMs: 1000 },
    { text: finalText ?? result, delayMs: 5000 },
  ] };
}
