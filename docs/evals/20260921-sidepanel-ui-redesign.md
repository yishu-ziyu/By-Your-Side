# 任务: 侧栏未完成态视觉重构（去除常驻悬浮、融入消息流、消除五重重复与穿模）

## 完成标准

- [x] 1. 顶部不再常驻大块悬浮卡：任务结束/需接续时，`#task-bar-root` 与 `#task-strip` 不在顶部霸占视口 — 谁检查: npm test
- [x] 2. 接续卡融入消息流：`#resume-entry-root` 移入 `#messages` 消息流尾部，呈现为 AI Elements Task 风格卡片（目标只显示一次、步骤清单抽屉折叠展开、保留「继续原任务」操作） — 谁检查: npm test && 人
- [x] 3. 去除裸露文本与冗余状态：移除卡片外直接散落的重复纯文本状态摘要，彻底消灭孤儿残行；来源链接统一为 Pill Badge 标签 — 谁检查: npm test && 人
- [x] 4. 吉祥物（Companion）防遮挡：修正宠物定位与呼吸安全区，严禁遮挡底栏输入框 — 谁检查: npm test && 人
- [x] 5. 全量单元测试与工程构建通过 — 谁检查: npm run check

## 验收证据

- 架构边界：`npm run check:architecture` 223 个生产文件全部通过。
- 类型检查：`npm run typecheck` extension 与 agent 全部无报错通过。
- 单元测试：`npx vitest run extension/test/` 96 个测试套件、902 个测试用例全部通过。
- 构建打包：`npm run build` 成功输出 `dist/sidepanel.js` (610.2kb) 及全部 content scripts。
- 视觉预览：已生成并验证 [preview-redesign.html](file:///Users/mahaoxuan/Desktop/AI%20产品/By-Your-Side/preview-redesign.html)。

## 边界与不做

- 不改动底层协议（`task_view`、`UserDelivery`、`task_action` 等数据契约不变）；
- 不引入外部重型 React/Vue 依赖，纯原生 TypeScript + DOM + 现有 Lucide 图标与 CSS 实现。
