# 任务: 用户说「圈出 X 给我看」，圈完后 agent 凭宿主读到的标注判完成，不再空转到超时

## 背景

`mark-motion-toggle` 真实路径用例在 13:11 之后连续失败（240 秒超时，侧栏卡在「正在读回多个元素」）。清理文档当时把原因记为「未查明」，怀疑是动效默认值收进共享模块那次重构。

复查 `out/acceptance/real-path/2026-09-23T05-34-49-556Z-mark-motion-toggle/data/traces/*.jsonl` 后结论如下：

- 标注早就画好了：第 3 轮 `mark @24` 返回 `Marked @24.`。
- 之后 4 轮，模型用 `read_elements` 换着选择器找标注（`[class*="mark"]`、`svg`、`canvas`……），全部 0 命中；又试 `js`，没有启用。每轮 30–50 秒，最后撞上超时。
- 标注画在封闭的 shadow root 里（`extension/src/content/cursor.ts` 的 `marksShadow`），页面选择器、`read_elements` 和 `task_goals verify` 的整页读取都看不到。复核（Jev，condition 门槛 0.9）手里只有执行记录里的「mark 成功」，而规则写明回执不算证据，于是结论在门槛上下摇摆。04:21、04:48 两次通过是复核判得松；05:22、05:28、05:34 三次失败是判得严。
- 13:11 的重构改了 4 个文件，语义都没变；同一时段改过的源码只有它和 13:03 的语音读表单修复（只有 `voice-relay` 用）。所以不是那次重构的问题，而是完成判定本身缺证据。

用户裁决（2026-09-23）：采用「宿主自己读标注层当证据」，不改成「画完问用户看到没有」。

## 完成标准

- [x] 1. `mark-motion-toggle` 真实路径连续 3 次通过。— 谁检查: 用例脚本（`…05-59-19-033Z`、`…06-01-10-949Z`、`…06-02-44-029Z`，另加一次 `…06-05-40-567Z`，均全 yes）
- [x] 2. 判完成的依据是宿主读到的标注，不是模型拿回执自证。— 谁检查: 人读轨迹（`…06-05-40-567Z-mark-motion-toggle/data/traces/`：`mark` 之后直接 `verify`，复核理由写「hostDrawnMarks 显示「取消」按钮已标注 shown=true……无点击操作」；两句分别 85 秒、46 秒完成）
- [x] 3. `typecheck`、`check:architecture` 通过；vitest 无新失败、无加载失败。— 谁检查: `npm run typecheck`、`npm run check:architecture`（232 个生产文件）、vitest 2,989 项失败 2 项，与 `out/cleanup/p6-vitest.json` 基线相同（`out/mark-evidence/vitest.json`）

## 改动

- `extension/src/content/cursor.ts`：新增只读的 `window.__sideagent.marksState()`，列出每个标注此刻圈住的元素（标签名、可读名字）以及是否显示。它在内容脚本的隔离环境里，页面脚本读不到也写不了。
- `extension/src/background/exec/snapshot.ts`：`snapshot` 读完页面后，照翻译显示状态的写法在隔离环境读 `marksState()`，有标注时附上 `marks` 字段。类型在 `shared/host-marks.ts`，协议 `shared/protocol.ts` 同步。
- `agent/src/goal-evidence-judge.ts`：condition 复核的 state 带上 `hostDrawnMarks`；说明里写明它的来源，以及只有「请求的元素上 shown=true」才算证明。
- `agent/src/task-goal-tool.ts`：工具说明加一句，提示标注在私有层里，圈完直接 verify，不要去 DOM 里找。
- `scripts/acceptance/real-path/mark-motion-toggle.mts`：数据目录（会话与轨迹）改为成败都保存，用来复查完成依据。

## 反例与残留

- 反例：修复前 3 次失败，就是复核看不到标注时的表现（不给过、继续找）。这次没有另外构造「没圈却判完成」的用例，所以复核会不会把别的元素上的标注误认成目标，只靠说明里的规则约束。
- 残留：Jev 对这两句的概率是 0.89 和 0.84，没到 0.9，每次升级给主模型复核（`reviewedBy: main`），多花 7–11 秒，侧栏会闪一次「正在独立复核」。Jev 文档注明中文准确率偏低，这和观察一致。门槛这次不动。

## 边界与不做

- 不改复核门槛，不改标注的画法和动效。
- 不做「画完问用户看到没有」。
- 日常 `extension/dist` 没有重建（会清空日常 Chrome 正在加载的目录），等用户决定。
