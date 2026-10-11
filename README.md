# assets/latency-20261011

延迟追踪（latency trace）和意图路由调研的证据。main `6a8587b`，2026-10-11（UTC+8）。只放证据，不合并进 main。

## 20261011-latency/ 延迟追踪

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

## 20261011-intent/ 意图路由调研

- `REPORT.md`：行业做法、BYS 现状、H1–H8 假设与实验。
- `probe/`：小实验脚本和原始结果。
  - `cache_probe.py` / `.json` / `.log`：系统提示词末尾动态段对缓存的影响（H2）。
  - `firstround_probe.py`、`firstround_probe2.py` 及结果：首轮读页内容 vs 首轮是否先调工具（H1）。
  - `rules_router_offline.py` / `.log`：纯规则路由离线回放。
  - `miyazaki.txt`：正文抽取样本。
  - 脚本读 `/workspace/bys-trace/runs/summary-r1/bodies.json`，换机器改成 `20261011-latency/data/runs/summary-r1/bodies.json`。
