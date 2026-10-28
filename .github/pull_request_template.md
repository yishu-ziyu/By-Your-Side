## 用户能观察到的变化

说明功能变化及边界；纯重构说明为何没有用户行为变化。

## 验证

- `npm run check:code` 和相关真实路径用例：
- 改界面时的 `npm run check:ui`；改文案时的 `npm run check:copy`；改跨层依赖时的 `npm run check:architecture`：
- 没跑到的检查及原因：

默认不要求验收文件。只有用户要求留证据，或安全、数据迁移、跨机发布等高风险改动才附验收链接。改了文档才运行 `npm run check:docs`。
