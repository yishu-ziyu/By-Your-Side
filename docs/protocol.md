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
client → user_message{text}        # 空闲时发起新任务
client → steer{text}               # 运行中插话（映射 session.steer）
client → abort                     # 中止当前运行
server → status{state:"running"|"idle", sessionId?}
server → agent_event{..., sessionId?}  # 流式渲染：text_delta / thinking_delta /
                                   #   tool_start / tool_end / turn_* / agent_* /
                                   #   notice / error
```

省略 `sessionId` 或值为 `main` = Lead（用户对话那条会话）。工人事件带自己的 id；面板把工人收进彩色步骤行，不另开聊天线程。`abort` 中止整张图（Lead + 全部工人）。

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

## 工作标签页语义

- 每个 session（Lead 或工人）认领自己的工作标签页：`open_tab`/`switch_tab` 显式指定；未指定时采用该 session 已认领页，否则认领一个未被其他 session 占用的标签页。
- 所有省略 tabId 的工具默认作用于**该 session** 的工作标签页。
- click / type_text / press_key：仅当工作窗口**已经在前台**时才把该标签页切到窗口内前台。绝不 `windows.update({focused:true})`（会拽走 macOS Space）。工人本来就不抢前台。
- screenshot 一律先 CDP `Page.captureScreenshot`，失败再 `captureVisibleTab`。
- 工人之间不传活页面状态，只经伴随进程内邮箱传可搬工件（post / await_message，不进入本协议帧）。

## target 定位串

`click`/`fill` 的 `target` 接受：`"@N"`（最近 snapshot 的 ref）、`"loc=css:..."`（snapshot 给出的稳定定位串）、原始 CSS 选择器；`click` 另接受 `point:[x,y]` 视口坐标。

## 安全

- 仅绑定 127.0.0.1；token 校验；Origin 校验。
- 任何网页尝试连接 localhost WS 都会因 Origin/token 不符被拒。
