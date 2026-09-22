# 当前状态

2026-09-22 18:10 Computer Use 真实路径修复后复测：J3 PASS、J4 前半段（改口继承/来源重绑定/末句捕获）PASS、修订后改写与检查点恢复入口未过。复测同 14:07 轮环境（日常 Chrome+真实扩展+已登录 Flomo+MiniMax-M3），18:01:51 重发 J3 原句（2m0s 交付，独立读回草稿两行正确、未保存；目标证据复核链抓出两行结构问题并自纠），18:04:47 发 J4 改口——requirement-1/2 正确并列、捕获到同一 Note 末句，但 fill 被「该字段已有成功回执（来自重启前）」闸门拒绝且 `confirm_blocked_write` 显示「不是可恢复的表单状态」，模型清空重试仍被拒×3，部分完成；复测后草稿被清空（如实记录）。J5 接管请求 4 次未确认（含工具链点击瑕疵，真人路径未复核，不判故障不断言通过）。已随本轮 commit/push 入库（未发布）。另发现：保留 tab 丢失+伴随进程重启后，「继续原任务」无后端事件（run 已 dispose），检查点续接为死路。期间经用户批准扩充验收工具链（不改产品逻辑）：Cua Driver daemon 后台可信按键（Accessibility/Screen Recording 已授权）+ manifest `_execute_action`（Command+Shift+Y）+ `setPanelBehavior`，侧栏可全程后台打开；CDP 合成按键触发不了浏览器级命令已实测。typecheck/architecture/build 通过，重载后 background.js `7d12fa8b…`。[复测逐环节证据](evals/20260922-computer-use-product-path.md#修复后复测2026-09-22-18011810kimi-code-会话续作)。下一步待用户裁决：① 修订后改写路径（新 revision 使既有回执失效或可确认）是否立项；② 检查点续接入口重建是否立项；③ 默认模型是否评估换 MiMo V2.6 Flash（Command Code Provider，OpenAI/Anthropic 兼容端点，$15/月起）——今日证据表明 MiniMax-M3 完成 J3 全链正常（2m0s），默认模型不是当前瓶颈；④ J5 需真人路径接管/交还复测。

2026-09-22 18:05 试用发现的三个问题已修复并验证（问题4 ASR误听经用户裁决不计）：①停任务后语音工具连坐——直连 display 帧不再附着被投毒的旧 runId（sdkId 帧族，任务迟到帧仍被拒）+ `freshDirect` 只豁免 cancelled 生命周期，未知写入等保护全保留；②建连瞬时 server error 改为有界静默重建握手（≤2 次，已有输入/耗尽仍 fatal）；③翻译瞬时中断同批重试一次、用户停止改报“已停止翻译请求（可继续）”。修前反例 8 败→修后 34/34；受影响回归 323/324（1 失败为他队在途 task 域 `untrackedWritePending` 既有问题，失败点早于本修复代码，不代改）；双端 typecheck、architecture 228 绿。**修复未加载日常**（gate 保持关闭、未 commit/push），待用户授权重载。[修复记录](evals/20260922-v22-spoken-result-shadow.md#试用后修复同日只修不加载待用户重载)、证据 `out/acceptance/post-trial-fixes/`。

2026-09-22 17:16 V2.3 受控加载已完成，**已加载、真人待验**（用户以「做完之后引导我去试用」授权）：本机 `voiceSpokenResultGate` 原值=不存在→临时置 true（源码缺省仍 false，其余配置未动，备份在 `~/.sideagent/config.json.bak-gate-*`）；`npm run build`+`npm run reload:ext` 后四项核验：新 Native PID 24385/24386（入口本仓库 main.ts，17:15）、生产 SW 自读 background.js SHA256=`ed7695b2…`=本次 dist（运行版为14:07 的 `cebbbf…`）、面板 09:15:48Z 已重连、gate 实读待开麦后以 `spoken_result_gate` 日志实证。增量已按归属分列：本链路（8.6/8.7 已复核，加载前哈希与联合验收逐一一致）+ 他队未提交并发改动（read-element/input/domops/editable-text/task-* 域，不属本票通过、未代改）。试用页「X 标签页」「Y 标签页」已在日常 Chrome 打开并完成真人试用：**用户总评「还行」，核心路径（切 X→换 Y→问 1+1）亲证无问题；T1 在日常真实链首次命中减话**（applied=capsule_only，判断早于决策 1.68s，无口头确认；gate 实读=true 由每会话 `spoken_result_gate` 日志实证）。试用中定位三处问题（不修，只记录）：①首要=停止任务后语音工具被 run/身份闸门连坐拒绝（“原任务已停止/已取消”连续执行失败×5，模型误归因为连接问题，会话内未自愈，`index.ts:1004`+task-next-step cancelled）；②重连时 provider “server error”一次（2s 自愈）；③page_translation 两次 aborted（翻译域）。gate **已恢复原值（键已删，下次开麦即关闭）**，备份保留，试用页服务已停。未 commit/push。[验收 8.8](evals/20260922-v22-spoken-result-shadow.md#88-v23-受控加载与真人试用2026-09-22已加载真人待验)。

2026-09-22 17:10 V2.3 最小联合验收已完成并停止（两场景各一次、两条独立连接；真实隔离 headless Chrome + 本地测试页 + 真实 StepFun/Jev 同链运行；文字入口非真人语音）：离线检查先跑 14/14（既有 8 + 联合 6），随后 `npx tsx scripts/acceptance/v23-joint-live.mts --headless` 退出码 0、全程 11.8s。**S1 仅切页 PASS、操作通过、减话真实命中**：判断 T0+1037ms 到达、早于 switch 批次决策 248ms，gate `capsule_only` 闭合，工具回传×2、成功胶囊事件恰 1 次、其后无续答无音频（response=2）；**S2 切页+问答 PASS、答案正确（=二）**：判定 spokenResult=0.97→`spoken_result_needed` 按需续答，241920B 音频 provider/delivered SHA256 一致。两场景生产回执均为真实读回（verified 逐项+独立双通道读取对应，起点 setup 与受测动作分列）。预算：Jev 2/2（每输入一次三问）、response 5/15、ready 406/304ms、单场景 3.4/5.6s；无重试/预热/调阈值/新增等待，cancel/error=0，源码哈希一致、日常 dist 未变、清理 PASS。脚本类型告警仅补两处准确类型声明（IsolationDiagnostics 接口、diagnose JSDoc），启动/清理行为零改动。操作通过与减话应用两项单列；胶囊只验事件链，真人收音/听感/观感 NOT_RUN；fill 未完成不阻塞。功能默认关、未改配置/未重载/未 commit/push。[验收 8.7](evals/20260922-v22-spoken-result-shadow.md#87-v23-最小联合验收真实切页与真实开口决策同链运行2026-09-22两例各一次即停)、[两例证据](../out/acceptance/v23-joint-live-1790067786067/result.json)、[离线检查](../out/acceptance/v23-joint/offline-checks.log)。

2026-09-22 16:50 V2.3 配套「切好了必须来自真实核验」已落盘（未提交、未重载、gate 默认关未动，待独立 Reviewer）：`tabs:switch` 执行/激活后一次读回浏览器事实（实际活动标签/窗口/焦点/工作目标），回执附 `verification`；分类器要求核验逐项通过才给「切好了/回弹/capsuleCanCloseAction」，旧回显、缺字段、读回失败、实际页不符、窗口未聚焦一律「结果待确认」（executed 不改写）；工具文字分述工作目标与可见结果。**修前反例 6 项全败→修后全绿**（回显当成功已固定）；最终定点 28 文件 386 例、双端 typecheck、architecture 228 项全绿。**A1 真实正例 PASS**：隔离 headless Chrome 独立双通道读取确为 B，生产回执核验事实与之对应，原宿主链产出一次「切好了」+成功资格，gate 实判 capsule_only 零续答，零模型请求，日常 dist 哈希不变（23/23 断言）。A2/A3/A4/A5 离线 PASS（真实分支重复与真人观感、真实模型减话 NOT_RUN，不把核验通过写成减话通过）。焦点/会话权限未放宽；他队在途改动保留未触碰（`isolated-extension.mts` 两处类型遗留属其票，本票该文件 diff=0）。未 commit/push/重载、未改配置。[验收 8.6](evals/20260922-v22-spoken-result-shadow.md#86-tabsswitch-执行后真实核验接线2026-09-22实现者自验待独立-reviewergate-默认关未动)、[A1 探针证据](../out/acceptance/v23-switch-verification-live-2026-09-22T08-37-15-180Z/result.json)、[反例与定点日志](../out/acceptance/v23-switch-verification)。

2026-09-22 15:44 V2.3 真实供应商小样本已跑完并停止（独立复核通过后；S1/S2/S3 各一次、各一条新连接，文字输入+回执夹具，真实 StepFun+真实 Jev，无窗口/无听感）：`realtime-spoken-result-live --headless` 退出码 0，Jev 3/3、response 10/15、全轮 18.3s 均未触上限，跑中 sourceChanged=false。**三例覆盖与交付均 PASS**：S1 判断（task/0.96/0.07，974ms）晚于切页批次决策 16ms，gate 未应用，fail-open 保守放行确认「切好了…」149760B 逐字节交付，**减话记未应用**；S2 判断保留语音（spokenResult 0.97），「切好了，一加一等于二。」答案音频 165120B 完整交付；S3 判断 363ms 及时到达且身份匹配，gate 实判 spoken_result_needed，snapshot 实调读回登录阻碍，「…要我帮你登录吗？」450240B 完整交付（模型问句，不构成新增授权）。无新增工具/音频等待。版本核对：manifest 27 项 19 项现存源码一致、6 项删除确认；NOTES/STATUS 及 session/conversation-manager（15:15）、tools/protocol（15:52，晚于跑完）为并发改动，均不属本链路，未撤销。只证明真实供应商与回执夹具配合，不证明真实浏览器核验、胶囊观感或真人听感；switch 回显、fill verified 仍未完成；功能默认关闭，未改配置/构建/重载/提交。[验收 8.5](evals/20260922-v22-spoken-result-shadow.md#85-真实小样本实跑独立复核通过后s1s3-各一次)、[证据与时间线](../out/acceptance/v23-live-sample/report.md)。

2026-09-22 14:07–14:40，用户要求主代理用 Computer Use 走日常真实路径，并明确要求先重载：双端 typecheck/build 通过，Chrome 扩展详情确认本仓库 dist，重载后新 Native 4150/4152 与面板连接。**完整资料→草稿路径 FAIL**：问答后台有正确文本但侧栏未交付；切换已开 Flomo 成功（单例 UI 40s）；一句原文跨页填写 5m20s 后失败、草稿为空，捕获材料范围与请求不符；改口“同一个 Note 的最后一句”选成了另一个 Note，来源仍被标为满足，后续填写被闸门挡住。接管/交还/中止控制生效，材料到成果续接仍未完成。语音连接检查已关闭，不认证指定口令或听感。未改产品源码/模型/配置，未保存或提交 Flomo 内容，测试任务已停止。14:07 后其他任务继续改源码，本次不声称覆盖其最终版本；新开口开关仍未设置，不能当作 V2.3 开启验收。[真实输入、页面读回、运行证据与修复顺序](evals/20260922-computer-use-product-path.md)。

历史｜2026-09-22 V2.3 请求级开口生产接线已完成机器自验（独立复核与实跑已完成，见顶部条目；本条保留写作时点状态），**默认关闭**。同一次 Jev 三问交付带 voiceId/turn/itemId/原始 inputId 的校验结果；语音宿主仅在判断已到达、请求门槛命中且当前批次全为可结束的成功胶囊时不创建续答。旧事后扣音生产代码、200ms 计时与专属状态已删除，终稿/取消/生成与播放/通知回归保留。受影响 18 文件 242 项通过，新增混合委派反例后定点 34 项通过；双端 typecheck、architecture 和新探针离线检查通过。**S1–S3 均 NOT_RUN：按本票顺序等待独立复核后再跑，不以实现者自验替代；本轮真实供应商请求为零。** 未修改用户配置、未构建/重载日常、未 commit/push；switch 回显与 fill verified 产线缺口仍未完成，不能宣布日常可启用。下一步仅独立复核。[完整验收与实际 diff](evals/20260922-v22-spoken-result-shadow.md#八v23-请求级生产接线离线完成待独立-reviewer默认关闭)。

历史｜2026-09-22 V2.2 影子实验已完成并停止（开口决策前移到用户请求，只验证可行性、不改用户可见行为）：`route-shadow.ts` 同一次 Jev 请求内新增 `spoken_result_0`（noul，假设动作成功+胶囊已显示后原要求是否仍需语音），日志增 `spokenResult`（原始 noul，缺失/非法省略不伪造 0/1）与 `requestMs`（同一次请求总耗时），lane/pageChange 口径不变，observability-only 边界保持。机器验收：route-shadow/conversation-manager/config 定点 62 例、agent typecheck、architecture 全绿（A1 单请求三问、A2 旧契约不回退、A3 新字段）。真实 Jev 9 句（每句一次不重跑，隔离日志、dailyLimit=9，未触碰日常影子目录）：**9/9 有效，方向全对**——组1 三句 0.07/0.08/0.10（全<0.5），组2/3 六句 0.78–0.97（全≥0.5），0 超时 0 无效；耗时 min 242/median 307/max 939ms（6/9 ≤397ms、8/9 ≤572ms，与工具首回执 397–572ms 仅参考非同轮对照）。裁决：语义可分、多数够早，**值得开下一票做生产接线**（本轮不选阈值、不接入）；事后扣音路径维持不进日常、200ms 不动。[验收](evals/20260922-v22-spoken-result-shadow.md)。

2026-09-22 [架构简化](architecture.md)：新 Pi 任务已收起手工执行登记，保留自动账本/目标核验及旧槽位、重启兼容；相关 154 项通过，另三项入场即失败已隔离复现，未改断言。[本轮验收](evals/20260922-automatic-result-registration.md)。未真实模型验收/提交/重载；新 A 最新独立 review 仍待完成。

历史｜2026-09-22 V2.1 S2/S3 真实供应商补证已完成并停止（各一次，S1 未重跑、原结果不变）：先离线检查探针（新测试 13/13 过，覆盖正常收尾能结束、断开无数据不假通过、超时/未覆盖退出码非零、夹具按场景 ID、缺失时间 null），随后实跑 `out/acceptance/realtime-quiet-live-1790054331574/result.json`。结果：S2、S3 均 PASS（quiescent 收尾，7 个 response、2 次 Jev、2 条连接，上限均未触，退出码 0）——S2 终稿「切好了，一加一等于二。」答案音频 24/24 交付；S3 读取 snapshot 登录阻碍并保留说明+问题，音频 60/60 交付；0 次 judge 丢弃。判断器两场景各 1 次调用均被 200ms 预算中止无判决（在飞 278/234ms），全部 `budget_expired` 降级放行——证明的是保守降级不丢答案/阻碍，**不是减话成功、判断器仍未验证**；额外扣音等待均 202ms。跑前跑后七文件哈希一致（无版本污染），未改生产源码、未调参、未重载、未提交。[验收追加](evals/20260921-voice-feedback-v2.md) 9.7.9。

历史｜2026-09-22 V2.1 真实供应商小样本验证已完成并停止（一轮一次，未重跑）：先补正 `realtime-quiet-order` 的 `resolveA` 透传（复跑 4/4），再用生产 Realtime+真实 Jev 跑三场景（文字输入、回执夹具、无窗口/无听感，证据 `out/acceptance/realtime-quiet-live-1790052810334/result.json`）。结果：S1 已执行——模型生成确认语「切好了，现在在“测试标签页”。」，Jev 1 次调用（完整终稿材料）在飞 287ms 被 200ms 预算中止无判决，**降级放行**（budget_expired, degraded，24/24 片段交付，额外扣音 201ms）——减话未成功，不能记静音成功；S2/S3 NOT_RUN（探针静默判定缺陷烧满 S1 窗口 + 供应商末次活动后 59.99s 报 `too long without operation` 断开，文字被 `text_before_ready_ignored`）；0 次误丢（本轮无 dropped+judge），听感 NOT_RUN。探针两缺陷（累计活动、-1 哨兵减法）运行后已修未重跑。未改任何生产源码，未调 200ms、未加判断器。[验收追加](evals/20260921-voice-feedback-v2.md) 9.7.8。
历史｜2026-09-22 V2.1 最小补修已落盘（未加载、未提交，交独立 Reviewer 仅复跑新增反例与受影响回归）：只补两处——跨回复保序（后轮出声前提前保守放行未判决前轮，`ordering_release` 记 degraded，不等判决、不叠加 200ms 预算、已取消前轮不复活）与确认完整文本才作判断材料（纯增量在 `response.done` 不定稿不判决，等迟到终稿或预算保守放行；迟到完整转写更新同一回复、按值幂等）。新反例 quiet-order 4 例修前 3 败/1 过、修后全过；定点 9 文件 61 例、typecheck、architecture、LSP 全绿；全量 unit 2940 例仅余已知 5 例（同上轮集合，无新增，本轮不再追查、未用 stash）。boundary/quiet-hold 各处补终稿事件输入（断言预期未改）。9.7.4 已修正 200ms 表述（限制额外扣音等待，非 response_done 发出时刻）；9.7.5 已修正整文件 stash 用词。fill/switch 缺口继续未完成，真实模型与真人 NOT_RUN。[验收](evals/20260921-voice-feedback-v2.md) 9.7.7。
历史｜2026-09-22 V2.1 复核修订已落盘（未加载、未提交，交独立 Reviewer 复跑）：只修语音出口——完整转写进权威文本状态、缺材料（无转写/迟到/超长截断）不再丢整段音频（明确取消/停声/关闭仍优先丢弃）；`response.done` 即入账放行工具输出与续答，减话判断不再阻塞工具主链；新增扣音预算（首段扣音起 200ms，本票工程预算非厂商承诺），到期/判断失败/证据不足一律保守放行并记 `degraded`，只有 `dropped+reason=judge` 才是重复确认消除。新反例 11 例修前 10 败/1 过、修后全过；受影响回归 8 文件 57 例、typecheck、architecture 全绿；全量 unit 2936 例中 5 例失败经隔离复跑证明属并发写入者在途任务域切片（撤掉本票改动仍败）。boundary/adversarial 各 1 例「无转写即丢弃」预期按本票 A2 修订并留依据。fill 正例仍只在模拟边界、switch 仍回显缺口、真实模型与真人 NOT_RUN；未重载、未提交。[V2.1 复核修订验收](evals/20260921-voice-feedback-v2.md) 第 9.7 节。
历史｜2026-09-22 V2.1 反馈边界修复已落盘（未加载、未提交，本轮自验）：证据门槛与静音范围两类边界收敛——tabs:switch/fill 成功胶囊要求回执证据（落点一致/内容核对），缺证据只显「结果待确认」且不改写执行事实；静音资格改为按话轮滚动（内部核验后的重复确认不进语音，非静音回执/失败/新任务终止资格），静音轮音频先扣住、由 Jev noul 判定是否仅重复确认，判定失败/超时/用户开口保守放行，同句问答答案与阻碍说明可听到。新增 11 例反例（修前 8 败/3 过，修后全过），V2 回归、101+62 例、typecheck、architecture 全绿；真实模型与真人 NOT_RUN，未重载。fill 成功证据的生产产线（扩展回执 verified）因并发切片在途未接线，落地前真实 fill 均显待确认（不再无据宣称已填入）。并发写入者在途 unknown-fill 读回切片（session/rpc/input/read-element 等）未被触碰。[V2.1 验收](evals/20260921-voice-feedback-v2.md) 第 9 节。
2026-09-22 第五切片 P1 已通过独立 code review（用户确认）。本轮真实 Chrome 无模型验收：B 同文档替换安全跳过通过，C snapshot-only 安全跳过通过但原 C2 未修复；A 在隔离执行钩子安装阶段 BLOCKED，未发出工具调用、不重跑，原对象有效的真实正例仍缺。模型请求为零；B/C 保留 unknown/reject/写入限制。生产代码未改，源码副本构建，日常 dist 未变；未提交/推送/重载。已清理测试进程，停止并交独立 review，未进入第六切片。[验收及原始证据](evals/20260922-realtime-unknown-fill-readback.md#真实浏览器无模型验收)。humanAcceptance 与真实模型语言验收仍 NOT_RUN。

历史｜2026-09-21 V2 执行反馈翻译层已落盘（未加载、未提交）：简单成功进右上角胶囊（一次轻微回弹，`prefers-reduced-motion` 不回弹），切标签那一轮不再语音补说成功；问答、部分成果、失败与等待确认仍走语音；VoiceService 的 running→idle 广播已删。独立复核发现并已修复「陈旧静音意图会误伤用户下一句提问」的缺陷（静音只在请求归属成立时生效；补两条回归），另修正可见页受限时的侧栏降级与落点页旧回执残留。离线定点/回归、类型、架构、构建通过；真实模型与观感未跑（NOT_RUN）。并发写入者期间工作区另有 realtime-fact-* 文件出现，本票未触碰。[V2 验收](evals/20260921-voice-feedback-v2.md)。

2026-09-21 第三切片：Realtime 直连浏览器结果保留宿主调用 ID 与执行事实，异常仍拒绝，超长结果保持有界 JSON；离线回归通过，本任务未重载。[执行事实验收](evals/20260921-realtime-execution-facts.md)。模型是否按事实发言尚未解决，本轮到此停止。

2026-09-21 22:34：V1 通知修复受控加载进日常（新 Native 40676，随载浏览器回执第二切片，范围与哈希见 [V1 验收第 7.1 节](evals/20260921-voice-notification-v1.md)）；真人 30 秒安静复测待用户，此前状态以本条为准。

2026-09-21 第二切片：浏览器回执已关联执行及成功核验的实际子调用 ID，第一切片语义保留；未重载。[调用关联验收](evals/20260921-browser-verification-evidence.md)。本轮结束，不继续第三阶段。

2026-09-21 补充：BrowserStepReceipt 已拆分执行事实与动作核验，定点及类型/架构检查通过；未加载日常版本，原 Realtime/Voice 工作保留。[语义收敛验收](evals/20260921-browser-receipt-semantics.md)。本任务结束，不继续第二阶段。

核对：2026-09-21。本轮按用户指定Waza hunt完成语音根因审计，未改产品代码或加载版本。日常仍是21:10重载版（保留多轮修复和Jev工具）；21:15真人反馈复现普通状态通知反复重发，另确认通知批次覆盖问题。API基本连通正确，Realtime口语与正式结果核验仍分叉；历史音色问题另有服务输出对照。[根因审计与完整架构](evals/20260921-voice-root-cause-audit.md)。恢复基线94b1782，产品改动仍未提交。

## 当前结论

开发预览版。**真实 B站→Flomo 任务暴露了新的 P0：动作成功被当成用户目标满足，已读到的评论没有作为原文材料复用。目标与原文证据链已修正，并通过真实模型与隔离无头路径；日常真账号和真人语音尚未验收。** [目标与证据链验收](evals/20260921-goal-evidence-contract.md)记录本次范围与失败。9/20 的切标签、工具结果等待和播报专项曾通过并加载，不能据此认定跨页复制已修复。原克隆音色漂移已留档，用户决定改用已试听通过的官方青春少女音色。 [本轮证据](evals/20260920-voice-repair.md)包含修前失败、全栈修复、真实回归、加载与音色最小复现，不代表正式发布或整体体验已通过。

| 范围 | 核对结果 | 依据与边界 |
|---|---|---|
| 目标与原文证据链 | 源码与隔离验收通过，已于9/21随短路径加载供试用 | 原文逐字符跨页复制、不同编辑器、指令型正文、目标交付与侧栏一致性通过；改口/恢复不清除未知写入锁。证据见本次验收，不外推正式发布 |
| 代码 | `main@94b1782` 已保存前序工作；其上是Realtime直连工具试用改动 | 本轮 Git 实查。HEAD 不代表全部当前源码，源码不等于正在运行的版本 |
| 日常语音 | StepAudio 3 Realtime，9/21 改为官方青春少女 qingchunshaonv | [迁移](evals/20260920-realtime3-daily.md)、[试用加载](evals/20260920-general-browser-trial.md)。原克隆音色已停用；官方音色四轮经用户确认音色一致，见[对照与采用](evals/20260921-official-demo-voice.md) |
| 通用浏览器循环 | 本机 `generalBrowserLoop=true`，已有日常加载记录 | [试用](evals/20260920-general-browser-trial.md)。源码缺省关闭与本机已开启是两个事实；陌生任务质量、速度评测未完成 |
| 模型与显示判断 | 17:27 Native 启动日志模型为 `opencode-go/deepseek-flash`；本次未改模型配置 | [加载证据](evals/20260921-resume-daily-load.md)；已有会话可保存不同模型，不代表所有请求走同一模型 |
| 本轮日常修复 | 公共标签候选、结果登记/播报一致性、工具回传与播放队列修复已加载 | [修复验收](evals/20260920-voice-repair.md)：切标签/纠正/填写及实际结果播放通过；新 Native、浏览器运行资源和 Realtime 3 ready 已核对。最新真人体验待用户 |

## 需要解决的问题

通知调度 V1 已修并加载：无 deliveryId 普通通知重复发送与批次覆盖 creatingNotice 均已修复，22:33 构建重载、22:34 新 Native（40676，入口本仓库 agent/src/main.ts，面板已连接，模型未变）进入日常宿主；真人 30 秒安静复测待用户。[V1 验收](evals/20260921-voice-notification-v1.md) 第 7 节含加载证据与复测步骤。另有评论区要求未产生滚动工具调用。[21:15日志诊断](evals/20260921-2115-voice-notice-loop.md)。

| 问题 | 已有证据 | 尚缺什么 |
|---|---|---|
| 9/21 14:42 语音与 14:44 圈词试用 | [日志回溯](evals/20260921-1441-log-review.md)确认原文预算与完整性要求冲突、圈注取证不足、部分交付正文与未核验状态不一致；语音 response 竞争和并发 attach 路径有离线反例 | 五项修复已通过定点检查并于17:27加载；真人听感与圈注效果待试用。[加载证据](evals/20260921-resume-daily-load.md) |
| 语音/文字入口的选道裁决 | [路由对照实验](evals/20260921-routing-experiment.md)：52 句可比语音里 Jev 判对 47，旧分类器 14/24、Realtime 3 12/28；225 条已派任务里 78 条不需任务引擎 | 语音影子已记录；真实侧栏文字入口漏记，修复已落盘未加载。用户已确认普通问答与页面执行分流方向，当前暂停实现、先完成子代理协作调研 |
| 原克隆音色漂移（留档，暂停排查） | 用户确认原克隆音色跨轮换人，官方青春少女只有正常语调变化 | 已采用官方音色继续开发；不引入 TTS、不再阻塞其他任务。[记录](evals/20260921-official-demo-voice.md) |
| 通用循环覆盖与体验 | 已观察标签页现可由 Jev 直接选择并核验；三轮判停→活动页读回约 1.4–2.7 秒，原链约 6 秒 | 小样本不代表整体提速；陌生任务与真人自然使用仍需验收，已曝光案例只作回归 |
| 长任务可靠性 | 多页研究、换页恢复、刷新恢复、排队恢复有失败记录；旧检查点专项另有通过 | 四项失败的后续闭环、P0 完整门槛。专项通过不能拼成全套通过；见[复核修复](evals/20260919-product-review-repair.md)及[整理前记录](history/20260920-status-snapshot.md) |
| 技能复用与改口 | [技能集成](evals/20260919-skill-loop-integration.md)有保存后复用实测；仍记录匹配超时、短句漏学、改口慢 | 日常覆盖与失败修复，不能用一次零模型复用推断首次任务普遍加速 |

## 原票组与发布边界

T01/T02/T05/T06 有局部修复、独立代码复核或专项验证，外部最终裁决仍未齐；T03 缺真人理解检查；T04 保留原轮 ACCEPTED。T07/T08 在本环境暂停，外部进度未核实。来源：[裁决同步](evals/20260919-product-review-status-sync.md)、[后续修复](evals/20260919-product-review-repair.md)。旧票组不会因本次整理自动恢复。

当前材料不足以认定正式发布通过。本轮已加载日常，未提交、推送或发布；工程与真实专项通过不等于发布门槛通过。

## 下一步

V2.3 请求级开口已完成独立复核与真实小样本三例（见顶部条目与[验收 8.5](evals/20260922-v22-spoken-result-shadow.md#85-真实小样本实跑独立复核通过后s1s3-各一次)）：覆盖与交付三例 PASS，但**减话能力未被证明**（S1 判断晚 16ms 未应用、保守放行；唯一及时的 S3 判定 spoken_result_needed）。下一步待用户裁决：是否继续验证 capsule-only 减话（提高判断及时性或再取样本），以及 switch 回显、fill verified 产线闭环。fill 成功证据需扩展回执补写入后读回后再验证真实「已填入」；switch 回执仍需回读实际活动页。200ms 与事后扣音不进日常、本票不自行调参；此前 V2.1/V2.2 证据保留、不与本轮拼记。上一轮 V1 真人 30 秒安静复测仍待用户（[V1 验收](evals/20260921-voice-notification-v1.md) 第 7.2 节）。本轮不自动 commit、不 push、不重载、不扩展人格系统、不用 stash/reset 撤换共享源码。

[多轮修复](evals/20260921-realtime-multiturn-repair.md)仍保留：scroll/hover审计误判已修，真实未知写入保留只读核查和原run，历史无逐项证据的异常不自动清锁。最初直连范围见[接入记录](evals/20260921-realtime-direct-tools.md)。
