# 任务: SEL-01 完整采集与局部候选分开，目标不能被截掉

## 完成标准

- [x] 1. 旧实现的 240 控件截断反例可证伪；修后目标在后半区域仍正确，其他区域无误点 — 谁检查: vitest `extension/test/decision-observation-coverage.test.ts`（手写 Region A/B，目标在 B 区 index>99；旧 `slice(0,100)` 丢失，续读后命中且仅一处 Submit）
- [x] 2. 24K 长文本截断不删除已采集控件，正文不完整标志仍准确 — 谁检查: 同上（interactive 超预算时 `axTreeToText.backendIds` 子集 ≠ `decisionControls` 全集；`textTruncated=true` 且 `controlsTruncated=false`）
- [x] 3. 同名按钮选对区域；无关计数器变化不误报 stale；来源输入变化使旧动作失效 — 谁检查: vitest coverage + `agent/test/browser-decision-context.test.ts`
- [x] 4. 标签页后续页、无语义长列表、分区摘要超预算均有真实续读路径 — 谁检查: vitest coverage（`tabsNextCursor` / `nextCursor` / `scopesNextCursor`）
- [x] 5. 超资源预算如实表达覆盖范围，不静默丢弃 — 谁检查: vitest（`MAX_COLLECTED_CONTROLS` + `collectionLimitReached` + `collectionComplete=false`）
- [ ] 6. 虚拟列表未加载内容的真实浏览器覆盖 — 谁检查: 隔离/日常浏览器 — **未跑**（AX 未出现的节点不会进 collected；无虚拟列表专用探测信号本票未加启发式）
- [ ] 7. 真实 240 控件页面 E2E / SEL-04 读回 — 谁检查: QA-01 — **未跑**

## 边界与不做

- SEL-02（Jev 先选分区/续读的串行判断）、SEL-03
- 新增 Jev/模型请求
- 真实跨站 OOPIF、snapshot subtree、waitForURL、`:has-text`（不标通过）
- 改坏 CAP-02A 事件、CAP-02B 输入、FIX-02 network-idle、上传账本
- commit / push / 重载日常 / 新建 worktree

## 契约要点（已落地）

| 维度 | 字段/行为 |
|---|---|
| 采集 | `collectedCount` / `collectionComplete` / `collectionLimitReached`；Registry 存全集（≤2500） |
| 视图 | `controls`≤100、`visibleCount` / `viewComplete` / `hasMore` / `nextCursor`；`viewScopeId` |
| 分区摘要 | `scopes`≤32、`scopesHasMore` / `scopesNextCursor` |
| 标签 | `tabs`≤64、`tabsHasMore` / `tabsNextCursor` |
| 代次 | 宿主 `generation`；续读复用采集基线；新 observationId 使旧 guard 失效 |
| 核验 | `consume` 校验视图目标，返回 collected 基线给 `browserContextChange` |
| 文本 | `decisionControls(nodes)` 不再吃 `axTreeToText.backendIds` |

## 命令与退出码

```bash
npx vitest run extension/test/decision-observation-coverage.test.ts \
  agent/test/browser-decision-context.test.ts \
  extension/test/browser-observation.test.ts \
  agent/test/browser-decision-loop.test.ts
# 退出码 0；70 passed（含本票新增）

npx vitest run extension/test/cap02c-locator.test.ts \
  agent/test/cap02a-events.test.ts \
  agent/test/cap02b-input-wiring.test.ts
# 退出码 0；23 passed
```

联合再跑上述全部：93 passed，退出码 0。

## 改动文件

- `shared/browser-decision.ts` — 覆盖字段；候选不再因 truncated 清空视图动作
- `shared/browser-decision-context.ts` — 未改逻辑（既有相关证据过滤）
- `shared/protocol.ts` — snapshot 增加可选 `cursor` / `viewScopeId`
- `extension/src/background/browser-observation.ts` — `selectObservationView` / `collectDecisionControls`；Registry 采集基线与续读
- `extension/src/background/exec/snapshot.ts` — 采集与视图分离；续读同代次
- `agent/src/browser-decision-loop.ts` — 仅散文截断/有界视图不再误 handoff
- `extension/test/decision-observation-coverage.test.ts` — 新建反例
- `agent/test/browser-decision-context.test.ts` / `agent/test/browser-decision-loop.test.ts` — 扩展

`axtree.ts` / `axstate.ts`：决策路径改为登记全部已采集 ref（经 snapshot 调用 `recordAxSnapshot`），未改 axtree 渲染预算本身。

---

# 任务: SEL-02 两条 Jev 路径共用有界选择，完整接通 hover

## 完成标准

- [x] 1. 预算内 operation+target 仍一次请求；非选中分支零动作 — 谁检查: vitest `agent/test/browser-action-selection.test.ts`（fan-out 同请求候选集）+ `browser-decision-input.test.ts` 既有 fan-out 契约；固定 decide fixture，**未调用真实 Jev**
- [x] 2. 30×12 场景填对字段、完整材料，其他字段不变，请求不超预算 — 谁检查: `browser-action-selection.test.ts` + `browser-decision-loop.test.ts`（先 `select_materials` 再 fill；写入值=宿主原文 `ORIGINAL-12-…`，候选≤256、payload≤64000；不 throw）
- [x] 3. 禁用工具不生成可执行建议；合法直接动作能力不缩水 — 谁检查: selection + loop（禁 click 无 click 候选）+ realtime judge（禁 click/hover 无 suggestion）
- [ ] 4. CSS hover-only 菜单真实展开后，从新观察选中指定项 — 谁检查: 真实浏览器 — **未跑**。单测已证明：loop 路径 hover 带 guard → 再 snapshot → 点新 menuitem；judge 返回带 guard 的 hover suggestion 且不自行执行；observation `consume` 允许 guarded hover。不改 CSS、不 JS 触发菜单。
- [x] 5. `browser_loop` 与 Realtime judge→真实工具两入口分别通过 — 谁检查: `browser-decision-loop.test.ts`（hover/30×12/continue_read）与 `realtime-browser-judge.test.ts`（guarded hover + 禁工具）；不只测共享函数

## 边界与不做

- SEL-03 继续/回退状态机
- 付费重跑真实 Jev 直到碰巧成功（本轮用固定判断器）
- 改 0.85 阈值；把置信度当权限或完成证据
- 无条件「先选区域」串行；CAP drag/upload/CDP 不全进 Jev operation
- 退回 SEL-01 截断后清空动作；虚拟列表 / 真实 240 页 E2E 仍未跑
- commit / push / 重载日常 / 新建 worktree

## 契约要点（已落地）

| 维度 | 行为 |
|---|---|
| 共享选择 | `agent/src/browser-action-selection.ts`：`selectBrowserActionCandidates`；loop 与 realtime judge 共用；不执行、不持任务状态 |
| Fan-out | 预算内保留一次请求里 operation + 各 `${op}_target`；只消费选中分支 |
| 预算 | 候选≤256、序列化 UTF-8≤64000；超额 → `continue_read` / `select_scope` / `select_materials`，不 throw |
| 材料 | 宿主保留全文；选中窗口后 fill 用原文；摘要不当正文 |
| 工具闸 | `canExecute` / `isToolActive` 过滤候选；执行器再检查；隐藏≠禁用 |
| 预算账本 | 分区/续读/材料窗口计入同一 16 次判断、24 步、90 秒 |
| hover | operation + guard；loop 悬停后强制再观察；judge 只建议；session 将 hover 列入 mutating，禁止悬停前证据直接交付 |
| 置信度 | `BROWSER_DECISION_CONFIDENCE_THRESHOLD = 0.85` 未改；保留原始概率 |

## 命令与退出码

```bash
npx vitest run agent/test/browser-action-selection.test.ts \
  agent/test/browser-decision-loop.test.ts \
  agent/test/browser-decision-context.test.ts \
  agent/test/realtime-browser-judge.test.ts \
  extension/test/decision-observation-coverage.test.ts \
  extension/test/browser-observation.test.ts
# 退出码 0；85 passed
```

真实 Jev：本轮 **未调用**（固定 decide fixture / 选择层纯函数）。这不能证明模型更准。

## 改动文件

- `shared/browser-decision.ts` — hover / continue_read / select_scope / select_materials；guard 含 hover；候选生成 hover
- `agent/src/browser-action-selection.ts` — **新建** 共用有界选择
- `agent/src/browser-decision-model.ts` — meanings 补 hover 与续读/材料窗口
- `agent/src/browser-decision-loop.ts` — 复用选择层；hover→再观察；续读/材料窗口；canExecute
- `agent/src/realtime-browser-judge.ts` — 共用选择；hover suggestion+guard；续读 needs_context
- `agent/src/realtime-browser-tools.ts` — hover 的 tabId/decisionGuard 与工具契约一致
- `extension/src/background/browser-observation.ts` — consume 允许 guarded hover
- `agent/src/session.ts` — mutating 含 hover；judge 传入 isToolActive
- `agent/src/tools.ts` — browser_loop 传入 canExecute
- 测试：`browser-action-selection.test.ts`（新）；loop / judge / observation 扩展；SEL-01 coverage/context 回归保留

---

# 任务: SEL-03 失败原因接上真实继续路径

## 完成标准

- [x] 1. no_match、低置信度、非法输出、超时分别得到正确类型和后续行为 — 谁检查: vitest `browser-decision-continue.test.ts` + `browser-decision-input.test.ts`（`none`→`no_match`；<0.85→`low_confidence`；非法 id/NaN→`invalid_decision`；Jev HTTP→`provider_error`；均零写入）
- [x] 2. 候选不足后真实续读或进入既有规划入口，不是仅换提示语 — 谁检查: continue 测试（`none`+`hasMore`→真实 `snapshot({cursor})` 再点中后区；穷尽后 `handoff`+`checkedRange`+`session_prompt`）
- [x] 3. 已成功步骤在 handoff 后只执行一次；unknown 通过新观察/委派仍保留 — 谁检查: continue（click 一次后 `unsupported_action` handoff，receipts 仅 1 条 executed；unknown→`execution_unknown`+`readonly_verify`+`preserveFacts`）
- [x] 4. 取消/接管/无权限时 fallback 不新增业务副作用 — 谁检查: continue（decide 中 abort→`cancelled` 零 click；held→`permission_required`/`permission_path`，仅一次 click 尝试且 `not_executed`）
- [x] 5. 简单直接切页不新增模型调用；Realtime 既有直接工具不缩水 — 谁检查: 既有 loop switch_tab 路径未改判断频率；`REALTIME_BROWSER_TOOL_NAMES` 仍无 `browser_loop`；direct tools 列表未删；generalBrowserLoop 开/关分别验证 Pi `browser_loop` 挂载与 Realtime `task_action`/`browser_request` 推荐
- [ ] 6. 真实浏览器 / QA-01 — **未跑**（本票禁止整份 QA-01）
- [ ] 7. 真实 Jev — **未调用**（固定 decide / fetch fixture）

## 边界与不做

- 新建持久任务状态机或全局 Router
- 改 0.85 阈值；把置信度当权限或完成证据
- 控制逻辑解析中文 `reason` 字符串
- 付费真实 Jev；整份 QA-01 浏览器验收
- commit / push / 重载日常 / 新建 worktree

## reasonCode（已落地）

| code | 含义 | 继续 |
|---|---|---|
| `observation_incomplete` | 观察窗/采集不完整 | 预算内续读；否则交回 |
| `candidate_budget` | 候选/调用预算 | 有界窗口或 planner 工具 |
| `no_match` | Jev `none` 或穷尽后无匹配 | 未检范围续读/换区；保存 `checkedRange` |
| `low_confidence` | <0.85 | 同 no_match 扩窗；否则交回 |
| `invalid_decision` | 非法 id / NaN / 缺字段 | **绝不执行** |
| `unsupported_action` | 快路径/Jev op 不够 | 回 Pi/`task_action`/`browser_request`（已挂载的） |
| `stale_observation` | 观察代次失效 | 重新观察；保留未执行事实 |
| `permission_required` | held/确认/接管 | 原确认路径 |
| `execution_unknown` | 写入未知 | 账本保留；只读核验 |
| `provider_error` | Jev/服务失败 | 有界降级；不写成网页找不到 |

## 三条入口继续方式

1. **Pi 初始循环** `runInitialBrowserLoop` → 同会话 `session.prompt(原话 + outcome JSON)`；`reasonCode`/`continue` 写入 handoff，不另开会话。
2. **Pi 主动 `browser_loop`** → 工具 JSON 含 `reasonCode`/`continue`/`receipts`；回原委派/规划工具；成功步骤与 unknown 留在 receipts。
3. **Realtime judge** → `continue.tools` 只列实际挂载项（直连 `snapshot`/`judge_browser_action` 等；委派 `task_action` 或 `browser_request`）；**从不**推荐 `browser_loop`。

## 命令与退出码

```bash
npx vitest run agent/test/browser-action-selection.test.ts \
  agent/test/browser-decision-loop.test.ts \
  agent/test/realtime-browser-judge.test.ts \
  agent/test/browser-loop-tool.test.ts \
  agent/test/browser-loop-direct-delivery.test.ts \
  agent/test/browser-decision-continue.test.ts \
  agent/test/browser-decision-input.test.ts
# 退出码 0；91 passed（含 SEL-03 新建反例；SEL-01/02 断言保留）

npx vitest run agent/test/realtime-direct-tools.test.ts
# 退出码 1；47 passed / 1 failed
# 失败：`unknown fill refuses unverifiable original object: css`
# 期望 original_node_identity_missing，实得 original_field_identity_missing
# 与本票 reasonCode/继续路径无关（未改 fill readback）；登记不冒充通过
```

真实浏览器 / 真实 Jev：**未跑**。

## 改动文件

- `shared/browser-decision.ts` — `BrowserDecisionReasonCode` / `BrowserContinueHint`；outcome 增字段
- `agent/src/browser-action-selection.ts` — `resolveBrowserDecision`、扩窗、`piContinueHint`/`realtimeContinueHint`
- `agent/src/browser-decision-model.ts` — Jev `none` 返回 typed decision
- `agent/src/browser-decision-loop.ts` — reasonCode；无匹配时真实续读；分类 finish
- `agent/src/realtime-browser-judge.ts` — reasonCode + 按挂载推荐继续工具
- `agent/src/session.ts` — 初始 handoff 带 reasonCode；judge 传入 continueMount
- 测试：`browser-decision-continue.test.ts`（新）；`browser-decision-input.test.ts` 补 none
