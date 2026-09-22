# 任务: 点模型芯片不再点了没反应——空目录时保持可选，目录跨会话/重开不丢

日期：2026-09-23。来源：用户反馈「[截图] 这个点击之后，模型我们就不能选。」截图状态 = 芯片显示 `deepseek-flash`、点开没有模型可选。

## 完成标准

- [x] 1. 目录为空时（models=[]/缺省）芯片可点，菜单给出空态原因，不再是静默死按钮 — 谁检查: 浏览器 harness 回放 + 真实侧栏
- [x] 2. 侧栏/面板重开或扩展重载后，回放携带模型目录，芯片直接可用 — 谁检查: 真实链路（重载后开面板）
- [x] 3. 别会话捎来的 model_info 目录被放行（不把可达模型挡在门外），模型本身仍按会话归属丢弃 — 谁检查: harness S3b + 真实链路
- [x] 4. 当前会话模型永远出现在默认（只看常用）视图，能选回来 — 谁检查: 真实侧栏 + harness S3b
- [x] 5. 全量工程检查不新增失败（预存并发失败经隔离证明非本次引入） — 谁检查: `npm run check`

## 复现（修前）

生产 dist + 端口边界替身（与 `extension/test/panel-states-check.mjs` 同方法），回放 `hello_ok{model:"opencode-go/deepseek-flash"}`（models 缺省，= 用户截图状态）：

- 芯片 `label="deepseek-flash"`、**`disabled=true`**；点击后面板不开、无提示、`set_model` 0 条。= 用户反馈原型。
- live 链路同源证据（开发者 Chrome + 真实 native agent）：
  - SW 重连后回放 `hello_ok model=undefined models=MISSING`、`model_info model=undefined models=0`（连接本身健康，detail=opencode-go/deepseek-flash）；
  - 225 条 `model_info`（models=163，真实 live 目录）因外层/内层双层 conversationId 过滤被整条丢弃，芯片停在空目录。

## 根因

1. `extension/src/sidepanel/model-picker.ts`：`modelBtn.disabled = models.length === 0` —— 目录没到时芯片静默禁用，点击无任何反馈。
2. `extension/src/background/index.ts`：syncPanel 回放 hello_ok 只带 `model` 不带 `models`（L1617-1620），且 `lastModelInfo` 入库被 `conversationId === "default"` 闸门卡住（L912，日常会话 id 永不为 default）→ 面板重开只能拿到「有模型名、没有目录」。
3. `extension/src/sidepanel/main.ts`：`handleBgMessage` 外层信封过滤（L3716-3718）与 `handleServerMessage` 内层过滤（L3656）把会话不匹配的 `model_info` 整条丢弃。目录是一次枚举、全局通用的事实，跟着别会话的消息一起被扔了。
4. 附带：UI 默认视图只信 agent 的 `featured` 标，标是按 agent 当时 current 打的；跨会话目录会让本会话当前模型漏出默认视图（当前模型回不去）。

## 修复（3 文件，均未改协议）

- `model-picker.ts`：目录空但已知当前模型时芯片保持可点、菜单打开显示「模型目录还没拿到，暂时没法切换」；只有完全无信息才隐藏；默认视图里当前会话模型强制可见（尊重搜索词）。
- `background/index.ts`：`lastHelloOk` 增存 `models`（目录是全局事实，与会话归属无关），syncPanel 回放带上；`model` 语义不变（仍不回写别会话默认值）。
- `main.ts`：两层过滤都为 `model_info` 放行——外层放行到内层，内层只收 `models`（`update(undefined, models)` 合并，保留本会话模型）、丢弃 `model`。

## 验证

- harness（生产 UI + 真实 163 条目录）四态：空目录（S1）= 芯片可点 + 空态文案；真实目录当前未打标（S2）= 菜单 4 项、点击发出 `set_model`；跨会话目录（S3b）= 目录放行、模型不放行；current 已打标（S3）= 5 项、current 标记。修前 S1 芯片 disabled、点击 0 事件。
- 真实链路（开发者 Chrome + 已加载扩展 + 真实 native agent）：`npm run reload:ext` 后开面板，芯片 `DeepSeek V4.1 Flash (Go)` 可用 title=`切换模型（opencode-go/deepseek-flash）`；真实 Chrome 侧栏容器点芯片，菜单 5 项、当前项 `current+aria-selected`。未真实发起切换（不改动日常会话模型），set_model 发送路径由 harness S2 证明。
- `npm run check`：typecheck/build 通过；全量 vitest 11 失败/3194（6 文件）——`git stash` 仅暂存本次 3 文件后同样失败（pointer-input 9 项逐条相同），证明属并发在途改动预存失败，非本次引入。models.test.ts 27/27 过。

## 边界与不做

- 不改 agent 侧：`availableModels()` 空枚举（modelRuntime 未就绪/枚举抛错 → `model_info{model, models:[]}`）本身未修，UI 现在会给原因而非死按钮，且后续任一 model_info/重开会自愈。
- 不新增轮询/重试机制；不真实切换模型；不动 `featured` 集与 provider 目录。
