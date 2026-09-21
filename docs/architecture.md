# 架构与维护

核对工作树：2026-09-20。本页描述代码职责与修改落点；当前开关、加载和验收只看[STATUS](STATUS.md)。安装运行见[README](../README.md)。

语音链路的全栈职责、四种生命周期及改造依据见[Voice架构与改造边界](voice-architecture.md)。

## 运行边界

```text
侧栏输入/呈现 ── runtime Port / relay ── 扩展后台 ── native stdio ── 本地 Agent
                                           │                        │
                                     浏览器工具执行             会话/模型/任务调度
                                           │                        │
                                     页面脚本与 CDP           工具请求经 RPC 返回后台

两侧依赖 shared 的协议和纯规则，不导入对方的运行实现。
```

| 位置 | 拥有的职责 | 不应承担 |
|---|---|---|
| `shared/` | 消息契约、输入校验、跨宿主纯规则 | Node/Chrome执行、文件存储、模型调用 |
| `agent/src/main.ts`、`transport/` | 本地进程启动、连接与生命周期 | 页面DOM或侧栏渲染 |
| `agent/src/conversation-manager.ts` | 用户会话、任务身份、语音路由与交付协调 | 浏览器执行实现 |
| `agent/src/conversation-runtime.ts` | 装配每会话的RPC、Lead、协作团队、授权等待区 | 跨会话共享可变状态 |
| `agent/src/session.ts` | Pi会话、工具挂载、当前任务及接管生命周期 | 侧栏选择状态 |
| `extension/src/background/` | 上行连接、页面归属、执行闸门、历史与控制回执 | 依赖侧栏是否打开才能运行 |
| `extension/src/background/exec/` | 浏览器工具的实际读写 | 自行决定用户意图或绕过授权 |
| `extension/src/content/` | 页面内观察、输入、标注与事件采集 | 会话管理、模型状态 |
| `extension/src/sidepanel/` | 输入、局部视图状态、收到消息后的呈现 | 以显示状态代替任务执行事实 |

扩展内部协议是 [relay.ts](../extension/src/relay.ts)，扩展与Agent之间是 [protocol.ts](../shared/protocol.ts)。具体消息语义见[协议说明](protocol.md)。

## 请求经过哪些判断

文字请求由扩展送入 `ConversationManager / TaskDispatcher`，每个会话的 `createConversationRuntime` 装配 RPC、Pi、Fleet 和授权。`BrowserAgentSession` 持有当前目标、工具和执行生命周期。

当前 `session.ts` 的任务入口按条件尝试：已保存技能复用 → 已有译文的显示操作 → 通用浏览器循环 → 普通 Pi 任务。前一路可直接结束，也可能携已有执行事实交接；不是每句话都要完整走四遍。

- **技能复用**：复用已保存且符合条件的做法；失败要保留已执行步骤，不从头重放。
- **显示操作**：仅适用已有译文和有效文档状态；配置开启且条件满足时调用 Jev。运行中的显示修改还有单独开关与身份检查。
- **通用循环**：`generalBrowserLoop` 开启、act 模式、工具可用、无选区/图片、具备任务与页面上下文等条件成立时，从任务入口调用 `browser_loop`。`browser-decision-loop.ts` 获取观察、让 Jev 选候选、按需由主模型准备材料，经原工具执行与读回；停止或交接后由主模型核验/处理剩余要求。循环结束不代表目标完成。已有标签作为浏览器级候选加入同一观察；执行前核对来源与目标身份，切后读取活动标签。页面控件截断不等于浏览器标签能力缺失，原权限/取消与最终任务核验保留。
- **普通任务**：主模型处理开放式规划、内容生成、工具选择和最终核验；`browser_run` 是其可用的 QuickJS 组合执行工具，不等同于 Jev 决策循环。

语音先由 Realtime 3 选择工具；明确任务在相应装配下可经结构化入口进入上述任务系统，旧路由/确认仍有保留分支。准确路径见[语音架构](voice-architecture.md)。

## 状态归属与数据

| 状态 | 持有者 | 边界 |
|---|---|---|
| 用户会话与执行实例 | `conversation-manager.ts`、`conversation-runtime.ts` | 切换界面不改变后台任务身份 |
| 当前任务、修改与结果 | `session.ts`、任务调度/账本模块 | 接收、执行、读回、目标完成分别记录 |
| 页面归属与在途动作 | 扩展 `background/` | tabId 不等于授权；晚到操作受任务/页面版本约束 |
| 聊天展示与草稿 | 扩展历史、侧栏、Chrome storage | 不是任务执行的事实来源 |
| Pi 对话、任务回执、显式记忆、经历、技能 | `conversation-store.ts` 等；本机 `~/.sideagent/` | 各自存储，不将历史文字或经验自动提升为用户授权 |
| 语音输入和播放 | Realtime 会话、relay、播放器、交付账本 | 停声、关通话、取消任务是不同动作 |

## 哪些是硬约束

页面/任务身份、参数校验、授权消费、取消、重复请求和未知写入保护由代码执行。回复简短、正确理解、挑选合适工具、对照用户目标仍含模型判断。提示词和结构化输出都不能单独证明行为正确；验收必须到真实页面结果。

## 主要维护入口

| 要改什么 | 先读与修改的位置 | 必须保留的边界 |
|---|---|---|
| 模型选择交互 | `sidepanel/model-picker.ts`，纯显示规则在 `models.ts` | DOM与发出选择由入口注入；收到模型回执才更新当前选择 |
| 语音工具选择与任务交接 | `realtime-voice-connection.ts`、`realtime-voice-session.ts`、`conversation-manager.ts`；旧分类分支另查 `voice-intent.ts` | 真实转写与来源绑定；工具判断不能自行授予页面权限 |
| 纠正、确认、暂停 | `voice-confirm.ts`、`voice-plan-store.ts`、`conversation-manager.ts`、`task-dispatcher.ts` | 原页面/附件/runId/controlVersion；确认不确认自身 |
| 新浏览器能力 | `shared/protocol.ts` → `agent/src/tools.ts`/`browser-program.ts` → `background/exec/`；通用候选另查 `shared/browser-decision.ts` 和 `browser-decision-loop.ts` | 单工具与组合执行经过同一页面、执行与授权检查 |
| 页面移交与接管 | `background/tab-bindings.ts`、`state.ts`、`worker-tab-control.ts`、`shared/control.ts` | 操作绑定目标tab；读页不等于认领；旧回执不得改新任务 |
| 授权 | `agent/src/fetch-consent.ts`、`consent-ticket.ts`，共享展示契约在 `shared/consent.ts` | Node账本归Agent；一次授权绑定原参数和任务身份 |
| 新记忆或技能行为 | `memory-store.ts`/`memory-runtime.ts`、`skill-store.ts`/`skill-runner.ts` | 历史、显式记忆、经验、技能分别存储；复用不能跳过当前页面校验 |
| 交付与进度呈现 | `task-progress.ts`、`user-delivery.ts`，侧栏 `steps.ts`/`selectors.ts` | 执行动作完成不等于用户目标完成；接收回执不等于正式交付 |

新功能先放进最接近的业务模块；需要另建模块时，让它独立拥有相关状态，并通过明确参数或回调连接。不要复制入口里的状态，再靠双向同步维护两份真相；不要把不相关功能塞进 `utils` 或新增通用服务容器。

## 检查与开发

```sh
npm run check:architecture # 生产代码依赖方向
npm run typecheck          # 两端类型
npm test                   # 普通回归后顺序运行规模测试
npm run build              # 扩展构建
npm run check              # 顺序执行以上四项
```

边界检查使用现有构建器解析静态import、export、字面量动态import与require，拒绝绑定某台机器的绝对文件路径、跨宿主实现依赖、扩展界面之间的实现依赖、生产代码导入测试/脚本，以及浏览器/共享模块中的Node内置模块。类型引用被擦除，不在运行依赖检查范围；计算出来的动态路径、行为耦合和任意循环依赖也不由此证明。类型检查、独立复核及真实入口验收仍需保留。

规模测试保留在 `agent/test/performance/`，`npm test` 先跑普通回归，再单Worker跑规模测试，避免测量与大批并行测试争抢资源。原数据规模、5秒单项超时及性能门槛不变；也可用 `npm run test:scale` 单独定位。

浏览器验收脚本见 `scripts/acceptance/`；执行前核对脚本实际连接的浏览器。项目要求默认无头，但旧 program 脚本仍直连 ChromeMain，不能当无头隔离入口直接运行。日常 Chrome 原生测试是另一种证据。语音改动的文字/合成测试不能替代真人声学验收。门槛以 `eval/protected/quality-gates.json` 为准，不因整理仓库修改。

## 源码与资料的归属

- `agent/test/`、`extension/test/`：行为回归；测试允许跨宿主装配，生产不允许。
- `scripts/`：安装、诊断、验收与维护入口；`scripts/fixtures/`：本地测试页面，不是产品页面。
- `extension/dist/`、`eval/runs/`、`out/acceptance/`：可生成的本地产物，按现有忽略规则管理。
- `agent/src/vendor/`、`extension/src/vendor/`、图像/模型/字体资产及许可证：保留来源，不当作业务冗余删除。
- `docs/`：见[文档导航](README.md)。历史证据不与生产代码一起打包，保留以便追溯失败和方案取舍。

## 仍需约束的维护热点

`sidepanel/main.ts`仍包含会话/知识与执行过程视图，`background/index.ts`仍包含每会话控制器装配，`conversation-manager.ts`仍协调语音确认与交付。它们没有因本次提取变成小文件。本轮先分离独立模型调用和模型选择；之后修改知识管理或控制器时，沿完整职责提取并补生命周期验证。不要为了行数达标再制造一层转发，或把共享状态拆成相互回调的碎片。

## Stagehand 兼容层

`browser_run` 的 `api:"playwright"` 模式通过 `stagehand-bridge.ts` 在现有 QuickJS 中加载固定上游的官方兼容代码，提供 page/context。每步经现有 tools/RPC 控制链；程序固定开始时的任务 tabId。默认 ego 模式与已有工具保持兼容。此接法不需要 Browserbase Key，也不引入另一套浏览器扩展或 SDK experimentalBatch。支持范围和本地补丁见 `agent/src/vendor/stagehand/PATCH.md`；验收见 [接入记录](evals/20260913-stagehand-control-integration.md)。


## 用户目标与原文材料

`TaskResultBook` 保留执行回执和未知写入保护；`TaskGoalBook` 保存用户目标。`TaskProgress.resultState` 在有目标计划时表示目标进度，`executionState` 单独表示执行账本；运行 idle 不等于完成。侧栏、语音进度与正式交付从这些宿主事实投影，不由模型自填状态。

`TaskEvidence` 保留本任务的观察与所选原文；原文来自完整元素文字或未压缩的 AX 文本/换行片段。`capture_page_material` 要求明确观察身份，代码复制文本，语义判断核对来源范围。所选材料与核验证书进入原有私有会话日志，快照仅保存引用。节点引用不跨文档复用；恢复和改口保持旧文本，但新目标须重新匹配来源。

核验先做身份、版本和字面相等检查，再处理必要语义；不确定时只对同一证据做一次主模型复核。目标身份与内容匹配分开，已知失败的旧方法不会覆盖已核验目标，未知副作用仍优先阻止重复操作。当前验收与未覆盖范围只看 [STATUS](STATUS.md)。
