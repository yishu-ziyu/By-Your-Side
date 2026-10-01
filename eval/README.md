# 浏览器任务评测（eval harness v1）

用真实网页任务给 By Your Side 的侧栏助手打分，比较不同模型。一次任务 = 一个模型配置在独立的无头 Chrome 里、只装扩展，从真侧栏完成一个网页任务。之后用 Codex 看最终截图、页面文本、工具记录和回答判定是否通过，最后汇总出通过率、耗时、token 和图表。

2026-10-02 起 harness 只依赖扩展（[验收](../docs/evals/20261002-eval-extension-only.md)）；full-1 及更早的结果来自已删除的伴随进程架构，见文末。

本目录原有的 `protected/`、`typesafe/`、`p0/`、`goal-evidence/`、`samples/` 是另一套评测，与这里无关，也没有改动。

## 目录

| 路径 | 内容 |
|---|---|
| `harness/` | 运行、判分、汇总、画图的脚本，细节见 [harness/README.md](harness/README.md) |
| `tasks/` | 141 道任务（`tasks.jsonl`，v2）、修改记录 `tasks_changes.md`、生成脚本 `gen_tasks.py`（生成的是 v1，重新生成会覆盖 v2 的修改）、类别分布图 |
| `splits/` | train / held-out 切分（`train.txt`、`heldout.txt`）、切分规则 `README.md`、修正后的基线 `baseline_judge_v3.json` |
| `judge_validation/` | judge v3 与人工结论的对照 `summary.md` |
| `research/` | 竞品调研 `competitors.md`、Go 套餐额度估算图 `cost.png` |
| `results/full-1/` | run full-1 的汇总表和图表（不含 `report.json`、轨迹、截图和逐题原始结果）；验收记录见 [docs/evals/20261001-browser-eval-harness.md](../docs/evals/20261001-browser-eval-harness.md) |

## 怎么跑

每题的流程：用验收驱动 `scripts/acceptance/real-path/harness.mts` 起一个 `--headless=new` 的 Chrome for Testing（临时配置目录，扩展从当前源码构建到临时目录、随机扩展 ID，不注册伴随进程、没有 Native Messaging，不碰日常 Chrome、9222 端口和 `extension/dist`）→ 把主模型、快速模型和凭据写进扩展自己的存储（设置页保存时用的同一组键）→ 打开真侧栏、像用户一样输入并回车 → 结束后在设置页点「导出」，把这一题的诊断记录（IndexedDB `sideagent-diagnostics`）存成 `<题号>.trace.jsonl`，供判分和统计使用。

模型配置写成 `主模型[+快速模型]`，各自是 `服务商/模型 id`；不写快速模型就和主模型相同。凭据读取顺序：环境变量 `BYS_KEY_<服务商>`（如 `BYS_KEY_ZAI_CODING_CN`）→ 阶跃星辰读 `SIDEAGENT_STEP_PLAN_KEY` 或 `~/.sideagent/step-plan.key`（只走 Step Plan 地址）→ `~/.pi/agent/auth.json`。harness 不打印凭据；每题结束会扫描本题写出的文件，`secret_scan.leaked_files` 不为空即说明凭据进了结果。

```bash
# 本机（macOS）：先 npx playwright install chromium（驱动找 Chrome for Testing），判分需要能用的 codex CLI
node eval/harness/run.mjs --models zai-coding-cn/glm-5.3-flash,minimax-cn/MiniMax-M3.1-Flash-Preview+zai-coding-cn/glm-5.3-flash \
  --tasks BYS-006,BYS-008,BYS-081 --concurrency 2 --run-id my-run
# 补跑缺失或无效的结果
node eval/harness/run.mjs --resume --run-id my-run --concurrency 2 --no-judge
# 判分缺失、过期或上次判分出错的结果，并重新生成报告和图表
JUDGE_CONC=4 eval/harness/finalize.sh eval/runs/my-run
```

云端 Linux（**未验证**）：不再需要 Xvfb；需要 Node 22、`npm install`、Python 3 + matplotlib、`ffmpeg`（拼截图，缺了只给页面截图）、一款中文字体（`BYS_CJK_FONT`）、可用的 `codex` CLI。Chrome 用 Chrome for Testing 或 Chromium（品牌版 Chrome 不认 `--load-extension`），用 `EGO_ACCEPTANCE_CHROME=<可执行文件>` 指定；驱动默认只找 macOS 的 Playwright 缓存路径。凭据用 `BYS_KEY_*` 环境变量传入最省事。以 root 运行时 Chrome 可能还要 `--no-sandbox`，驱动目前没有这个开关。

环境变量（默认值都相对本仓库，定义在 `harness/paths.mjs`）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `BYS_REPO` | 被测的仓库（构建它的扩展源码，并用它的验收驱动） | 本仓库 |
| `BYS_TASKS` | 任务文件 | `eval/tasks/tasks.jsonl` |
| `BYS_RUNS_DIR` | 结果输出目录（已被 git 忽略） | `eval/runs` |
| `BYS_KEY_<服务商>` | 该服务商的 API key，优先于本机凭据文件 | 无 |
| `EGO_ACCEPTANCE_CHROME` | Chrome for Testing / Chromium 可执行文件 | macOS Playwright 缓存里最新的一份 |
| `BYS_PRICES` | 价格表 JSON（`服务商/模型` → 每百万 token 美元），有它才算成本 | `harness/prices.json`（目前没有） |
| `BYS_CJK_FONT` | 画图用的中文字体文件 | Noto CJK，macOS 退到冬青黑体/华文黑体 |
| `JUDGE_CONC` | `finalize.sh` 同时跑几个 Codex 判分 | 4 |

## 测量规则（2026-10-02 用户确认）

跑分只用于两件事：找出还不知道的产品问题；修完后确认修好了。已知产品问题没修完时不跑完整评测，每个修复只带它自己的小测试（[路线图](../docs/ROADMAP.md)第 11 条按档报分）。

1. **同一把尺子**：改了判分规则（`tasks/tasks_changes.md`），旧一轮受影响的结果用新规则重判后再比较。反例：旧轮按旧规则、新轮按放宽后的规则，比出来的「进步」是尺子变了。
2. **改规则有门槛**：每条改动写明原因，并检查同类题是否也该收紧；只在看完结果后往有利方向放宽的改动不接受。正例：BYS-140「点下载是用户动作」对所有生成文件题同样成立。
3. **站点不可用单列**：站点连不上、限流、验证码导致的失败记为「环境」，不进通过率，在报表里单独计数。反例：政府网 ERR_CONNECTION_CLOSED 算作模型没做对。
4. **只认超出误差的差距**：每档约 30 题时，通过率的随机误差约正负 14 个点；差距小于此不说「变好/变差」。要下结论就同一批题重复 2–3 次，或只看具体题是否转过来。正例：「BYS-049 两个配置都从失败变通过」；反例：「M3.1 比 GLM 高 4 个点，所以 M3.1 更好」。
5. **保留集只用一次**：`splits/heldout.txt` 34 题在用户判定可以收工时跑一次；改进期间不看、不跑。

## 判分（judge v3）

`harness/judge.mjs` 让 Codex 按任务的成功规则判一次运行，输出 `pass`、`fail` 或 `undeterminable`（无法判定，统计时按未通过计）。证据从强到弱依次是：
1. 最终整窗截图和侧栏截图；
2. 结束后抓取的任务页文本和表单值（`final_page_text`，由 `job.mjs` 记录）；
3. 助手的工具在运行中读到的页面文本，以及答案里每个数字或日期在这些文本中的上下文摘录；
4. 最后 40 次工具调用（能看出报错、被拦下或没有执行的动作）；
5. 助手的最终回答。

规则要点：
- 答案里的事实只要页面文本或截图能支持，就算通过；
- 品牌名不翻译、www 与 cn 这类等价域名、页面自己替换掉的瞬时提示，都不算失败；
- 扩展自动加的状态脚注（如「有一步已经做了，但还没确认结果」）不算助手承认失败；
- 只有证据既不支持也不否定关键结论时，才判「无法判定」。

每条判分结果都记录 `judge_version` 和结果文件的 `result_sha`。版本升级或结果重跑后，旧判分自动视为过期，`finalize.sh` 会重新判分。

验证：对照 full-1 的人工复核，35/37 条一致（不计 1 条可商榷），两条不一致都是「无法判定」，没有把失败判成通过。详见 `judge_validation/summary.md`。

## 任务规则 v2 与切分

`tasks/tasks.jsonl` 是 v2：改了规则写死、与真实页面不符的题（如 BYS-059、042、048、065、083、093）；把要在新会话里验证的记忆题拆成本轮可验的部分；把依赖前一轮的题标为 setup。逐条修改见 `tasks/tasks_changes.md`。

去掉 28 道带前置步骤的题后，剩下 113 题，按类别分层切成 train 79 题、held-out 34 题（种子 20261001）。

**held-out 只用于最终确认**：迭代期间不看、不跑，也不据此改提示词、工具或规则，只在最后跑一次。日常迭代和 issue 验收都用 train。issue #22–#29 的验收用的就是这里的 judge v3 和 v2 规则。

## run full-1 结果（2026-09-30 至 10-01，伴随进程架构，OpenCode Go，judge v3 重判）

113 道不带前置步骤的题，4 个基础配置：

| 配置 | 通过率（judge v3 + 规则 v2） | 原判分（只看截图 + v1 规则） | 无法判定 | 中位总耗时 | 每次通过成本 | 超时 |
|---|---|---|---|---|---|---|
| deepseek-v4.1-flash | 77.0%（87/113） | 69.9%（79/113） | 3 | 20.4s | $0.0091 | 2 |
| deepseek-v4-flash | 69.9%（79/113） | 65.5%（74/113） | 7 | 15.8s | $0.0116 | 6 |
| space-bunny-free | 68.1%（77/113） | 61.1%（69/113） | 3 | 22.8s | 免费 | 6 |
| mimo-v2.6-flash | 62.8%（71/113） | 60.2%（68/113） | 3 | 40.9s | $0.0060 | 19 |

同题对比（BYS-001–057，5 个配置都有结果）：v4.1-flash 82.5%（47/57），v4-flash 77.2%（44/57），space-bunny-free 75.4%（43/57），mimo 66.7%（38/57），mimo 关思考 61.4%（35/57）。

全部 141 题（含结果不可信的 setup 题）：v4.1-flash 76.6%，v4-flash 69.5%，space-bunny-free 66.7%，mimo 62.4%（22 次超时，多为整页翻译）。

逐题结果在 `results/full-1/report_per_task.csv`，各配置汇总在 `report_models.csv`。图表有三张：`chartA.png`、`chartB.png`，以及新旧判分对比 `chart_rejudge.png`（由 `harness/chart_rejudge.py` 生成）。完整的 `report.json`（含失败与判分分歧明细）体积大，留在运行目录，不进仓库。

## 已知限制

- 只装扩展的版本只在本机（macOS）跑过 2 个模型 × 3 题；判分当时没跑成（本机 codex 默认模型对 ChatGPT 账号不可用），报表里 `pass_rate` 为空，见[验收](../docs/evals/20261002-eval-extension-only.md)。云端 Linux 未验证。
- 成本：没有价格表时只报 token。智谱、MiniMax、阶跃都是 Token Plan 订阅，按 token 折算的钱不是实际账单；`catalog_list_total_usd` 是轨迹里 pi-ai 目录的 API 标价，目录外的模型（如 MiniMax-M3.1-Flash-Preview）沿用模板模型的价，只能参考。快速模型的后台判断（`side_call`）只计次数，没有 token。

- 28 道题的前置步骤（划词后 Ctrl+J、预先打开其他标签页、预置记忆等）harness 不执行，这些题的结果不可信。题号：BYS-019–028、BYS-071、BYS-079、BYS-097–106、BYS-121、BYS-122、BYS-124–126、BYS-139（v2 新增 BYS-122、BYS-139）。
- （full-1，伴随进程时期）成本只统计伴随进程轨迹里记录到的模型调用，轨迹自带的 cost 字段恒为 0；所有调用都在非高峰时段，DeepSeek 高峰价翻倍没有测到。
- 关思考配置只跑了 58 题（BYS-001–057 加 BYS-128），图 1 里它和其他行不是同一批题。
- 判分由 Codex（judge v3）完成，只对照过 full-1 的一批人工复核，没有逐条人工审。超时上限为 240 秒。
- 服务器负载过高会导致建环境失败，runner 会重试，并在每个结果里记录当时的负载。
