# 2026-10-15 夜间到 2026-10-16 中午：BYS 测试和研究

测试版本：main `ba3d11a8`。模型：MiniMax-M3.1-Flash-Preview。

这些都是 AI 在自建测试网站上的测试，不是真实用户的反馈。每个例子只跑了 1 次（乘客票价和整理联系方式各跑了 3 次），所以结果不是成功率。EGO 和 Sider 的能力都是官网宣称，不是我们测出来的。

## 先看这里
- `2026-10-16-ego-sider-replication/qa/competitor-score.md`：QA 对 21 个 EGO 和 Sider 例子的判分。以文件开头的「最终结论」为准。
- `2026-10-16-ego-sider-replication/design-review/fix-list-2026-10-16.md`：设计问题清单，每条写了严重程度。
- `2026-10-16-ego-sider-replication/evidence-gate/`：哪些结论有证据，哪些还没有。
- `2026-10-16-ego-sider-replication/competitor-examples.md`：21 个例子的来源和官网原文。

## 每个例子的细节
- `2026-10-16-ego-sider-replication/replicate/<例子>/criteria.md`：运行之前写好的评分标准。
- `2026-10-16-ego-sider-replication/runs/<例子>/rN/`：每次运行一个目录，乘客票价和整理联系方式各有 `r1` 到 `r3`。目录里有服务器记录 `state.json`、结果 `result.json`、结束时的截图。
- `2026-10-16-ego-sider-replication/replicate/_fx/`：测试网站，启动命令在 `lane.sh` 里。

## PR 测试
- `2026-10-16-overnight-pr-tests/`：#290、#439、#440、#483 的测试脚本、测试网站和日志。`STATUS.md` 是夜间记录。

## 相关 PR（都是草稿）
- #485 可以合，合了以后关掉 #439。
- #486 要等它和 main 交替对比的测试结果。
- #487、#488 先不合，PR 正文里写了已知问题。

## 不在仓库里
- 58 个运行视频，因为太大。需要的话找 Proto Bot 要。
