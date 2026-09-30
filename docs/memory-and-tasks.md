# 记忆、过往任务与任务跨轮

本页是[协议](protocol.md)中记忆、过往任务、目标核对与任务跨轮部分的权威说明；记什么、记成哪种、用到哪里的设计见[记忆模型](memory-model.md)；用户可见行为见[使用说明](guides/usage.md#会话页面和记忆)，验收见 [20260927 记忆、主动、任务感](evals/20260927-memory-proactive-task.md)。

## 个人记忆

`memory_list{conversationId,requestId}` 读取个人记忆；`memory_update{conversationId,requestId,id,expectedVersion,text,scope}` 纠正内容与范围（只能改生效的条目）；`memory_forget{conversationId,requestId,id,expectedVersion}` 忘记；`memory_restore{conversationId,requestId,id,expectedVersion}` 撤销替换（id 是被替换的旧条目：它恢复生效，替换它的新条目改为失效，两条版本各 +1）。响应为 `memory_result{conversationId,requestId,action:"list"|"update"|"forget"|"restore",ok,entries?,entry?,deletedId?,error?}`，回到请求所属会话；restore 成功时 `entries` 为改动的条目（恢复的在前）。修改、忘记和撤销须匹配当前版本，失败不能呈现成功回执。

`scope` 为 `{kind:"all"}` 或 `{kind:"site",hostname}`。站点范围只约束使用，个人管理列表仍展示全部条目。条目（`MemoryEntry`，`formatVersion:2`）包含 id、version、text（最多 2000 字符）、scope、sourceConversationId、createdAt、updatedAt，以及：

- `kind`：`profile` 关于你 / `past` 做过的事 / `method` 做事的方法（来自纠正的 `experience` 条目）；「这件事的要求」只在对话里，不落盘。
- `validity?{start?,end?,task?}`：毫秒时间戳，缺省 = 长期；带日期的事 `end` 为那天本地 23:59:59.999。`date?` 是关联的本地日期 `YYYY-MM-DD`。
- `sourceQuote?`：用户原话（判断依据的那段，最多 600 字）；升级前的条目没有。
- `useCount`、`lastUsedAt?`：被带给助手的次数与最近一次，不改版本号。
- `status`：`active` 生效 / `replaced` 被替换（`replacedBy` 指向新条目）/ `invalid` 失效。只有生效的会被带给助手、被判断当作修改目标。

同一事实换新值（判断为 update）时不再覆盖：旧条目版本 +1、标 `replaced` 留作历史，新值另起一条。存储文件 `format:2`；读到升级前的 `format:1` 时逐条补默认值（种类按来源推断：有 `experience` 的为 `method`，其余 `profile`；有效期为空；`active`；用过 0 次），下次写入即为 2；有一条不合格仍按损坏报错，不当作空记忆覆盖。回执事件里的旧格式条目在协议解析时同样补默认值。

当前 Lead 工具为 `user_memory`：`recall` 查询任务所需资料，`change` 按当前直接用户请求解释保存、修改或忘记，`history` 查过往任务。语义解释由 `memory-decision.ts` 完成，运行时核对输入当前性；网页、附件、工具输出及 worker 不能自行授予记忆修改权限。产品会话开启自动模式（`MemoryRuntime` 的 `auto`）：可能在说个人资料的用户消息一到，就用快速模型按同一边界判断一次，只收用户自己说的、关于自己的长期资料，不收一次性参数、别人的事、网页内容和任何密码验证码；这句被新消息、停止或接管作废时不落盘。模型再调用 `change` 时复用这次结果，不判断第二次。

**决定点 A：一句话记成哪种。** 同一次判断里模型另答四个窄问题 `about{longTerm,date,onlyThisTask,explicitRequest}`（是用户自己的长期事实吗？这件事关联哪一天，按输入里的 `today` 解析？只对眼前这件任务吗？明说记住了吗？），`placeMemory` 按[记忆模型](memory-model.md)的顺序落位：像密码验证码证件卡号的不记 → 只对这次任务的不记 → 长期事实记 `profile` → 有日期的记 `past`、有效期到那天结束 → 明说记住的记 `profile` → 其余不记；更新 `method` 条目时保留种类。缺 `about` 时按长期事实处理（升级前行为）。粗筛也放行带日子的自述和「这次…」，让这两类得到判断。任务结束写过往任务时，提到日子的任务再问快速模型一个窄问题「结果关联哪一天」（`MemoryRuntime.datePastTask`，12 秒超时），代码给过往任务标 `date` 与 `validity`。每次判断在诊断记录写一条 `memory_decision{source:"message"|"change"|"task",action?,kind,stored?,rule,answers?,quote,date,validityEnd}`；原话像密码验证码时 `quote` 只写占位。

**决定点 B：这一轮带哪些。** `before_agent_start` 用纯代码规则 `selectMemoryContext` 挑选：`always` 生效的 `profile` 与到处适用的 `method`（合计最多 40 条、4000 字）；`in-validity` 有效期内的 `past` 条目与带有效期的过往任务，不论网站（10 条、2000 字）；`site` 网站范围与当前主机名精确相同的记忆，以及这个网站最近 3 条过往任务（2400 字）；`asked` 这句话在问「之前 / 上次」时，最近 5 条过往任务（3000 字）。总字数上限 `MEMORY_CONTEXT_MAX_CHARS`=9000。被替换、失效、过期、别的网站的不带；自动总结、用户没改过的网站做法仍要对得上这件事的对象。带上的条目在写锁下按 id+版本再核对一次（挑选后被忘记、修改或替换的不带），`useCount`+1。诊断记录写一条 `memory_context{hostname,rules,entries:[{id,kind,rule,chars}],tasks:[{id,rule,date}],totalChars,maxChars,skipped}`，只有编号和规则，不含记忆原文。显式查询仍由 `select / resolveSelected` 按任务对象选择生效条目并复核版本。`agent_event` 中的 `memory` 事件记录 saved/updated/forgotten/used 及条目快照，历史回执不随之后的修改而重写；侧栏在单条 saved 回执上给「撤销」，发的就是 `memory_forget`。

存储经 `DocumentPersistence` 抽象：扩展 IndexedDB `sideagent-memory` 库、`kv` 表的 `memories` 键（扩展申请 `unlimitedStorage`，不受默认配额限制）（原本机宿主的 `~/.sideagent/memory/memories.json` 随本机模式退役；文件实现 `FileDocument` 只留给在 Node 里托管会话的检查）。忘记会移除有效条目，后续新轮次不再读取它；原聊天仍保留。当前没有按 Chrome 配置分别选择存储目录，不能宣称已实现浏览器配置隔离。

## 过往任务

列过目标或有执行记录的任务在 Lead 的 `agent_end` 后留一条摘要 `TaskHistoryEntry{id=runId,conversationId,goal,page?,revisions,hosts,outcome:"complete"|"partial"|"stopped"|"error",summary,unfinished,startedAt,endedAt,date?,validity?}`；同一 runId 接着做完时覆盖。`date / validity` 由决定点 A 在任务结束时标上，旧条目与无日期的任务缺省（文件仍是 `format:1`，新字段可选）。最多 200 条，存在同一处（扩展 IndexedDB `tasks` 键）。每轮带哪些见上面的决定点 B；`user_memory history` 按词或网站查过往任务，并列出用户说过的 `past` 条目（过期的标 already past），所以过了有效期仍查得到。侧栏用 `task_history_list{conversationId,requestId}` 读取、`task_history_forget{conversationId,requestId,id|null}` 删一条或全部清空，响应为 `task_history_result{conversationId,requestId,ok,tasks?,error?}`（删除后返回剩下的）。

## 目标核对

Lead 会话一轮结束（`agent_end`，非停止、接管、出错，且这一任务有改动页面的执行记录）时，先用快速模型核对用户要的结果达成没有（`goal-check.ts`，输入为用户原话与修订、最后回答、当前页标题/地址/正文前 3000 字，12 秒超时）。结论 `done / needs_user / continue`：`continue` 时宿主不收尾，直接追加一轮 `[GOAL CHECK]` 提示让助手接着做（每个任务最多 2 次，提示要求保留用户设的条件和安全规则）；否则照常收尾。最后一轮回答里在问用户（结尾约 100 字内有问号）时，一律按 `needs_user` 处理，不交给模型判断。结论以 `agent_event{kind:"goal_check",status,remaining?}` 发出，进度快照记为 `goalCheck`，任务视图投影为 `goalStatus{status:"done"|"open",remaining}`；`open` 使任务 `resumable`，任务条据此写「还差：…」或「已完成」。核对失败只在诊断记录里留 `goal_check{status:"unavailable"}`，不影响收尾。

## 用户设的提交条件

用户原话要求「提交前让我确认」这类条件时（`asksConfirmBeforeSubmit`），会话经 `ToolRpc.decorateParams` 给这一任务出站的 `click` / `double_click` 加 `confirmSubmit:true`（模型不能自己设）。扩展执行时按页面上元素自己的名字判断，提交类按钮（`isSubmitLabel`：提交、订阅、注册、报名、Sign up、Subscribe、Submit、Register…）与删除类一样先拿住，等用户在页面或侧栏确认；侧栏「确认 / 可以 / 提交吧 / 没问题」这类明确同意与名牌上的「确认」同效：有拿住的点击时由扩展直接补上那一下（`resolveHeldClick("confirm")`），再把这句话交给助手；没有拿住的点击时只放行下一次。拿住的点击在宿主账本里是「结果未知」，模型不能重做它，所以不能只放行等模型重点。未覆盖：页面脚本（`js`）与在输入框里按回车提交。

## 任务跨轮

上一个任务以「部分完成」结束（任务视图 `resumable`）时，侧栏发来的普通文字 `task_action{action:"start"}` 先由快速模型判断是否接着做这件事（`follow-up-intent.ts`，6 秒超时，判断不了按另起）。是则改走 `steer`：登记为原任务的修订，以 `manual_continuation` 中断后从原任务恢复，runId 与目标不变；恢复提示写明是用户补充而非重启。
