# 任务: 一般模型下后台判断也靠得住；思考档位由产品按模型能力和任务进展决定

[当前状态](../STATUS.md)

## 起因（10-01 实测）

- OpenCode mimo-v2.6-flash 拒绝 `reasoning:"minimal"`（400）：目标核对、记忆判断（GitHub #24：full-1 里 7 道记忆题全失败）、续接判断全部静默失败。
- MiniMax-M3.1-Flash-Preview 反过来：不传档位时库默认发「关闭思考」，服务端回 400「requires adaptive thinking」；带 minimal/low 正常，核对 9/9、中位 1.5 s。现在把它设成主模型，第一句就失败（主循环从不设档位）。
- 阶跃 step-3.7-flash 无视「只回 JSON」，直接和用户聊天：核对 0/9 可解析。
- 扩展把阶跃登记为只收文字（`extension/src/inproc/model-runtime.ts`），截图发不到阶跃，实际它能看图。
- 失败原因被吞：记忆判断只报「记忆判断失败」（`agent/src/side-completion.ts`），划词问答一律「这次回答没有完成」（`agent/src/reading.ts:40`，GitHub #15）。

## 完成标准

- [x] 1. 每个模型的思考能力（支持哪些档、最低档、能否关闭、能否收图）只有一处权威定义，主循环和所有后台判断都从这里取；未知模型按保守默认，不按名字猜（GitHub #2） — 谁检查: 机器
- [x] 2. 所有后台判断（目标核对、续接判断、记忆判断、找词/翻译意图、目标复核、语音判断）走同一个入口：取该模型允许的最低档；服务端因档位/思考参数拒绝时换下一个允许的档位重试一次，并在本会话记住；回复不是要求的 JSON 时用更严格的要求修复重试一次；仍失败返回带原因类别的失败（不含凭据） — 谁检查: 机器，真实会话 + 脚本模型测试
- [x] 3. 每次后台判断写一行诊断 `side_call{purpose, model, effort, attempts, outcome, reason?}` — 谁检查: 机器
- [x] 4. 主任务从起始档开始（默认中档，不低于模型最低档）；出现以下任一信号时下一次调用升一档，不超过上限：工具连续失败、原地打转被停、目标核对判没做完、用户纠正；新任务回到起始档；每次变化写 `effort_change{from,to,signal}` — 谁检查: 机器
- [x] 5. 记忆判断失败与划词问答失败的提示带上原因类别（如「模型拒绝了请求参数」「模型回复格式不对」「超时」） — 谁检查: 机器
- [x] 6. 阶跃登记为可收图 — 谁检查: 机器
- [x] 7. 真实模型：MiniMax-M3.1-Flash-Preview 作主模型完成一次带工具的请求；作后台判断核对 9/9 — 谁检查: 机器，真实模型探针
- [x] 8. 真实模型：GLM-5.3-flash、MiniMax-M3、step-3.7-flash 后台判断核对可解析率与正确率各测 9 次并记录；step-3.7-flash 从 0/9 提升（改进指标，不设硬门槛），失败都有原因 — 谁检查: 机器，真实模型探针
- [ ] 9. 扩展里选 MiniMax-M3.1-Flash-Preview 后能正常对话 — 谁检查: 人（真实扩展）

## 边界与不做

- 不改「结果未知」锁（另一任务：[锁的范围](20261001-unknown-lock-scope.md)）。
- 不改主模型默认选择；档位上限先用模型最高档，评测后再定。
- 升档信号只用宿主已记录的事实，不为判断难度额外调用模型。

## 实测证据

10-01/10-02 实现，未提交、未进日常构建。设计说明见[模型与思考档](../model-effort.md)。

### 机器检查（定点）

| 标准 | 检查 | 结果 |
|---|---|---|
| 1、6 | `extension/test/model-capabilities.test.ts`（扩展真实 `createModelRuntime → resolveModel`）：阶跃可看图且系统提示词走 system 角色；M3.1 解析到 MiniMax Anthropic 地址、不能关闭思考、low 起；未登记模型取保守默认 | 3/3 通过；旧代码上 3 条全失败（阶跃只收文字；M3.1 与未登记模型「找不到模型」） |
| 2、3、5 | `agent/test/side-judgment-session.test.ts`（真实会话 + 脚本模型）：J1 mimo 不再收到 minimal；J2 档位被拒换档一次并本会话记住；J3 聊天式回复带更严格要求修复一次；J4 两次都不对按「格式不对」失败；J5 只有思考时额度 1600→8000；J6 失败诊断不含服务商原文；J7 记忆判断失败写明原因；J8 划词问答失败写明原因；每次判断一行 `side_call` | 8/8 通过；旧代码上 8/8 失败（断言失败，非导入错误） |
| 1、4 | `agent/test/main-effort-session.test.ts`（真实会话 + 脚本模型）：M3.1 起始中档；无中档取 low、最低档 high 时取 high；同一操作连续两次失败、目标核对催做、用户纠正、原地打转各升一档；到顶不再写；新任务回起始档并写 `new_task`；未登记不思考模型不发参数 | 7/7 通过；旧代码上 6/7 失败，未登记模型不发参数一条在旧代码也通过（守护保守默认） |
| 相关旧测试 | voice-*、goal-check-files、offtopic-reply-diagnostics、memory-*、pi-agent-loop、reading、page-translation、no-progress*、conversation-manager、partial-delivery-claims、experience*、user-delivery-runtime、harness-contract-evaluator、task-restart-checkpoint、p0-review-regressions 与上面三份 | 54 个文件、544 条全部通过。`voice-model.test.ts` 两处原断言 `reasoning:"minimal"` 改为「未登记模型不发思考参数」（档位改由能力决定） |
| 工程 | `npm run typecheck`、`npm run lint:changed`、`npm run check:architecture`、`npm run check:docs -- --base HEAD` | 全部通过 |

旧代码对照：`git archive HEAD` 解出到临时目录，只放入新测试、`shared/model-capabilities.ts`（扩展测试读能力用）和 vitest 配置，跑同三份测试。

### 真实模型探针（标准 7、8）

凭据取自 `~/.pi/agent/auth.json`（minimax-cn、zai-coding-cn）与 `~/.sideagent/step-plan.key`（只用 Step Plan 地址）；走新的后台判断入口 `checkGoal → sideJudgment`。三组输入各 3 次：甲 问答已答 → done；乙 目标「在YouTube里面找到前两首歌。」、回答说上传 Google Drive 不确定 → continue；丙 同一目标、回答「字幕文件已经整理好并放在下载卡片里了。」→ continue。探针脚本用完已删。

| 模型 | 取档 | 第一轮 可解析 / 正确 / 中位 | 第二轮（最终代码） 可解析 / 正确 / 中位 | 失败与错判 |
|---|---|---|---|---|
| MiniMax-M3.1-Flash-Preview | low | 9/9 / 9/9 / 1.8 s | 9/9 / 9/9 / 1.9 s | 无 |
| glm-5.3-flash | low | 9/9 / 9/9 / 1.5 s | 9/9 / 9/9 / 1.2 s | 无 |
| MiniMax-M3 | off | 9/9 / 4/9 / 1.2 s | 8/9 / 4/9 / 2.7 s | 乙、丙多判成 needs_user；第二轮 1 次 18 秒超时（原因类别 timeout） |
| step-3.7-flash | minimal | 9/9 / 9/9 / 2.7 s | 9/9 / 8/9 / 2.7 s | 第二轮丙 1 次判成 needs_user |

所有请求一次成功（`attempts` 全为 1），没有触发换档或修复重试。

M3.1 作主模型：真实会话循环（`BrowserAgentSession` + 扩展里的 pi-agent-core 循环，模型请求走 pi 的 ModelRuntime）跑「用 read_page 读一下当前页面，然后告诉我页面标题」，两次请求都带 `reasoning:"medium"`，第一次 `toolUse` 调 `read_page`，第二次 `stop` 收尾，无错误，4.8 s。

### 实测中的发现

- 阶跃「无视只回 JSON」的直接原因：开了 reasoning 后 pi-ai 的 OpenAI 兼容适配把系统提示词改用 `developer` 角色，阶跃忽略它、直接和用户聊天（同一请求换回 `system` 角色后 3/3 给出 JSON）。能力登记里给 step-3.7-flash 标了 system 角色。
- 阶跃接受 `reasoning_effort` minimal–xhigh，但始终思考；同一请求思考长度波动很大（215 到 6324 字）。
- 看图：step-3.7-flash、step-5-preview 能看图，step-3.5-flash 回 400「doesn't support image input」。mimo-v2.6-flash 因 OpenCode Go 订阅已停（403）未能探测，按保守默认登记为只收文字。

### 与原文不同或原文未定的做法

- 「工具连续失败」取同一操作（工具 + 参数）连续第二次失败，不等第三次被停；第三次停下属于原有保护。
- 「用户纠正」取运行中插话（`steerCurrentTask`）和用户补一句接着做没做完的任务（`manual_continuation`）。
- 起始档在模型没有中档时取不高于中档的最高一档（智谱为 low），不往上取 high。
- 格式修复的严格要求同时加在系统提示词末尾和用户消息末尾（阶跃实测不太听系统提示词）；回复前后夹说明文字时取第一个 `{` 到最后一个 `}` 解析。
- 整页翻译批次、划词问答、正式回答不是判断，不走重试，但档位同样取最低允许档并跳过本会话被拒的档。
- 只在 Node 里托管会话的检查循环（`node-agent-loop.ts`，退役中）不接主任务取档。

### 未做

- 标准 9（扩展里选 M3.1 正常对话）待真人在真实扩展里试；本次未构建扩展、未重载日常 Chrome。
- 未跑完整工程检查 `npm run check`、浏览器验收。
