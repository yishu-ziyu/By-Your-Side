# 二元评测切分（2026-10-01）

- 来源：tasks.jsonl v2（见 tasks_changes.md）。排除 28 道带 setup 的题（harness 还不能执行前置步骤、连续会话或语音）。
- 按 category 分层，每类约 30% 进 held-out；随机种子 20261001（random.Random，类内先排序再 shuffle）。
- train 79 题，held-out 34 题。
- **held-out 在爬坡期间不许看、不许跑、不许据此改提示词或规则**，只在最终确认时跑一次。
