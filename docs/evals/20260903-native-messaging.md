# 任务: native messaging 自启动伴随进程

用户不再需要手动 `npm run dev:agent`：加载扩展、打开面板即「已连接」，伴随进程由 Chrome 自动拉起。token 粘贴流程整体删除（native messaging 用 `allowed_origins` 白名单鉴权）。

## 已确认设计决策

- **native port 放 background**（service worker 持有 `connectNative`；panel ↔ background 新增长连接转发事件流）。附带收益：关面板任务不断（原路线图 offscreen 项的大部分价值被本卡覆盖）。
- **保留 `--ws` 调试模式**：手动启动仍走原 WS+token 通道，便于看日志排障；native stdio 为默认。
- **model/proxy 走配置文件**（如 `~/.sideagent/config.json`），CLI 参数优先于配置文件，为后续「模型选择 UI」铺路。

## 完成标准

- [ ] 1. 真机端到端：加载扩展后打开面板，零手动启动、零 token，直接「已连接」，并完成一次完整任务（导航 + 读页面 + 回答）— evaluator: 人评
- [ ] 2. 伴随进程生命周期：由 Chrome 拉起（ps 确认父进程链），Chrome 退出后进程退出 — evaluator: 人评
- [ ] 3. 关闭面板后任务不断；重开面板能看到任务状态和事件流（本决策的附带收益，须验证）— evaluator: 人评
- [ ] 4. 空闲 5 分钟后连接仍可用（MV3 service worker 回收问题已处理：保活或自动重连重放状态）— evaluator: 人评
- [ ] 5. `npm run typecheck` 全绿 — evaluator: npm run typecheck
- [ ] 6. `npm test` 全绿，含：协议编解码在新传输下往返、配置文件读取优先级（CLI > 配置文件 > 默认）— evaluator: npm test
- [ ] 7. token 机制移除：agent 无 checkHello/token 校验（ws 调试模式除外），面板无 token 设置 UI；manifest.json 有固定 `key` + `nativeMessaging` permission — evaluator: grep + typecheck
- [ ] 8. native 模式 stdout 纯净：只写协议帧，banner/日志走 stderr — evaluator: npm test（stdio 传输启动后 stdout 输出可逐帧解析）
- [ ] 9. `npm run install:host` 生成 native host manifest 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`，指向仓库内 wrapper 脚本 — evaluator: 人评执行一次
- [ ] 10. `--ws` 调试模式回归：手动 `npm run dev:agent` + 面板连接仍按原方式工作 — evaluator: 人评
- [ ] 11. README「快速开始」更新为新流程（install:host → 加载扩展 → 直接用）— evaluator: 人评

## 边界与不做

- 不打独立可执行包、不上商店（dev 态 wrapper 脚本跑 tsx）
- 深层 iframe 快照、站点经验工具包、模型选择 UI 不在本卡（模型选择暂只能改配置文件）
- 交互/视觉反馈优化不做（用户明确推迟）
- Windows/Linux 的 host manifest 路径适配不做（当前只 macOS）
