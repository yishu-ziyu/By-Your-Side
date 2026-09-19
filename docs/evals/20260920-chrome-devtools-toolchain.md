# 任务：专用 ChromeMain 的扩展开发检查不再依赖手动点击扩展管理页

## 完成标准

- [x] Codex Chrome DevTools MCP 使用 1.9.0、启用扩展工具，明确连接专用 ChromeMain 的 9222 端口，不自动连接默认 Chrome。— 谁检查：配置解析、进程参数与 MCP 握手
- [x] 能列出 By Your Side，并在确认无运行任务后重载。— 谁检查：真实 MCP 调用
- [x] 能读取扩展后台和侧栏运行状态。— 谁检查：真实 MCP 调用；侧栏不存在时明确记未跑

## 边界与不做

用户在会话 01a0ba80-3254-7583-a0c3-7a9a57819ac1 明确授权此工具链探针。只操作专用 ChromeMain；不改产品代码、不配置商店发布、不接入内置 AI。不终止其他会话持有的旧 MCP，不把独立进程探针冒充当前 Pi 已加载插件。

## 证据

续接时配置仍为包装脚本 1.7.0 + --autoConnect；未发现旧会话已完成升级。ChromeMain 进程 PID 5017 明确带 --remote-debugging-port=9222、--enable-unsafe-extension-debugging 与 ChromeMain user-data-dir。

1.9.0 独立 stdio MCP 握手成功；list_extensions 返回 fnbjglhppbkgmjeehablkfilmmefjolo / By Your Side / Enabled；list_pages 能列出同 ID 的后台 Service Worker。该阶段尚未重载。官方 README 已定点下载核对；1.9.0 --help 仍写着 149 之前的连接限制，但当前 Chrome 152 实测通过，不能只据 help 误判为不支持。

### 实际结果

- `/Users/mahaoxuan/bin/chrome-devtools-mcp-wrapper` 已从 1.7.0 改为 1.9.0；`/Users/mahaoxuan/.codex/config.toml` 的该服务器参数改为 `--browserUrl=http://127.0.0.1:9222 --categoryExtensions`。备份分别为原文件追加 `.before-bys-20260920` 和 `.before-bys-chrome-20260920`（配置备份不入仓、不输出原文）。
- 使用真实配置启动独立 MCP 进程，initialize 回报 1.9.0，扩展工具可见。检查 213 个控制快照全部 idle、无打开侧栏后，`reload_extension` 返回 `Extension reloaded.`。新后台 contextId 与重载前不同。
- 触发扩展 action 打开原生侧栏，MCP 读取 `ready=complete / status=已连接 / composer=true`。后台实际文件与本地 dist 的 background.js、sidepanel.js SHA-256 一致。重载会加载当前 dist，包括原先已构建的产品修复；本轮未重新构建或修改产品代码。
- 证据：`out/acceptance/20260920-chrome-devtools/result.json`、`reload-response.json`；独立探针存同目录 `probe.py`。复验命令：`python3 out/acceptance/20260920-chrome-devtools/probe.py`（只读）；`--reload` 会执行重载且仅在快照空闲、侧栏关闭时继续；`--panel` 会切换侧栏开关，不能当只读命令。探针的证据原始输出默认存 /tmp，仓库 result.json 为本次脱敏摘要。
- 异常保留：首次 reload 后在同一 MCP 连接 evaluate_script 超时；新建 MCP 连接读取后台正常。已打开侧栏在新 MCP 连接里未被枚举，重新触发 action 产生新侧栏后可读取；action 实际切换开/关。因此不删除旧 reload 脚本，也不宣布无条件替代所有浏览器验收。
- 当前 Pi 工具列表只有 Notion，未把 Codex 配置冒充 Pi 已接入；实际功能由独立配置启动验证。已有 Codex 会话的旧 1.7.0 进程未终止，新启动的 MCP 才读取新配置。未改全局模型路由，未安装商店流程或内置 AI。
