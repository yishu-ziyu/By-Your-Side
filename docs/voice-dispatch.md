# 语音与任务调度

本文描述当前工作目录中的实现，不代表已加载或验收完成。进度见[项目状态](STATUS.md)，证据见[验收台账](evals/20260909-voice-dispatch-results.md)。类型以`shared/protocol.ts`、`shared/task-actions.ts`、`shared/voice.ts`为准。

## 任务请求与回执

文字和语音通过`task_action{conversationId,request}`进入共享调度。request包含`requestId`、目标`conversationId`、`source`、`action`、`expectedRunId`，可带原话`text`、`context`、`attachments`。控制动作还可带`scope`和`tabId`。动作限于start、steer、status、pause、resume、abort。

`requestId`标识一次请求，`runId`标识实际任务。暂停和恢复保留任务身份，新任务重新生成。执行前核对expectedRunId；任务已被替换时拒绝。语音请求编号固定到voiceId与turn，复合指令另加步骤编号。

回执通过`agent_event`的notice携带`receipt`，包含原话、目标名称、目标/来源会话、任务身份、结果及时间。`task_receipt_query{conversationId,requestId}`查询已有回执，不重做动作。

| 状态 | 含义 |
|---|---|
| accepted | 任务或修改已接收，网页结果尚未因此被证明 |
| applied | 控制已确认，或只读状态查询已完成 |
| rejected | 未执行，条件或输入不成立 |
| failed | 明确失败；控制可能部分完成，需读message |
| unknown | 执行结果无法确认，不能自动重做 |

回执存于本机`~/.sideagent/task-receipts/`。同会话同编号只接受同一内容；冲突拒绝。先持久写pending，再调用执行器，最后写结果。写入pending失败不执行；已有记录损坏、崩溃或结果落盘失败保留unknown。pending不是用户可见的成功状态。记录暂不自动清理，避免旧请求在清理后再次执行。

## 页面控制

控制走`task_control`到扩展，扩展复用原接管、交还、中止流程，最终回`task_control_result`。内部takeover/handback/abort携带taskRequestId以匹配在途请求；终止还等待`task_control_ack`确认执行端停下。两端等待均有45秒边界；超时不等于成功。

语音pause默认整个会话团队。已有单页入口保留page范围。暂停排空在途操作后才确认；暂停时steer只保存，resume采集最新页面并交给原任务。恢复期间partial且仍有restoring成员是中间状态。runId与成员执行代次共同拒绝旧写入。abort等待执行端停止及页面排空，不能直接把模型abort当作网页已停。

## 语音连接与分流

语音连接归开启它的面板与会话。start开启连接；interrupt开始新轮并停止旧播报；audio发送PCM；commit提交本轮及所选资料；playback_done报告播放结束；stop关闭语音。关闭语音本身不终止网页任务。切换会话关闭原语音，后台任务仍按各自会话运行。

Step产生转写，当前执行模型在无工具调用下分类，应用校验后调度。普通chat、只停声音silence、澄清clarify不进入任务写操作。非法输出允许在同一15秒预算内重新分类一次，仍失败则不执行。没有重试已接受的动作。

控制和查询播报使用应用确定的文字；整段音频的对应转写必须与该文字吻合才释放，最多两次生成，否则保留文字回执。一般闲聊仍由语音模型回答，不能把这个事实约束误认为对所有闲聊输出的全面校验。

重连沿用原voiceId、轮次和请求身份。已有转写/回执不重新调度；尚未识别的当前音频可用于恢复输入。旧连接事件不再生效。最新代码把一轮恢复限制为三次失败重试，连接29分钟到时结束。真人暴露的旧计数重置缺陷已修但尚未实测重载；网络最初为何中断仍未知。

`TaskProgressSnapshot`只反映观察到的任务状态，successVerified固定false。idle表示本轮结束，不能据此宣布任务成功。状态主动播报会去重并核对当前runId，避免旧任务结束通知覆盖新任务。

## 资料、目标与复合指令

commit可携带PageContext和图片附件，复用文字校验。页面补充期间如换轮、换会话或断线，旧commit不再发送。草稿正文不拼入语音指令。

讲话开始时捕获真实会话目录与runId。模型只提取名称，应用按精确或唯一子串解析；不接受模型编造ID。名称目录供同音词辨识，不是可执行指令。目标不存在或重名时先澄清整份计划。跨目标不会自动携带来源资料，只有明确引用当前页或所选内容才转交。跨会话回执带originConversationId，来源和目标均可查询；语音仍在来源，不自动切换侧栏。

运行中请求无关新任务先询问。待确认内容仅在同一语音连接、紧邻下一轮、90秒内的明确肯定后另开背景会话；否认、换连接、超时或改说别的使其失效。尚未提供持久的跨连接确认。

复合动作按序接收，前一步失败即停止后续。原话片段不能交叉、倒序或重叠。已接收的步骤不能因后来插话被声称撤回。真实复合恢复路径尚未通过当前版本验收。

## 新增只读页面问答

observe是语音意图，不是TaskAction。用户要求看当前页面时，以提交时的tabId调用snapshot和screenshot，再把实际文字和图片交给现有多模态模型生成回答。不向模型提供页面写工具，不新建浏览器任务。网页和图片里的指令当数据处理。

每个读取步骤及模型回答前后检查轮次有效性。缺页面、读取失败或无可用回答时如实说明。只观察浏览器标签页，不是整个macOS屏幕，也不持续录像。当前只支持所选页；指定另一个会话先澄清。该路径已做聚焦测试，真实页面语音观察仍待验收。

## 维护入口

- 调度：`agent/src/conversation-manager.ts`、`task-dispatcher.ts`、`task-control.ts`。
- 听说：`agent/src/voice-session.ts`、`voice-service.ts`、`voice-intent.ts`、`voice-receipt.ts`。
- 执行与只读模型回答：`agent/src/session.ts`。
- 扩展控制与页面资料：`extension/src/background/index.ts`、`voice-relay.ts`。
- 面板播放、状态与回放：`extension/src/sidepanel/voice-client.ts`、`voice-ui.ts`、`main.ts`，`extension/src/background/panel-history.ts`。

复验脚本和版本证据要求统一列在验收台账，避免把本文的实现描述当作验收结果。
