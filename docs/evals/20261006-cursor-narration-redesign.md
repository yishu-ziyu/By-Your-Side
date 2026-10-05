# 任务：光标旁一句白底的话，右上角只管停下

[#43](https://github.com/yishu-ziyu/By-Your-Side/issues/43) · 设计稿：Claude Design 画板「#43 光标旁白」方向 A，气泡用方向 B（用户 2026-10-06 选定）

## 规则

- R1 助手操作页面时，光标右下挂一句白底轻卡：左边一颗小光球，墨色 13px 常规字，如「我在填出发日期」「我在点「查询车票」」；只随光标平移，碰到右、下边缘才整体换边，不左右跳。
  - 正：真实模型填表、点按钮，旁白依次是填、填、填好了、点、点好了，与动作一致，每次只有一句。机器检查：`scripts/probes/design-check/43/cursor-narration.mts --headless`（gpt-6-luna）。
  - 反：旁白挡住要点的地方、减少动态效果时仍有动画。机器检查：同上（`pointer-events:none`；模拟减少动态效果）。
- R2 页面上只留一道淡光晕和一条墨蓝细描边；右上角胶囊只有小光球、By Your Side 和「停下」，不再重复「正在点击」。
  - 正：助手在点时，右上角文字为「By Your Side 停下」。机器检查：`scripts/probes/cursor-narration/page-stop.mts --headless`。
- R3 点页面右上角「停下」与侧栏「我来」走同一条路：侧栏进入「已暂停 · 页面归你」，助手不再点，页面右上角换成「现在归你 · 你继续」同款胶囊。只有一位助手时不显示人数和头像。
  - 正：点「停下」1 秒内暂停，之后 4 秒点击次数不变。机器检查：同上。
  - 反：「我来 / 你继续」原有行为变化。机器检查：`scripts/acceptance/real-path/takeover-handback.mts --headless`。

## 还没答上的问题

无。

## 技术前提

- 前提：后台已有「我来」的接管路径（`handleTakeover` + `requestPanelControl("pause")`），页面按钮只需找到正在操作这一页的会话。结果：通过（R3 实测）。

## 边界与不做

- 「我来 / 你继续 / 现在归你」沿用产品既有说法，不改成设计稿的「你在操作 · 继续」。
- Agent 光标保留墨蓝箭头（不用设计稿的黑箭头），和用户自己的黑色系统光标分得开。
- 不加「按 Esc 让我停下」（方向 B 的提示），右上角「停下」已常驻。

## 证据

2026-10-06：
- `cursor-narration.mts`（gpt-6-luna，正常与减少动态效果各一轮）：两轮都填完并查询；R1–R4 通过，旁白顺序「我在填出发日期 → 我在填乘客姓名 → 填好了 → 我在点「查询车票」 → 点好了」。截图 `out/design-check/43/normal-02-7360ms.png`、`normal-05-7991ms-zoom.png` 人工看过。
- `page-stop.mts`：胶囊文字「By Your Side 停下」；点后 258 ms 暂停，之后 4 秒 0 次点击；页面条「现在归你 你继续」，位于右上角。截图 `out/probes/cursor-narration/{acting,paused}.png`。
- `takeover-handback.mts` 12/12 通过（改样式后）。
- 删去 `extension/test/cursor-label.test.ts`：它断言的「名牌避开目标」正是这次有意改掉的旧行为，位置改由真实页面探针看。
- `npm run typecheck`、`npm run build` 通过。用户自己的鼠标与 Agent 光标是否分得清，需真人看。
