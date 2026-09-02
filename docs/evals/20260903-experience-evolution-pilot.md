# 任务: 在 ego 项目内试点 ContextPilot/WikiSkill 机制（上下文默认行为 + 离线经验沉淀闭环）

日期：2026-09-03

## 验收标准

- [x] 1. wiki 骨架、consolidator agent、三个 hook 脚本落盘 — evaluator: 文件存在 + `bash -n` 语法检查 ✅（全部通过）
- [x] 2. hook 脚本按 cwd 门控：非 ego 项目触发时零副作用退出 — evaluator: 模拟 payload 测试 ✅（三个脚本均 exit=0、无输出、无副作用）
- [x] 3. SessionEnd 短会话（<50 行轨迹）跳过、防递归守卫（KIMI_CONSOLIDATE_CHILD）、10 分钟 lock 生效 — evaluator: 模拟 payload + 假 kimi 测试 ✅（长会话正确 spawn `kimi -p --agent consolidator`，短会话跳过，递归守卫 exit=0）
- [x] 4. 用户级 config.toml 追加 hooks 后仍是合法 TOML — evaluator: python3 tomllib ✅
- [ ] 5. 第一次真实会话结束时 consolidator 能 headless 跑通并产出 wiki 更新 — evaluator: **人评**（下次真实会话结束后查 `.kimi-code/wiki/consolidate.log`；`kimi -p` 下工具审批行为文档未覆盖，当前配置 `default_permission_mode = "auto"` 理论上不会卡住，需实测确认）

## 边界与不做

- 不动用户级 skills/agents 目录；不改全局 `~/.kimi-code/AGENTS.md`；hooks 注册在用户级 config.toml（产品无项目级配置机制），但脚本内按 cwd 门控只对本项目生效
- consolidator 只产出提案到 `proposals/`，不直接改 skill / AGENTS.md；落地由用户裁决
- fold-archive 与 consolidate.log/lock 已加入 .gitignore（含轨迹原文，可能含敏感信息，不入库）

## 落地清单

- 项目内：`.kimi-code/wiki/`（patterns/ proposals/ index.md logs.md fold-archive/）、`.kimi-code/agents/consolidator.md`、`.kimi-code/hooks/{consolidate,precompact-archive,pending-proposals}.sh`、`docs/NOTES.md`、AGENTS.md 新增两节、.gitignore 追加
- 项目外（唯一）：`~/.kimi-code/config.toml` 追加三条 hooks（标记块 `ego 项目经验沉淀试点 hooks START/END`）
