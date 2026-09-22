# 任务：解释21:15–21:17真人试用中的持续异常播报

本轮只读排查及一个内存事件探针，未改产品代码、未重载、未运行模型或全量测试。

## 证据与结论

- voiceId：bdb66c77-feb7-4759-be9f-0c6835b61410；conversationId：c2d8c54f-f4a0-4305-b298-aeb89c7cfbfe。
- 原始源：~/.sideagent/agent.log、~/.sideagent/voice-capture/2026-09-21.jsonl；本轮连续采集副本：out/acceptance/20260921-2110-live-monitor/events.jsonl。
- 21:15:48与21:15:56发生两次tabs工具调用，均成功；账本第二次有切换tab:29964958的已执行结果。之后谈到评论区、说“要滚动到”、再反馈“你还是没滚呢”，没有scroll、snapshot、judge_browser_action调用。不能把语音生成当作浏览器操作。
- 只有两次notify_queued（76、71字符）；21:16:28至21:16:59却发送六次notify_sent，后五次均71字符。21:16:28–43没有新用户话轮启动，却连续产生四个requested=true回复。此段没有provider_error，也没有上一轮审计锁死的工具错误。

## 已确认的通知循环

RealtimeVoiceSession.notify对无正式delivery的状态调用notifyTask(text)，不带delivery ID。VoiceService.observe仍会在直接工具状态转idle后、后续状态消息到来时发送这类旧任务系统的空闲通知。

RealtimeVoiceConnection在conversation.item.created后保存creatingNotice，但response.created的消费条件要求creatingDeliveryId存在。普通状态通知没有这个ID，于是进入else分支，将同一通知重新放回queuedNotify。播完后maybeFlush再发送，再次触发相同分支。无新输入也可重复。

另外，maybeFlush在已接收一个通知、wantResponse=true时仍优先发送下一个排队通知，因此前两个通知在28.822/28.864快速连续发送，creatingNotice可能被后者覆盖。此次重复的71字符通知与这一顺序一致。

## 最小复现

/tmp/bys-notice-loop-probe.mts：用当前生产RealtimeVoiceConnection和内存Socket，只调用notifyTask一次；模拟通知已接收、response.created、response.done。结果externalNotifications=1、notificationsSent=2、sameText=true。无需真实模型即可复现程序自行重发，排除必须靠模型重复生成才会出现这个循环的解释。

## 修复建议（尚未实施）

1. 将普通状态通知是否已被本轮消费与是否有正式deliveryId分开。合法通知都只消费一次；deliveryId只用于正式交付播放关联。
2. 已被接收、正在等待生成的通知不被后续通知覆盖；完成或确实被打断后才推进下一项。
3. Realtime直接工具结果已返回本轮，不再另外排“任务idle”通知；必要后台结果和真实控制结果保留。

上述修复针对程序重复播报。不把它自动算成滚动不执行、识别半句、真人音色异常的全部根因。助手逐字口语没有完整持久化，不能声称已还原其具体重复话语；这轮原始音频未试听。
