# 当前卡点定点核对（不是陌生任务验收）

用户要求：具体指出 API 接入、浏览器自动化、Jev 与 Realtime 3 配合究竟卡在哪里，不能笼统归为“验收未过”。

## 1. 实际执行路线仍由强模型选择

当前开发版：Realtime 3 的 task_action → ConversationManager.dispatchTaskAction → 当前任务模型 → 自行选择 browser_loop 或旧工具；browser_loop 是 createBrowserTools 中受 generalBrowserLoop 开关控制的可选工具，不是任务管理器默认的通用执行路线。

刚重跑的自然语音记录 `out/acceptance/20260920-general-browser/voice-dev-1789898432359/`：从隔离存储中的真实 Pi toolResult 提取出的工具顺序为 **tabs → browser_run → send_user_message**，没有 browser_loop。因此该轮证明结构化语音交接、原工具执行、结果播报，不证明自动走了 Jev。

Jev 开发正例 `dev-1789897657401` 的输入明确要求“请使用 browser_loop”，只证明可调用、能执行与核验；不能用它宣布通用调度完成。此前“通用核心已接通”的沟通必须限于这个范围。主模型作为可选工具调度者并非天然错误，但与“明确要求不再必经主模型重新决定”的本轮目标尚有缺口。

## 2. 通用观察和候选仍有具体缺口

命令：`node_modules/.bin/vitest run --config out/diagnostics/general-browser-blockers/vitest.config.mts`。

三个隔离反例直接调用生产函数，输出在 `out/diagnostics/general-browser-blockers/result.log`。这里的测试通过表示**缺口被重现**，不是产品通过验收；没有调用模型或操作日常浏览器。

- `assertBrowserDecision` 比较整份控件数量与状态：目标 Continue 按钮完全不变，另一控件计数名称变化，仍被拒为 DECISION_STALE。缺少目标/必要关联上下文的依赖范围，不能把“任意控件变化”都当成目标失效。
- `axTreeToText` 可以仅裁剪长正文而完整保留交互控件，但 snapshot 把文本截断/控件缺失混成一个 truncated；loop 无条件交回强模型。反例保留了目标 ref，Jev 仍一次都未被调用。
- browserCandidates 没有材料就没有 fill 候选。当前材料由前面的主模型调用 browser_loop 时提供，循环内部没有按需生成/提取材料后继续的交接。在第一轮开发测试中，模型把值写进 goal 而遗漏 materials，整个循环退回主模型；改成明确材料契约后开发正例通过。字段材料、直接导航/现有标签选择等仍需按通用能力补齐，不能按业务口令补例外。

不能错误声称“点开新标签一定丢页”：已核对 ToolRpc.observePageResult 对 click.newTab.tabId 更新任务工作页，既有执行器具备这条能力；本次不把继承能力忽略后当成缺陷。

## 3. 语音故障有明确原因，当前定点结果已变化

### 前段输入丢失

旧代码把 input item_id 不是最新一句的转写全部丢掉。真实语音中下一段 speech_started 可先于上一段 ASR completed，导致正常续说被当过期输入。已改保留已知、未派发的片段；只有 Realtime 3 明确选择 includePending 时拼接原文，同页面/同任务版本校验，普通聊天和新任务不自动拼接。

### 结果未送到却误标已播

旧通知使用 conversation.item.create 的 system role，实际服务返回 400 `item.role must be user or assistant`。并且零音频的 response_end/playback_done 也会把任务标 played。已改 user-role 应用通知、服务器确认后才发起回复、实际有音频才允许 played。

另一个实测适配差异：preview 会重写客户端 item.id，把输入文本回显到 audio.transcript。严格只按客户端 ID 等确认会超时，现按已发送原文精确匹配回显，不把任意下一条 user item 当通知确认。独立真实 API 探针证据：`notice-api-probe.json`、`notice-ack-shape.json`。

### 本轮重跑

`node --import tsx scripts/acceptance/general-browser-voice-dev.mts --headless --fragmented` 最终 `voice-dev-1789898432359/result.json` passed=true：

- 真实 provider 返回两段转写；任务原文按原顺序完整包含两段，仅派发一次；旧意图分类调用 0。
- 实际字段为“星河”、复选框勾选、未保存；独立页面检查通过。
- 最终通知确实被接收，有真实音频及实际播放回执，最后语音为“搞定啦，代号已经填好‘星河’，只看可用项目也勾选上了，没点保存”。
- 期间一次 `ongoing response already exists` 按现有有界重试恢复，计入全程，不删除错误。前一份报告把这种已恢复繁忙也一概判协议失败，保留旧结果并修正检查；不放行未恢复错误、缺通知确认或零音频假播报。
- 合成声音、隔离生产浏览器，不代表物理麦克风及所有改口已验。

最新定点 `browser-loop-tool.test.ts` + `realtime-voice-session.test.ts` 共 28 项通过，`latest-regressions.log`。不得继续把这两个已修且定点通过的故障说成“尚未找到原因”；也不能将其通过外推成整个语音系统完成。

## 4. 陌生任务检查尚未完成

general-browser-evaluation.mts 目前实现版本指纹、任务首次曝光、首测结果不覆盖等记录约束；**尚未完成 24 个独立陌生任务的实际执行与独立结果核验**。`oracle:unknown` 只是任务格式位置，不是已经实现的通用评分器。当前没有陌生任务结果，不能说“陌生任务普遍失败”，也不能说“系统通用性已经好、只差证明”。

两万条回执规模测试超时是独立性能问题，不是上述架构未完成的原因。保留失败，不以它作为暂不做通用调度/陌生任务的借口。

## 修复优先顺序

1. 明确的目标进入共同执行路径，按需才请主模型生成材料或处理开放推理；不能以每次提示主模型“请用 browser_loop”代替调度接入。
2. 区分正文截断与控件缺失，补目标依赖范围与材料/观察补充后继续的通用机制。
3. 用独立任务源与真实结果判据完成陌生任务执行，而非只维护成绩文件。整体验收前不切日常，不新增站点特例。
