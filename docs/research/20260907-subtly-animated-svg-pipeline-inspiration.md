# 设计灵感与素材库归档：Kit Langton 式 SVG 微动效数据流管线

- **来源链接**：[https://x.com/kitlangton/status/2096703869136867563](https://x.com/kitlangton/status/2096703869136867563)
- **作者**：Kit Langton (@kitlangton)
- **原推描述**：“Is there a limit to the pleasures a man can derive from subtly animated svgs? For I have not yet found it.”
- **归档时间**：2026-09-07
- **归档状态**：**素材库就绪（Inspiration Archived · 暂不落地）**
- **关联评估文件**：
  - 规格说明：[`docs/evals/20260907-runtime-pipeline-viz.md`](file:///Users/mahaoxuan/Desktop/ego/docs/evals/20260907-runtime-pipeline-viz.md)
  - 交互原型：[`docs/evals/20260907-runtime-pipeline-viz.html`](file:///Users/mahaoxuan/Desktop/ego/docs/evals/20260907-runtime-pipeline-viz.html)

---

## 1. 核心视觉与交互精髓 (Core Mechanics)

1. **结构形态**：
   - 左侧为汇聚容器（`Shared state` / `Runtime`），右侧为树状发散的独立源节点（如 Model、Skills、Tools、Policy）。
   - 中间通过平滑的贝塞尔总线（Cubic Bezier Curves）精准连通起点与目标插槽。
2. **微动效原则（Subtle & Event-Driven）**：
   - 平时保持极简静态（哑光灰色细线条 `rgba(255, 255, 255, 0.12)`），无常驻眩光或机械转圈；
   - 仅在数据更新时，触发一次单向、带 Apple 阻尼减速（`cubic-bezier(0.16, 1, 0.3, 1)`）的微光粒子滑入；
   - 到达目标端口时，数字产生轻微的缩放回弹（`scale(1.12) → scale(1)`），随后迅速恢复静止。
3. **情绪价值**：
   - 展现系统的“生命力”与“确定性”，消除黑盒疑问，强化克制与安全感。

---

## 2. 为什么当前版本【不强行落地】？

用户明确指出、且经源码核查确认：
- **产品现实**：By-Your-Side 当前底层只有 `shared/protocol.ts` 定义的 17 个固定浏览器工具，**尚未构建动态发现与挂载的 Skills 插件系统**，也没有开放的 `models.dev` 总线；
- **设计禁忌**：不能为了动效而虚构不存在的系统概念（防止陷入 Vaporware UI / 虚假状态困境）。
- **共识**：底层没有真实运转的机制时，绝不在界面上画这套皮。

---

## 3. 未来激活落地的触发条件 (Future Activation Triggers)

当项目演进至以下里程碑时，可直接唤醒本素材库中的原型落地：

1. **MCP / Skills 动态插件体系正式构建时**：
   - 当扩展支持扫描本地文件夹安装 Skill 或连接远程 MCP Server，界面需要向用户展示“刚刚检测并挂载了哪些能力”时，采用方案 A（空状态能力装配看板）。
2. **多 Agent 编排与控制权流转深入时**：
   - 当 Lead Session 与 Worker Session 协同，或在用户深度参与的 `Takeover ↔ Handback` 中需要清晰感知“控制权与 DOM 快照在哪个 Agent 手中”时，激活连线流转。
3. **Run Steps 执行卡片支持复杂 DAG 步骤依赖时**：
   - 当工具链输出成为下一工具显式输入时，激活方案 C（步骤内嵌依赖图）。
