# 任务：独立预览 Agent 确认胶囊的玻璃形变

设计探索，**仅提供可试原型**；不改变现有扩展的网页操作策略，也不代表批准卡恢复。原型位于 [prototypes/agent-glass-confirm](../../prototypes/agent-glass-confirm/README.md)。

## 规则

- R1 胶囊能原位生成一个玻璃弹层，取消与确认后沿原路径收回。— 检查者：`npm run smoke`；实际形变手感由人判断。
- R2 取消保留草稿；确认只改变模拟状态，禁止向真实邮箱发送请求。— 检查者：`npm run smoke`，检查状态和网络请求。
- R3 Esc、键盘 Enter、快速重新展开与减少动态效果时仍可使用。— 检查者：`npm run smoke`。

## 还没答上的问题

正式产品是否需要任何确认浮层、何时出现，以及如何与现有边缘药丸合并，尚未决定。本 PR 不涉及。

## 技术前提

使用 MIT 许可的 Glass-HQ `@glass-sdk/liquid-glass`、Base UI Popover、`morphFrom` 和 `morph="become"`。背景须由 `GlassContent` 管理；这不证明在普通网页上能折射任意窗口背景。

## 边界与不做

原型不接真实邮箱、Chrome 扩展或 Agent；不合入生产 UI。只在独立页面展示。

## 验证与遗留

- 2026-10-09：原型 `npm run build` 通过；`npm run smoke` 通过，包括原生弹层、退出、连续操作、键盘与零对外发送。测试截图在原型本地 `out/`，不提交。
- 用 Chrome 无头播放并逐帧观察，确认了中间轮廓；测得首次明显变形前约 350ms 的准备延迟，重复打开也可能超过 160ms。**尚未通过真人手感验收**。
- 项目根目录 `npm run check:docs` 因隔离工作树缺少根依赖 `marked` 未运行成功；不写为通过，交给 PR CI 核查。
