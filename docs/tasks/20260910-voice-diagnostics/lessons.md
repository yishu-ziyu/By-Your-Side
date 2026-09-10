# 本轮失败与修订

暂无本轮实现失败。此前真实录音未保留；合成输入与假ASR仅证明触发/提交，不证明识别正确。旧转写过滤必须在过滤之前取证；客户端audio回调不能冒充服务端实际发送。

## 实现轮：类型与工具

- 检查项 `npm run typecheck`；失败值 exit 1，voice-client.ts TS2687（`diagnostic` 修饰符不一致）+ TS2349（`Type 'Boolean' has no call signatures`）；根因：诊断开关字段与注入的 `diagnostic?` 回调同名，类字段遮蔽了回调参数，且一次 `perl -pi` 改名只改了使用处没改字段声明。修订：字段改名 `diagSession`，回调保持 `this.diagnostic?.()`，改名后须 grep 声明与使用两侧。
- 检查项：用 `apply_patch` 改 voice-client 构造函数；失败值：上下文空白不匹配被拒；根因：该文件用空格混排的单行紧凑风格，补丁里我重排了空白。修订：改用精确字符串 `edit`，不重排无关空白。

## 实现轮：定点测试暴露的问题

- 检查项：C0 时长上限（每次60秒）；失败值：第二帧 24000 样本、上限 2 秒时返回 `ok` 而非 `full`；根因：返回 `full` 的条件是"已经丢过样本"，客户端要再收一帧才知道停。修订：`samples >= maxSamples` 即返回 `full`，客户端在同一边界结束本轮；上限外到达的帧只标 `capped`、不再存储。
- 检查项：容量上限（保留记录条数内最多 3 段音频）；失败值：期望 3 段实得 4 段；根因：`trim()` 只在 `captureStarted` 调用，某轮结束时新结束的记录未参与释放。修订：`captureEnded` 也调用 `trim()`。
- 检查项：未完成标注；失败值：恰好录满上限（无样本被丢）也被标为"音频被截断"；根因：一个布尔量同时表达"到达上限"和"样本被丢"。修订：`capped` 只表示有样本被裁或被丢，`endReason==='limit'` 表示到上限结束，两者都计入未完成，只有前者写"被截断"。
- 检查项：未确认后端不发音频；失败值：断言 `['start']` 实得 `['start','stop']`；根因：断言错了，不是缺陷，`fail()` 经 `stop()` 会发 stop 释放服务端会话（诊断不回退为普通模式）。修订：断言改为 `['start','stop']` 并显式断言没有任何 `audio` 命令。
- 检查项：上限外帧的归属；失败值：`captureFrame` 期望 `ignored` 实得 `full`；根因：测试顺序问题，该帧落进了下一段已开启的记录。修订：重排时序，同一段内先验证边界再结束。

## 实现轮：真实链路复查发现的缺陷（非测试暴露）

- 检查项：侧栏真实报文入口 `parseServerMessage`；失败值：`isVoiceServerMessage` 没有 `diag` 分支，诊断记录会被判非法整条丢弃，客户端永远等不到确认并在 8 秒后 fail-closed，整条链路在真实 Chrome 里都跑不通；根因：只是加了事件类型没更新共用的报文校验。修订：加 `case "diag": return isVoiceDiagRecord(e.record)`，并补一条经 `parseServerMessage` 的边界测试。
- 检查项：手动开始录音可用性；失败值：`diagStart.disabled=!log.isConfirmed||...` 在任何会话开始前就是 disabled，用户第一次点击不可能发生，且确认失败后无法重试；根因：把"等待确认"和"不可开始"混成一个条件。修订：`client.diagnosticRecording||(client.active&&!log.isConfirmed)`，空闲可重试、活动且未确认时禁用。
- 检查项：DOM 最终文字取证；失败值：点"结束录音"时用 `displayText(text,true)` 把当时可能还空/旧的 question 文字钉成最终值，随后真实 user text 到达后的更新被 `final` 规则拒绝，一致性会假报不一致；根因：final 的含义被用在"用户动作时刻"而不是"文字渲染之后"。修订：结束时刻记非 final，user text 渲染后记 final。
- 检查项：诊断期间不得有网页操作；失败值：VoiceRelay 的 commit 富化会对每次 commit 读取页面 context/observation（正常路径需要，诊断不需要）；根因：诊断命令沿用了普通 commit 的接线。修订：lease 记录 `diagnostic`，诊断 commit 跳过富化；补 relay 定点测试。
- 检查项：C0 必须在 classifier 之前复制；失败值：诊断模式原本直接跳过 classifier，等于没有转移这一步，"转移前复制"无从验证；根因：把"分类器不决定轮次"和"分类器不接收帧"混为一谈。修订：诊断仍向 classifier 推帧（复制与 `pcmBase64` 都在 push 之前），只让它的判定不再驱动 turn。
