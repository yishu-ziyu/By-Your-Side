# By Your Side

陪你阅读，也帮你操作网页的 Chrome AI 助手。复用当前浏览器的登录状态，在侧栏对话、阅读网页并执行任务。

开发预览版。现有源码安装面向 macOS + Chrome；三系统成品分发仍是待完成目标。最新验证范围与已知问题只在 [当前状态](docs/STATUS.md) 维护。

## 文档导航

| 要做什么 | 从这里开始 |
|---|---|
| 找项目资料 | [文档总入口](docs/README.md) |
| 安装与配置 | [源码安装](docs/guides/getting-started.md) |
| 了解交互与权限 | [使用说明](docs/guides/usage.md) |
| 找代码职责和调用链 | [架构](docs/architecture.md) · [协议](docs/protocol.md) |
| 接着开发 | [当前状态](docs/STATUS.md) · [续接要点](docs/NOTES.md) |
| 修改与验证 | [开发检查](docs/development/checks.md) · [文档维护](docs/development/documentation.md) |

## 安装

环境准备、模型凭据、扩展加载与可选语音设置见[安装步骤](docs/guides/getting-started.md)。

## 可以做什么

页面理解、选区追问、翻译、浏览器操作、会话与记忆见[使用说明](docs/guides/usage.md)。

## 语音交互

使用方式见[语音交互](docs/guides/usage.md#语音交互)，实现边界见[语音架构](docs/voice-architecture.md)。

## 数据和权限

见[数据和权限](docs/guides/usage.md#数据和权限)。本地伴随进程不意味着模型推理离线。

## 实现结构

`extension/` 负责浏览器与侧栏；`agent/` 负责本地运行时；`shared/` 保存共享契约。详细职责只在[架构](docs/architecture.md)维护。

## 开发与验证

先读 [AGENTS.md](AGENTS.md)，按[开发检查](docs/development/checks.md)选择验证范围。文档检查入口：`npm run check:docs`。
