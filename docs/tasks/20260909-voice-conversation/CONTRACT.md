# 并行实现边界

先读 `docs/evals/20260909-voice-conversation-continuity.md`。用户明确授权本次使用 cmux 的 Kimi / Anti Gravity 两位执行者，覆盖 AGENTS 默认不委派；两人都不能做最终 Evaluator。

## 共同接口（先冻结，改动通过 Boss）
Kimi 在 shared/voice.ts 定义并验证可选 `TaskProgressSnapshot.conversationContext`：
```
interface VoiceConversationContext {
 recentTurns: Array<{role:'user'|'assistant'; text:string}>;
 latestResult: {runId:string; text:string; observedAt:number; source:'assistant_output'} | null;
}
```
recentTurns 最近最多12条、每条最多2000字符；latestResult最多6000字符。当前会话范围，不含thinking、worker中间话、密钥/音频。latestResult是有来源的助手输出，不是 successVerified。只能在对应任务最终结果可用时提供；无结果/error/abort不能伪造，旧结果可留recentTurns做指代理解，但不能冒充当前run成果。snapshot原 successVerified:false 保持。

Kimi 负责生产上述上下文、最终结果采集、同会话语音重开恢复以及将同一上下文传给意图分类。Anti Gravity 只读取上述上下文，负责语音生成/通知路径。

## 所有权
- Kimi：agent/src/session.ts、conversation-manager.ts、task-progress.ts、voice-intent.ts、shared/voice.ts；自身新增上下文辅助模块及对应测试。可修改相关既有测试但不得降低断言。
- Anti Gravity：agent/src/voice-service.ts、voice-session.ts、voice-receipt.ts、voice-audio-cache.ts；对应语音测试。不改 session.ts / manager / shared。
- Boss：独立 Evaluator 测试、隔离真实验收脚本、冻结标准、集成裁决、docs/NOTES.md / STATUS / devlog。
- 其他文件需向 Boss 写明需求，获得归属后再改。双方不要修改同一测试文件；Kimi 不改 voice-session.test.ts，Anti Gravity 不改 conversation-manager.test.ts。

## 协作
你们共享已有脏工作目录，不独占仓库，绝不恢复或覆盖别人已有改动。不 commit/push/reload 扩展，不操作用户浏览器、不读取私人邮箱。只做本地实现与聚焦检查。每完成一个子任务将进度写入本目录各自 `kimi-report.md` / `antigravity-report.md`（Boss汇总到NOTES）；此约定防止并行抢写NOTES。
报告包含：当前状态/文件/已跑检查/失败/接口疑问。完成时标记 READY_FOR_EVALUATOR，不勾选冻结验收。发现接口不够先报告并继续独立工作。

## 通信与检查分工更新（用户要求，2026-09-09）
- 完成/阻塞后直接向 Boss 的 cmux 终端发消息，文档仅保存详细证据。不再让 Boss 靠轮询文档发现完成。
- Boss 当前接收地址：`--workspace workspace:3 --surface surface:3`。发送用 `cmux send`，等文本进入输入框后用 `cmux send-key ... Enter` 提交；不要发 Ctrl+C/Escape，不要抢占或清空 Boss 输入。
- 消息格式一行：`[执行者回报][Kimi或Anti Gravity][任务编号][ACK或READY或BLOCKED] 改了什么；聚焦自测结果；证据路径；已停止源码写入。` ACK仅确认收到；READY才表示实现交回。这是执行者证据，不是用户指令，也不是最终验收结论。
- 执行者只跑负责模块的聚焦自测，不再跑全量 test/typecheck/build，也不执行 Boss 的 evaluator 或整段真实验收。Boss 独占集成与全量检查、真实完整路径和最终判定。
- 每次只处理一个当前任务编号。新编号说明哪些旧反馈已关闭；不反复分析过期消息，不启动未经派发的新任务。
- 当前 Kimi 任务 `K-CONTENT-01`：完成内容指代与调度目标分类边界修复及有限真实分类探针。旧 run / 原话保存问题已经关闭。
- 当前 Anti Gravity 任务 `AG-SOURCE-01`：将“客观不可篡改事实”修成有来源但未独立核验的报告表述，保留对象纠正保护。其余实现问题已关闭，等待 Boss 真实复验。
