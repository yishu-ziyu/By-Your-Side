# SideAgent · 运行时装配与数据流微动效评估 (Kit Langton SVG 对照)

本文档定义了将 Kit Langton 式的克制 SVG 微动效管线引入到 By-Your-Side 扩展侧边栏的评估标准、设计对照与交互原型。

原型 HTML 文件位于：[`docs/evals/20260907-runtime-pipeline-viz.html`](file:///Users/mahaoxuan/Desktop/ego/docs/evals/20260907-runtime-pipeline-viz.html)

## 真正要判断的 3 件事

1. **展现位置与生命周期（Where & When）**：
   - 方案 A【推荐 · 空状态能力装配看板】：在用户尚未发问、切换模型或初始化会话时，直观展现 Agent 连接的 Model、Skills、Browser Tools 与 Policy，消除黑盒感；
   - 方案 B【顶部常驻折叠 HUD 胶囊】：作为侧栏顶部的极简状态胶囊，平时仅占 28px 高度，展开后查看流动状态；
   - 方案 C【步骤执行卡片内嵌 DAG】：下沉至 Run Steps 卡片内，用贝塞尔连线替代死板的步骤清单，展示工具间的数据传递。

2. **动效克制度与认知负荷（Subtlety vs Distraction）**：
   - 严格杜绝无休止的机械旋转与跑马灯；
   - 仅在“事件发生时”（如发现新技能、切换工作页、派发工具调用）触发一次 600ms 物理阻尼微光脉冲与沿线粒子滑入，数据到达后端口微震，随之恢复静止。

3. **视觉与侧边栏 360px 宽度适配（Layout Density）**：
   - 在狭窄的 360px~420px 侧栏视口内，如何保证拓扑层次紧凑、文字不被挤压折行。

## 对照过的 Will's S Design Note

1. **Refactoring UI《Start with too much white space》&《Emphasize by de-emphasizing》**：
   - 灰度分级：背景 `#090d16` / 容器 `#131823` / 边框 `rgba(255,255,255,0.08)`；
   - 连线与插槽端口采用低明度哑光，仅在数据流动瞬间点亮 `#38bdf8`（Sky Blue）或 `#4ade80`（Emerald Green），不喧宾夺主。
2. **Agentive UX · Wayfinding（方向感知）**：
   - 让用户确信“Agent 已经拿到了这些工具，且明确知道当前的活动标签页”，回答“发生了什么、依赖是什么”。
3. **Apple Motion 物理阻尼原则**：
   - 脉冲运动采用 `cubic-bezier(0.16, 1, 0.3, 1)`，粒子减速入场，无生硬顿挫。
