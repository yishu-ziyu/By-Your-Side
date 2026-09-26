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

## 调试入口

```bash
npm run dev:agent            # WebSocket 调试模式
```

该模式默认监听 `127.0.0.1:7758` 并打印连接 token。扩展在 Native Messaging 不可用时可回退连接；它不是普通安装的前置步骤。

Native 模式日志位于 `~/.sideagent/agent.log` 与 `~/.sideagent/wrapper-err.log`。`npm run reload:ext` 需要 Chrome 的远程调试入口，且必须在明确的加载范围内执行；配置和构建存在不证明运行版已经采用。

## CI 与人工复核

[Documentation 工作流](../../.github/workflows/docs.yml)运行文档命令级验收与结构检查，并在 PR 中运行功能同步检查。[E2E 工作流](../../.github/workflows/e2e.yml)手动触发，在 Linux 上跑不需要凭据的隔离验收门槛子集（场景列表写在工作流里）。工作流文件写入不代表已经在远端执行，也不等于启用了分支保护。

维护者按[PR 模板](../../.github/pull_request_template.md)核对内容与实现；每个里程碑额外运行全量历史链接审计。所有当前进度和未决项只在 [STATUS](../STATUS.md)维护。
