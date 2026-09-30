# 记忆、过往任务与任务跨轮

本页是[协议](protocol.md)中记忆、过往任务、目标核对与任务跨轮部分的权威说明；记什么、记成哪种、用到哪里的设计见[记忆模型](memory-model.md)；用户可见行为见[使用说明](guides/usage.md#会话页面和记忆)，验收见 [20260927 记忆、主动、任务感](evals/20260927-memory-proactive-task.md)。

## 个人记忆

`memory_list{conversationId,requestId}` 读取个人记忆；`memory_update{conversationId,requestId,id,expectedVersion,text,scope}` 纠正内容与范围（只能改生效的条目）；`memory_forget{conversationId,requestId,id,expectedVersion}` 忘记：id 是生效的值时整条历史（同一事实的所有旧值）一起删；id 是被替换或失效的一行时只删这一行，指向它的更旧条目改指向它的下一条（`replacedBy` 接上，这些条目版本 +1）；`memory_restore{conversationId,requestId,id,expectedVersion}` 撤销：id 是被替换或失效的条目（生效的报错），它成为这条历史里唯一生效的值，原来生效的那条改为 `invalid` 并以 `replacedBy` 指向它；所有改动的条目版本各 +1。响应为 `memory_result{conversationId,requestId,action:"list"|"update"|"forget"|"restore",ok,entries?,entry?,deletedId?,error?}`，回到请求所属会话；restore 成功时 `entries` 为改动的条目（恢复的在前）。修改、忘记和撤销须匹配当前版本，失败不能呈现成功回执。侧栏在忘记或撤销成功后重新读取列表，显示的是存储里的最新状态。

`scope` 为 `{kind:"all"}` 或 `{kind:"site",hostname}`。站点范围只约束使用，个人管理列表仍展示全部条目。条目（`MemoryEntry`，`formatVersion:2`）包含 id、version、text（最多 2000 字符）、scope、sourceConversationId、createdAt、updatedAt，以及：

- `kind`：`profile` 关于你 / `past` 做过的事 / `method` 做事的方法（来自纠正的 `experience` 条目）；「这件事的要求」只在对话里，不落盘。
- `validity?{start?,end?,task?}`：毫秒时间戳，缺省 = 长期；带日期的事 `end` 为那天本地 23:59:59.999。`date?` 是关联的本地日期 `YYYY-MM-DD`。
- `sourceQuote?`：用户原话（判断依据的那段，最多 600 字）；升级前的条目没有。
- `useCount`、`lastUsedAt?`：被带给助手的次数与最近一次，不改版本号。
- `status`：`active` 生效 / `replaced` 被替换 / `invalid` 失效（两者的 `replacedBy` 都指向接替它的条目）。只有生效的会被带给助手、被判断当作修改目标。

同一事实换新值（判断为 update）时不再覆盖：旧条目版本 +1、标 `replaced` 留作历史，新值另起一条。存储文件 `format:2`；读到升级前的 `format:1` 时逐条补默认值（种类按来源推断：有 `experience` 的为 `method`，其余 `profile`；有效期为空；`active`；用过 0 次），下次写入即为 2；有一条不合格仍按损坏报错，不当作空记忆覆盖。回执事件里的旧格式条目在协议解析时同样补默认值。

当前 Lead 工具为 `user_memory`：`recall` 查询任务所需资料，`change` 按当前直接用户请求解释保存、修改或忘记，`history` 查过往任务。语义解释由 `memory-decision.ts` 完成，运行时核对输入当前性；网页、附件、工具输出及 worker 不能自行授予记忆修改权限。产品会话开启自动模式（`MemoryRuntime` 的 `auto`）：可能在说个人资料的用户消息一到，就用快速模型按同一边界判断一次，只收用户自己说的、关于自己的长期资料，不收一次性参数、别人的事、网页内容和任何密码验证码；这句被新消息、停止或接管作废时不落盘。模型再调用 `change` 时复用这次结果，不判断第二次。

**决定点 A：一句话记成哪种。** 同一次判断里模型另答五个窄问题 `about{longTerm,date,onlyThisTask,explicitRequest,dateIsTheTask}`（是用户自己的长期事实吗？这件事关联哪一天，按输入里带星期几的 `today` 解析？只对眼前这件任务吗？明说记住了吗？这个带日期的安排本身就是此刻要助手去办的事吗？模型没答最后一问时按「是」处理，即先不记），`placeMemory` 按[记忆模型](memory-model.md)的顺序落位：像密码验证码证件卡号的不记 → 只对这次任务的不记 → 此刻要做的事不记（见下）→ 长期事实记 `profile` → 有日期的记 `past`、有效期到那天结束 → 明说记住的记 `profile` → 其余不记；更新 `method` 条目时保留种类。「此刻要做的事」指用户这句话同时在让助手去做事（订票、买东西），带的日期就是这件任务本身，还没做完：决定时不记，任务结束时作为过往任务带日期记下；只有明说「记住」或属于长期事实时才照常记。缺 `about` 时按长期事实处理（升级前行为）。粗筛也放行带日子的自述和「这次…」，让这两类得到判断。任务结束写过往任务时，先立即写入，提到日子的任务再问快速模型一个窄问题「结果关联哪一天」（`MemoryRuntime.datePastTask`，12 秒超时），晚到的日期经 `patchDate` 补上 `date` 与 `validity`。每次判断在诊断记录写一条 `memory_decision{source:"message"|"change"|"task",action?,kind,stored?,rule,answers?,quote,date,validityEnd}`；原话像密码验证码时 `quote` 只写占位。

**决定点 B：这一轮带哪些。** `before_agent_start` 用纯代码规则 `selectMemoryContext` 挑选：`always` 生效的 `profile` 与到处适用的 `method`，以及网站范围的 `profile`（网站范围只在当前主机名精确相同时才算），`always` 与 `site` 的记忆条目共用一层，合计最多 40 条、4000 字；`in-validity` 有效期内的 `past` 条目与带有效期的过往任务，不论网站，共用一层（10 条、2000 字）；`site` 网站范围与当前主机名精确相同的 `method` 与自动总结条目（记忆条目的 `site`，计入上面 40 条 / 4000 字那一层），以及这个网站最近 3 条没过期的过往任务（只有这一项限 2400 字）；`asked` 这句话在问「之前 / 上次」时，最近 5 条过往任务，不限网站，含已过期的（3000 字，此时不再按网站带任务）。每一层先各自受上限，再受总字数上限 `MEMORY_CONTEXT_MAX_CHARS`=9000（超出的不带，记入 `skipped.overCap`）。被替换、失效、过期、别的网站的不带：有效期已过的 `past` 条目与带日期任务，只在 `asked` 时出现，不会经 `site` 或 `always` 再带；网站范围的 `method`（含自动总结）要对得上这件事，不论改过几次，没改过的自动总结按对象严格对、用户改过或恢复过的按词宽松对，到处适用的做法与用户自述的事实照常带。一条只记一次，列在第一个带上它的规则下。带上的条目在写锁下按 id+版本再核对一次（挑选后被忘记、修改或替换的不带），`useCount`+1。诊断记录写一条 `memory_context{hostname,rules,entries:[{id,kind,rule,chars}],tasks:[{id,rule,date}],totalChars,maxChars,skipped}`（每个带上的条目和任务各一行，标明是哪条规则带上的；`skipped` 为没带的条数及原因），只有编号和规则，不含记忆原文。显式查询仍由 `select / resolveSelected` 按任务对象选择生效条目并复核版本。`agent_event` 中的 `memory` 事件记录 saved/updated/forgotten/used 及条目快照，历史回执不随之后的修改而重写；侧栏在单条 saved 回执上给「撤销」，发的就是 `memory_forget`。

存储经 `DocumentPersistence` 抽象：扩展 IndexedDB `sideagent-memory` 库、`kv` 表的 `memories` 键（扩展申请 `unlimitedStorage`，不受默认配额限制）（原本机宿主的 `~/.sideagent/memory/memories.json` 随本机模式退役；文件实现 `FileDocument` 只留给在 Node 里托管会话的检查）。忘记后被删的条目后续新轮次不再读取；原聊天仍保留。当前没有按 Chrome 配置分别选择存储目录，不能宣称已实现浏览器配置隔离。

## 过往任务

列过目标或有执行记录的任务在 Lead 的 `agent_end` 后留一条摘要 `TaskHistoryEntry{id=runId,conversationId,goal,page?,revisions,hosts,outcome:"complete"|"partial"|"stopped"|"error",summary,unfinished,startedAt,endedAt,date?,validity?}`；同一 runId 接着做完时覆盖，但沿用原条目的 `useCount / lastUsedAt`，新条目没带日期与有效期时也沿用原来的。任务结束时立即写入；日期判断晚到时只补 `date / validity`，且只改仍存在、`endedAt` 相同的那条，已被删除的不重建，已被同一任务新记录覆盖的不动。带给助手的任务 `useCount`+1、记 `lastUsedAt`。`date / validity` 由决定点 A 在任务结束后补上，旧条目与无日期的任务缺省（文件仍是 `format:1`，新字段可选）。最多 200 条，存在同一处（扩展 IndexedDB `tasks` 键）。每轮带哪些见上面的决定点 B；`user_memory history` 按词或网站查过往任务，并列出用户说过的 `past` 条目（过期的标 already past），所以过了有效期仍查得到。侧栏用 `task_history_list{conversationId,requestId}` 读取、`task_history_forget{conversationId,requestId,id|null}` 删一条或全部清空，响应为 `task_history_result{conversationId,requestId,ok,tasks?,error?}`（删除后返回剩下的）。

## 目标核对

Lead 会话一轮结束（`agent_end`，非停止、接管、出错，且这一任务有改动页面的执行记录）时，先用快速模型核对用户要的结果达成没有（`goal-check.ts`，输入为用户原话与修订、最后回答、当前页标题/地址/正文前 3000 字，12 秒超时）。结论 `done / needs_user / continue`：`continue` 时宿主不收尾，直接追加一轮 `[GOAL CHECK]` 提示让助手接着做（每个任务最多 2 次，提示要求保留用户设的条件和安全规则）；否则照常收尾。最后一轮回答里在问用户（结尾约 100 字内有问号）时，一律按 `needs_user` 处理，不交给模型判断。结论以 `agent_event{kind:"goal_check",status,remaining?}` 发出，进度快照记为 `goalCheck`，任务视图投影为 `goalStatus{status:"done"|"open",remaining}`；`open` 使任务 `resumable`，任务条据此写「还差：…」或「已完成」。核对失败只在诊断记录里留 `goal_check{status:"unavailable"}`，不影响收尾。

## 用户设的提交条件

用户原话要求「提交前让我确认」这类条件时（`asksConfirmBeforeSubmit`），会话经 `ToolRpc.decorateParams` 给这一任务出站的 `click` / `double_click` 加 `confirmSubmit:true`（模型不能自己设）。扩展执行时按页面上元素自己的名字判断，提交类按钮（`isSubmitLabel`：提交、订阅、注册、报名、Sign up、Subscribe、Submit、Register…）与删除类一样先拿住，等用户在页面或侧栏确认；侧栏「确认 / 可以 / 提交吧 / 没问题」这类明确同意与名牌上的「确认」同效：有拿住的点击时由扩展直接补上那一下（`resolveHeldClick("confirm")`），再把这句话交给助手；没有拿住的点击时只放行下一次。拿住的点击在宿主账本里是「结果未知」，模型不能重做它，所以不能只放行等模型重点。未覆盖：页面脚本（`js`）与在输入框里按回车提交。

## 任务跨轮

上一个任务以「部分完成」结束（任务视图 `resumable`）时，侧栏发来的普通文字 `task_action{action:"start"}` 先由快速模型判断是否接着做这件事（`follow-up-intent.ts`，6 秒超时，判断不了按另起）。是则改走 `steer`：登记为原任务的修订，以 `manual_continuation` 中断后从原任务恢复，runId 与目标不变；恢复提示写明是用户补充而非重启。
