# 验收脚本入口

[文档导航](../README.md) · [开发检查](../development/checks.md)

只保留当前仍能被团队找到和重复运行的验收入口。

Node 入口契约 `npx vitest run extension/test/entry-contract.test.ts` 只证明协议结果；生产仍使用 IndexedDB。不应以没有 IndexedDB 的 Node 环境跳过记忆钩子或放宽原协议断言。

记忆误分类定点：`npx tsx scripts/acceptance/real-path/remember-corrections.mts --headless --scripted`，用 `--only=` 选场景，证据见[验收](../evals/20261003-memory-classification.md)。真实模型仍通过同脚本 `--model=...` 定点核对。

## 正式入口

- `node --import tsx scripts/acceptance/real-path/north-star-research.mts --headless --scripted`：博客、维基、X、Flomo 四站隔离基线，场景与参数见脚本；见[去掉批准卡验收](../evals/20261004-remove-approvals.md)与[诚实完成验收](../evals/20261004-honest-completion.md)。`--model=provider/id` 另需真实模型授权（[标准](../evals/20261004-north-star-cross-site.md)）。
- `npm run accept:browser`：浏览器主链。
- `npm run accept:real-path`：一次跑完全部真实路径用例（见下节）；`-- --only=a,b` 为过滤轮，恒不算整轮通过。
- CI 工作流 `.github/workflows/e2e.yml` 跑几条真实路径用例，仅手动触发，未在 Linux 跑过。
- `npx tsx scripts/acceptance/page-readouts.mts --headless [--live]`：截断文字的完整值与范围输入框的读数、越界填写回执，零模型请求（[规则](../page-readouts.md)）。
- `npx tsx scripts/acceptance/real-path/answer-selfcheck.mts --headless [--live]`：只装扩展，默认脚本主模型故意给出错误草稿，真实 GLM 快速模型做目标核对；`--live` 改用真实 GLM 主模型。需本机已配置 GLM 凭据。固定页面检查不代替 #35 的完整产品评测（[标准](../evals/20261002-answer-selfcheck.md)）。
- `npx tsx scripts/acceptance/real-path/pdf-download.mts --headless [--live|--arxiv]`：默认脚本模型走真实 PDF 阅读器和 Chrome 下载；`--live` 用真实 GLM，`--arxiv` 复现 #25 的 arXiv 论文地址（[标准](../evals/20261002-pdf-download.md)）。
- `npm run eval:integration -- --headless`：发布集成评测。
- `npm run eval:live`：需要真实供应商或真实环境的评测；原 Node 托管的评测套件已删除，有预算时也如实报 BLOCKED，真实模型的产品路径改用 real-path 的 `--live`。

## 真实路径用例（real-path）

```bash
npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless    # 打字让 Agent 填表且不保存
npx tsx scripts/acceptance/real-path/sidebar-header.mts --headless      # 顶部会话导航与任务条
npx tsx scripts/acceptance/real-path/script-friction.mts --headless     # 页面刷新后脚本照常执行，存文件与页面数据一致
npx tsx scripts/acceptance/real-path/model-failover.mts --headless      # 主模型不出字时快速模型接手
npx tsx scripts/acceptance/real-path/plain-text-streaming.mts --headless # 直接写的正文逐段出字，不重复
npx tsx scripts/acceptance/real-path/memory-proactive.mts --headless --model=kimi-coding/kimi-for-coding --fast-model=kimi-coding/kimi-for-coding-highspeed  # 真实模型：记忆、任务跨轮与过往任务；换 --model 跑每家
npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash --suite=sitegeist # Sitegeist 宣传的 5 类任务
npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless # 语音问页面内容（say 合成的 WAV 当麦克风）
npx tsx scripts/acceptance/real-path/answer-before-goal-check.mts --headless # 回答交付与回到空闲不等目标核对
npx tsx scripts/acceptance/real-path/goal-continue-same-page.mts --headless # 回答后的续做只在原网页上、侧栏写明原因
npx tsx scripts/acceptance/real-path/orb-style.mts --headless           # 语音光球三种样子可选，默认暮色
npx tsx scripts/acceptance/real-path/ptt-dictation.mts --headless       # 网页上按住右 ⌥ 说话，松开交给助手（侧栏关着；听写走 Step Plan 套餐）
npx tsx scripts/acceptance/real-path/ptt-capsule.mts --headless         # 按住说话的网页底部胶囊：在听 → 在做 → 结果（念出来），Esc 停；念结果连 MiniMax 订阅 Key
npx tsx scripts/acceptance/real-path/reinject.mts --headless            # 重载扩展后，已打开的网页不刷新也能按住说话
npx tsx scripts/acceptance/real-path/proactive-card.mts --headless      # 侧栏里的主动卡：动词即按钮，按下原位接着说；没成也原位说清；每次判断进诊断记录；全程录侧栏
npx tsx scripts/acceptance/real-path/proactive-card-boundaries.mts --headless # 忙时不抢任务、助手断开留卡、扩展后台重启后旧卡只执行一次
npx tsx scripts/acceptance/real-path/ptt-faults.mts --headless # 真实听写与朗读鉴权拒绝、关闭念结果
npx tsx scripts/acceptance/real-path/ptt-playback-boundaries.mts --headless # 真听写+挂起合成请求，半开超时与过期回调
npx tsx scripts/acceptance/real-path/step-icons.mts --headless          # 侧栏每一步都有自己的图标
npx tsx scripts/acceptance/real-path/route-record.mts --headless # 做成一件事后记下做法，「不用记」可撤销，被停下的不记
npx tsx scripts/acceptance/real-path/route-replay.mts --headless [--first=selector] # 同一类事照上次的做法走、提交前核对；页面改了停下交回；--first=selector 第一次用选择器操作
npx tsx scripts/acceptance/real-path/route-ab.mts --headless [--rounds=3] # 走老路对照实验：照旧组与一步步组各跑 N 轮，按判负条件给结论
npx tsx scripts/acceptance/real-path/thinking-chip.mts --headless # 输入框旁「模型 · 快/深入」：选了真的换档、重开侧栏还记得
npx tsx scripts/acceptance/real-path/unfinished-turn.mts --headless    # 一项做不到时的未完成行
npx tsx scripts/acceptance/real-path/offline-send-and-model-menu.mts --headless # 模型菜单（#2）；后台停机时发送（#4）
npx tsx scripts/acceptance/real-path/inproc-mark.mts --headless --via-settings --model=stepfun/step-3.7-flash # 设置页到圈画交付
npx tsx scripts/acceptance/real-path/page-download.mts --headless --case=complete|broken # 下载页面提供的文件
npx tsx scripts/acceptance/real-path/artifact-open.mts --headless      # 文件卡片「打开」与网页越权探针
npx tsx scripts/acceptance/real-path/screenshot-to-user.mts --headless # 「把这页截个图给我」
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=mark --voice=qingchunshaonv # 语音到页面标注
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=barge-in --model=zai-coding-cn/glm-5.3-flash # 长回答念到一半插话
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=stop-task --model=zai-coding-cn/glm-5.3-flash # 语音确认终止原任务；当前有失败记录
npx tsx scripts/acceptance/real-path/ux-fixes.mts --headless --phase=after # 09-26 实拍的 10 个界面问题
npx tsx scripts/acceptance/real-path/no-model-card.mts --headless # 没连模型就发消息：回复给「连一个模型」按钮
npx tsx scripts/acceptance/real-path/error-recovery.mts --headless # 模型报 401/429/断网：错误卡上修好原因，从出错处接着做
npx tsx scripts/acceptance/real-path/memory-management.mts --headless # 顶栏「记忆」入口有字；抽屉搜索，组头计数跟着结果走
npx tsx scripts/acceptance/real-path/new-conversation-draft.mts --headless # 点「新会话」后马上打字，字不被清掉
```

`ux-fixes.mts` 只装扩展，用本机脚本模型。脚本像用户一样在设置页选「自定义地址」填写，所以工具调用、任务宿主核验和页面标注都是产品自己在跑。判据只看用户看得到的东西。`demo` 组依赖的技能存储已不在扩展里，要等技能接进扩展后改写。

`real-path/harness.mts` 是共用驱动：隔离的无窗口 Chrome、真侧栏、只装扩展（从当前源码构建到临时目录）、真模型或脚本模型。不碰日常 Chrome 和 `extension/dist`。每条用例只看结果（页面、练习站收到的请求、侧栏状态、日常数据目录）。验收文件：`docs/evals/20260923-real-path-first-case.md`、`docs/evals/20260923-repo-cleanup.md`。

`everyday-baseline.mts --headless --inproc=provider/id` 像用户一样从设置页填 key、测试连接、保存，再跑日常请求；模型请求只许发往所选服务商。跑完再像用户一样在设置页导出、清空诊断记录并核对。长文翻译用 `--only=translate-long`，需要 `CASE_LIMIT_MS=900000` 放宽单条时限。标注渲染的离线自检是 `node extension/test/overlay-check.mjs`（本机 Playwright Chromium 版本变了时用 `OVERLAY_CHROME` 指向当前那一份）。

`everyday-baseline.mts --daily` 改用 `attachDailyChrome()`：连到用户已开的日常 Chrome（9222），驱动已加载的 `extension/dist` 和日常设置，不构建；在用户窗口里新开标签页和侧栏，结束只关自己开的标签页。只在用户同意后运行。

两个隔离启动器（`real-path/harness.mts`、`isolated-extension.mts`）都把下载文件夹指到临时目录，页面下载不进用户真实的下载文件夹。

临时配置目录由 `temp-profile.mjs` 统一登记，用例抛错或被中断时也会清理。2026-09-26 之前每次隔离运行都留下配置目录，约 880 个（11 GB）占满了磁盘。

`inproc-*` 用例的模型凭据只写进隔离扩展存储。圈画判据同时要求页面圈住目标、未点击、侧栏交付无错误；只看到圈画但目标账本报未完成，仍为失败。

**过滤轮的三个信号不应混用**：

| 字段 | 含义 |
|---|---|
| `exitCode` / `status` | 本次**实际执行**的 yes/no 场景是否全 yes（过滤集内是否干净） |
| `ok` | 仅**整轮**（无 `ONLY`）且全 yes 才为 `true`。过滤轮恒为 `false` |
| `runKind` | `full` / `filtered`；`executed` 与 `filteredOut` 列出实际跑了哪些、过滤掉哪些 |

被 `ONLY` 过滤的场景**一个工具调用都不会发**，verdict 记 `未跑` 并进 `notRun`——过滤不等于通过。要证明整套通过，应再跑一次不带 `ONLY` 的整轮。

任务专用脚本只有满足至少一条时才留在主线：

1. 被 `package.json`、本文件或另一个活跃脚本引用；
2. 是多个任务共用的驱动、fixture 或独立 oracle；
3. 属于当前发布门禁，并会产出可复验的验收输出。

一次性探针在任务完成后应合入共用驱动，或随 Git 历史保留后从 HEAD 删除。评测文档记录命令、结论和证据位置，不靠永久堆积脚本保存历史。

## 连续对话侧栏

`npx tsx scripts/acceptance/real-path/sidebar-interaction.mts --headless --run=candidate` 使用隔离真实侧栏与本机脚本模型，保存截图与布局读数。脚本模型只验证交互呈现，不代表供应商或真人语音验收；见[侧栏第二版验收](../evals/20260929-sidebar-interaction.md)。

评测环境分类：见[说明](eval-environment.md)，运行 `npx tsx scripts/acceptance/eval-environment.mts`。

会话与文件重启验收：`npx tsx scripts/acceptance/real-path/session-durability.mts --headless`。真实侧栏、扩展与整个隔离 Chrome 进程重启，见[标准](../evals/20261002-session-durability.md)。

会话列表的小迭代：`npx tsx scripts/acceptance/real-path/conversation-menu.mts --headless`，见[验收](../evals/20261003-conversation-menu.md)。

真实路径的临时 Linux Chrome 带 `--no-sandbox`，适配禁止非特权 namespace 的 CI runner；不改变日常浏览器或产品权限。

原生弹窗专项：`node --import tsx scripts/acceptance/dialog-recovery.mts --headless` 隔离构建当前源码，核对原生 confirm/prompt 与恢复；不是供应商模型整链路。时间框定点：`page-readouts.mts --headless --only=range`；`--live` 尚待适配。

#22 只读脚本专案后置：`readonly-script.mts --headless` 仅草拟未来专用工具的验收契约，产品工具尚未实现、脚本未运行，不作为发布入口。求值标记不能覆盖返回对象序列化的实际副作用，见[实验失败](../research/20261003-readonly-js.md)；后置安排不阻塞其他功能。

交互细节回归：`npx tsx scripts/acceptance/real-path/sidebar-interaction.mts --headless --run=craft-after`。快捷键消息检查不等于操作系统实际按下 ⌘J；模型仍为本机脚本，非供应商验收。

页面微交互：`npx tsx scripts/acceptance/real-path/killer-interactions.mts --headless --run=final`，真实隔离扩展、原生鼠标/拖拽数据与本机脚本模型。翻译批次由夹具写入，不冒充供应商翻译质量。

我来 / 你继续：`npx tsx scripts/acceptance/real-path/takeover-handback.mts --headless --run=final`，真实隔离扩展、本机计数页与本机脚本模型。

侧栏关着时的小药丸：`npx tsx scripts/acceptance/real-path/edge-pill.mts --headless --run=final`，真实隔离扩展、本机计数页与本机脚本模型。

工具栏淡出：`npx tsx scripts/acceptance/real-path/chrome-quiet.mts --headless --run=final`，真实隔离扩展与真侧栏，不需要模型。

拖拽投喂的划词与把手：`npx tsx scripts/acceptance/real-path/drag-feed-selection.mts --headless --run=final`，真实隔离扩展与 CDP 原生鼠标/拖拽。macOS 上 Chrome 要按住选区约 150 毫秒再移动才算拖动，脚本照此操作。

直连按钮与改方向：`npx tsx scripts/acceptance/real-path/ghost-hud-and-steering.mts --headless --run=final`，真实隔离扩展、本机媒体/文档页与本机脚本模型。不覆盖真实 YouTube/Bilibili 页面和供应商模型的改写质量。

跨渲染进程拖拽与 ISOLATED helper 前提：`npx tsx scripts/probes/killer-interactions.mts --headless`。它只证明技术前提，不代替上述功能验收。此处不操作日常 Chrome 或重载日常扩展。
