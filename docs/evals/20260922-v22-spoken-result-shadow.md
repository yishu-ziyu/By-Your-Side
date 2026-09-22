# V2.2 影子实验：开口决策前移到用户请求（spoken_result_0）

日期 2026-09-22。裁决背景：V2.1 真实供应商小样本（[9.7.8](20260921-voice-feedback-v2.md)、[9.7.9](20260921-voice-feedback-v2.md)）显示 S1/S2/S3 的事后 Jev 扣音判断分别在飞 287/278/234ms，均被 200ms 预算中止，3 次调用 0 判决 0 静音，每个有音频场景额外等待 201–202ms，而 S2 答案与 S3 阻碍靠保守降级完整交付。因此本轮裁决：事后扣音路径不进日常版本、不提高 200ms、不再优化事后判断；保留胶囊/反馈事实/通知调度/安全修复；**本票只验证「请求开始时预判是否需要语音」是否可行，不改变任何用户可见行为**。

## 一、第三个判断的完整定义

在现有 `routeQuestions()` 的**同一次 HTTP 请求**内新增（`agent/src/route-shadow.ts`），与 lane_0、pagechange_0 并列：

```json
"spoken_result_0": {
  "type": "noul",
  "instructions": "Assume the simple visible browser action requested in `utterances[0]` has already succeeded and the host displayed one brief confirmation capsule in the UI. Judging only the original request itself: does it still need a piece of spoken information to be satisfied?",
  "criteria": {
    "true": "The user also asked a question; asked to view, inspect, read, explain or report results; asked for page content or specific information; expects to hear remaining items, obstacles, choices or next steps; the page change plus the capsule alone cannot satisfy the original request; when unsure, choose this.",
    "false": "The user only asked for one simple page action whose result is directly visible, and after success the page change plus one capsule confirmation fully satisfies the request; there is no separate question, content request, result report, or follow-up decision."
  }
}
```

判断含义（中文原裁决）：假设用户要求的简单可见浏览器动作成功完成、且宿主已用胶囊显示一条简短确认，这条用户原要求是否仍需要一段语音信息才能被满足。**只判断用户原要求**：失败、unknown、等待确认等实际执行结果以后仍由宿主强制开口，不能由本判断静音（代码内注释同记）。criteria.true/false 与裁决文本逐条对应，含「无法确定时选择 true」的保守项；本轮未在结果出来后改动问题文本或 criteria。

## 二、数据契约

`JevResponse.answers` 增加 `spoken_result_0`；utterance 日志的 `jev` 增加：

- `spokenResult`：原始 noul 数值，仅当它是有限 number 时写入；缺失/非法（字符串、null、Infinity、空对象）**省略字段，不伪造 0 或 1**（`rawNoul()`）；
- `requestMs`：沿用本次 Jev 请求的总耗时，与既有 `ms` 同源同值（同一次计时，不是第二次计时）。

既有 `lane/confidence/probabilities/pageChange/ms/usage` 字段与口径原样保留；lane/pageChange 判据未动，历史影子数据仍可比。不新增第二个 fetch、不另设日预算、不为本字段单独重试；调用失败/超时/凭据缺失仍走原 `skipped` 路径，不抛给产品路径，不推断为「不需要语音」。RouteShadow 继续 observability-only：结果只记录，不控制语音、工具、路由或任务状态。

## 三、机器验收（A1/A2/A3）

检查命令与结果（本轮实跑）：

- `npx vitest run agent/test/route-shadow.test.ts agent/test/conversation-manager.test.ts agent/test/config.test.ts` → **3 文件 62 例全过**（route-shadow 18 例，含新增 2 例与扩展的请求形状用例）。
- `npm run typecheck -w @sideagent/agent` → 0；`npm run check:architecture` → 228 生产文件通过。

| 验收 | 证据 |
|---|---|
| A1 仍然只有一次请求 | 请求形状用例断言 fetch 恰好 1 次、body.questions 恰好 `{lane_0, pagechange_0, spoken_result_0}` 三键、`spoken_result_0.type=noul` 且含 `utterances[0]` 与 true/false criteria；真实运行另有 fetch 计数（见下）|
| A2 已有契约不回退 | disabled 零调用零写入、daily limit 按一次 utterance 请求计数（limit=1、磁盘恢复、跨天重置 3 例）、lane/pageChange 字段断言原值、失败只记 skipped 4 例、observe 不同步阻塞——原用例全部保持通过，未改断言；conversation-manager 的 4 例 shadow 用例（含磁盘落盘、disabled 零写）同轮通过 |
| A3 新字段正确记录 | 新用例：`spokenResult=0.42` 原值、`lane/pageChange` 不回退、`requestMs===ms`（同一次计时）、单次 fetch；缺失/`'1'`/null/Infinity/空对象五种非法输入均断言**记录里没有 spokenResult 键**（不伪造 0/1），lane/pageChange/requestMs 照常 |

真实运行的 A1 现场证据：`fetchProbe.calls = 9`（恰 9 句 9 次），9 次请求的 questions 键全部为 `[lane_0, pagechange_0, spoken_result_0]`——没有先路由再单独补一次语音判断的调用。

## 四、真实 Jev 9 句结果（每句一次，不重跑）

不调 StepFun、不跑浏览器、不生成音频；真实 Jev（`jev-1.13.0`，RouteShadow 原生端点），channel=voice、previous=[]、taskRunning=unknown；日志写入本目录隔离 `shadow-log/`（`dailyLimit=9` 硬上限），**未触碰 `~/.sideagent/route-shadow` 日常影子数据与日预算**（该目录 9/21 后未再写入）。证据：`out/acceptance/route-shadow-spoken-result-1790055509020/result.json`。

| # | 组 | 原文 | lane | pageChange | **spokenResult（原始 noul）** | requestMs | 预期 | 方向 |
|---|---|---|---|---|---|---|---|---|
| 1 | 1 | 切到测试标签页。 | task | 0.97 | **0.08** | 939 | false(<0.5) | ✓ |
| 2 | 1 | 帮我换到测试标签页。 | task | 0.97 | **0.07** | 255 | false(<0.5) | ✓ |
| 3 | 1 | 去测试标签页。 | task | 0.94 | **0.10** | 477 | false(<0.5) | ✓ |
| 4 | 2 | 切到测试标签页，顺便告诉我一加一等于几。 | task | 0.94 | **0.97** | 285 | true(≥0.5) | ✓ |
| 5 | 2 | 切过去，然后告诉我一加一是多少。 | answer | 0.65 | **0.96** | 314 | true(≥0.5) | ✓ |
| 6 | 2 | 换到测试标签页，再告诉我现在有几个标签页。 | task | 0.90 | **0.96** | 262 | true(≥0.5) | ✓ |
| 7 | 3 | 切到测试标签页，看看页面还需要什么。 | task | 0.89 | **0.78** | 307 | true(≥0.5) | ✓ |
| 8 | 3 | 切过去检查一下还有什么需要我处理，并告诉我。 | task | 0.42 | **0.95** | 242 | true(≥0.5) | ✓ |
| 9 | 3 | 打开测试页，看看是不是需要登录。 | task | 0.91 | **0.87** | 447 | true(≥0.5) | ✓ |

9/9 取得有效 utterance 记录，0 超时 0 无效 0 skipped；lane/pageChange 同请求一并记录（lane 判据未改；第 5 句 lane=answer 属既有选道判断的观察，不在本票裁决范围）。结果未用于修改问题文本、criteria 或阈值后重跑混算——本轮一次成型。

## 五、耗时分布（同一次三问请求的总耗时）

**min 242ms / median 307ms / max 939ms（n=9）**；排序后 242, 255, 262, 285, 307, 314, 447, 477, 939——6/9 ≤397ms，8/9 ≤572ms，仅首句 939ms（冷启动样本）。参考已有真实工具首回执 397–572ms 样本：**非同轮严格对照，仅作量级参考**；不因速度阻塞任何产品行为（本轮无任何产品行为依赖此结果）。

## 六、结果裁决

1. **语义是否可分：是。** 第一组三句全部低于 0.5（0.07–0.10）；第二、三组六句全部 ≥0.5（0.78–0.97）。9/9 方向正确，无一句方向错误、无响应或超时。组间空隙大（组1最大 0.10 vs 组2/3最小 0.78），0.5 阈值不贴近任何样本——但本轮**不选定生产阈值**。
2. **是否足够早：多数有机会。** median 307ms、8/9 ≤572ms，低于或落在工具首回执参考区间（397–572ms）附近的多数样本之前；1 句 939ms 晚于该参考上限。结论按参考口径给，不作同轮对照外推；速度不阻塞任何行为。

**是否值得进入生产接线：值得开下一票。** 语义方向在本样本稳定，且多数结果有机会在工具完成前返回，满足「才值得开下一票做生产接线」的门槛；本轮到此为止，不代表立即接入，也不选阈值。

若下一票实测中语义不稳定或普遍过晚，则按裁决：停止 Jev 语音输出策略、删除事后 quiet judge/扣音热路径、保留胶囊与简洁提示、不以等待换静音率。若可用：请求级结论与 voice turn/itemId 绑定；工具执行期间并行等待、绝不阻塞工具；结论未及时返回默认保留语音；**替换并删除当前事后扣音判断，不让两套机制长期并存**。

## 七、版本、凭据边界与停止点

- HEAD `94b1782`（共享工作区，79 处 dirty，含并发写入者文件；本票未 reset/stash/commit/push）。
- 本票变更=`agent/src/route-shadow.ts`（sha256 `767ace1b…9c62f0`）、`agent/test/route-shadow.test.ts`（sha256 `9d81d043…4310f7`）、新脚本 `scripts/acceptance/route-shadow-spoken-result.mts` 与本文档；运行前后哈希一致，无版本污染。**未修改** RealtimeVoiceConnection 静音行为、200ms 预算、胶囊 UI、personality、fill/switch 生产核验、日常运行版本（未重载）。
- 凭据：仅使用 Jev 凭据（存在即用，未打印）；未使用 STEPFUN_API_KEY；未连接 StepFun、未运行浏览器。
- 停止点：影子样本完成即停。不自动 commit、push、重载，不继续实现生产接线，不追加句子重跑。

## 八、V2.3 请求级生产接线（离线完成，待独立 Reviewer；默认关闭）

目标：简单可见动作确认成功且胶囊足够时，不创建工具后的语音续答；复合要求、失败、未知及判断不可用时立即正常续答。判断与执行并行，不扣音、不等 Jev。

验收沿用本票 A1–A8：单输入单次三问；成功胶囊零续答且下一问有声；复合要求答案音频交付；失败/未知强制续答；迟到/异常 fail-open；挂起判断不阻塞工具；删除旧扣音生产路径并保留通用回归；开关默认关闭且不依赖影子开关。检查者：机器定点测试、主代理实际 diff 核对；独立 Reviewer 单列，未通过前不运行真实 S1–S3。

试运行门槛固定为 task + pageChange >= 0.80 + spokenResult <= 0.20，仅允许匹配 voiceId/turn/itemId/inputId 且批次前到达的判断。执行反馈自身的资格改名 capsuleCanCloseAction，不升级执行事实。

范围：共享判断交付、Realtime 续答出口、反馈契约与相应测试。保留原始历史及 out 证据；不改 switch/fill 核验产线，不改机器配置、构建日常版本、重载、提交或推送。现场完整源码基线：out/acceptance/v23-baseline（含未提交文件），不能用 HEAD 代替。


### 8.1 最小调用链与事实边界

`最终 ASR → connection.recordUserInput（voiceId/turn/itemId/原始 inputId）` 同时启动两个分支：

- `Session.judgeRequest → shared RouteShadow.judge → 一次 Jev 三问 → 本地审计 → RequestJudgment`。生产只接收八类 lane 中的合法 lane、[0,1] 范围内的两个 noul、耗时、完成时间和原输入身份；无有效审计写入也返回 null。RouteShadow 不选阈值、不控制回复。原三问内容、模型和 4s 网络上限未变。
- `runDirectBrowserTool → PendingToolCall.inputId → 实际工具回执 → capsuleCanCloseAction`。沿用现有执行事实/成功证据门槛；字段只描述动作自身，不回答整条要求是否还需语音。`shared/protocol.ts` 原已引用共享 `ExecutionFeedback`，无需重复定义或兼容旧字段；两端类型守卫及测试改用新字段，旧字段单独出现不再通过守卫。

`maybeFlush` 先照常回传每个 function_call_output 并标记 settled，再读取同 inputId 的**已到达**判断。当前批次每项都必须是本轮同输入、executed、capsule + success、capsuleCanCloseAction=true，无失败/委派/其他结果。与请求门槛同时成立才省掉这次 response.create。list、snapshot 或无反馈观察不能单独结束；观察混在动作批次也按保守策略继续。没有跨批次滚动“静音资格”。

缓存只有请求数据，没有音频。新话轮、停声（含 ASR 尚未到）、同 item 的最终文本被修改、会话关闭均使旧判断不能控制后续。重复最终转写只请求一次。旧 ASR 显示时保留原 turn，不更新当前请求身份；缺可靠 VAD/item 绑定的 ASR 仍可显示/正常处理，但不能授权 capsule-only。

开关：`voiceSpokenResultGate` 未配置即 false，仅 VoiceService 向宿主传递；routeShadow 仅控制影子观察。gate=true / shadow=false 与二者皆 true 均走同一个共享实例、同一次请求、同一每日上限。此次没有写本机配置或日常日志目录。

### 8.2 实际 diff 与维护成本

以入场时完整工作区为基线（`main` / HEAD `94b1782`，**包含未提交与未跟踪源码**），不是只比较 HEAD。完整差异：[changes.patch](../../out/acceptance/v23-request-gate/changes.patch)；文件统计及最终哈希：[change-manifest.json](../../out/acceptance/v23-request-gate/change-manifest.json)。入场副本保留在 `out/acceptance/v23-baseline/files/`。

生产代码 7 文件合计 **+185 / -356 行，净减 171 行**（基于上述工作区基线的逐行 diff；不含测试、文档、探针或生成证据）。新增内容集中在请求身份/数据交付和一个批次政策函数；一个请求 Map 将身份、判断和失效位放在一起，另保留停声话轮，防止“停声后 ASR 才到”重新授权。删除音频缓存、定时放行与判决状态机，不新增依赖、第二个模型请求或第二套预算。

已删：生产 `realtime-quiet-judge.ts`、quietJudge 注入、QuietHold/heldQuiets、quietRequested/quietTurnSeq/quietReceipts、QUIET_HOLD_BUDGET_MS、200ms 扣音定时器、音频缓存/丢弃/放行逻辑、ordering_release 等专属状态。三个 quiet 专属测试和旧 quiet-live 探针/测试已退休；原文档与 out 证据均保留，旧源码可由入场副本核对。新探针为 `scripts/acceptance/realtime-spoken-result-live.mts`。

通用回归迁至请求级/普通 Realtime 测试：权威终稿可迟到并按值幂等、无转写音频直接交付、重复 done 单次收账、生成结束后工具不等播放、停声/取消、新话轮与旧判断隔离。原通知调度、播放记账及 direct-tools 回归沿用。

### 8.3 A1–A8 独立口径（实现者机器自验，不冒充独立复核或真实供应商）

| 标准 | 机器状态 | 可核对证据及实际范围 |
|---|---|---|
| A1 单输入单请求 | PASS（离线） | spoken-result 两个开关组合均 fetch=1、questions 恰三键；重复最终转写不增加请求；route-shadow 单实例共享日限及磁盘预算旧回归通过 |
| A2 停在胶囊 | PASS（离线）；真实供应商 NOT_RUN | 真实 ConversationManager→Session→连接出口的回执夹具：function_call_output 与胶囊各一次、工具后 create=0；list→switch 只在 list 后 create，switch 后为 0；下一句数学问题有音频。未连接供应商，不能把“无 create”当作真实供应商实测结果 |
| A3 复合要求有声 | PASS（离线）；真实供应商 NOT_RUN | spokenResult=0.21/0.97 时均续答；答案对应音频事件实际交付，不以文字事件替代 |
| A4 失败/未知开口 | PASS（离线） | not_executed、unknown、held、缺成功证据、tabId 矛盾、混合观察批次、混合已接受委派批次均保留正常续答；未升级执行事实 |
| A5 迟到/失败保守续答 | PASS（离线） | 超时、无凭据、日限、非法/越界返回；工具批次后判断到达；新轮后的旧判断与旧 ASR；同 item 文本修改；关会话后返回；停声早于 ASR。均无事后取消/扣音 |
| A6 工具零新增判断等待 | PASS（离线） | 挂起 fetch Promise，只清微任务、不推进计时器：工具执行、output 与 create 已可观察，音频同步交付；迟到判断不取消、不清音频、不重播 |
| A7 旧机制删除 | PASS | 源码扫描无五个指定标记、旧字段及 ordering_release；普通终稿、生成/播放、取消、通知回归通过 |
| A8 开关 | PASS（离线） | 配置缺失/false/错误类型均关闭；gate 关闭时两种 shadow 配置均正常续答；开启才允许动作闭合；所有开关测试使用临时文件或内存依赖，未改用户配置 |

机器证据目录：[v23-request-gate](../../out/acceptance/v23-request-gate)。

- 受影响回归：18 文件 242 项通过，`unit-results.json` / `unit.log`。之后只新增“成功胶囊 + accepted 委派同批次”反例，单独复跑 spoken-result 34 项全部通过，`spoken-result-final.json` / `.log`；未重复跑无变化的其他测试。
- `npm run typecheck`（agent + extension）通过；`npm run check:architecture` 227 个生产文件通过。
- 新真实探针的离线检查 8/8 通过，另以独立临时 tsconfig 检查探针与测试通过。覆盖无数据不算成功、response/tool 配对、无音频不算有声答案、PCM 逐字节交付一致、S3 必须实际 snapshot、超时/断连失败、fail-open 不记减话成功。
- 新停声反例与混合委派反例属于本票边界验证，不把已有未知写入读回测试的 PASS 当作真实 fill verified。全仓测试、日常构建/加载、真实浏览器与真人听感 NOT_RUN。

### 8.4 三个真实小样本与停止点

| 场景 | 状态 | 原因 |
|---|---|---|
| S1 切到测试标签页 | NOT_RUN | 用户指定先通过独立 Reviewer；尚无独立复核结论 |
| S2 切页并回答一加一 | NOT_RUN | 同上 |
| S3 切页并检查登录阻碍 | NOT_RUN | 同上 |

本轮用户选择主代理直接完成，未派子代理；机器自验不能冒充独立 Reviewer。**真实小样本阶段为 BLOCKED（等待独立复核），未发出真实 StepFun/Jev 请求**。不将此前 V2.1 或 V2.2 样本拼成本票结果。（上述为写作时点状态；独立复核通过后已于 2026-09-22 实跑 S1–S3，结果见 8.5。）

独立复核通过后，已准备的单次入口：`npx tsx scripts/acceptance/realtime-spoken-result-live.mts --headless`。按 S1/S2/S3 各一条新连接、各一次三问执行，Jev 总上限 3、response 总上限 15、ready 20s、单场景 100s、总计 6min；不重试不调阈值。原始三问审计、完成时刻与批次时刻、gate 应用、response/工具计数、continuation、终稿和逐响应 provider/delivered PCM 均单独落盘。文字输入、回执夹具、模拟播放回执，无麦克风/扬声器/真实浏览器，不声称视觉或真人听感通过。

仍未完成：switch 生产回执仍可能是请求回显；fill verified 生产证据链未闭环。此次未触碰这些产线，unknown-fill 读回不等于成功核验或写入解锁。功能默认关闭、不改本机配置、不加载日常、不 commit/push；当前停止并交独立 Reviewer，不继续 personality 或下一阶段。

### 8.5 真实小样本实跑（2026-09-22，独立复核通过后；S1–S3 各一次）

前置：独立 Reviewer 已通过 V2.3 接线与离线范围（复跑 13 文件 197/197、双端 typecheck、architecture、探针离线检查 8/8）。跑前版本核对：change-manifest 27 项逐哈希比对，19 项现存生产/测试/探针源码与 afterSha256 一致，6 项删除确认不存在，仅 NOTES/STATUS 两项因并发改动追加而不一致（文档，不影响链路）；`session.ts`/`conversation-manager.ts` 的 15:15 并发改动属任务证据/改口域且探针不加载，未撤销。跑后 `tools.ts`/`shared/protocol.ts` 于 15:52（探针 15:44:26 结束之后）被并发写入者修改，属 fill/read-element 域，不影响本轮。

命令：`npx tsx scripts/acceptance/realtime-spoken-result-live.mts --headless`，退出码 0。上限实况：Jev 3/3、response 10/15、ready 各 <0.5s、单场景 ≤5.8s 收尾、全轮 18.3s，均未触上限；stopReason=null；跑中 sourceChanged=false；跑前/跑后哈希见证据目录。时刻均以同场景输入登记为 T0，只在同场景内比较。证据：[v23-live-sample](../../out/acceptance/v23-live-sample/report.md)（含版本核对与时间线）、[探针原始 result.json](../../out/acceptance/realtime-spoken-result-live-1790063048644/result.json)。

| 场景 | 覆盖与交付 | 三问原始结果（lane/pageChange/spokenResult；requestMs；到达） | gate | 终稿与音频 | 减话 |
|---|---|---|---|---|---|
| S1 切到测试标签页 | PASS（fail-open 保守放行） | task(1.0)/0.96/0.07；974ms；T0+977ms | **未应用**：切页批次决策 T0+961ms 早于判断到达 16ms，judgment_unavailable | 「切好了，现在在“测试标签页”（https://fixture.test/doc）。」149760B PCM 逐字节一致；仅一条确认续答，无重复确认 | **未应用**（保守放行有效） |
| S2 切页并回答一加一 | PASS | task(0.98)/0.94/0.97；1888ms；T0+1889ms | 未应用（迟到 1037ms，judgment_unavailable）；判断方向保留语音（0.97≥0.20） | 「切好了，一加一等于二。」答案正确；165120B PCM 逐字节一致，答案音频完整交付 | not_expected |
| S3 切页并检查登录阻碍 | PASS | task(1.0)/0.92/0.76；363ms；T0+364ms（早于批次决策 562ms，voiceId/turn/itemId/inputId 匹配） | gate 实际判定 **spoken_result_needed**（0.76>0.20），非降级放行 | snapshot 实调，读回「请登录后继续操作。登录后可继续查看与编辑文档。」；「切到测试标签页了，页面显示"请登录后继续操作"，需要先登录才能查看和编辑文档。要我帮你登录吗？」450240B PCM 逐字节一致 | not_expected |

- 工具输出、续答创建与音频：三场景 function_call_output 发出与批次决策同毫秒、续答 CREATE 与决策同毫秒，判断挂起/迟到未阻塞工具或音频；**无新增工具/音频等待**。
- 「要我帮你登录吗？」为模型实际问句，**不构成新增授权或能力证明**。
- 本轮只证明真实供应商（StepFun Realtime + Jev）与浏览器回执夹具的配合：switch 回执仍为夹具回显，**不证明真实浏览器核验、胶囊观感或真人听感**。switch 请求回显、fill 成功核验产线继续未完成。功能默认关闭，未改用户配置、未构建/重载日常、未 commit/push；S1 判断值虽可命中闭合门槛但迟到未应用，**减话能力本轮未被证明**。

## 8.6 tabs:switch 执行后真实核验接线（2026-09-22；实现者自验，待独立 Reviewer；gate 默认关未动）

目标：只补 `tabs:switch` 的执行结果→成功胶囊证据链——确实切到目标页才显示「切好了」；没切过去或无法确认就不显示成功、不回弹、不能凭该回执结束语音续答。不调 Jev、不加等待窗口、不重跑三场景；不碰 fill、personality、反馈架构，不改焦点/会话权限，请求级 gate 继续默认关闭。检查者：机器定点测试、A1 探针、主代理 diff 核对；独立 Reviewer 单列。

### 实际 diff（逐文件；基线=入场工作区，含未提交源码）

| 文件 | 改动（本票） |
|---|---|
| `extension/src/background/exec/tabs.ts` | `switchTab` 激活后新增 `readSwitchVerification`：一次读回 `chrome.tabs.get` + `windows.get(focused)` + 同窗口 `tabs.query(active)` + `getWorkingTabId` → 回执附 `verification{verified, activeTabId?, windowId, windowFocused, workingTabId}`；读取失败（目标消失/查询异常）只回 `{verified:false}`，不抛错不编造。只读：无轮询、无 sleep、无重试、不抢焦点。全量 patch：[changes-tracked.patch](../../out/acceptance/v23-switch-verification/changes-tracked.patch) |
| `shared/protocol.ts` | 新增 `SwitchTabVerification` 接口；`switch_tab.data` 增可选 `verification`，原 `tabId` 工作目标含义不变（旧回执仍可路由）。该文件另有他队 fill/read-element 在途改动，本票只动 switch 两处，混合 patch：[changes-shared-mixed.patch](../../out/acceptance/v23-switch-verification/changes-shared-mixed.patch) |
| `shared/execution-feedback.ts` | `successEvidence('tabs:switch')`：除回执目标与请求一致外，必须携带执行后核验事实并逐项核对（实际活动页=请求、窗口聚焦、工作目标仍在）；旧回显、缺字段、读回失败、实际页不符、窗口未聚焦均→「结果待确认」（`executed` 不改写）。fill 分支未动（文件未提交，基线为入场副本同形） |
| `agent/src/tools.ts` | 新增 `switchResultText`，switch 分支 `textResult` 改用：工作目标与可见结果分五种措辞（已核验/非活动页/未聚焦/读回失败/未经核验），未核验时明确不宣称用户看到目标页。他队改动保留，见混合 patch |
| `extension/build.mjs` | 支持 `SIDEAGENT_BUILD_DIST` 输出到隔离目录；不带环境变量时行为与原来完全一致 |
| 测试 | 新增 `extension/test/switch-verification.test.ts`（7 例，chrome API 边界替身）、`agent/test/switch-tool-text.test.ts`（5 例模型文字）；`agent/test/execution-feedback.test.ts` +6 例核验反例/正例；`realtime-spoken-result.test.ts` +A2 反例、默认夹具升级为核验形状；`realtime-feedback-translation/adversarial/boundary` 夹具升级 + boundary 新增 R3-4 四负例（均未提交文件，入场即此形态） |
| `scripts/acceptance/v23-switch-verification-live.mts` | 新增 A1 探针（隔离构建→隔离 Chrome→原宿主链→双通道独立读取） |
| `scripts/acceptance/isolated-extension.mts` | **本票 diff = 0**（曾试加构建目录环境变量，为避免代改他队在途文件已完全撤回；A1 改用临时根目录 + cwd 切换加载原启动器） |

证据贯穿：扩展真实回执 → `ToolRpc.handleResult`（entry.resolve → 工具 `details`）→ `session.executeRealtimeBrowserTool.feedbackFor(details)` → `classifyDirectExecutionFeedback` → `execution_feedback` 事件 + `call.feedback` → 胶囊事件与 request-gate `resultsAllow`。链上无任何手填 `verified:true`；分类器对 `verified:true` 但事实矛盾的回执也拒发成功资格。

### 修前 / 修后反例

- 修前：新反例 6 项全部失败（回显一致被判成功）：[pre-fix-counterexample.log](../../out/acceptance/v23-switch-verification/pre-fix-counterexample.log)（`6 failed | 43 passed`）。
- 修后：同文件全绿：[post-fix-counterexample.log](../../out/acceptance/v23-switch-verification/post-fix-counterexample.log)；最终定点 28 文件 386 例通过：[targeted-final.log](../../out/acceptance/v23-switch-verification/targeted-final.log)；双端 `npm run typecheck` 通过、`npm run check:architecture` 228 文件通过。
- 关键反例（A2，原链）：请求 8、回包 8、读回实际活动页 7 → `kind=unknown/结果待确认`、`capsuleCanCloseAction=false`；即使判断及时且「胶囊足够」（lane=task/page 0.95/spoken 0.05），gate 实判 `applied=false, reason=execution_requires_continuation`，**续答保留**（`creates=1`）。

### 真实浏览器正例（A1）

命令：`npx tsx scripts/acceptance/v23-switch-verification-live.mts --headless`，退出码 0。证据：`out/acceptance/v23-switch-verification-live-2026-09-22T08-37-15-180Z/result.json`（23/23 断言通过，cleanup PASS，日常 `extension/dist/background.js` 跑前跑后 SHA256 一致）。零模型请求（Realtime 内存 Socket、Jev 判断本地夹具）；未用日常 ChromeMain、真实账号或用户配置；隔离构建在临时目录。

- 起点：已聚焦窗口（独立读 `focused=true`）A 活动；终点：切到 B。
- 生产回执：`tabId=B`（工作目标不变）+ `verification{verified:true, activeTabId:B, windowId, windowFocused:true, workingTabId:B}`。
- 独立读取（不经过回执、两条通道）：扩展侧 `chrome.tabs.query({active,lastFocusedWindow})` = B、`bActive=true`；CDP 页面 `document.visibilityState` A=hidden、B=visible——与回执核验事实逐项对应。
- 原宿主链产出一次反馈：`切好了 / kind=success / bounce=true / capsuleCanCloseAction=true / facts.executionFact=executed, tabId=B`，身份 `inputId=v23-switch-live:u1`、`id=tool:display-…`；request-gate 实消费：`applied=true, reason=capsule_only`，`response.create=0`（零续答）；批次决策在工具回执后 36ms，无新增等待。
- 模型可见工具文字：`Working tab is now B. Read-back right after: it was the active tab of its focused window at that moment, so the user was on this page.`，与胶囊一致，未声称页面已加载或内容已读取。

### A1–A5 状态

| 标准 | 状态 | 证据与范围 |
|---|---|---|
| A1 真实正例贯穿 | **PASS** | 上述探针 23/23；独立读取与回执互证；原宿主链一次成功胶囊+成功资格。非请求回显、非手填、非只测分类器 |
| A2 回显一致但未激活 | **PASS（离线反例）** | 修前 6 败→修后全绿；原链 A2：不显示切好了、不回弹、`capsuleCanCloseAction=false`、及时「胶囊足够」判断仍保留正常续答；真实浏览器上的该反例未单独实跑（NOT_RUN，按票面分层由第一层替身固定） |
| A3 焦点与失败边界 | **PASS（离线，chrome API 边界替身）** | 非当前会话不激活且无 update、窗口未聚焦不抢焦（无 update）、激活后核验前用户切走（不切回不重试）、目标消失/读回失败→`{verified:false}`；身份失效旧结果不结束新要求由 spoken-result A5 集回归覆盖。真实环境重复这些分支 NOT_RUN（票面分层不强制） |
| A4 已有状态与兼容 | **PASS** | 已活动目标核验后正常确认（单测断言无切走切回）；旧形状回执仍路由工作目标（`rpc-default-page` 全绿）但无核验事实不授权成功；其他 tabs 操作、后台页归属、fill 与未知写入保护回归全绿（tab-bindings/page-transfer/parent-tab-control/conversation-tabs/lead-global-browser/explicit-page-target/R3-3 fill 例） |
| A5 无新增减话等待 | **PASS** | 核验仅 4 次即时 chrome 读，无 sleep/轮询/Jev 等待；probe 批次回执后 36ms 决策；spoken-result A5/A6/A7/A8（含 gate 默认关）全绿；未改阈值、未恢复扣音 |

### 分层记录（四层不互相冒充）

| 层 | 状态 | 说明 |
|---|---|---|
| 切页核验 | **PASS** | 离线 18 例（7 扩展替身 + 6 分类器 + 5 模型文字）+ A1 真实正例 |
| 胶囊事件 | **PASS（离线链 + 真实回执驱动一次）** | translation/boundary/adversarial/spoken-result 原链回归 + A1 探针真实 feedback 事件 |
| 真人观感 | **NOT_RUN** | 本票未重载、未开界面，胶囊实际观感待真人 |
| 真实模型减话效果 | **NOT_RUN** | 本轮 StepFun/Jev 请求为 0（按票面不消耗预算）；**不把浏览器核验通过写成减话通过** |

### 并发写入、边界与停止点

- 入场 `git status` 基线 md5 `6d75c9516ef26ee6c48fc9675890a19a`；跑中他队新增 `agent/test/task-result-turn-economy.test.ts` 改动（非本票链路，未触碰）；`protocol.ts`/`tools.ts` 与他队 fill/read-element 在途改动共存保留，未 stash/reset。
- `scripts/acceptance/isolated-extension.mts` 现存两处类型检查问题（L59 `diagnostics(): unknown`、L185 `options.diagnose` 参数型）均在**他队在途新增行**里，`scripts/` 不在 `npm run typecheck` 范围，按票面不代改，留待其票处理；本票在该文件 diff=0。
- 未 commit、未 push、未重载、未改用户配置、未开请求级 gate；fill 产线与真人听感继续列未完成。
- 独立 Reviewer 重点：① 证据来自实际读取（`readSwitchVerification` 源码 + 探针双通道独立读 + 手填矛盾回执拒发反例）；② 负例不结束语音续答（A2 `applied=false/creates=1`）；③ 前台/会话权限未放宽（`shouldActivateForKey`/`mayActivateTabInWindow` 零改动，单测断言无抢焦 update）；④ 工具文字、胶囊与核验结果一致（switch-tool-text 5 例 + 探针 modelText/hostFeedback 断言）。复跑入口：`npx vitest run <targeted-final.log 同名单>`、`npm run typecheck`、`npm run check:architecture`、`npx tsx scripts/acceptance/v23-switch-verification-live.mts --headless`。

## 8.7 V2.3 最小联合验收：真实切页与真实开口决策同链运行（2026-09-22；两例各一次即停）

前置：切页核验配套票已过独立复核（12 文件 124/124、双端 typecheck、architecture、隔离 Chrome 23/23、cleanup PASS、日常 dist 未变）。本轮只组合已有路径：`v23-joint-live.mts` 复用 `realtime-spoken-result-live.mts` 的轨迹/收尾/判分（isSettled/summarize）与 `v23-switch-verification-live.mts` 的真实宿主链装配（BrowserAgentSession→ToolRpc→扩展执行器→ExecutionFeedback→请求级 gate），只补必要探针装配，未改生产策略、未新建通用测试平台。浏览器=独立 profile headless Chrome + 本地测试页（127.0.0.1）；StepFun/Jev=真实供应商；输入=已有文字入口（`connection.handle({type:'text'})`，非真人语音）；不手填 verified、不伪造 Jev 结果或返回时间。检查者：机器离线检查与两场景判分、主代理 diff/证据核对。

### 离线检查先行（两场景执行之前）

`npx tsx --test scripts/acceptance/realtime-spoken-result-live.test.mts scripts/acceptance/v23-joint-live.test.mts` → **14/14 通过**（既有 8：收尾/身份/预算异常退出/音频完整性/超时断连/胶囊缺失不判过；新增 6：预算常量、S1/S2 场景集合、import 不执行、jointChecks 对回显无核验/独立读取不符/未聚焦/可见性不符/超时收尾/胶囊次数/身份串用的拒发）。日志：[offline-checks.log](../../out/acceptance/v23-joint/offline-checks.log)。

脚本类型告警按边界单独补正：仅两处准确类型声明——`isolated-extension.mts` 新增 `IsolationDiagnostics` 接口替换 `diagnostics(): unknown`、`sw-hook.mjs` 为 `diagnose` 参数补 JSDoc 类型；启动/清理行为零改动（本轮启动→运行→cleanup PASS 即为佐证），未扩大脚本重构范围。

### 两例实际时间线（T0=文字输入登记；均同场景内比较）

证据：`out/acceptance/v23-joint-live-1790067786067/result.json`（逐事件 traces + request-audit + PCM 文件）。命令：`npx tsx scripts/acceptance/v23-joint-live.mts --headless`，退出码 0，全程 11.8s。

**S1「切到测试标签页。」——PASS；操作通过=是；减话应用=applied（本轮真实命中）**

| 时刻 | 事件 |
|---|---|
| T0-409ms | 连接启动；ready 于 T0-3ms（readyMs=406ms ≤20s） |
| T0 | 文字输入登记；同刻发起唯一一次 Jev 三问 |
| T0+553ms | 模型调 tabs:list（真实 list 返回本地两页）→ 输出回传 |
| T0+584ms | 批次1（list 观察）gate 未闭合 `applied=false, reason=judgment_unavailable`（判断 T0+1037ms 未到；观察批次本就不可闭合）→ 保守续答 |
| T0+1037ms | Jev 到达（requestMs=1038，实时计算，非伪造） |
| T0+1266ms | 模型调 tabs:switch（目标 B）→ 真实读回核验回执 → 输出回传 |
| T0+1285ms | 批次2（switch）gate **`applied=true, reason=capsule_only`**（判断已到且早于决策 248ms）→ **不再创建续答** |
| T0+3439ms | quiescent 收尾；全程 0 个 response.cancel/error |

Jev 原始结果：lane=task、pageChange=0.97、spokenResult=0.07、requestMs=1038、completedAt=T0+1037ms、voiceId=S1/turn=2/itemId=text-1（与 gate 同场景匹配）。response 总数=2（list 轮+switch 轮），工具输出=2，`continuationAfterSwitch=false`，**终稿=0、音频=0（无任何成功确认语音）**；成功胶囊事件恰 1 次（`tool:display-c66c92eb…，kind=success，切好了，capsuleCanCloseAction=true`）。

**S2「切到测试标签页，顺便告诉我一加一等于几。」——PASS；操作通过=是；减话应用=not_expected（判定需语音，按需续答）**

| 时刻 | 事件 |
|---|---|
| T0-301ms | ready 于 T0-4ms（readyMs=304ms） |
| T0 | 文字输入 + 唯一一次 Jev 三问 |
| T0+345ms | tabs:list → 输出回传；T0+351ms 批次1 gate `applied=false, reason=spoken_result_needed` |
| T0+329ms | Jev 到达（requestMs=331），早于两个批次决策 |
| T0+846ms | tabs:switch（真实读回核验回执）→ 输出回传；T0+873ms 批次2 gate `applied=false, reason=spoken_result_needed` → 同毫秒创建续答 |
| T0+5563ms | quiescent 收尾 |

Jev 原始结果：lane=task、pageChange=0.94、**spokenResult=0.97**（>0.20，判定必须有声）、requestMs=331、voiceId=S2/itemId=text-1（身份与 S1 不串用）。终稿：「切好了，现在在测试标签页。一加一等于二。」**答案正确**；对应 response 音频 provider=delivered=**241920B，SHA256 一致**（非只有转写、非部分片段；PCM 落盘 `S2-ba824ae5e0b2-{provider,delivered}.pcm`）。response 总数=3，工具输出=2，成功胶囊事件 1 次。

### 实际浏览器核验事实（两场景，独立双通道读取，不经回执）

- 生产回执（扩展真实读回）：`verification={verified:true, activeTabId:B, windowFocused:true, workingTabId:B}`，`tabId=B`（工作目标语义不变）；模型可见工具文字为已核验措辞，`hostFeedback={text:'切好了'}`。
- 独立读取：切后 `chrome.tabs.query({active,lastFocusedWindow})=B`、`bActive=true`、`focused=true`；CDP `document.visibilityState` A=hidden、B=visible——与回执逐项对应。
- 起点准备与受测动作分开记录：每场景前 probe setup（切回 A + 独立确认 A 活动/聚焦）入 `setupSeparation` 字段，setup 回执与受测 switch 回执各自独立；受测动作从 A→B 全程由模型真实发起。

### 预算实况与 A4

| 项 | 上限 | 实况 |
|---|---|---|
| Jev 总请求 | ≤2 | **2**（每场景恰 1 次三问；requestShapes 均为 `[lane_0,pagechange_0,spoken_result_0]`；request-audit 落盘） |
| Realtime response 总数 | ≤15 | 5（S1=2，S2=3） |
| ready | 每次 ≤20s | 406ms / 304ms |
| 单场景发送后 | ≤100s | 3.44s / 5.56s |
| 总时长 | ≤360s | 11.8s |

stopReason=null；无预热、无重试、无改题、无调阈值；判断与工具并行（judgeRequest 在输入登记时同步发起），**未新增任何等待 Jev 的窗口/睡眠/扣音**；两场景 provider 侧 cancel/error=0，无事后静音。相关源码跑前/跑后哈希一致（sourceChanged=false，17 个文件含两支探针/宿主链/扩展执行器）；日常 `extension/dist/background.js` 跑前跑后 SHA256 一致；凭据只读、用户配置未写；资源清理 `IsolationCleanup=PASS`（cdp/chrome/fixture 全 CLOSED）。

### A1–A4 验收

| 标准 | 状态 | 依据 |
|---|---|---|
| A1 真实动作 | **PASS** | 两场景生产回执均来自扩展实际读回（verified 逐项+独立双通道读取对应）；非请求回显、非手填成功字段（起点 setup 与受测动作分列记录） |
| A2 真实减话 | **PASS（applied）** | S1 判断及时（早于 switch 批次决策 248ms）且过门槛 → `capsule_only`；工具结果回传×2、胶囊事件恰 1 次、其后无 continuation（response 总数 2）无音频；非靠退出码——gate 日志/创建时序/零音频三项直接为证。迟到分支本轮未出现，不追跑 |
| A3 必要答案 | **PASS** | S2 终稿答案正确（=二），对应 response 音频 241920B provider/delivered SHA256 逐字节一致，非只有转写/部分片段 |
| A4 无新增等待与污染 | **PASS** | 上表预算全绿、判断并行无新等待窗、cancel/error=0、场景身份不串用（voiceId/itemId 分列）、源码哈希一致、清理 PASS、日常 dist/配置不变 |

### 边界与停止

- 本轮「胶囊」只验证事件链（execution_feedback 事件 + hostFeedback + request-gate 消费）；**不声称真人看过动效**。真人收音、听感、观感仍 NOT_RUN。
- **操作通过（S1/S2 均 PASS）与减话应用（S1 applied、S2 not_expected）两项单列**，不互相冒充；总退出码 0 不作为减话证据。
- fill 产线继续列未完成，不作为本次切页验收阻塞项。功能仍默认关闭（探针仅在内存会话开启 gate，与既有探针同法），未改用户配置、未重载日常、未 commit/push，不继续 personality 或下一阶段。两例完成即停止。

## 8.8 V2.3 受控加载与真人试用（2026-09-22；已加载、真人待验）

前置：8.7 联合验收已过独立原始证据复核；本轮不重复联合实验、不新增产品功能，只验证切页轻反馈与正常接话。用户以「做完之后引导我去试用」明确授权本次加载与临时开门（会中断当前语音连接）。

### 实际运行版本与增量（不只报 HEAD）

- 联合验收 17 个源文件哈希与当前工作区逐一比对：**全部一致**（changed since joint run = 0）——本链路在加载前无新变化，无需无变化重跑全仓。
- 运行版 = 14:07 构建（bundle SHA256：sidepanel `3044f765…`、background `cebbbfbf…`、content-cursor `3808a2e9…`）+ 16:20 启动的 Native。
- 待加载/本次构建：sidepanel.js `dbc2872c…`、background.js **`ed7695b2…`**（两者已变）、content-cursor.js `3808a2e9…`（未变，cursor 域源码 14:07 前已入运行版）。
- **真实增量（mtime>14:07 的生产源码，按归属分列）**：
  - 本链路（已过 8.6 独立复核 + 8.7 联合复核，且哈希未再变）：`extension exec/tabs.ts`（切页核验读回）、`shared/execution-feedback.ts`（核验门槛+capsule 字段）、`shared/protocol.ts` 的 SwitchTabVerification、`agent/src/tools.ts` 的 switch 文字、`agent/src realtime-voice-connection/realtime-voice-session/route-shadow`（请求级 gate 接线）。**其中 Native 侧增量=0**：现行 Native 启动于 16:20，其后 agent/shared 源码零改动，新 PID 同源。
  - 他队未提交并发改动（随本次构建一并进入运行版，**不属本票通过范围**，未代改未撤销）：`exec/input.ts`、`exec/read-element.ts`、`content/domops.ts`、`shared/editable-text.ts`、`shared/task-goals.ts`、`shared/task-results.ts`、`shared/protocol.ts` 的 editableText 契约、`agent/src` 的 conversation-manager/session/task-evidence/task-goal-tool/task-results/goal-* 等任务域改动。
- 构建与重载均用项目现有入口：`npm run build`、`npm run reload:ext`（CDP 9222 点击重载按钮）。

### 受控配置与加载核验

- `~/.sideagent/config.json`：**原值 = voiceSpokenResultGate 不存在**（源码缺省 false 不变，源码未改）；备份 `config.json.bak-gate-20260922-1714…`（同目录）；临时置 `voiceSpokenResultGate=true`，读回 true。其余键（model/proxy/routeShadow/generalBrowserLoop/display*）未动。该键在**每次语音会话创建时读取**（voice-service createSession 调 `voiceSpokenResultGateEnabled()`），故开麦建连即生效，不需要额外重启；是否生效以本次会话日志中出现 `spoken_result_gate` 记录为实证（该日志只在 gate 开启时产生）。
- 加载后四项核验：① 新 Native PID 24385/24386（17:15 启动，入口=本仓库 `agent/src/main.ts`，旧进程 09:15:40Z stdio 关闭退出）✓；② 扩展实际加载构建：CDP 在生产 SW 内自读 `background.js` SHA256 = `ed7695b2…` = 本次 dist（≠运行版 `cebbbfbf…`）✓；③ 侧栏已重连：日志 09:15:48Z「面板已连接」✓（扩展重载会关闭侧栏 UI，未开时点扩展图标打开即可）；④ Realtime ready 与 gate=true 实读 = **待用户开麦后由 T1 机器日志核验（真人待验）**。
- 试用页：本地静态安全页已在日常 Chrome 后台打开——「X 标签页」`http://127.0.0.1:18742/x.html`、「Y 标签页」`/y.html`（python http.server PID 25027，不碰用户已有页面）。

### T1 / T2 结果（同一语音连接，用户自己的声音；机器与真人分列）

**T1「切到 X 标签页」**（ASR 原话：「切换到 X 表情页」——把“标签页”听成了“表情页”；voiceId=5dddb966，turn=3，itemId=inputId=c7fdc7d4…，17:18:43）

- 机器：tabs list→switch 真实执行成功；Jev 到达 T0+810ms（lane=task, pageChange=0.94, spokenResult=0.10）；批次1（list 观察）judgment_unavailable→保守续答；**批次2（switch）applied=true, reason=capsule_only**——判断早于决策 1.68s，其后无 continuation、无口头确认音频；成功胶囊资格被 gate 实证（resultsAllow 要求 kind=success 且 capsuleCanCloseAction=true 才可能 applied）。全程无 response.cancel、无事后静音。
- 真人：用户总评「还行」，核心路径明确确认无问题；胶囊观感分项未逐条单独答复，不代填细分 PASS。
- **减话命中：是（T1）**——日常真实链首次实证胶囊闭合。

**T2「切到 Y 标签页 + 问 1+1」**

- 机器：Y 切换工具执行成功（call_0_1921, ok, 278ms）；该批次判断迟到（judgment_unavailable）→ 正常续答并播报（本句本就需语音回答，无减话主张）；会话内多条 playback_done 播放回执存在。
- 真人：用户亲证「打开 X 再换成 Y，再问 1+1」没问题、答案「二」能听到。1+1 的逐字文本未在本会话存档 grep 命中，以用户亲证为准，不代填机器逐字证据。

**无串用/无吞答案实证**：stale_input 拒绝跨输入复用判断（17:19:37）；所有失败/存疑批次均产生续答；无取消、无扣音。gate 实读=true 完成核验：每个会话均输出 `spoken_result_gate` 日志（仅 gate 开启时产生）——第三节第 4 项核验就此闭合。

### 试用中定位的问题（只定位，不在本票修复）

1. **（最值得处理）停止任务后，语音直接工具被身份闸门连坐拒绝**：用户停止旧任务后（run 被标记中止），新语音请求（新 voiceId/新 inputId）的每个 tabs 调用仍携带该 run 身份，在扩展侧 `index.ts:1004`（`abortedRuns.has(runId) || current!==runId` → “原任务已停止或发生变化”）及 task-next-step 的 cancelled 映射（“原任务已取消”）被拒。现场：17:21:07–08 连续 3 次、17:21:53–54 连续 2 次 `tool_output ok=false`（324/7/6/113/7ms，UI 即截图中「执行失败·耗时0.0s」×N），模型反复重试后道歉称“连接出了点问题”（**误导性归因：不是连接问题**），直到会话结束未恢复。gate 行为本身正确：这些批次分别判 execution_requires_continuation / spoken_result_needed，均正常续答，未误静音、未假成功。
2. 重连时供应商瞬时错误：17:20:51 新会话 session_created 后 90ms 收到 provider_error “server error”→fatal 关闭；2s 后重连成功（session3 ready）。自动恢复，但会话中断一次。
3. page_translation 两次生成中止（翻译域，不属本票）：17:19:24「已完成 23 段，剩余 135 段…aborted」（10.5s）、17:20:36「已完成 120 段，剩余 49 段…aborted」（38.7s）——用户后续“翻译成中文/只留中文/宋体/绿色标注”系列要求受此影响；中止根因需翻译域单独排查。
4. 观察（非本链路）：ASR 将「标签页」误听为「表情页」，模型仍选对 X；供应商重复 function_call 事件被 `duplicate_call_id` 幂等忽略（设计内）。

### 最终配置状态与回退

试用已结束，**已恢复原值：`voiceSpokenResultGate` 键已从 `~/.sideagent/config.json` 删除（恢复为“不存在”=源码缺省关闭）**，备份仍在 `config.json.bak-gate-*`；其余键未动。该键在每次语音会话创建时读取，且当前无活动语音会话，**下次开麦即读到关闭、恢复正常续答**（无需重启；已由读取时机代码与无活动会话两个事实核实）。出现吞答案/串话/反复播报时的回退规则不变：先关 gate，不恢复已删除的事后扣音代码。试用本地页服务已停止（PID 25027），两个标签页留在浏览器里可自行关闭。未 commit、push，不扩展 fill/personality。

### 最值得处理的一个体验问题

问题 1（上述）：**用户主动停止任务后，语音链的后续新请求全部被“原任务已停止/已取消”拒绝**——连续「执行失败」刷屏、模型反复重试、最后归因成“连接问题”，会话内无法自愈；这是本轮体验里唯一造成明显挫败感的交互断崖，建议作为下一票优先处理（修复时需区分“停旧任务”与“新语音请求”，不在本票范围）。

### 试用后修复（同日；只修不加载，待用户重载）

用户裁决：问题 4（ASR 误听但执行正确）不算问题；问题 1–3 立即修复。修前反例 8 败（[pre-fix.log](../../out/acceptance/post-trial-fixes/pre-fix.log)）→ 修复后四文件 34/34（[post-fix.log](../../out/acceptance/post-trial-fixes/post-fix.log)）。

| 问题 | 根因（日志/源码实证） | 修复（最小面） |
|---|---|---|
| 1 停任务后工具连坐 | 会话 emit 包装给工具帧附着 `progress.runId`；停任务后该 runId 被扩展 `abortedRuns` 永久投毒 + 状态 `aborted`→“原任务已取消”；直连语音帒与任务帒未区分（快照实证：三次失败输入时 state=aborted、runId 仍为旧值、unknown=1） | ① 工具帧携带 `sdkId`（protocol/rpc）；`display-*` 直连帒不附着任务 runId（conversation-manager 一行条件）——新语音请求不被扩展身份闸门连坐，任务迟到帒仍按原身份被拒（身份次序规格测试保留）；② `assertTaskStepExecution` 新增 `freshDirect`（display-* 调用），只豁免 `cancelled` 一条生命周期原因，未知写入/运行时错误/重复回执/失败边界全部保留（session 传入 display 前缀） |
| 2 建连瞬时 server error 断会话 | `onProviderError` 在非 ready 阶段直接 fatal（实测 session_created 后 90ms 中断，靠面板恢复重连） | 未 ready 且无用户输入时静默重建握手：预算 2 次（`retryHandshake`），耗尽或已有输入回退原 fatal；ready 后路径不变，ready 时预算清零 |
| 3 翻译生成中止 | `translatePageBatch` 对 stopReason error/aborted 立即抛错不重试；用户主动停止也报“翻译生成失败”（39s 已停止行与1928中止同秒，属用户停止） | `runPageTranslation` 同批对“这批翻译未完成（…）”瞬时中断只重试一次，再次失败如实报故障；`signal.aborted`（用户停止）不重试，改报“已停止翻译请求，已完成/剩余 X 段；可从已完成处继续”；parseTranslations 的 JSON.parse 就地包 try/catch 并原样重抛（保留上层 SyntaxError 分型，行为不变） |

回归：受影响 21 文件 324 例中 **323 过，1 失败 = `task-recovery-matrix` “interrupted auxiliary script…untrackedWritePending”——他队在途 task-progress/evidence 域的既有失败**（失败点在 TaskProgress.observe→snapshot，早于本修复任何被执行的代码；四份相关生产源均属他队在途改动，本票不代改，留待其票）。双端 `npm run typecheck` 绿、`check:architecture` 228 项绿。

**加载状态：修复只在源码，尚未重载日常**（日常仍跑已加载版本）；`voiceSpokenResultGate` 保持原值关闭；未 commit/push。重载需用户授权（会中断语音连接）。
