# 任务：对照官方 Demo 的原克隆音色与内置音色连续四轮发声

## 完成标准

- [x] 1. 使用官方客户端原代码，固定 Realtime 3、同句、同设置，仅换原 voice 与 qingchunshaonv — 谁检查：主代理、事件记录
- [x] 2. 每组保存四轮原始 WAV 和请求/响应记录，确认响应成功及音频非空 — 谁检查：实验脚本
- [x] 3. 两组录音交用户判断音色是否一致，据此决定后续接入方案 — 谁检查：用户

## 边界

用户明确拒绝 OS 的 TTS 路径，同意官方 Demo 两组对照。原有直接执行选择继续有效。日常不换音色，不修改产品语音链路，不启动麦克风或浏览器，不调用 TTS。

## 方法

官方仓库 commit 0812a2dd82b94602ea380c73468abb1718e28053，临时 checkout 为 /tmp/stepfun-doc-comparison/console。脚本 scripts/experiments/voice-official-demo.mts 导入原始 RealtimeClient，调用原始 connect/sendUserMessageContent，未改 SDK 配置和事件逻辑。

宿主差别：在 Node 中提供浏览器 WebSocket 适配器，使用与官方 Bun relay 相同的 StepFun 地址和 Authorization 头。原 SDK 的 Node 分支写死了 OpenAI 地址，因此没有使用该分支。没有运行 Svelte 页面、官方 Bun 中继和播放器；本实验检验 SDK 请求与服务端原始音频，不冒充完整 Demo UI 验收。

固定 instructions 为同一句朗读要求，手动四轮同句。其余保留 Demo 默认 session 配置，含 temperature=0.8、max_response_output_tokens=4096、turn_detection=null、tools=[]。每轮直接使用 Demo 的空 response.create。两组分别建新会话。

证据目录：out/acceptance/20260921-official-demo/。所有录音按原始 PCM16 24kHz 保存；comparison.wav 只拼接并添加一秒静音。

## 结果

- 原克隆音色：clone-1789971799019，四轮均 completed、有原始音频、转写均为指定同句。
- 官方内置音色：builtin-1789971808324，四轮均 completed、有原始音频、转写均为指定同句。
- 两组实际 session.update 仅 voice 不同；每组四次 response.create 均不携带覆盖参数。官方 checkout 无改动，git diff --check 通过。
- 已形成两段 comparison.wav，待用户试听判断是否跨轮换音色。未以音高统计或协议成功代替听感验收。
- 没有产品代码修改、构建、重载。没有新增 TTS 调用。

## 用户裁决与采用

用户确认 B（qingchunshaonv）只有正常语调/音高变化，没有音色变化；A 原克隆音色会换说话人。用户决定先用官方音色，记录克隆问题并停止排查。音高变化不是音色漂移判据。

日常 Realtime 3 的 STEP_VOICE 改为 qingchunshaonv；不改旧 2.5 类和历史实验中的 voice，不引入 TTS。原 voice-tone-T3kZb9MwL2 的适配问题留档，不阻塞其他开发。

### 日常加载验证

Realtime 定点测试 29 项通过。空闲状态重载日常扩展及 Native 宿主，连接 Realtime 3 成功；无麦克风、无页面写入。原会话选择已恢复。加载记录为 out/acceptance/20260921-official-demo/daily-load.json。仅更新当前 Realtime 音色常量，产品其他既有改动保留。
