# Pi 后台子代理：现成插件与自建选择

日期：2026-09-21。用户要求调查后台子代理插件，产品文字日志/问答分流/语音执行暂停，等后续信息再判断。此轮只取源码和核查，没有安装、启用或运行第三方扩展。

## 推荐

先试 `pi-subagents@0.70.1`（nicobailon），不从零自建。它具备后台进程、runId、查看状态、中途指令、停止、保留会话续做，并支持现有agent模型文件。只使用单代理后台功能，不启用额外工作流、定时任务或自动审查。

这是源码核查后的试用推荐，不是本机兼容性验收结论。采用前需处理旧同名工具，并在独立Pi会话做最小运行检查。若现成插件的通知行为或规模不合适，再考虑一个窄范围适配；不先造完整调度系统。

## 本机基线

- Pi npm版：0.86.1，macOS。
- 当前同步工具：`/Users/mahaoxuan/.pi/agent/extensions/subagent/index.ts` 是官方 examples/extensions/subagent/index.ts 的符号链接。
- 当前角色定义：`/Users/mahaoxuan/.pi/agent/agents/`，包括独立模型配置。
- Pi工具注册采用同名第一个生效，见 `dist/core/extensions/runner.js:352–362`。不能同时留下两个subagent并假定新包会覆盖旧工具。

## 候选对比

| 候选及核查版本 | 已在源码找到的能力 | 对本需求的限制 | 建议 |
|---|---|---|---|
| [pi-subagents](https://github.com/nicobailon/pi-subagents) 0.70.1 | 后台独立runner、status/steer/stop/resume、现有agents文件、进度面板 | 与现有subagent同名；功能较多；完成通知默认进入主模型并可触发回合；重启后的自动补通知有限制 | 首选做隔离试用 |
| [@tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents) 0.19.0 | Agent默认后台、状态、中途指令、保留会话恢复、复用agents | 模型没有专用取消工具，取消主要在UI/内部接口；工作流/UI功能多；完成默认followUp+triggerTurn | 备选，适合更重的管理界面 |
| [@narumitw/pi-subagents](https://github.com/narumiruna/pi-extensions/tree/main/packages/pi-subagents) 3.0.2 | spawn立即回jobId、inspect/send/cancel、默认只读工具、双向消息 | 不支持每任务选模型或现有agents目录；任务不跨重载/退出存活；README发布状态过期 | 更简洁，但不适合当前多模型分工 |

不把「完成通知触发主模型」直接称为打断用户语音：这里是开发宿主的消息调度，不是产品语音。是否影响我们正在讨论的节奏，要在TUI实际检查。

## 首选源码证据

解包目录：`/tmp/pi-background-candidates.n1X9u4/pi-subagents-0.70.1/package`。

- `src/runs/background/async-execution.js:1950`：返回runId/asyncId；返回前有启动握手（约10秒超时），并非零等待启动。
- `src/runs/shared/background-process-options.js:3` 与 async-execution.js 的unref：Unix使用detached runner；父退出不等于后台进程退出。
- `src/runs/foreground/subagent-executor.js`：status、resume、steer、stop、interrupt动作分发已实现。
- `src/runs/background/control-channel.js`：跨进程控制文件通道。
- `src/agents/agents.js:411`：builtin < package < user < project，同名用户agent覆盖内置定义。
- `src/runs/background/notify.js:373–377,618`：sendMessage带triggerTurn，未指定deliverAs；一般完成通知可触发主模型。不能承诺静默后台，不存在已确认的普通单任务quiet开关（定时任务quiet是另一功能）。
- `src/runs/background/result-delivery-ownership.js`、`completion-owner.js`：结果投递与父进程owner关联，重新打开Pi不保证补发通知；可查status和产物。
- 状态/产物默认在系统临时目录，不能当永久任务档案；重要代码证据仍写项目文档。
- 包会声明加载skills/prompts；最小试用只加载扩展，其他资源先不自动采用。
- `package.json`没有postinstall脚本；`install.mjs`只是独立CLI入口。其旧目录检测不能误写成 `pi install npm:pi-subagents` 必然拒绝安装，最终由实际Pi包安装流程决定。
- README的「官方0.86.1 Linux x64 standalone」支持边界针对standalone发行，不应误读为npm版macOS被明确排除。当前npm版macOS仍需实跑。

## 另两项关键核查

Tintin：src/index.ts 的Agent后台分支先启动后返回；完成发送followUp且triggerTurn=true；get_subagent_result与steer_subagent可由模型调用；取消在manager.abort/UI；可关闭workflowsEnabled，但仍有较多界面和生命周期功能。peer依赖>=0.84.0与本机版本相符，不等于已通过运行检查。

Narumitw：src/runtime.ts start同步返回、tools.ts注册5个主工具；process.ts用子Pi RPC，禁用无关扩展/skills且继承主模型，不提供per-job model；完成本身不唤醒空闲模型，子代理提问会触发主模型。包为3.0.2，README仍称npm为2.x，故以源码与版本为准。

两份子代理核查对Pi同名工具覆盖顺序给出了矛盾说法，主代理直接读本机runner.js裁定「首个生效」，未照抄报告。

## 采用前最小检查（未执行）

1. 独立Pi会话只载候选扩展，保留日常会话与旧工具，验证工具schema含后台和控制动作。只下载依赖不代表启用成功。
2. 只读、明确限时的小任务：启动后拿到runId，任务仍在运行时主会话能回答另一句，证明不是仅子任务彼此并行。
3. 检查status；发中途补充，验证子代理确实收到；另一次任务测试停止，不影响主会话。
4. 检查完成结果只收到一次；主会话正在讨论/空闲分别观察通知顺序。
5. 复用当前一个DeepSeek角色，核对实际model与工具清单；不先给写权限，不在产品仓库做试验性改动。
6. 保留会话续做并核对前文；父进程退出后的任务状态与结果恢复单独检查。
7. 通过后再替换日常同名工具，保留回滚路径，不同时启用两个subagent。没有授权前不安装或修改全局资源。

## 若自建，最小范围是什么

只围绕现有派发器补：立即返回的任务ID、持久状态/输出、查询、停止、运行中指令、完成通知。必须明确会话归属、防旧任务结果混入新会话、退出/重载处理与部分修改留存。已有库已经实现这些，第一选择不是自行再做一遍。

只有隔离试用证实候选无法满足当前模型分工或交互需求，才依据那一个实测缺口做最小适配。暂不估承诺工期，不把自建列为产品任务的前置大工程。

## 获取与验证记录

- `npm search --json 'pi subagents'`：找到多个公开候选。
- `npm view <候选> name version repository homepage dist.tarball peerDependencies time.modified --json`：核对仓库和发布版本。
- `npm pack <候选> --ignore-scripts --pack-destination /tmp/pi-background-candidates.n1X9u4`：仅下载发布包；使用安全解包过滤提取源码，无生命周期脚本执行。
- 三个候选的功能由源码/README交叉核对，未运行第三方代码或模型，未安装插件，未改当前工具注册。
