# 任务: 就地确认结束后，"待确认"名牌不再留在页面上

2026-09-10 21:29 真机：在 ChatGPT 页面上 Agent 点击发送按钮被拦成"待确认"，用户点确认、消息确实发出去了，但"待确认"名牌一直挂在那颗按钮上（用户截图）。这条标注是就地确认的锚框，确认完就该消失。

## 完成标准

- [x] 1. 拿住态结束（用户确认/取消、或换动作）时，本次确认的锚框标注一起撤掉。— 谁检查: 隔离浏览器
- [x] 2. 页面上同时存在的任务标注（模型画的 AMR 位置等）不受确认流程影响。— 谁检查: 隔离浏览器
- [x] 3. 标准 1 在没有修复时必须失败（证明检查真的盯住了这个现象）。— 谁检查: 临时移除修复复跑
- [x] 4. 第一轮光标、就地确认、状态层既有行为不回归。— 谁检查: overlay-check、cursor-status-check、全量测试

## 边界与不做

- 不改"哪些点击要被拦"的判定，不改双键形态与拿住姿态。
- 取消路径现有"清空该工作页全部标注"的行为**本轮未改**（见下"未决"）。
- 不改确认后真实派发点击的链路。

## 证据

真机日志 `~/.sideagent/traces/1789046800691-94854dbb-f39a-408a-b6c6-bfd7b7b2fe2d.jsonl`：

- 13:29:00 `click{label:"发送按钮"}` → `Held click on 发送按钮`（`isError:false`），标注"待确认"+拿住双键
- 13:29:03 用户确认（`steer "确认"`）→ 点击真实派发，消息进入对话
- 13:29:32 用户截图：光标已走，"待确认"名牌仍留在按钮上

根因：`extension/src/content/cursor.ts` 里拿住态（hold）把锚框标注画在产品页面上，但 `releaseHoldInst` 只摘按住姿态与双键，没有任何一步撤掉那条标注；确认路径 `resolveHeldClick` 只调 `releaseHold`，于是标注留到下一次 `clear_marks` 或页面跳转。

| 层 | 入口 | 结果 |
| --- | --- | --- |
| 定向检查 | `node extension/test/overlay-check.mjs` | PASS。新增用例：任务标注 + 确认锚框共存（标注层 2 个）→ `releaseHold` → 只剩"任务标注"（标注层 1 个，DOM 子节点数与记账同时核对） |
| 反例复现 | 临时注释掉 `if (hold.mark) removeMark(hold.mark)` 后重建复跑 | FAIL（`layer:2, labels:["AMR 位置","待确认"]`），确认检查能抓住原现象；已还原 |
| 状态层回归 | `node extension/test/cursor-status-check.mjs` | PASS |
| 全量 | `npm test` / `npm run typecheck` / `npm run build` | 136 文件 1117 项通过；类型检查、构建通过 |
| 部署一致 | `shasum` + CDP 取运行中扩展 | `content-cursor.js` `922c78833fcd…`、`background.js` `1af859c43121…` 与构建一致；扩展已重载 |

## 未决（下一件事，等用户裁决）

1. **取消会清掉整页标注**：`resolveHeldClick` 的取消分支调用 `clearMarks`（清空该工作页全部标注）。真机同一页面上还有三条 AMR 任务标注——当时若点"取消"，那三条会一起消失。改法是一行（取消只撤本次锚框，交给 `releaseHold` 收），但会改变既有行为，先不动。
2. ~~**held click 回执被当成"已执行"**~~ 已修，见[该项验收](20260910-held-click-not-executed.md)。held 上报 `not_executed`，账本在未实际派发时不判 satisfied。
