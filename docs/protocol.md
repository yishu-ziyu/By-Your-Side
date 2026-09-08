# SideAgent 桥接协议

background service worker 与本地伴随进程（Node + Pi SDK）之间的协议；默认走 native messaging，WebSocket 用于调试回退。侧栏通过扩展内部 Port 连接 background。
权威类型定义见 `shared/protocol.ts`，本文档描述流程与语义。

## 传输与握手

以下 token、Origin 与单客户端握手规则适用于 WebSocket 回退通道。native messaging 由 Chrome 拉起伴随进程，通过 host 的扩展白名单限制访问。

- WebSocket 模式监听 `ws://127.0.0.1:7758`（仅回环地址）。
- 启动时生成随机 token 并打印到终端；用户在面板首次设置中粘贴一次，存 `chrome.storage.local`。
- 连接后客户端第一帧必须是 `hello{token, client:"sidepanel"}`。
- 服务端校验：token 匹配 + WS 握手的 `Origin` 头以 `chrome-extension://` 开头。
- 成功回 `hello_ok{version, model}`；失败回 `hello_error{error}` 并关闭连接。
- 单客户端策略：新连接握手成功则顶替旧连接（旧连接收到 `agent_event{kind:"notice"}` 后被关闭）。

## 消息流

### 用户会话身份

`conversationId` 标识顶层用户会话；`sessionId` 标识该会话内的 Lead 或 worker。所有客户端和服务端帧都支持 `conversationId`；兼容旧客户端时，缺失值归入 `default`。`sessionId` 缺失或为 `main` 表示该会话的 Lead。状态、工具调用、结果及控制确认始终按原会话路由，切换侧栏不改变事件归属。

```text
client → conversation_create{requestId, title?}
server → conversation_created{requestId, conversation}
client → conversation_list{requestId?}
server → conversation_list{requestId?, conversations}
server → conversation_updated{conversation}
```

摘要包含 `id/title/createdAt/updatedAt/state/model?/mode`。每个用户会话拥有独立 Pi AgentSession、Fleet、任务上下文、控制门和历史。新建 B 不停止 A；切换只改变当前显示项。`conversation_list` 还重发各会话的运行状态、团队与模型信息，用于后台重新连接后的同步。

### 对话

以下帧均可携带 `conversationId`。

```
client → user_message{text, context?}  # 空闲时发起新任务；context = 发送时用户正在看的
                                       #   标签页{tabId,title,url}（background 转发前自动附上）
client → steer{text, context?}     # 运行中插话（映射 session.steer）；同样附当前页锚点，
                                   #   避免打断后丢工作标签
client → abort                     # 中止该 conversation 的 Lead 与 workers
client → takeover{requestId, members?, groupId?, generation?}
                                   # background 按目标页冻结该页全部协作者，不结束会话。
client → handback{context?, snapshot?, members?}  # 一次交还。members 按成员绑定页给
                                       #   各自 tabId/title/url/snapshot；某页已关则 closed。
                                       #   不得把当前活动标签复制给其他成员。
server → status{state:"running"|"idle"|"user", sessionId?}
                                       # user = 现在归你，≠ idle，≠ 中止
server → team_status{team}            # 组相位：draining / user / restoring / partial /
                                       #   restored / aborted。部分失败不得写成全队已恢复。
server → control_result{..., team?}   # 接管/交还确认，可带组成员结果
server → agent_event{..., sessionId?}  # 流式渲染：text_delta / thinking_delta /
                                   #   tool_start / tool_end / turn_* / agent_* /
                                   #   notice / error
```

worker 事件带自己的 `sessionId`，面板把它们显示在所属用户会话的团队状态中。`abort` 只中止指定用户会话；停止单个 worker 只撤销该成员。`takeover` / `handback` 保留会话与标签绑定：接管先阻止目标页新写入，等待已在途短动作到安全停止点，再暂停该页全部协作者。其他会话的独立页继续。交还为各成员读取绑定页的新快照；关闭或读取失败的页面保持暂停，不把当前活动页替代进去。


`text_delta` 聚合成当前助手消息；`tool_start`/`tool_end` 以 `toolCallId` 配对渲染为可折叠卡片。

### 工具调用（RPC）

```
server → tool_call{conversationId, id, name, params, sessionId?}     # name ∈ TOOL_NAMES；工人调用带 sessionId
client → tool_result{conversationId, id, ok:true, data}  # data 形状见 ToolContract
       | tool_result{conversationId, id, ok:false, error}
```

- background 从上行连接直接接收和执行 `tool_call`，结果原路回传；工具执行不经过侧栏，关闭侧栏不会停止任务。
- 伴随进程侧 RPC 默认超时 30s（`navigate`/`screenshot` 60s），超时/断连即以错误结果结束该工具调用。
- 扩展侧任何异常都必须回 `ok:false` + 一行人类可读 error，不允许挂断不回。

`browser_run` 在本地解释器执行，不是新增的扩展 RPC 工具。它的每个浏览器子调用仍使用上述帧，并附带可选 `programId`。接管/排空期间，该程序的所有子调用都被拒绝，包括普通情况下允许的只读工具；原独立工具行为不变。内部开始/结束通过 SDK 工具更新事件转成既有步骤事件，使用 `父调用ID/序号` 关联。详见 `docs/browser-program.md`。

## 工作标签页语义

- 页资源记录 `tabId + conversationId + mode + collaborators`。普通页独占；共享页只能由同一用户会话内显式登记的成员访问。`sessionId` 的工作页绑定不取代页资源归属检查。
- 首次认领页面时才创建该会话的 Chrome 原生标签组，标题跟随会话名；纯聊天不创建空组。`groupId` 只用于展示，持久身份仍是 `conversationId`。
- 主 Agent 的 `list_tabs` 返回全局标签；worker 只返回分配给自己的页面。主 Agent 可用 `snapshot({tabId})` / `read_element({tabId,target})` 跨会话只读，不认领页面。操作其他会话的页面先经 `take_tab` 协调；普通 `switch_tab` / `close_tab` 自动走此流程。A/B 会话内容保持独立。
- 用户当前未归属的活动页可以明确借入当前会话。`get_active_tab` 只读活动页信息，不自动认领；它与用户消息的 `context` 为「这页面」提供锚点。
- 省略 `tabId` 时使用该执行成员已绑定的工作页；没有绑定时只能选择未归属页面。只有当前显示会话的 Lead 可以在已在前台的窗口中激活自己的标签；后台会话和 worker 不抢标签焦点，也不调用 `windows.update({focused:true})`。
- screenshot 优先使用 CDP `Page.captureScreenshot`，失败再尝试 `captureVisibleTab`。

### 同页协作

运行时通过 `spawn_worker` 的 `sharedTabId` 指定共享页，并调用 `share_tab{tabId, collaborators, remove?}` 登记成员；未登记成员不能操作该页。撤销 worker 时移除其写入资格。材料与文案可以通过邮箱并行准备，页面上的写动作串行执行。

共享表单写入使用 `page_operation{tabId?, target, expectedValue, value}`。当前支持原生 `input` / `textarea` 字段，定位为 CSS 或当前 snapshot 的有效引用。队列覆盖完整短事务：获锁后重新定位和核对原值 → 滚动与 focus → 输入 → 读回核对。过期目标、原值冲突、协作资格撤销或用户接管都会拒绝写入；失败包含操作者、目标、是否发生修改及读回信息。共享页其他通用写工具安全拒绝，不能绕过该事务直接使用 click/fill/js 等命令。

彩色光标表示成员身份与位置，页面仍只有一套输入焦点。当前不支持跨用户会话共享页面，也不提供 A/B 会话合并。

`read_element{tabId?, target}` 按当前 ref 或唯一 CSS 定位返回完整 `textContent` 与表单 `value`，用于补读快照缩略的材料和填写前的原值。读取不滚动、不聚焦、不修改页面，不接受任意脚本；归属和协作者检查仍生效。超过安全上限时明确报错，不把截断值用于原值核对。独立读取可在用户接管时进行，已停止的 browser program 不能借此继续执行。

## 面板恢复与 Pi 持久化

扩展内部 relay 使用 `select_conversation{conversationId}` 切换显示，`sync{conversationId, afterSeq?}` 按会话同步历史；历史和状态 envelope 带 `conversationId`。选择项保存在 `chrome.storage.session`，聊天历史与各会话的输入草稿、待发送附件保存在 `chrome.storage.local`。历史序号单调递增，新一轮用户消息不会清空前面的轮次。

Pi 上下文保存在 `~/.sideagent/conversations/{conversationId}/` 下的会话文件及索引中。伴随进程重启后可恢复对话上下文；重建实例不会自动重放旧任务或继续原页面动作。前端历史只负责展示，不能替代 Pi 的原生上下文恢复。

## 跨会话记忆

`memory_list{conversationId,requestId}` 读取个人记忆；`memory_update{conversationId,requestId,id,expectedVersion,text,scope}` 纠正内容与范围；`memory_forget{conversationId,requestId,id,expectedVersion}` 忘记。响应为 `memory_result{conversationId,requestId,action,ok,entries?,entry?,deletedId?,error?}`，回到请求所属会话。修改和忘记须匹配当前版本，失败不能呈现成功回执。

`scope` 为 `{kind:"all"}` 或 `{kind:"site",hostname}`。站点范围只约束使用，个人管理列表仍展示全部条目。条目包含 id、version、text、scope、sourceConversationId、createdAt、updatedAt；内容最多 2000 字符。

只有 Lead 的 `remember_user_preference` 工具能新增，且当前用户消息须明确要求保留。网页、附件、工具输出及 worker 无权自动保存。每轮按主题词与精确 hostname 选择记忆，再重新核对条目版本，通过 Pi 单轮提示使用。`agent_event` 中的 `memory` 事件记录 saved/used 及条目快照，历史回执不随之后的修改而重写。

数据当前存于操作系统用户目录 `~/.sideagent/memory/memories.json`；原子替换与写锁保护并发修改。忘记会移除有效条目，后续新轮次不再读取它；原聊天仍保留。当前没有按 Chrome 配置分别选择存储目录，不能宣称已实现浏览器配置隔离。

## target 定位串

`click`/`hover`/`fill` 的 `target` 接受：`"@N"`（最近 snapshot 的 ref）、`"loc=css:..."`（snapshot 给出的稳定定位串）、原生 CSS 选择器；`click`/`hover` 另接受 `point:[x,y]` 视口坐标。

ref 编号随节点保持稳定，但必须出现在最新快照中；新快照替换可用引用集合。无效、失效、未找到或匹配多个元素时明确报错并要求重新定位，不猜测另一个目标。Playwright 的 `:has-text()` 和 `loc=h3...` 不受支持。

`hover` 派发真实 CDP `mouseMoved`，触发原生 CSS 悬停状态；返回 `{hovered:true}` 仅表示移动执行成功。Agent 仍需观察是否出现预期入口。`click` 同样只确认事件执行，不证明编辑器打开或任务完成。接管期间 `hover` 和其他写操作一样被控制闸门拦截。

`mark` 可选 `actions: [{id:"confirm"|"cancel", label}]`：就地确认。带 actions 时光标飞到目标拿住，删除/取消一类按钮长在光标名牌上（不在框外）。用户点按钮时，content script 发内部 `mark_action`，background 转成 `user_message` 文本「确认」或「取消」（与侧栏打字同一条路）。点取消会先 `clear_marks`。

## 安全

- 仅绑定 127.0.0.1；token 校验；Origin 校验。
- 任何网页尝试连接 localhost WS 都会因 Origin/token 不符被拒。

## 本地诊断轨迹

`~/.sideagent/traces/*.jsonl` 按会话、任务、轮次与工具调用标识记录目标、模型、参数、返回、错误和耗时，以及接管/交还事件。日志写入失败不改变任务结果。输入工具的填写值默认隐藏；图片只留元数据，其他文本按敏感字段与模式脱敏。任务和页面文本仍属于本地私密数据。

目录权限 0700、文件权限 0600；每会话最多约 8 MiB，创建文件时清理到最近约 20 份。单条记录限制总字符和节点数，达到上限明确标记截断。日志是诊断证据，不作为自动停止任务或判定业务成功的条件。


## 网页经历与纠正（第一轮）

`MemoryEntry.experience?` 包含 `runId`、`evidence`（最多8条、每条最多600字符）及 `topic?`（最多200字符）。缺省仍表示现有显式记忆。经验使用同一 memory_list/update/forget 协议与 memory 事件，前端通过来源标记显示“已整理这次纠正”，不增加独立操作入口。

ExperienceRuntime 只观察 Lead；由用户消息开始、浏览器 tool_execution_end 收集有限文本、agent_end 封存，abort/takeover 标记 interrupted。结束、工具成功和模型自述均不证明任务成功，本轮任务结果默认 unknown；逐条观察另存工具是否失败。仅直接用户纠正且有同会话同网站的任务观察时进入整理，未启用成功轨迹自动提炼。

每个任务独立原子写入 `~/.sideagent/experiences/{id}.json`。本地落盘队列与后台普通模型调用分开；任务有 pending/done/failed 状态，最多3次尝试，可恢复 pending。模型输出必须包含与输入逐字一致的纠正和观察引用；整理只能生成待验证文本建议，无工具、无执行权限。

记忆首次发布按 topic 检索，避免“核对结果”等模板词把无关任务召回；用户编辑后按新文本选择。适用范围默认当前 hostname。来源 runId 保证发布幂等，不覆盖用户更新；forget 把 runId 记入 memories.json 的 forgottenExperiences，使后台重试不能复活。发生新的明确纠正时，只废止原任务实际使用且版本仍未变的经验，用户后来的修改优先。

当前页面若因另一会话占用而被既有隔离规则移除，不凭旧页面信息注入站点记忆。新会话应使用自己的页面；用户消息含唯一明确网址时，用该目标地址选择经验；否则需要起始 PageContext，本轮不会在中途导航后补入经验。EverOS 服务和语义检索未接入。

### 主 Agent 全局查看与页面调度

- `take_tab` 是主 Agent 的编排工具。普通 `switch_tab` / `close_tab` 自动协调页面：通过 ConversationManager 找到原成员，停止相关成员并等待扩展旧调用结束，再继续原操作。主 Agent 已离开的旧页面不要求停止它现在另一页面的任务。
- 内部 `worker_tabs` RPC 支持 `inspect` / `release` / `claim`。仅父 Agent 可调用，受用户接管写闸门约束；不暴露给 `browser_run`。`release` 只能释放本会话的 worker，不接受跨会话复合身份。
- worker 完成、失败、取消或启动失败后，Fleet 请求移交该成员的全部历史页面。保留页面及内容、父 Agent 当前工作指针和其他协作者；最后一个 worker 离开后页面恢复为父 Agent 独占。
- 扩展在移交前封住该 worker 的新调用，并排空完整的已开始调用。尚未开始的共享页队列写入取消。停止标记保存在 `storage.session`；worker 每次启动使用唯一身份，防止旧请求借复用身份继续操作。
- 子 Agent 仍不能跨越分配范围。主 Agent 接手时使用检查到的 conversationId 防止覆盖并发归属变更；原会话和请求方的用户接管闸门都必须允许操作。读取不需要接手。
