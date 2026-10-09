# 验收脚本入口

[文档导航](../README.md) · [开发检查](../development/checks.md)

本页说明怎样选验收入口，以及代码里看不出的边界。每个真实路径用例都用 `npx tsx scripts/acceptance/real-path/<名>.mts --headless` 运行。
脚本有额外参数时，参数写在这个脚本的文件头，本页不逐个复述。

## 怎样选入口

- **合并前**：`npm test`。`npm test` 只跑核心用例：用例只装扩展、用脚本模型，不要凭据。
  用户在等结果时，把输出写进 `out/acceptance/test-run.log`，在仓库根目录起 `python3 -m http.server`，用侧边浏览器打开 [进度页](../../scripts/acceptance/real-path/progress.html)，让用户看到每项测什么、测到哪（10-10 用户要求）。新加核心用例时，在进度页里补一句它测什么。
  核心清单是 [`run-all.mts`](../../scripts/acceptance/real-path/run-all.mts) 的 `CORE`，选择依据见[验收](../evals/20261008-e2e-only.md)。
- **全部真实路径用例**：`npm run accept:real-path`。加 `-- --only=a,b` 是过滤轮：没选的用例记为未跑，过滤轮永远不算整轮通过。
- **浏览器主链**：`npm run accept:browser`。
- **单项**：在 [`scripts/acceptance/real-path/`](../../scripts/acceptance/real-path/) 找到对应脚本，先读文件头，再加 `--headless` 运行。
  对应的标准与结论在 [`docs/evals/`](../evals/)，按功能名或脚本名查找。
- **技术前提**：`scripts/probes/` 下的[前提小实验](../development/checks.md#前提小实验)只证明前提，不代替功能验收。
- **评测环境分类**：见[站点不可用](eval-environment.md)。
- **CI**：[E2E 工作流](../../.github/workflows/e2e.yml)跑 `npm test`，目前只能手动触发，还没在 Linux 上跑过。

证据在 `out/acceptance/real-path/`。验收文件记录命令、结论和证据位置。

## 脚本模型与真实模型

- 多数用例用本机脚本模型。脚本模型只验证交互呈现，所以通过不代表供应商模型的质量，也不代表真人语音验收。
- 接真实模型（`--model=provider/id`、`--live`）要本机凭据和用户授权。缺凭据时如实写「没跑」。
  北极星跨站任务的授权要求见[标准](../evals/20261004-north-star-cross-site.md)。
- `answer-selfcheck` 不加 `--live` 也要本机 GLM 凭据：目标核对默认就用真实 GLM 快速模型。
- `inproc-*` 用例的模型凭据只写进隔离扩展存储。
- `everyday-baseline` 的模型请求只许发往所选服务商。

## 容易误判的地方

- **试用包不等于当前源码**：验已准备的试用包时，用 `SIDEAGENT_ACCEPTANCE_DIST` 指向试用包。当前源码通过，不代表试用包通过。
  首句问页还要核对浏览器实际读取的侧栏文件，见[首句验收](../evals/20261008-voice-first-utterance.md)。
- **日常 Chrome**：`everyday-baseline --daily` 连到用户已开的日常 Chrome。只在用户同意后运行。
- **下载**：两个隔离启动器都把下载文件夹指到临时目录。页面下载不进用户真实的下载文件夹。
- **圈画判据**：页面圈住目标、没有点击、侧栏交付无错误，三项都要满足。只看到圈画、但目标账本报未完成，仍算失败。
- **固定页面不等于完整评测**：`answer-selfcheck` 的固定页面检查不代替 #35 的完整产品评测（[标准](../evals/20261002-answer-selfcheck.md)）。
- **快捷键**：`sidebar-interaction --run=craft-after` 只检查快捷键消息，不等于操作系统真的按下 ⌘J。
- **夹具数据**：`killer-interactions` 的翻译批次由夹具写入，不代表供应商翻译质量。
  `ghost-hud-and-steering` 不覆盖真实 YouTube/Bilibili 页面，也不覆盖供应商模型的改写质量。
- **原生弹窗**：`dialog-recovery` 只核对原生 confirm/prompt 与恢复，不是供应商模型整链路。
- **语音设置**：`voice-plan-settings` 只验设置的保存与拒绝，不是音频验收。
- **先核对再说完成**：`claim-after-check` 的目标核对结论由本机转发服务换成脚本结论，只验证侧栏怎样扣住和放出回答，不代表快速模型核对得准不准。`refill-after-check` 验证改正时同一栏能重填一次、重复提交仍被拦；`readback-privacy` 验证读回的内容不进诊断导出、敏感栏不读回。
- **发送前确认**：`send-confirm` 在本机练习页上扮演用户点确认框，每次跑要多等 40 秒。它没有覆盖「2 分钟没理就不发」，因为产品没有缩短等待的开关，也不为测试加开关。
- **GPT-Live 语音**：`gpt-live-voice` 用真实 GPT-Live 和 ChatGPT 登录，会用掉用户 ChatGPT 套餐的语音额度；声音来自合成语音，不代替真人试听。

## 当前缺口

- `page-readouts --live` 尚待适配。
- `inproc-voice --case=stop-task`（语音确认中止原任务）当前有失败记录。
- #22 只读脚本后置：产品没有专用的只读脚本工具，因为求值标记盖不住返回对象序列化时的副作用（[实验失败](../research/20261003-readonly-js.md)）。
  为它草拟的验收脚本 `readonly-script.mts` 每次都失败，10-09 已删除，要做时从 Git 历史取回。

## 脚本留在主线的条件

任务专用脚本至少满足一条，才留在主线：

1. 是 `scripts/acceptance/real-path/` 下的用例。`npm run accept:real-path` 运行全部真实路径用例；一个用例跑不通又没人修，就删掉（2026-10-08 用户决定：测试和检查按抓到过什么问题评价，没用的删掉，不维护）；
2. 被 `package.json`、`docs/` 下的现行文档或验收记录、或另一个活跃脚本引用；
3. 是多个任务共用的驱动、夹具或独立判定程序。

一次性探针在任务完成后合入共用驱动，或留在 Git 历史里、从 HEAD 删除。评测文档记录命令、结论和证据位置，不靠堆积脚本保存历史。
