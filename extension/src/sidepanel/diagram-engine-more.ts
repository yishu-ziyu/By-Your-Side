/**
 * 流程图以外的结构图（时间线、时序图……）：用户点名要 Mermaid 时模型会写这些图种。
 * 和 diagram-engine.ts 分开打包：常见的流程图只加载那一小包，遇到这些图种才加载这一包。
 * 注册的图种和 answer-cards.ts 的 MERMAID_FENCE 一一对应，没注册的照旧显示代码。
 */
import { mount, register, render } from "pele/core";
import classDiagram from "pele/diagrams/class";
import er from "pele/diagrams/er";
import gantt from "pele/diagrams/gantt";
import journey from "pele/diagrams/journey";
import mindmap from "pele/diagrams/mindmap";
import pie from "pele/diagrams/pie";
import quadrant from "pele/diagrams/quadrantChart";
import sequence from "pele/diagrams/sequence";
import state from "pele/diagrams/state";
import timeline from "pele/diagrams/timeline";
import xychart from "pele/diagrams/xychart";

for (const diagram of [timeline, sequence, mindmap, pie, gantt, state, classDiagram, er, journey, quadrant, xychart]) register(diagram);

export { mount, render };
