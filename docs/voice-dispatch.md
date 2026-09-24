# 任务调度与回执

文字与语音共享任务调度；语音接入和播放见[语音架构](voice-architecture.md)，实现状态见[STATUS](STATUS.md)。旧 2.5 的分类、打断和重连说明已移至[历史](history/20260920-voice-dispatch-snapshot.md)。

## 身份与入口

`shared/task-actions.ts` 定义任务请求，`ConversationManager` 协调目标，`TaskDispatcher` 负责接收、幂等与执行。`requestId` 标识请求，`runId` 标识任务，`expectedControlVersion` 等字段约束旧控制消息；不能用当前可见会话替换原请求归属。

- 文字入口发送共享 `task_action`；协议仍有旧 `user_message` / `steer` 等兼容入口。
- Realtime 工具 `task_action` 是语音适配接口（start/steer/pause/resume），不是完整共享协议的同名类型。宿主附真实转写、来源资料和目标身份后派发。任务运行中明确说“终止任务”时，由宿主按开口时的任务身份直接下发 abort，不读回、不经模型（见[语音架构](voice-architecture.md)的转写闸门）；其他取消说法仍可由模型走 `browser_request`，同样直接送达。
- `read_page` 不启动网页写任务，不切换标签页；`task_status` 查询已有事实。用户希望切换页面时是否选对任务工具，仍依赖语音模型判断，不由工具名或提示词保证。

## 回执

| 回执 | 含义 |
|---|---|
| accepted | 请求已接收，不证明网页结果成立 |
| applied | 控制或查询已应用，按具体动作解释 |
| rejected | 条件不成立、未执行 |
| failed | 明确失败，可能部分完成，需读回执 |
| unknown | 不能确认执行结果，不自动重做 |

回执保存在 `~/.sideagent/task-receipts/`。相同请求 ID 的内容冲突会拒绝；执行前登记持久记录，异常保留不确定性。结果交付和播放另有生命周期，不能由 accepted 或 idle 推断“完成”。

## 页面、排队与恢复

页面操作经扩展执行与控制检查；接管先挡新写入，再等待在途动作排空。恢复需新页面观察和原任务身份，断连或超时不代表已停手或已完成。

多个独立要求的准入与结果关联见[多要求设计](voice-multi-request-design.md)，实现入口为 `task-queue.ts`、`task-dispatcher.ts`、`conversation-manager.ts`。设计里的容量是策略配置，不是服务承载量实测。

重启保留会话和任务资料，不自动重放未知网页动作。恢复、控制和多会话组合的未通过项在 STATUS 维护；本页不重复测试成绩。

## 维护入口

- [任务类型](../shared/task-actions.ts)、[调度器](../agent/src/task-dispatcher.ts)、[管理器](../agent/src/conversation-manager.ts)。
- [扩展后台](../extension/src/background/index.ts)、[语音资料](../extension/src/background/voice-observation.ts)、[连接](../extension/src/background/uplink.ts)。
- [桥接协议](protocol.md)、[人机协作约定](human-ai-contract.md)。
