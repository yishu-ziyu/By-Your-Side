# 语音架构

核对源码：2026-09-20。本文描述工作树的装配与约束；已加载哪一版、验证了什么只看 [STATUS](STATUS.md)。旧 2.5 的问题和改造计划见[历史](history/20260920-voice-architecture-snapshot.md)。

## 一次语音请求

1. `sidepanel/voice-client.ts` 收音并输出 PCM，经 `background/voice-relay.ts` 和 Native Messaging 交给本地 Agent。
2. `main.ts → VoiceService → RealtimeVoiceSession → RealtimeVoiceConnection` 接到 StepAudio 3。服务端判断话轮；当前日常工厂实例化 Realtime 3，不提供 2.5 运行时切换。
3. 语音模型选择读页、查任务或派发操作。`read_page` 通过本轮观察令牌读取当前页文字；没有图片理解，也不切换页面。空白重读在扩展观察层，仍失败返回失败事实。
4. 操作通过 `task_action`（装配启用时）或 `browser_request` 进入同一任务系统。前者处理明确 start/steer/pause/resume，后者保留需原路由/确认的情况。宿主使用真实转写，等待来源资料并核对话轮；不接受模型另造用户原话。
5. 页面执行、任务结果和用户交付由原任务系统处理；结果送回语音会话，Realtime 3 生成音频，浏览器播放并返回 `playback_done`。

## 四种生命周期

| 对象 | 身份与持有者 | 不可混淆 |
|---|---|---|
| 声音话轮 | voiceId、turn；客户端、relay、Realtime 连接 | 停顿不必然等于完整任务要求 |
| 用户输入 | 真实转写、来源片段、response 绑定；Realtime 会话和 manager | 晚到转写、补充和新要求不能随意合并或丢弃 |
| 网页任务 | requestId、runId、controlVersion、页面身份；manager、dispatcher、扩展 | 停声或关通话不等于取消任务 |
| 结果播放 | deliveryId、responseId、播放回执；交付账本和播放器 | 生成完成、已送音频、实际播完是不同事实 |

## 提示词和程序分别保证什么

| 行为 | 实现方式 | 能证明的边界 |
|---|---|---|
| 简短回复、不先朗读计划、选择操作而非读页 | `INSTRUCTIONS` 与工具说明引导模型 | 不能保证每轮遵守，须核对实际工具与内容 |
| 音色 | `voice` 配置，加同一说话人的提示词 | ID 回显不证明听感稳定，须真人试听 |
| 同一输入不重复派发、旧话轮不执行 | 输入消费集合、call ID 去重、话轮/来源校验 | 拦重复与过期；不能证明模型理解正确 |
| 工具结果回传 | `maybeFlush` 的状态条件 | 等对应生成结束；工具结果不等前导语播完；accepted/queued 的异步任务不额外生成一遍计划，等待正式结果；主动通知仍受播放状态限制 |
| 已播报状态 | 通知接收确认、delivery/response 绑定与 `playback_done` | 不把生成完记成用户已听完；超时涵盖前方未播音频队列，仍有上限与缺回执失败 |
| 页面读写权限与新鲜度 | 观察令牌、页面身份、任务控制和执行回执 | 由程序检查；提示词不是授权替代品 |

## 耗时怎么定位

分开测：说完→服务端判停，判停→实际工具调用，工具调用→结果就绪，就绪→结果送回，后续生成→浏览器首声/播完。`first_audio_since_vad_stop` 是服务端判停后的音频到达指标，不是用户实际听到答案的时间。

Native Messaging 是本地消息传输，不是另一次模型推理。代码或拓扑不能证明它零开销；归因需要同轮时间戳。旧分类/主模型/TTS 串行数据只适用于旧版本。

源码入口：[连接](../agent/src/realtime-voice-connection.ts)、[会话](../agent/src/realtime-voice-session.ts)、[读页](../agent/src/voice-page-reader.ts)、[服务装配](../agent/src/voice-service.ts)。任务控制另见[调度](voice-dispatch.md)。
