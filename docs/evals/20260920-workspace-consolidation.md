# 任务：把现有成果保存在一条主线，清理旧分支名称，不丢工作

## 完成标准

- [x] 原 36 个未提交文件全部保存；产品代码、测试与脚本不被此次整理改写。— 谁检查：Git 提交与整理前 SHA-256 清单逐一比较
- [x] 只剩 main 分支与一个原主工作树；仅删除确认已合入 main、且不被工作树使用的分支名称。— 谁检查：git merge-base --is-ancestor、git branch -d、git worktree list
- [x] 旧分支位置、整理前提交历史及工作文件有本机备份，能够恢复。— 谁检查：git bundle verify、归档文件哈希、旧 tip 仍可从 main 到达
- [x] STATUS 提供已有能力／未解决问题／暂停事项，明确不是产品整体验收或发布。— 谁检查：主代理读文档与既有证据、独立只读核对
- [x] 完成后工作区无未提交文件；无推送、无新功能、无产品测试或扩展重载。— 谁检查：git status、此次执行记录

Change：用户只需在原目录继续使用 main，成果有正式本地记录。
Not this：保存版本不代表功能全部通过，不借整理修缺陷或清空忽略文件。
Evaluator：主代理执行上述 Git、哈希和文档检查；独立子代理只读核对能力清单。
Evidence：本文、STATUS、旧分支映射与本机备份。Improve：无，检查通过即停止整理。

## 授权与范围

用户明确同意：保存当前成果、清理已经合并的旧分支、整理能力与遗留清单。此次不开发、不跑产品测试、不推送、不发布、不重载浏览器。工作目录：`/Users/mahaoxuan/Desktop/AI 产品/By-Your-Side`。

开始时已有且仅有一个工作树 `main@60b3b62b26f7c0f34075a66241df5cbb3d815f89`，另有十个分支。十个分支的独有提交数均为 0；不需要再 merge 或 cherry-pick。main 比本机缓存的 origin/main 多 51 个提交；本轮不 fetch，不能据此判断服务器最新状态。无相关测试或 Git 写入进程，后台 aged-checkpoint 已退出（exit 0）。

## 回退依据

本机备份目录：`.git/checkpoints/20260920-consolidation/`（不提交、不推送，仍在同一磁盘，不是异地备份）。

- `before.bundle`：整理前所有 Git refs 的提交历史，已通过 `git bundle verify`。
- `branches-before.txt`、`worktrees-before.txt`：原分支完整位置与工作树登记。
- `working-files-before.tar.gz`、`files-before.json`、`before.patch`：原 36 个变动文件原文、SHA-256 与二进制补丁。
- `acceptance-evidence.tar.gz`：本轮相关 16 个验收目录副本（包括已完成后台任务）；原 `out/` 不删除、不移动。不宣称包含全部历史验收数据。

旧分支与原提交（全部已在 main 历史内）：

| 分支 | 提交 |
|---|---|
| codex/skill-loop-integration | a521d978f190ae698d3d41ae3bfe07a26424d983 |
| feat/skill-fast-loop-20260919 | 52b593e5413e7d148075b3d9e3a0943763b24f15 |
| t01/product-journeys | 4cd8d5543301bc542ecf86b433ac21c36cf9084b |
| t01/review-fixes | 22ec3f0de1c6c9475ff9ba63007d58c110e50386 |
| t02/task-view | 95a93bf11279a3d717095196b03b2f5068cfe5ef |
| t03-task-bar | 627de83465dc439a16232dcba999f59743bea9e1 |
| t04-edit-receipts | c7dee429f499b4fdec7b878f85db9edfe0dfafa4 |
| t05-resume-entry | 6daa3881b2d3fd9cd76bc39bf3fff0861a28235c |
| t06-delivery | a0453aed299bb53ae1611a648962352197bad6ec |
| t08-prep | bba42decf2a708113fb94d40ed52a3402c70af30 |

如需找回分支名称，可在原仓库执行 `git branch t05-resume-entry 6daa3881b2d3fd9cd76bc39bf3fff0861a28235c`；无需重置 main 或覆盖当前工作目录。仅为恢复说明，本轮不执行该恢复命令。

## 结果

已完成：

- `3c52930` 保存整理前全部 36 个文件，加本次收口契约。提交的文件逐一与整理前 SHA-256 比较一致；后续只更新 STATUS、NOTES、修复记录三份文档和本文，未改产品、测试或脚本。
- 十个分支均先检查 tip 是 main 祖先、没有工作树占用，再执行 `git branch -d`（未强删）。`git branch --list` 只剩 main；`git worktree list` 只剩原目录。所有旧 tip 再次验证仍能从 main 到达。
- 工作文件压缩包逐个成员哈希与原清单一致，验收材料压缩包完整读回通过；`git bundle verify .git/checkpoints/20260920-consolidation/before.bundle` 通过。机器摘要存备份目录 `preservation-check.json`。
- 能力与遗留清单经过独立只读核对；主代理没有把不同报告拼成整体验收，也没有把 ChromeMain 已重载误写成所有日常入口都未加载。后台任务通过结果仅据已存在文件核对，没有重跑。
- 最终文档另行保存，完成后执行 `git status --porcelain` 检查为空。另保存 `consolidated.bundle`，包含收口后的提交；它与 before.bundle 均是本机备份，不是远端同步。
- 本次没有运行产品测试、构建、浏览器、模型验收或推送，没有停止正在运行的应用，没有删除工作目录或原验收材料。只读子代理用于材料核对，不是产品模型调用。

现有产品状态只在 [STATUS](../STATUS.md) 维护；历史失败保留在对应验收记录，不因整理变为通过。下一步由用户综合判断产品方向，而不是从旧票组自动继续扩功能。
