# 受保护评测基线（本地副本）

本目录是 Codex 执行包的锁定评测规格，不是已经达标的证明。

- `quality-gates.json`：41 项机器门槛，缺测为 BLOCKED，聚合为 ALL_REQUIRED_PASS。
- 候选实现不得在同一晋级变更里改这些文件。
- `release:verify` 从本目录读取门槛 SHA；篡改或换文件会被拒绝。

## 保护状态（2026-09-11）

GitHub `main` 分支 **未开启** branch protection（API 404）。仓库没有 CODEOWNERS。没有独立留出集保管人。

因此：

- 不能宣称「评测规则已被远端保护」。
- `evaluation_policy_and_oracle_are_independently_protected` = **BLOCKED**。
- 同一 Agent 既出题又执行，独立性不足，不能宣称盲测。

要启用远端保护，需要有仓库管理权限的人：

1. 保护 `main` 与本目录所在提交；
2. 增加 CODEOWNERS，评测文件需第二人审批；
3. required checks 从受保护 revision 读取门槛，而不是从候选分支读取。
