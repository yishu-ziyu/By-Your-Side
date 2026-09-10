# 进度：任务结果齐备后 5 秒内结束

更新时间：2026-09-10 14:21（Grok）
冻结标准：`docs/evals/20260910-task-completion-tail.md`
副本：`/tmp/ego-completion-tail-20260910/{A,candidate}`；root 产品未改。

## 本轮交付
第一候选只改原生控件读数（candidate）：视频默认带 `paused` 等，checkbox 带 `checked`；只要 textContent/visible 也不丢原生状态。交付结束接点未做。

### 检查（原始 log）
| 命令 | 结果 | log |
|---|---|---|
| `npx vitest run extension/test/read-element.test.ts` | EXIT:0，14 passed | `offline/candidate-read-element.test.log` |
| `npm run typecheck` | EXIT:0 | `offline/candidate-typecheck.log` |
| `npm run build` | EXIT:0，`dist/background.js` 244957 bytes | `offline/candidate-build.log` |

## 宿主复测（同 state_environment，请立即启动）
```bash
cd /tmp/ego-completion-tail-20260910/candidate
SIDEAGENT_AB_SEED=completion-tail-repro-a npx tsx scripts/acceptance/completion-tail-run.mts --case=state_environment
```
stdout/stderr 请落到 `docs/tasks/20260910-completion-tail/runs/repro-single-candidate-01.log`。
看：click 之后是否还出现连续空 `textContent`/`visible` 循环；是否 5s 内正式交付并结束。未过 5s 或其它冻结边界再按该样本续修。

## 阶段
- [x] A 单场景复现：180s 空转，评论已齐、paused 从未出现在工具返回
- [x] candidate 原生控件状态 + 定点反例 + typecheck/build
- [ ] 宿主 candidate `state_environment` 复测
- [ ] 若 5s+边界通过则不再扩；否则按新证据续修（含交付结束接点）
