# AG-DELIVERY-01 实施报告（Anti Gravity）

## 1. 任务与目标

按照 `docs/tasks/GROK-DELIVERY-01-contract.md` 分工与冻结标准 `docs/evals/20260909-explicit-user-delivery.md`：
- **正式气泡按 id 只显示一次**：`user_delivery` 渲染到现有助手答复位置（`.msg.assistant`），按 `delivery.id` 去重；状态更新（`composed` → `speaking` → `played`）以及重复交付事件在已有 DOM 上更新状态属性，不产生重复气泡。
- **执行过程分层**：新 Lead 运行在 `agent_start` 携带 `deliveryMode: 'explicit'` 时，内部生成的 `text_delta` 汇入执行过程折叠块（`details.run-steps` / `details.thinking`），不直接冒充助手正式答复。
- **旧历史兼容**：回放旧历史（无 `deliveryMode: 'explicit'` 标记）时，仍保留原有 `text_delta` 渲染为助手气泡的行为，旧历史正常可见。
- **语音面板消费**：`voice-ui.ts` 的 `voice-answer` 通过 `deliver(delivery)` 消费同一正文，不自行润色，并防迟到 `ack` 覆盖 `finding` 或 `reply`。
- **历史记录去重与单调性**：`PanelHistory.record` 对相同 `id` 和 `conversationId` 的 `user_delivery` 就地更新状态，仅状态单调前进（`composed` → `speaking` → `played`）并严格保留原正文，防历史回放或篡改。

---

## 2. 缺陷修复（Boss 验收退回项）

- **问题现象**：Boss 生产 UI 验收脚本 `user-delivery-ui-run.mts` 末项报错：先 D1 finding，再 D2 reply，后续 D1 played 状态更新到达时，`voice-answer` 被错误换回 D1。
- **根因分析**：`main.ts` 中的 `handleUserDelivery` 在检查 `existing` 缓存前无条件调用了 `voiceUI.deliver(delivery)`，导致旧交付的状态更新事件误将正文再次推送给语音区，冲掉了更新的 D2。
- **修复方案**：
  1. `main.ts`：将 `existing` 缓存判断置于最前；已有 `delivery.id` 的事件仅执行单调状态更新（`DELIVERY_STATUS_RANK`），绝不调用 `voiceUI.deliver`，不替换正文或语音，严格保持最新 D2。
  2. `panel-history.ts`：增加 `DELIVERY_STATUS_RANK` 严格单调守卫（`newRank > oldRank`），且更新时始终保留 `old.text` 及原标识，杜绝旧 `composed` 倒退或改文篡改已登记交付。
  3. `user-delivery-ui.test.ts`：补齐针对“D1 → D2 → D1 played 保持 D2 语音正文”及“历史记录状态单调前进且原正文不可篡改”的独立单测。

---

## 3. 实际改动文件清单

| 文件 | 变更说明 |
|---|---|
| `extension/src/background/panel-history.ts` | 增加 `userDelivery` 提取函数与 `DELIVERY_STATUS_RANK`；在 `record()` 中按 `delivery.id` 与 `conversationId` 索引已存在条目，仅在状态单调前进时更新状态并严格保留原正文，不产生重复 seq，保证历史日志仅留一条最新状态。 |
| `extension/src/sidepanel/main.ts` | 1. 引入 `UserDelivery` 类型与 `DELIVERY_STATUS_RANK`；<br>2. 维护 `deliveredBubbles` Map（按 `delivery.id` 记录已渲染气泡）；<br>3. `handleUserDelivery` 先检查 `existing`，已有 id 仅单调更新状态属性并立即返回，绝不再次替换正文/语音；首次交付才消费到语音面板并渲染正式气泡；<br>4. 在 `text_delta` 分支实现 `leadDeliveryMode === 'explicit'` 汇入 `appendLeadDelta` 执行过程，无标记时走旧有 `appendDelta`；<br>5. `resetConversationRender` 统一清空 `deliveredBubbles` 与重置模式。 |
| `extension/src/sidepanel/voice-ui.ts` | 导出 `deliver(delivery)` 方法，将交付正文直出赋给 `.voice-answer`（`transcript.textContent = delivery.text`），防迟到 ack 覆盖 finding/reply，新 turn 重置。 |
| `extension/test/user-delivery-ui.test.ts` | 新增自有聚焦自测（12 项测试）：覆盖 PanelHistory 去重/状态单调前进/原正文不可篡改/跨会话隔离/历史恢复；VoiceUI deliver 消费与防迟到 ack；DOM 气泡按 id 一次渲染与显式/旧历史模式分支；状态更新不调用 voiceUI.deliver 保持最新语音回答。 |

---

## 4. 自测与检查结果

- **模块类型检查**：
  `npm run typecheck -w @sideagent/extension` → **0 errors（全部通过）**。
- **归属聚焦自测**：
  `npx vitest run extension/test/user-delivery-ui.test.ts extension/test/panel-history.test.ts extension/test/voice-auto-recovery.test.ts extension/test/voice-audio.test.ts extension/test/voice-relay.test.ts extension/test/voice-recovery-evaluator.test.ts`
  - `extension/test/user-delivery-ui.test.ts` (12/12 PASS)
  - `extension/test/panel-history.test.ts` (9/9 PASS)
  - `extension/test/voice-recovery-evaluator.test.ts` (7/7 PASS)
  - `extension/test/voice-audio.test.ts` (5/5 PASS)
  - `extension/test/voice-relay.test.ts` (3/3 PASS)
  - `extension/test/voice-auto-recovery.test.ts` (11/11 PASS)
  - **总计：6 测试文件，47 项测试全部 PASS**。

---

## 5. 延迟代价与模型调用评估

- **新增模型调用**：**0 次**（UI 层纯响应式数据驱动与 DOM 映射）。
- **回答延迟影响**：
  - `user_delivery` 事件到达时直接使用同步 marked 消毒渲染，无额外网络往返。
  - `text_delta` 在 `deliveryMode: 'explicit'` 期间流式写入 `run-steps` 内 pre 节点，避免无谓的顶层 Markdown 频繁全量 re-parse，DOM 重绘耗时微幅降低。
  - `voice-answer` 直接复用 `delivery.text` 文本直写，状态更新在现有缓存命中时 O(1) 立即返回，0 额外延迟。

---

## 6. 遵守协议与边界

- 严格遵守文件归属，未触碰 `shared/`、`agent/src/`、`docs/evals/` 或 Boss evaluator 测试。
- 未改动 CSS 样式文件（`styles.css` 保持不动）。
- 未执行全量测试、未执行 `npm run build`、未重载用户扩展、未操作用户浏览器。
- 保持停笔。
