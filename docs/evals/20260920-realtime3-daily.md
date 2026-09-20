# 任务：日常侧栏只使用 Realtime 3，保留自然交流、真实任务与权限保护

## 完成标准

- [x] 1. 日常运行只连接开放平台 stepaudio-3-realtime-preview；无 2.5 回退，不再读取套餐 Key；凭据仅存在本机服务端。— 谁检查：类型/构建、真实模型回显与日常运行记录
- [ ] 2. 常规语音连续上传 PCM、使用服务端 VAD，不因开口自动取消回答或后台任务；实际播放完成后再推进工具回复。— 谁检查：定点协议/客户端测试、无头静音真实链路；听感由用户
- [x] 3. 3 的工具调用进入原任务、页面资料和授权链；会话/页面变更、晚到输入不能执行错对象；停声与停任务分开。— 谁检查：反例、真实页面任务与回执
- [x] 4. 原任务结果可回到语音，错误和断线可见、重连可用；诊断与正常模式不互相冒充。— 谁检查：定点测试、真实侧栏
- [x] 5. 空闲时加载日常版本并核对运行构建，提供实际可用入口。— 谁检查：主代理实际界面、进程/构建证据

## 授权与边界

用户明确要求将 3 整合进日常版本、不要 2.5，之后基于 3 继续开发。本次主代理亲自执行，不派子代理。不是只改模型名：复用已获真人认可的实时连接逻辑，常规对话交给 3，接入原任务和权限保护。原执行模型的进一步重构另按证据推进，不同时移除尚未验证替代的规划/翻译能力。

不开双版本产品开关，不改日常账户/页面数据做测试，不发布/推送。旧版本实验及历史测试证据保留，但不作为日常回退。改动验证后再加载，不把源代码完成当成日常可用。已有 .serena/ 为用户并发改动，保留不碰。

## 结果

日常入口已迁移并加载，机器验证通过。标准 2 的连续输入、无本地开口截断、真实播放回执部分通过；**重新集成后的日常真人收音/听感尚未测试，因此该条不整体勾选**。用户先前已认可独立试用，但不能替代新入口的真人声学检查。验收完成时尚未提交或推送；用户随后明确授权 commit 与 push，本轮不执行发布。

### 实现与分工

- `VoiceService` 唯一默认实例是 `RealtimeVoiceSession` → `RealtimeVoiceConnection`，固定开放平台 3 和 server_vad，无模型切换/2.5 回退。诊断也使用 3，但手动 commit、无工具，不冒充正常对话。
- 3 处理普通对话和工具选择。网页任务仍由原 manager/dispatcher 执行：浏览器工具必须取得对应输入的真实原话、页面资料及任务身份，忽略模型伪造的命令参数；任务控制分类、规划与翻译保留原任务模型。
- PCM 连续传输；服务端 input_turn 触发原页面授权获取，不重复提交音频。VoicePlayer 允许推进输入话轮而不切断已有播放。新增“停声”按钮与结束通话均不派发任务取消。
- 工具输出回复等待实际 playback_done；超时结束语音而非把未听到记为已播放。正式交付按 deliveryId 排队、播前检查任务归属，并回写 speaking/played。
- 开放平台凭据保存在 `/Users/mahaoxuan/.sideagent/stepfun-api.key`，权限 0600，复用已获授权的试用 Key；不输出内容，不读取套餐 Key，不改任务模型账号。试验浏览器启动时显式剔除语音/TypeSafe Key 环境变量；无头进程实测父进程有 Step Key、浏览器中没有这三类 Key，见 `browser-key-boundary.json`。
- 保留旧源码与失败记录，不作为日常可选实现；原试用启动器也改为导入同一生产连接核心。

### 机器检查

工作目录：`/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side`。

- `npm run check`：边界 203 个生产文件、类型检查、2485 个普通测试 + 2 个规模测试、构建通过。证据：`out/acceptance/20260920-realtime3-daily/check.log`、`check.exit`（0）。
- 增加服务端告警显示和繁忙重试上限后，边界/类型/全量测试复验通过（2486 普通 + 2 规模，`final-code-check.log`、`final-code-check.exit` 为 0）。随后补上断线关闭状态同步反例，最终类型检查及 4 文件 27 项定点复验通过：`final-types.log`、`final-targeted.log`。覆盖 3 配置确认、拒绝 2.5、连续上传不本地打断、来源上下文等待、原话而非模型参数派发、旧 ASR/工具与重复调用拒绝、播放确认前不续答、停声不派发任务控制、诊断隔离及侧栏所有权。最后确认 provider 断开即关闭宿主会话，晚到页面资料不能再派发旧请求；已接收的后台任务不因此取消。该修复复验后再次加载日常 Native，真实 3 回显通过。
- 旧客户端测试原来要求“开口先 interrupt，静音后 commit”。该要求已被用户授权的新 server_vad 方案替代，测试改为连续 PCM、服务端 input_turn 获取上下文、开口不 stop；仍保留外来会话、过期输出、资源释放和不保存正常原始音频的断言。

### 无头真实链路（合成输入，非真人）

命令：`node --import tsx scripts/acceptance/realtime3-daily.mts --headless`。

实际生产 VoiceClient / AudioWorklet / VoiceRelay / VoiceService / manager 与真实 3 API、原任务模型、真实页面工具全链路运行；仅麦克风输入用本地合成 MediaStream，播放静音。任务与 trace 目录隔离，不使用用户网页或会话数据。

`out/acceptance/20260920-realtime3-daily/native-path.json` 最终通过：

1. 真实服务端确认 3/server_vad；实际连续捕获非零 PCM，转写为“把当前网页翻译成中文。”。
2. 网页任务完成后独立读回 3 段中文正文，连同标题共 4 段翻译。
3. **最终交付本身**取得真实 VoicePlayer 播放完成回执，交付账本对应 deliveryId 为 played；不是只检查第一句接收提示。
4. 实际断开宿主 WebSocket 后，侧栏自动恢复传输并重新连接真实 3；已经完成的页面翻译保持。
5. 停声、结束消息确实到达；正常调用不记录用户原始音频。截图 `native-panel.png` 已由主代理查看。

### 日常加载（非隔离实例）

加载前核对日常实例 running=0、voiceActive=false，再重载扩展与 Native 进程。`daily-status.json`、`daily-install.json`、`daily-loaded.json` 留证：

- ChromeMain 扩展 `fnbjglhppbkgmjeehablkfilmmefjolo`；真实运行后台与磁盘构建 SHA256 完全一致，实际提供的侧栏资源与构建一致。
- 日常 Native 进程实际连接后返回 `Realtime 3 已连接`、`inputMode=server_vad`；随即结束验证连接。**没有启动用户麦克风、没有向日常会话发送任何任务指令。** 临时只读观察钩子已恢复。
- Chrome 拒绝脚本自动打开原生侧栏（需要用户手势），未绕过；用户正常点击 Chrome 工具栏的 By Your Side，再点“语音”即可进入新版本。自动行为验证使用无头隔离实例，不冒充真人或发布验收。
- 原试用窗口已由用户关闭，确认无页面、无语音、宿主断开后，按准确命令/PID 退出遗留试用进程；未删除资料。见 `trial-retired.json`。

### 原失败和测量修正

- 首次检查器把客户端 voice 命令当成服务端 event，发生 undefined.kind；保留 `native-path-first-harness-error.json`，改为区分方向/可选 event，未改变产品判据。
- Chrome 假音频文件尝试未出现 ASR；后来量到 1255 帧全零。保留 `native-path-no-asr.json`、`native-path-zero-capture.json`；不能据此归因 3 听不懂。改为显式合成 MediaStream，仍经过生产 AudioWorklet 和真实 API；不声称验证了物理麦克风。
- 首轮页面翻译通过时只检查了先前 response 的播放，未证明最终交付播完；该窄结果保留为 `native-path-translation-only.json`，收紧为精确 deliveryId 的 played 回执后再通过。
- 补真实重连前的通过结果保留为 `native-path-before-reconnect.json`。没有抹去失败、把未跑记为通过或扩大旧票组。
