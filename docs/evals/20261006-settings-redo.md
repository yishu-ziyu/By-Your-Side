# 任务: 设置页「模型与语音」一眼看出正在用哪个模型、哪几家已经连好（#62）

## 规则
- R1 正在用的服务商和模型在页顶，换模型一步完成。
  - 例子(正)：主模型下拉只列已连接服务商的模型；选了就写入存储，列表把新的一家排第一 — 谁检查：`scripts/probes/settings-redo.mts`
  - 例子(反)：下拉里出现没连接的服务商（如 Anthropic） — 谁检查：同上
- R2 已连接的排在前，状态一眼可读；其余折起，可搜服务商名和模型名。
  - 例子(正)：6 家已连接在上，「使用中 / 已登录 / 已填 key」用点或钥匙加文字；搜 glm 命中 OpenRouter — 谁检查：同上
  - 例子(反)：同一家的国际、中国各占一行 — 谁检查：同上
- R3 原有功能都在，原有验收脚本照样能跑：登录 / 退出、测试连接、保存并使用、用作快速模型、自定义地址、语音 key、音色、人设、开关、诊断记录 — 谁检查：`ux-fixes`、`plain-text-streaming`、`offline-send-and-model-menu`、`takeover-handback`
- R4 观感与原型 A 一致，没有卡片套卡片；深色、窄窗口、减少动效都正常 — 谁检查：人（截图见 PR）

## 还没答上的问题
- 无。

## 技术前提
- 前提：`popover` 顶层浮层能放模型下拉，不被列表的 `overflow: hidden` 裁掉。小实验：无头 Chrome 打开 xAI 详情点模型框，截图 `6-model-combo.png`。结果：通过。

## 边界与不做
- 不改存储键和凭据格式；地区合并只影响显示。
- 品牌图标来自 `@lobehub/icons-static-svg` 1.95.1（MIT），原样收进 `extension/icons/providers/`，许可见 `extension/licenses/lobe-icons-MIT.txt`。小米的图标是文字标，小尺寸看不清，用首字。
- 不加新依赖，不用 React。

## 证据
- 选型：A 安静列表 + D 的「主模型 / 快速模型」一组。理由和 #62 的 11 条差别见 PR。
- R1、R2：`settings-redo.mts` 18/18 通过（假凭据，不发请求）。截图写到 `tmp/settings-redo/`。
- R3：`ux-fixes --phase=after`、`plain-text-streaming`、`takeover-handback`、`ghost-hud-and-steering` 通过；`inproc-voice` 用 gpt-6-luna 跑音色、自定义人设两次，全过。
  - `plain-text-streaming` 原来点「自定义地址」前不滚动；新列表更长，那一行在视口外，点空后存成了上一家（`minimax-cn/demo-model`）。脚本补上滚动后通过。产品里人会先滚动。
  - 与本页无关、`main` 上也失败的：`sidebar-header` 3 项旧判据，`sidebar-interaction` 的 #58 B，`offline-send-and-model-menu` 的「模型菜单展开」。`killer-interactions` 在两边都失败，失败点不同，没有定论。
- `npm run check`：类型、构建通过；单测 2413/2414，失败的两个 agent 测试单独重跑通过（并发下不稳定，本次没改 agent）。
