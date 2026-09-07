# 浏览器恢复改动与验收结果

日期：2026-09-07。完成标准：`docs/evals/20260907-browser-recovery.md`。

## 已落地

- 新增真实 hover：模型工具、共享协议、扩展分派、CDP mouseMoved、worker 光标和接管闸门一致接入。
- 非法定位、失效 ref、未找到目标提供明确恢复反馈；多匹配 CSS 拒绝执行，避免默选第一个项目。
- 修正 ref 契约：编号可能稳定，但目标必须出现在最新快照。点击成功只表示事件执行，JS undefined 不代表有效观察。
- 本地 JSONL 轨迹记录会话/任务/轮次、模型、工具参数与实际返回、错误、耗时和接管/交还。
- 日志默认隐藏 fill/type_text 输入，图片只留摘要；共享字符/节点预算、文件大小和保留数量有界，日志故障不改变任务行为。
- 未添加固定次数熔断，未更换模型，不做侧栏视觉重设计。

## ego lite 对照

本轮直接检查的可迁移能力：

- 真实 hover： https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/driver/pointer.ts#L116
- 定位器与节点恢复： https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/element-resolver.ts#L70
- 本机官方 skill 的最新快照 ref 约束与观察/动作/验证工作流：`/Applications/ego lite.app/Contents/Resources/ego-browser/SKILL.md`。

采用真实 hover、准确 ref 生命周期和可执行错误反馈。没有因此宣称达到 ego lite 的总体成功率，也未移植完整多工具脚本运行器。

## 机器检查

- `npm run typecheck`：通过。
- `npm test`：45 个文件、422 项通过。
- `npm run build`：通过；最终扩展已重载。
- 独立审查发现的输入日志泄露、多目标默选和序列化前无总预算问题已修复，并定点复核关闭。
- 本轮修改文件的 `git diff --check` 通过；整个既有工作区另有 `extension/test/steps.test.ts` 文件尾空行警告，不属于本轮修改，未处理。

## 本地真实模型路径

模型均为 `minimax-cn/MiniMax-M3`，生产 BrowserAgentSession、ToolRpc 和生产扩展执行链，无模型 mock。

| 场景 | 结果 | 耗时 | 模型工具 | 人工介入 |
|---|---|---:|---:|---:|
| hover 显示入口、打开、填写草稿 | 通过 | 42.825 秒 | 8 | 0 |
| 无效选择器后恢复 | 通过 | 46.614 秒 | 9 | 0 |
| 节点替换、旧 ref 失效后恢复 | 通过 | 77.195 秒 | 12 | 0 |
| 点击无变化后继续找真实入口 | 通过 | 58.770 秒 | 11 | 0 |

四项都由实际页面与截图确认草稿值，提交次数为 0。错误由校验者通过真实工具预置后交给模型，页面有 hover 提示。耗时含准备和取证。详见 `20260907-browser-recovery-local-results.md`，不当作陌生网站总体成功率基准。

## 原生侧栏接管/交还

第一轮按生产 UI 发送原目标，点击接管，由自动化扮演一次人工操作打开空编辑器，再点击页面现有交还按钮。native Agent 续填原草稿，没有第二次提供内容。

持久化轨迹：`~/.sideagent/traces/1788779905003-04b572b5-3b6c-4fd1-90c0-c5b76f5be1f2.jsonl`。
同一 runId：`07120d50-0586-459f-8530-13df6581e7a2`。

- 19:19:51.850 原目标进入。
- 19:19:57.044 接管。
- 19:20:12.386 交还。
- 19:20:15.899 fill 完成。
- 19:20:18.270 JS 读回原草稿。
- 19:20:20.307 结束。全程 28.457 秒，续跑 2 次工具调用，提交 0 次。

证据：`out/acceptance/handback-2026-09-07T11-19-38-268Z/` 中的 `native-timeline.json`、`human-opened-editor.png`、`after-native-fill.png`、`recovered-observation.json`。

判定：产品路径通过，人工介入次数记 1（自动化扮演）。验收命令不能记通过：首轮 Port observer 未初始化导致报告写入失败，结果由原始截图、现场状态和上述持久化轨迹恢复确认。后续两轮有测试设置问题，保留其失败证据，不拿它们充当干净通过。最终脚本补了初始化与前台操作，仅做语法检查，未再次实跑。

## BOSS 原页面

当前真实页面：`https://www.zhipin.com/web/geek/resume`。

先前会话尝试失败：上一轮 HANDOFF BOUNDARY 被模型沿用，模型停留在本地夹具，明确没有进入 BOSS。该失败单独记录，不能计入下面的成功。

重载扩展开启新会话后，原生 MiniMax-M3 在 69.198 秒、16 次工具调用、0 次人工介入下打开「添加项目经历」表单。新增字段均为空，无 fill/type_text 调用，未保存或提交。模型确认页面没有「红鲱鱼与枪」独立项目，只有其他项目描述提到它，因此打开新增入口。

实际机制证据：添加链接初始 `display:none`、宽高 0；一次非法 hover locator 返回恢复反馈；随后真实 hover(point) 后链接变成 `display:block`，再点击并快照确认编辑字段出现。中间仍有多次 JS 探查和一次合成 hover 尝试，因此不能说模型已经完全遵循高效工作流。

runId：`0ff74a5c-f25d-4aa8-ace4-a253209a0f89`。
轨迹：`~/.sideagent/traces/1788780787908-40d959c1-833b-4c4e-97e1-86a3e536fcb9.jsonl`。
证据：`out/acceptance/boss-recovery-2026-09-07T11-33-21-470Z/` 下的 `before.json`、`after.json`、`after.png`、`recovered-result.json`。可见字段从 1 个增加到 8 个。

判定：新会话中的原页面入口操作通过。自动脚本曾漏读 history 封装的 agent 事件，超时不等于模型失败；结果由同一运行的持久化轨迹与只读现场恢复，没有为恢复取证重新发送任务。脚本已修正 history 解包，语法检查通过，未再发起同一任务。

## 尚未解决与下一步

- 接管后的旧页面约束可能污染下一项新任务，已在 BOSS 验收前出现。新会话成功不能证明此问题已修复。下一步应把交还约束限定到被恢复的任务，并用「接管续填完成 → 新页面新任务」验证。
- AX 路径忽略 viewport scope，截断反馈不准确；本轮未改，未证明其造成这次卡住。
- 实际 BOSS 轨迹有 screenshot 尺寸报告 0x0，视觉坐标换算需另行核对；本轮成功动作使用 DOM 读回的视口坐标。
- 本轮只验证 BOSS 打开入口，没有验证填写、保存、新项目发布的完整任务。
- 体验是否足够快、接管是否顺手仍由用户判断。
