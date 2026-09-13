# Stagehand 兼容层接入 ego：同页填写、停止、纠正和切页

用户已批准：保留 Pi，Stagehand 接入现有操作控制。实现前标准如下。

## 完成标准

- [x] 真正复用固定版本的官方兼容层，模型可写 page.getByLabel/getByRole/locator；MIT 来源清楚。检查者：源码与独立复核。
- [x] 所有网页动作经 ego 原 RPC、任务页、授权、epoch 和取消检查；旧程序行为保留。检查者：定点测试与 diff。
- [x] 真实页面填姓名/邮箱且不提交。检查者：隔离浏览器及日常入口。
- [x] 等待时停止，即使代码 catch 也无后续写入；在途调用排空后才结束。检查者：事件轨迹与页面最终值。
- [x] 新程序改姓名为李明，邮箱保持；用户切到 B 时原任务仍操作 A，B 不变。检查者：两页最终值与运行中切页。
- [x] 真实侧栏/模型路径采用新兼容方式，停止后能继续新要求。检查者：原生入口操作。
- [ ] 真人说停/纠正的声学体验。检查者：用户；与文本/信号注入证据分开。

## 实现选择

复用 Stagehand 官方 Playwright facade，RawPage 由 ego 的浏览器工具适配；运行在现有 QuickJS。保留同一控制闸门与当前登录页，不另装扩展、不另起日常浏览器。此选择复用官方兼容代码，不代表已采用完整 SDK experimentalBatch 的浏览器内批处理，性能另测。

## 范围

现有阅读设置、回答排版、语音交付并发改动原样保留。本轮不做视觉改版。主代理负责接线决策和实际验收，DeepSeek 执行与独立复核。

## 改前复现

`node --import tsx scripts/acceptance/stagehand-control.mts --headless`：失败于 `page is not defined`，未发生填写。这是本轮新兼容入口尚未接线的真实基线。证据：`out/acceptance/stagehand-control-2026-09-13T11-23-18-277Z/result.json`。验收脚本将用同一路径复跑。


## 最终结果（2026-09-13）

**已接入并加载到现有 ChromeMain。** 使用官方兼容层，保留原 Pi、QuickJS、RPC 与授权/控制链。无需 Browserbase Key，模型继续使用现有配置。

### 真实面板与模型

模型显示 `deepseek-flash`，生产配置为 `opencode-go/deepseek-flash`。本轮通过生产面板文字输入、真实 Pi 模型和原 native host 执行。提示明确要求 `browser_run api:"playwright"`，属于 guided 集成验收，未测试真人麦克风。

| 用户路径 | 观察到的结果 |
|---|---|
| 填写姓名/邮箱、不提交 | 张三、test@example.com 正确进入 A 页；提交次数 0 |
| 等待中点发送框停止按钮 | 按钮收到 trusted click；原程序结束，观察越过原等待时长，姓名/邮箱无新增写入 |
| 新输入将姓名改成李明 | A 页变成李明，邮箱原样保留，B 页保持空白 |
| 程序等待中激活 B 页 | 操作仍写入 A 页（用王五作区分标记），B 页无写入且最后仍为活动页 |

[完整结果](20260913-stagehand-control-native/result.json) · [执行事件](20260913-stagehand-control-native/events.json) · [改名截图](20260913-stagehand-control-native/03-scenario3-renamed-a.png) · [未被改动的 B 页](20260913-stagehand-control-native/05-scenario4-untouched-b.png) · [代码指纹](20260913-stagehand-control-native/source-hashes.json)。测试创建的三个标签页已关闭，未向站外提交内容。

停止时间分别留存脚本开始准备点击、DOM trusted click、agent_end；脚本准备与点击之间包含读取/定位等待，不能拿总差值当产品停止延迟。本次可信点击到 agent_end 为 117ms，仅此一次按钮路径记录，不是语音指标或性能比较。

### 执行层与回归

最终[隔离结果](20260913-stagehand-control-native/isolated-result.json)通过：上述控制用例、非提交按钮点击一次、trial不点击、多匹配不写、macOS全选范围0..2、epoch变化后不写。使用实际模式隐藏标记，同时保留显式禁用能力的拒绝。

- 执行者此前完整普通单测：184 文件 / 1639 项通过；类型检查与166个生产文件的架构检查通过。
- 主代理后续变更后：阶段定点45项通过；最终权限/模式/兼容/旧路径定点52项通过，完整类型检查通过。未为无关模块机械重复全套规模/发布评测。
- DeepSeek 独立复核指出的 request 别名及 trial 选项问题已修；主代理完成真实结果复验。后续定点复核核查初始化预算、权限判定与macOS键盘修复；权限判定最后进一步收紧为显式 `isToolHiddenByMode`，旧“逐个禁用工具不得经JS绕过”的完整反例仍全部通过。
- 真人说“停一下”和语音纠正体验：留给用户亲测，没有用文字/信号注入代替勾选。

## 本轮修复与测量修正

1. 官方 locator.click 会丢弃 trial 等选项；在丢弃前拒绝未支持选项，并保留清晰 vendor PATCH 说明。page.context 等别名返回统一守卫对象，request 在底层也明确拒绝。
2. 真实模式隐藏的 page_operation 不能被误当成撤销填写能力。只豁免 session 明确标记为“已获准但被模式隐藏”的工具；显式禁用仍拒绝，直接 page_operation 调用也不因隐藏而放行。
3. 大型可信兼容代码初始化在高负载下可能触发旧100ms预算；初始化单独1000ms，第一次await发生在用户代码之前，用户代码后续jobs仍100ms。
4. macOS Meta+A 原来仅发key事件，实际没有选中文字；补入精确条件下的CDP selectAll编辑命令，同一输入框复跑通过。
5. native验收脚本先前复用了会reload的新面板helper，造成双次会话启动；现在只打开一次，并等待UI/存储选择一致。实时执行事件从history信封取出，过去历史不回放。停止按钮检查真实可见区域及trusted click；旧隐藏按钮的点击不能记为有效停止请求。之前失败尝试在out/acceptance对应时间目录保留，不计通过。
6. 安装路径修复：现有扩展注册及 `.sideagent/native-host.sh` 均仍指旧Desktop/ego。只更新到当前项目位置，同ID重新加载，未卸载浏览器或改模型/凭据；原wrapper备份在 `/tmp/ego-stagehand-integrate/native-host-before.sh`。
