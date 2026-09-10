# Grok Bot 重建仓库：内部执行与用户消息如何分开

2026-09-09，只读调研。用户提供仓库并要求先调研交流设计，AG-SPEECH-R2已暂停。此次没有继续表达实现，没有运行该仓库的应用或安装脚本。

## 来源与范围

[b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed)，本次检出的版本为 `a9f633e09d49a85829b8236331b9e21f7e612634`。本地只读副本 `/tmp/ego-grok-bot-018-research-20260909`。

仓库自述是公开发布的macOS 0.18.0应用的非官方重建与扩展，含推断的模块名称，不能当成官方原始源码。此次结论只适用于读到的重建实现，不证明线上产品行为或语音效果。

## 已看到的设计

最接近用户说的那层，是 `SendMessage` 的显式用户消息通道。普通assistant文本和工具输出属于内部工作；模型必须把要对人说的话作为SendMessage参数发出。子代理只把结果交回父代理。

路径：工具结果 → 主Agent依据对话组织消息 → SendMessage({type, content, reply_to…}) → 参数校验/附件处理 → onSendMessage → transport.onUpdate → transcript的send-message记录 → 前端消息显示。

- [系统提示：工作与说话分开](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/runner/system-prompt.ts#L65)：子代理不能直接找用户；对话要先回应，工作结束再交付结果；开头确认不等于结果已交付。自然简短的口吻主要由该提示约束。
- [发送工具](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/runner/tools/send-message-tool.ts#L39)：text分支把raw.content交给消息，执行参数校验和附件/回复目标处理；这条链上没有调用第二个模型润色正文。等待用户选择时会拒绝继续发送。
- [发送接线](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/host-runner-composition.ts#L1808)：调用transport.onUpdate，拿回本地分配的消息ID。
- [实际transport](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/ports/transport.ts)：转交update给ingest，记录最后消息ID/表情是否应用；不负责语言重写、事实核验或口语总结。
- [前端文本投影](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/frontend/src/recovered/features/conversation/cards/transcript-card/send-message-text.ts#L102)：验证消息形状，保留content，选择普通文本或链接卡片展示。不是口语化模型。

## 交付不是只靠一句提示

[发送提醒中间件](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/runner/send-message-reminder-middleware.ts)记录上次发消息后工具调用次数，长时间无对用户消息时给模型补提醒；已经开口但工作又有进展时也会提醒结果要交出去。

[turn-runtime](https://github.com/b-nnett/grok-bot-0.18-reconstructed/blob/main/source/host/extensions/transcript/turn-runtime.ts#L538)结束前检查是否仍欠用户回复，在当前轮次有效时最多做3次回复提醒，另有静默工具结束后的收尾提醒。仍未交付会记诊断。底层Agent另有受feature gate控制的delivery-owed/empty-response重试逻辑。

这是“有没有发出消息”的机制，不是“消息内容一定正确”的证明。回传消息ID也不等于人已经看见或听见。

## 对By Your Side的启发（推断，尚未实现）

现在已有任务结果进入Step语音模型的表达步骤。这次失败不证明需要再加第三个模型，而是提示应该把工作事实与面向当前问题的交付内容分清楚。

可以先检验以下职责划分：

1. 执行端给出具体对象、发现、读取范围、未确认内容与回执状态。
2. 负责对话的部分据当前问句与前文，写出直接给人的回答；内容追问应说清所指对象，不能改写来源的实体关系。
3. 用户消息成为独立记录，区分“已接收”“有新发现”“正式答复”。界面展示与语音消费这份交付，而非把任意内部日志当回复。
4. 播放与重连只改变送达状态，不重新决定事实或重做网页动作。

例子：内部事实是“竹海工作坊活动邀请，仅读标题，正文未开”；用户问“活动那个呢？”；待交付回答可以是“你说的是竹海工作坊那封活动邀请。我目前只看了标题，还没打开正文。”这是假设方案示例，不是Grok实测输出。

是否由主模型直接形成用户消息，还是由现有语音模型承担表达，仍需比较延迟、事实保留和追问成功率。本轮只读调研没有作这个实现决定。

## 当前停点

断连恢复和底栏修复的局部独立测试、实际路径已有通过证据。表达回归仍有Markdown原文播报和指代不明确的真实失败，未宣布整体完成。保留所有代码，不提交、不推送、不重载用户扩展。下一步由用户判断是否按显式消息交付方向设计小实验。
