# 架构与维护

本页描述代码职责与修改落点，不维护发布状态；当前结论见[STATUS](STATUS.md)。

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

## 主要维护入口

| 要改什么 | 先读与修改的位置 | 必须保留的边界 |
|---|---|---|
| 模型选择交互 | `sidepanel/model-picker.ts`，纯显示规则在 `models.ts` | DOM与发出选择由入口注入；收到模型回执才更新当前选择 |
| 语音识别后的意图 | `agent/src/voice-intent.ts`、`voice-model.ts`，经 `session.ts` 转发 | 分类不执行工具；保留总超时、重试、输入原文和当前模型 |
| 纠正、确认、暂停 | `voice-confirm.ts`、`voice-plan-store.ts`、`conversation-manager.ts`、`task-dispatcher.ts` | 原页面/附件/runId/controlVersion；确认不确认自身 |
| 新浏览器能力 | `shared/protocol.ts` → `agent/src/tools.ts`/`browser-program.ts` → `background/exec/` | 单工具与组合执行经过同一页面、执行与授权检查 |
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

浏览器验收脚本见 `scripts/acceptance/`，默认隔离/无头；日常Chrome原生测试是另一种证据。语音改动的文字/合成测试不能替代真人声学验收。门槛以 `eval/protected/quality-gates.json` 为准，不因整理仓库修改。

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
