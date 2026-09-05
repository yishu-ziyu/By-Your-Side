# 任务: 把本地 CLIProxyAPI 订阅池接入 SideAgent 模型选择器

来源：2026-09-04 用户要求"探测能用就在产品里用上"。探测已完成，结论：池子（http://127.0.0.1:8317/v1，OpenAI 兼容）可用——Codex 全系（含 gpt-5.6-luna）/ Kimi / xAI / Claude 实测返回正常；Antigravity Gemini 全系区域限制（"User location is not supported"）不可用；图像/视频生成模型不适合对话场景。

## 完成标准
- [ ] 1. agent 侧注册 CLIProxyAPI 为自定义 provider（baseURL http://127.0.0.1:8317/v1，key 从 ~/.cli-proxy-api/client.env 读取，不落盘复制到仓库、不打印）— evaluator: npm test + e2e
- [ ] 2. 模型选择器出现"本地池"分组，含对话类模型（Codex/Kimi/xAI/Claude），**排除**：gemini 全系（区域限制已知坏）、图像/视频生成模型（gpt-image、grok-imagine、*-flash-image）— evaluator: e2e hello_ok 模型列表断言
- [ ] 3. 选中池内模型可正常对话（热切换 + 至少一个模型的真实请求往返）— evaluator: e2e 脚本
- [ ] 4. 池子未运行（端口不通）时优雅降级：该组不出现或标注不可用，不导致 agent 启动失败 — evaluator: 单测/e2e（关掉端口场景可模拟）
- [ ] 5. 探测结论与接入方式记入 NOTES.md；config.yaml 的 api-keys 曾因红action 正则未覆盖裸列表项而外泄到会话，记录此事件 — evaluator: 人工复核 NOTES
- [ ] 6. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- 不动 CLIProxyAPI 本体（config/auths/LaunchAgent 一律不改）
- 不新增 OAuth 登录（Claude 已能用但未见 auths 文件，不追来源）
- 默认模型不动（仍 minimax-cn/MiniMax-M3）
- 不做池内额度监控/轮询策略 UI
