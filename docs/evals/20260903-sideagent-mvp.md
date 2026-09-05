# 任务: SideAgent MVP —— Chrome 侧边栏 Agent 扩展（对标 ego lite 效果）

日期：2026-09-03

## 完成标准

- [x] 1. 双包 typecheck 零错误 — evaluator: `npm run typecheck`（机器）
- [x] 2. 扩展构建产物完整（dist/ 七件：background.js、sidepanel.js、content-snapshot.js、content-domops.js、manifest.json、sidepanel.html、styles.css）— evaluator: `npm run build`（机器）
- [x] 3. 单元测试全绿 — evaluator: `npm test`（机器，36/36）
- [x] 4. WS 握手安全：正确 token + chrome-extension Origin 放行；坏 token / 网页 Origin / 无 Origin 均拒绝 — evaluator: 契约冒烟脚本（机器，四种场景实测）
- [x] 5. 真实 LLM 端到端：对话流式回复 + 工具调用回路（tool_call → tool_result → 模型续答）— evaluator: 模拟扩展客户端冒烟（机器，kimi-coding 实测）
- [x] 6. 底层错误可观测：模型请求最终失败透传真实错误到面板与终端；空响应（限流）有兜底提示 — evaluator: `npm test` + openai-codex 故障实测（机器）
- [x] 7. 面板真实连接、流式对话成功 — evaluator: 人评（用户确认「成功了」）
- [ ] 8. 真实浏览器操控成功率与手感（click/fill/snapshot/截图在真实站点）— evaluator: 人评（待大量使用后裁决）

## 边界与不做

- native messaging 自启动伴随进程、offscreen document 持 WS（关面板任务不断）、CDP Accessibility 快照升级（深层 iframe）、learnings 站点工具包移植、模型选择 UI、商店发布
- 已知边界：click/js/screenshot 触发 chrome.debugger 黄条（按需挂载，闲 15s 自卸）；关闭面板即中止任务；kimi-coding/k3 间歇性空响应（建议 kimi-coding/kimi-for-coding）
