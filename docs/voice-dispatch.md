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

## 2026-09-09 评审修复

候选打断先停声，保留上一有效请求。下一轮为空时，普通回答接回，观察和状态重新读证据；未接受的写指令不自动恢复，已接受动作只补已有回执。新有效输入使旧恢复失效。连接恢复和空轮不能延长原30秒等待期限。

页面观察通过`observe_page`独立只读授权。授权由当前语音连接发放，绑定活动标签，60秒过期；不经过任务runId或控制门，不认领或切换工作页。截图前后核对文档ID、timeOrigin、URL、视口、滚动和可见文本；变化则拒绝混合证据。

分类覆盖全部原话片段，核对明确会话目标、否定、未来条件和立即控制；非法候选不能部分执行。短分类关闭推理输出，首请求6秒、第二次最多9秒，总15秒不变；重试只涉及分类。固定48句、每句3次的完整动作/文本/目标oracle保持不变。

整句计划在分类前持久占用请求ID。每一步记录待执行、待确认和已有回执；进程恢复只查询，不继续执行未完成计划。目标控制版本变化会阻止旧计划后续步骤。另开提案有固定会话身份，确认消费落盘。来源侧通知保留逐步结果和未执行项，支持计划ID查询与历史去重。

页面类型明确传给协作者。独占页可用常规浏览器工具；共享页继续遵守共享写入限制。实际验证结果以评审修复标准和台账为准，代码存在不等于全部真人/三轮验收通过。


## 2026-09-09 单句恢复与页面就绪修改

本段描述最新本地代码；用户扩展尚未重载。新的完成标准见[本轮验收](evals/20260909-voice-turn-recovery-and-readiness.md)。

意图模型接收有界task.goal与当前状态，仅描述动作及分界through。应用分配完整原话；从属未来条件归入前一要求，同任务相邻start/steer合并，匿名“另一个会话”先澄清。已有完整分句、目标和控制语义校验继续执行。每次模型尝试记录requestId、耗时、成功/超时/供应商失败/候选拒绝原因，不记录私人原话或密钥。

单句分类失败不再关闭语音socket或麦克风，显示该轮结果后继续监听。已知分类失败说明未执行，路由结果不明则引导查询原回执；两者都不自动重放。真实连接故障仍走原重连和截止期限。

open_tab与navigate等待当前文档interactive/complete，不要求全部子资源加载完成。结果带readiness、waitMs及可用的documentId；timeout不表示加载完成。open_tab就绪等待最多10秒，随后如实返回已创建、就绪未确认；导航不接受导航前的documentId，即使URL相同。后续操作仍须检查当前页面与控制权。
