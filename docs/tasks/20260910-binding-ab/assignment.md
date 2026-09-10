# DeepSeek执行委派

## 当前授权

用户明确指定：Codex规划，DeepSeek实现并执行测试/A-B比较；当前任务只解决登记与目标绑定的额外往返。遵守docs/evals/20260910-registration-binding-ab.md冻结标准。项目默认不委派已被本次明确授权覆盖；不要再委派其他模型。不要修改AGENTS.md或全局规则。

## 责任与文件所有权

你不是工作区唯一参与者，当前main有大量既有WIP，不能回退他人改动。你负责：创建当前工作区的隔离A/B/C副本；候选产品代码；全部测试与比较脚本；写入docs/tasks/20260910-binding-ab/下的执行记录/JSON/报告。未经主代理选型，不改当前产品源码。主代理负责冻结验收、检查证据、选型和项目状态入口，请不要写docs/STATUS.md或docs/NOTES.md。

实验副本可以放/tmp/ego-binding-ab-<unique>/；完整复制当前相关代码和构建配置，依赖可只读复用当前node_modules。不要用HEAD创建丢失WIP的基线；不要带密钥或私有浏览轨迹到副本/报告。记录各副本源码hash，冻结A。A/B/C参数只影响本次机制；不要永久引入一堆产品试验开关。

## 必读与精确线索

- docs/evals/20260910-registration-binding-ab.md（本次标准，绝不修改）
- docs/research/20260910-agent-responsiveness/report.md（已有整体研究，按相关节读）
- docs/evals/20260910-browser-environment-state.md（前轮失败与首轮工具修复）
- agent/src/session.ts: assertTaskResultExecution, observeProgramStep, bindTaskResults
- agent/src/task-results.ts: register/noteStart/noteEnd; shared/task-results.ts
- agent/src/task-progress.ts: tool_start/tool_end及持久化接线；conversation-manager.ts/runtime.ts
- agent/src/tools.ts: execution上下文、browser_run直接onStep，保持已修的同步子步骤绑定
- shared/control.ts, extension/src/background/observation-document.ts（不扩大读写权限）
- scripts/acceptance/harness-s2-run.mts已有state_environment/state_tools场景，复用生产侧栏/真实M3/隔离Chrome。媒体事件计数必须MAIN world，旧partial baseline错误已修，重新跑A。
- agent/test/browser-program-binding.test.ts, task-results.test.ts, write-receipt-loss相关定点。R3未通过的历史反例继续单列，不偷改。

已核对ego-lite公开源码5ca3c36c，副本/tmp/ego-lite-source-20260910；本轮不必再次泛搜。借鉴执行层承担固定的绑定/等待，不要写站点特例。

## 执行顺序

1. 先确认cwd/当前WIP，准备隔离副本及简明实施分解。先写新行为与反例测试，报告必要的旧断言修订。
2. 独立实现B、C，跑固定边界，失败继续修。所有代码/测试由你完成；主代理不代写实现。
3. 通过边界再跑同模型同条件的18次交错A/B/C。基于本地fixture，不操作用户Chrome/邮件/网站。可并行准备材料，真实模型调用避免并发引起负载偏差。
4. 写report.md与每次JSON/日志索引、源码hash、精确测试命令、差异文件。报告正确性与性能分开，指出基础设施失败，不隐藏原失败。
5. 此轮完成后停在待主代理选型，不自行回接或重载。

进度：完成副本与红测、边界通过、首组对照、全部结果各汇报一次。运行长时通过任务目录的progress.md更新当前阶段、运行中的命令和证据路径，避免只有结束时才交付信息。

若DeepSeek路由失败/过期，明确报告，不自行换模型。若冻结标准实质上无法同时满足，先给反例与具体取舍，不能改标准让自己通过。
