# 自动恢复任务分工

先读冻结标准 docs/evals/20260909-voice-auto-recovery.md。其它任务继续，本文件按编号新增明确归属。

## K-TRANSPORT-03 / Kimi
- K-ACK-02已交回，当前只处理native帧方向限制。所有权：agent/src/transport/stdio.ts、agent/test/stdio-transport.test.ts及自有新增聚焦测试。
- 当前MAX_FRAME_BYTES=1MiB被FrameDecoder输入和encodeFrame输出共用；decoder超过即input.destroy，native onClose退出。输入与输出上限应分离，输入64MiB、输出1MiB，仍有安全边界，不无限缓冲。
- 添加不含原文的拒绝诊断（方向、字节数、限制）。最小修改，不读整个语音链路，不改main/voice/client/UI；有额外需求直接BLOCKED。
- 仅聚焦自测，直接向Boss报告：[执行者回报][Kimi][K-TRANSPORT-03][READY或BLOCKED]。详情 docs/tasks/K-TRANSPORT-03-report.md。

## AG-RECOVER-03 / Anti Gravity
- 先交回AG-UI-02并停下CSS写入，再开始此任务。K-ACK-02已交回无写者；新所有权：extension/src/sidepanel/voice-client.ts、voice-ui.ts、main.ts（只连接回调）；extension/src/background/voice-relay.ts、index.ts（只voice连接回调）；shared/voice.ts（必要的可恢复错误标记）；agent/src/voice-session.ts（仅可恢复错误类型/时限标记，不改K-ACK-02语境回执）。对应自有聚焦测试。不得改voice-receipt.ts或stdio.ts。
- 已定位：main.ts Port.onDisconnect直接voiceUI.disconnect→client.fail→stop清空麦克风；background VoiceRelay.disconnected同样发error清lease。普通侧栏虽自动重连，语音不恢复。上游Step本身已在agent重连，不能叠成多套无界重试。
- 用明确的连接状态/可恢复错误标记驱动恢复，不用“任何错误都重新start”或靠文案匹配。健康连接断开时保留用户开语音意图和同会话；复用可用mic流，停止过期音频；传输ready后开始新voice连接/代次，旧回调不串入；新代次不重放旧音频/写入。
- 可恢复错误有限退避（建议最多3次、总30秒），用户停止/切换会话取消所有恢复。配置、权限、模型不匹配等永久错误仍由用户处理；29分钟正常会话时限可标记为续接而非让用户手点。
- 保留上一轮目标/回执来源，不宣称host重启后任务仍在执行。先完成最小可验证闭环，不新增大型恢复框架。
- 不跑全量、build/reload，不操作用户浏览器。直接向Boss报告：[执行者回报][Anti Gravity][AG-RECOVER-03][READY或BLOCKED]。详情 docs/tasks/AG-RECOVER-03-report.md。

## 通信
Boss接收：cmux send --workspace workspace:3 --surface surface:3，待文本送入后同目标send-key Enter。ACK确认收到，READY后停笔。禁止对Boss发Ctrl+C/Escape。旧已关闭任务不重复分析，标准与Boss测试仅Boss维护。
