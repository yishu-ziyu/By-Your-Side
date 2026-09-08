# 语音调度验收台账

记录日期：2026-09-09。本文整理已有结果，不代表本次重新测试。冻结标准不改写，未完成的整条标准不勾选。

## 可持久查阅的证据

仓库内[结果摘要](20260909-voice-dispatch-evidence.json)保存选定运行的检查、页面值、分类失败及原文件SHA256。原始大文件留在对应本机临时目录，可能被系统清理；摘要不能替代音频、截图、时序和完整事件。运行时源码版本未完整记录，不能用当前HEAD补填历史版本。后续复验应同时记录源码差异指纹、扩展包指纹、模型和环境。

| 证据 | 结果 | 适用范围 |
|---|---|---|
| P0 [原有结果](20260908-voice-dispatch-p0-results.json)；P1原文档中的对照和侧栏重载 | 预算800、升序699/799、单次启动；回执可重载 | 阶段当时版本，不代表之后所有改动回归 |
| P3 `/tmp/ego-voice-control-1788886790121/result.json` | 12项通过；主/协作者写入，暂停5秒稳定，保存600，使用新人工标记恢复，同runId，终止5秒稳定，旧写拒绝 | 一轮完整真实链路；人工改页由脚本模拟 |
| P4 `/tmp/ego-voice-context-1788886954229/result.json` | 两项通过：实际表单7391/海风；主动结束播报不声称成功 | 图片和选区真实到达执行模型；一轮 |
| P5 `/tmp/ego-voice-target-1788887465193/result.json` | 暂停并保存通过；后续等待页面恢复超时 | 整轮失败，不能只取前半段算通过 |
| 分类a `/tmp/ego-voice-intents-1788886956308/result.json` | 140/144；一项非法输出，三项超时 | 未达到全部匹配门槛 |
| 分类b `/tmp/ego-voice-intents-1788887119715/result.json` | 140/144；一项非法输出，三项超时 | 未达到全部匹配门槛 |

P3曾被笔记误写为13项，按原结果文件核对为12项；本次更正计数，不改变原检查结果。

## 真人结果

| 用户路径 | 用户反馈与观察 | 结论 |
|---|---|---|
| 语音预算800、升序、筛选一次 | 用户明确确认听写正确、有反馈、页面699/799；截图筛选次数1 | 本次通过 |
| 连续对话和追问 | 用户反馈后续正常；第一次故事请求有完整转写后未回复 | 连续对话通过，首句可靠性存在问题 |
| 说“好了，别说了” | 用户确认“基本上就停了，直接就停” | 一次主观停声通过，未测毫秒或P95 |
| 暂停页面任务 | 已给测试步骤，随后用户转而要求打开YouTube | 没有暂停成功证据，不计通过 |
| 打开YouTube | 有accepted回执；之后用户截图显示YouTube页面 | 目标页可见，同时语音陷入重连；不是完整可靠性通过 |
| 询问能否看屏幕 | 当时回复看不到 | 用户要求新增只读查看，代码待真实验收 |

本机真人记录：`/tmp/ego-voice-human-1788887715503/first-human-turn.json`、`conversation-human-turns.json`、`reconnect-human.json`。不把真人原始音频或含无关个人浏览内容的完整截图复制进仓库。

## 修复与复验分开

- 团队部分恢复误判：真实失败后修复，完整P3一轮已复验；扩展测试覆盖restoring→partial→restored。
- 无限重连：新增断网重试测试先红后绿；18项语音会话测试通过。用户扩展尚未重载，原始断线原因未定位。
- 停声状态不收回：修改ready状态处理，相关采音测试通过；真人复验未做。
- 复合指令漏resume：结构检查不允许吞掉明确“然后继续”，分类修复仍需真实复验。
- 语音只读看页：代码、聚焦测试、类型检查和构建通过；真实截图问答、用户验收未做。

## 命令与尚未完成的验证

```sh
npm run typecheck
npm test
npm run build
git diff --check
node --import tsx scripts/acceptance/voice-intents-run.mts
node --import tsx scripts/acceptance/voice-dispatch-run.mts --suite parity
node --import tsx scripts/acceptance/voice-dispatch-run.mts --suite faults
node --import tsx scripts/acceptance/voice-dispatch-run.mts --suite extensions
node --import tsx scripts/acceptance/voice-restart-run.mts
```

这些命令的存在不代表执行通过。faults新增真实接受后断线及重复commit，尚未跑；extensions会顺序跑控制、资料、目标各三轮，尚未跑。重启脚本单独存在，尚未并入faults也未运行。新增observe改变分类能力后，48句旧集仍须回归，并补独立看页用例。真人测试期间不并行执行上述浏览器脚本。

当前人工页面服务仍由本机进程提供。停止前需与用户协调；不通过清理或重载中断其正在使用的页面。

推送前最终检查（2026-09-09）：85文件697项测试通过，typecheck/build/diff检查通过；新增来源侧回执测试先红后绿。暂存文本未命中配置的凭据模式，JSON与评审链接检查通过。未重载扩展、未重跑真实语音及浏览器验收。
