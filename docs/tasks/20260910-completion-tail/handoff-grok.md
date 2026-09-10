# Grok续接：当前5秒收尾任务

用户最新指令：“接下来子agent就派grok”。DeepSeek线程已中断；未发现本轮遗留的vitest/tsx/esbuild/rsync进程。远端模型请求可能仍消耗其当前请求，但不再委派任何DeepSeek工作。Grok是当前唯一实现者，不新增代理、不换别的provider。

## 必读

1. `docs/evals/20260910-task-completion-tail.md`：用户已批准并冻结，六次全正确，最大收尾≤5000ms，真实结束后10秒无重复。
2. 本目录assignment.md、review-checklist.md、plan.md、progress.md。执行者由当前指令覆盖为Grok，已有测量和检查结果仍属于前任，不冒称自己已跑。

## 当前实际状态

- 新副本已存在：`/tmp/ego-completion-tail-20260910/{A,candidate}`。两者产品当前都为原A；candidate尚未改产品。root 245项左右WIP保留，严禁回退他人更改。
- 测量驱动已准备：副本`scripts/acceptance/completion-tail-{run,metrics,fixtures}.mts`；root编排`docs/tasks/20260910-completion-tail/run-completion-tail.mjs`。
- 前任最新离线记录：3文件47测试通过、typecheck退出0、esbuild打包通过、node --check通过；原始log在本任务`offline/`，先核对progress里的实际路径。
- 前任沙箱preflight遭tsx IPC EPERM；宿主执行已获授权，主代理负责启动，不重复请求已拒权限，不绕过。
- 新5秒标准下尚无真实样本，尚未复现/改产品，不能引用旧A83.7s作为新收尾指标。

## 主代理已经退回并要求修复的测量问题

前任报告已修，接手只需定点核对，不重做整个脚手架：

- T0外部真值首次达成；多项取最晚，不能用产品satisfied/最后一次验证重置。
- T结束同时要面板完整正文、`#status-pill.running`退出、`BrowserAgentSession.isStreaming()`为false、真实在途RPC为0。只有agent_end/TaskProgress.active为空不够。
- 首次真结束点冻结，后面新忙/工具/重复通知判违规，不把结束点推后吞掉违规；观察满10000ms。
- suite必须六条都正确、ok=true、有finite完整计时；缺数据/事后违规不能qualified。
- state_environment前后规范观察都用pauseEvents；比较只看实际副作用与状态，不把自然currentTime变动当新增操作。
- 正文事实三态：pass/fail/needs_review；三评论须顺序正确，两个对象不能说反，同义措辞不误杀；待复核不是自动成功。
- 采样异常明确harness_measurement_failure，不能吞错；失败也保留已取得的真值和时间；每批唯一目录。

## 下一步

主代理马上执行：
`node docs/tasks/20260910-completion-tail/run-completion-tail.mjs --preflight-only`
通过后：
`node docs/tasks/20260910-completion-tail/run-completion-tail.mjs --repro-a`

这是A三场景各一次的根因复现，不是正式六次达标验收。运行期间不得改A或共用测量驱动；你只读分析。若确认驱动错误通知主代理先停，不能边跑边修。

得到A时间线后提出最小方案，区分“结果达成→完整正文”和“正文交付→模型真结束”。再在candidate写生产反例并实现，保持A登记/绑定/权限、M3/medium、完整历史和正文/语音。不要恢复旧B/C，不改测试标准，不读fixture oracle变量进产品。

你负责全部实现和测试；主代理负责规划/评审与已授权的宿主脚本启动。只有候选六次全正确、max≤5s及所有冻结边界通过，才由主代理选中，然后你回接有限差异并复验。不得自行重载或提交推送。任务目录定期写progress，原始检查从命令开始记录log和退出码。
