# 浏览器任务评测（eval harness v1）

用真实网页任务给 By Your Side 的侧栏助手打分，比较不同模型。一次任务 = 一个模型在独立的 Chrome 里完成一个网页任务。之后用 Codex 看最终截图和回答判定是否通过，最后汇总出通过率、耗时、成本和图表。

本目录原有的 `protected/`、`typesafe/`、`p0/`、`goal-evidence/`、`samples/` 是另一套评测，与这里无关，也没有改动。

## 目录

| 路径 | 内容 |
|---|---|
| `harness/` | 运行、判分、汇总、画图的脚本，细节见 [harness/README.md](harness/README.md) |
| `tasks/` | 141 道任务（`tasks.jsonl`）、生成脚本 `gen_tasks.py`、类别分布图 |
| `research/` | 竞品调研 `competitors.md`、Go 套餐额度估算图 `cost.png` |
| `results/full-1/` | run full-1 的汇总表和图表（不含 `report.json`、轨迹、截图和逐题原始结果）；验收记录见 [docs/evals/20261001-browser-eval-harness.md](../docs/evals/20261001-browser-eval-harness.md) |

## 怎么跑

前置条件：Linux，装好 `google-chrome`、`Xvfb`、`ffmpeg`、Node 22、Python 3（带 matplotlib）和一款中文字体。判分需要已登录的 `codex` CLI。本仓库要先 `npm install`，并构建出 `extension/dist`。模型凭据放在 `~/.pi/agent/auth.json`，由伴随进程自己读取，harness 不读取也不打印。

```bash
# 3 个默认模型 × 3 道题，并发 3，跑完自动判分
node eval/harness/run.mjs --tasks BYS-001,BYS-040,BYS-081 --concurrency 3 --run-id my-run
# 补跑缺失或无效的结果
node eval/harness/run.mjs --resume --run-id my-run --concurrency 3 --no-judge
# 判分剩余结果，并重新生成报告和图表
JUDGE_CONC=4 eval/harness/finalize.sh eval/runs/my-run
```

环境变量（默认值都相对本仓库，定义在 `harness/paths.mjs`）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BYS_REPO` | 被测的仓库（用它的 `extension/dist` 和 `agent/`） | 本仓库 |
| `BYS_TASKS` | 任务文件 | `eval/tasks/tasks.jsonl` |
| `BYS_RUNS_DIR` | 结果输出目录（已被 git 忽略） | `eval/runs` |
| `BYS_WORK_ROOT` | 每个任务的临时 Chrome 配置和伴随进程数据 | `$TMPDIR/bys-harness` |
| `BYS_NODE` | 启动伴随进程用的 node | 当前 node |
| `BYS_CJK_FONT` | 画图用的中文字体文件 | Noto Serif CJK Bold |
| `JUDGE_CONC` | `finalize.sh` 同时跑几个 Codex 判分 | 4 |
| `SIDEAGENT_DATA_DIR` | 由 harness 给每个任务的伴随进程单独设置（其中 `config.json` 指定模型），不会碰 `~/.sideagent` | 自动设置 |

## run full-1 结果（2026-09-30 至 10-01，OpenCode Go）

同题对比：BYS-001–057，5 个配置都有结果。

| 配置 | 通过率 | 中位总耗时 | 每次通过成本 | 超时 |
|---|---|---|---|---|
| deepseek-v4.1-flash | 77.2%（44/57） | 14.8s | $0.0072 | 1 |
| deepseek-v4-flash | 70.2%（40/57） | 9.5s | $0.0085 | 5 |
| space-bunny-free | 70.2%（40/57） | 13.8s | 免费 | 4 |
| mimo-v2.6-flash | 64.9%（37/57） | 30.2s | $0.0038 | 12 |
| mimo-v2.6-flash 关思考 | 61.4%（35/57） | 26.0s | $0.0048 | 3 |

全部 141 题（4 个基础配置）：v4.1-flash 69.5%，v4-flash 65.2%，space-bunny-free 61.0%，mimo 59.6%（22 次超时，多为整页翻译）。逐题结果在 `results/full-1/report_per_task.csv`，各配置汇总在 `report_models.csv`，图表是 `chartA.png` 和 `chartB.png`。完整的 `report.json`（含失败与判分分歧明细）体积大，留在运行目录，不进仓库。

## 已知限制

- 26 道题的前置步骤（划词后 Ctrl+J、预先打开其他标签页、预置记忆等）harness 不执行，这些题的结果不可信。题号：BYS-019–028、BYS-071、BYS-079、BYS-097–106、BYS-121、BYS-124–126。
- 成本只统计伴随进程轨迹里记录到的模型调用。轨迹外的直接调用没算进去，轨迹自带的 cost 字段恒为 0。
- 所有调用都在非高峰时段。DeepSeek 高峰价翻倍，这部分没有测到。
- 关思考配置只跑了 58 题（BYS-001–057 加 BYS-128），图 1 里它和其他行不是同一批题。
- 判分由 Codex 根据最终截图和回答完成，没有人工复核。超时上限为 240 秒。
- 服务器负载过高会导致建环境失败，runner 会重试，并在每个结果里记录当时的负载。
