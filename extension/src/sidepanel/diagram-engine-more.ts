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
