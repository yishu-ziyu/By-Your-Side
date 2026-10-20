# 任务: 左侧麦克风使用独立选择的语音转文字服务

## 规则
- R1 在设置的「语音」中独立选择 Chrome、阶跃 Realtime 3（按量）、阶跃 Step Plan 或硅基流动，填写凭据、测试连接、保存；重新打开仍显示选择。语音对话设置不变。谁检查：真实扩展浏览器用例。
- R2 左侧麦克风使用保存的服务；确认只把文字放入草稿，取消保留原草稿；切会话、取消或重新听写后迟到的结果不能写入。谁检查：真实扩展浏览器用例。
- R3 凭据只发送给对应官方固定地址，不在日志、截图或错误原文中显示；失败提供可操作提示，不偷偷切换服务。升级后的 Chrome 默认选择也不再自动改走阶跃，避免音频流向和计费渠道与所选服务不一致。谁检查：独立代码审查及真实扩展失败路径。
- R4 对有凭据的服务用已知中文合成音频走真实识别；无凭据明确记未验证，模拟输出不计识别通过。谁检查：浏览器用例与证据人工复核。

## 还没答上的问题
无。第三方真实服务验收取决于有效凭据，缺失必须报告，不影响配置接入的实现。

## 技术前提
- Realtime 3 的真实探针已准确转写已知中文：`modalities:[text,audio]`、`turn_detection:null`，不发送 `response.create`，不使用提示词约束；转写后继续观察 10 秒无回复事件。关闭 VAD 回显为 `{type:""}`。证据在 `out/acceptance/realtime3-transcription-probe/`。
- 阶跃官方 [Step Plan 语音接入](https://platform.stepfun.com/docs/zh/step-plan/integrations/audio-api.md) 指定 `/step_plan/v1/audio/asr/sse` 和 `stepaudio-2.5-asr`。这是整段上传、SSE 返回文字，不是边录边传。
- 硅基流动官方 [转写 API](https://docs.siliconflow.cn/docs/api/audio-transcriptions-post) 使用 multipart 文件和 `FunAudioLLM/SenseVoiceSmall`，返回 JSON text，未声明流式输入。[模型原件](https://github.com/FunAudioLLM/SenseVoice) 明确支持普通话与粤语。
- Chrome SpeechRecognition 的音源不能仅凭 fake-audio 启动参数假定；识别结果必须与已知输入对齐才算音频验收。
- 设计依据：Will's S Design Note「Designing a Complex Form」：相关字段分组，保存为主操作、测试为次操作。沿用现有设置页 Magpie 原件与控件样式。

## 验收契约
Change：选择并保存识别服务后，左侧麦克风按该设置转文字。
Not this：仅列选项、静音播放或模拟识别成功均不算。沿用语音对话凭据须由用户明确选择并显示来源。
Evaluator：实现者驱动真实扩展，另一代理独立审查；用户保留视觉最终判断。
Evidence：浏览器结果、前后截图、类型检查与审查记录留在 out/。

Goal：保留已有多服务设置，Realtime 3 在真实扩展内只转写并实时出字。
Hard bar：真实 Realtime 3 配置、测试、保存、重开、实时增量、准确最终转写（仅允许标点/数字书写规范化）、确认不发送、取消恢复、切会话和并发保护；服务端无 response.* 事件或回复音频。
Improve：none。
Loop：修改 → 浏览器检查 → 读取证据 → 修正。

## 边界与不做
不改右侧实时语音对话、按住说话或模型渠道；不新增 OpenAI API key。第三家服务无凭据时不宣称真实识别已通过。

## 当前证据与边界
Realtime 3 已在隔离有窗口真实扩展通过完整路径：独立密钥和显式沿用语音对话密钥、连接测试、保存重开、实时文字、准确确认、双窗口互斥、录音及等待阶段取消、切会话取消、重开保留草稿。证据：`out/acceptance/real-path/2026-10-20T08-36-45-237Z-dictation-realtime/`。音频为 macOS Tingting 合成中文，经真实麦克风采集链路发送到真实服务；客户端没有 `response.create`，服务端没有 `response.*`，鉴权规则已清理。真人麦克风与日常扩展仍未验证。

禁用增量消费的隔离构建副本在「边说边出字」失败，服务器仍有增量，证明验收能抓住此缺陷：`out/acceptance/real-path/2026-10-20T08-37-03-653Z-dictation-realtime/`。设置页旧用例通过，前后总览在 `out/gallery/2026-10-20T08-35-13-389Z/index.html`。

两份现有阶跃凭据在 Step Plan ASR 路径均返回 `404 model_invalid`；硅基流动没有有效凭据。它们的成功识别未验证，服务失败提示、清除密钥及草稿保护已通过此前真实扩展失败路径。Chrome 已验证能力和权限，受控音源识别未验证。Realtime 3 按量实时语音已获用户授权，本轮不根据事件推断计费。

独立审查记录在 `out/realtime-review.log` 与 `out/realtime-review-final.log`。临时鉴权规则在正常连接、失败和取消后移除；浏览器页面在握手时被强制销毁可能遗留只匹配一次性随机地址的会话规则，重启浏览器清除。不会覆盖右侧语音规则，不给网页发起的连接补头。
