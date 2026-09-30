# 记忆、过往任务与任务跨轮

本页是[协议](protocol.md)中记忆、过往任务、目标核对与任务跨轮部分的权威说明；用户可见行为见[使用说明](guides/usage.md#会话页面和记忆)，验收见 [20260927 记忆、主动、任务感](evals/20260927-memory-proactive-task.md)。

## 个人记忆

`memory_list{conversationId,requestId}` 读取个人记忆；`memory_update{conversationId,requestId,id,expectedVersion,text,scope}` 纠正内容与范围；`memory_forget{conversationId,requestId,id,expectedVersion}` 忘记。响应为 `memory_result{conversationId,requestId,action,ok,entries?,entry?,deletedId?,error?}`，回到请求所属会话。修改和忘记须匹配当前版本，失败不能呈现成功回执。

`scope` 为 `{kind:"all"}` 或 `{kind:"site",hostname}`。站点范围只约束使用，个人管理列表仍展示全部条目。条目包含 id、version、text、scope、sourceConversationId、createdAt、updatedAt；内容最多 2000 字符。

当前 Lead 工具为 `user_memory`：`recall` 查询任务所需资料，`change` 按当前直接用户请求解释保存、修改或忘记，`history` 查过往任务。语义解释由 `memory-decision.ts` 完成，运行时核对输入当前性；网页、附件、工具输出及 worker 不能自行授予记忆修改权限。产品会话开启自动模式（`MemoryRuntime` 的 `auto`）：可能在说个人资料的用户消息一到，就用快速模型按同一边界判断一次，只收用户自己说的、关于自己的长期资料，不收一次性参数、别人的事、网页内容和任何密码验证码；这句被新消息、停止或接管作废时不落盘。模型再调用 `change` 时复用这次结果，不判断第二次。个人资料（非经验条目）每轮全部带上（`MemoryStore.profile`，最多 40 条、4000 字）；网站做法仍由 `select / resolveSelected` 按任务对象选择并复核版本。`agent_event` 中的 `memory` 事件记录 saved/updated/forgotten/used 及条目快照，历史回执不随之后的修改而重写；侧栏在单条 saved 回执上给「撤销」，发的就是 `memory_forget`。

存储经 `DocumentPersistence` 抽象：扩展 IndexedDB `sideagent-memory` 的 `memories` 键（原本机宿主的 `~/.sideagent/memory/memories.json` 随本机模式退役；文件实现 `FileDocument` 只留给在 Node 里托管会话的检查）。忘记会移除有效条目，后续新轮次不再读取它；原聊天仍保留。当前没有按 Chrome 配置分别选择存储目录，不能宣称已实现浏览器配置隔离。

## 过往任务

列过目标或有执行记录的任务在 Lead 的 `agent_end` 后留一条摘要 `TaskHistoryEntry{id=runId,conversationId,goal,revisions,hosts,outcome:"complete"|"partial"|"stopped"|"error",summary,unfinished,startedAt,endedAt}`；同一 runId 接着做完时覆盖。最多 200 条，存在同一处（扩展 IndexedDB `tasks` 键）。每轮开始时带上当前网站最近 3 条；`user_memory history` 按词或网站查。侧栏用 `task_history_list{conversationId,requestId}` 读取、`task_history_forget{conversationId,requestId,id|null}` 删一条或全部清空，响应为 `task_history_result{conversationId,requestId,ok,tasks?,error?}`（删除后返回剩下的）。

## 目标核对

Lead 会话一轮结束（`agent_end`，非停止、接管、出错，且这一任务有改动页面的执行记录）时，先用快速模型核对用户要的结果达成没有（`goal-check.ts`，输入为用户原话与修订、最后回答、当前页标题/地址/正文前 3000 字，12 秒超时）。结论 `done / needs_user / continue`：`continue` 时宿主不收尾，直接追加一轮 `[GOAL CHECK]` 提示让助手接着做（每个任务最多 2 次，提示要求保留用户设的条件和安全规则）；否则照常收尾。最后一轮回答里在问用户（结尾约 100 字内有问号）时，一律按 `needs_user` 处理，不交给模型判断。结论以 `agent_event{kind:"goal_check",status,remaining?}` 发出，进度快照记为 `goalCheck`，任务视图投影为 `goalStatus{status:"done"|"open",remaining}`；`open` 使任务 `resumable`，任务条据此写「还差：…」或「已完成」。核对失败只在诊断记录里留 `goal_check{status:"unavailable"}`，不影响收尾。

## 用户设的提交条件

用户原话要求「提交前让我确认」这类条件时（`asksConfirmBeforeSubmit`），会话经 `ToolRpc.decorateParams` 给这一任务出站的 `click` / `double_click` 加 `confirmSubmit:true`（模型不能自己设）。扩展执行时按页面上元素自己的名字判断，提交类按钮（`isSubmitLabel`：提交、订阅、注册、报名、Sign up、Subscribe、Submit、Register…）与删除类一样先拿住，等用户在页面或侧栏确认；侧栏「确认 / 可以 / 提交吧 / 没问题」这类明确同意与名牌上的「确认」同效：有拿住的点击时由扩展直接补上那一下（`resolveHeldClick("confirm")`），再把这句话交给助手；没有拿住的点击时只放行下一次。拿住的点击在宿主账本里是「结果未知」，模型不能重做它，所以不能只放行等模型重点。未覆盖：页面脚本（`js`）与在输入框里按回车提交。

## 任务跨轮

上一个任务以「部分完成」结束（任务视图 `resumable`）时，侧栏发来的普通文字 `task_action{action:"start"}` 先由快速模型判断是否接着做这件事（`follow-up-intent.ts`，6 秒超时，判断不了按另起）。是则改走 `steer`：登记为原任务的修订，以 `manual_continuation` 中断后从原任务恢复，runId 与目标不变；恢复提示写明是用户补充而非重启。
