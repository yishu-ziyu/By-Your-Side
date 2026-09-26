# 按 TypeSafe 官方指南重新设计向 Jev 的提问：S5/S6 十轮方向试验（bys-jev-design-r1）

日期：2026-09-26 · 仓库 by-your-side · 基线：`fm/bys-jev-fix-r1`（`4abe606`，含上一轮三处循环补丁）· 原型提交：scratch `32f5103`（未推送，worktree 拆除即删除）· Jev `jev-1.13.0`

## 结论

**方向是对的，建议按这个方向改产品，然后跑完整 30 轮验收。** 十轮只能说明方向，不能当验收。

新做法是：代码掌控流程；每看到一次页面，只问 Jev 几个窄问题：用户要点的是哪个控件、它在不在当前视图里、该先打开哪个菜单、任务是否已经完成、这个点击是不是高风险写入。代码根据这些答案决定悬停、续读、点击或停止。

S5 和 S6 上，新做法没有比现有做法差，在三件事上明显更好：

1. **循环能自己判断“已完成”。** 新做法在所有没遇到网络故障、且问到完成判断的运行里，**13/13 都以“已完成，待核验”结束**（S5 循环入口 5/5，S6 8/8）。现有做法是 **0/12**：它的 done 置信度只有 0.58–0.74，全部低于 0.85，所以只能以 `low_confidence` 交回主模型。
2. **点击判断的把握更大。** 新做法对“点哪个”的置信度 22/22 次都是 1.00；现有做法是 0.90–0.97。两者都过了 0.85，但新做法离门槛更远。
3. **请求更小，延迟更稳。** S5 单次请求约 2 KB，现有做法约 5 KB；S6 为 28 KB 对 37 KB。Jev 单次请求 p90 为 **0.72 s 对 1.92 s**（S6 为 0.82 s 对 2.70 s）。

**成功率分不出高低。** 两边的失败全部来自同一个网络问题：本机代理偶尔卡在 TLS 握手，约 12% 的 Jev 请求撞上 3 秒上限。只看没遇到网络故障的运行，两边每个任务都是 100%。两边都没有错误写入。

**有一处要说清：** 循环自己判断出“已完成”，并不会自动让端到端变快。现在的产品只要循环执行过点击，就不走直接交付（`agent/src/session.ts` 的 `verifiedBrowserLoopDeliveryText`），仍然交回主模型核验。前两轮测到的“分工更慢”，主要慢在这一步。要不要在“Jev 判定完成 + 执行器确认点击已送达”时直接告诉用户完成，是产品上的取舍，需要船长定（见最后一节）。

## 用户能看到的变化（推断，本轮没有跑端到端）

| 场景 | 现在 | 改完后 |
|---|---|---|
| “打开 Account 菜单点 Settings”，页面操作成功 | 循环点完后说不准是否完成，交回主模型，主模型再看一遍页面才回复 | 循环自己给出“已完成，待核验”。能否省掉主模型那一轮，取决于下面的船长决定 |
| 长列表里找 Late-Target | 同上 | 同上；另外单次判断更快（p90 0.8 s 对 2.7 s） |
| 页面上没有要找的按钮 | Jev 可能在还没读完页面时就交回（本轮 S6N 10/10 都是读一个窗口就交回） | 代码把所有分区读完才说“没找到”。本例多花一次请求，约 0.4 s |
| 要点的是“删除账号”“付款”这类按钮 | 只看同一个 0.85 门槛 | 另有一个“高风险写入”判断，高风险就不自动点，改为请用户确认（本轮只做了离线检查，见下文） |

## 十轮对照数据

条件：每次运行新起一个隔离的无头 Chrome for Testing（`--headless=new`，临时 profile，隔离扩展构建），同一时间只开一个。两臂轮流、同一夹具、同一执行器、同一 3 秒超时且不重试、同一 0.85 门槛，唯一区别是怎么向 Jev 提问、怎么组合答案。成功与否只看页面计数器：S5 要求 `settings===1 && forbidden===0`，S6 要求 `L-50` 恰好被点一次、别的都没点，S6N 要求零点击。80 次运行 cleanup 全部 PASS，`dailyDistUnchanged: true`。1 分钟负载中位数 12–14（8 核；上一轮定的“高于 16 视为耗时不可靠”，本轮没有超过）。

| 任务 | 臂 | 成功（95% CI） | 无网络故障时成功 | 错误写 | 任务耗时 p50 / p90 | 每轮 Jev 请求 | 平均请求大小 | 结束方式 |
|---|---|---|---|---|---|---|---|---|
| S5 实时判断入口 | 现有 | 8/10（49–94%） | 8/8 | 0 | 12.9 / 14.4 s | 1.9 | 5.1 KB | 8 次 悬停→点击；2 次网络超时 |
| | 新 | 6/10（31–83%） | 6/6 | 0 | 12.7 / 13.3 s | 1.8 | 1.9 KB | 6 次 悬停→点击；4 次网络超时 |
| S5 循环入口 | 现有 | 7/10（40–89%） | 5/5 | 0 | 14.1 / 15.9 s | 2.6 | 5.4 KB | 5 次 `low_confidence`；5 次网络超时 |
| | 新 | 7/10（40–89%） | 5/5 | 0 | 14.1 / 17.1 s | 2.6 | 2.1 KB | **5 次 `needs_verification`**；5 次网络超时 |
| S6 长列表 | 现有 | 10/10（72–100%） | 7/7 | 0 | 10.8 / 13.6 s | 3.0 | 37.4 KB | 7 次 `low_confidence`；3 次网络超时 |
| | 新 | 9/10（60–98%） | 8/8 | 0 | 8.6 / 11.0 s | 2.9 | 28.1 KB | **8 次 `needs_verification`**；2 次网络超时 |
| S6N 无目标 | 现有 | 10/10 | 10/10 | 0 | 0.5 / 0.7 s | 1.0 | 36.6 KB | 10 次 Jev 选 handoff |
| | 新 | 10/10 | 10/10 | 0 | 0.9 / 0.9 s | 2.0 | 29.9 KB | 10 次 代码读完后 `no_match` |

说明：

- 有些运行在点击之后才超时，页面上已经成功（例如 S6 现有臂 10/10 成功，其中 3 次循环以超时结束），所以“成功”可能多于“无网络故障时成功”的分母。
- 请求层汇总：现有 85 次请求、10 次超时（12%），成功请求延迟 p50 0.57 s、p90 1.92 s；新做法 93 次请求、11 次超时（12%），p50 0.51 s、p90 0.72 s。输入 token 为 649k 对 502k，花费 $0.027 对 $0.021。
- **完成判断：** 现有做法有 12 次选了 done，置信度 0.58–0.74，没有一次过门槛。新做法问了 26 次 `goal_done`：13 次本该“未完成”的（悬停之后、实时入口第二步之前）是 0.04–0.06，13 次本该“已完成”的是 0.95–0.98，两组之间没有重叠。
- **不确定性：** 每格只有 5–10 个有效样本。“无网络故障时两边都 100%”的 95% 下限只有约 57–72%。“新做法 13/13 能自己判完成，现有 0/12”这个差别区间不重叠（13/13 的 95% 下限 77%，0/12 的上限 24%），但也只限这两个夹具。**两个夹具都已在多轮开发中见过，而且我在第一轮冒烟后调过一次组合规则（见下文）。它们是回归集，不是留出集，不能证明通用能力。**

## 为什么新做法更好（机制）

对照上一轮报告整理的原因，结合本轮逐次记录：

1. **把“做什么”和“对谁做”拆开，概率就不会被元操作分走。** 现有做法把 click、hover、reobserve、done、handoff、select_scope 等选项放进同一个 Choice，最终置信度取操作概率和目标概率的较小值。本轮现有臂点击置信度 0.90–0.97，差的那部分就是被这些选项分走的。新做法的 `target` 选项只有“观察到的控件 + none”，22 次点击全部是 1.00。
2. **完成判断单独问，而且只看代码写的事实。** 现有做法里，done 和“下一步做什么”混在一个问题里，还要对照整页文本和 8 行历史，结果 done 最高只有 0.74。新做法用一个 Noul：`actions_done`（代码写的执行事实，比如“点击了 menuitem "Settings" 一次，浏览器确认已送达”）是否完成了 `request.task`。答案明显分成两组：0.04–0.06 和 0.95–0.98。
3. **状态只发问题需要的内容。** 不发页面正文、标签页列表，也不发写成提醒的历史，只发任务原话、URL、当前分区名、控件清单（每个控件一行），以及做过动作之后的 `actions_done`。这对应官方 State 页和 jev-1.13 失败模式 #5。S5 请求因此从 5 KB 降到 2 KB。
4. **结构规则交给代码。** 悬停只用来展开菜单；读完所有分区才能说“没有”；同一个控件不点第二次；高风险写入不自动点。这些原来写在给 Jev 的长段说明里，现在都由代码执行。S6N 的差别就来自这里：现有做法在还有分区没读时由 Jev 选择交回（这次答案碰巧对，但页面更长时会误判）；新做法由代码决定继续读。

## 现有接入对照官方指南

行号以基线 `fm/bys-jev-fix-r1`（`4abe606`）为准。main 上 `browser-decision-model.ts` 的长指令在第 68 行，内容相同。

| 位置 | 问什么 / 发什么 | 符合的指南 | 违反的指南 |
|---|---|---|---|
| `agent/src/browser-decision-model.ts:50` `operation` Choice | “Choose the next operation to advance the user goal and ALL constraints…”，后面跟十几条规则，约 1,400 字符。选项是 14 种操作，每种的说明也夹着规则，比如 hover 的说明写着 “prefer it over click, done, handoff or reobserve” | 只能从给定选项里选，不能生成（Choice） | How to build：“System One is for software, not agents… does not choose its own next action”。Primitives：好问题是“一秒钟能下的判断”，反例正是 “determine the best course of action”。把几个判断藏在一个问题里（Decompose the questions）。jaggedness #1 字面理解（规则写成长段 prose）、#7 指令与选项说明不一致（选项说明里夹着命令） |
| 同文件 `:54` `<op>_target` Choice | “Assuming the next operation is X, select its compatible candidate…”，选项说明直接用候选 label，例如 “Hover generic Account to reveal hover-only controls…, then reobserve before clicking”；有 none 选项 | 推测式扇出（Speculative fan-out）；有 none 选项（Choice 页） | jaggedness #4 间接层级（“假设下一步是 X”）；选项说明写的是指令，不是对选项的描述 |
| 同文件 `:58` state | goal（实时入口是 `{userTask, localGoal}` 的 JSON 字符串）、页面正文和可视正文、全部控件的完整字段、全部标签页、材料、最近 8 行历史 | 有结构的 JSON | State 页和 How to build 的 “Include only the context relevant”；jaggedness #5 大量无关状态（S6 请求 37 KB）。历史是写给执行者的提醒，不是事实。上一轮测到悬停回执里一句“必须用新观察再选点击目标”，就让 reobserve 升到 0.16 |
| 同文件 `:135` 置信度 | `min(operation.confidence, target.confidence)` | Confidence 页：代码按置信度路由 | 它门控的是一个宽泛问题的分布。操作选项越多，这个数越低，与选对与否无关 |
| `agent/src/browser-decision-loop.ts:176–700` | 代码掌控循环、执行、守卫，写入不重放；低置信度不再写成“没找到”（上一轮补丁） | 流程和副作用放在代码里 | 循环往哪走由 Jev 选的元操作决定（continue_read、select_scope、wait、reobserve、done、handoff），等于让模型驾驶循环。“悬停后要重新观察”这类规则写成文字告诉 Jev，而不是由代码直接执行 |
| `agent/src/browser-action-selection.ts:342` 候选生成 | 代码从观察结果生成候选，对应 value extraction cookbook 的“代码找候选、模型挑”；按预算裁剪；`goalConcernsBrowserTabs` 是代码规则 | 与 pre-parsed value extraction 做法一致 | 每个控件都生成 click 和 hover 两个候选，选项数翻倍 |
| `agent/src/realtime-browser-judge.ts:52` | 与循环用同一个 `decideBrowserCandidate`；goal 是 `{userTask, localGoal}`，靠指令解释“userTask 优先” | — | 同第一行；另加一层间接（jaggedness #4） |
| 其他 Jev 调用（不在本轮范围） | `fast-task.ts:196–213`、`display-fast-path.ts:12–14`：窄 Noul/Choice，符合指南。`goal-evidence-judge.ts` 的 `condition` 阶段：一条约 1,300 字符的指令 | — | `condition` 阶段有同样的“长指令塞规则”问题，可作为下一个改造对象 |

## 新的提问模板（由代码按情况组合）

原则：每看到一次页面，发**一次**请求。所有问题共用同一份小状态，并行求值，代码只取当前情况用得上的答案（Speculative fan-out）。需要上一个答案才能构造下一份状态时，才发第二次请求：点击之后要读新页面，续读时要读新分区。

**状态（所有模板共用）：**

| 字段 | 内容 | 为什么发 |
|---|---|---|
| `request.task`（循环）或 `request.step` + `request.whole_task`（实时入口） | 用户原话，或语音层给出的当前一步 | 每个问题都要对照它判断；用反引号路径直接指向它，避免间接（How to build “reference a nested value”） |
| `page.url`、`page.part_shown` | 当前 URL 和当前分区名 | 帮助区分分区；不发页面正文 |
| `controls` | `{c1: 'menuitem "Settings" in …', …}`，只含可点击的控件，每个一行（角色、名字、所在分区、状态） | Choice 的选项和 Noul 的判断对象；这些候选由代码从观察结果中找出（pre-parsed extraction 做法） |
| `actions_done`（仅在执行过动作后） | 代码写的事实，例如“点击了 menuitem "Settings" 一次，浏览器确认已送达”“悬停在 generic "Account" 上，现在显示 menuitem "Settings"、menuitem "Forbidden"” | 完成判断的唯一依据；只写发生了什么，不写对执行者的提醒 |

**问题：**

| id | 类型 | 何时问 | 问题原文（节选） | 代码怎么用 |
|---|---|---|---|---|
| `target` | Choice：各控件（每个选项带一行描述）+ `none` | 每次 | “Which control in `controls` is the one `request.task` asks to click, press or select?”，另附 `not_the_target`：“A menu, dropdown or section that only has to be opened to reach that control.” | 选中某个控件、置信度 ≥ 0.85、`target_listed` ≥ 0.5、没点过、`risky` < 0.5 时点击。选中但置信度不足：交回 `low_confidence`，不执行 |
| `target_listed` | Noul | 每次 | “Is the control that `request.task` asks to click, press or select listed in `controls`?” | 低于 0.5 时不采信 `target`，转去展开菜单或续读。官方理由：Choice 的概率是相对的，总有一个选项排第一；Noul 是绝对判断（Line-by-line search、Skill suggestion、jaggedness #8） |
| `opener` | Choice：各控件 + `none` | 每次 | “Which control … is the menu, dropdown or section that `request.task` says to open, or that has to be opened to reach the control it asks to click?” | 置信度 ≥ 0.85 且没悬停过时悬停。悬停后由代码重新观察，把新出现的控件写进 `actions_done` |
| `part` | Choice：未读的分区 | 页面有两个以上未读分区时 | “Which part of the page most likely contains the control …?” | 只用来决定续读顺序，不设门槛。读哪一段由代码执行；读完所有分区仍没找到才说 `no_match` |
| `goal_done` | Noul，带 true/false 两侧说明 | 执行过动作之后 | “Do the actions in `actions_done` complete everything `request.task` asks for?” | ≥ 0.85 时循环以 `needs_verification` 结束 |
| `risky_<id>` | 每个控件一个 Noul | 每次（推测式） | “Would clicking `controls.c12` delete, pay, buy, send, publish or submit something, or make another change that is hard to undo?” | 被选中的目标 ≥ 0.5 时不自动点击，交回 `permission_required`，请用户确认 |

**代码负责的结构规则**（`composeLocate`，原型在 `agent/src/browser-question-loop.ts`）。顺序是：先看是否已完成；再看能否点击有把握的目标；目标和 `opener` 指向同一个还没悬停过的控件时，先悬停；接着看能否悬停有把握的 `opener`；目标在但不确定时交回；否则续读，先读 `nextCursor`，再按 `part` 的概率顺序读分区；全部读完就 `no_match`。另外两条硬规则：同一控件在一个循环里不点第二次；悬停只用来展开。

**不交给 Jev 的事：** 下一步规划、生成要填写的文字、数字和日期计算、“读哪一段”的执行、是否重试，都留给代码或主模型。

**本原型没覆盖、产品版要补的模板**（按同一思路设计，尚未实测）：

- 填写：每个字段各用一个 Choice，在“已提供的材料 + none”中选，选项来自代码（pre-parsed extraction）；需要生成的文字交给主模型。
- 下拉选择：一个 Choice，在观察到的选项中选。
- 开关的目标状态：Noul，判断“请求是否要求它处于开启状态”，再由代码对比当前状态。
- 切换标签页：只在 `goalConcernsBrowserTabs` 为真时，问一个 Choice，在各标签页 + none 中选。
- 按回车提交搜索：代码规则。

## 阈值：维持 0.85

官方 Confidence 页和 Confidence-gated routing 页都说，门槛应随风险调整，只读动作可以低一些。但本轮数据没有给出降低的理由：新做法里，悬停前 `opener` 的置信度 0.98–1.00，点击时 `target` 22/22 为 1.00，完成判断的“是”一组 0.95–0.98。0.85 两边都有很大余量。所以不提议改路由，0.85 继续作为动作门槛，`goal_done` 也用 0.85。风险判断另设 0.5 的拦截线，这是一条新的、方向相反的门：宁可多问用户一次，也不漏掉高风险写入（依据 Noul 页“漏掉真阳性代价高时把门槛放低”）。

## 两个夹具测不到的模板：离线检查

标签在调用之前手写。每个例子单独发一次请求，状态只含一个控件或一段 `actions_done`，问题原文和原型完全一致。这不是在真实页面上的检查，只用来看方向。

- **`risky_write`：** 6 个高风险控件为 0.74–0.94（删除账号 0.94、发布 0.93、付款 0.87、下单 0.87、发送 0.83、取消订阅 0.74）；7 个普通控件为 0.02–0.28（Late-Target 0.28、Early-3 0.22，其余 ≤ 0.09）。按 0.5 分开，13/13 正确。**“Save profile”为 0.60，会被拦下要求确认**，原因是问题里写了 “submit”。如果用户明确要求“保存”，这会多一次确认，产品版需要决定措辞（见建议）。
- **`goal_done`：** 10 个例子按 0.85 判定全对。“已完成”一组 0.89–0.97，“未完成”一组 0.02–0.09；例外是“要点 Late-Target、实际点了 Late-3”，只有 0.49。按 0.85 仍判为未完成，但这不是一个有把握的“否”。所以“点的是不是用户要的那个控件”应该由代码核对（代码知道点了哪个 ref），不能只靠这个 Noul。

## 过程记录与原型缺陷（诚实说明）

- **调过一次组合规则。** 第一轮冒烟中，S5 实时入口第一步是 “Open the Account menu”：`opener` 以 1.00 选中 Account，`target` 以 0.77 对 0.23 在 Account 和 none 之间犹豫（Jev 按字面理解，把“打开”也读成了“点它”）。我加了一条代码规则：目标和 `opener` 是同一个还没悬停过的控件时，先悬停。之后冻结代码（`32f5103`）再跑正式批次。**问题措辞一次也没有改过。** 这次调整是看了 S5 之后做的，所以 S5 的结果是样本内的。
- **分区标签噪声。** 观察层的 `scopeLabel` 会出现 “none” “generic”，控件描述因此变成 `in none`，S5 上还多出一个没有意义的 `part` 问题。它不影响本轮结果，产品版应当过滤。
- **重复读同一批控件。** S6N 的第二个分区和整页视图是同样的 100 个按钮，新做法多读了一次（多一次请求，约 0.4 s）。代码应当跳过控件集合已经读过的分区。
- **S6 单次请求仍有 93 个问题、28 KB。** 大头是每个控件一个 `risky` Noul，外加三个各有 90 多个选项的 Choice。花费和延迟都不成问题（p90 0.82 s），但要减也很容易：只对 `target` 概率前几名问风险。
- **网络。** 本轮开始前用 curl 探测 8 次，4 次 TLS 握手用了 2–5 秒，其中 1 次超时。和上一轮看到的是同一个问题。两臂的传输条件完全一样，所以对比仍然公平，但它让有效样本少了约三分之一。

## 建议

1. **按这个方向改产品。** 保持 `runBrowserDecisionLoop` 和实时判断入口对外的返回类型不变（`BrowserLoopOutcome`，以及 suggestion / needs_context / uncertain），把内部换成“窄问题 + 代码组合”。同时修掉上面三处原型缺陷，补上填写、下拉、开关、切换标签页这几类模板。风险措辞建议去掉 “submit”，或者加一个 Noul：“请求是否明确要求点这个控件”。用户明确要求的可逆写入按普通点击处理，删除、付款、发送、发布仍然要确认。
2. **单独修传输层（与提问设计无关，但它现在是最大的失败来源）。** 只对连接层失败重试一次；Jev 是只读判断，重试没有副作用。再把 keep-alive 时间调长，减少重新握手。两次评估都显示约 12–16% 的请求死在 TLS 握手上。
3. **完整 30 轮验收应该包括：**
   - **任务：** S5 两个入口、S6、S6N，加上 `scripts/acceptance/jev-compare/fixtures.mts` 里已经写好、从未拿来调过的 8 个留出任务 H1–H8（覆盖第二种悬停菜单、分区里的目标、开关、下拉加保存、标签切换等），再加多标签条件（`--extra-tabs=3`）。
   - **对照：** 现有做法对比新做法，每格 30 轮，两臂轮流，一次只开一个 Chrome。
   - **端到端：** 再跑 E5、E6、E6N，比较分工和单独两种方式，看完成判断能不能真正让端到端变快。结果取决于下面的船长决定：可以按“允许直接交付”和“不允许”各跑一组。
   - **通过门槛：**
     - 在无网络故障的运行里，新做法每个任务的成功率不低于现有做法；S5、S6 和留出任务合计 ≥ 90%。
     - 错误写入 0。
     - 误报完成（页面计数器说没完成、循环却给出 `needs_verification`）0。
     - 成功的运行里，≥ 90% 由循环自己以 `needs_verification` 结束。
     - Jev 单次请求 p90 ≤ 1 s。
     - 网络故障单独统计，不算进成功率。
   - 留出任务第一次跑出的结果就是验收结果；如果中途调了规则，之后的数据要重新标为样本内。

## 需要船长决定的一件事

**循环点击之后，Jev 判定“已完成”（`goal_done` ≥ 0.85），执行器也确认点击已送达、目标不是高风险写入时，能不能直接告诉用户“完成了”，不再让主模型复核一遍？**

- A. 不能。只要页面被写过，就一律交给主模型复核。这是现状：安全，但前两轮测到端到端要慢 20–35 秒。
- B. 能。低风险写入满足上述条件就直接交付；删除、付款、发送、发布仍然走确认。
- C.（推荐）原则上同意 B，但先在 30 轮验收里确认“误报完成 = 0”，再打开这个开关。

这个决定不影响先改提问设计和跑 30 轮，只影响端到端的速度能省下多少。

## 证据

### 读过的官方文档（2026-09-26 抓取的 Markdown 原文）

- System One：https://docs.typesafe.ai/concepts/system-one.md
- How to build with TypeSafe：https://docs.typesafe.ai/concepts/how-to-build-with-system-one.md（“software, not agents”、Decompose the questions、Include only the context relevant、Ask a lot of questions、Route on uncertainty）
- State：https://docs.typesafe.ai/concepts/state.md
- Primitives：https://docs.typesafe.ai/primitives.md（一个问题只问一个快速判断；独立问题放同一请求；有依赖时才发第二次请求）
- Choice：https://docs.typesafe.ai/primitives/choice.md（逐选项描述、none 选项、最多 255 个选项）
- Noul：https://docs.typesafe.ai/primitives/noul.md（没有单独的 confidence；门槛按代价高低设定）
- Score：https://docs.typesafe.ai/primitives/score.md（本设计未使用）
- Advanced: structure：https://docs.typesafe.ai/primitives/advanced.md
- Confidence：https://docs.typesafe.ai/confidence.md（门槛随风险调整）
- Confidence-gated routing：https://docs.typesafe.ai/patterns/confidence-routing.md
- Speculative fan-out：https://docs.typesafe.ai/patterns/fan-out.md
- Jev 1.13 jaggedness：https://docs.typesafe.ai/model-jaggedness/jev-1.13.md（#1 字面理解、#4 间接层级、#5 大量无关状态、#7 指令与选项说明不一致、#8 Choice 与 Noul 不能互换）
- Function calling：https://docs.typesafe.ai/cookbooks/function_calling.md（先选函数，再逐个参数问；整体置信度取最低项）
- Skill suggestion：https://docs.typesafe.ai/cookbooks/skill_suggestion.md（先用 Choice 排序，再用 Noul 判断“要不要”）
- Line-by-line search：https://docs.typesafe.ai/cookbooks/semantic_find.md（Choice 指出是哪一行，Noul 判断“有没有”）
- Pre-parsed value extraction：https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook.md（代码找候选，Jev 挑，none 兜底）
- 另读了 Models（上下文 64k / 32k）、API（Noul 返回 `noul` 字段）和项目的 `.agents/skills/typesafe-ai/SKILL.md`

### 命令（都在 worktree 根目录执行）

```bash
# 正式批次：4 个任务 × 2 臂 × 10 轮，两臂轮流，每次运行新起一个隔离无头 Chrome
npx tsx scripts/acceptance/jev-compare/run.mts --headless --tasks=S5rt,S5loop,S6,S6N --arms=jev,q --rounds=10 --name=design-r1
python3 out/jev-design/analyze.py design-r1
# 冒烟（不计入统计）：smoke-q1（4 次，组合规则修改前）、smoke-q2（4 次，修改后）
# 离线模板检查（24 次请求，标签在调用前写好）
npx tsx out/jev-design/template-probe.mts
```

### 原型与原始数据（在 scratch worktree 里，拆除后删除）

- `agent/src/browser-question-loop.ts`（新文件，416 行）：`askJev`（与现有做法相同：同一 endpoint、固定模型版本、3 秒上限、不重试）、`buildLocateRequest`（上面的模板）、`composeLocate`（代码组合规则）、`runQuestionLoop`（执行器调用和守卫与现有循环相同）、`judgeRealtimeWithQuestions`。
- `scripts/acceptance/jev-compare/run.mts`：只加了 `q` 臂和逐次请求记录，现有臂的行为不变。
- `out/jev-compare/design-r1/results.jsonl`（80 行），`runs/*.json` 里有每次请求的完整 body 和全部答案。
- `out/jev-design/template-probe.json`、`out/jev-design/docs/`（抓下来的文档原文）。
- 没有改动任何测试、夹具或断言；没有推送，没有开 PR；没有碰产品分支。
- 另一个 lane 的无头 Chrome（real-path，PID 49669，来自用户主目录的 checkout）在本轮期间一直在跑，不是我启动的，我没有动它。

### 凭据与花费

Jev 只通过项目现有的 `typesafe-auth` 读取凭据，从未打印、复制或移动密钥。本轮 Jev 真实请求：正式批次 178 次，冒烟约 20 次，离线检查 24 次，合计约 $0.05。没有调用主模型。
