# 任务：安装 TypeSafe，评估 Jev 对 Agent Loop 六类决策的适用边界

## 完成标准

- [x] 通过用户指定的单一 npx 安装方式为 Codex 安装项目 Skill，核对安装文件与锁文件。— 主代理：安装输出及文件
- [x] 六类判断均对应当前源码、可实验方案与必须取得的执行事实。— 主代理及独立原生 Agent：源码复核
- [x] 用一次固定版本 Jev 请求检查 12 个预先标注的中文合成案例，保留原始结果及失败。— 实验脚本
- [x] 明确已验证范围、未验证范围和后续接入建议。— 主代理

## 范围与修订依据

安装目录 `.agents/skills/typesafe-ai`，安装命令 `npx --yes skills add typesafe-ai/skills --skill typesafe-ai --agent codex --yes`。仅使用这一种安装方式。

用户指出：现有规则建立于不知道 Jev 之前，不能以已有代码作为拒绝替换的理由。本次据此将语义授权判断、状态解释、有限动作选择全部纳入可比较候选。精确身份校验、事实采集、持久化和执行不由概率答案冒充；这不限制 Jev 对这些事实的解释。

实验只发合成文本，不读用户真实页面，不执行工具，不改生产控制链。单请求、12 道 Choice、固定 jev-1.13.0、35 秒超时、不重试。预期答案在请求前写入脚本，模型仅看到场景与问题，不看到预期标签。这是可行性探针，不是独立留出集，也不能推出生产准确率或置信度阈值。

## 官方依据

- [Skill](../../.agents/skills/typesafe-ai/SKILL.md)：模型提供结构化判断，代码组织流程；类型正确不保证事实正确。
- [Models](https://docs.typesafe.ai/models)：本轮查阅版本 jev-1.13.0，输入为文本；中文需单独验证。
- [HTTP API](https://docs.typesafe.ai/api)、[Choice](https://docs.typesafe.ai/primitives/choice)、[Confidence](https://docs.typesafe.ai/confidence)、[Function calling](https://docs.typesafe.ai/cookbooks/function_calling)：有限选择、概率分布和闭集参数组合方式。

## 实验记录

脚本：`scripts/experiments/typesafe-loop-probe.py`。原始[请求](../../out/experiments/typesafe-loop-probe/request.json)、[响应](../../out/experiments/typesafe-loop-probe/response.json)、[汇总](../../out/experiments/typesafe-loop-probe/summary.json)已保存。

实测 jev-1.13.0，单请求 1903ms，输入 2574 tokens，输出 505 tokens，12/12 与预先标注一致。按本轮官方输入单价 $0.042/Mtok 估算约 $0.000108，并非账户账单。场景文字短且明确，不能推出真实页面成功率、单问题延迟或生产收益。

关键结果：可逆筛选修改选择 proceed；仅授权起草的邮件发送选择 confirm；修改宋体选择 display；点击已执行但读回保存失败选择 incomplete；旧文档的“保存成功”选择 unknown；订单提交超时选择 verify。需要工具读取票价的案例选择正确但 confidence=0.42，其余置信度不能视为正确率保证。没有用这 12 个样本拟合阈值。

## 六类决策扫描

| 用户问题 | 当前路径 | Jev 候选职责 | 代码与主模型职责 |
|---|---|---|---|
| 是否需要确认 | `agent/src/prompt.ts` 的 Safety；`extension/src/background/exec/input.ts` 的 click/destructive label；`agent/src/write-confirm.ts` | 判断动作是否超出原话授权、是否需要澄清；可与当前标签规则比较漏报和误报 | 代码保管用户实际确认、绑定参数/任务/页面、TTL 与一次消费；主模型解释后果和处理无法归类的意图 |
| 是否应该调用工具 | `conversation-manager.ts` proposeVoiceTurn → `voice-model.ts` prepareVoiceTurn；`voice-intent.ts` | 需要外部事实/直接回答/等待完整输入等有限判断，替换实验可覆盖现有语义路由 | 代码维护轮次与取消；主模型生成回答、复杂多意图计划。不能丢掉原文分界和指代上下文 |
| 该选哪个工具 | `agent/src/tools.ts` 工具目录与 execute；主模型工具调用 | 在实际可用目录中选工具与已提供的闭集参数，例如 display 与 translate；保留 none/unknown | 开放字符串、程序生成、复杂目标定位交主模型；schema/可用性检查及 RPC 由代码执行 |
| 当前任务是否完成 | `task-readback.ts` observed；`task-progress.ts` snapshot；`user-delivery.ts` finding | 优先试验：逐项判断新读回对目标是 satisfied / contradicted / insufficient，可作为主模型的独立语义核验 | 代码提供真实回执、要求版本、页面及新鲜度；主模型处理证据不足、补读和最终报告。业务验证已有精确 expect 时优先复用 |
| 页面属于什么状态 | `extension/src/background/observation-document.ts`、snapshot/read_element | 从实际文本判断登录、表单错误、处理中、可操作、证据不足；多状态并存时用独立问题而非强迫单选 | 代码取得文档身份、DOM 属性与文本；纯视觉信息仍需视觉模型或观察工具，当前 Jev 不直接接图 |
| 下一步执行哪个有限动作 | `shared/task-next-step.ts` decideTaskNextStep、assertTaskStepExecution；`product-context.ts` | 可把 continue/change_method/verify/ask/deliver 等当动作选择实验；重点比较“有读回但目标未满足”等语义分支 | 代码验证实际授权、停止、版本及写入条件并执行。Jev 可解释 unknown 证据，不能将猜测写成已执行事实 |

`decideTaskNextStep` 的 AST 调用点已核对：task-progress 构造快照、product-context 暴露上下文、assertTaskStepExecution 执行检查。当前无 CodeGraph 工具，采用 ast-grep 与直接调用链阅读，未把文本命中冒充结构图。

## 优先级与下一实验

1. **先试任务完成语义核验。** TaskReadback 明确只管读回顺序与范围；有效读回会清除待核查项，但不比较用户目标。TaskProgress 的 successVerified 当前固定 false；交付闸门检查 delivery，并非独立业务成功验证。Jev 在这里可能补上能力，而不是多加一层同义路由。先只记录判断，与主模型交付和人工标注比较；通过后再决定是否影响交付。
2. **再试确认必要性及有限下一动作。** 比较 Jev 与现有规则/主模型，对漏确认、过度确认、错误重做、该补读却结束分别计错。不得用“代码现在这样做”作为正确标签；以用户实际授权和任务结果标注。
3. **工具路由和语音意图随后。** `classifyVoiceEdit` 只有定义、session 包装和测试，没有实际生产调用。修改它不会降低真实语音延迟。应从真实 prepareVoiceTurn 路径取案例，避免新建第二套路由。多意图、指代与原文定位不能由一个 EDIT/NONE 替代。

下一实验使用脱敏真实样本与反例：读回有 Saved 但保存对象错误；上一轮成功文本残留；部分要求完成；用户改要求后旧结果晚到；“别发送，先改一下”；“等我说继续”；未知提交但当前存在同名旧订单。单独留出评估样本，冻结问题与模型后测误判、弃权覆盖率、整体延迟和回退成本，再提出生产修改。当前未运行这些样本，未比较主模型基线，未测实际网页行为，未接入生产。
