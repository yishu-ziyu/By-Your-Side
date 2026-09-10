# Grok执行委派：任务结果齐备后5秒内结束

用户已明确批准实施 `docs/evals/20260910-task-completion-tail.md`，先完整阅读该冻结标准。用户最新要求“接下来子agent就派grok”，因此改由Grok实现和测试，主代理继续规划/评审；已允许主代理在宿主启动准备并审查过的脚本。产品仍A，B/C不接入。承接DeepSeek已完成的测量工作，当前交接见 `handoff-grok.md`。

## 目标、门槛、边界

目标：六次固定短任务全部正确完成，最长收尾等待≤5.000秒；正确性与时间由独立fixture判定。完整结果显示且模型/工具实际结束才能停表。结束后10秒无新的同任务操作/重复完成。冻结文件为唯一标准。

保留A登记/目标绑定/权限，不换模型（仍M3/medium）、不调低推理、不截历史、不改语音策略、不硬编码测试站点/随机值/任务关键词。不能用UI提前idle、模型仍在后台、丢弃必要正文或读测试oracle变量过关。旧R3不得伪称修复或借新增完成出口解除unknown。

## 所有权

你负责新任务的所有实现、验收驱动、离线测试与真实结果分析；主代理只规划、读证据与评审，并依已有授权启动你的宿主脚本。你不是代码库唯一使用者，保留所有其他人的WIP；禁止reset/clean/checkout覆盖或回退其他更改，不提交推送。

当前root `/Users/mahaoxuan/Desktop/ego`；先确认instructions/HEAD/WIP。建立新快照 `/tmp/ego-completion-tail-20260910/{A,candidate}`，A必须来自当前完整WIP，不从HEAD或旧B/C复制产品。依赖可只读复用，不复制.git；记实际源码hash。

root允许你写 `docs/tasks/20260910-completion-tail/` 的plan/progress/report/scripts/logs；验收标准、STATUS、NOTES、devlog由主代理维护。候选产品源码、测试、harness写隔离副本，主代理判定通过后再回接有限差异。

## 先做能启动的步骤

当前前提已具备：用户冻结标准、A代码、已有真实Chrome/M3/侧栏harness、宿主执行授权。当前先做独立测量与A复现；候选必须基于已复现原因。

1. 复用上一轮修好的脚手架与预检（仅测试基础设施，不复用B/C产品差异）。修建独立收尾测量：预先定义T结果齐备，完整正文可见时间、实际runtime停止时间，10秒结束后检查。不要从产品completion状态当oracle；不能用最后一次验证重置T起点。
2. 初版工具：单场景baseline复现入口 + 六次对照编排。需要真实Chrome时交给主代理运行；你已知worker DNS/loopback拒绝，不重复提权、不绕过。脚本先离线自检，启动预检通过才进模型；输出原始JSON、hash、独立批目录、失败保留、异常路径也记录已有时间和事件。
3. 在 `plan.md` 写已观察根因、最小实现方案、涉及模块和为何能满足门槛；不要一开始设计泛化大框架。主代理会审查，不把内部阶段切换变成向用户重复请示。
4. 依现有A复现写生产模块反例，然后实现候选。保持原断言；任何发现的验收驱动错误须提供证据给主代理，不能自己改标准。对外工具参数不能让模型声明成功成为真实完成证据。
5. 候选边界通过后按同fixture/seed/task/model测六次，与A六次交错。失败或>5s继续查原因修复新候选；每次代码变更新批，旧失败保留，不只重跑失败项刷通过。不能缩短用户任务或把等待挪到计时之前。
6. 真正达标后由主代理选中，再由你回接当前WIP有限差异，typecheck/test/build及同六次真实复验。正式加载脚本也由你准备，主代理审查并在宿主运行。没有通过前不动正式产品、不重载。

## 现有证据与入口

- 原问题：`docs/research/20260910-agent-responsiveness/report.md` §4.1/7。登记描述结果却按tool+target+工具成功判断；换方法可能留下pending，snapshot成功不等于状态成立。
- 现有生产链：`shared/task-results.ts`、`agent/src/task-results.ts`、`task-progress.ts`、`session.ts`、`conversation-manager.ts`、`conversation-runtime.ts`、`tools.ts`、`browser-program.ts`。先定点读调用链，别无关改UI/模型/语音。
- 上轮稳定测试基础设施位于 `/tmp/ego-binding-ab-20260910/A/scripts/acceptance/`：harness-s2-run.mts、binding-ab-fixtures.mts、binding-ab-metrics.mts、voice-evidence.mts；root编排 `docs/tasks/20260910-binding-ab/run-ab.mjs`。只借测试接线，不改或覆盖旧证据。
- 上轮有效原始批 `docs/tasks/20260910-binding-ab/runs/20260910T045813-60319` 可辅助定位，但不是新5秒验收数据。
- `docs/tasks/20260910-binding-ab/review-harness.md` 是测量错误清单：内部工具不发RPC、ServerMessage无at、开始尝试不等于真实动作、失败必须存指标、无.git不能崩、error不保证exit、不要覆盖旧批。
- 涉架构按项目要求读 `/Users/mahaoxuan/Desktop/coding/index.md` 对应 standards；重用现有AI接线时只查相关组件，不新增provider/外部服务。

## 进度与证据

尽快写progress.md，之后每完成子步骤更新：最近实际执行命令/结果、当前代码状态、下一步。不要长时间无共享状态，不在无限等待循环里阻塞主代理的新消息。

所有检查从命令开始就保存原始stdout/stderr与退出码；不要在最后只抄录“已观察摘要”。每个真实样本保存页面真值、必要读取首次返回、正文完整显示、运行真正停止、10秒观察，以及页面/会话标识。机密凭据不得落日志。

首个测量交付点已经存在，见progress及handoff-grok。接着由主代理启动真实A复现，你根据结果实现。没有必要再请求用户批准已有范围。
