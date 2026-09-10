# GROK-DELIVERY-01 R2：最后几条实际交付路径对齐

同一实验的验收修复，不另做方案。Kimi和AG模块已过独立验收并停笔，你只改Agent当前归属。一次集中回报，Boss脚本/断言不改。

## 1. 实际ack的run身份仍错（确定性红测）

agent/test/user-delivery-speech-evaluator.test.ts中“new run arrives: true”红：Step为run-a生成接收回应期间，文字已开run-b；VoiceService.onSpokenAck用回调时snapshot.runId把旧ack记到run-b。必须使用已接受的receipt的原run身份，不能回调时重新取当前run贴牌。可以把原runId由Step回传；新run/旧voice按原身份丢弃。正例不变。

## 2. 本轮工具在结束前发出finding，idle后却不播（确定性红测）

agent/test/user-delivery-evaluator.test.ts末项红：finding在running时发出，此时不主动播可以；但随后status idle/agent_end应把同一未播finding恰好播一次。目前只有user_delivery事件分支notify，后续idle不再notify，导致工具主路径可能静默。不得靠额外补写第二份finding来触发语音。

## 3. 工具类别含糊造成结果补发一遍（真实复现）

`ego-user-delivery-zqzDpa/task-events.json`（同前temp目录）中：Lead send_user_message用kind reply发出整个读邮箱结果；hasFinding为false，系统又compose并发出另一份同义finding。两份正式结果，用户看重复，且多了一次模型调用。

把任务工具的类别与闭环明确对齐。可让该宿主工具只接收ack/finding；reply保留给manager的事实追问/只读页面回答。参数schema和简短说明必须一致，最终任务成果用finding，不能发布一份reply后又补同义finding。保持record层三kind不变，不改Kimi共享接口。

## 4. 页面观察回答也必须登记为reply

本次“活动那个呢”被分类observe。Boss发现自己新测试桥漏了正式VoiceRelay会附的observation token，已补测试桥；这部分不算产品无页面缺陷，不要改分类器硬凑chat。

但当前manager.observe成功只emit notice和返回spokenText，没有user_delivery，这条真实对话分支绕过新交付层。应把已有answerVoiceObservation生成的正文登记为reply，并以同一正文/快照送语音；不加额外模型调用。保留页面读取来源验证、stillCurrent以及原run/control捕获检查。

页面问答允许当前没有task run：共享UserDelivery/ledger已支持null-run，请让发布reply的helper支持它，finding仍须有任务身份。之后追问可据该交付与来源继续，不应因为latestResult恰好为空就丢掉已经说过的页面答案。

## 验收现状

上一轮28个独立检查全绿，真实任务结果的explicit标记、同一正式正文、侧栏一次显示、语音同文、played状态已通过（zqzDpa）。当前修的是剩余分支，不要推翻它们。Grok估计时延不算实测；Boss已经在真实脚本记录commit→首音频时间/调用数。

完成聚焦自测后一次READY，带最终VoiceService回调签名（如果变），停笔。不要跑用户浏览器/全量/构建/重载，不修改Boss文件。
