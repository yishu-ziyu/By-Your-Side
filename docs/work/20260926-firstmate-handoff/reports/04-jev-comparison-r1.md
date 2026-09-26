# Jev + 主模型分工 vs 主模型单独：S5/S6 真实对照报告（bys-jev-r1）

日期：2026-09-26 · 仓库：by-your-side，基线提交 `0c40421`（detached worktree，未提交任何东西）· 主模型：日常配置 `zai-coding-cn/glm-5.3-flash` · Jev：`jev-1.13.0`

## 结论

**分工目前还算不上"效果好"，两边各有一类失败。** Jev 在所有样本里没有执行过一次错误写入，但遇到 hover 菜单这类任务（S5）会因为不敢执行而失败。主模型单独做时能完成更多任务，也更快交付，但会重复点击、误点，而且它自报的置信度起不到把关作用。

- **Jev 比主模型差的地方（直说）：S5 hover 菜单。** 实时判断入口成功率 **37%（11/30）**，主模型 **100%（30/30）**；循环入口 **7%（2/30）**，主模型 **90%（27/30）**。Jev 并没有选错：89 次都选中了"点 Settings"，但只有 13 次置信度达到 0.85 门槛，没达到的就不执行。
- **Jev 比主模型好的地方：S6 长列表找目标。** 成功率 **93%（28/30）**，主模型 **63%（19/30）**。主模型那 11 次失败都是**真实页面上多点或误点**。端到端 E6 也一样：分工 **15/15**，主模型单独 **11/15**（4 次重复或误点）。
- **安全性：** Jev 选到错误写动作 30 次，置信度最高只有 0.54，全部被门槛挡住，**实际执行 0 次**。主模型选到错误写动作 40 次，自报置信度常在 0.9，0.85 门槛下仍**执行了 16 次**。
- **速度：** 单次决策 Jev p50 **0.75 s**，主模型 **3.4 s**。但**端到端分工更慢**：E5 p50 73.5 s 对 45.1 s，E6 68.9 s 对 35.8 s。原因是 Jev 循环在这 45 次任务里一次都没以"建议完成"结束，全部交回主模型重新核验或重做，主模型在核验上花的时间比它自己做一遍还长。
- **花费：** 全部真实调用约 **$0.83**。Jev 539 次，$0.21，约 $0.0004/次；主模型 745 次（425 次决策 + 320 轮代理），$0.61。预算不构成约束。

**建议：** 保留"Jev 负责结构化选择、主模型负责开放内容和核验"这个方向，但**先修三处宿主/循环问题，再判定分工是否达标**（见"建议"一节）。**不建议**直接把 0.85 门槛调低，也**不建议**让主模型接管选择。这两个结论都来自本轮数据，理由见下文。

## 对照结果

### A. 决策层对照（其他条件完全相同，只换选择器）

同一个 harness、同一隔离无头 Chrome、同一观察和候选、同一请求内容、同一答案解析、同一个 0.85 门槛和同一执行器，只把 Jev 换成主模型。每个场景、每一臂各跑 30 轮，每轮都新起一个 Chrome，Jev 与主模型交替运行。

| 场景 | 臂 | 页面成功（95% CI） | 错误写（轮） | 任务耗时 p50 / p90 | 每轮模型请求 | 循环结束状态 |
|---|---|---|---|---|---|---|
| S5 实时判断入口 | Jev | **11/30（37%，22–54%）** | 0 | 8.2 s / 14.0 s | 1.9 | 第 2 步 18 次 low_confidence，1 次超时 |
| | 主模型 | 30/30（100%，89–100%） | 0 | 17.1 s / 19.2 s | 2.0 | 全部 suggestion |
| S5 browser_loop 入口 | Jev | **2/30（7%，2–21%）** | 0 | 8.2 s / 9.4 s | 4.1 | 30/30 handoff/low_confidence |
| | 主模型 | 27/30（90%，74–97%） | **2**（Settings 被点 2 次） | 28.8 s / 40.5 s | 4.7 | 8 needs_verification，21 low_confidence，1 连接错误 |
| S6 续读后点 Late-Target | Jev | **28/30（93%，79–98%）** | 0 | 12.0 s / 12.9 s | 5.6 | 27 low_confidence，3 超时 |
| | 主模型 | 19/30（63%，46–78%） | **11** | 38.1 s / 55.7 s | 6.4 | 7 needs_verification，22 low_confidence，1 连接错误 |
| S6 无目标（真实判断器） | Jev | 30/30（100%） | 0 | 0.52 s / 0.85 s | 1.0 | 29 handoff，1 超时（也未点击） |
| | 主模型 | 30/30（100%） | 0 | 2.4 s / 5.2 s | 1.0 | 30 handoff |

"页面成功"以夹具页面上的独立计数器为准：S5 要求 `settings===1 && forbidden===0`；S6 要求 `L-50===1` 且没有其他按钮被点；S6 无目标要求点击总数为 0。这里不看模型自己怎么说。

### B. 逐步选择对不对（Jev 的"选择"与正确答案）

正确答案由夹具结构和已执行历史推出，不参考模型输出。规则写在 `analyze.py:classify`：未 hover 时应 hover Account；菜单项可见时应点 menuitem Settings；目标已点过应 done；S6 目标不在视图里时应续读或进入 Late 分区；无目标页应 handoff 或续读。

| 步骤 | Jev 选对 | Jev 选对且过门槛 | 主模型选对 | 主模型选对且过门槛 | 主模型错误写被执行 |
|---|---|---|---|---|---|
| hover Account | 59/60 | 59 | 59/60 | 59 | 0 |
| **点 Settings（菜单已展开）** | **89/89** | **13（15%）** | 59/59 | 59 | 0 |
| 点 Late-Target（可见） | 28/28 | 28 | 30/30 | 30 | 0 |
| S6 首屏无目标 | 0/30（28 次选"none"弃权，循环会自动续读） | — | 1/30（29 次弃权） | — | 0 |
| **目标已点过 → done** | **112/113** | **0** | 140/215（65%） | 15 | **16**（又点了一次或点了容器） |
| 无目标页 handoff | 29/30 | 29 | 31/31 | 30 | 0 |

汇总（仅决策层，不含报错）：Jev 选对 317/375（84.5%），主模型 320/423（75.7%）。

**门槛敏感度**（被执行的动作里有多少是对的）：

| 门槛 | Jev：执行 / 其中错误写 / 挡掉的正确选择 | 主模型：执行 / 其中错误写 / 挡掉的正确选择 |
|---|---|---|
| 0.60 | 205 / 0 / 112 | 381 / 40 / 6 |
| 0.75 | 185 / 0 / 132 | 261 / 23 / 91 |
| **0.85（现行）** | **129 / 0 / 188** | **213 / 16 / 127** |
| 0.90 | 73 / 0 / 244 | 197 / 15 / 140 |

Jev 选错时置信度 p50 0.50、p90 0.54，选对时 p50 0.80，两者分得很开。主模型选错时 p50 0.70、p90 0.90，选对时 p50 0.90，两者高度重叠。**所以主模型的自报置信度不能当门槛用，Jev 的可以。**

### C. 端到端对照（同一用户句子，完整产品形态）

- **分工**：复刻生产 `runInitialBrowserLoop`，先用用户原话跑 Jev 循环，再把生产原文的 handoff 说明交给主模型"独立核验并继续"。
- **单独**：主模型拿到生产 `SYSTEM_PROMPT`、首屏观察和全部生产浏览器工具（`createBrowserTools`，不含 browser_loop）直接完成任务。
- 每一臂 15 轮，每轮 3 个任务，主模型使用 medium 推理（生产默认），最多 12 轮。

| 任务 | 臂 | 成功 | 错误写 | 总耗时 p50 / p90 | 主模型轮数 | Jev 请求 | 其中 Jev 循环耗时 p50 |
|---|---|---|---|---|---|---|---|
| E5 hover 菜单点 Settings | 单独 | 14/15（93%） | 0 | **45.1 s** / 63.4 s | 3.0 | 0 | — |
| | 分工 | 13/15（87%） | 1 | 73.5 s / 106.4 s | 3.7 | 3.9 | 8.3 s |
| E6 点 Late-Target | 单独 | 11/15（73%） | **4** | **35.8 s** / 119.3 s | 5.3 | 0 | — |
| | 分工 | **15/15（100%）** | 0 | 68.9 s / **85.8 s** | 4.5 | 5.7 | 11.9 s |
| E6N 目标不存在 | 单独 | 15/15 | 0 | 20.3 s / 27.9 s | 2.0 | 0 | — |
| | 分工 | 15/15 | 0 | 27.4 s / 45.0 s | 2.8 | 1.0 | 1.4 s |

- 分工臂里 Jev 循环 45 次的结束状态：`low_confidence` 26 次，`provider_error`（Jev 3 秒超时）4 次，`unsupported_action`（无目标时正确 handoff）15 次，**`needs_verification` 0 次**。
- 分工 E5 的两次失败：一次是供应商连接错误；另一次是主模型的 `browser_run` 点了 Settings 后因 `setTimeout` 未定义报错，主模型以为没点上又点了一次。这次 Jev 循环只做了 hover，重复点击来自主模型。
- 单独 E6 的 4 次失败都是主模型先点击、再快照"核验"、然后又点一次，或点到了别的按钮。
- 分工 E6 里，主模型交接后的核验时间 p50 为 57.3 s，而它单独做完整个任务的 p50 只有 29.4 s。

## 为什么会这样

1. **Jev 的 click 概率被两个无关候选分走，结果卡在门槛下面。** 在"菜单已展开，应点 Settings"这一步（n=89），Jev 给 click 的平均概率是 0.82，switch_tab（切到隔离实例里的 `about:blank` 标签页）0.058，reobserve 0.061，最终置信度均值 0.79。结果是 Jev 选对了却不执行，S5 两个入口因此失败。日常使用时打开的标签页更多，switch_tab 候选只会更多。这一条是推断，本轮没有在多标签条件下测量。
2. **循环在置信度不够时写入了一条与事实不符的历史。** `agent/src/browser-decision-loop.ts:272` 在 `low_confidence` 时也写入 `Checked partition …: no matching target.`，但目标其实就在视图里，只是 Jev 不够确定。随后循环切到只剩菜单容器的分区。Jev 在这个分区里 30/30 次选了"点容器"（置信度约 0.5，被挡）。主模型遇到同样情况会执行，S5 循环里 4 次点容器、2 次重复点 Settings 都出自这里。
3. **点击后重新观察时，循环回到了首个分区。** 动作之后 `page = undefined`，下一步用 `snapshot {decision:true}` 重新观察（`browser-decision-loop.ts:170`），得到默认首分区（S6 是 Early 区），刚点过的目标不在视图里，回执又是"已执行、未核验"。Jev 在这里 112/113 次正确地想说 done，但置信度都在 0.4–0.5，一次也没过门槛。于是循环从来没有以 `needs_verification` 结束，全部交回主模型重新核验。这就是端到端分工更慢的主要原因。
4. **主模型的置信度不校准。** 它对错误选择也常报 0.9，0.85 门槛挡不住，在 S6 和 S5 循环里造成了真实的重复点击和误点。
5. **Jev 的 3 秒超时。** `agent/src/browser-decision-model.ts:60` 设了 `AbortSignal.timeout(3000)`。539 次请求中 9 次超时（1.7%）：5 次是 S6 这类约 37 KB 的大请求，4 次是 S5 这类 4–6 KB 的小请求。所以超时是供应商延迟的长尾，不只是请求大小造成的。Jev 延迟 p50 745 ms，p90 1454 ms，成功请求的最大值 2952 ms，已经贴近 3 秒。

## 请求数与花费（本轮真实调用）

| 模型 | 真实请求数 | 输入 / 输出 token | 花费 | 计价依据 |
|---|---|---|---|---|
| Jev `jev-1.13.0` | 539（决策层 380 + 端到端循环 159） | 5.04 M / 0.59 M | **$0.21** | 官方 $0.042/M 输入，输出免费（docs.typesafe.ai/models.md） |
| 主模型作为选择器 | 425 | 2.24 M / 0.04 M | **$0.36** | pi 模型表给出的 `usage.cost`；实际账单按 zai 订阅方案，可能不同 |
| 主模型端到端代理 | 320 轮 | 共 5.11 M | **$0.25** | 同上 |

另有 7 次冒烟运行（约 30 次 Jev、10 次主模型请求），用来验证环境，其中主模型 JSON 解析尚未修正，**不计入上面的统计**。

## 公平性与未证明的部分

- **只有两个夹具、一个主模型。** S5 和 S6 都是本地合成页面，而且多轮开发中已经见过，属于回归集，不是留出集。按项目规范（`docs/evals/20260920-general-browser-contract.md` §6），这些结果不能当作"通用能力"的证据。门槛敏感度表是样本内的，**不能据此直接调门槛**，需要在新的留出任务上验证。
- 决策层主模型用 `minimal` 推理，这是生产里其他有界小调用的做法；端到端用生产默认的 `medium`。没有测更强的主模型，因为本轮问的是日常配置下的分工。
- 端到端"单独"臂是最小化的工具循环：有生产系统提示词和工具，但没有 `task_goals` 目标账本和 `send_user_message` 交付通道。分工臂也没有 `deliverVerifiedBrowserLoopOutcome` 的直接交付，因为本 harness 没有目标账本。两臂都没有这部分，条件对等。
- S5 循环的超时从 40 s 改成了生产值 90 s，两臂一致，以免主模型因测试预算太紧被冤判。
- 两条批量流并行运行（决策层和端到端），两臂共用供应商，延迟可能相互影响；Jev 与主模型轮流运行，以抵消时段漂移。
- 有一个孤立的隔离 Chrome for Testing 进程（PID 17477，01:59 启动，父进程已退出，临时目录 `sideagent-isolated-KIpQ9u`）。它的临时目录不在本任务 210 次运行的任何产物里，无法确认归属，可能来自其他 lane 并行跑的同一 harness，**我没有结束它**。本任务 210 次运行的 `cleanup` 全部为 PASS，`dailyDistUnchanged` 全部为 true，没有碰日常 profile 或日常 dist。

## 建议

这些建议无需船长另作裁决，可由 firstmate 决定是否转成交付任务：

1. **修正低置信度时写入的错误历史**（`browser-decision-loop.ts:272`）。只有 `no_match` 才写"no matching target"；`low_confidence` 应写"uncertain, not executed"，并且不要切走当前分区。这一处会直接影响 S5 两臂的后续判断。
2. **动作后的重新观察应带回目标所在分区，或在回执里给出可核验的读回**，让"已点过 → done"在同一视图里能被判定。当前 112/113 次 done 判断都对，却全部被挡，这正是端到端分工变慢的主要原因。
3. **减少与目标无关的 switch_tab 候选**，只在用户目标确实涉及标签页时提供。先在多标签条件下复测，看 S5 的 click 置信度能否回到门槛以上。
4. **不要调低 0.85 门槛，也不要让主模型接管选择。** 前者只在两个见过的夹具上验证过；后者的置信度不能拦截错误写。上面 1–3 完成后，在新的留出任务上重跑本对照再下结论。
5. 可以考虑把 Jev 超时从 3 s 放宽到 5 s。本轮 9 次超时里有 4 次是小请求，说明是延迟长尾。这个改动的收益小于 1–3。

**建议的下一轮验收门槛：** 修复后重跑同一对照，S5 两个入口的 Jev 成功率 ≥ 90%、错误写仍为 0，E5/E6 分工的端到端 p50 不慢于单独，再补不少于 6 个留出任务。

## 证据

### 运行命令

在 worktree 根目录执行，每轮都是新的 `--headless=new` Chrome for Testing 和临时 `--user-data-dir`：

```bash
# 决策层（每一臂）：
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S5 --s5-entry=realtime --jev-budget=100 --judge=jev|main --main-model=zai-coding-cn/glm-5.3-flash
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S5 --s5-entry=loop     --jev-budget=100 --judge=jev|main --main-model=zai-coding-cn/glm-5.3-flash
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S6 --s6-none=real      --jev-budget=100 --judge=jev|main --main-model=zai-coding-cn/glm-5.3-flash
# 端到端：
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=E5,E6,E6N --e2e=split|alone --jev-budget=100 --main-model=zai-coding-cn/glm-5.3-flash
# 批量：scripts/acceptance/jev-compare/run-batch.sh decision 30 ; run-batch.sh e2e 15
# 汇总：python3 scripts/acceptance/jev-compare/analyze.py
```

- 零模型基线复验：`--only=S5 --s5-entry=loop --s5-fixture=valid --jev-budget=0`，结果 2/2，`dailyDistUnchanged: true`。
- 重构后回归：`npx vitest run` 跑 `browser-decision-{trace,budget,input,loop}.test.ts`，结果 45/45 通过。

### 对 worktree 的改动（仅实验用，未提交，worktree 将被丢弃）

- `agent/src/browser-decision-model.ts`：把请求构造和答案解析抽成 `buildBrowserDecisionRequest` 和 `interpretBrowserDecisionAnswers`，Jev 的请求字节和行为不变（上面的测试覆盖了这一点），让主模型选择器能用完全相同的请求和解析。
- `scripts/acceptance/browser-capability-integration-v2.mts`：新增 `--judge=jev|main`、`--main-model`、`--s6-none=real`、`--e2e=split|alone` 和 E5/E6/E6N 场景。每次请求写 `<arm>-request-N.json`，内容包括输入、决策、trace 和耗时。S5 循环超时 40 s 改为 90 s。默认参数下仍是原有行为。
- `scripts/acceptance/jev-compare/main-model.mts`：主模型选择器（通过 pi `ModelRuntime.completeSimple`，与生产使用同一套凭据配置）和最小工具循环代理。
- `scripts/acceptance/jev-compare/analyze.py`：正确答案判定、Wilson 置信区间、分位数、花费统计。

### 原始产物（在 worktree 中，teardown 后删除）

- `out/jev-compare/manifest-{decision,e2e}.tsv`：210 行，每行对应一个 `out/acceptance/browser-capability-integration-v2-<ts>/`。
- `out/jev-compare/summary.json`：逐轮和逐次决策的明细。

如需保留，应在 teardown 前拷走。

### 凭据使用

按 inbox 001 的批准，只通过项目现有读取路径使用凭据：Jev 走 `agent/src/typesafe-auth.ts`，主模型走 pi `ModelRuntime` 和 `cliproxy.ts`。本任务从未打印、复制或读取任何密钥内容。
