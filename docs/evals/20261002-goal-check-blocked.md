# 任务: 网站连不上这类外部原因做不成时，助手说明后就停，不被核对反复催回去重试

[当前状态](../STATUS.md)

## 起因（10-02 评测 tiers12-20261002，GLM BYS-017）

政府网 ERR_CONNECTION_CLOSED。助手 57 s 已正确放弃并说明；目标核对（9415c84 起用过工具就核对）判 `continue: 重试打开政策页面`，宿主催续做、思考档 low→high；170 s 第二次说明后又判 continue、档位 →max；222 s 第三次说明。用户收到 3 条几乎相同的「打不开」，总耗时 224 s。这是 9415c84 扩大核对范围带来的回归：核对分不出「还没做完」与「外部原因做不成」。

## 完成标准

- [x] 1. 目标核对新增结论「受阻」：结果做不成的原因在助手和用户之外（站点连不上、页面/数据不存在、服务端拒绝），且最后回答已说明原因 → 宿主不催续做、按部分完成收尾、不升思考档 — 谁检查: 机器，真实会话 + 脚本模型复现 BYS-017 序列：只交付 1 次说明，无续做
- [x] 2. 催续做的提示附上本任务已尝试且失败的做法（工具名与失败原因摘要），要求换做法而不是重复 — 谁检查: 机器
- [x] 3. 真实快速模型探针（GLM-5.3-flash、MiniMax-M3.1，各 3 次）：BYS-017 真实输入判「受阻」；10-01 答非所问三组输入（问答已答→done；Drive 答非所问→continue；答非所问却自称做完→continue）结论不变 — 谁检查: 机器
- [x] 4. 「受阻」显示给用户的那一行用人话说明（如「网站现在连不上，稍后可以让我再试」），不出现内部字段 — 谁检查: 机器

## 边界与不做

- 不改「用过网页工具就核对」的范围。
- 不自动换搜索引擎或镜像站去绕；是否换来源由主模型自己判断。

## 实测证据

2026-10-02，工作区 main（e5c3892 之上未提交）。

### 做法

- 核对（`agent/src/goal-check.ts`）新增结论 `blocked` 与 `cause:"unreachable"|"missing"|"refused"`：原因在助手和用户之外且最后回答已说明。`blocked` 不受「在问用户→等你」「自称没做成→还差」两条改判影响；给用户看的原因由宿主按类别写（`shared/user-facing.ts` `plainBlockedReason`），不用模型原话。
- 宿主（`agent/src/session.ts` `checkGoalThenFinish`）：只有 `continue` 催续做、升档；`blocked` 照常收尾，发 `goal_check{status:"blocked",remaining:<原因>}`。任务视图 `goalStatus.status` 加 `blocked`（不并入 `open`：任务条要写「没做成」而不是「还差」），仍 `resumable`，过往任务记 partial。
- 催续做提示附本任务已失败的做法：工具报错，或打开页面但文档没加载完（`details.readiness:"timeout"`，10-02 navigate 每次都是这样「成功」返回）。每条工具名 + 原因前 120 字，遇 `<page-content` / `untrusted` 标记截断，同样做法只留一次，最多 6 条；末尾要求「Do not repeat them; take a different approach.」
- 文档：目标核对段从 `memory-and-tasks.md`（已超字符预算）拆到 [目标核对](../goal-check.md)，原处留链接；同步[使用说明](../guides/usage.md)、[协议](../protocol.md)、[架构](../architecture.md)、[任务调度](../voice-dispatch.md)、[文档导航](../README.md)。

### 标准 1、2、4：真实会话 + 脚本模型

`agent/test/goal-check-blocked.test.ts`（扩展里的会话循环 + 脚本主模型 + 脚本核对模型，事件喂真实 `TaskProgress`）复现 BYS-017：打开（文档没加载完）→ 读页（Chrome 错误页，夹一句注入）→ 请求失败 → 用 GLM 10-02 第一次说明的原话交付 partial。

| 用例 | 断言 | 新代码 | 旧代码（HEAD 的 session.ts、goal-check.ts、task-view.ts） |
|---|---|---|---|
| B1–B3 判受阻 | 主模型共 4 次调用、无 `[GOAL CHECK]`、用户只收到 1 次说明、1 次 agent_end、无 effort_change（始终 medium）；事件 `goal_check{blocked, "网站现在连不上，稍后可以让我再试"}`；任务视图 idle、resumable、`goalStatus` 为 blocked + 原因 | PASS | FAIL |
| B4 受阻回答结尾问「要我过一会儿再试吗？」 | 仍为 blocked，不改判等你/接着做，无续做 | PASS | FAIL |
| C1 先判 continue 再判 blocked | 催续提示含 `open_url — page did not finish loading` 与 `fetch_url — …Failed to fetch`，要求 different approach，不含成功的 read_page、不含页面注入；共 2 次说明、6 次主模型调用，只有被催那次升档（`goal_unfinished`） | PASS | FAIL |
| C2 8 次不同失败、最近一次错误原文 400+ 字带页面原文 | 列出 ≤6 条、最早的被挤掉、长原文截短、无页面原文 | PASS | FAIL |

标准 4 另有侧栏两行：`extension/test/task-view-ui.test.ts`（输入框上方那行 = 「没做成：网站现在连不上，稍后可以让我再试」；旧代码为「还差：…」）与 `extension/test/resume-entry.test.ts` G7（停下/结束那行同句，不含英文字段名或错误码；这一条旧代码也能过，只作守护）。

### 标准 3：真实快速模型探针

凭据取自 `~/.pi/agent/auth.json`（zai-coding-cn、minimax-cn，未打印）；走真实后台判断入口 `checkGoal → sideJudgment`，pi `ModelRuntime`。glm-5.3-flash 在目录里；MiniMax-M3.1-Flash-Preview 目录里没有，按扩展的做法从 MiniMax-M3 复制连接参数改 id。四组输入各 3 次：甲 BYS-017 原目标、goalPage 政府网 zuixin、lastReply 为 GLM 17:41:33 的原话、page 为 17:41:26 的错误页快照；乙 问答已答（「这条笔记是哪天记的？」/「这条笔记记于 2026-09-30 21:14。」）；丙 「在YouTube里面找到前两首歌。」+ Drive 上传状态；丁 同一目标 +「字幕文件已经整理好并放在下载卡片里了。」。探针脚本用完已删。

| 模型 | 取档 | 甲 → blocked | 乙 → done | 丙 → continue | 丁 → continue | 耗时 |
|---|---|---|---|---|---|---|
| glm-5.3-flash | low | 3/3（unreachable） | 3/3 | 3/3 | 3/3 | 0.8–3.5 s |
| MiniMax-M3.1-Flash-Preview | low | 3/3（unreachable） | 3/3 | 3/3 | 3/3 | 0.6–4.4 s |

所有请求 `attempts` 为 1。甲的旧结论见起因：10-02 实跑同一输入 3 次核对全判 continue。

### 机器检查

- 相关测试：`goal-check-blocked`、`goal-check`、`goal-check-files`、`main-effort-session`、`offtopic-reply-diagnostics`、`side-judgment-session`、`task-history-date-patch`、`no-progress-policy`、扩展 `resume-entry`、`task-view-ui` — 全部 PASS。
- `npm run typecheck`、`npm run lint:changed`（无新增）、`npm run check:architecture`、`npm run check:docs`（含 `--base HEAD`）— PASS。

### 未验证

- 没有在真实浏览器里重跑 BYS-017（需要站点真的连不上）；侧栏那行只在组件测试里看过，没有截图。
- 「missing」「refused」两类只有提示词与人话映射，没有真实模型探针。
- 完整 `npm run check` 与 `npm test` 全量未跑。
