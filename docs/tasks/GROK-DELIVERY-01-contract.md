# 显式用户消息交付：当前唯一实施任务单

2026-09-09 16:14。用户要求三个执行者有效协作，并提醒不要重复派单。本文件覆盖先前消息中的单人范围/flat phase接口/待方案状态；不执行旧队列的重复开工或重复方案任务。冻结标准仍是 docs/evals/20260909-explicit-user-delivery.md，条件不变。

## 决定

实施已授权，无需再做方案或请用户确认。Agent内部工作与正式用户消息分开。Lead本轮send_user_message为主；有事实却缺最终交付时同任务模型最多一次补写，仍失败就明确未交付，不截取内部全文冒充成功。存在任务事实的内容追问用现有任务模型组织reply，Step只朗读这份正文；普通问候/闲聊不强制额外completeSimple或整段缓存。start accepted只登记ack，保持已通过的生成路径。ack不清偿finding。

不新增第三模型/provider，不改变控制、恢复、页面权限，不重新执行不确定写入。长文/无效参数拒绝重写，不截尾丢约束。不自动重播已播放或被打断内容；关开语音不主动播旧结果。状态仅表示应用/播放器进度，不表示人已听懂。

## 文件归属

| 执行者 | 唯一归属 | 本轮交付 |
|---|---|---|
| Grok / workspace:3 surface:11 | agent/src/{session,prompt,task-progress,conversation-manager,voice-session,voice-service,voice-receipt}.ts；必要agent/src/tools.ts、已创建agent/src/user-delivery.ts；自有agent/test/user-delivery-runtime.test.ts | 宿主send_user_message工具、内容追问、一次补交、ledger接线与Step只读交付；Lead agent_start带deliveryMode:'explicit' |
| Kimi / surface:4 | shared/voice.ts、shared/protocol.ts、agent/src/user-delivery-ledger.ts；自有agent/test/user-delivery-ledger.test.ts | 下述固定类型/校验、事件、ledger；不做运行时或UI |
| Anti Gravity / surface:5 | extension/src/sidepanel/main.ts、voice-ui.ts；必要extension/src/background/panel-history.ts；自有extension/test/user-delivery-ui.test.ts | 正式气泡按id只显示一次，状态更新不重复；新运行内部text_delta留执行过程；旧history无标记仍正常可见 |
| Boss / surface:3 | docs/evals、NOTES/STATUS/devlog、所有*-evaluator.test.ts及scripts/acceptance | 独立标准、集成审查、类型/全量/构建/真实UI和语音验收 |

所有人共享工作区。不得回滚、覆盖、格式化别人的修改，不修改别人的归属文件。Kimi和AG不要再接旧轮修补；Grok不要写shared/ledger/extension。CSS/恢复/transport不在本轮范围。

## 冻结接口

shared/voice.ts导出：

```ts
interface UserDelivery {
 conversationId:string;
 id:string;
 runId:string|null;
 kind:'ack'|'finding'|'reply';
 text:string;
 replyTo?:string;
 composedAt:number;
 status:'composed'|'speaking'|'played';
}
```

- VoiceConversationContext.latestDelivery?:UserDelivery|null；原latestResult继续单独保留作事实，不升级successVerified。
- AgentUiEvent新增{kind:'user_delivery';delivery:UserDelivery}；agent_start增加deliveryMode?:'explicit'。
- text非空、最大2000；id/conv/run/时间/状态严校验；事件envelope与record conversation一致。旧snapshot无latestDelivery仍兼容。
- 新Lead运行发deliveryMode:'explicit'，内部text_delta进既有执行过程，正式气泡只吃交付。旧历史没有该标记保留旧答案显示。worker无标记、不能注册send_user_message。

agent/src/user-delivery-ledger.ts导出：

```ts
class UserDeliveryLedger {
 constructor(conversationId:string);
 beginRun(runId:string|null):void;
 record(delivery:UserDelivery):boolean;
 latest():UserDelivery|null;
 hasFinding():boolean;
 markPlayback(id:string,status:'speaking'|'played'):UserDelivery|null;
}
```

record首次有效为true；重复、越界、相同id改文为false。latest返回副本；迟到ack不覆盖finding/reply。hasFinding仅判断本run曾有finding，不被ack改变。markPlayback只更新本run已知id，不倒退、不造正文。beginRun清空本run，旧run后续不能写入；null-run闲聊允许。不要扩大成消息框架。

Grok在TaskProgress新run时beginRun、收到user_delivery时record、首次成功后记recentTurns。worker/run过滤仍在TaskProgress。Agy用delivery.id渲染/更新一次，voice-answer消费相同正文，不自行润色。若真的有接口硬冲突，报告一个具体阻塞，不越权修另一个模块。

## 回报与检查

三人只跑本模块聚焦自测/归属类型检查，不跑全量、不改Boss测试。完成或确切阻塞直接一次cmux回报Boss，之后停笔。不要因旧队列消息重复做任务。

报告文件：docs/tasks/GROK-DELIVERY-01-report.md、K-DELIVERY-01-report.md、AG-DELIVERY-01-report.md。回报目标workspace:3 surface:3，发后Enter；不轮询其他终端。报告包含实际文件/检查/新增模型调用/延迟代价，估计不当实测。

不提交、不推送、不重载扩展，不操作用户浏览器。Boss会用真实生产侧栏→任务模型→VoiceClient/Worklet→Step→播放器检验同一交付和不重复，再交用户判断听感。

16:18交接纠正：Grok未消费新分工前已创建user-delivery.ts工具/组织辅助函数，并写过shared初稿；Boss已结束旧执行保留代码。Kimi的ledger落单独user-delivery-ledger.ts，避免与工具辅助函数争同文件；shared由Kimi收敛为上列三kind与nullable runId。Grok恢复原会话后仅改当前归属，旧队列不再执行。
