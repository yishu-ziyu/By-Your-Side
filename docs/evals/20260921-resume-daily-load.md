# 任务：将五项修复及只记录的影子路由加载日常

## 完成标准
- [x] 工具检查覆盖真实会话挂载，而非漏项合成清单 — 机器：tool-surface / session-tool-mount。
- [x] 相关定点测试、全工程类型检查与扩展构建通过 — 主代理运行下列命令。
- [x] 日常 routeShadow=true，扩展重载后新 Native 进程连接 — 主代理检查配置、进程及日志。
- [ ] 用户真实文字和语音各一条，核对影子记录及回复 — 用户输入，主代理查日志。

## 执行证据（2026-09-21 17:26–17:27 本地）
工作目录：`/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side`。

- `npx vitest run agent/test/tool-surface.test.ts agent/test/session-tool-mount.test.ts agent/test/route-shadow.test.ts agent/test/realtime-voice-session.test.ts agent/test/conversation-manager.test.ts`：5 文件 / 91 项通过。
- `npm run typecheck`：扩展及 Agent 均通过。
- `npm run build`：dist 构建完成。
- `/Users/mahaoxuan/.sideagent/config.json`：只设置 routeShadow=true，默认每日上限400，保留其他键。
- `npm run reload:ext`：fnbjglhppbkgmjeehablkfilmmefjolo 重载成功。
- `ps -axo pid,command`：原宿主14158/14159替换为42717/42724，入口仍为本仓库 agent/src/main.ts。
- `/Users/mahaoxuan/.sideagent/agent.log`：09:27:08.496Z Native启动，09:27:08.498Z 面板连接。启动模型为 opencode-go/deepseek-flash，本次未修改模型。

真实工具数量与原组件预算的区别见 [工具检查补正](20260921-tool-surface-reconcile.md)；五项修复与影子接线见[独立复核](20260921-resume-independent-review.md)。

## 边界
没有提交、发布、全量测试或改动实际路由。真实输入日志等待用户触发；不使用合成音频冒充真人语音。下一步让用户在侧栏发送「1+1等于几」，再用语音问「你好，你能听到我吗」，核对 `/Users/mahaoxuan/.sideagent/route-shadow/`。
