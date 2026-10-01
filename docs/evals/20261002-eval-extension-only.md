# 任务: 浏览器任务评测只依赖扩展，能用任意已登记模型跑并出判分报表

[当前状态](../STATUS.md) · [评测包](../../eval/README.md) · [上一版评测验收](20261001-browser-eval-harness.md)

## 起因

- 评测每题启动 `agent/src/main.ts` 伴随进程（`eval/harness/job.mjs`），该进程 10-01 已删除：main 上 141 题会全部在建环境阶段失败。
- 选模型靠给伴随进程写 `config.json {model}`；判分 v3 读的 `.trace.jsonl` 也来自伴随进程。
- `finalize.sh`、`analyze.py`、`charts.py` 只认 `opencode-go*` 目录；OpenCode Go 订阅已停，新阵容是 MiniMax（M3、M3.1-Flash-Preview）、智谱 GLM-5.3-flash、阶跃 step-3.7-flash。

## 完成标准

- [x] 1. 每题在独立 Chrome 配置里只装扩展（无伴随进程、无 Native Messaging），不读写日常 Chrome 与其配置 — 谁检查: 机器
- [x] 2. 模型与快速模型按 `provider/modelId` 通过扩展自己的设置与凭据存储配置；凭据从运行机的本地凭据文件或环境变量读取，不打印、不写进结果 — 谁检查: 机器
- [x] 3. 每题结束后从扩展的诊断记录（IndexedDB `sideagent-diagnostics`）导出该题记录，作为判分 v3 与成本统计的输入；记录含 `model_request`、`side_call`、`effort_change` — 谁检查: 机器
- [x] 4. 汇总与图表按任意 provider/model 归组，不再写死 `opencode-go` — 谁检查: 机器
- [x] 5. 本机无头（`--headless=new`）用 GLM-5.3-flash 与 MiniMax-M3.1-Flash-Preview 各跑训练集 3 题，端到端产出判分报表；失败按建环境/模型/判分分类 — 谁检查: 机器，产物路径写入下方
- [ ] 6. 运行说明（本机与云端 Linux）更新到评测包文档；云端是否能跑写明已验证与未验证部分 — 谁检查: 人

## 边界与不做

- 不跑全量训练集或保留集（先报成本再跑）。
- 不改判分规则与任务集内容。
- 本机只用无头 Chrome；不碰日常 Chrome。

## 实测证据

2026-10-02，本机 macOS，Chrome for Testing 149（`--headless=new`），main `cb45b1f` 加本次未提交改动。

做法：`eval/harness/job.mjs` 改用验收驱动 `scripts/acceptance/real-path/harness.mts` 的 `launchRealPath()`（扩展从源码构建到临时目录、随机扩展 ID、只装扩展）、`openSidePanel()` 和 `exportDiagnosticsViaSettings()`；模型与凭据写进 `inproc_model_config`、`inproc_fast_model_config`、`inproc_cred:<服务商>`（设置页保存用的键，未点设置页界面）。凭据读取见 `eval/harness/credentials.mjs`。

运行：`node eval/harness/run.mjs --models zai-coding-cn/glm-5.3-flash,minimax-cn/MiniMax-M3.1-Flash-Preview+zai-coding-cn/glm-5.3-flash --tasks BYS-006,BYS-008,BYS-081 --concurrency 2 --run-id ext-only-smoke-20261002`，再跑 `eval/harness/finalize.sh`。产物：`eval/runs/ext-only-smoke-20261002/`（`report.json`、`report_per_task.csv`、`report_models.csv`、`summary.csv`、每题截图与 `.trace.jsonl`，已被 git 忽略）。另有 `eval/runs/dry-ext-1/`（`--dry-run`：配置后侧栏连上、模型名显示 GLM-5.3-Flash）。

| 题 | 模型配置 | 运行 | 判分 | 总耗时 / 首个输出 | 主模型调用 | 输入 / 输出 / 缓存 token |
|---|---|---|---|---|---|---|
| BYS-006 | GLM-5.3-flash | completed | judge_error | 29.6s / 6.1s | 5 | 32,933 / 408 / 74,752 |
| BYS-006 | M3.1-Flash-Preview + 快速 GLM | completed | judge_error | 10.0s / 5.5s | 2 | 22,237 / 414 / 21,475 |
| BYS-008 | GLM-5.3-flash | completed | judge_error | 7.0s / 7.0s | 1 | 4,808 / 116 / 16,704 |
| BYS-008 | M3.1-Flash-Preview + 快速 GLM | completed | judge_error | 6.1s / 6.1s | 1 | 21,760 / 163 / 187 |
| BYS-081 | GLM-5.3-flash | completed | judge_error | 42.2s / 8.8s | 5 | 57,019 / 1,106 / 54,592 |
| BYS-081 | M3.1-Flash-Preview + 快速 GLM | completed | judge_error | 25.5s / 3.4s | 5 | 22,875 / 2,040 / 94,281 |

- 标准 1：6 题都是 `harness.mode = extension-only`，各自不同的随机扩展 ID；运行后 `~/.sideagent` 下没有 00:53 之后修改的文件，`extension/dist/manifest.json` 仍是 00:45 的构建；驱动不注册本机伴随进程。
- 标准 2：每题 `harness.stored_config` 记下存储里的主/快速模型（不含密钥）；轨迹里主模型回复的 provider/model 与配置一致，M3.1 那组的 `side_call` 全部走 `zai-coding-cn/glm-5.3-flash`。6 题 `secret_scan.leaked_files` 都为空。反例：把 GLM 的 key 设成会出现在结果里的字符串 `glm-5.3-flash` 跑 `--dry-run`，扫描报出 `CREDENTIAL LEAK in BYS-006.json`，说明扫描能抓到泄漏。
- 标准 3：6 题都经设置页「导出」拿到记录（如「已导出 1 个会话、67 条任务记录，0 条语音记录。」）；6/6 含 `model_request`，4/6 含 `side_call`（BYS-008 两题一轮答完，没有核对），1/6 含 `effort_change`（GLM BYS-081：low→high，goal_unfinished）。`effort_change` 只在档位变化时写，不是每题都有。判分 v3 读取的 `tool_execution_start/end` 字段与旧轨迹相同，未改判分规则。
- 标准 4：`analyze.py`、`charts.py`、`finalize.sh`、`chart_rejudge.py` 不再出现 `opencode-go`；按运行里出现的模型配置归组。没有价格表时成本为空、只报 token，另报轨迹自带的 pi-ai 目录标价（`catalog_list_total_usd`）。
- 标准 5 **未通过**：6 题都端到端跑完并产出报表，但判分没跑成。`codex exec` 用 `~/.codex/config.toml` 的默认模型 `gpt-6.1-sol`，服务端回 400「not supported when using Codex with a ChatGPT account」。报表 `pass_rate` 为空、`judge_errors` 为 3/3（每个配置），图表因无判分结果未生成。失败分类：建环境 0、模型 0、判分 6。人工看答案：BYS-006 两个模型都答「默认 10、上限 125」，BYS-008 都答 8 位作者、v7、v1 于 2017-06-12，BYS-081 都导出 11 本书的 CSV；这只是旁证，不算判分。
- 改判分代码只有一处簿记：`judge_error` 的结果不再算「新鲜判分」，换好判分模型后 `finalize.sh` 会重判，判分规则与提示词未改。
- 标准 6：评测包文档已改写（`eval/README.md`、`eval/harness/README.md`），待人核对。云端 Linux 一次都没跑：驱动默认只找 macOS 的 Chrome for Testing（要设 `EGO_ACCEPTANCE_CHROME`），root 运行可能需要 `--no-sandbox`，驱动没有该开关。

### 补判（主代理，10-02）

- 判分模型固定为 `gpt-6-sol`（`eval/harness/judge.mjs` 的 `JUDGE_MODEL`，可用 `BYS_JUDGE_MODEL` 覆盖；判分结果记 `judgeModel`）。实测 ChatGPT 账号下 Codex：`gpt-6.1-sol` 400，`gpt-6-sol`、`gpt-5.6-sol`、`gpt-5.5`、`gpt-6-luna` 可用。未改本机 `~/.codex` 默认。
- `finalize.sh eval/runs/ext-only-smoke-20261002` 补判 6/6：全部 pass（codex+截图+文本），图表生成。标准 5 通过；失败分类：建环境 0、模型 0、判分 0。
- 图表标题在通过率并列时写「N 个配置通过率并列最高」，不再把并列的第一名说成「最高」。
- 注意：PR #30 基线判分未记录所用模型，新旧分数比较时判分模型可能不同。

## 待决（已决）

- 判分用哪个 Codex 模型：改本机 `~/.codex` 默认模型，或给 `judge.mjs` 加一个模型参数。定了以后对本轮跑 `finalize.sh` 即可补判，不必重跑任务。
