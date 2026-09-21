# 安装并验证 pi-subagents@0.70.1

## 范围
用户授权安装首选后台插件。只调整Pi宿主资源，不改By Your Side产品代码、不重启产品宿主、不推进文字/语音路由方案。

## 完成标准与结果
- [x] 固定版本安装，现有代理模型文件保留。
- [x] 普通资源发现只注册一份新版subagent，旧示例工具被排除。
- [x] 独立真实Pi CLI无额外SDK路径环境变量，主代理先结束当前工作，子任务后台继续并完成。
- [x] 独立SDK会话验证status、中途steer到达、stop。
- [ ] 当前对话切换新版工具：需要用户发 `/reload`，本轮工具schema仍为旧版。

## 配置
执行：`pi install npm:pi-subagents@0.70.1`。
安装位置：`/Users/mahaoxuan/.pi/agent/npm/node_modules/pi-subagents`。

`/Users/mahaoxuan/.pi/agent/settings.json`：
- packages新增固定版本，只加载index.js；包内skills/prompts/themes先不加载。
- extensions排除 `-/Users/mahaoxuan/.pi/agent/extensions/subagent/index.ts`。
- 原示例链接及 `/Users/mahaoxuan/.pi/agent/agents/` 保留；其他包配置不变。

npm安装报告新增5项、移除263项；`npm ls --prefix /Users/mahaoxuan/.pi/agent/npm --depth=0 --omit=dev`确认原有npm顶层包和新插件均在。安装清理了非依赖的Waza旧路径兼容链接，已恢复其指向现有本地skills，未替换技能内容。

## 主代理资源复验
脚本：`/tmp/pi-background-install-check-20260921-182500/resource-check.mjs`。
命令：`cd /tmp/pi-background-install-check-20260921-182500 && node resource-check.mjs`。
使用普通SettingsManager和DefaultResourceLoader读取真实全局设置，结果：`ok:true`，仅新版index.js注册subagent，schema具备async/action，extension errors为空。

## 真实CLI验证
目录：`/tmp/pi-cli-subagent-check-20260921-184013/`。
证据：`logs/summary.json`、`logs/driver.log`、`logs/cli-rpc.stdout.log`、README.md、driver.mjs。

启动命令：
`/Users/mahaoxuan/.local/bin/pi --mode rpc --provider opencode-go --model deepseek-v4.1-flash --thinking off --approve --no-builtin-tools --session-dir /tmp/pi-cli-subagent-check-20260921-184013/sessions`

cwd为一次性fixture项目 `/tmp/pi-background-install-check-20260921-182500/project`。没有PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT覆盖，包自行从真实CLI入口发现npm宿主。

- runId：`6e5137a0-0234-4071-bda2-26945791f15c`。
- 主模型只调用一次async subagent；当前工作在6221ms settled，没有轮询等待。
- 后台DeepSeek任务耗时13486ms，state=complete，success=true，exitCode=0。
- 只读六个fixture文件并输出ORANGE-1至ORANGE-6；工具为ls/find/read/grep。
- 后台终态后验证driver主动SIGTERM结束RPC父进程（143），不是任务失败；driver退出0。
- 主代理已读summary核对工具调用、主会话先结束、子任务结果和环境字段。

此证据证明CLI后台运行；尚未在用户当前TUI里演示同时聊天的界面体验。

## SDK控制验证及测试工具限制
目录：`/tmp/pi-background-install-check-20260921-182500/`，harness.mjs、logs/summary.json、logs/run.stdout.log。

SDK脚本使用显式宿主包路径时9项断言通过：新schema、后台期间running、中途指令被子代理输出确认、真实模型只读任务完成、另一任务停止。子模型为opencode-go/deepseek-v4.1-flash。

主代理去掉宿主包路径后复跑，启动立即失败，但测试脚本仍对空runId轮询，130秒超时；该失败日志保存在logs/main-recheck.stdout.log。原因是独立harness入口位于/tmp，插件不能据此找到Pi包；SDK验证不能直接当日常CLI证明。因此追加上面的真实CLI检查，无路径覆盖成功。不改插件源码、不靠全局环境变量掩盖问题。先前成功summary属于有路径覆盖的SDK运行，不是失败复跑的新结果。

## 启用与回滚
用户在当前Pi对话发送 `/reload` 后刷新工具schema与资源；新工具支持async/action，不再使用旧tasks/chain参数。常规后台任务启动后不主动轮询等待，独立讨论继续，等待原生完成通知。

回滚仅需从settings的packages移除新插件条目、移除旧路径排除项，再 `/reload`；原工具文件、角色与模型配置都在。若届时仍有后台任务，先确认其状态并停止或等待，不直接切换丢失在途结果。

未验证：跨父进程重启恢复、当前TUI通知观感、复杂工作流。这些不在本次最小安装验证范围。
