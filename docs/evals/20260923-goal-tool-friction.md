# 任务: 「把代号填成星河，不要保存」这类任务不再因目标工具的两处提示多绕模型轮次

## 背景与裁决

- 依据：[第一条真实路径样板用例](20260923-real-path-first-case.md)「发现但未处理」。修复前 4 次有效运行：目标方案被拒 2 次，都是 field 目标没有配套的 material 目标，报错却笼统列出所有规则，其中两条模型已经做到，只能靠猜；核验漏 `tabId` 3/3 次，每次多一轮。
- 2026-09-23 用户：下一步「按你建议来」，建议即先修这两处，并用样板用例量化前后变化。
- 用户入口不变：侧栏发任务，伴随进程里的模型调用 `task_goals`。可见变化只在模型拿到的报错文字和参数说明；接受/拒绝的规则不变。
- 不做：核验时替模型默认选页。读哪一页由调用方指定是原有设计，默认值会改变核验语义。

## 失败方式（先写，再改代码）

1. 修复前被拒的真实方案（field 引用了不存在的 material）拿到的报错里仍然没有这个目标的 id 和 materialId，也没说改用 condition。
2. 原来能通过的方案被误拒：只有 condition 的方案；material + field 引用同一 materialId 的方案。
3. 原来会被拒的方案被放过：遗漏某项用户要求；引用了不存在的要求编号（如 `1`）；material 目标 materialId 重复；material 缺 materialId；某目标 requirements 为空；description 超过 160 字。
4. 新报错把几个原因混在一起，或给出的编号不是这次真正出错的那个。
5. 参数说明改了但模型仍然先漏 `tabId`（样板用例里 verifyNoTab 仍 > 0）。
6. 改动让样板用例本身失败（页面结果、没保存、无错误提示任何一条不满足）。

## 完成标准

- [x] 1. 用修复前样板运行里记录的真实 plan 参数（`2026-09-23T02-53-09-234Z`、`03-04-22-669Z` 的被拒方案和 `03-04-22-669Z` 的通过方案）逐一回放 `TaskGoalBook.install`：被拒方案仍被拒，报错点名目标 id、materialId，并提示用户给的值改用 condition；通过方案仍通过。— 谁检查: 回放脚本（输出贴在结果里）
- [x] 2. 失败方式 2、3 列出的每种方案，接受/拒绝结果与修改前一致，拒绝时报错写出的是那一条真实原因。— 谁检查: 同一回放脚本，修改前后各跑一次对比
- [x] 3. 样板用例修改后连续跑 3 次全部通过；3 次合计「核验缺少 tabId」为 0（修改前 3/3）；若出现目标方案被拒，下一次 plan 即被接受。— 谁检查: 样板脚本 + 对话记录统计
- [x] 4. `npm run typecheck` 通过；`task-goals`、`task-goal-tool` 相关现有测试结果与修改前一致。— 谁检查: npm

## 边界与不做

- 不改接受/拒绝规则，不改工具总说明，不默认 tabId。
- 3 次真模型运行样本小，只能说明方向，不能当作稳定比例。

## 结果

2026-09-23：4 条满足。改动：`agent/src/task-goals.ts` `assertCoverage` 按真实违反项分别报错（接受/拒绝条件原样保留）；`agent/src/task-goal-tool.ts` 给 `tabId` 参数加说明「condition/field 核验必填」。

1. 回放（`out/acceptance/real-path/2026-09-23-goal-plan-replay/`，含脚本和修改前后输出）：3 个录制的被拒方案仍被拒，报错改为「field 目标 fill-codename 引用的 materialId「codename-value」在本方案里没有同编号的 material 来源目标；…改用 kind=condition」；录制的通过方案仍接受。重跑：把 `goal-plan-replay.mts` 复制成 `agent/.tmp-goal-replay.mts`，在 `agent/` 下 `npx tsx .tmp-goal-replay.mts`。
2. 同一回放的 8 个构造方案，接受/拒绝与修改前逐行一致（diff 相同）；拒绝原因分别为遗漏 requirement-2、不认识编号 1、materialId 重复、缺 materialId、格式不符（requirements 为空、description 超长两例共用格式提示）。
3. 修改后样板用例 3/3 通过：

| 运行 | 用时 | 模型轮数 | 方案被拒 | 核验漏 tabId |
| --- | --- | --- | --- | --- |
| `2026-09-23T03-20-48-765Z` | 35.1s | 5 | 0 | 0 |
| `2026-09-23T03-21-32-861Z` | 96.6s | 8 | 0 | 0 |
| `2026-09-23T03-23-18-426Z` | 73.2s | 9 | 1，下一次 plan 即接受 | 0 |

   修改前 3 次：核验漏 tabId 3/3；修改后 0/3。其余工具报错是模型猜了练习页不存在的 `input[aria-label="代号"]`，重新 snapshot 后恢复，与本改动无关。用时波动大（35–97s），样本小，不据此下提速结论。
4. `npm run typecheck` 通过；task_goals 相关 142 项中 141 通过，唯一失败 `agent/test/task-goals.test.ts:172` 在修改前已存在（见[样板用例结果](20260923-real-path-first-case.md#结果)第 8 条）；lint 在两个文件无违规。
