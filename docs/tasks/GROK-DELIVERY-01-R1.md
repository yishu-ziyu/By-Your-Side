# GROK-DELIVERY-01 R1：Boss交回的单批验收修复

这是同一任务的验收修复，不重新规划、不另起任务。Grok只修当前Agent归属；允许为回调接线最小修改agent/src/main.ts。shared仍归Kimi，extension已通过并停笔。Boss测试/脚本不改。

## 已复现且必须修正

1. `agent/test/user-delivery-runtime-evaluator.test.ts` 3项中2红：
   - 任务结束补写pending期间出现error，迟到补写仍发finding。补写发出前重新检查同run、状态/控制版本、是否仍欠交付；错误/暂停/终止后不补成功正文。
   - 来源追问pending期间用户通过文字开新任务（voice stillCurrent仍true），旧追问被publishDelivery按“当前新runId”重新贴牌。必须锁住最初run/控制与来源身份，晚到丢弃，不能只看voice turn。

2. 新真实生产侧栏+M3+Step失败：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-user-delivery-N5jA03/result.json`与task-events.json。
   - 另查明工具和explicit标记被错误绑到memoryRuntime：createConversationRuntime默认options没有memoryStore时，这个真正Lead没有send_user_message，走了全部事后补交。交付不能依赖记忆功能开关。Fleet worker未传conversationId，可据真实Lead身份注册，别用memoryRuntime猜角色；实际新Lead必须发explicit标记。
   - 唯一正式finding是“收件箱里最近三封邮件的标题分别是…看起来是研究、工作坊和阅读类各一封。还没有打开正文。”
   - 实际播出是另一段“好的，我帮你看了下，最近三封邮件的标题分别是…正文我还没打开。”
   - Boss已另有确定性红测 agent/test/user-delivery-speech-evaluator.test.ts：先排idle通知，300ms内raw结果到达但delivery仍null，不能对Step发起结果改写。
   - StepVoiceSession.tryAnnouncement仍有hasResult分支直接把内部facts交Step改写；没有delivery时的通知竞态会进入它。新显式运行只能按已交付正文朗读，补交pending时不抢先播原报告。也检查事实chat compose失败不退回Step对长JSON另写一份。保留普通无来源闲聊。

3. 使用Kimi已READY的 `agent/src/user-delivery-ledger.ts`。目前TaskProgress仍import ./user-delivery.js里你暂写的重复Ledger，导致他的模块没进真实链。改import并移除你自己的重复类；保留你自己的工具/compose helpers。

4. start accepted不应发布“收到，即将开始处理。”占位交付。按批准要求登记实际已经生成的语境化接收回应，不额外再发一份通用ack。保留K-ACK-02语境生成，不能用通用ack顶替最终finding。可最小增加VoiceService→manager回调及main.ts接线，禁止新模型调用。

5. 播放状态要真的接入ledger：当前VoiceService的playback_done没有对应markPlayback调用。将responseId映射到明确delivery.id；只给该id推进speaking/played，不能给“当前最新消息”误打已播。中断/旧连接/未知id不得标为played。必要回调同上；告知Boss新增构造参数用于真实脚本接线。

## 全量现状

Boss typecheck/build通过。首次全量871项中4失败：上述runtime两项，另两项旧测试要求raw结果进入recentTurns/直接notify。后两项与新冻结“内部事实不算正式交付”相反，由Boss作为Evaluator审定更新；你不要为了它们恢复新显式路径的raw fallback，也不要改这些旧断言。其它867通过。

补交最多一次，真实调用数/延迟按事实记录。完成聚焦自测后一次READY回报，停笔；不要跑全量/真实浏览器/改Boss测试。
