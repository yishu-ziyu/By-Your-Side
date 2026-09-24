# 任务核心进入扩展：4e–4g 验收

2026-09-24，基线 `bdc2667`，同一主目录上的未提交实现。用户要求继续 Claude Code 的④迁移，并按“只保留能比 E2E 多抓真实故障的隔离测试”审查本次相关测试；范围限定为 4e。以下记录每次失败，后续通过不覆盖原结果。

## 完成标准

- [x] 本机与扩展入口的 heldClick、ownership、duplicate、staleSteer 均按同一协议断言通过，扩展不再用 `it.fails`。— 谁检查：`entry-contract.test.ts`；证据：18 项定点测试（含系统提示词与来源范围）通过。
- [x] 只装扩展、从设置页配置模型后，文字任务圈住指定按钮且不点击，目标账本与侧栏正式交付一致。— 谁检查：隔离 Chrome + 真实模型 + 页面 DOM；证据：[智谱结果](../../out/acceptance/real-path/2026-09-24T03-34-03-829Z-inproc-mark/result.json)和同目录页面/侧栏截图，全部 verdict 为 yes，无本机 host。
- [x] 只装扩展，语音设置的音色由服务端回显，语音指令圈住按钮且不点击，普通网页不能借用语音鉴权头。— 谁检查：隔离 Chrome + StepFun 实时语音 + 页面 DOM；证据：[语音结果](../../out/acceptance/real-path/2026-09-24T03-35-02-178Z-inproc-voice-mark/result.json)，全部 verdict 为 yes，无本机 host。
- [ ] 用户语音明确终止正在执行的任务：停声不取消任务，确认终止只作用原 run，迟到旧请求无页面副作用。— 谁检查：真实扩展入口；[首次失败](../../out/acceptance/real-path/2026-09-24T03-44-59-811Z-inproc-voice-stop-task/result.json)和[补采样失败](../../out/acceptance/real-path/2026-09-24T03-49-48-910Z-inproc-voice-stop-task/result.json)均保留；待修复后重验。 **修订（同日）**：用户改为直接终止，新标准与通过证据见[直接终止验收](20260924-voice-direct-abort.md)。
- [x] 扩展构建不用日常 `extension/dist`，架构检查不再有扩展直接导入 agent 实现。— 谁检查：隔离构建、`check:architecture`；证据：`/tmp/bys-4e.4jTAhf/dist` 构建成功，263 个生产文件通过。
- [ ] 主模型可重试故障耗尽后切到已配置备用模型，同一上下文续跑，不重放已执行工具；任务记录和界面写明换过模型。— 谁检查：共享循环契约和真实路径；[协议级探针](../../out/acceptance/model-failover-4g-result.json)已证明工具执行 1 次、备用续接、缺凭据与上下文溢出不切；尚缺真实服务故障下的切换与顶栏读数。
- [ ] 真人试用新核心的任务与语音体验。— 谁检查：人；尚未交付日常扩展，不用隔离 Chrome 替代真人结论。

## 失败与修正

1. 首次 `inproc-mark` 在 Chrome CDP `Target.getTargets` 初始化超时；[原始结果](../../out/acceptance/real-path/2026-09-24T03-06-40-487Z-inproc-mark/result.json)保留。脚本没有走到产品动作。
2. 设置页成功但用户消息未送达：侧栏在会话就绪前允许输入，Enter 时尚不能发送，迟到的会话选择又清空草稿。CDP 帧记录在 `out/acceptance/real-path/2026-09-24T03-18-10-937Z-inproc-mark/`。修复为发送按钮在会话就绪前禁用、初始草稿随新会话保存；真实脚本等可发送后再输入。
3. 任务到达核心后 `task_goals` 报错：旧扩展 `route-shadow` 替身返回 `undefined`，而正式 `ConversationManager` 会调用其 `observe`。改为只实现观察接口的空对象；不把本机 Jev 影子请求带进扩展。
4. [圈画成功但交付失败](../../out/acceptance/real-path/2026-09-24T03-23-11-824Z-inproc-mark/result.json)：页面圈盖目标、无点击，`task_goals` 三次失败后目标仍为未完成。扩展取不到本机 TypeSafe 凭据；代码路径推断是 Jev 不可用，原始工具错误未在该产物保存。后来复用既有任务模型复核通路处理 Jev 调用失败，复核仍失败则不升级目标状态。智谱真实路径通过；这种降级是另一模型判断，不能等同 Jev 校准概率或独立供应商验证。
5. [阶跃文字路径](../../out/acceptance/real-path/2026-09-24T03-30-48-253Z-inproc-mark/result.json)实际圈画成功，但复核中的任务模型返回空响应，侧栏诚实报告部分完成；4g 的备用模型切换尚未接入，不能把智谱那次通过当作阶跃已稳定。
6. 语音明确说“终止任务”时，Realtime 已准确转写，却没交给控制路由，直接播报“任务已终止”；协议里没有 abort 回执，原任务仍等待点选。第二句“对”被当普通闲聊。补采样产物的 `voiceSamples` 与协议帧构成反例；修复应保证模型不能用叙述替代控制回执。

## 相关测试取舍

本次没有删除 4e 相关隔离测试。四条入口契约覆盖待确认点击、跨会话串号、重复请求、过期修订；两条真实路径尚不能稳定触发这些故障。现有重试、钩子与语音停止隔离测试也有独立故障类型。全局与项目 AGENTS.md 已有图片中的三条测试规则，不重复添加。

## 边界与未跑

- 隔离 Chrome 与真实供应商证明上述路径，不证明日常 `extension/dist` 已更新；本轮没有重载日常扩展。
- 未跑全量测试与发布评测；只有受影响的入口契约、来源范围、类型、架构、文档和两条真实路径取证。
- 第一版扩展内队列与回执仍是内存存储；offscreen 重启后的持久去重不在这轮结论内。
