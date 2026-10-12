# assets

存放 issue 里要给人看的截图、录像、报告和原始数据。不是产品代码，不合并进 main。

- 每次任务一个文件夹，名字是 `YYYYMMDD-<任务>`，在下面加一节说明。
- 引用这里文件的 issue 用 `blob/assets/<文件夹>/<文件>` 链接。
- 某个文件夹不再被任何开着的 issue 引用时，可以删掉；历史提交里仍能取回。
- 2026-10-12 由原来的 4 条 `assets/*-20261011` 分支合并而来，原分支的提交都是本分支的父提交。

## 20261011-dogfood/ 新用户首启走查截图

（原分支 `assets/dogfood-20261011`）

只存图，不合并。被 issue 引用，引用它的 issue 都关闭后才删。

来源：main 6a8587b，扩展 v0.2.0，Linux 上的 Chrome，全新配置。06 由无头 Chrome 加载同一构建截取。

## 20261011-copy-pass/ 界面文案审校

（原分支 `assets/copy-pass-20261011`）

界面文案 STE 审校的报告和数据。不是产品代码，不合并进 main。

- `20261011-copy-pass/REPORT.md`：报告（核准词表、违规表、影响最大的 10 处修改）。基线 main `6a8587b`。
- `20261011-copy-pass/strings-inventory.csv`：提取的 1907 条字符串和机器扫描结果。
- `20261011-copy-pass/*.js`：提取和扫描脚本（需要 `typescript` 包）。
- `20261011-copy-pass/agy_out.md`：第二意见原文（Antigravity，只找歧义）。

## 20261011-latency/、20261011-intent/ 延迟追踪与意图路由调研

（原分支 `assets/latency-20261011`）

延迟追踪（latency trace）和意图路由调研的证据。main `6a8587b`，2026-10-11（UTC+8）。只放证据，不合并进 main。

### 20261011-latency/ 延迟追踪

- `REPORT.md`：报告（时间线表、每次调用、和 10-07 基线对比、UI 时间对照、修法排名）。
- `*-v2.png`：瀑布图（中文版，issue 里用这一套）。旧版 `*.png` 留作对照。
- `data/runs/<场景>-r<N>/`：每次运行的原始数据。
  - `result.json`：网络层每次模型请求（请求体摘要、首字节、首个思考 / 正文 / 工具块时间、usage）、后台 service worker 事件（debugger attach/detach、sendCommand、tabs.update）、侧栏每 150 ms 采样、页面打开时间。时间单位毫秒，从按下发送算起（`t0`）。
  - `bodies.json`：发给 Step Plan 的完整请求体（JSON 字符串数组，按发送顺序）。
  - `traces.jsonl`：设置页「诊断记录 → 导出」的原样内容。
  - `*.png`：侧栏截图。
- `data/metrics.json`：`scripts/analyze.py` 汇总出的每次运行指标。
- `data/replay.json` / `replay.log`：真实请求体按不同 `reasoning_effort` 重放的结果。
- `scripts/`：
  - `trace-run.mts`：驱动。`npx tsx trace-run.mts --headless --scenario=summary|action|explain|gist --round=N [--fast=step-3.5-flash] [--main=step-5-preview]`。key 取环境变量 `STEPFUN_API_KEY`。
  - `batch.sh`、`batch2.sh`：本次实际跑的批次（需在仓库根目录、设 `EGO_ACCEPTANCE_CHROME` 指向 Chrome for Testing 145、`SIDEAGENT_ACCEPTANCE_DIST=extension/dist`）。
  - `analyze.py`：算指标、写 `metrics.json`。`v2.py`：画 v2 瀑布图。`replay.py`：思考档重放。`show.py`：打印单次运行。
  - 脚本里的路径写死为 `/workspace/bys-trace/`，换机器要改 `BASE` / `out`。

### 20261011-intent/ 意图路由调研

- `REPORT.md`：行业做法、BYS 现状、H1–H8 假设与实验。
- `probe/`：小实验脚本和原始结果。
  - `cache_probe.py` / `.json` / `.log`：系统提示词末尾动态段对缓存的影响（H2）。
  - `firstround_probe.py`、`firstround_probe2.py` 及结果：首轮读页内容 vs 首轮是否先调工具（H1）。
  - `rules_router_offline.py` / `.log`：纯规则路由离线回放。
  - `miyazaki.txt`：正文抽取样本。
  - 脚本读 `/workspace/bys-trace/runs/summary-r1/bodies.json`，换机器改成 `20261011-latency/data/runs/summary-r1/bodies.json`。

## 20261011-stream-proto/、20261011-proto-steps/ 原型

（原分支 `assets/proto-20261011`）

2026-10-11 的两个界面原型和一份延迟追踪报告。不是产品代码，不合并进 main。基线 main `6a8587b`。

- `20261011-stream-proto/`：回答流式手感，现在 vs 按 Claude 实测参数改后（节拍器、按段淡入、拆壳、弹簧入场）。`index.html` 直接打开；录像 `compare.mp4`、`compare-serif.mp4`；静图 `compare.png`、`stills/`；说明 `README.md`。
- `20261011-proto-steps/`：过程块三种改法 + 用户选定的 AC（进行中一行「现在」，做完收成一行回执）。`index.html` 直接打开；录像 `videos/AC.mp4`、`videos/AC-err.mp4`；静图 `stills/AC.png`、`stills/compare-AC.png`；说明 `README.md`。
- `20261011-latency-trace/`：延迟报告的旧版，和 `20261011-latency/` 重复，10-12 删掉。issue 里的链接写的是提交 `77dadfc`，照常能打开。

两个原型的 `product-styles.css` 是当时仓库 `extension/src/sidepanel/styles.css` 的副本。`vendor/` 里是 marked（MIT）和 DOMPurify（Apache-2.0 / MPL-2.0）的发行文件。原型里的界面文字写于 #247 文案审校之前，落地时按 #247 的核准词表改（例如「做了 N 件事」→「做了 N 步」）。
