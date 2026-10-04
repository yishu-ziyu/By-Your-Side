# 开发检查

[文档导航](../README.md) · [文档维护](documentation.md) · [真实路径验收](../testing/acceptance.md)

## 先按影响范围选择

纯文档变更只查篇幅、引用、差异和语义，不运行产品构建或付费模型。修改检查脚本时，运行它自己的命令级验收；修改网页、语音或恢复逻辑时，再按实际入口选择对应产品验收。

```bash
npm run check:docs                  # 位置、当前说明篇幅、文件链接
npm run test:docs                   # 临时 Git 仓库中的文档检查反例
npm run check:docs -- --base HEAD    # 当前未提交代码与对应文档同步
npm run check:docs -- --base origin/main  # 当前分支相对共同祖先的同步
npm run check:docs -- --all          # 额外审计历史记录中的文件链接
```

没有 `--base` 时只检查结构，不输出“功能文档已同步”。PR 工作流会传入真实基线；无效基线直接报错。全量同步可能暴露工作区既有在途代码的文档欠账，不得通过随意改一行文档冒充补齐。

## 产品检查

```bash
npm run typecheck            # 扩展与宿主类型
npm run test:unit            # 普通测试
npm run test:scale           # 规模测试
npm run check:architecture   # 模块边界
npm run build                # 重建 extension/dist
npm run check                # 文档、边界、类型、测试、构建
```

`check` 包含构建，会影响日常正在加载的 dist，不是纯文档命令。真实浏览器验收默认无窗口；真实模型和真实依赖的使用边界按任务授权，缺凭据或预算如实标记。单测、真实供应商、真实页面结果和真人体验分开留证。

只核对扩展打包时，设置 `SIDEAGENT_BUILD_DIST` 指向独立临时目录，再运行 `npm run build -w @sideagent/extension`；`inproc-mark`、`inproc-voice` 的 real-path 驱动也隔离构建。入口契约只证明协议结果；圈画可见而任务账本仍判未完成时，真实路径算失败，保留页面截图和侧栏回执一起排查。
`package-lock.json` 要带上各平台的可选原生绑定（例如 `@rolldown/binding-darwin-arm64`）：缺了时已有的 `node_modules` 照常能跑，干净 `npm ci` 后 vitest 却起不来。改依赖后，在临时目录做一次干净 `npm ci` 再跑 `npm test` 核对。
模块边界检查只允许扩展的 `inproc` 入口使用公开的 `@sideagent/agent/browser-core` 包接口；其他扩展页面仍不得直接依赖 agent 实现。
依赖审计用 `npm audit --registry=https://registry.npmjs.org`（命令级参数，不改全局源）。Pi 0.84.4 自带 npm-shrinkwrap，npm 10 下项目级 override 不能覆盖其中的版本；必须以干净 npm ci 后的 npm ls 和 audit 核对，不凭根锁文件清零。当前直接依赖补丁与 Pi 内依赖分别记录，见[升级验收](../evals/20261003-issue-42-dependencies.md)。

模型菜单动效的隔离浏览器检查与并排录制：运行 `node extension/test/model-picker-motion.mjs`（[脚本](../../extension/test/model-picker-motion.mjs)），产物在 `out/model-picker-motion/`。它挂载真实组件、生产 CSS 与固定目录，不加载扩展或调用模型；不能替代日常 Chrome side panel 验收。脚本默认复用本机 Playwright/CfT，其他安装路径需调整 Playwright 导入、用 `MODEL_PICKER_CHROME` 指定浏览器。

隔离 worktree 复用依赖时，不能把整个 node_modules 直接指回主工作区：其中 @sideagent 的相对链接会让内部包解析回主源码，浏览器 shim 也可能失效。应在 worktree 建本地依赖目录，复用第三方包，把 @sideagent/agent 与 extension 链回本 worktree；无须改产品构建逻辑。

## 前提小实验

验收脚本预计超过 200 行时，先在 `scripts/probes/` 写不超过 50 行的小实验，只证明一句技术前提，结果写进验收文件「技术前提」。成立才写验收脚本；不成立就改方案，不先搭验收。小实验用独立观测（如服务器计数），退出码 0 为成立、1 为不成立；`npx tsx scripts/probes/<名>.mts` 运行。它不是产品验收，不能冒充真实路径通过。

示例 `readonly-return-getter.mts`：开启副作用拒绝后，返回网页已有对象仍会在序列化时发出 POST，2 秒复现 #22 原方案的否定结论。`click-request-gesture.mts` 否定了用 `hasUserGesture` 归因点击请求（点击后的后台请求也为 true），改用时间窗口；`trusted-domain-psl.mts` 证明 tldts 把 github.io 子站分开、把各语言维基归为一个域名。

## 调试入口

本机伴随进程入口（`npm run dev:agent` 的 WebSocket 调试模式、Native Messaging 宿主）已随本机模式退役删除。扩展的 `nativeMessaging` 权限与连接尝试也已删除。只给测试用、待这些检查改到扩展里跑后删除的两件（见 [STATUS](../STATUS.md)）：Node 会话循环 `agent/src/node-agent-loop.ts`（`eval:live`、用户旅程、P0 在 Node 里托管会话；原语音 v23 两套检查依赖 Jev 播报闸门，已随 Jev 删除），以及扩展的 WebSocket 调试回退——`accept:journeys` 与 P0 本地运行先让 offscreen 文档建不起来、再写 token，扩展才回退到这条通道。

`npm run reload:ext` 需要 Chrome 的远程调试入口，且必须在明确的加载范围内执行；配置和构建存在不证明运行版已经采用。

## 项目看板

`npm run dashboard`（[脚本](../../scripts/maintenance/dashboard.mjs)）生成 `out/dashboard/index.html`：一页给产品负责人看的静态 HTML，内容依次为版本与同步状态、三档能力通过率（9 月底基线与 `eval/runs/*/report.json` 的判分结果，对照 `eval/tasks/tiers.json` 目标）、最近 3 天提交及其验收结论、GitHub 上开着和最近关闭的问题、[STATUS](../STATUS.md) 能力表、分支与工作目录。数据全部在生成时读取；它只读仓库，不 fetch、不改远端，gh 取不到时对应区块显示提示。看板只是汇总视图，不替代 STATUS 与验收记录。

### 给用户看的进展（Linear）

进展只在 Linear 的 [By Your Side 项目](https://linear.app/yishuyuki/project/by-your-side-9d77250909c0)更新（10-04 用户决定，取代临时本地工作页 `127.0.0.1:8894`，其[验收](../evals/20261003-local-workbench.md)保留为历史）。状态含义：In Progress＝正在做；In Review＝已修好验证、尚未装进日常扩展，或需要用户亲手试；Done＝已装进日常扩展；Todo/Backlog＝排队。

每个任务按“以前 → 现在 → 没验到的”写，用产品语言，不写提交号与测试术语；技术证据只给仓库验收文档路径。用户要求充分展示：有可见变化时附实际截图或录屏（注明来源与场景），需要用户试的写清在哪试、怎样算好。阶段变化时在任务下补一句进展；装进日常扩展后才移到 Done。Linear 只做展示，项目事实仍以 [STATUS](../STATUS.md) 与验收记录为准。

### 分工与排期（Linear）

任务按标签分执行者（10-04 用户确认）：「Claude」主导拆任务、写完成标准、查根因、产品判断与最终验收；「Codex 可领」只给规格清楚、写明文件范围与检查命令的实现任务；「要你来」是需要用户亲手试、拍板或授权的事。Codex 用本机 CLI（已接 Linear），在单独的 git worktree 和分支里完成，交回后由 Claude 验收再合入 main；不与 Claude 同时改同一文件，浏览器验收由 Claude 错开安排。排期按 Linear 每周一个周期。

## CI 与人工复核

[Documentation 工作流](../../.github/workflows/docs.yml)运行文档命令级验收与结构检查，并在 PR 中运行功能同步检查。[E2E 工作流](../../.github/workflows/e2e.yml)手动触发，在 Linux 上跑不需要凭据的隔离验收门槛子集（场景列表写在工作流里）。工作流文件写入不代表已经在远端执行，也不等于启用了分支保护。

维护者按[PR 模板](../../.github/pull_request_template.md)核对内容与实现；每个里程碑额外运行全量历史链接审计。所有当前进度和未决项只在 [STATUS](../STATUS.md)维护。

评测环境分类以[浏览器证据](../testing/eval-environment.md)为准；报表和复核页不得把普通任务失败移出分母。

安全候选PR额外执行strict确认策略/台账与输入回归、typecheck、完整npm test、文档同步及构建；验收边界见[安全记录](../evals/20261003-security-confirmation.md)。lockfile补齐缺失的Linux ppc64可选esbuild条目，不升级依赖。

2026-10-03 的 lint 基线校正只取已合并 `2f95cbf` 的 input/index/page-events 三份原文件计数；未使用本轮工作树增加预算。本轮新增诊断仍须修复。原版本与计数证据在 `out/issue-42/merged-lint-baseline.json`。
