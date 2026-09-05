# 任务: 一只手拿住 —— 就地确认改为光标名牌双键（C 案）

> 修订关系：本文件替代 `20260904-on-page-confirm.md` 的视觉方案（框外双键作废，2026-09-05 人选 C）。0904 版的行为标准（只拦危险词、侧栏确认仍有效）由本文件继承并收紧。

来源：2026-09-05 用户在 `docs/evals/20260905-one-hand-confirm.html` 三案中选定 C：**手拿住目标，「删除 / 取消」长在光标名牌上**。本轮把就地确认从「框外双键」（20260904 版视觉，作废）改成 C，并修掉上轮人评暴露的行为层失败。

视觉权威：`docs/evals/20260905-one-hand-confirm.html` C 列。口头描述与 HTML 冲突时以 HTML 为准。

## 已探明的现状（写标准依据）

- 拦阻链路：`isDestructiveLabel`（`extension/src/shared/mark-actions.ts:36-46`）命中 → `click()` held（`extension/src/background/exec/input.ts:500-532`），存 `pendingBySession` 不发鼠标事件，自画「待确认」mark + 框外双键；held 分支**全程不动光标**。
- 双键渲染在 `cursor.ts`（`armMarkActions` 457-483），按钮发 `mark_action` 消息；放行 `resolveHeldClick`（`input.ts:374-409`）；侧栏「确认」走 `armDestructiveClick`（`background/index.ts:853`）。
- **断点 1**：模型自绘 mark+actions 时 `pendingBySession` 无记录，用户点「确认」不 arm，模型重试 click 再次被 held——要点两轮才收敛。
- **断点 2**：侧栏打「取消」无任何处理，pending 一直残留。
- **断点 3**：held/放行链路（`pendingBySession`/`armedSessions`/`resolveHeldClick`）在 vitest 里**零覆盖**，0904 版标准第 1 条的机器勾名不副实。
- 光标 `.pressing` 姿态已有但 160ms 自动摘掉（`cursor.ts:124, 762-769`）；名牌只显示实例名；`.cursor.rest .label` 透明、`.flip` 会把名牌翻到左侧。
- 光标 host 是 fixed 视口层，滚动只重锚 marks（`cursor.ts:267-269`）——拿住期间滚动会穿帮。
- 上轮人评失败根因：模型从未对危险控件发起 click（去翻站点「更多」菜单），14 次 mark 全无 actions——两条画键路径都没走到。

## 完成标准

- [x] 1. **拿住**（机器项 2026-09-05 过：overlay-check 拿住姿态+名牌双键断言；人评待）：危险 click 被 held 时，光标飞到目标上进入持久拿住态——保持按下（不弹回）、不 park、rest/flip 不藏名牌；名牌变为「删除 / 取消」双键（确认红、取消灰，按 `confirmLabelForDestructive` 文案）。视觉以 HTML C 列为准，名牌保持成员色，双键内嵌。框（mark）仍在但**框外不再画双键**。谁检查: `node extension/test/overlay-check.mjs`（拿住姿态 + 名牌双键断言）+ 人评
- [x] 2. **点一次就发生**（2026-09-05：held-clicks.test.ts 覆盖 dispatch/armOnce/cancelled）：点名牌「删除」，刚才被拦的那一下真实派发（带点击波纹，同一只手落下去）；模型自绘 mark 路径（`pendingBySession` 无记录）点「确认」必须直接 arm，模型重试 click 一次通过，不要第二轮。谁检查: `npm test`（新增 held/放行链路单测，覆盖 confirm/cancel/arm/无 pending 的 mark_action 路径）
- [x] 3. **取消收敛**（机器项过：名牌/侧栏取消同走 cancelled 分支；人评待）：点名牌「取消」或侧栏打「取消」→ 不执行、pending 清除、手松开收回、标注收起；侧栏「确认 / 是 / 继续」仍放行。谁检查: `npm test` + 人评
- [x] 4. **滚动跟随**（机器项过：overlay-check 内部容器/window/resize 三处位移断言；人评待）：拿住期间页面滚动、内部容器滚动、窗口缩放，手跟着目标走（复用 mark 的锚点重算语义）；不许光标留在原地而框跟元素走。谁检查: overlay-check.mjs 位移断言 + 人评（flomo 列表拖动）
- [x] 5. **同一目标只有一套键**（2026-09-05：键长在名牌上天然一套，overlay-check 去重断言过）：模型 mark 与执行层 held 自绘叠加时，不产生两套确认键。谁检查: `npm test` 或 overlay-check
- [x] 6. **模型行为修正**（机器项过：safety-prompt 契约测试；flomo 真机人评待）：prompt 明确——危险操作必须对当前目标直接发起 click（执行层会拿住等确认），禁止打开站点自身菜单冒充就地确认，禁止只圈不点；mark 必须圈当前目标。同步清理过时文案：`agent/src/prompt.ts:42`「outside the box」、`agent/src/tools.ts` mark description 与 held 提示语。谁检查: prompt 契约测试（`agent/test/`）+ 人评 flomo
- [x] 7. **注入失败兜底**（2026-09-05：held-clicks 单测覆盖，armOnce 不依赖页面状态）：overlay 画不出（受限页面）时，侧栏「确认」仍能放行。谁检查: `npm test`
- [x] 8. 回归（2026-09-05 校验独立复跑：357 tests / typecheck / build / overlay-check / diff-check 全绿）：`npm run typecheck` / `npm test` / `npm run build` / `node extension/test/overlay-check.mjs` / `git diff --check` 全绿。谁检查: 实现自跑 + 校验独立复跑
- [ ] 9. 人评（flomo 删「MiroFish 项目」）：看到手飞过去拿住那条笔记；点名牌「删除」，手落下去、笔记进回收站；重跑一次点「取消」，笔记还在、手松开；拿住时拖列表，手跟着走。谁检查: 人

## 边界与不做

- 复用 `mark_action` 消息，不改 `shared/protocol.ts` 结构。
- A（键在框上、手拿住）/ B（圈完退开）不采用；框外双键视觉作废。
- 不拦 `js` 直接调删除接口；不拦普通点击（既有词表单测保持）。
- 不做轨迹回放（已降级）；不动接管/交还；不动教学模式开关。
- `overlay-check.mjs` 硬编码本机路径的可移植性问题不在本轮修。
- 多成员：拿住态用成员自己的光标实例与颜色，不为确认单开新实例。
