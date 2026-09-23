# 续接要点

只保留容易导致下一次误判的原因；当前结论见 [STATUS](STATUS.md)，完整历史见[旧 NOTES](history/20260920-notes-snapshot.md)。本页不保存任务授权、供应商额度或本机开关快照。

[22:01 交接](evals/20260920-general-browser-handoff.md)是修复前基线；后续原因与反例见[本轮修复](evals/20260920-voice-repair.md)，当前加载/未决状态只看 STATUS。

## 先分清证据属于什么

- Browser v2 的旧 19/19 记录包含 S5 脚本代点，不能用作完整产品链证明；新执行/证据只看 [REV 记录](evals/20260922-browser-capability-integration-v2.md)。Chrome 的“another debugger”文案也可能来自本扩展仍然持有的旧连接，必须用有权限的只读命令核对，不能为恢复连接重放未知输入。共享 index 被并发整文件提交带入部分在途接线，后续发布须核对完整差异与构建指纹，不能仅看 HEAD。

- 当前源码、本机配置、正在运行的进程与浏览器资源、真人结果是四层证据。前一轮音色 ID 回显和返回音频未覆盖用户的忽男忽女反馈；见[真人反馈](evals/20260920-voice-trial-feedback.md)。
- 旧 2.5 分类→回答→TTS 的延迟数据不能解释当前 Realtime 3。Native Messaging 只是通信边界，未测传输耗时不能把所有等待归给它。
- 同一文档混入“已开启”和“仍关闭”、把局部 check 当最新代码通过，已导致本轮架构判断出错。旧结论应移至历史，当前结论必须有日期和证据范围。

## 不要在修复时破坏的因果关系

| 问题 | 必须保留的区别 | 证据 |
|---|---|---|
| 语音衔接 | 生成结束、工具回传、实际播完分别处理；允许音频排队后，播放超时也须包含前方队列，不能因解除等待而制造误断线 | [反馈与候选修复](evals/20260920-voice-trial-feedback.md) |
| 动作与交付 | 页面动作已发生、读回一致、目标完成、用户已听见分别记账；失败后不能从头重复未知写入 | [恢复裁决](evals/20260917-p0-retest-adjudication.md)、[交付](evals/20260919-product-t06.md) |
| 任务恢复 | 收到 accepted 前必须可恢复原请求与附件；读回最新页面不等于证明旧动作没发生 | [接收持久化](evals/20260917-p0-acceptance-fixes.md)、[恢复矩阵](evals/20260917-p0-recovery-matrix.md) |
| 重连 | 旧重连定时器不得拆除已恢复的活连接；确认消息必须有正确的会话信封 | [T05](evals/20260919-product-t05.md)；详见旧 NOTES 的 T05 条目 |
| 学习与记忆 | 做法匹配、材料齐全、可自动执行是不同判断；技能输出契约不足不能靠提示词掩盖 | [技能集成](evals/20260919-skill-loop-integration.md) |
| 验收环境 | 日志、数据与浏览器都要按环境区分；曾因 trace 目录未隔离轮转日常日志 | [技能验收](evals/20260919-skill-fast-loop.md) |

## 目标与原文证据链

9/22 Computer Use 暴露了尚未修复的范围反例：AX 原始片段准确保存，不等于它恰好覆盖用户要求的某一句；“同一个 Note”改口也必须保留原对象关系。实测整段被当成第一句、另一处 Note 被当成原 Note，来源目标仍通过，而下游填写闸门拒绝。后续不能通过放松写入核验消除表面失败；先核对来源对象、句子范围及实际填写值的关系。原输入和独立页面对照见[真实路径验收](evals/20260922-computer-use-product-path.md)。

本次 B站→Flomo 失败不能归咎于 closed shadow DOM：最初观察已含评论。控件快照会压缩空白、截短文本并丢弃换行，原文材料必须来自另存的 AX 原始片段或完整元素文本。片段编号只标识那次观察，不是以后能执行的页面引用。

Jev 对真实浏览器来源有保守判断；重复换 DOM/网络工具不能解决核验不确定。先保留同一证据，再进行一次主模型独立复核。分工已经过定点模型与浏览器检查；来源重用只判断旧证书是否适用于新要求，不重新推测原文。通过范围与加载状态见 [验收](evals/20260921-goal-evidence-contract.md)和 STATUS。

9/21 圈词试用补充：[日志回溯](evals/20260921-1441-log-review.md)中的失败包含取证结构本身缺信息，不能一律交给同证据模型复核或降低 Jev 门槛。完整保存原文被固定成目标后，与 8000 字符限制形成不可满足条件；内部方法调整与删除用户要求须分开处理。`partial` 交付也必须约束正文中的完成宣称，不能仅加未完成尾注。调试器占用提示可能来自产品自身并发 attach，尚未证明本次是外部 DevTools 导致。

## 子代理派发与真实入口

用户最新修订：产品问题（文字日志、简单问答分流、语音派发/多轮衔接）等待更多信息后重新判断方案，不按此前顺序自动继续实施或加载。当前只调查后台子代理现成插件与自建选择。

9/21 文字影子漏记暴露了检查方法的问题：子代理和独立复核都用旧 `user_message`，真实侧栏却发 `task_action`。后续任务包必须带真实发送端、消息形状、允许的定点命令和停止条件，不能仅要求「相关测试通过」。当前 Pi 子代理扩展是同步等待、共享文件系统、无持久子会话，不具备后台续发能力；不要照搬 Claude 的后台承诺。依据、任务包示例及衔接方法见[子代理协作调研](evals/20260921-subagent-workflow-research.md)。

## 按修改范围再查

页面翻译、模型提示预算、材料脱敏、任务视图、草稿初始化等细节已在对应代码/测试和验收文件中。需要其历史原因时，按[旧 NOTES 标题](history/20260920-notes-snapshot.md)定点查，不把整份旧笔记注入每次任务。

## 2026-09-21 交给用户试用

用户明确要求缩短代理自行验收阶段，只做必要检查就交付本人使用，之后按真实反馈继续。短路径与目标证据链已成套加载；当前应等待使用反馈，不自行启动更多基准、边界矩阵或全套测试。技术证据及未验证项见 `evals/20260921-fast-task-contract.md`。

## 逐次指定音色实验

9/21 候选在无 VAD、手动逐次 response.create 的直连里仍出现明显音高变化；因此仅关闭日常自动回复不解决这个反例。服务端接受 response.voice，但未回显其逐次采用情况。原始录音待真人听感判断，见[对照验收](evals/20260921-voice-per-response.md)。

## 官方音色采用

用户确认官方 Demo B 组青春少女的变化只是正常语调，音色保持同一人；原克隆音色会跨轮换人。音高不能作为音色漂移判据。用户决定日常改为 qingchunshaonv，保持 Realtime 3 原生发声，暂停克隆问题排查。证据与采用见[记录](evals/20260921-official-demo-voice.md)。


## 2026-09-21 Realtime直接工具试用
用户选择先commit固定现状再直接接现有工具，拒绝继续增加路由或大量评测。恢复点94b1782；后续是否提交由真人试用决定。本次独立页面读回已证明填写发生，但模型未主动再读回，不能把接通当成完整自主核验通过。详见[验收](evals/20260921-realtime-direct-tools.md)。

多轮修复：控制权写操作不等于持久写入结果；scroll/hover 不应因不自动建结果项而留下全局审计缺口，JS 则必须保留逐项执行记录。未知状态的核查必须保留原 run，单纯读取不能清锁；历史总标志无调用依据时只能限制恢复。直连 status 生命周期不触发 Pi agent_end，避免自动交付。证据见[多轮修复](evals/20260921-realtime-multiturn-repair.md)。


## 2026-09-21 Realtime调用Jev工具
用户认可按需工具分工，不要求两模型二选一：Realtime发起判断，宿主给真实候选，Jev返回建议，Realtime再执行。20:59已加载；Jev与真实浏览器分段通过，但Realtime合成语音只观察就虚报点击，完整链路未通过。不要通过工具定义存在或Jev单独成功掩盖这项缺口。[证据](evals/20260921-realtime-jev-tool.md)。

## 执行反馈与请求级开口

动作成功、胶囊足够确认动作、整条用户要求不再需要语音是三个独立命题。V2.3 只在最后一个命题与当前真实成功批次同时成立时省掉 response.create；旧 200ms 扣音结果仅是历史，不再沿其“按轮静音资格”续接。缺 VAD/item 身份绑定、停声早于最终 ASR、同 item 文本更新都必须保守保留语音，不能用“当前 turn”补身份。历史与当前验证边界见 [V2.3 验收](evals/20260922-v22-spoken-result-shadow.md#八v23-请求级生产接线离线完成待独立-reviewer默认关闭)；当前进度只看 STATUS。

## 第五切片 review 续接

首次验收中“身份完整”的判断已被同文档替换反例推翻；续接时以[原验收文件的 P1 补充](evals/20260922-realtime-unknown-fill-readback.md#p1-同文档对象替换修复本轮)为准，不将历史 CSS/DOM 读回正例当作当前支持范围。

真实 Chrome 无模型验收中，A 的隔离钩子未就绪，不能用随后 B/C 的成功补成 A 正例；C 的 PASS 仅指 snapshot-only 安全跳过，不代表原 C2 修复。下次续接先看[本轮限制](evals/20260922-realtime-unknown-fill-readback.md#真实浏览器无模型验收)，不要自动重跑或改生产能力。

## 后台 GUI 基础设施（2026-09-22 18:10 起可用）

Cua Driver 0.7.1（`/Applications/CuaDriver.app`，com.trycua.driver）daemon 已授权可常驻。用法：`cua-driver call <tool> '<json>'`；打开侧栏用 `hotkey {"keys":["cmd","shift","y"],"pid":<Chrome pid>}`（background 默认：可信按键投递到 pid，不前台、不动真实鼠标）。扩展已带 `_execute_action` 命令（Command+Shift+Y）与 `setPanelBehavior`，该按键即开侧栏。`click` 用 element_index+window_id 走 AX 路径（后台/隐藏窗口可用）；`get_window_state`/`zoom` 取 AX 树/截图；`get_accessibility_tree` 看桌面。页面内真实输入仍走 CDP（Runtime.evaluate + Input.insertText/鼠标事件）。**CDP 合成按键不触发浏览器级快捷键**（Cmd+T 实测无效），这是选 CuaDriver 的原因。权限归属 driver 身份；`cua-driver skills install` 可给各代理装技能包（未装）。验收脚本属临时工具，未入库。

## Computer Use 复测后续接（2026-09-22 18:10）

- 已实证生效：改口继承（requirement 并列）、来源对象绑定与句子范围（同 Note 末句准确捕获）。未过：①「修订后改写已有成功回执的字段」——闸门按字段选择器+回执拒绝重放，`confirm_blocked_write` 对该字段无恢复态；需要以新 revision 为键的回执失效/确认路径，不能靠放松核验。② 中断任务续接：保留 tab 丢失+伴随进程重启后 run 已 dispose，「继续原任务」无后端事件。③ J5 接管/交还需真人路径复测（自动化点击只拿到「未确认」，含工具链瑕疵，不能定罪也不能记过）。
- 复测消息发在面板原会话（记录 d505b83c）；c54da576 的历史（含「无法继续」finding 与中断快照）保留未动。复测后 Flomo 草稿为空（模型清空重填的副作用）。
- 模型侧待决记录：默认模型现为 minimax-cn/MiniMax-M3（本日 J3 全链正常，2m0s）。候选 MiMo V2.6 Flash 经 Command Code（Provider 计划，OpenAI/Anthropic 兼容端点）——若要换，先走真实路径对比再定，不以价格/宣传替换验收。CUA-S1（trycua/cua `libs/cua-s1`，cua-s1-form-v0）当前为 source-only 研究版：无权重、无性能声明、代码 MIT 但未来权重商用条款未定，暂不可用；表单专用方向与本产品填写路径相关，条款明确后再评估。

## anti-slop 规则集已接入（2026-09-23）

lint 入口为 `npm run lint`（`npm run lint:fix` 仅空白行 autofix）；未并入 `npm run check`。规则集 vendor 在 `tools/oxlint/anti-slop/`，pinned revision 与更新方式见该目录 `VENDOR.md`；策略只在 `oxlint.config.ts` 改，上游规则实现保持未修改。**已落地三步**（提交 `f71dfef` 空白行机械消红 611 文件 / `1d5fd33` 新改动闸门 / `2e49428` vendor+config）：`require-readable-spacing` 只剩 86 个 WIP 文件里的 4,694 条，`npm run lint:changed` + pre-commit 钩子（`core.hooksPath`）已挡住真实新增，baseline 10,681 条。续接先读[验收文件](evals/20260923-anti-slop-vendor.md)的分批计划与「baseline 是快照、工作树是活水」提醒；每批修完必须 `npm run lint:baseline` 下调，否则等于没做。
