# 验收脚本入口

[文档导航](../README.md) · [开发检查](../development/checks.md)

只保留当前仍能被团队找到和重复运行的验收入口。

## 正式入口

- `npm run accept:browser`：浏览器主链。
- `npm run accept:capability`：浏览器能力对齐。
- `npm run accept:team`：多 Agent 协作。
- `npm run accept:sessions`：会话管理。
- `npm run accept:real-path`：一次跑完全部真实路径用例（见下节），汇总写 `out/acceptance/real-path/summary-<时间>.json`；`-- --only=a,b` 为过滤轮，恒不算整轮通过。
- `npm run accept:journeys -- --suite smoke|sample|baseline|full`：12 个完整任务模板，真实侧栏 + 真模型 + 独立判定器；结果在 `eval/runs/journeys-*`。
- `npm run accept:isolated`：QA-01 v2 隔离无头验收，默认不调用模型、不需凭据；CI 工作流 `.github/workflows/e2e.yml` 只跑其中 2026-09-23 在 macOS 整轮全绿的 9 个场景（F1–F5、F4b、C1、S1、S2）作回归门槛；目前仅手动触发，待 Linux 首次通过后再挂到 PR。
- `npm run eval:integration -- --headless`：发布集成评测。
- `npm run eval:live`：需要真实供应商或真实环境的评测。

## QA-01 任务书 v2 隔离无头验收（browser-capability-integration-v2）

```bash
# 整轮（留证用这个）
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless

# 只跑指定场景（迭代用，约 8 秒；整轮约 7 分钟）
ONLY=C5 npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S4,S6
```

场景 ID：`F1 F2 F3 F4 F4b F5 C1 C2 C3 C4 C5 S1 S2 S3 S4 S5 S6 S7`（`C6` 富文本粘贴走单独通道 `browser-capability-paste.mts`）。

无头窗口从不聚焦，产品按设计不把工作页切到前台，所以工作页默认是隐藏状态。C2 先验证隐藏页上的滚轮被快速拒绝、页面没收到事件，再把页切到前台（模拟用户切回窗口）验证落点。

## 真实路径用例（real-path）

```bash
npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless    # 打字让 Agent 填表且不保存
npx tsx scripts/acceptance/real-path/mark-motion-toggle.mts --headless  # 圈画动效默认值与右击切换
npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless # 语音问页面内容（say 合成的 WAV 当麦克风）
npx tsx scripts/acceptance/real-path/point-then-mark.mts --headless    # 用户点选、Esc 取消、侧栏停止
npx tsx scripts/acceptance/real-path/unfinished-turn.mts --headless    # 一项做不到：未完成行写用户原话、无「继续」、步骤清单平铺
npx tsx scripts/acceptance/real-path/inproc-mark.mts --headless --via-settings --model=stepfun/step-3.7-flash # 只装扩展，设置页到圈画交付
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=mark --voice=qingchunshaonv # 只装扩展，语音到页面标注
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=stop-task --model=zai-coding-cn/glm-5.3-flash # 语音确认终止原任务；当前有失败记录
```

`real-path/harness.mts` 是共用驱动：隔离的无窗口 Chrome、真侧栏、经 Native Messaging 拉起当前源码的伴随进程、真模型。伴随进程的数据写进临时目录（`SIDEAGENT_DATA_DIR`），凭据从 `~/.sideagent` 原位只读；不碰日常 Chrome、`extension/dist` 和日常伴随进程。每条用例只看结果（页面、练习站收到的请求、侧栏状态、日常数据目录），产物在 `out/acceptance/real-path/<时间>-<用例>/`。`launchRealPath({ microphoneWav })` 用 WAV 充当麦克风（只放一遍），语音模型和断句都是真的。加 `--model=provider/id` 只替换测试伴随进程的模型（例如 `kimi-coding/kimi-for-coding`），日常配置不动。验收文件：`docs/evals/20260923-real-path-first-case.md`、`docs/evals/20260923-repo-cleanup.md`。

`inproc-*` 用例则不注册 Native Messaging：模型凭据只写进隔离扩展存储。圈画判据同时要求页面圈住目标、未点击、侧栏交付无错误；只看到圈画但目标账本报未完成，仍为失败。`inproc-mark --via-settings` 等待新会话可发送后才输入，避免把启动中的草稿切换误判为任务失败。

**过滤轮的三个信号别混用**：

| 字段 | 含义 |
|---|---|
| `exitCode` / `status` | 本次**实际执行**的 yes/no 场景是否全 yes（过滤集内是否干净） |
| `ok` | 仅**整轮**（无 `ONLY`）且全 yes 才为 `true`。过滤轮恒为 `false` |
| `runKind` | `full` / `filtered`；`executed` 与 `filteredOut` 列出实际跑了哪些、过滤掉哪些 |

被 `ONLY` 过滤的场景**一个工具调用都不会发**，verdict 记 `未跑` 并进 `notRun`——过滤不等于通过。要证明整套通过，必须再跑一次不带 `ONLY` 的整轮。

任务专用脚本只有满足至少一条时才留在主线：

1. 被 `package.json`、本文件或另一个活跃脚本引用；
2. 是多个任务共用的驱动、fixture 或独立 oracle；
3. 属于当前发布门禁，并会产出可复验 artifact。

一次性探针在任务完成后应合入共用驱动，或随 Git 历史保留后从 HEAD 删除。评测文档记录命令、结论和证据位置，不靠永久堆积脚本保存历史。
