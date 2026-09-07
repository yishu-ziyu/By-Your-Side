# 任务: 修复侧边栏执行步骤聚合块在消息较多时被垂直挤压变形的问题

来源：2026-09-07 用户提供截图指出侧边栏中“这个过程被压缩的很奇怪”：执行步骤聚合卡片在对话消息变长时被严重纵向挤压，图标与文字下半截或上半截被卡片边缘裁切，卡片高度甚至被压至不足 20px 乃至 2px。

```
Change:     1. extension/src/sidepanel/styles.css：
               - 在 #messages > * 增加 `flex-shrink: 0;`，确保消息流中所有子元素在纵向超出时均走父容器滚动（overflow-y: auto），绝不被弹性盒压缩。
               - 在 details.run-steps 显式声明 `flex-shrink: 0; min-height: min-content;`，并确保 .run-body > * `flex-shrink: 0;`。
               - 在 details.run-steps summary 显式增加 `min-height: 38px; line-height: 1.5; box-sizing: border-box;`，确保无论文字长短均保持充足舒适的垂直高度与居中对齐。
               - 在 details.thinking、.chip-group、.msg 显式增加 `flex-shrink: 0;` 防护。
            2. 验证 Chrome 真实页面下在收起状态与展开状态下的实际 DOM 盒模型高度与截屏表现。
Not this:   不破坏步骤链文字超长时的横向省略（run-chain 的 text-overflow: ellipsis）。
Evaluator:  机器：npm run typecheck、npm test、npm run build。
            人评：在 Chrome 侧边栏实际长对话下观察执行步骤块，确认无论收起或展开状态均高度舒展完整、图标文字垂直居中且无任何裁切。
Evidence:   本卡 + docs/NOTES.md + 单元测试 + CDP 截图。
```

## 完成标准

- [x] 1. 样式防护：在 `extension/src/sidepanel/styles.css` 中为 `#messages > *`、`details.run-steps`、`summary` 及关键容器声明 `flex-shrink: 0` 与尺寸保底，从根本上杜绝 flexbox 负空间挤压 — 谁检查: `npm run build`
- [x] 2. 全量测试与类型安全：TypeScript 类型检查与全量单元测试（42 模块、404 用例）全绿 — 谁检查: `npm test && npm run typecheck`
- [x] 3. 真机渲染核验：通过 CDP 注入与真实 sidepanel 验证，收起状态高度恢复稳定 40~44px，展开状态按需伸展，文字/图标完整呈现零裁切 — 谁检查: 人（已保存真机截图证据）

## 边界与不做

- 不改变步骤链横向 ellipsis 行为与折叠展开的交互语义。
