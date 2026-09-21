# 交接：日常语音试用失败与未完成修复

更新时间：2026-09-20 22:01（本机时间）。用户要求交由另一位处理；本会话停止继续修改和加载。

## 工作目录和约束

- 仓库：`/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side`，当前工作目录/main；大量已有未提交改动，不能 reset、覆盖或清理。不提交、不推送。
- 用户要求亲自处理，不派子代理。不要为切 B 站等具体案例加关键词或网站捷径。
- 用户已明确授权提前日常试用；这取代了“完整陌生任务评测通过前不开放试用”的前置条件，但不是正式验收通过。
- 不开用户麦克风做诊断、不操作用户真实网页复现、不擅自切回 2.5、不另换或付费重克隆音色。加载前查实际任务/通话状态，不能打断正在执行的任务。
- 日志含用户私人网页及对话内容，仅本机使用，不公开上传。

## 当前日常实际状态

- `~/.sideagent/config.json` 的 `generalBrowserLoop=true`。
- Realtime 模型仍为 `stepaudio-3-realtime-preview`，原自定义音色已恢复为 `voice-tone-T3kZb9MwL2`，但用户明确反馈仍然“忽男忽女”。**音色问题没有解决。**
- 日常 Native 进程 79115/79116 启动于 21:44:03；`agent/src/realtime-voice-connection.ts` 最新修改为 21:56:28。下面的缩短话语、工具结果不等待播放的补丁**尚未加载到日常进程**。
- 不应把代码已改、API 回显正确、生成过音频等同于用户听感已恢复。

## 问题一：同一音色忽男忽女

真实反馈：换回旧音色后，同一个说话人的性别/声音仍变化，不是用户所说的断续播放。

确认事实：
- 之前迁移到 3 时源码用了 `wenrounansheng`，与旧版本 `agent/src/voice-session.ts` 的自定义音色不同。
- 已把 `agent/src/realtime-voice-connection.ts` 的 `STEP_VOICE` 恢复成旧 ID。
- 当前凭据调用官方 `GET /v1/audio/voices?limit=100` 返回 200、15 个音色，旧 ID 确实存在，并非只凭字符串猜测。
- 真实 Realtime 3 接受旧 ID 并输出音频；日常日志 21:41:56 回显旧 ID。**这些检查不能验证音色稳定。**
- 目前没有原始用户这轮助手输出音频的独立听音结论，也没有证据证明自动回复与工具续答配置了不同 voice；不能把此猜测写成原因。

待修源码仅加了“保持同一说话人、不模仿用户、不切换性别”的提示，未证明有效，未加载。不应据此宣布修复。

证据：`out/acceptance/20260920-general-browser-trial/original-voice.json`、`original-voice-verified.log`、`~/.sideagent/agent.log`。

官方资料已查：
- https://platform.stepfun.com/docs/zh/api-reference/realtime/chat.md
- https://platform.stepfun.com/docs/zh/api-reference/audio/list-voice.md
- https://platform.stepfun.com/docs/zh/guides/models/stepaudio-3-realtime.md
API 文档支持自定义 voice，但没有给出此问题的原因。voice 在会话开始后不能随意更新。不要臆造兼容参数。

## 问题二：切标签页没执行，反复读当前页、长篇说话

真实试用：用户要求切到另一个标签页。首段 ASR 有误识别、截断；后续用户再次明确纠正“标签页切到 B 站那一个，不是表情”。Realtime 仍两次调用 `read_page`，没有派发任务。

因此，这一轮不是“Jev 点击慢”：任务根本没交到浏览器执行流程。用户等到的是当前 flomo 页面内容和长回复。

同时发现确定的代码延迟：
- 21:44:29.574：第一次页面读取结果已就绪（耗时 14ms）。
- 21:44:38.647：等前导语实际播完才发送工具结果，白等约 9.1 秒。
- 第二次读取耗时 5ms，同样额外等待约 9.4 秒。
- 原 `RealtimeVoiceConnection.maybeFlush()` 同时用生成状态和 `playbackBusy()` 阻挡工具输出，并要求对应 `playedResponses`。

已写、尚未加载的补丁：
- 工具结果和续答只等服务端 `response.done`，不再等前导语实际播放完；播放回执仍独立，主动通知仍等待播放，不把“已接受任务”升级成完成。
- 默认只说一句短话，操作先调用工具，不朗读计划、不复述页面。
- 明确切换/打开/关闭标签页也属于任务工具能力，`read_page` 不能替代操作或查询其他标签。
- 没加 B 站/flomo 特例。

定点回归：修改旧的错误播放等待断言后，先保留修前失败 `preamble-before.log`，补丁后 23 项单测通过 `preamble-after.log`。

## 问题三：最新切标签回归仍未通过——正文称完成，完成记录未核验

最新真实隔离无头测试：
```
node --import tsx scripts/acceptance/general-browser-voice-dev.mts --headless --switch-tab
```

结果：**FAIL：actual task result timeout**。证据目录：
`out/acceptance/20260920-general-browser/voice-dev-1789912724892/`

已确认：
- 真实语音只派发一次任务，旧意图分类调用 0 次。
- 实际出现 `list_tabs → worker_tabs → switch_tab → snapshot`，`switch_tab` 返回 ok。
- 主模型调用 `send_user_message`，文字为“已切到「资料页」标签页”，请求 `outcome: complete`。
- 实际返回却是 `{ outcome: "unverified", nextAction: "continue", resultIds: [] }`。
- Realtime 仍播出了“已经切到资料页标签页了”。
- 检查器等待正式 complete 超时，未执行后面的独立当前标签状态检查。因此不能仅据 switch_tab ok 或语音声称就宣布任务通过。

下一位应查：切换标签页为什么没有登记/核验对应结果，以及事实未核验时为何允许确定完成的正文播报。不要删掉等待判据让测试变绿。若证据表明判据本身错，应保留旧失败、记录修订理由并补反例。

另一个待查点：真人日志 21:45:38 出现一个主模型回合，提示含当前页但缺实际用户任务，模型随后问“需要我做什么？”尚未定因，不要直接归因用户点了空发送。

## 通用执行流程的真实边界

- 已实现普通 act 任务先进入通用循环、按需生成字段材料再继续、结构化控件和更有针对性的失效检查、原权限和停止保护。
- 字段/下拉等开发场景通过；不是陌生任务总体通过。
- 切换已有标签页尚不在 Jev 候选动作中，应走真实明确交接给现有任务工具；不能说本次切换是 Jev 独立执行。
- 独立留出任务执行器/完整评分和性能对比未完成。`general-browser-oracle.mts` 只是新增的只读判定模块草稿，尚未接成完整运行器，不要把它当成已完成验收。
- 最后这次修补仅跑了 23 项语音单测及上述失败的真实切标签检查；不是最新全量工程绿。此前 86 项定点、类型、构建及开发场景通过不能覆盖后续新改动。

## 日志与入口

10 分钟增量记录已结束（21:42:48—21:52:48），采集器无错误，不再后台运行：
`out/acceptance/20260920-general-browser-trial/usage-214248/`

关键真实用户会话：`9f298d97-352a-4b83-8995-e2f860506605`。
关键 trace：`logs/traces/1789911855952-47b727a0-7fa4-44a1-86a6-324be3ef713f.jsonl`。
`logs/voice-capture/2026-09-20.jsonl` 有原始 ASR，`logs/agent.log` 有工具/播放时间，`logs/conversations/` 有新增任务会话记录。只采日志，不含此次用户麦克风录音。

主要代码：
- `agent/src/realtime-voice-connection.ts`：音色、提示词、工具输出/播放时序。
- `agent/src/realtime-voice-session.ts`、`agent/src/voice-service.ts`：派发、通知与实际播放记录。
- `agent/src/session.ts`：初始通用循环与主模型交接。
- `agent/src/browser-decision-loop.ts`、`shared/browser-decision*.ts`：候选、执行、守卫。
- `scripts/acceptance/general-browser-voice-dev.mts`：新增 `--switch-tab` 回归；测试界限写在代码内。

加载检查脚本 `out/acceptance/20260920-general-browser-trial/load-daily.mjs` 会重载日常扩展，仅空闲时可用。新面板初始化可能切换所选会话，使探针被拒绝/关闭；已有首次失败保留，后续 `--verify-only` 可检查，不要盲目重复重载。
