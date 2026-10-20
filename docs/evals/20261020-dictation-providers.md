# 任务: 左侧麦克风使用独立选择的语音转文字服务

## 规则
- R1 在设置的「语音」中独立选择 Chrome、阶跃 Realtime 3（按量）、阶跃 Step Plan 或硅基流动，填写凭据、测试连接、保存；重新打开仍显示选择。语音对话设置不变。谁检查：真实扩展浏览器用例。
- R2 左侧麦克风使用保存的服务；确认只把文字放入草稿，取消保留原草稿；切会话、取消或重新听写后迟到的结果不能写入。谁检查：真实扩展浏览器用例。
- R3 凭据只发送给对应官方固定地址，不在日志、截图或错误原文中显示；失败提供可操作提示，不偷偷切换服务。谁检查：独立代码审查及真实扩展失败路径。
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

## 当前证据与阻断
固定预览包的隔离有窗口扩展通过设置、错误凭据、保存、重开设置、旧窗口防覆盖、真实录音上传后的权限错误、取消保草稿、等待时拒绝发送和语音对话、切会话取消、缺密钥提示；结果在 `out/acceptance/real-path/2026-10-20T08-11-35-661Z-dictation-providers/result.json`。音频是 macOS Tingting 合成中文，失败路径通过不能代表识别成功。

两份现有阶跃凭据在官方 Step Plan ASR 路径均返回 `404 model_invalid`，套餐模型列表仅列推理模型；旧实时转写探针也未连通。硅基流动没有有效凭据，仅验证真实服务拒绝无效密钥。Chrome 已验证浏览器能力及权限，受控音源转写、真人语音与日常 Chrome 均未验证，这些服务边界不等于 Realtime 3 通道受阻；本轮以已获授权的 Realtime 3 真实路径完成接入，其他服务的成功识别仍如实列为未验证。

Claude 独立审查后已修复识别错误丢字、输入法 Esc、设置窗口覆盖、切会话取消、发送互斥和开麦无限等待。类型、文档、样式、用词、动效、架构检查通过，设置页旧用例通过，前后截图总览在 `out/gallery/2026-10-20T08-12-44-171Z/index.html`。
