# SideAgent 桥接协议

background service worker 与任务宿主之间的协议；优先走本地伴随进程的 native messaging，未安装时接扩展 offscreen 里的同一任务核心，WebSocket 用于调试回退。侧栏通过扩展内部 Port 连接 background。
权威类型定义见 `shared/protocol.ts`，本文档描述流程与语义。任务身份、持久回执、语音连接及只读页面问答另见[语音与任务调度](voice-dispatch.md)，对应类型也包括`shared/task-actions.ts`与`shared/voice.ts`。

## 传输与握手

以下 token、Origin 与单客户端握手规则适用于 WebSocket 回退通道。native messaging 由 Chrome 拉起伴随进程，通过 host 的扩展白名单限制访问。

offscreen 入口使用扩展内部 runtime Port；background 先送模型配置与凭据，再送 `hello`。任务、工具结果、会话和语音控制继续使用下面同一套消息与身份，`inproc_config`、`inproc_voice` 和保活帧只在扩展内部传递。配置前的只读查询不会被误报为任务失败；真正的任务输入会返回明确拒绝回执。

- WebSocket 模式监听 `ws://127.0.0.1:7758`（仅回环地址）。
- 启动时生成随机 token 并打印到终端；用户在面板首次设置中粘贴一次，存 `chrome.storage.local`。
- 连接后客户端第一帧必须是 `hello{token, client:"sidepanel"}`。
- 服务端校验：token 匹配 + WS 握手的 `Origin` 头以 `chrome-extension://` 开头。
- 成功回 `hello_ok{version, model, features?}`；失败回 `hello_error{error}` 并关闭连接。`features{memory, skills}` 说这个宿主有没有记忆、技能存储（只装扩展时都是 false），侧栏据此收起只会失败的入口；旧宿主不带时按有处理。
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

当前任务与控制入口还包括共享 `task_action`、`task_view` 和独立交付消息；见[任务调度](voice-dispatch.md)。`notice` 带 `progress: true` 时只是运行中的进度，面板只替换过程行标题，不进消息流、历史回放忽略。`task_view.latestDelivery.unfinished` 是模型在部分交付里列出的未完成项，只用于侧栏那一行文字，不参与 `resumable` 判定或结果核验。下面保留基础/兼容帧说明，不是完整协议清单。

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
                                   #   tool_start / tool_end / tool_late_result /
                                   #   turn_* / agent_* / notice / error
```

worker 事件带自己的 `sessionId`，面板把它们显示在所属用户会话的团队状态中。`abort` 只中止指定用户会话；停止单个 worker 只撤销该成员。`takeover` / `handback` 保留会话与标签绑定：接管先阻止目标页新写入，等待已在途短动作到安全停止点，再暂停该页全部协作者。其他会话的独立页继续。交还为各成员读取绑定页的新快照；关闭或读取失败的页面保持暂停，不把当前活动页替代进去。


`text_delta` 聚合成当前助手消息；`tool_start`/`tool_end` 以 `toolCallId` 配对渲染为可折叠卡片。`tool_late_result` 是晚到/重复回执，只按原 SDK 调用 id 关联任务账本，不渲染新卡片。`tool_end.declined`：用户在授权卡上点了「拒绝」，没执行但不是失败，账本不留待办。任务视图里带 `awaitingConfirmation` 的项是被拦下、等页面确认的点击；它不妨碍别的会话接手这一页，接手时旧确认一并收起。

### 工具调用（RPC）

```
server → tool_call{conversationId, id, name, params, sessionId?}     # name ∈ TOOL_NAMES；工人调用带 sessionId
client → tool_result{conversationId, id, ok:true, data, executionFact:"executed"}  # data 形状见 ToolContract
       | tool_result{conversationId, id, ok:false, error, executionFact}  # executionFact ∈ not_executed | unknown | executed
```

- background 从上行连接直接接收和执行 `tool_call`，结果原路回传；工具执行不经过侧栏，关闭侧栏不会停止任务。
- 伴随进程侧 RPC 默认超时 30s（`navigate`/`screenshot` 60s），超时/断连即以错误结果结束该工具调用。
- 扩展侧任何异常都必须回 `ok:false` + 一行人类可读 error，不允许挂断不回。
- 发出前就拒绝的调用回 `not_executed`，并在 error 里说明可行的替代做法：`fetch` 指向本机或私网地址时，提示改用 `open_tab`/`navigate` 打开后再 `snapshot`；`wheel` 的工作页处于隐藏状态时（窗口未聚焦、不抢前台），不派发任何滚轮事件，提示改用 `scroll` 或请用户切回窗口。

`browser_run` 在本地解释器执行，不是新增的扩展 RPC 工具。它的每个浏览器子调用仍使用上述帧，并附带可选 `programId`。接管/排空期间，该程序的所有子调用都被拒绝，包括普通情况下允许的只读工具；原独立工具行为不变。生产装配中，内部开始/结束直接同步转成既有步骤事件，先登记子调用再执行权限检查，使用 `父调用ID/序号` 关联；独立工具包装器仍可回传SDK进度，但不能把异步进度队列当作权限登记前置。详见[组合执行](browser-program.md)。

## 用户指出元素

文字任务的主会话可调用 `ask_user_to_point`，请用户在工作页指出一个主文档 DOM 元素。点选层显示悬停轮廓和说明，吞掉用于选择的鼠标输入；Esc 取消，普通键盘输入也不穿透到网页按钮。此工具需要页面控制权，但不产生持久写入义务，后台成员与共享页不能占用它。

点选回执是 `selected`、`cancelled` 或 `timed_out`，准确类型见 `shared/point-selection.ts`。选中时返回可直接用于后续已授权操作的定位串和文档身份；这不构成点击、提交或保存授权。取消或超时不能猜目标，也不能自动重新请求点选。等待期间绑定具体文档和控制轮次，停止任务会撤掉点选层；之后页面变化时仍须重新观察、重新定位，不能跨文档复用选择。

等待用户的期限为 90 秒；独立工具给 RPC 留 100 秒传输预算，不改变其他工具的默认超时。当前没有接入 Realtime 语音工具表，不支持 iframe 与自定义 Shadow DOM 内部点选。[实现范围与真实路径证据](evals/20260923-user-points-element.md)。

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

`read_elements{tabId?, selector, limit?}` 按 CSS 选择器（或 `loc=css:...`）一次性读取全部命中元素（按文档顺序取前 `limit` 个，默认 60，1–200），返回每个元素的标签、文字（截 200 字）、可见性、位置矩形与六项计算样式，以及只指向这一个元素的 `target`（`loc=css:` 路径：唯一 id 优先，否则逐层 `:nth-child`，页面内核对只命中它一个；算不出来就缺省），可直接交给 click/mark/read_element，供圈注、标注一类结果核验取证；不接受 `@ref`。零命中返回 `total:0` 与空列表，不算错误；输出超过安全上限时明确报错，不返回部分内容。只读，不修改页面、不注入样式。

## 面板恢复与 Pi 持久化

扩展内部 relay 使用 `select_conversation{conversationId}` 切换显示，`sync{conversationId, afterSeq?}` 按会话同步历史；历史和状态 envelope 带 `conversationId`。选择项保存在 `chrome.storage.session`，聊天历史与各会话的输入草稿、待发送附件保存在 `chrome.storage.local`。历史序号单调递增，新一轮用户消息不会清空前面的轮次。

Pi 上下文保存在 `~/.sideagent/conversations/{conversationId}/` 下的会话文件及索引中。伴随进程重启后可恢复对话上下文；重建实例不会自动重放旧任务或继续原页面动作。前端历史只负责展示，不能替代 Pi 的原生上下文恢复。

## 跨会话记忆

`memory_list{conversationId,requestId}` 读取个人记忆；`memory_update{conversationId,requestId,id,expectedVersion,text,scope}` 纠正内容与范围；`memory_forget{conversationId,requestId,id,expectedVersion}` 忘记。响应为 `memory_result{conversationId,requestId,action,ok,entries?,entry?,deletedId?,error?}`，回到请求所属会话。修改和忘记须匹配当前版本，失败不能呈现成功回执。

`scope` 为 `{kind:"all"}` 或 `{kind:"site",hostname}`。站点范围只约束使用，个人管理列表仍展示全部条目。条目包含 id、version、text、scope、sourceConversationId、createdAt、updatedAt；内容最多 2000 字符。

当前 Lead 工具为 `user_memory`：`recall` 查询任务所需资料，`change` 按当前直接用户请求解释保存、修改或忘记。语义解释由 `memory-decision.ts` 完成，运行时核对输入当前性；网页、附件、工具输出及 worker 不能自行授予记忆修改权限。检索由 `MemoryStore.select / resolveSelected` 选择并复核版本，通过 Pi 单轮提示使用。`agent_event` 中的 `memory` 事件记录 saved/used 及条目快照，历史回执不随之后的修改而重写。

Lead 工具 `artifacts` 为用户写文本文件（csv、md、txt、json、html、svg、js、css），命令沿用 Pi web-ui 的约定：`create`（同名已存在则失败）、`update`（`old_str` → `new_str`，找不到时返回全文）、`rewrite`、`get`、`delete`。文件只存在本会话内存，单个上限 256 000 字符，文件名只许一层并带扩展名。每次保存发 `agent_event{kind:"artifact",action:"saved",filename,content}`，删除发 `action:"deleted"`；侧栏画成带「下载」按钮的卡片，回合结束时挪到回答下面，CSV 下载时加 BOM。事件随侧栏历史回放；宿主重启后模型不再能 `get` 旧文件。

数据当前存于操作系统用户目录 `~/.sideagent/memory/memories.json`；原子替换与写锁保护并发修改。忘记会移除有效条目，后续新轮次不再读取它；原聊天仍保留。当前没有按 Chrome 配置分别选择存储目录，不能宣称已实现浏览器配置隔离。

## target 定位串

`click`/`hover`/`fill` 的 `target` 接受：`"@N"`（最近 snapshot 的 ref）、`"loc=css:..."`（snapshot 给出的稳定定位串）、原生 CSS 选择器；`click`/`hover` 另接受 `point:[x,y]` 视口坐标。

ref 编号随节点保持稳定，但必须出现在最新快照中；新快照替换可用引用集合。无效、失效、未找到或匹配多个元素时明确报错并要求重新定位，不猜测另一个目标。Playwright 的 `:has-text()` 和 `loc=h3...` 不受支持。

`hover` 派发真实 CDP `mouseMoved`，触发原生 CSS 悬停状态；返回 `{hovered:true}` 仅表示移动执行成功。Agent 仍需观察是否出现预期入口。`click` 同样只确认事件执行，不证明编辑器打开或任务完成。接管期间 `hover` 和其他写操作一样被控制闸门拦截。

页面下载：`arm_event{type:"download"}` → 点页面的下载入口 → `wait_event`。`Page.downloadWillBegin` 把下载归到已 arm 的标签页，文件由 Chrome 存进用户的下载文件夹；是否下完只看 `chrome.downloads`（两者按 URL 对上）。`wait_event` 匹配后再等下载结束（默认最多 60 秒），`download.completed` 只在 Chrome 报 `complete` 时为真并带 `path`/`bytes`；中断时 `failure` 是 Chrome 的错误码，模型工具把它作为失败返回。`download_cancel` 不取消已下完的文件，`download_delete` 只忘掉记录、不删文件；本机伴随进程的 `download_save_as` 在完成后复制到指定路径。扩展调试通道拒绝浏览器级 `Page.setDownloadBehavior`，所以不再用它（[09-23 记录](evals/20260923-ci-gate-failures.md)）。

`mark` 可选 `through: "@N"`：同一行的结束 ref，一个框从 `target` 圈到它（用于「名称 + 数值」这类成对内容，先后顺序不限）。两者都必须是同一张快照的 ref；不在同一行、不在同一页面或不是 ref 时报错并记为未执行。框随两端之间的内容重排而重画。名牌依次试框的右、上、下、左，选第一处不压页面文字、图片或控件的位置；四处都压字时沿框的上沿、下沿往右找空白。

`mark` 可选 `actions: [{id:"confirm"|"cancel", label}]`：就地确认。带 actions 时光标飞到目标拿住，删除/取消一类按钮长在光标名牌上（不在框外）。用户点按钮时，content script 发内部 `mark_action`，background 转成 `user_message` 文本「确认」或「取消」（与侧栏打字同一条路）。点取消会先 `clear_marks`。

## 安全

- 仅绑定 127.0.0.1；token 校验；Origin 校验。
- 任何网页尝试连接 localhost WS 都会因 Origin/token 不符被拒。

## 本地诊断轨迹

`~/.sideagent/traces/*.jsonl` 按会话、任务、轮次与工具调用标识记录目标、模型、参数、返回、错误和耗时，以及接管/交还事件。日志写入失败不改变任务结果。只装扩展时，同样的行写进扩展的 IndexedDB（`sideagent-diagnostics`，格式由 `shared/run-trace-core.ts` 统一），同样只保留最近 20 个会话；设置页「诊断记录」可以导出成一个 jsonl 或清空。语音日常记录同理：行格式由 `shared/voice-capture-core.ts` 统一，扩展写进同一个库、导出为单独的 jsonl、保留 14 天，不存录音。输入工具的填写值默认隐藏；图片只留元数据，其他文本按敏感字段与模式脱敏。任务和页面文本仍属于本地私密数据。

目录权限 0700、文件权限 0600；每会话最多约 8 MiB，创建文件时清理到最近约 20 份。单条记录限制总字符和节点数，达到上限明确标记截断。日志是诊断证据，不作为自动停止任务或判定业务成功的条件。


## 经历、显式记忆与技能

它们分别由 `ExperienceStore`、`MemoryStore`、`SkillStore` 持有，不能把自动整理建议等同于用户已确认的事实或可自动执行的技能。经历采集与模型整理不是网页执行权限；保存做法后的匹配与复用仍须核对材料、页面和结果。

EverOS 是独立可选桥接，安装与边界见[桥接说明](integrations/everos.md)；普通源码安装不自动启用。本机启用历史见[记录](evals/20260916-everos-enable.md)，当前服务运行状态需要另行核对，不能再笼统写成“未接入”。

### 主 Agent 全局查看与页面调度

- `take_tab` 是主 Agent 的编排工具。普通 `switch_tab` / `close_tab` 自动协调页面：通过 ConversationManager 找到原成员，停止相关成员并等待扩展旧调用结束，再继续原操作。主 Agent 已离开的旧页面不要求停止它现在另一页面的任务。
- 内部 `worker_tabs` RPC 支持 `inspect` / `release` / `claim`。仅父 Agent 可调用，受用户接管写闸门约束；不暴露给 `browser_run`。`release` 只能释放本会话的 worker，不接受跨会话复合身份。
- worker 完成、失败、取消或启动失败后，Fleet 请求移交该成员的全部历史页面。保留页面及内容、父 Agent 当前工作指针和其他协作者；最后一个 worker 离开后页面恢复为父 Agent 独占。
- 扩展在移交前封住该 worker 的新调用，并排空完整的已开始调用。尚未开始的共享页队列写入取消。停止标记保存在 `storage.session`；worker 每次启动使用唯一身份，防止旧请求借复用身份继续操作。
- 子 Agent 仍不能跨越分配范围。主 Agent 接手时使用检查到的 conversationId 防止覆盖并发归属变更；原会话和请求方的用户接管闸门都必须允许操作。读取不需要接手。

## 元素状态与条件读取

`read_element`默认仍返回完整textContent和字段value。可选properties读取textContent/value/visible/enabled/checked/selected/expanded/pressed，以及audio/video的paused/ended/currentTime/duration。

`expect:{property:"paused",equals:true}`检查指定属性；文字可用contains。equals按属性区分布尔、数字和文字，布尔值不接受字符串。timeoutMs默认0，仅检查一次；最多5000ms在同一只读调用中有界等待。不匹配明确失败，匹配才返回`check:{matched:true,property,elapsedMs}`。这只是该目标该条件成立，不能单独推导整项任务成功。

原@ref、唯一CSS、标签权限仍生效。多个匹配、过期ref、无效属性立即失败；等待跨文档时拒绝结果。状态查询的模型正文只返回所请求属性与检查证据，默认全文读取不截断。browser_run可直接await browser.read_element使用同一参数和权限路径。
