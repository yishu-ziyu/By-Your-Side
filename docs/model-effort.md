# 模型能力、思考档与后台判断

[文档导航](README.md) · [架构](architecture.md) · [当前状态](STATUS.md)

本页是三件事的权威说明：每个模型能做什么（思考档、能否关闭思考、能否看图）从哪里来；后台判断怎么发请求、怎么重试、失败怎么说；主任务每次调用用哪一档。验收与实测见 [20261001 思考档与后台判断](evals/20261001-model-effort-and-side-judgments.md)。

## 能力从哪里来

只有一处：[`shared/model-capabilities.ts`](../shared/model-capabilities.ts)。用 pi-ai 模型对象自带的 `reasoning`、`thinkingLevelMap`、`input` 三个字段表达，`thinkingProfile(model)` 读出「可请求的档（从低到高）、能否关闭、能否看图」。

- pi-ai 目录里有的模型照目录（如智谱 glm-5.3-flash 只有 low / high / max，不能关闭）。
- 目录缺失或与实测不符的，在 `MEASURED` 里按「服务商/模型 id」精确登记实测结果，并写明依据：MiniMax-M3.1-Flash-Preview（不能关闭思考，low 起，最高 max，能看图，连接参数取同服务商的 MiniMax-M3）、OpenCode mimo-v2.6-flash（不接受 minimal）、阶跃 step-3.7-flash（始终思考，minimal 起；能看图；系统提示词必须用 system 角色，developer 角色会被忽略）、step-5-preview（能看图）、step-3.5-flash（不能看图）。
- 两边都没有的模型按保守默认：不发思考参数（由服务商自己决定）、只收文字。不按名字或同服务商的邻居去猜。

扩展注册模型时就套用这份登记（[`model-runtime.ts`](../extension/src/inproc/model-runtime.ts) 的 `resolveModel` 与阶跃注册），所以截图能不能发、目录外的模型怎么连，都和下面的取档同源。登记新模型：先实测，再加一条带依据的 `MEASURED`，并在 `extension/test/model-capabilities.test.ts` 补一条。

## 后台判断

目标核对、续接判断、记忆判断（记不记、纠正要不要问、过往任务日期）、找词/翻译意图、目标复核、语音判断（编辑判定、整句分类、直答、页面观察）、经验提取，都走 [`sideJudgment`](../agent/src/side-judgment.ts)：

1. 取该模型在本会话还允许的最低档（能关闭的就是不发思考参数）。
2. 服务端因档位或思考参数拒绝（400 参数错误）时，换下一个允许的档重试一次；被拒的档本会话记住，之后的后台判断、划词问答、整页翻译、正式回答都跳过它。
3. 回复不合要求（不是要求的 JSON、只有思考没有正文）时，带更严格的要求重试一次：系统提示词末尾和用户消息末尾各补一句「只回 JSON」；只有思考时输出额度放大到 5 倍。各判断可以换成自己的重试要求（语音分类沿用「拒绝原因 + 强化提示」，并且请求失败或超时也只重试这一次）。
4. 仍失败时抛出只带原因类别的错误：「模型拒绝了请求参数」「模型回复格式不对」「超时」「模型服务出错」「已取消」，不带服务商原文。记忆判断失败的提示是「记忆判断失败（原因），尚未修改记忆」；划词问答失败是「这次回答没有完成（原因）。已保留内容，可以重试。」
5. 每次判断在诊断记录写一行 `side_call{purpose, model, effort, attempts, outcome, reason?}`；目标核对拿不到结论时另有 `goal_check{status:"unavailable", reason?}`。

整页翻译的批次、划词问答、正式回答这些不是判断的短调用不走上面的重试，但档位同样取该模型允许的最低档。

## 主任务的思考档

[`MainEffort`](../agent/src/main-effort.ts) 由会话持有，扩展里的循环每次调模型前按当前模型取档（换模型、故障切换后按新模型的档位表换算）：

- 起始档为中档；模型没有中档时取不高于中档的最高一档，都没有就取模型最低档。
- 宿主已记录的四种信号各让之后的调用升一档，不超过模型最高档：同一操作连续第二次失败（`tool_failures`）、原地打转被停（`no_progress`）、目标核对判没做完并催它接着做（`goal_unfinished`）、用户中途补充或纠正、或补一句接着做没做完的任务（`user_correction`）。不为判断难度额外调用模型。
- 新任务回到起始档。每次实际变化写一行 `effort_change{from, to, signal}`（回到起始档时 `signal` 为 `new_task`）；已在最高档时不变、不写。

只在 Node 里托管会话的检查循环（`node-agent-loop.ts`）不接这套取档。
