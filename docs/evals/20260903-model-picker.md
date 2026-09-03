# 任务: 模型选择 UI + 查清"模型请求最终失败：Not Found"根因

来源：2026-09-03 用户截图——openai-codex/gpt-5.6-luna 所有请求报 "Not Found"；用户要求加模型选择功能。

## 验收标准
- [ ] 1. 查清 Not Found 根因并记录：本地 SDK 目录是否含 gpt-5.6-luna、404 来自哪一层（端点/代理/鉴权）、对照模型（如 kimi-coding/kimi-for-coding）是否可用 — evaluator: 复现脚本/日志证据，写入 NOTES.md
- [ ] 2. 面板顶栏有模型选择器：列出**已配置凭据的 provider 下**的可用模型（按 provider 分组），显示当前模型 — evaluator: 无头截图 + 人评
- [ ] 3. 选择即生效：panel→background→agent 链路下发 set_model，agent 切换会话模型（SDK 支持则热切换，不支持则重建会话），并写回 ~/.sideagent/config.json 使重启保留 — evaluator: 单测（协议解析）+ 人评真机切换
- [ ] 4. 当前模型状态以 agent 为准：hello_ok/sync 携带当前模型与可用列表，面板重开/多面板显示一致 — evaluator: 无头截图断言
- [ ] 5. 模型请求失败时面板错误提示包含可行动信息（如"模型不存在或已下线，请切换模型"），不再是裸 "Not Found" — evaluator: 人评
- [ ] 6. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- 不做 provider/凭据管理 UI（仍走 ~/.pi/agent/auth.json 与 install:host 流程）
- 不做 thinking level 选择
- 若根因是上游模型下线，修复=切换默认模型+提示，不替他做账号侧操作
