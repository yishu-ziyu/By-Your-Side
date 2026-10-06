# 任务: 输入框是一个圆角框，框里最多一行工具；接管 / 交还用行业通用的名字

来源：用户 2026-10-06 嫌运行中的输入框「元素乱七八糟」，给了 Claude for Chrome、ChatGPT Atlas、Cursor、Comet、Gemini in Chrome、Operator 的对照（与 Grokbot 整理）；认可预览 `out/design-check/composer/preview.html`，选定「停止键一直在，打字时左边多一个发送」。又指出「我来」看不懂、应参考世界级产品：ChatGPT agent「Take over browser」、Crewly「Take control / Give control back」、FreeClaw「Take control / Hand back」，定为「接管 / 交还」。

## 规则
- R1 框里一行：＋、话筒、（运行中）接管、（运行中有字）发送、发送或停止。没有 ···、没有语音光球胶囊、页面标签后没有绿点。
  - 例子(正)：空闲时一行是 ＋ / 话筒 / 发送 — 谁检查：`scripts/probes/shell/composer-quiet.mts`
- R2 运行中不换颜色、不加提示区：框不变琥珀色，没有「写到一半也能改方向」和建议按钮；停止键是黑色圆；占位是「补充或改方向…」。
  - 例子(反)：运行中出现红棕色停止键或琥珀描边 — 谁检查：同上
- R3 运行中打字：停止键还在，左边多一个发送键；点它发出插话，输入框清空，发送键收起。
  - 例子(正)：打「只看按钮那一类」→ ↑ 和 ■ 并排 — 谁检查：同上；`ghost-hud-and-steering.mts` 改方向 38 ms 内开写
- R4 ＋ 菜单 = 截图 / 选取 / 上传 + 边注三项 + 语音诊断；接管、交还取代「我来」「你继续」。
  - 例子(正)：点「接管」后同一位置变成「交还」 — 谁检查：同上；`takeover-handback.mts`、`page-stop.mts`
- R5 好不好看由用户在真实扩展里裁决 — 谁检查：人

## 还没答上的问题
- 无。

## 技术前提
- 前提：只改侧栏标记与样式，停止仍走原来的 `#send-btn.stopping`；插话发送复用 `sendInput()`。小实验：无需（读 `main.ts` 的 `setSessionState`、`sendBtn.onclick`）。结果：通过

## 边界与不做
- 不取真网站图标，不改 ＋ 菜单里截图、上传的行为。
- 改方向回答上的「⚡ 已改方向」标记保留文字，只改成灰色。

## 证据
- `composer-quiet.mts` 8/8；截图 `out/probes/shell/composer-{idle,plus,running,typing,held}.png`。
- 改写的验收：`quiet-shell.mts`（边注从 ＋ 菜单切换）、`chrome-quiet.mts`（去掉 `#composer-more`）、`ghost-hud-and-steering.mts`（改方向从点建议按钮改成在输入框里说）、`takeover-handback.mts` 与 `page-stop.mts` 和三条单测（按钮名）。全部通过：takeover-handback 0 失败、chrome-quiet 0 失败、ghost-hud-and-steering 全过、sidebar-interaction 29/29、page-stop 暂停后 0 次点击。
- 扩展单测 927/927；其中 `voice-diagnostic.test.ts` 按 [语音验收](20261006-voice-states-redesign.md) R1 改成「在听 / 在想 / 在说」（原先失败，测试没跟上语音改版）。
- 未跑：`extension/test/overlay-check.mjs`（本机缺 Playwright 的 Chromium，只改了其中按钮名）。
- 2026-10-06 修订：框的材质改回暖灰凹槽 + 顶边高光（用户看过「纯白平面 / 暖灰凹槽 / 纸面浮起」三张真侧栏截图后选定），布局与按钮不变；`composer-quiet.mts` 仍全过。
