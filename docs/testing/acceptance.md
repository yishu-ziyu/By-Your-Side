# 验收脚本入口

[文档导航](../README.md) · [开发检查](../development/checks.md)

只保留当前仍能被团队找到和重复运行的验收入口。

## 正式入口

- `npm run accept:browser`：浏览器主链。
- `npm run accept:capability`：浏览器能力对齐。
- `npm run accept:real-path`：一次跑完全部真实路径用例（见下节），汇总写 `out/acceptance/real-path/summary-<时间>.json`；`-- --only=a,b` 为过滤轮，恒不算整轮通过。
- `npm run accept:journeys -- --suite smoke|sample|baseline|full`：12 个完整任务模板，真实侧栏 + 真模型 + 独立判定器；结果在 `eval/runs/journeys-*`。
- `npm run accept:isolated`：QA-01 v2 隔离无头验收，默认不调用模型、不需凭据；CI 工作流 `.github/workflows/e2e.yml` 只跑其中 2026-09-23 在 macOS 整轮全绿的 9 个场景（F1–F5、F4b、C1、S1、S2）作回归门槛；目前仅手动触发，待 Linux 首次通过后再挂到 PR。
- `npx tsx scripts/acceptance/page-readouts.mts --headless [--live]`：截断文字的完整值与范围输入框的读数、越界填写回执，零模型请求（[规则](../page-readouts.md)）。
- `npx tsx scripts/acceptance/real-path/answer-selfcheck.mts --headless [--live]`：只装扩展，默认脚本主模型故意给出错误草稿，真实 GLM 快速模型核对；`--live` 改用真实 GLM 主模型。覆盖错误合计 CSV、错误日期文件、缺项/价格/来源及正确结果，下载文件留证。快速模型按设置页同一格式写入隔离扩展存储；需本机已配置 GLM 凭据，产物在 `out/acceptance/answer-selfcheck/`。固定页面检查不代替 #35 的完整产品评测（[标准](../evals/20261002-answer-selfcheck.md)）。
- `npx tsx scripts/acceptance/real-path/pdf-download.mts --headless [--live|--arxiv]`：默认脚本模型走真实 PDF 阅读器和 Chrome 下载，覆盖字节、中断、延迟查询、非法地址与完成后取消；`--live` 用真实 GLM，`--arxiv` 复现 #25 的 arXiv 论文地址。产物在 `out/acceptance/pdf-download/`（[标准](../evals/20261002-pdf-download.md)）。
- `npm run eval:integration -- --headless`：发布集成评测。
- `npm run eval:live`：需要真实供应商或真实环境的评测。

## QA-01 任务书 v2 隔离无头验收（browser-capability-integration-v2）

```bash
# 整轮（留证用这个）
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless

# 只跑指定场景（迭代用，约 8 秒；整轮约 7 分钟）
ONLY=C5 npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S1,S2
```

场景 ID：`F1 F2 F3 F4 F4b F5 C1 C2 C3 C4 C5 S1 S2 S3`，零模型请求（原 S4–S7 走真实 Jev，已随 Jev 于 10-01 删除；`C6` 富文本粘贴原走单独通道 `browser-capability-paste.mts`，依赖本机伴随进程的剪贴板服务，已随本机模式删除）。

无头窗口从不聚焦，产品按设计不把工作页切到前台，所以工作页默认是隐藏状态。C2 先验证隐藏页上的滚轮被快速拒绝、页面没收到事件，再把页切到前台（模拟用户切回窗口）验证落点。

## 真实路径用例（real-path）

```bash
npx tsx scripts/acceptance/real-path/codename-no-save.mts --headless    # 打字让 Agent 填表且不保存
npx tsx scripts/acceptance/real-path/mark-motion-toggle.mts --headless  # 圈画动效默认值与右击切换
npx tsx scripts/acceptance/real-path/companion-toggle.mts --headless    # 「更多 → 显示小伙伴 M」关掉、重开侧栏仍关、再打开
npx tsx scripts/acceptance/real-path/sidebar-header.mts --headless      # 只装扩展、本机假模型：顶部一行会话导航，任务条在输入框上方收起/展开，断线时才露连接状态，M 不挡按钮
npx tsx scripts/acceptance/real-path/plain-text-streaming.mts --headless # 只装扩展、本机假模型：直接写的正文逐段出字、调工具后收进执行过程、停止/出错/插话/历史不重复；设置里 MiniMax 能选 M3.1-Flash-Preview
npx tsx scripts/acceptance/real-path/memory-proactive.mts --headless --model=kimi-coding/kimi-for-coding --fast-model=kimi-coding/kimi-for-coding-highspeed  # 只装扩展、真实模型、本机假订阅站与假 Gmail：自动记邮箱与撤销、新对话直接用、提交前拦、提交后自己去邮箱确认、任务跨轮、过往任务、后台重启后记忆还在；换 --model 跑每家
npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash --suite=sitegeist # Sitegeist 宣传的 5 类任务：多页汇总、导出 CSV、改错字、提取会议、做小工具
npx tsx scripts/acceptance/real-path/voice-page-question.mts --headless # 语音问页面内容（say 合成的 WAV 当麦克风）
npx tsx scripts/acceptance/real-path/point-then-mark.mts --headless    # 用户点选、Esc 取消、侧栏停止
npx tsx scripts/acceptance/real-path/unfinished-turn.mts --headless    # 一项做不到：未完成行写用户原话、无「继续」、步骤清单平铺
npx tsx scripts/acceptance/real-path/offline-send-and-model-menu.mts --headless # 只装扩展、本机假模型：模型菜单未知模型无能力标签（#2）；带引用草稿在后台 worker 停机 / 扩展内 agent 崩溃时发送（#4）
npx tsx scripts/acceptance/real-path/inproc-mark.mts --headless --via-settings --model=stepfun/step-3.7-flash # 只装扩展，设置页到圈画交付
npx tsx scripts/acceptance/real-path/page-download.mts --headless --case=complete|broken # 只装扩展，下载页面提供的文件：完整下完 / 下载中断
npx tsx scripts/acceptance/real-path/artifact-open.mts --headless      # 只装扩展、本机脚本模型：文件卡片「打开」6 种类型、网页越权探针（含对照组）、查看页下载、删除后提示
npx tsx scripts/acceptance/real-path/screenshot-to-user.mts --headless # 只装扩展、本机脚本模型：「把这页截个图给我」图片出现在回答下、点开看大图、下载 PNG；模型自己看的截图不进侧栏；切回会话后回放
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=mark --voice=qingchunshaonv # 只装扩展，语音到页面标注
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=barge-in --model=zai-coding-cn/glm-5.3-flash # 长回答念到一半插话：旧回答停声、不抢话，新问题照常回答
npx tsx scripts/acceptance/real-path/inproc-voice.mts --headless --case=stop-task --model=zai-coding-cn/glm-5.3-flash # 语音确认终止原任务；当前有失败记录
npx tsx scripts/acceptance/real-path/ux-fixes.mts --headless --phase=after [--only=main,demo,voice-nokey,voice-mic,voice-conn,voice-ready] # 09-26 实拍的 10 个界面问题，每步截图
npx tsx scripts/acceptance/real-path/ux-fixes.mts --headless --phase=real --only=real-confirm --real-model=stepfun/step-3.7-flash # 真实模型：等页面确认时这一轮会不会结束
```

`ux-fixes.mts` 只装扩展，模型换成本机脚本模型 `real-path/scripted-model.mts`（OpenAI 兼容，按任务原话里的关键词回写好的正文、工具调用或错误码），像用户一样在设置页选「自定义地址」填写，所以工具调用、宿主核验、账本和页面标注都是产品自己在跑。判据只看用户看得到的东西：侧栏文字里不得出现工具名、元素编号、内部占位、原始错误和账本口吻，页面上的确认按钮要在「发送」键旁边看得见且点了真的提交。语音组填真 key 或一把服务端不认的 key 看连不上的样子；`demo` 组原靠注册伴随进程取得技能存储看示范记录；本机模式退役后驱动不再注册，扩展里没有技能存储、示范入口隐藏，这一组要等技能接进扩展后改写。产物在 `out/acceptance/ux-fixes/<phase>/`。

`real-path/harness.mts` 是共用驱动：隔离的无窗口 Chrome、真侧栏、只装扩展（从当前源码构建到临时目录，agent 跑在 offscreen 文档里，不注册本机伴随进程）、真模型或脚本模型。不碰日常 Chrome 和 `extension/dist`。每条用例只看结果（页面、练习站收到的请求、侧栏状态、日常数据目录），产物在 `out/acceptance/real-path/<时间>-<用例>/`。`launchRealPath({ microphoneWav })` 用 WAV 充当麦克风（只放一遍），语音模型和断句都是真的。`withoutNativeHost` 参数保留只为兼容，传不传都一样；`close()` 返回的 `hostPids` 恒为空。验收文件：`docs/evals/20260923-real-path-first-case.md`、`docs/evals/20260923-repo-cleanup.md`。

`everyday-baseline.mts --headless --inproc=provider/id` 在隔离 Chrome 里只装扩展，像用户一样从设置页填 key、测试连接、保存，再跑 10 条日常请求。扩展内没有诊断记录，所以用 `watchInproc()` 从外部记录 offscreen 的 console 和每次网络请求（首字节、结束），写进 `hostlog.txt` 和 `inproc-requests.json`；每条还要求模型请求只发往所选服务商的主机，发错就判失败。跑完后再像用户一样在设置页点「导出」「清空」：导出的 jsonl 必须覆盖每条用例、每行带 time/sessionId/type/turn、不含 API key，清空后再导出为空（结果在 `summary.json` 的 `traceCheck`）。观察器也记下扩展后台 worker 的起停，用来排除「worker 重启丢了内存状态」这类原因。长文翻译用 `--only=translate-long`（`/long` 页：脚本拼出的 109 个原创英文段落块；判据是 109 块都出现译文），需要 `CASE_LIMIT_MS=900000` 放宽单条时限；翻译用例另记页面上第一段译文出现的时刻和译文块数随时间的变化（`firstTranslatedMs`、`translatedTimeline`），`traceCheck.translation` 列出导出文件里的每次翻译请求和每次翻译工具调用的结果。每条用例导航后把工作页切回前台，上一条新开的标签页不会变成下一条的当前页。`inproc-voice` 跑完同样从设置页导出语音记录，判 `voiceRecordExported`：有 asr、text 行，与侧栏听到的句子一致，不含语音密钥（逐帧行只在诊断模式有，不作要求）。问答、圈画、闲聊用例另记开口时间线（`result.opening`：开麦、握手帧、首帧音频、服务端断句与转写相对开麦的毫秒数和发出音频的响度），并判 `speechDelivered`：WAV 里的人声时长与实际发给服务端的人声时长比较，不依赖服务端断句。`--lead=300` 模拟点完麦克风马上开口；假麦克风在 `getUserMedia` 时开始放。时间线还记服务端回显的 `turn_detection`，以及每个回复的创建、首段文字、工具调用（含参数）、取消/结束和宿主回传的工具结果；`receivedBySecond` 按秒统计收到的事件类型，用来看挂住时服务端还在发什么。`--daily` 在日常 Chrome 跑扩展内 agent 时也挂同一个观察器。圈画这条（`/quota`）要求有一个框同时圈住「五小时用量」和「32%」，并且名牌不压页面文字：框和名牌画在扩展的封闭 shadow root 里，用 CDP 穿透读出位置，再和页面每个文字节点对照。标注渲染的离线自检是 `node extension/test/overlay-check.mjs`（本机 Playwright Chromium 版本变了时用 `OVERLAY_CHROME` 指向当前那一份），through 用例量的是手绘框线本身，不是外层盒子。

`everyday-baseline.mts --daily` 改用 `attachDailyChrome()`：连到用户已开的日常 Chrome（9222），驱动已加载的 `extension/dist` 和日常设置，不构建；在用户窗口里新开标签页和侧栏，结束只关自己开的标签页。只在用户同意后运行。

两个隔离启动器（`real-path/harness.mts`、`isolated-extension.mts`）都把 Chrome 配置目录的下载文件夹指到临时目录，页面下载不进用户真实的下载文件夹。`page-download` 的练习页是夹具服务器的 `downloads.html`：一个文件完整返回，另一个声明 64 KB、发 4 KB 后断开；判据看临时下载文件夹里的实际文件、Chrome 下载记录（`chrome.downloads.search`）和侧栏回答。

临时配置目录由 `temp-profile.mjs` 统一登记：`isolated-extension.mts` 在 `close()` 时删除，real-path 在 `remove()` 时删除；用例抛错、`process.exit()` 或收到 SIGINT/SIGTERM/SIGHUP 时，先杀掉对应 Chrome 再删除。`p0-local-agent-run.mts`、`capability-parity-run.mjs` 与 QA-01 的隔离构建目录同样登记。2026-09-26 之前每次隔离运行都留下配置目录，约 880 个（11 GB）占满了磁盘。

`inproc-*` 用例的模型凭据只写进隔离扩展存储。圈画判据同时要求页面圈住目标、未点击、侧栏交付无错误；只看到圈画但目标账本报未完成，仍为失败。`inproc-mark --via-settings` 等待新会话可发送后才输入，避免把启动中的草稿切换误判为任务失败。

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

## 连续对话侧栏

`npx tsx scripts/acceptance/real-path/sidebar-interaction.mts --headless --run=candidate` 使用隔离真实侧栏与本机脚本模型，检查字阶、窄宽、复制、模型入口、草稿和完成态，保存截图与布局读数。脚本模型只验证交互呈现，不代表供应商或真人语音验收；见[侧栏第二版验收](../evals/20260929-sidebar-interaction.md)。

评测环境分类：见[说明](eval-environment.md)，运行 `npx tsx scripts/acceptance/eval-environment.mts`。
