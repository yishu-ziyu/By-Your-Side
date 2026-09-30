# 任务: 模型菜单轻微展开、短退场，先交前后视频供用户决定是否合入

[当前状态](../STATUS.md) · [使用说明](../guides/usage.md)

## 完成标准

- [x] 1. 原版与候选使用同一实际组件、CSS、视口、目录和操作，交付并排 MP4/GIF — 谁检查: 浏览器录制脚本 + 人
- [x] 2. 进场缩放 .95–.98，退场短于进场；原点仍对齐按钮；搜索与列表刷新不重播 — 谁检查: 无头浏览器
- [x] 3. 快速开关、进退场中断、Escape、外部点击、选模型不会留下幽灵面板或抢焦点；关闭后不能再交互 — 谁检查: 无头浏览器
- [x] 4. 搜索优先清空、方向键/Enter 选择、回执才更新当前模型；减少动画即时开关 — 谁检查: 无头浏览器
- [x] 5. 适用测试、扩展类型/构建、文档同步通过；原工作区不变 — 谁检查: 命令与 diff
- [ ] 6. 观感与是否合入由用户观看录制后裁决 — 谁检查: 人，待审

## 边界与不做

- 以远端 main `05c66a6` 为基线；独立 worktree `/tmp/bys-model-picker-motion`、分支 `codex/model-picker-motion`。
- 不含主工作区未提交的侧栏改版，不含 PR14 恢复链；不推送、不合并、不部署、不替换日常扩展/构建。
- 不调用模型、不读凭据。录制采用原组件的隔离浏览器页，模型目录与发送回调为固定测试边界，不是完整扩展/Chrome side panel 验收。

## 实现前的失败清单

- 旧版从 .72 放大且关闭直接消失；过大的内容缩放由实际渲染复现。
- 关闭后残留可点击、可 Tab 聚焦的列表；焦点留在隐藏搜索框。
- 旧退场清理晚到，隐藏刚重开的菜单；旧打开微任务抢外部焦点。
- 搜索/刷新列表在打开动效期间重新播逐项入场；旧 600 ms 清理中断新一次入场。
- 进场未完便关闭或退场未完重开产生闪烁/尺寸跳跃。
- 减少动画偏好仍缩放，或运行中切换偏好后面板卡住。
- 选择发多次请求、未等回执就改当前模型，Escape 不先清搜索。

## 验证证据

- 原版运行与候选检查分别保留在 `out/model-picker-motion/baseline-results.json`、`results.json`；原版 5 PASS / 4 FAIL，候选 9 PASS / 0 FAIL。原版失败为无退场、搜索重播、Escape 焦点丢失、减少动画仍播放。原始失败未删除。
- `node extension/test/model-picker-motion.mjs`：真实浏览器鼠标/键盘验证；并排录制按同一脚本向两份真实组件同步发送 DOM 点击/输入/键盘事件。静态壳来自既有 fixture，真实 mountModelPicker 与完整生产 CSS，没有手绘动效或模型调用。
- 环境：macOS arm64、Node v22.23.1、Chrome for Testing 149.0.7827.55（本机 chromium-1228 目录），Playwright 来自 `/Users/mahaoxuan/tools/gstack/node_modules/playwright/index.mjs`；全程 headless、新建临时 profile，无扩展安装、无浏览器安全策略绕过。
- MP4/GIF：`out/model-picker-motion/model-picker-before-after.mp4` / `.gif`，728×720、25 fps、7 秒、1×速度；每侧 360×640。展示打开、搜索、两次 Escape、外部点击、点选 Kimi、50 ms 间隔反向开关。已人工查看逐帧联系图确认真实菜单与标签；手感和合入仍待用户判断。
- `npm run typecheck -w @sideagent/extension`、`npm exec vitest run extension/test/models.test.ts extension/test/task-view-ui.test.ts`：通过，67 个现有测试。
- `SIDEAGENT_BUILD_DIST=/tmp/bys-model-picker-motion/out/extension-dist npm run build -w @sideagent/extension`：最终完整构建通过，日志 `out/model-picker-motion/build-isolated.log`。
- 构建曾先受沙箱 IPC 限制、再因整目录 node_modules 链接把 @sideagent/agent 解析回原工作区而失败。只修正 worktree 的依赖链接后通过；两份失败日志保留，不修改构建代码。
- `npm run lint:changed`：无新增违规；已修正新验收脚本的格式与未使用导入，随后复跑浏览器验证。
- `npm run check:architecture`：290 个生产文件通过。`npm run check:docs` 与 `npm run check:docs -- --base 05c66a6`：通过。入口/说明已人工复核，仅说明模型菜单交互，不修改侧栏位置或数据协议。
- 原工作区既有修改保留；本次只写独立 worktree、临时证据和 Git 分支元数据。未 push/merge/deploy。
- 真实 Chrome side panel 容器与完整扩展加载未跑：未获安装/替换日常扩展授权，采用用户允许的原组件隔离页。模型通信/Chrome 服务为固定边界，不宣称全链路验收。旧浏览器对离散 display 过渡的兼容未验；不支持时会即时收起，焦点与逻辑状态仍即时关闭。

## 实现与长期归属

整体缩放从 .72 改为 .97，180 ms 入场、110 ms 退场；保留按钮原点。CSS 离散 display 过渡负责视觉生命周期，hidden 与 inert 立即停止交互，没有隐藏延迟回调。移除一次性列表动效及 600 ms 计时器，搜索/刷新不会重播；打开焦点微任务核对菜单仍打开。长期用户行为见[使用说明](../guides/usage.md)，复跑边界见[开发检查](../development/checks.md)。

经验筛选：本次没有需另建经验条目的产品结论；动效与焦点原因已由实现解释。依赖链接导致隔离失效的已验证原因回流开发检查。
