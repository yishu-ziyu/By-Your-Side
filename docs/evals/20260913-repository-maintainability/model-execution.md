# 模型选择器封装（sidepanel）— 结果

## API（extension/src/sidepanel/model-picker.ts，317 行）

`mountModelPicker({ host, sendSetModel }) => ModelPicker`

- `host`：显式 DOM 宿主 `{ button, mark, name, reasoningTag, popover, composer, app }`；模块内部不再 `getElementById` 读全局。
- `sendSetModel(model: string): void`：唯一对外动作，选定后发 `set_model`。
- 返回 `ModelPicker`：
  - `apply(model, models)` — hello_ok 初始快照（`models` 未下发按空目录）。
  - `update(model, models)` — model_info 回执（字段缺省保留现值）。
  - `reset()` — 会话切换 / 断线回到未选择态。
  - `reposition()` — 布局变化后重算位置（面板未展开不动作）。
- `modelState` / `modelQuery` 收入闭包，不再有全局状态镜像。

main.ts 调用者已改：`selectConversation`→`reset()`；`hello_ok`→`apply(msg.model, msg.models)`；`model_info`→`update(msg.model, msg.models)`；断线→`reset()`；`autoResize`→`reposition()`。
移除仅因提取而闲置的 import：`Search`、`Check`（lucide）；`chipLabel/displayName/filterModels/groupModelsByProvider/modelReasoningMeta/providerLabel/providerMark`（models.js，仅留 `humanizeModelError`）；类型 `ModelOption`。

行为保持：搜索过滤、键盘上/下导航、Escape 先清搜索再关闭、点击外部关闭、provider 字母标（首字+稳定色相）、能力标签仅在有可信证据时渲染（当前恒无）、展开动画/尺寸定位、收到 `model_info` 回执才更新状态——逻辑逐行照搬，未重设计样式。

## 前后体量

- main.ts 模型块：241 行 → 18 行（改为 `mountModelPicker` 调用）。
- main.ts 总行数：3265 → 3031（-234）。

## 检查

- `npm run typecheck -w @sideagent/extension`：通过。
- 模型相关既有测试：`extension/test/models.test.ts`、`extension/test/motion-language.test.ts`、`agent/test/reachable-models.test.ts`、`agent/test/protocol.test.ts` → 95 passed。
- 改测试 1 处：`motion-language.test.ts`「03 reveal」原断言 `alignModelPopoverOrigin`/`playPopoverOpening` 在 main.ts，提取后改读 `model-picker.ts`（契约意图不变）。
- 全量 `npm test`：180/181 文件通过；唯一失败 `extension/test/fetch-effect-policy.test.ts`（`listen EPERM 127.0.0.1`，沙箱禁本地监听），与本次改动无关。

## 未决

- 未做真实 UI 验证（按要求不操作 GUI），交主代理。
- 未新增单测：选择器是 DOM+动画行为，vitest 环境为 node（无 jsdom），加 DOM 测试需引入新依赖（越界）。行为一致性由既有 motion/models 契约 + 主代理真实侧栏验证覆盖。
- 未跑全量 build、未提交、未改 docs。
