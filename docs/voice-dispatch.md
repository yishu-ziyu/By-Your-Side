# 任务调度与回执

文字与语音共享任务调度。语音接入和播放见[语音架构](voice-architecture.md)，实现状态见[STATUS](STATUS.md)。旧 2.5 的说明见[历史](history/20260920-voice-dispatch-snapshot.md)。

## 身份与入口

- 任务请求按请求、任务和控制版本识别；不能用当前可见会话替换原请求归属。
- 上一个任务还没做完、而用户在回答助手的问题时，文字新消息按插话续接原任务。见[记忆、过往任务与任务跨轮](memory-and-tasks.md)。
- Realtime 工具 `task_action` 是语音适配接口，不是共享协议里的同名类型。
- 用户在任务运行中明确说“终止任务”时，任务宿主直接下发中止，不读回，不经模型。其他中止说法仍由模型转达。
- 语音的各项后台判断走[后台判断入口](model-effort.md#后台判断)。
- `read_page` 不启动网页写任务，不切换标签页。用户要切换标签页时，是否选对工具依赖语音模型判断，不由工具名或提示词保证。

## 回执

| 回执 | 含义 |
|---|---|
| accepted | 请求已接收，不证明网页结果成立 |
| applied | 控制或查询已应用，按具体动作解释 |
| rejected | 条件不成立、未执行 |
| failed | 明确失败，可能部分完成，应读回执 |
| unknown | 不能确认执行结果，不自动重做 |

执行前，程序登记持久记录；出现异常时，记录保留不确定性。结果交付和播放另有生命周期，不能由 accepted 或 idle 推断“完成”。

## 页面、排队与恢复

网页操作经扩展执行与控制检查。接管时，先挡住新写入，再等在途动作排空。恢复需要新页面观察和原任务身份；断连或超时不代表已停手或已完成。

多个独立要求的准入与结果关联见[多要求设计](voice-multi-request-design.md)。容量是策略配置，不是服务承载量实测。

重启保留会话和任务资料，不自动重放未知网页动作。未通过项在 STATUS 维护。

## 维护入口

- [任务类型](../shared/task-actions.ts)、[任务队列](../agent/src/task-queue.ts)、[调度器](../agent/src/task-dispatcher.ts)、[管理器](../agent/src/conversation-manager.ts)。
- [扩展后台](../extension/src/background/index.ts)、[语音资料](../extension/src/background/voice-observation.ts)、[连接](../extension/src/background/uplink.ts)。
- [桥接协议](protocol.md)、[人机协作约定](human-ai-contract.md)。
