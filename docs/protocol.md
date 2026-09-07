# SideAgent 桥接协议

side panel（扩展页面）与本地伴随进程（Node + Pi SDK）之间的 WebSocket 协议。
权威类型定义见 `shared/protocol.ts`，本文档描述流程与语义。

## 传输与握手

- 伴随进程监听 `ws://127.0.0.1:7758`（仅回环地址）。
- 启动时生成随机 token 并打印到终端；用户在面板首次设置中粘贴一次，存 `chrome.storage.local`。
- 连接后客户端第一帧必须是 `hello{token, client:"sidepanel"}`。
- 服务端校验：token 匹配 + WS 握手的 `Origin` 头以 `chrome-extension://` 开头。
- 成功回 `hello_ok{version, model}`；失败回 `hello_error{error}` 并关闭连接。
- 单客户端策略：新连接握手成功则顶替旧连接（旧连接收到 `agent_event{kind:"notice"}` 后被关闭）。

## 消息流

### 对话

```
client → user_message{text, context?}  # 空闲时发起新任务；context = 发送时用户正在看的
                                       #   标签页{tabId,title,url}（background 转发前自动附上）
client → steer{text, context?}     # 运行中插话（映射 session.steer）；同样附当前页锚点，
                                   #   避免打断后丢工作标签
client → abort                     # 中止当前运行（任务结束）
client → takeover                  # 运行中拿回当时完整活跃组（Lead + 活跃 worker）。不结束会话。
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

省略 `sessionId` 或值为 `main` = Lead（用户对话那条会话）。工人事件带自己的 id；面板把工人收进彩色步骤行，不另开聊天线程。`abort` 中止整张图（Lead + 全部工人）。`takeover` / `handback` 是控制权，不是 abort：会话、对话、工作标签都还在。v2 一次接管冻结发起时的活跃组；交还按成员绑定页续跑，关闭的绑定页保持暂停且不阻断其他人。

`text_delta` 聚合成当前助手消息；`tool_start`/`tool_end` 以 `toolCallId` 配对渲染为可折叠卡片。

### 工具调用（RPC）

```
server → tool_call{id, name, params, sessionId?}     # name ∈ TOOL_NAMES；工人调用带 sessionId
client → tool_result{id, ok:true, data}  # data 形状见 ToolContract
       | tool_result{id, ok:false, error}
```

- sidepanel 收到 `tool_call` 后经 `chrome.runtime.sendMessage` 转 background 执行，结果原路回传。
- 伴随进程侧 RPC 默认超时 30s（`navigate`/`screenshot` 60s），超时/断连即以错误结果结束该工具调用。
- 扩展侧任何异常都必须回 `ok:false` + 一行人类可读 error，不允许挂断不回。

`browser_run` 在本地解释器执行，不是新增的扩展 RPC 工具。它的每个浏览器子调用仍使用上述帧，并附带可选 `programId`。接管/排空期间，该程序的所有子调用都被拒绝，包括普通情况下允许的只读工具；原独立工具行为不变。内部开始/结束通过 SDK 工具更新事件转成既有步骤事件，使用 `父调用ID/序号` 关联。详见 `docs/browser-program.md`。

## 工作标签页语义

- 每个 session（Lead 或工人）认领自己的工作标签页：`open_tab`/`switch_tab` 显式指定；未指定时采用该 session 已认领页，否则认领一个未被其他 session 占用的标签页。
- 所有省略 tabId 的工具默认作用于**该 session** 的工作标签页。
- click / hover / type_text / press_key：仅当工作窗口**已经在前台**时才把该标签页切到窗口内前台。绝不 `windows.update({focused:true})`（会拽走 macOS Space）。工人本来就不抢前台。
- screenshot 一律先 CDP `Page.captureScreenshot`，失败再 `captureVisibleTab`。
- 工人之间不传活页面状态，只经伴随进程内邮箱传可搬工件（post / await_message，不进入本协议帧）。
- `get_active_tab` 返回用户此刻正盯着的标签页（纯查询，不认领）；配合 `user_message.context` / `steer.context` 解析「这页面」类指代。插话延续当前工作标签页，不重新询问。

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
