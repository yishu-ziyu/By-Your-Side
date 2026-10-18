/**
 * 回答卡片里的结构图渲染器（Pele，MIT，见 extension/licenses/pele-MIT.txt）。单独打包，回答里第一次出现图时才加载。
 * 只注册流程图：提示词只教模型写 flowchart，其他图种进来按画不出处理。
 */
import { mount, register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";

register(flowchart);

export { mount, render };
