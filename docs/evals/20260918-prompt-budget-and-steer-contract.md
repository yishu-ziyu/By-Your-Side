# 任务: 上调提示词预算并给插话回退路径补上「原任务仍欠交付」契约

日期：2026-09-18。基线：`867f60b` + 本地未提交的五项 review 修复。两项改动的根因定位见
`docs/evals/20260918-jev-display-review-fixes.md` 尾部结论与本次会话分析：
① 预算自 09-16 起只剩 2 字符余量，`089d920` 的 P0 `confirm_blocked_write` 指引 +170 越线至 15168；
② Jev 关闭臂的回退插话以裸文本注入，旧计划取消话术又把模型重定向到最新输入，交付闸门只验证
最新要求的读回，run 在首个交付后结束——三层都不携带「修改是补充，原任务答案仍欠着」。

用户裁决（2026-09-18）：预算上调（不压缩提示词、不降标准）；契约位置由本次实现判断——放在
注入文本（`session.steer` 载荷），执行闸门报错同步补一句；不在交付闸门/run 结束判定加语义判断。

## 完成标准

- [ ] 1. `npm run check` 退出 0（此前唯一失败为 SYSTEM_PROMPT 15168 > 旧门槛 15000）— 检查者：npm run check
- [ ] 2. 回退插话的模型载荷包含契约、原用户文本与页面上下文；Pi 回显整条载荷后销账仍精确匹配；用户面回执不含契约文本 — 检查者：npx vitest agent/test/continuous-steering.test.ts（真实 Pi 队列 + 合成会话）
- [ ] 3. 真实逐臂隔离配对（最终脚本形态）：关闭臂 paragraphCount/summary=true 且无重复执行/重译，开启臂不回归 — 检查者：scripts/acceptance/jev-display-steering.mts --headless

## 边界与不做

- 不改 SYSTEM_PROMPT 正文、不动 Jev 提示词/阈值/模型；`displaySteerFastPath` 保持未设置/关闭。
- 不重载日常扩展；不提交、不推送。验收用隔离浏览器与本地模型池。
- 预算新值 16,000（当前 15168，留约 800 头部空间），仍是有界约束；后续加提示词仍需在此预算内仲裁。
- 若注入契约实测仍不足以让关闭臂交还原任务答案，本文件记录失败证据后再评估交付闸门方案，不放宽验收器。

## 实施记录

- 预算：`agent/test/tool-surface.test.ts` 门槛 15,000 → 16,000（SYSTEM_PROMPT 未动，当前 15168）。注释写明上调依据与“继续加内容需在预算内仲裁”。
- 契约：`agent/src/session.ts` 新增导出 `STEER_CONTRACT_NOTE`（插话是补充/修改而非替换；除非用户明确取消，先满足这条要求，再继续完成并交付原任务未交付结果），附在回退路径 `session.steer` 载荷尾部；`record.input` 与载荷完全一致，保证 `consumeCorrection` 精确销账；契约不进任何用户面回执。`agent/src/tools.ts` 两处执行闸门报错同步补「原任务尚未交付的结果仍需完成」。
- 测试：`continuous-steering.test.ts` 真实 Pi 队列断言每条插话载荷携带契约；新增合成专项（载荷含用户文本/页面上下文/契约，Pi 原样回显后销账放行，契约不进用户面事件）；`session-helpers` / `voice-listen-back` / `harness-s2-execution-evaluator` 同步更新载荷/回显断言（S2 增补：只回显裸文本不算消费，不给写入放行）。
- 验收脚本效率分层（用户要求）：`scripts/acceptance/jev-display-steering.mts` 新增 `--pairs N`（1..10）与 `--skip-boundaries`；`results.scope` 记录部分范围，`results.passed` 仅限全量 10 对+6 边界；`display-steering-oracle` 退出码新增显式 `pairsExpected`（默认仍 10，正式门槛不变），配套 4 条单测。

## 证据

- [x] 1. `npm run check` 退出 0：215 文件 2056 项 + 规模 2 项全部通过，边界/类型/构建通过 —— 同目录 `contract-check.log`（一次环境波动导致的 5 秒超时重跑后全绿，波动另见 `check.log` 历史，不计数）。
- [x] 2. 定点 61/61（4 文件）与验收器 14/14 通过；全量 check 内含上述全部断言。
- [x] 3. 全量真实逐臂隔离配对 `out/acceptance/jev-display-steering-1789734088114/`：**关闭臂 10/10 交付原任务段落数与概括**（修复前 3/10，`paragraphCount/summary` 全 true，无重复执行/无重译）；开启臂 10/10 无回归；6 边界 0 失败。**但整跑退出 1、`passed=false`**：pair-0 关闭臂模型擅自把仅译文切成双语（字体与原任务答案都对，`page:false` 判得正确）——基线模型偶发越改显示参数，非本次契约引入，保持未处理。控制台日志 `contract-pairs.log`。
- 快速回路演示：`--smoke` 重跑 2.5 分钟两臂 `match:true, answer:true` 退出 0，`contract-smoke-fast.log`，目录 `out/acceptance/jev-display-steering-1789737560860/`（部分范围，`passed:false` 为预期）。

## 结论

两项既定完成标准达成；「完整产品验收通过」仍未宣称：全量配对退出 1（关闭臂偶发越改显示模式），真人语音、发布门槛均不在本轮。改动保持本地未提交；`displaySteerFastPath` 仍关闭；日常扩展未重载。
