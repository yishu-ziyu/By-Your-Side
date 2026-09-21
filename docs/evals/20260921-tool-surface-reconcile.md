# 工具面检查补正：合成清单 → 真实 BrowserAgentSession active 清单

日期 2026-09-21。对象：`agent/test/tool-surface.test.ts`。起因：`docs/evals/20260921-resume-independent-review.md` 第 3 节独立发现——原 `leadSurface()` 是手工拼接的合成清单，不是真实会话的 active 工具表，漏计 `take_tab`、`task_goals`、`capture_page_material`、`confirm_blocked_write`，`browser_loop` 也未建模，因此「无 worker 不超过 23」从未约束真实工具面。本轮只补正检查，不改产品工具或功能。

## 验收四行

- 目标：工具面检查反映真实 BrowserAgentSession 注册与 active 清单，覆盖无 worker / 有 worker、generalBrowserLoop 开关，不再漏算真实工具。
- 检查：定点 vitest（命令见下）+ 从真实装配生成的双向完整性断言 + 实测基线。
- 证据：本文档；`agent/test/tool-surface.test.ts`；真实清单见第 3 节。
- 边界：未改产品行为（本轮未动 `agent/src/**`、`extension/**`、`shared/**`）；未构建、未加载 host / 扩展、未重启、未调用模型；未提交、未 stash、未清理工作树中的并发未提交改动；只改了本测试与本文档。

## 1. 检查怎么补的

### 1.1 旧合成预算保留并改名

`leadSurface()` → `componentSurface()`，describe 改为「合成组件范围预算（非真实会话清单）」。它只拼接组件工厂（浏览器 + 账本/交付/记忆 + 团队），不含 session.ts 挂载的 Lead 专属工具，仍然只守组件级 23/29 上限；注释明确指向下方真实清单用例。没有借这次改动收紧或删除任何工具。

### 1.2 新增真实清单用例

`describe("真实会话 active 清单（BrowserAgentSession 注册）")` 两个用例（`browser_loop` 关 / 开）：

- 用生产装配路径 `createConversationRuntime("default", …, { memoryStore })` 在进程内构造真实会话，读取 `session.getActiveToolNames()`（不是手工清单）。
- 无 worker 为会话初始状态；有 worker 调用生产同一回调 `fleet.onMembersChange?.(1)`（`conversation-runtime.ts` 把它接到 `setTeamToolsMounted`），不新增挂载代码。
- `generalBrowserLoop` 用 `SIDEAGENT_GENERAL_BROWSER_LOOP=0/1` 显式控制，不受本机 `~/.sideagent/config.json` 影响；`afterAll` 恢复原值并清理临时 MemoryStore 目录。
- 每个场景四组断言：双向完整性（见 1.3）+ 真实数量基线 + 真实清单基线。

### 1.3 完整性断言（防漏算）

`sourceInventory(loopEnabled, workerMounted)` 按生产装配调用同一批工厂：`createBrowserTools`（含 `browser_loop` 开关与执行接线）、`session.ts` 的 Lead 专属六件（`capture_page_material` / `task_goals` / `record_task_results` / `resolve_unknown_result` / `confirm_blocked_write` / `send_user_message`）、`MemoryRuntime.tools()`、`createFleetTools(fleet, LEAD_SESSION_ID)`，再按无 worker 规则去掉 `TEAM_COORDINATION_TOOLS` 与 `page_operation`。断言双向：

- `inventory − active` 必须为空（真实清单漏挂来源工具）；
- `active − inventory` 必须为空（真实清单出现来源未覆盖的工具，即新工具未纳入检查）。

任一侧新增工具都会点名具体工具失败，不会再出现「合成清单漏掉工具却仍算通过」。

## 2. 真实数量基线（实测）

| generalBrowserLoop | 无 worker | 有 worker |
| --- | --- | --- |
| 关（`SIDEAGENT_GENERAL_BROWSER_LOOP=0`） | 27 | 32 |
| 开（`SIDEAGENT_GENERAL_BROWSER_LOOP=1`） | 28 | 33 |

基线以精确清单写进测试（`REAL_SURFACE_BASELINE`），不再沿用 23/29 上限。原合成清单相比真实无 worker 清单少的 4 个：`take_tab`、`task_goals`、`capture_page_material`、`confirm_blocked_write`；`browser_loop` 只由开关决定。

## 3. 真实 active 清单原文

命令：`npx vitest run agent/test/tool-surface.test.ts --reporter=verbose`（用例内部即真实构造，输出为断言基线）。

```text
browser_loop 关 · 无 worker（27）
["browser_run","capture_page_material","click","confirm_blocked_write","fetch","fill","hover","js","mark","navigate","network","page_translation","press_key","read_element","read_elements","record_task_results","resolve_unknown_result","screenshot","scroll","send_user_message","snapshot","spawn_worker","tabs","take_tab","task_goals","type_text","user_memory"]

browser_loop 关 · 有 worker（32）
["await_message","browser_run","capture_page_material","click","confirm_blocked_write","fetch","fill","hover","js","list_workers","mark","navigate","network","page_operation","page_translation","post","press_key","read_element","read_elements","record_task_results","resolve_unknown_result","screenshot","scroll","send_user_message","snapshot","spawn_worker","stop_worker","tabs","take_tab","task_goals","type_text","user_memory"]

browser_loop 开 · 无 worker（28）
["browser_loop","browser_run","capture_page_material","click","confirm_blocked_write","fetch","fill","hover","js","mark","navigate","network","page_translation","press_key","read_element","read_elements","record_task_results","resolve_unknown_result","screenshot","scroll","send_user_message","snapshot","spawn_worker","tabs","take_tab","task_goals","type_text","user_memory"]

browser_loop 开 · 有 worker（33）
["await_message","browser_loop","browser_run","capture_page_material","click","confirm_blocked_write","fetch","fill","hover","js","list_workers","mark","navigate","network","page_operation","page_translation","post","press_key","read_element","read_elements","record_task_results","resolve_unknown_result","screenshot","scroll","send_user_message","snapshot","spawn_worker","stop_worker","tabs","take_tab","task_goals","type_text","user_memory"]
```

来源清单与真实清单在四个场景逐名相等（双向差集均为空）。

## 4. 反例核验（临时改坏 → 复红 → 还原）

三次临时改动均在验证后还原（`cp` 备份还原，最终 `git diff` 只含本轮与并发包原有改动）：

| 临时改动 | 预期失败断言 | 实测输出 |
| --- | --- | --- |
| 来源清单去掉 `createTaskGoalsTool` | `active − inventory` 非空 | `AssertionError: 无 worker：真实清单有来源未覆盖的工具: expected [ 'task_goals' ] to deeply equal []` |
| 来源清单加 `"phantom_tool"` | `inventory − active` 非空 | `AssertionError: 无 worker：真实清单漏挂来源工具: expected [ 'phantom_tool' ] to deeply equal []` |
| 无 worker 基线 27 → 26 | 数量基线 | `AssertionError: 无 worker：真实数量基线: expected 27 to be 26` |

## 5. 命令与真实结果

```text
$ npx vitest run agent/test/tool-surface.test.ts agent/test/session-tool-mount.test.ts
 Test Files  2 passed (2)
      Tests  13 passed (13)          # 补正前同组为 11：新增 2 条真实清单用例

$ npx vitest run agent/test/tool-surface.test.ts --reporter=verbose
 ✓ 合成组件范围预算（非真实会话清单） > 组件拼接：无 worker ≤23、有 worker ≤29
 ✓ 合成组件范围预算（非真实会话清单） > read_elements 的模型参数上限与扩展执行器一致（1-200）
 ✓ 合成组件范围预算（非真实会话清单） > 系统提示词不超过 16,000 字符
 ✓ 合成组件范围预算（非真实会话清单） > worker 只拿到自己的工具（浏览器 + 投递/等待）,没有 spawn_worker
 ✓ 真实会话 active 清单（BrowserAgentSession 注册） > browser_loop 关：无/有 worker 的真实清单等于来源清单并匹配实测基线
 ✓ 真实会话 active 清单（BrowserAgentSession 注册） > browser_loop 开：无/有 worker 的真实清单等于来源清单并匹配实测基线
 ✓ 单人页不挂载 page_operation > setTeamToolsMounted(false) 从模型清单拿掉 page_operation，请来人后再挂上
 ✓ 合并工具的行为 > tabs 的每个 action 落到对应 RPC 名；switch/close 仍是同一模型工具
 ✓ 合并工具的行为 > tabs action:switch 缺 tabId 时不发 RPC
 ✓ 合并工具的行为 > mark 画标注与清除走同一个模型工具、两个 RPC 名
 ✓ 合并工具的行为 > RPC 名到模型名的映射覆盖合并的五个标签页工具与标注工具
 Test Files  1 passed (1)   Tests  11 passed (11)

$ npm run typecheck -w @sideagent/agent
 tsc --noEmit -p tsconfig.json   # 无输出，通过（agent/tsconfig.json include 含 test）
```

## 6. 未跑 / 未验 / 残留

- 未运行全量 `npm test` / `npm run check` / `npm run build`；未加载 host / 扩展、未重启、未用真实账号。
- 有 worker 场景用的是生产同一 `fleet.onMembersChange` 回调模拟成员加入，不是真的 `spawn_worker` 起一个 worker（起 worker 需要模型调用）。挂载语义与生产一致，但「真实 worker 生命周期中工具面不变」未单独验。
- 真实数量 27/28/32/33 只作为基线记录；是否要给真实工具面设上限、或调整工具组成，是产品取舍，不在本次范围，未改。
- 并发工作包的未提交改动（`read_elements` 等）全部保留，未提交、未 stash、未清理。

## 改动文件（本轮）

- `agent/test/tool-surface.test.ts`：`leadSurface` → `componentSurface` 并改名合成预算 describe；新增 `sourceInventory` + `REAL_SURFACE_BASELINE` + 2 条真实会话 active 清单用例。
- `docs/evals/20260921-tool-surface-reconcile.md`：本文档。
