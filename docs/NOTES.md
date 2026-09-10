# 会话工作笔记

使用方式：当前进度以 [STATUS](STATUS.md) 为准；关键决策、阶段完成、受阻或交接时更新续接结论，不重复抄验收证据。下文旧任务描述保留为历史记录，不能覆盖当前指令和状态入口。规范修订依据见[本轮验收](evals/20260910-working-rules-simplification.md)。

## 光标可见性第一轮（2026-09-10）

用户批准先做 P0。续接先看 [本轮验收](evals/20260910-cursor-visibility.md)及 STATUS；体验待用户判断后再进入 P1。页面可见性与操作成功分开检查：ChromeMain 工具可以在后台完成，但后台 RAF 不推进，截图和动作回执不能代替可见窗口中的运动检查。当前测试脚本使用唯一 request id、真实窗口可见性并恢复原前台，失败记录保留在验收文件。

## 语音交接入口（2026-09-10）

[交接与失败证据](tasks/20260910-voice-review/handoff-gpt6-pro.md) 保存识别退化反馈、截图、会话日志及验证边界；当前裁决见 STATUS。

## 人声检测第一处实施（2026-09-10）

用户授权只做第一处，随后自行试用。状态见STATUS，证据见[验收](evals/20260910-voice-speech-detection.md)。新增voice-speech、voice-vad-model、voice-vad-worker，VoiceClient将worklet音频先送本地Silero，原24k PCM经96ms人声确认与320ms前音送往原协议。模型与ONNX wasm随扩展打包，CSP仅增加本地wasm执行；失败显式报人声检测错误，无音量回退。生命周期和音频测试已补，旧恢复检查仅补分类器fixture，不改失败断言。

9类真实模型样本和正式VoiceClient/worklet合成输入在日常Chrome扩展页面通过；1050项全量及最终定点29项、typecheck/build通过。暂不改第二、第三处。真实环境声音无原始PCM，不能以样本声称真人已通过。脚本voice-speech-run.mts使用带唯一查询参数的独立扩展诊断页，逐帧回执推动样本，避免页面后台定时器限速；voice-speech-capture.mts可指定测试target验证完整收音链路。关键原因已记录在验收与测试，无新经验提案。

## 静默时出现“嗯”的诊断（2026-09-10）

用户15:30截图反馈没有说“嗯”却反复显示。只诊断，未修改产品或重载。实际native agent.log中会话44805480… turn4于15:29:50.502提交53760字节（1.12秒）、RMS0.01316，50.963转写1字；turn7于56.339提交48960字节（1.02秒）、RMS0.00977，56.776转写1字。default持久会话15:29:58.188快照包含用户“嗯”。两次独立输入提交，不能归为单纯界面重复渲染；turn4精确文本日志未保留，不能断言两次都是“嗯”。

生产VoiceTurnDetector仅RMS>=0.015连续4个20ms帧判开始，随后700ms低音量提交；不辨人声。VoiceClient一开始就停止播放器并interrupt。服务端非空转写直接发布用户text并routeInput，没有可疑短输入门控。用100ms确定性非语音噪声+静音直接调用生产detector，复现start:1/commit:1。复现只证明误触发机制，不证明ASR一定输出“嗯”。

声音检测器本轮未改；earlyReplies让误识别也立即触发接话，放大原缺口。已启用浏览器回声消除、降噪及自动增益，但无此轮原始PCM/实时播放对应日志，不能区分环境噪音、呼吸或外放回声。修复方向为人声与噪声判别、插话防误触及短输入有效性；不能全局屏蔽“嗯”，否则真实确认被吞。用户当前只要求查日志查原因，后续实现需按此范围明确验收。

## 任务中连续语音对话（2026-09-10）

用户确认主要问题是直到任务结束才出声，要求接话、执行中闲聊/改口和一致人格。完成标准：[live-dialogue](evals/20260910-live-dialogue.md)，进度以STATUS为准。初始8项7失败：awaitDelivery吞接收语音、后台stream直接reset抢话。修改voice-session接收回应与后台排队，manager给当前语音reply流附voiceTurn，voice-personality统一实时语音和正式回答。

顺序分类后接话的真实样本出现11.93秒等待，改为VoiceService启用earlyReplies，先接话与分类并行。先接话只表达理解/意图，实际确认仍依真实receipt。routingTurns/inputDecision门控让普通闲聊保留尚待接收的旧委托，新动作永久失效旧委托；manager pendingDelegation避免闲聊启动第二任务。语音近期已说内容进入分类上下文。分类start+observe且无独立任务措辞时合并委托；其他非法混合仍拒绝。

后台排队保留voiceTurn，过期/取消ID加入静音集合，防晚final复活；当前reply仍可流式。最新定点3文件66项及全量129文件1044项、typecheck/build/diff通过。真实u0oHyq四轮13检查通过但措辞仍欠佳；ZeGTEC第二轮11930ms，推动并行接话；DOcyVX第一声2324ms后任务模型529，未完成完整最新路径。记录均保留，不用旧样本证明最新代码。

用户要求看得见测试：录音页已在日常Chrome打开；正式扩展已重载，但sidePanel.open被Chrome用户手势限制拒绝，待用户点击工具栏图标。没有偷偷切回无头验收。下一步从日常侧栏完成真实可见语音验证，明确区分合成输入与真人听感。CDP实际可连127.0.0.1:9222；chrome-devtools默认profile自动发现失败不代表浏览器不可连。


## 任务收尾验收定义（2026-09-10）

**最新：暂停。** 用户问5秒到底何义、语音还是文字，并指出侧栏文字一直正常、复杂长回答超过5秒属正常。主代理承认当前全文交付计时混入正常产出，暂停旧指标工作，已中断Grok。没有新获批指标，未把旧候选改判通过，原标准保留修订依据。正式agent/src与A无差异，未发现本轮残留测试进程；旧voice-human进程19344不是本轮，不触碰。后续实现者仍按用户选择Grok，但不能在验收对象未重新对齐时继续旧任务。

用户已明确“OK，同意方案，开始执行吧”，[标准](evals/20260910-task-completion-tail.md)冻结进入实施。指标为六次全正确的最长收尾等待≤5秒。T起点由独立fixture预先定义的全部结果齐备时刻确定，不用最后一次检查或模型自报；终点为完整正文可见且运行实际结束。正常三场景各两次，另测假成功/漏步骤/已达成反转/方法变更/错文档/unknown与结束后重复。保留A登记，主代理规划评审、DeepSeek执行延续；当前A/B/C结论不变。

自包含[委派](tasks/20260910-completion-tail/assignment.md)和[主代理评审](tasks/20260910-completion-tail/review-checklist.md)已落盘。新快照计划`/tmp/ego-completion-tail-20260910/{A,candidate}`；只借上轮A的测试脚手架，产品来自当前root完整WIP。真实运行由主代理启动DeepSeek脚本，已有授权不重复问；worker不重试此前拒绝的DNS/loopback权限。日志从命令开始留stdout/stderr与退出码，不再只手抄摘要。

用户最新指令“接下来子agent就派grok”：后续由Grok 4.6实现/测试，主代理规划评审不变。DeepSeek已中断，交接[handoff-grok](tasks/20260910-completion-tail/handoff-grok.md)。47项测量/fixture/wiring离线检查由前任完成；主代理已准备宿主preflight和A三场景复现。运行期间Grok只读A/共用驱动，待真实根因后改candidate。此前分工记录不覆盖当前Grok选择，产品M3/medium不变。

首批A因extension/dist缺失启动失败；Grok补A构建后，单例`runs/repro-single-A-01.log`真实执行到180秒超时。原始out为`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-harness-s2-0Y3OnG`：snapshot已读齐3评论，click之后反复请求video的visible/textContent，未请求paused。该例不是六次正式比较，T0/after在超时出口尚未完整采集，不能伪算精确收尾秒数。

第一候选只增强read_element原生控件状态反馈（video/audio包含paused等，checkbox包含checked），并更新工具说明；未做交付后结束接点。Grok定点14项/typecheck/build均通过，原始日志在任务offline/candidate-*。宿主正跑candidate同场景，seed=completion-tail-repro-a，日志`runs/repro-single-candidate-01.log`。两次单例用于诊断，正式达标仍需冻结同seed条件六次及边界，不能用单例替代。用户强调效率与阶段可见，后续按单场景→修复→六次验收推进，不堆测量框架。

该candidate单例现已完成，out=`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-harness-s2-6xRcXX`。页面/三评论正确，request后28.743s结果齐备、50.786s正式交付、52.806sSDK停止；因此仅后台结束已晚24.063s。tail.fullBody为null：疑似Markdown列表序号与DOM innerText格式比较不等价，未修正验证，不伪报精确完整UI终点。第二处交付优化未收到产物，Grok现已中断。

## 登记/绑定A-B-C委派（2026-09-10）

用户已明确指定DeepSeek做实现与全部测试，主代理只规划/评审。以[新冻结标准](evals/20260910-registration-binding-ab.md)及[自包含委派](tasks/20260910-binding-ab/assignment.md)为准，旧“不新增代理”仅为先前任务边界。主代理不得代写候选代码或代跑比较。

比较A当前WIP、B先观察+唯一pending项执行时绑定、C先观察+动作携带原结果编号。先边界后18次交错真实M3/medium测试；禁止混入模型调参/语音改口。DeepSeek仅改隔离副本与任务目录，待主代理选型再回接现有工作区。当前状态见STATUS，进度读任务目录progress.md。

评审入口[review-r1](tasks/20260910-binding-ab/review-r1.md)：不能只测试assert/helper。必须覆盖tool_start到真实派发的接线，否则C在两个同target项下可能先认领第一项、再按result_id绑定第二项；已有证据快捷路径同样须核对run/成员。持久化的可选链和host.bind返回false不可变成成功放行。候选在/tmp/ego-binding-ab-20260910/{A,B,C}；线上仍前轮版本。worker遇DNS/loopback EPERM且提权自动拒绝，不继续重复请求或绕过；等待其准备具体脚本后评审执行环境变更，不能用模拟数据替代18次真实对照。

运行入口`node docs/tasks/20260910-binding-ab/run-ab.mjs`。每批独立目录、同block共用seed、18次串行；firstAttempt/Dispatch/DOM动作区分，内部登记从agent_event而非browser RPC统计，usage从真实session提取。失败/超时保留，SIGTERM清理后才强制结束。用户已确认宿主启动，首批无.git失败后DeepSeek修复voiceEvidence与预检，正式有效批次20260910T045813-60319完成18次。原始数据与[主代理结论](tasks/20260910-binding-ab/decision.md)为续接入口。

用户明确改用单指标：六次全部正确完成的平均totalMs，任一次失败则不达标。A6/6、83.701秒；B/C各5/6，不接入。B最后等待任务browser_run连续报错、未执行提交；C首次等待任务猜错CSS后180秒超时。候选源保持冻结，没有重跑刷掉失败；正式agent/src仍与A一致。后续若继续须以失败路径为起点测试新候选，不能把本轮五个成功样本均值当作达标或提速。

## ego-lite工具环境首轮落地（2026-09-10）

用户已从研究授权转为继续推进，并强调先检查工具环境，再决定轮次/上下文/推理配置。[STATUS](STATUS.md)为状态入口，[冻结标准与结果](evals/20260910-browser-environment-state.md)包含所有失败样本。本轮仍M3/medium，未改UI或供应商。

新增shared/element-state.ts固定属性/条件契约；read-element.ts共用可序列化只读getter，properties/expect/timeoutMs支持原生控件与媒体状态，条件不匹配失败，跨文档拒绝；agent/tools.ts按属性给出严格equals类型并投影小结果。原文本/值读取保留。最初3项新断言红，后通过；真实Chrome AX/有界等待/多目标/换文档7项通过。

实际M3选择browser_run，却因Pi onUpdate异步而先跑assert再收到子步骤绑定，合法target被拒。新增browser-program-binding.test.ts复现红→绿。tools execution.onStep经runtime/fleet直接同步调用session.observeProgramStep，旧SDK更新仅保留无宿主的兼容出口；没有放宽目标匹配。原生状态的字符串true错误通过属性类型schema与运行时早拒修正。

最终自主样本9轮29.561秒、0JS，暂停一次且三条评论正确；旧环境部分基线10轮21.762秒，不能称整体更快。中间14轮36秒和13轮104秒保留。下一断点是强制登记/目标绑定往返，以及改口/旧播报有效性；不要用调低推理掩盖，也不要把本轮当作完成全链路改造。12:05构建已加载且hash核对。1024项/typecheck/build通过。经验已由测试/验收覆盖，无新增wiki提案。

## 连续任务响应调研（2026-09-10）

当前状态见[STATUS](STATUS.md)。用户真人确认语音正常，但简单任务太慢，随后明确要求先调研整体现状与优质做法，不直接改产品。[完整报告](research/20260910-agent-responsiveness/report.md)与[脱敏计时](research/20260910-agent-responsiveness/timing-evidence.json)是续接依据。

本次暂停视频7轮模型6429推理token；工具累计185ms，49秒后暂停、确认后73秒才出声。新要求11:25:49入队，11:26:52才消费；已安装Pi0.84.4的steer就是轮次边界投递，不是中断当前生成。TaskResultBook严格匹配tool/target，click改js后原项pending；snapshot调用成功可把名为验证的项置satisfied，但不核对结果值，模块探针已复现。assertTaskResultExecution比“多步骤才登记”的文字更广；当前正式流只核对run，不区分同run中尚未消费的新要求。

建议先校正结果契约与改口/播报有效性，复用已有browser_run、工具权限和回执；再作模型/上下文对照。不能删除unknown保护，也不能把普通插话变成停手。外部框架资料仅支持机制方向，未做替换实测。报告候选时延门槛未获确认、未实施。后续不要将调研理解为重写授权。

## 正式流式语音接入（2026-09-10）

用户试听后已授权正式改动和重载；当前状态以[STATUS](STATUS.md)为准，冻结标准与证据在[流式语音验收](evals/20260910-streaming-voice-product.md)。Step realtime保留输入，StepTtsStream用同音色纯TTS输出24k PCM；短句进入合成、音频包立即转发，取消关闭输出并丢弃晚包。原整段20秒限制不再拦生产正式回答。

Pi send_user_message部分参数转为有runId/稳定deliveryId的累积正式正文；普通text_delta仍为内部流。注意实际模型可能先content后kind，不能等kind才发布；factory覆盖bindDeliveryRun时必须同时绑定流事件读取者。已有compose正式回答出口也使用streamSimple增量，同气泡终结不重复。voice-service、voice-session、shared协议、panel-history和侧栏已接通；agent_end/失败取消未完成正文，清空播放器队列。入口与取消测试见agent/test/streaming-voice.test.ts，真实侧栏入口为harness-s2-run.mts --case=streaming_voice。

真实模型可能172ms就给完全部正文，TTS首音859ms，因此该例首音晚于正文结束；不能把异步增量接入宣传成每次都抢在全文前出声。真实长音频/播放器打断和受控分段不等全文测试分别记录。最终复测9段正文、73.5秒音频，首音比最终正文早912ms；正式构建已加载并核对hash。无新增子代理、提交或推送。代码/测试/验收已覆盖原因，不重复建立wiki经验或提案。

## 真人语音无声：原因已确认（2026-09-10）

用户10:39真人复现的两次receipt_speech_rejected均completed、有音频、textMatches=true，158字；音频990720字节/20.64秒、1075200字节/22.4秒。唯一不满足为g.bytes<=960000（24kHz单声道PCM16即20秒）。两次后只留文字，未发音频；不是本次文字不一致。证据见[诊断结果](evals/20260910-speech-rejection-diagnosis.md)，不复制邮件内容。之前无字段日志不可倒推原因。诊断代码已加载且有效，未改播放规则；修法需与用户对齐，不再让用户重复测试。断线恢复仍暂停。实时语音调研见[简报](research/20260910-realtime-voice-first-pass.md)。

## 第三轮独立验收：R3前后差异仍不足（本任务续接）

当前进度见[STATUS](STATUS.md)，返工权威见[第三轮报告](evals/20260909-write-receipt-loss-independent-review-r3.md)。旧标题反例7/7和正例6/6通过，定点98通过，不重复旧修复。

独立scope驱动三个真实Chrome反例均最终2条：AX未覆盖的隐藏旧文本被read_element读到；同文档无关banner出现新文字；用户/环境导航到同tabId新document而未触发Agent页面工具清基线。三者均被resolve_unknown_result接受为新增动作证据。原算法只有tabId与前后文本差异，仍缺原操作/结果绑定。不要用禁h1、隐藏选择器或补关键词解决；需窄的预绑定结果与可比较读数，无证据保持unknown。

新入口scripts/acceptance/write-receipt-loss-scope-run.mts，参数hidden/background/navigation；JSON独立保存于r3-independent-{hidden,background,navigation}。正例的“接续”仅再次snapshot，不能独自证明写权限已恢复，后续需实际独立写入验收。A9仍未跑；本轮无产品源码修改，证据hash一致。

## 前轮：写入回执丢失独立验收技术结论（2026-09-09）

原实现闭环结论被独立检查推翻，修订证据和返工项在[独立验收报告](evals/20260909-write-receipt-loss-independent-review.md)，原实现报告/日志13保留，不改冻结标准。

关键断点：RPC按随机传输UUID保存fact，session按Pi toolCallId查询，恒未映射；TaskProgress用错误关键词补fact，其他错误变not_executed。真实隔离Chrome在明确unknown非超时错误后重复新增2条。onLateResult无赋值，handleLateResult及resolveVerifiedResult无生产调用；后者也无观察证据校验。ControlGate非去重器，同id两次执行计数2，index无外围去重。worker工具初始化无lead execution/assertCall参数，需补生产覆盖。

新增验收者文件：`scripts/acceptance/write-receipt-loss-boundaries.mts`（模块5/10）、`scripts/acceptance/write-receipt-loss-unknown-error-run.mts`（浏览器3/6，副作用重复）；三份independent JSON及验收报告。固定脚本复跑15/15、定点82通过，源码hash核对一致。未跑A9及全量工程复验，不作为通过；产品源码未改。

## 当前状态（2026-09-09，以下为较早记录）

维护入口：[项目状态](STATUS.md)、[语音验收台账](evals/20260909-voice-dispatch-results.md)、[语音协议](voice-dispatch.md)。用户先要求补文档，之后明确授权提交推送和云端评审；浏览器仍归用户，未获重载交回答复。完整任务未完成，当前提交是开发快照。

2026-09-09 Anti Gravity 语音对话连续性与真实发现播报：
1. **意图与事实分离通用原则落地**：
   - 来源事实基准不可动摇：`latestResult` 包含的实体属性与类型为绝对真实客观基准；
   - 用户否定纠正（如“不是A，是B”）为谈论焦点切换/筛选意图，绝不可改变源事实中实体的客观分类；
   - 依据源事实解析指代，严禁阿谀迎合篡改事实（严禁说“你说得对，某某确实是B不是A”）；歧义冲突时如实基于源事实澄清；
   - 系统指令与 per-turn prompt 双层约束生效，拒绝特定词补丁。
2. **口语提炼发现与去 Markdown**：
   - 播报与回答提炼为 1-3 句简短自然口语短答，直接说明发现、保留范围限制与报告来源；
   - 严禁原样照搬 Markdown 清单，严禁输出或朗读任何 Markdown 标记（`-`、`*`、`**`、`#`、反引号）及内部哈希 ID。
3. **通知语义四解耦与去正则摘要**：
   - `announcedControls`、`announcedResults`、`announcedUnconfirmedRuns`、`announcedErrors` 独立去重，防吞 control 动作与迟到结果；
   - 彻底删除启发式正则摘要，`progressSpeech` 保留完整数据，`receiptSpeech` 状态查询在有真实结果时返回 null 走已有实时模型自然摘要。
4. **验证与状态**：48/48 单元测试通过，`typecheck` 0 错误，`git diff --check` 通过。状态标记：`READY_FOR_EVALUATOR`。


## 历史记录（按各条日期判断，后续更新在文末）

2026-09-08 跨会话记忆 A 版正式实现已获用户批准。保留 Pi；仅显式记忆，默认全会话、明确网站则 hostname 限定；个人抽屉可管理全部记忆。独立校验负责 eval 与固定测试，memory_runtime（Sol/high）负责存储和 Pi，memory_ui（Sol/high）负责正式抽屉，主线程负责共享协议、进程注入与真实扩展验收。当前代码开发中，未 build/reload。

2026-09-08 跨会话记忆进入独立标准与原型阶段。用户已明确功能拓展优先，效率优化暂存待办；保留 Pi。当前仅授权标准与 HTML，产品实现等待原型人评。标准由 memory_evaluator（GPT-6 Astra / high，独立上下文）负责；主线程负责设计依据和原型。入口：`docs/evals/20260908-cross-session-memory-design.md`；eval 和 preview 已完成；原型浏览器事件路径20项与独立反例7项通过，真实点击主路径和窄屏/深色已检查。P6及真实产品全部待评/待实施。

2026-09-07 教学模式手绘圈点勾画与通透批注正式落地（标准 `docs/evals/20260907-hand-drawn-teach-marks.md`，原型 `docs/evals/20260907-hand-drawn-teach-marks.html`，日志 `docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`）。
1. **核心算法与模块实现**：
   - 0 依赖轻量自研 PRNG 与几何算法（`extension/src/shared/rough/`：`prng.ts`, `geometry.ts`, `index.ts`），提供 `mulberry32`、`roughEllipse`、`roughArrow`、`chiselWash` 与 3 帧微动 `variants`；
   - 算法单测覆盖：`extension/test/rough.test.ts`（6 项测试通过）。
2. **动效设置与状态持久化**：
   - `extension/src/background/mode.ts`：增加 `MarkMotion` 类型（`"grow"` | `"boil"`）、`getMarkMotion()`、`setMarkMotion()`，单测在 `teach-mode.test.ts` 中通过；
   - `extension/src/background/exec/input.ts`：`toolMark` 自动感知当前运行模式（teach 模式默认 `style: "sketch"`，act 模式保持矩形框）；
   - `extension/src/sidepanel/main.ts`：在 `#teach-toggle` 按钮支持右键快捷切换动效偏好（持续微抖 vs 生长定格），并通过 tooltip 提示当前状态。
3. **页面 Content Overlay 渲染落地**：
   - `extension/src/content/cursor.ts`：升级 `spawnMark`，支持手绘椭圆、引导箭头、CSS 3 帧微颤动与生长动画，滚动和 resize 时复用固定 seed 坐标平移（零闪烁）；
   - 修复荧光笔遮挡字迹：`.highlight` 增加 `mix-blend-mode: multiply`，文字 100% 锐利透出不被遮挡。
4. **自动化验证与自检闭环**：
   - `npm run typecheck`、`npm test`（52 files, 489 tests）、`npm run build` 全绿；
   - `node extension/test/overlay-check.mjs` 截图并通过无头 Chromium 断言。
5. **待人检裁决**：
   - 真机教学模式引导圈注的笔触质感与动效流畅度，以及长文本高亮透出度。

2026-09-07 Kit Langton 风格克制 SVG 微动效数据流（Subtly Animated SVGs）概念探索与素材库归档（原型 `docs/evals/20260907-runtime-pipeline-viz.html`，规格 `docs/evals/20260907-runtime-pipeline-viz.md`，素材归档 `docs/research/20260907-subtly-animated-svg-pipeline-inspiration.md`）。
1. **概念与设计验证**：
   - 深入拆解 Kit Langton 演示精髓：事件驱动的贝塞尔微光连线 + 沿线减速微粒 + 接收端数字弹跳回弹，极具克制美感与安全感；
   - 制作包含 3 套形态（空状态全景装配看板、顶部收纳 HUD 胶囊、步骤 DAG 流）的高保真交互原型；
2. **决策与裁决（不强行落地）**：
   - 用户与执行者深度达成共识：当前 By-Your-Side 扩展尚未构建动态 Skills 插件市场或开放配置总线，现有工具集固定写死在协议层；
   - 坚决杜绝“为了动效而编造不存在的虚假产品概念（Vaporware UI）”；
   - **结论**：本设计完整保存入素材库（包含完整可运行 SVG/CSS 源码与动效参数），暂不落地进产品，待未来插件架构或多 Agent 拓扑成熟时再行唤醒。

2026-09-07 侧边栏执行步骤聚合卡片垂直压缩变形 bug 根治修复（标准 `docs/evals/20260907-fix-run-steps-squash.md`）。
1. **根本原因（Root Cause）**：
   - `#messages` 为纵向 Flex 容器（`display: flex; flex-direction: column`），当会话消息变长超出视口高度时，浏览器 Flexbox 计算负空间（negative space）；
   - 普通消息气泡（`.msg`）为 `overflow: visible`，拥有隐式 `min-height: auto`（基于其内容高度，不会被压缩）；
   - `details.run-steps` 声明了 `overflow: hidden;`，按 CSS Flexbox 规范，带有 `overflow: hidden` 的 flex item 其自动最小高度为 0（`min-height: 0`）；
   - 导致整个消息流超高时，Chrome 弹性盒算法将所有的负空间压缩完全施加在 `details.run-steps` 上，卡片高度被挤压至 ~20px 乃至 2px，summary 顶部或底部严重裁切。
2. **根治方案与防线**：
   - `extension/src/sidepanel/styles.css`：
     - `#messages > *` 全局声明 `flex-shrink: 0;`：确立整个聊天消息流只能随内容自然伸展并滚动（`overflow-y: auto`），绝不允许被 flexbox 压扁；
     - `details.run-steps` 声明 `flex-shrink: 0; min-height: min-content;`，`.run-body > *` 声明 `flex-shrink: 0;`；
     - `details.run-steps summary` 显式增加 `min-height: 38px; line-height: 1.5; box-sizing: border-box;`；
     - `details.thinking`、`.chip-group`、`.msg` 同样补全 `flex-shrink: 0;` 双重防御。
3. **测试与真机验证**：
   - 新增 `extension/test/steps.test.ts` 布局契约测试（全量 42 模块、404 测试 100% 绿）；
   - 在真实 Chrome 环境注入长对话与超高消息流，实测 `detailsHeight` 稳定保持 40px（未展开）/ 3400+px（展开），截图确认图标、文字垂直居中且零裁切（截图存 `run-steps-overflow-verification.png`）。

2026-09-07 扩展与产品名称对齐 GitHub 仓库名重命名为「By Your Side」（标准 `docs/evals/20260907-rename-by-your-side.md`）。
1. **统一品牌与可见名称**：
   - `extension/manifest.json`：`name` 与 `action.default_title` 更新为 `"By Your Side"`。
   - `extension/sidepanel.html`：页面 title 更新为 `"By Your Side"`。
   - `extension/src/sidepanel/main.ts`：顶栏品牌文本与设置面板标题更新为 `"By Your Side"`，输入框 placeholder 更新为 `"给 By Your Side 发消息，Enter 发送，Shift+Enter 换行"`。
   - `extension/src/background/index.ts`：划词上下文菜单更新为 `"问 By Your Side"`。
   - `shared/cast.ts` & `extension/src/content/cursor.ts`：默认 Lead 名称与光标名牌更新为 `"By Your Side"`。
   - `agent/src/prompt.ts`：系统提示词身份声明对齐 `"By Your Side"`。
   - `scripts/install-host.mjs`：伴随进程原生清单描述对齐 `"By Your Side 伴随进程"`。
2. **构建与真机验收**：
   - 全量 42 个测试文件、403 项测试通过，`npm run typecheck` 与 `npm run build` 绿。
   - `npm run reload:ext` 热重载成功；CDP 检查与截图确认 `chrome://extensions` 中扩展名称已直接显示为 **By Your Side 0.1.0**（截图存 `by-your-side-extension-card.png`）。

2026-09-07 Composer 附件瓷贴（方案 A · 复合上下文分层流 Context Ribbon）与多模态图片闭环落地（标准 `docs/evals/20260907-composer-attachments-v1.md`）。
1. **闭环架构落地**：
   - **协议层（shared/protocol.ts）**：定义 `ImageAttachment` 契约（`id`, `type: "image"`, `name`, `dataBase64`, `mimeType`）；扩充 `ClientMessage` (`user_message` / `steer`) 增加可选 `attachments?: Attachment[]` 校验；更新 `extension/src/relay.ts` 使 `PanelHistoryItem` 保留用户附件。
   - **伴随进程（agent/src/session.ts & main.ts）**：编写 `extractImages` 转换器，将消息附件转化为 Pi SDK 原生 `ImageContent[]`（`{ type: "image", data, mimeType }`），无缝传递给 `session.prompt(text, { images })` 与 `session.steer(text, images)`，打通多模态投喂闭环。
   - **后台服务（extension/src/background/index.ts）**：监听 `sidepanel_capture_tab` 消息，基于 `chrome.tabs.captureVisibleTab` 实现当前激活页安全视口截屏并返回 DataURL；用户消息投递历史中完整持久化 `attachments`。
   - **侧栏界面（extension/src/sidepanel/）**：
     - 落地方案 A 布局：顶部常驻 `PagePill` 与 `ask-cite`，下方紧随 `#attachments-strip`；
     - 1:1 精准复刻 Board UI 动效：56px Squircle 瓷贴、顺时针 SVG Accent Ring 进度描边（周长 194px）、右上角 9px 百分比数字、100% 达成时刻 9px 文字与关闭 ✕ 的原位 Blur Cross-Fade（Zero Layout Shift）；
     - 交互源完备支持：左下角 `+` 弹出 Action Sheet（📸 截取当前网页视口、📁 上传本地图片）、输入框 `Cmd+V` 粘贴图片、拖拽到 Composer 区域自动加入瓷贴；
     - 消息流渲染：用户消息气泡展示已发送附件缩略图，点击可直接查看原图。
2. **测试与质量状态**：
   - 42 个测试文件、403 项测试全部通过（通过率 100%）；
   - `npm run typecheck` 与 `npm run build` 全部零错误、零警告通过。

2026-09-07 借鉴 Board UI（Mertcan @sitenley）AI Composer 附件瓷贴动效（Composer Attachments）评估页落地（标准 `docs/evals/20260907-composer-attachments.md`，页面 `docs/evals/20260907-composer-attachments.html`，服务 `http://127.0.0.1:19907/20260907-composer-attachments.html`）。
1. **1:1 精准复刻推文 4 大灵魂动效**：
   - 56px Squircle 瓷贴（图片 cover 缩略图、文档类型彩色图标 + 9px 截断文件名）；
   - 顺时针 SVG Accent Ring 进度描边（沿 56px 圆角矩形边缘自 12 点钟平滑追踪）；
   - 右上角 9px 百分比实时非线性计数（0% → 100%）；
   - 100% 达成瞬间：数字原地 blur-out，关闭按钮 ✕ 同一精确坐标原地 blur-in（零位移 Zero Layout Shift）；
   - 多文件排队交错入场（Staggered queued landing）。
2. **结合 SideAgent 360px 侧栏环境的三种落地形态并排人选**：
   - 方案 A（推荐 · 复合上下文分层流 Context Ribbon）：顶部常驻活动页 PagePill 与划词引用，下方紧随 56px 附件流，输入框左下角 `+` 提供快速截取当前页/选择本地文件/粘贴板导入，层级职责最清晰；
   - 方案 B（全合一 56px 对象流 Unified Tile Stream）：将活动标签页与划词全部压缩为 56px 瓷贴并列，视觉极统但严重削弱侧栏当前页感知；
   - 方案 C（紧凑折叠抽屉 Compact Accordion）：平时仅一行微晶药丸计数（`📎 3 项附件`），点击或拖入时弹性向下展开。
3. **验证与状态机**：
   - 真实支持本地文件选择、拖拽（Drag & Drop）到任意输入框生成 56px 瓷贴、一键模拟截屏、重播动效、清空附件；
   - Playwright 无头自检通过（0 console errors），深色（Obsidian Slate）与浅色（Sequoia 晨曦微晶白）截图通过，服务运行于 19907 端口待人评。

2026-09-07 稳定化首轮开工（标准 `docs/evals/20260907-stability-foundation.md`，追踪 issue #1，首修 issue #2）。分支 `fix/stability-issue2-model-capability-labels`，base 2cd23a1。
1. 基线当次实测全绿：typecheck / test 385 / build / overlay-check / accept:browser / accept:team（ChromeMain 152.0.7977.82，扩展 fnbjglh… 在线）。
2. **模型能力标签纠偏（issue #2 / B1–B6）**：`modelReasoningMeta` 旧实现凭供应商与名称片段猜测能力——openai/openai-codex 一律「支持档位调节」、未匹配模型默认「极速直接响应」。9 月 6 日条目所称「真实档位体系」实为无证据推断，与本轮事实区分开：当前实现一律保守中性（`tag=null` 不渲染任何能力标签），反例矩阵 12 断言旧码全失败、新码全过；生产 bundle 三个捏造文案 0 次出现。能力标签待协议携带真实 runtime/SDK 元数据后再恢复，`tag-native/effort/direct` 样式类保留复用。
3. 真机证据：生产侧栏当前模型 MiniMax-M3（旧实现必显示「内置深度思考」）下芯片 tag `hidden=true`、全页无可见能力标签。切换失败状态未在真机主动触发（避免扰动用户会话），由 modelState 仅随 `model_info` 更新的机制保证；亮暗/窄宽目测待人评。

2026-09-06 借鉴 CollectUI Arek AI chat bar 动效与真实思考档位评估页落地（标准 `docs/evals/20260906-chat-bar-morph.md`，页面 `docs/evals/20260906-chat-bar-morph.html`，服务 `http://127.0.0.1:19906/20260906-chat-bar-morph.html`）。
1. **严格绑定真实模型能力**：彻底推翻视觉样张中全量硬编码 Medium/High 的假象。MiniMax-M3 明确标为「内置深度思考 · 1M 上下文」（不可调）；GPT-5.6/o3-mini 提供真实 `[Low] [Med] [High]` 档位切换；Kimi for Coding 标为「代码极速 · 直接响应」（无思考）。
2. **三种具体形变形态并排对照**：
   - 方案 A（推荐）：底部芯片原位液态舒展（保持大输入框习惯，左下药丸作为形变种子向上膨胀，选后如液滴平滑归位）；
   - 方案 B：左侧独立胶囊裂变（对齐参考图单行 Chat Bar，左侧整颗胶囊向上裂变）；
   - 方案 C：Composer 一体化折叠抽屉（机械拉伸展开，非悬浮 popover）。
3. **底部 Ambient Glow 灵动胶囊**：实现翠绿就绪、琥珀接管、绯红危险确认、冰蓝并行采集 4 态光晕呼吸过渡。
4. **修复浅色模式割裂与诡异色差**：
   - 根因 1：底部 Ambient Glow 胶囊与发送键硬编码暗色导致「一块白一块黑」；
   - 根因 2：思考标签（`tag-native`）使用了暗色专用的粉紫粉调 `#d8b4fe`，在白底下泛白发粉严重失真；思考档位分段器（`effort-segmented`）写死了 `rgba(0,0,0,0.25)` 暗灰底色，在白底行中如同烧焦的污块；芯片激活态（`morph-seed-chip.active`）泛蓝底色与紫色标签冲撞产生泥浆色感；卡片投影在亮色下透黑过深。
   - 修复：全面引入双模式语义化高对比度变量：亮色下 `tag-native` 调整为高贵清晰的深紫 `#6d28d9` 配柔和紫底；档位分段器改为精致冷灰胶囊配苹果蓝激活态；芯片激活态保持洁净白底 + 苹果蓝微晶描边；卡片投影采用高透柔和景深。
5. **验证**：Playwright 无控制台报错，深浅色自检截图过。服务运行于 19906 端口待人评。

2026-09-05 路线图「选中即问」第一刀落地：划词/右键把正文带进侧栏（标准 `docs/evals/20260905-select-and-ask.md`）。
1. 路线图原句是「调起 Agent，带页面上下文问答」。第一刀：选区旁一粒「问」+ 右键「问 SideAgent」；侧栏出引用胶囊，输入框空着等你打问题，不自动发。
2. 评审页后来的 Sider 方向（答案先贴在选区旁）没做，是下一刀。
3. 协议 `PageContext.selection`；`content-ask.js`；session 交接；composer `#ask-cite`。
4. 待人评：维基划词。需 reload 扩展。

2026-09-05 选中即问评审页按 Sider 重做（标准 `docs/evals/20260905-select-and-ask.md`，页 `docs/evals/20260905-select-and-ask.html`）。
1. 用户说上一版例子太一般，点名 Sider。Sider 官方：阅读菜单 / 写作菜单 / ⌘J 问 AI；答案贴在选区旁；追问才进侧栏。
2. 判断改成 3 件：答案先出现在哪；浮层带几件事；写作菜单做不做。
3. 人选 A。生产：选区旁「问 / 解释」；答案贴在页上；「在侧栏继续」才把引用送进 composer。解释走 user_message/steer + selected text，prompt 禁止为此调工具。右键/⌘J 打开页上「问」。待人评真机。

2026-09-05 用户转向 Reicon 形「M」小精灵（标准 `docs/evals/20260905-reicon-m-composer.md`，页 `docs/evals/20260905-reicon-m-composer.html`，服务 `http://127.0.0.1:19905/20260905-reicon-m-composer.html`）。
1. 上一轮 SVG 拼贴 / 煤球猫大福 / 像素手套被判丑。用户给了 https://reicon.dev/：官网那个 R 是单色胖字母剪影 + 两只镂空竖眼，要求把 R 做成 M。
2. 用户截图 A 版趴框：「其实这个效果已经相当不错了」，同时要更圆、眼睛多几版。
3. 评审页改成左边换皮、右边一只输入框。形体三档：现在这版 / 圆角 V（推荐） / 再胖一点。眼睛五档：胶囊 / 官网眼（推荐） / 细长 / 靠拢 / 圆点。太圆的 blob 在 36px 读成 n，已拿掉。
4. 用户点头「圆角 V + 官网眼」，已落地生产：`extension/src/sidepanel/companion.ts`。沿顶沿分段走、跳前先蹲、长消息惊讶、闲时休息多于乱动。typecheck / companion 8 测 / build 绿。需 reload 扩展。

2026-09-05 Lil Pix 伴侣落地生产（标准 `docs/evals/20260905-lil-pix-composer.md`，harness `docs/evals/20260905-lil-pix-prod.html`）。
1. 用户确认 HTML **方案 A：Rauno 原版微像素终端**（不是小煤球 SVG）。精灵图在 `extension/assets/companion/`。
2. 闲时静止趴在 Composer 顶沿、避开页面胶囊；打字倚靠；发送护航到用户气泡左侧外沿；步骤卡趴左上角外沿；摸头是 `grab` 下压 + 弹簧回弹，**没有悬浮手套**。
3. 历史回放不巡游。几何单测 + Playwright 截图：idle/lean/send/step 与气泡内文不相交。待人评真机手感。
4. 机器：371 tests / typecheck / build 绿。需 reload 扩展。

2026-09-05 侧栏界面层重构与苹果 Liquid Glass + 灵动 Motion 正式落地生产代码（标准 `docs/evals/20260905-agent-ui-evolution.md`，开发日志 `docs/devlog/20260905-04-侧栏界面层重构与苹果毛玻璃动效落地.md`）。
1. **核心设计定力全面落地**：
   - 贯彻 **「Glass 用来表达层级，Motion 用来表达状态」**。
   - 彻底剔除刺眼生硬的蓝底渐变（`#2563eb`），用户消息改用纯净坚实微晶卡片（Solid Surface），消除泛白廉价感，保障长文阅读对比度。
2. **6 大关键位置全量生产实现**：
   - **Send `↑` / Stop `■` 原位形变按钮**：单一 DOM 原地承载状态演进，圆角由 50% 弹簧缩至 9px，颜色变 Apple Red，图标自旋溶解，空间重心毫厘不移。
   - **页面感知胶囊 (Context Pill) → 检查器 (Morphing Sheet)**：输入区顶端内嵌当前标签页 Favicon 与标题，点击在原地液态舒展展开为检查器面板，关闭时自然回缩。
   - **Model Picker 弹簧生长选择器**：左下角锚点弹性生长，配合高质感磨砂与厂商标识。
   - **Liquid Glass 顶栏 + Dynamic Island 灵动状态指示器**：SVG 光学折射滤镜（`feTurbulence` + `feDisplacementMap`）真实透镜高光，状态胶囊动态伸缩与呼吸心跳，深浅模式严格对比度保证。
   - **平滑步骤抽屉与兄弟节点推挤**：测量实际高度，展开带有物理阻尼，消灭原生 details 瞬间突变。
   - **macOS Alert 危险确认卡**：敏感不可逆操作拦截卡带有触感按压物理。
3. **架构与工程完备性**：
   - 零 React/外部庞大运行时引入，保持纯原生 TS + DOM + CSS，编译产物仅 257KB。
   - 39 个测试文件、366 项测试全绿，typecheck / build / reload 全过，CDP 真机走查深浅色截图均无控制台报错。

2026-09-05 深度吸纳开源 Liquid Glass 与 Motion 核心动力学：**真正物理级折射与 6 大连续性 Motion 原型落地**（标准 `docs/evals/20260905-agent-ui-evolution.md`，页面 `docs/evals/20260905-agent-ui-evolution.html`）。
1. **彻底扭转认知偏误**：摒弃“全屏无脑假 blur”的廉价毛玻璃风，落实核心铁律——**「Glass 用来表达层级，Motion 用来表达状态」**。
   - **Glass 属于顶层 Chrome**（Topbar、浮动 Composer Dock、弹窗 Sheet 享有 SVG `feDisplacementMap` 边缘折射与高光）；
   - **正文坚实纯净**（消息流采用 Solid 介质，彻底杜绝刺眼大蓝底与泛白，保证 100% 阅读舒适度）；
   - **Motion 属于生命周期动态**（苹果感源自不可断裂的空间连续性与惯性质量）。
2. **标定并实现 6 大关键改造点（已在 HTML 原型实装并可交互测试）**：
   - 位置 1：**Send `↑` / Stop `■` 原位形变按钮**（Motion Shared Layout，单元素受压下沉，圆角从 50% 弹簧变 9px，箭头旋转溶解为方块，重心不移）；
   - 位置 2：**页面感知胶囊 → 检查器原形舒展**（Motion Primitives Morphing Dialog，胶囊自身原地液态放大铺开，关掉时回缩）；
   - 位置 3：**Model Picker 弹簧生长选择器**（从输入框左下角锚点物理弹簧弹性缩放生长）；
   - 位置 4：**Liquid Glass 顶栏 + 灵动状态胶囊**（SVG 物理折射与高光棱边，状态珠随 idle/thinking/acting/hold 灵动伸缩与心跳）；
   - 位置 5：**步骤抽屉弹簧推挤与兄弟节点自然排开**（测量真实 scrollHeight，展开平滑推挤下方元素，具有重力与阻尼）；
   - 位置 6：**危险操作拦截卡 (macOS Alert Sheet)**（抽屉微滑弹升起，带 60ms 触感下沉物理）。
3. **守规状态**：生产代码 `extension/src/` 保持干净零污染，机器走查（Playwright 截图与状态测试）全过。

2026-09-05 真实 ChatGPT 任务后台日志排障与修复完成：**点击健壮性防御 + 就地确认拿住兜底**（标准 `docs/evals/20260905-click-robustness-and-hold-fallback.md`）。
1. **彻底消除 `reading 'x'` 崩溃**：排查实测中 Chrome `chrome.scripting.executeScript` 吞没 content script 异常返回 `{ result: null }` 的深层坑，在 `input.ts` 的 `click`/`fill`/`mark` 中采用安全的页面执行结果包裹与多重断言，页面未找到目标元素时直接向外报明确业务错误，绝不裸抛 `Cannot read properties of null (reading 'x')`。
2. **危险操作词表扩充**：`isDestructiveLabel` 与 `confirmLabelForDestructive` 正式支持 `归档` / `archive`，伴随进程 `prompt.ts` 同步纳入 `archive` / `归档` 引导。
3. **`mark` 语义兜底拿住**：针对模型调用 `mark` 未显式带 `actions` 但称“光标已停在上面”的幻觉，新增 `resolveImplicitMarkActions`。当 label 包含确认意图（以 `待` 开头如 `待归档`、`待删除` 或命中危险词）时，自动推导确认与取消双键并触发 `holdInst` 就地拿住，杜绝页面光标留在原位。
4. **拿住态锚点容错**：`relayoutHolds` 去除因 AX ref 无法反解而将光标直接置为 `hidden` 的缺陷，无锚点时保持在 `hold.point` 维持可见拿住姿态。
5. **回归状态**：全量 366 tests / typecheck / build / overlay-check / git diff --check 全绿。

2026-09-05 像素伴侣「lil pix」深度演进：**真实物理弹簧手感 + 边框爬行游走系统 + 超萌生命感重构**（标准 `docs/evals/20260905-lil-pix-composer.md`，页面 `docs/evals/20260905-lil-pix-composer.html`）。
1. **自然感根源落实**：深入剖析 Rauno Freiberg《Invisible Details of Interaction Design》的 Kinetic Physics 动能物理与 Direct Manipulation。光标采用原生直接操纵（`grab/grabbing`，消除像素手套杂乱浮框），直接身体下压（Mousedown 60ms 刚性压扁 `scale(1.32, 0.60)` + 享受眯眼 `^ ^`）；松手释放积蓄势能，触发真正的 Spring Overshoot 弹簧过冲（`translateY(-22px)` 离地浮空起跳 + 兴奋星光眼 `✦ ✦`），再经重力与阻尼残余反弹落地，消除塑料假滑感。
2. **“A太丑了”视觉彻底重构**：推翻蓝色塑料电视机天线 GrokBot，重构为 3 款高治愈度萌系生物并支持一键换皮：
   - 🐾 **纯正小煤球 (Pure Lil Pix Ink Soot) · 强烈推荐**：宫崎骏灰尘精灵 / 灵动墨团，高级石墨黑圆团 + 柔软云朵轮廓 + 水汪汪清澈双高光大眼 + 软萌粉颊 + 真实搭在输入框顶沿的小肉爪（Paws on rim）；
   - 🐱 **探头小黑猫 (Peeking Shadow Neko)**：微翘猫耳 + 翡翠绿眸 + 樱花粉耳窝 + 雪顶白手套小爪；
   - 🍡 **奶白大福团 (Bouncy Mochi Bun)**：软糯奶白团子 + 萌系兔耳 + 樱花粉腮红与小白爪。
3. **边框爬行与绝不遮挡文字**：把输入框顶沿与各消息气泡的外轮廓（Outer Rim / Border Rail）连接成专属跑道。用户发送消息时小人快步跑动护航；Agent 生成时小人趴在气泡顶沿探头关注流式输出；生成完成在拐角欢呼小跳。严格通过 Safe Boundary 红线约束：全身位于外部轨道（`-32px`），内部文本区遮挡率为 0%。
4. **守规状态**：生产代码 `extension/src/` 保持干净零污染，机器走查（Playwright 截图、换皮交互、Console 0 error）全过。服务运行于 `http://localhost:19890/20260905-lil-pix-composer.html`。

2026-09-05 用户判定：**轨迹回放不重要，降优先级**（ROADMAP 已标）。就地确认走「一体」方向：人选 **C 案（手拿住目标，双键在光标名牌上）**，判断页 `docs/evals/20260905-one-hand-confirm.html`。C 案已实现（`04a950d`）：held 拦阻与模型 mark 两条路径同一形态、两轮确认断点已修、侧栏「取消」收敛、拿住跟滚动；357 tests / typecheck / build / overlay-check 全绿，校验已独立复跑。待人评：flomo 删「MiroFish 项目」真机（标准 9），需 reload 扩展 + 伴随进程重连。未决：拿住态名牌保持成员色 vs HTML C 列 pill 整体变红，人评裁决。

2026-09-05 最新：交还恢复可靠性子任务机器项全绿（标准 `docs/evals/20260905-handback-restore-reliability.md`，341 tests / typecheck / build / overlay-check 全过，独立校验复跑确认）。待人评：面板失败文案真机观感 + 双 Wikipedia 交还回归（需 reload 扩展）。下一步候选：就地确认/轨迹回放人评，或路线图「选中即问」。

2026-09-04 第二个 Grok 开始独立任务：建设真实浏览器任务验收跑道，只能改 `scripts/acceptance/**`、本地 fixture、聚焦测试，必要时只给根 `package.json` 加一个命令；禁止碰 `extension/src/**`、`agent/src/**`、`shared/protocol.ts`。标准：`docs/evals/20260904-real-browser-acceptance-lane.md`。Codex 独立重跑并验收。

2026-09-04 接管/交接开始。角色已锁：Codex 写标准并独立校验，Grok 只实现，用户做人评。v1 只做单 Agent、单标签页：接管后执行层硬停；交还时读取当前活动页和新 snapshot，同一会话继续。标准：`docs/evals/20260904-takeover-handoff-v1.md`。实现不得修改标准；生产界面先过 Will's S + 临时 HTML 人选。

两份标准已锁定，对照画面已定。实现不能改判定条件。就地确认：`docs/evals/20260904-on-page-confirm-done.html` 右边 + `20260904-on-page-confirm.md`。轨迹回放：HTML 第 1 列页上重演 + `20260904-trace-replay.md`；产品未改、未开工。

工作怎么分：新想法放大之后进路线图，路线图一次做不完。一次能修完的小问题当场修。下面两列对照路线图和未勾完的标准。

### 已定要做、还没做完（路线图，一次做不完）

- **就地确认**（本轮，实现已改执行层）：要点「删除 / 清空 / 支付 / 发送」时先不真点，框外双键；点删除或侧栏「确认」才执行。机器：201 tests 绿。待人评同一条 flomo 删除。标准：`docs/evals/20260904-on-page-confirm.md`
- 操作轨迹回放：标准已锁（页上重演）。实现：点击/填写记文档坐标；空闲时说「回放」在原标签页按浅弧再飞，不点真页面、不撤销。无胶片、无常驻线。待人对照 HTML 第 1 列。标准：`docs/evals/20260904-trace-replay.md`
- 选中即问
- 技能录制 / 页面哨兵 / 多标签编排
- 接管/交接：v1 已开始，标准 `docs/evals/20260904-takeover-handoff-v1.md`

### 已经在做、还不满意

- 有名字的人：名册和形象已落地；连续 js 没收成一条、等待词表、Lead 完成后的空执行块、双站点人评还开着。标准：`docs/evals/20260904-cast-and-wit.md`
- 执行块布局（人第一眼、chip 从属）。标准：`docs/evals/20260904-run-layout.md`
- 光标浅弧：机器绿，真机点击人评未过。标准：`docs/evals/20260904-cursor-path.md`
- 当前页感知：人评未过。标准：`docs/evals/20260904-当前页面感知.md`
- 插话后不换页：机器绿，真机未过。标准：`docs/evals/20260904-steer-cursor-residue.md`
- 危险确认：主路径过人评；含糊回复、普通点击未测
- 圈画内部滚动：轻拖过了，长列表压力测试还开着

2026-09-04 协作协议改完：完成标准必须在动手前由校验写，实现不能自己定「什么叫做完」。三个角色：校验 / 实现 / 编排。见 `AGENTS.md`、`docs/METHODOLOGY.md`。

2026-09-04 就地确认人评未过（标准：`docs/evals/20260904-on-page-confirm.md`）。flomo 删「MiroFish 项目」：页面无框外双键；14 次 `mark` 全无 `actions`，目标是走查页 h2（`❌ 立案后空壳帧` 等），切到 flomo 后只点站点「更多 → 删除」并在侧栏等「确认」。扩展 overlay 这轮没被调用。下一步：收紧 prompt（危险确认必须对当前目标 `mark`+`actions`，禁止打开站点删除菜单冒充就地确认），必要时补当前页感知。

2026-09-04 光标轨迹人评浅弧（截图 `20260904-cursor-path.html` 中列）。落地：`cursor-path.ts` Fitts 220–480ms + easeInOutCubic + 一侧弧 spread clamp(12%D,8,36)；闲着停角落（Lead 左上、第二人右上），点/填完 `park`；去掉 3s 隐掉。产品改 `cursor.ts` / `input.ts`。不采用随机、过冲、拖尾、perfect-cursors。

2026-09-04 光标存在感：用户要闲着待左上/右上、要点再飞过去点。先 HTML，不改产品。卡 `docs/evals/20260904-cursor-perch.md`，页 `docs/evals/20260904-cursor-perch.html`（8766）。对照 Apple Motion / NNGroup 动效 / Live Activity / Emphasize by de-emphasizing。现状仍是点完 3s `opacity:0`。

2026-09-04 feat/small 已 fast-forward 进 main（`dd7eb39`：输入区模型选择 + 并行工人底座 + 点击不抢 Space）。主线上仍有未提交 WIP：当前页感知 / overlay / steer 光标残留 / METHODOLOGY / mark 内部滚动跟随。Chrome 加载 `Desktop/ego/extension/dist`；native-host 需 `npm run install:host` 指回 ego。

上一项：2026-09-04 mark 圈画在内部滚动容器里漂移（标准：`docs/evals/20260904-mark-nested-scroll.md`）。机器项已过，待人评 flomo 笔记列表拖动。

上一项：2026-09-04 点击不再拽 macOS Space（标准：`docs/evals/20260904-no-space-steal.md`）。

上一项：2026-09-04 真机维基+飞书 Lead 未 spawn，已加硬性 prompt + Coordinator 提醒。

上一项：2026-09-04 模型选择改到输入区（标准：`docs/evals/20260904-model-picker-composer.md`）。

下一件：就地确认（标准：`docs/evals/20260904-on-page-confirm.md`）。人选框外双键。机器项已绿（183 tests + overlay-check）。待人评：flomo 删笔记时框外点删除/取消，侧栏打确认仍可用。伴随进程需重连才吃到新 prompt。

接管/交接用户确认按 B（`docs/evals/20260904-takeover-handoff.md`）：运行中随时拿过来，还回去读当前页接着干。现在不实现。下一件：就地确认。

上一项：2026-09-04 危险操作确认人评过（标准：`docs/evals/20260904-dangerous-confirm.md`）。场景：flomo 删「MiroFish 项目」笔记，Agent 说清对象+回收站后果后停住。路线图该项已勾；硬闸门不做。

上一项：2026-09-04 并行工人底座人评过（标准：`docs/evals/20260904-parallel-workers.md`）。场景：B 站抓视频评论 ∥ 写入 Formal 笔记，两页同时干活。原维基+飞书未再跑，同构任务替代。路线图「多任务并行」已勾。设计另开标准 `docs/evals/20260904-cast-and-wit.md`。点击不抢 Space、输入区模型选择均已人评通过。

**WIP 未提交（原 main 工作区）**：`docs/evals/20260904-steer-cursor-residue.md`、当前页感知、`docs/METHODOLOGY.md`。详见文末对应节。

教学模式已按实测反馈重设计（标准：`docs/evals/20260903-teach-revamp.md`）。侧边栏执行步骤信息流重设计（标准：`docs/evals/20260903-panel-steps-design.md`）。

上一项（操作前元素高亮，卡：`docs/evals/20260903-element-highlight.md`）：click/fill 执行前呼吸高亮框，机器项全绿，待用户实测手感。

## 关键结论与决策（CDP AX 快照）

- **snapshot 走 `Accessibility.getFullAXTree`**（`exec/snapshot.ts`），ax→text 纯转换层在 `extension/src/background/axtree.ts`（ignored 折叠、无名 generic 折叠、50K 截断、link/iframe 带 url= 注解）。debugger 不可用/AX 失败时回退旧 DOM 快照并在首行标注。
- **ref 即 backendDOMNodeId**（不再自编号），`background/axstate.ts` 只存 per-tab 已输出 ref 的集合做校验（`recordAxSnapshot`/`isAxRef`，导航即作废）；click/fill 的 `@N` 走 `DOM.resolveNode` + `Runtime.callFunctionOn`（坐标/fill 逻辑与 domops 同语义），`loc=`/裸 CSS 仍走 domops。
- **OOPIF 跨域 iframe 未做**（需 Target.attachToTarget flatten 子会话，二期）；跨域 iframe 仍是占位行。
- 输出不再有 loc=css 定位串（AX 路径下靠 backendNodeId；DOM 回退时才有 loc=）。
- 排障利器：Chrome 带 `--remote-debugging-port=9222` 时可 CDP 直连扩展 SW/面板页做探针（connectNative 测试、读面板 DOM）。
- **远程重载扩展**：`npm run reload:ext`（`scripts/reload-ext.mts`）。实测三个坑：① 外部直接开 `chrome-extension://` 页会被 Chrome 拦（ERR_BLOCKED_BY_CLIENT），临时扩展页调 `chrome.runtime.reload()` 此路不通；② 已开久的 chrome://extensions 标签会被冻结，evaluate 挂起无响应——必须新建标签（新渲染进程）再点；③ Chrome 152 的 reload 按钮 id 是 `#dev-reload-button`（旧版 `#reload-button`）。
- **纯 CLI 装扩展不可行**：`chrome.developerPrivate.loadUnpacked` 已删 path 参数（安全考虑），只能调无参版弹目录选择框让用户选。扩展被删后的恢复路径 = 弹框选 `extension/dist`。

## ego-browser 移植要点（2026-09-03 运行时探测）

- ego 的 snapshot 编译在框架内、源码不可得；行为约定靠运行时探测：ref 用稳定 backendNodeId、link 带 url=、输出不截断（380KB 照吐，靠 scope 控范围）、canvas/富文本走视觉工作流、写入前先 write-probe。前三条已搬进我们的实现。
- loc= 规则：a[href]→`loc=href:`、表单控件→`loc=css:tag[attr=]`、其余标 unstable（id/class 一概不用）。本期没搬 loc 生成（AX 树拿不到属性来源，需 DOM 往返太贵）。
- 站点经验包位置：`/Applications/ego lite.app/Contents/Resources/ego-skills/ego-browser/learnings/{github,google,x-com}/`（manifest.json + notes/*.md + 短提取脚本，browserTools/nodeTools 二分）；运行时 siteSkills() 实测返回空，属种子示例——路线图「站点经验工具包」的参考格式。

## 关键结论与决策（native messaging 改造）

- **传输架构**：panel ⇆（runtime Port，`extension/src/relay.ts` 定义信封）⇆ background SW ⇆（native port 优先 / ws 回退，`extension/src/background/uplink.ts`）⇆ 伴随进程。tool_call 由 background 直接执行不回面板——关面板任务不断的收益由此而来。
- **agent 双模式**：默认 stdio native 模式（stdout 只写协议帧，日志走 stderr + `~/.sideagent/agent.log`）；`--ws` 保留旧 WS+token 调试通道。stdio 帧 = 4 字节 LE 长度前缀 + JSON（`agent/src/transport/stdio.ts`）。
- **配置**：`~/.sideagent/config.json` 读 model/proxy（`agent/src/config.ts`），CLI 参数优先。
- **安装**：`scripts/install-host.mjs` 从 manifest key 推扩展 ID，生成 `agent/native-host.sh`（gitignored）+ 写 host manifest 到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.sideagent.host.json`。
- **SW 生命周期假设（待真机验证，验收条目 4）**：开着的 native messaging port 应能阻止 MV3 service worker 闲置回收；若不成立需加保活或接受重连丢会话。
- 面板重开能看到后续事件流，但**历史对话不回放**（事件没有持久化）——若用户要历史回放另开任务。

## 关键结论与决策（MVP）

**架构**：扩展（side panel 持 WS + background 执行层 + content script 快照）⇆ 本地伴随进程（Pi SDK，`noTools:"builtin"`，13 个浏览器工具经 WS RPC 转发执行）。协议权威定义 `shared/protocol.ts`，流程见 `docs/protocol.md`。

**Pi SDK 0.84.4 事实**（以 node_modules .d.ts 为准，网上教程不可信）：

- `AuthStorage` 未从包根导出；用 `ModelRuntime.create()`（默认读 `~/.pi/agent/auth.json` + 环境变量）。
- 工具结果 `content: (TextContent | ImageContent)[]`，ImageContent = `{type:"image", data: base64, mimeType}`——截图可直接回传模型。
- `defineTool` execute 签名 `(toolCallId, params, signal, onUpdate, ctx)`；参数 schema 用裸包名 `typebox`。
- `agent_end` 事件带 `willRetry`（自动重试中须保持 running）；最终失败的真实错误在最后一条 assistant 消息的 `errorMessage` 字段（已透传到面板+终端）。

**网络/代理（实测）**：

- pi-ai 请求走 `globalThis.fetch`，默认直连，不读系统代理环境变量。
- `--proxy <url>` 显式挂 undici ProxyAgent 解决 openai-codex 的 `fetch failed`（直连被断）。
- **不要**默认挂全局 dispatcher（EnvHttpProxyAgent）：实测干扰 kimi-coding 流传输导致空响应。
- kimi-coding/k3 间歇性空响应（200 但无内容，限流特征）；`kimi-coding/kimi-for-coding` 稳定，优先用它。空响应已加面板兜底提示。

**环境坑**：npm 可选依赖 bug——`@rolldown/binding-darwin-arm64` 可能漏装导致 vitest 起不来；重装依赖后若复发：`npm install --save-dev -W @rolldown/binding-darwin-arm64`。

## 未决问题

- 2026-09-03：Chrome 重启后扩展一度消失（疑似清理旧 ID 时两个 SideAgent 条目都被删了——Secure Preferences 只剩骨架条目，`getExtensionsInfo` 查无此 ID）。已通过 loadUnpacked 目录选择框装回，ID 不变（`fnbjglhppbkgmjeehablkfilmmefjolo`）。旧 ID `efpbhk…` 已无实体，chrome://extensions 里找不到是正常的。
- **排障记录 2（Native host has exited）**：wrapper 放 `~/Desktop/ego/agent/` 时被 macOS TCC 拒——内核日志 `System Policy: bash deny(1) file-read-data .../native-host.sh`（Chrome 无「桌面」文件夹权限，bash 作为其子进程读 Desktop 脚本被拒；但 node 读 Desktop 上的 tsx/main.ts 未被拒，实测可跑）。修复：wrapper 装到 `~/.sideagent/native-host.sh`。排障关键手段：Chrome 带 `--remote-debugging-port=9222` 时用 CDP 直连扩展 service worker / sidepanel 页面做 connectNative 探针 + 读面板 DOM 状态。
- 用户 Chrome 是 `--user-data-dir=.../ChromeMain` 启动的自定义 profile；`npm run install:host` 现在自动探测运行中 Chrome 的 user-data-dir，标准目录+ChromeMain 都会装。
- 排障期间发现 SW target 会频繁消失（SW 秒级回收？），注意验收条目 4（空闲 5 分钟）。
- 凌晨 2:55 残留一个旧代码的 `tsx agent/src/main.ts --model ...`（ws 模式，占 7758）进程（pid 5547/5548），建议用户杀掉，避免 ws 回退连到旧代码。
- native messaging 验收待人评：条目 1（真机端到端）、2（进程生命周期）、3（关面板任务不断）、4（空闲 5 分钟 SW 回收）、10（ws 调试模式回归）。
- 完成标准条目 8「真机操控成功率与手感」已人评：中等——交互/设计/视觉反馈很差，但用户明确先搞功能，UX 项挂路线图。
- 路线图：CDP Accessibility 快照升级（深层 iframe）、站点经验工具包移植、模型选择 UI、交互/视觉反馈优化、商店发布。

## 2026-09-03 扩展 logo
- 新 logo 来源：~/Downloads/ChatGPT Image 2026年9月3日 16_04_52.png（线稿机器人+浏览器窗口）
- 改动：新增 extension/icons/{16,48,128}.png；manifest.json 加 icons + action.default_icon；build.mjs 拷贝 icons/ 到 dist
- 完成标准：docs/evals/20260903-logo.md；build/typecheck 已绿；工具栏实际显示效果待人评

## 2026-09-03 Agent 虚拟鼠标 overlay
- 需求来源：用户提供的 ChatGPT 插件截图（页面内可见虚拟鼠标+调试横幅）
- 新增 extension/src/content/cursor.ts：window.__sideagent.cursor={move,click,hide}，closed shadow DOM，箭头 SVG+光晕+波纹，idle 3s 自动隐藏，首次出现直接落位不做长距滑动
- input.ts click 流程：算出 point 后先 ensureCursor + move(await 300ms) + click 波纹(await 150ms) 再走 CDP/domops 真实点击；驱动失败静默兜底
- build.mjs 加 content-cursor IIFE 入口；sideagent.d.ts 加 SideAgentCursor 类型
- 完成标准 docs/evals/20260903-cursor-overlay.md；typecheck/build/test(56) 全绿；无头 Chrome 静态渲染自检通过
- 待人评：真实任务中的移动/波纹/自动隐藏观感

## 2026-09-03 侧边栏 UI 重设计
- 选型：marked 18 + dompurify 3 + lucide 1.39（装到 extension workspace），保持 vanilla TS+DOM 无框架
- main.ts 渲染层重写：assistant 消息流式 Markdown（累积原文→marked.parse→DOMPurify.sanitize，链接强制 target=_blank）；工具卡加 lucide 扳手图标+状态 pill（运行中/完成/失败）+参数折叠；thinking 加 Brain 图标；composer 圆形发送/停止按钮（运行时隐藏发送键）；textarea 自适应高度(≤140px)
- styles.css 全量重写：CSS 变量 tokens（bg/surface/text/border/accent/圆角/阴影），prefers-color-scheme 暗色，顶栏毛玻璃+状态 pill，用户气泡右对齐蓝色，assistant 全文宽 markdown 排版
- 完成标准 docs/evals/20260903-sidepanel-redesign.md；typecheck/build/test 全绿；无头 Chrome 截图自检通过（注意：无头最小窗口宽 500px，--window-size=380 会被忽略导致布局裁切假象）
- sidepanel.js 体积 8.3kb→136kb（marked+dompurify 打进 bundle）
- 待人评：暗色模式观感（CLI 无法模拟 prefers-color-scheme，未截图验证）、流式 markdown 重渲染闪烁程度

## 2026-09-03 侧边栏组件精修（第二轮）
- 思考块：流式期间 details open + summary "正在思考…" shimmer 渐变动画 + Brain 图标脉动；closeBlocks 时自动折叠并落定"思考过程"（main.ts 新增 currentThinkingDetails 跟踪）
- 工具卡：TOOL_ICONS 按名映射 lucide 图标（click→MousePointerClick、fill→PenLine、type/key→Keyboard、scroll→ArrowDownUp、snapshot→ScanSearch、screenshot→Camera、js→CodeXml，兜底 Wrench）
- 气泡：用户气泡改 135deg 渐变 + 品牌色投影；assistant 流式期间末尾 ▍ 闪烁光标（.streaming::after）
- 动效：消息/卡片入场 rise 上浮淡入 0.18s；prefers-reduced-motion 全部禁用
- 完成标准 docs/evals/20260903-sidepanel-polish.md；typecheck/build/test(56) 全绿；无头截图自检通过

## 2026-09-03 虚拟鼠标样式重做
- 用户反馈：旧光标（黑色线稿箭头+蓝色大光晕）丑；要求参考优质开源项目
- 参考：tldraw 协作光标（彩色箭头+白描边+名牌 pill）、ChatGPT Agent（点击波纹）、cdpilot（fake cursor+ripples）；箭头形状用 lucide MousePointer2 path
- cursor.ts 视觉重写：27px 品牌蓝箭头+白描边+drop-shadow，旁边 "SideAgent" 名牌 pill；点击=按下缩放(scale .8/160ms)+双层交错波纹；缓动改 cubic-bezier(.22,1,.36,1)；去掉旧 halo
- 技巧：svg 负偏移让箭头尖端对齐 translate 原点（overflow:visible）
- 完成标准 docs/evals/20260903-cursor-restyle.md；typecheck/build/test 全绿；无头截图双底色自检通过
- 后台日志说明：项目无落盘日志，background 日志只能在 chrome://extensions 的 Service Worker 控制台查看

## 2026-09-03 高交互性：steer 提示 + 多实例光标
- 新增 docs/ROADMAP.md：操作前高亮/教学模式/轨迹回放/确认卡/接管/并行任务/技能录制/页面哨兵/多标签编排
- steer 链路确认已通（sidepanel running→steer → agent session.steer Pi SDK）；补 UX：运行中输入框 placeholder 变"插话：调整 Agent 的方向…"
- cursor.ts 重构多实例：ns.cursor.for(id) 返回实例专属光标，PALETTE 5 色按序着色，名牌显示 id；默认 main/SideAgent 蓝色不变；颜色经 CSS var(--c) 下发
- 完成标准 docs/evals/20260903-interactivity.md；typecheck/build/test 全绿；双光标截图自检通过
- 待做（路线图）：agent 侧多 session 并行编排需协议加 session 路由

## 2026-09-03 操作前元素高亮（呼吸高亮框）
- 需求来源：让用户看清"Agent 找对地方了"，在 click/fill 执行前圈出目标元素，避免误触与黑盒感
- overlay 渲染层 (`cursor.ts`)：
  - 扩展 `window.__sideagent.cursor.highlight(rect)`，复用 cursor overlay 的 closed shadow DOM
  - 样式：`border: 2px solid var(--c)` + `background: color-mix(in srgb, var(--c) 12%, transparent)` + 外反差白边与实例色双重光晕，在深浅色背景均具有清晰边界
  - 动效：`highlight-breathe` 500ms 脉动 2 次（0% -> 20% -> 45% -> 70% -> 100%），结束后触发 `animationend` 自动 `remove()`，带 650ms 超时兜底与 `hide()` 清除，不留残影
  - 多实例支持：按实例 `inst.highlightEl` 独立管理，着色跟随实例调色板（默认 #2f6fed 蓝，worker-red #e2554f 红等）
  - **重要排障**：修复了 `host.attachShadow({ mode: 'closed' })` 导致 `host.shadowRoot` 外部访问为 null 的问题，模块内持久保留 `shadow` 根引用供动态实例挂载
- 执行层集成 (`input.ts`)：
  - 新增 `rectOfBackendNode(tabId, backendNodeId)`：在 AX 快照路径下以 `scrollIntoView` 后通过 `getBoundingClientRect()` 取精确视口包围盒
  - `click`：解析出 `targetRect` 后优先调用 `cursor.highlight` 并 await 500ms，随后驱动光标 `move` (300ms) + `click` 波纹 (150ms) + 真实派发点击
  - `fill`：在原生/domops 填充前解析 `targetRect`，调用 `cursor.highlight` 并 await 500ms，随后派发填值
  - 健壮性：高亮及光标注入均在 `try/catch` 保护下，受限页面（如 chrome://）静默跳过，主流程不受阻
- 验证：
  - 完成标准 `docs/evals/20260903-element-highlight.md`，新增测试 `extension/test/highlight.test.ts`
  - `npm run typecheck` + `npm test`（60 tests）+ `npm run build` 全绿
  - 无头 Chrome CDP 运行自检截获峰值帧（`element-highlight-peak.png`）与结束清理帧（`element-highlight-finished.png`），深浅底色与多实例均完美通过
  - `npm run reload:ext` 热重载生效；待用户实测人评点击/输入手感


## 2026-09-03 mark/clear_marks 标注工具（修标注漂移 bug）
- 根因：agent 用 js 工具在 main world 手写 position:fixed 覆盖层画标注，用户滚动后标注脱离目标；且 main world 访问不到 ISOLATED world 的 overlay API
- 修复（收编为正式工具）：协议加 mark{target,label?}/clear_marks；cursor.ts 新增独立 absolute host（文档坐标，随内容滚动）承载标注层，spawnMark=描边框+左箭头+名牌，实例色跟随；input.ts mark 复用 click 的 AX/CDP+domops 双路解析；agent tools.ts 注册；prompt.ts 加标注指引（禁止手写 fixed 覆盖层）
- 协作事故记录：与 Gemini 并发改同一工作区，protocol.ts 编辑被其 git 操作 revert；教训=多 agent 派工需按 commit 划界，协议类共享文件同一时间只许一方改
- 完成标准 docs/evals/20260903-mark-tool.md；typecheck/build/test(60) 全绿；标注样式截图自检通过
- 待人评：真实页面 mark 后滚动的跟随效果；与 Gemini 高亮的衔接节奏

## 2026-09-03 教学模式（软引导 + 硬闸门双层）
- 完成标准 `docs/evals/20260903-teach-mode.md`。开关打开后 agent 不操作页面，用 mark 标注（描边框+箭头+"Step N: …" pill）一步步教用户自己点
- **协议**：`shared/protocol.ts` 加 `AgentMode = "act" | "teach"` + ClientMessage `{type:"set_mode",mode}`；`parseClientMessage` 对 set_mode 校验 mode 枚举，其余帧守卫不变
- **扩展硬闸门**：新模块 `extension/src/background/mode.ts`（照 state.ts 模式：模块缓存 + chrome.storage.session 键 `agentMode`，模块顶层不碰 chrome API 故可单测）；`isBlockedInTeachMode(name, mode)` 纯函数拦 click/fill/type_text/press_key/js；`executeToolCall` 入口命中即回 `{ok:false, error:"教学模式已开启：请改用 mark 标注引导用户手动操作"}`
- **链路**：background 的 kind:"client" 处理器先 `setMode` 落本地再照常转发（relay.ts 未改）；`onServerMessage` 收到 hello_ok 时补发当前 set_mode（agent 重启/重连不丢模式）；`relay.ts` BgToPanel 加 `{kind:"mode",mode}`，面板接入/sync 时 postMode，set_mode 后 broadcast 收敛多面板
- **面板**：topbar 在 status-pill 左侧加 `#teach-toggle` 圆形按钮（lucide GraduationCap 已确认存在），开关态存 `chrome.storage.local["sideagent_teach_mode"]`，background 推来的 kind:"mode" 反向收敛本地存储；styles.css 加 `.on` 态（accent 描边+accent-soft 底），`#teach-toggle{margin-left:auto}` + 相邻选择器 `#teach-toggle + #status-pill{margin-left:0}` 保持右对齐成组
- **agent 侧**：`agent/src/mode.ts` 模块级 mode ref；`prompt.ts` 加 TEACH_MODE_PROMPT（英文，禁 5 工具/一步一 mark/label 写 "Step N"/用户说"好了/下一步"再推进/换步先 clear_marks）+ 纯函数 `appendPromptForMode(mode, base)`；tools.ts 5 个被拦工具 execute 开头 `teachModeReject()` 软拒（不发 rpc.call，回英文引导文本）
- **SDK 求值时机结论（0.84.4，dist 源码实读）**：`appendSystemPromptOverride` 只在 `DefaultResourceLoader.reload()` 时求值并把结果数组缓存；系统 prompt 在 `AgentSession._rebuildSystemPrompt` 组装（会话创建/setActiveToolsByName/reload），**不是每次请求重评**；每次 prompt 开始时还会把 `agent.state.systemPrompt` 重置回 `_baseSystemPrompt`（无 extension 时）。因此切模式不能只改闭包，`session.setMode()` 的做法 = `setModeRef` + `resourceLoader.reload()`（重评闭包）+ `session.setActiveToolsByName(getActiveToolNames())`（同名集合工具不变，借它触发 prompt 重建）
- **测试**：protocol.test.ts 加 set_mode 正/反例（mode 非枚举值→null）；extension/test/teach-mode.test.ts（teach 拦 5 放行 5、act 全放行）；agent/test/teach-prompt.test.ts（appendPromptForMode 两态 + mode ref 往返）。`npm run typecheck` / `npm test`（70）/ `npm run build` 全绿
- **无头自检**（playwright 取自 `~/tools/gstack/node_modules`，匹配本机 chromium-1234 缓存；全局 @playwright/cli 的 1.61 alpha 要 chromium-1226 不匹配）：脚本 `/tmp/teach-mode-check.mjs`，从 SW 内部 `chrome.tabs.create` 开 sidepanel（外部直开 chrome-extension:// 会被拦）。断言：开关 off→on 后 `aria-pressed=true`、`storage.local.sideagent_teach_mode=true`、**background 的 `storage.session.agentMode="teach"`**（面板→background set_mode 链路端到端实证）。截图：`/tmp/teach-toggle-off.png`、`/tmp/teach-toggle-on.png`、`/tmp/teach-mark-steps.png`
- **遗留/待人评**：① mark label pill 定位在元素上方 26px，目标贴页面顶部时会出屏被裁（截图中可见；缓解=agent 先 scroll 把目标带下来，prompt 已允许 scroll）——是否给 mark label 加"上方没空间就放到下方"的翻转逻辑，待人评后另开任务；② 教学模式真实对话手感（步骤粒度、label 文案语言）待人评；③ 切模式后重建 prompt 对进行中的会话在下一 turn 生效，未做真机验证

## 2026-09-03 教学模式实测反馈（用户人评，先记不改）
场景：GitHub 仓库"新建 Issue 但不提交"教学（red-herring-and-gun 仓库）。
1. **应自动感知用户已完成步骤**：用户点了 Issues 但回复"好了"之前，Agent 不会主动发现步骤已完成。实测形态：页面已进 All issues 列表，Agent 还在原地等"好了"，第 1 步 mark 也还挂着。根因线索：GitHub 是 SPA 软跳转（turbo），不触发整页导航，"导航即清 mark/作废 ref"机制不生效，Agent 收不到任何页面已变信号。期望：教学模式应有智能——检测到页面变化（URL/DOM）即判断用户已点击，自动推进到下一步。候选方向（待评估）：教学模式下 mark 后 background 监听 tab URL 变化/DOM mutation 主动通知 agent；或 agent 轮询 snapshot。与路线图「页面哨兵」项有交集。
2. **模式不应二分，教学是增强不是剥夺**：用户让 Agent 打开 X 并讲解页面值得探索的区域，Agent 回"教学模式下我不能替你打开页面，请关闭教学模式"。用户观点：开标签页/导航是基础能力，教学模式下很多任务依然需要；学位帽应该是"教学性更强"（多解释、多标注、等确认），而非砍掉通用能力；反过来通用模式下也不排斥教学行为（该解释时解释）。另发现**软/硬两层不一致**：硬闸门只拦 click/fill/type_text/press_key/js，open_tab/navigate 本不在拦截名单，是 TEACH_MODE_PROMPT 把禁令写宽导致模型过度自我设限。改造方向（待设计）：从"模式开关"转向"教学倾向增强"——保留全部工具，prompt 侧重引导式讲解+关键动作前征得同意；硬闸门是否保留/拦什么需重新定（也许只拦"不可逆/危险动作"，与路线图「危险操作确认」合并考虑）。

## 2026-09-03 教学模式重设计（去闸门 + 自动感知 + label 翻转）
- 卡 `docs/evals/20260903-teach-revamp.md`。设计转向：学位帽=教学倾向增强，不再剥夺能力（用户实测反馈第 2 条）；软硬双层闸门全拆——删 `isBlockedInTeachMode`/executeToolCall 拦截/tools.ts `teachModeReject()`；mode 状态保留（prompt 切换+自动感知用）
- TEACH_MODE_PROMPT 改倾向式：默认一步一 mark 引导+等确认，但 "You keep your FULL toolset"，任务需要或用户要求时直接动手并解释；危险/不可逆动作前自然语言征得明确同意（与路线图「危险操作确认」prompt 约定合流）
- **步骤完成自动感知**：background 追踪"有待完成教学标注"（mark 成功置 true，clear_marks/整页导航置 false，`mode.ts` 纯逻辑可单测）；SW 顶层 `chrome.tabs.onUpdated` 的 `changeInfo.url`（SPA pushState 也触发）在 teach+pending 时命中→content 侧 clearMarks + 经 uplink 发 page_event。协议加 ClientMessage `{type:"page_event",event:"url_changed",url}`。agent 侧 `session.notifyPageEvent(url)` 复用 steer() 通道注入：运行中=插话，空闲=sendUserMessage 起新 turn 做 snapshot 确认并推进。限制：空闲时无法"追加进当前 turn"，只能起新一轮；act 模式忽略
- **mark label 翻转**：`extension/src/shared/mark-label.ts` 纯函数 `markLabelPlacement(viewportTop)`，阈值 34px，不足时 pill 加 `.below` class 渲染到框下方；cursor.ts spawnMark 接入
- 测试：teach-mode.test.ts 改写为标注追踪 4 例；protocol.test.ts 加 page_event 1 正 4 反；mark-label.test.ts 4 例。76→88 测试全绿（含并行侧边栏任务新增 12 例）
- 无头截图 `/tmp/mark-label-flip.png`：贴顶（rect.y=4）pill 翻下方完整可见，中部正常在上方。已 `reload:ext`
- 待人评：GitHub SPA 场景复测自动推进；教学对话手感；已知边界=URL 不变的 reload 不发 page_event（标注随页面销毁）

## 2026-09-03 侧边栏执行步骤信息流重设计（参考 ChatGPT/Kimi）
- 卡 `docs/evals/20260903-panel-steps-design.md`。参考：Kimi "执行步骤 思考→读取页面→思考"聚合链+完成绿勾、"思考过程 1.4s"耗时；ChatGPT "Worked for 2m 28s"、人性化动作描述
- **run 聚合块**（main.ts ensureRun/finishRun）：用户发消息→agent_end 算一个 run，期间 thinking 块+工具卡收进 `details.run-steps`；运行中 summary=spinner+步骤链（相邻去重、只留最近 3 步加 "… → " 前缀），完成后绿勾+"耗时 Xs"+自动折叠。steer 不触发 agent_end 故自然落同一 run；空 run 壳 finishRun 时移除；status:idle/断连/Port 重连三处兜底 finishRun。计时面板侧本地记（事件流无时间戳）
- **纯逻辑抽离** `extension/src/sidepanel/steps.ts`：describeTool（ToolName 全集 15 个中文动作映射，navigate/open_tab 带域名、click/mark 带「label」、press_key 带键名）、StepChain、formatDuration（<10s 一位小数/<60s 整数/≥60s "2m 28s"）；extension/test/steps.test.ts 12 例
- 工具卡头改 图标+中文描述+弱化 mono 原名+耗时+状态 pill；思考块落定带耗时；新增 pinned 跟随滚动 + `#to-bottom` 回到底部圆钮（上翻不强拉、点击回底后隐藏）
- 无头自检 `/tmp/run-steps-check.mjs`（stub chrome.runtime.connect 注入合成事件序列）：截图 runsteps-{running,done,expanded,dark,tobottom}.png 全过；暗色/reduced-motion 无回归
- 待人评：真实 run 的观感（步骤链信息密度、折叠时机、正文是否被稀释）

## 2026-09-03 开发日志与设计取向成文
- 首篇开发日志 `docs/devlog/20260903-01-教学模式为什么做错了.md`（阮一峰风格：短句短段/事实先行/克制判断/编号小节，参考 https://2aran.com/skill-center/ruanyifeng-weekly-style 的风格拆解）
- AGENTS.md 新增两节：「开发日志」（docs/devlog/ 约定+文风）与「设计取向」（克制简约+安全可依赖；参考优质开源项目消化不照搬；克制=信息分层默认只露摘要，可依赖=动作有名字/耗时/状态）
- 用户对本日交付的整体评价：没什么大问题；后续侧边栏设计迭代继续遵循该取向

## 2026-09-03 模型选择器 + 默认模型换 MiniMax
- 卡 `docs/evals/20260903-model-picker.md`。背景：openai-codex/gpt-5.6-luna 全量报 "Not Found"——用户确认是 ChatGPT 官方故障（已恢复），不查根因；同时定方向：主力换 MiniMax（套餐额度有余），备选阶跃星辰
- **凭据盘点**（~/.pi/agent/auth.json，只看 key）：openai-codex / xiaomi-token-plan-cn / google-antigravity / minimax-cn / xai / kimi-coding / opencode-go 共 7 个 provider。**阶跃不可用**：auth.json 无凭据且 0.84.4 SDK 无 stepfun provider（只在 openrouter 等聚合网关间接出现），要用需另开任务（自定义 provider）
- **默认模型改 minimax-cn/MiniMax-M3**：M3 是目录旗舰（1M 上下文、图像输入、reasoning，价格同 M2.7）；实测最短请求 850ms 正常返回；config.json 只改 model 字段 proxy 保留
- **协议**：ClientMessage 加 set_model{model}；hello_ok 加可选 models（ModelOption{id,provider,modelId,name} 数组）；新增 ServerMessage model_info{model?,models}（切换成功后回推）
- **agent 侧**：SDK 0.84.4 `AgentSession.setModel()` 原生热切换（不重建会话不丢上下文）；`ModelRuntime.getAvailable()` 枚举有凭据 provider 的模型（52 个/7 组）；config.ts 加 saveConfigModel() 写回选择
- **面板**：status-pill 模型名变 #model-btn，点开 popover 按 provider 分组+当前项打勾+点外部/Esc 关闭；以 agent 回推为准不本地持久化；断连隐藏；老 agent 无 models 字段回退内联显示；404 类错误人话化（"模型不可用…请在顶栏切换模型"）
- 测试 98 全绿（新增 protocol set_model/config saveConfigModel/models 分组+错误人话化共 9 例）；无头截图 model-picker-{collapsed,expanded}.png；ws 模式真进程 e2e 过（hello_ok 带模型列表、热切 kimi-coding/k3、config 写回、反例报错）
- 已 `reload:ext`。待人评：选择器暗色观感、52 模型的滚动手感、真机切换体感
- 排障副产品：tsx 的 SIGTERM 只杀父进程会留孤儿占端口，ws 调试 e2e 脚本后要 `pkill -f "port <n>"` 清理

## 2026-09-04 CLIProxyAPI 本地订阅池接入模型选择器
- 卡 `docs/evals/20260904-cliproxy-integration.md`。池子 `http://127.0.0.1:8317/v1`（OpenAI 兼容，LaunchAgent 保活，auths 池：antigravity/codex-pro/kimi/xai×2）
- **探测结论**：/v1/models ~40 个；实测 Codex 全系（gpt-5.4-mini、gpt-5.6-luna）/ kimi-k2 / grok-3-mini / claude-sonnet-4-6 正常；**gemini 全系区域限制不可用**（"User location is not supported"，两型号复测一致）；图像/视频模型不适合对话
- **接入机制**：SDK 0.84.4 `ModelRuntime.registerProvider()` 运行时注册（`agent/src/cliproxy.ts`），`getAvailable()` 自动枚举→选择器零改动出现"本地池"分组（providerLabel 映射）；key 从 `~/.cli-proxy-api/client.env` 运行时读取，不落盘不进仓库；注册前 2s 超时探测 /models，池子挂了跳过不拖垮启动
- **静态清单 19 个**（∩ /models 通告）：Codex 7 + Kimi 5 + xAI 5 + Claude 2；排除 gemini（区域限制）/图像视频/未实测型号
- **排障发现（重要）**：undici ProxyAgent 经本地代理（7897）转发**回环地址的流式 POST 必败**（GET 正常）——`agent/src/main.ts` 的 proxy dispatcher 改为按 origin 分流：127.0.0.1/localhost/::1 直连，其余走代理
- e2e 8/8 PASS（热切 cliproxy/gpt-5.4-mini 真实往返 ~3s，切回 MiniMax-M3 默认不变）；112 tests/typecheck/build 全绿；已 reload:ext（native host 旧进程需重连拉起才生效）
- **密钥外泄事件**：探测时 cat config.yaml 的红action sed 正则没覆盖 `api-keys:` 下的裸列表项，导致本地池 key 进入会话记录。影响面=仅本机回环端点；教训=敏感配置一律用 `grep 键名` 或先 jq/yq 摘字段，不整文件过 sed。建议用户择机在管理面板轮换该 key（http://127.0.0.1:8317/management.html，密钥为 remote-management.secret-key）
- 遗留：池子注册后"组出现但池子刚挂"的窗口期请求会失败，走现有错误透传，可接受

## 2026-09-04 Gemini 恢复可用，补入本地池清单
- 用户提示后最小探针复测：gemini-3.1-flash-lite / gemini-3-flash / gemini-3.1-pro-low 全部返回 ok（前一日为区域限制 FAILED_PRECONDITION）
- `agent/src/cliproxy.ts` 清单 +3（注释注明曾为区域限制）；cliproxy.test.ts 相应断言反转（排除项只剩图像/视频与未实测型号）。112 tests / typecheck / build 全绿，已 reload:ext。本地池现 22 个模型

## 2026-09-04 Gemini 快型号补入 + beautifului.dev 组件评估
- 池内无 3.5/3.7 的 Lite 型号；probe gemini-3.7/3.8-flash-high 均 ~5s 返回 ok，已注册进 `cliproxy.ts`（本地池 24 个模型）。快速 Gemini 选择现状：3.1-flash-lite（最快最轻）/ 3.7-flash-high、3.8-flash-high（新且带推理）
- beautifului.dev（AI 原生界面组件库，21 个组件）评估结论，分三档：
  - 现在可用：01 Loading State（像素格 loader+耗时，可升级我们的流式占位）、02 Thinking（可展开 trace，对照我们的思考块）、05 Tool Chips（工具调用更紧凑的形态）、08 Prompt Bar（@ 来源 / 命令 + 模型选择器，composer 演进方向）
  - 路线图对齐（做到对应项时参考）：04 Approval Card（危险操作确认，注意路线图已定调纯对话，此卡仅作视觉参考）、06 Task Rows（并行 session 状态）、20 Selection Actions（选中即问）、21 Agent Screen（轨迹回放/技能录制）
  - 不适用：表格类（Diff/Records/Filter）、Search、Flowchart、Insight/Context/Recommendation Cards（数据型应用场景）

## 2026-09-04 Tool Chips + 像素格 Loading（A/B 用户双选 B）
- 卡 `docs/evals/20260904-chips-pixel-loading.md`；视觉规范稿 `/tmp/sideagent-ab-compare.html`（B 侧即 beautifului.dev 风格的消化版）
- **Tool Chips**：run 块内连续工具调用收进 `.chip-group`（可换行 flex + 共享详情区），chip = 6px 状态点（running accent 脉动/绿/红）+ lucide 图标 + describeTool 中文名 + 灰耗时；点击就地展开参数/结果，每组最多展开一个；思考块插入会另起 chip 组保持事件交错序。旧 .tool-card/.spinner/思考 shimmer 样式已删
- **像素格 loader**：5×5、7px 格/3px 间距、accent 相位波纹（(x+y)*0.12s），旁"处理中 · N.Ns"（等宽 100ms 刷新）+ 当前动作副标题（最近工具中文名，无则"思考"）；运行中常驻 run body 底部。run 摘要行 spinner 移除（运行态由像素格表达），摘要链与"绿勾+耗时"终态不变
- **interval 清理**：耗时读数 timer 挂 currentRun，finishRun() 统一 clearInterval+移除节点，agent_end/idle/断连/重连/空 run 全汇此出口；连续多 run 实测无残留
- 纯逻辑进 steps.ts（chipState/loaderSubtitle/pixelDelay，+8 断言）；117 tests / typecheck / build 全绿；截图 chips-{running,collapsed,expanded,failed,dark,reduced-motion}.png 全过（reduced-motion 下格子静止、读数照刷）
- 已 reload:ext。待人评：chips 手感（点开展开/收起）、像素格观感、思考流式期不再用 shimmer 是否习惯

## 2026-09-04 并行工人底座

- 卡：`docs/evals/20260904-parallel-workers.md`。已实现：协议 sessionId、按 session 认领 tab、Mailbox + Fleet.spawn、面板工人行、光标稳定散列。待人评：维基∥飞书硬场景（真机 Lead 曾未 spawn）。
- **注意**：伴随进程改动需 native host 重连。

## 2026-09-04 当前页面感知（user_message 上下文 + get_active_tab）
- 卡 `docs/evals/20260904-当前页面感知.md`。起因：用户问"这页面是关于什么"，agent 列 16 个标签反问"指哪一个"。根因：user_message 只有 text，无任何"用户正在看哪页"的信号；工具集也无查询活动标签的能力
- **协议**：`user_message` 加可选 `context{tabId,title,url}`（PageContext，parseClientMessage 校验、malformed 拒收）；TOOL_NAMES 加 `get_active_tab`（16 个工具），data = {tab: TabInfo|null}（null = 无活动标签）
- **注入点在 background 不在面板**：`background/index.ts` attachPageContext 在转发 user_message 前 chrome.tabs.query({active,lastFocusedWindow}) 附上下文，失败/无活动页原样发送不阻塞；面板零改动
- **agent 侧**：session.withPageContext 把 `[User's current page: tab N "title" — url]` 前缀拼进 prompt/steer 文本（标题换行折叠）；SYSTEM_PROMPT Working tab 段明确"这页面"= 该行所指 tab，无此行则调 get_active_tab，不再反问
- **get_active_tab 是纯查询不认领**（exec/tabs.ts getActiveTab），认领仍走 resolveWorkingTab 既有逻辑；steps.ts 中文映射"定位当前页"
- 测试 124 全绿（protocol +3、session-helpers withPageContext +4）；typecheck/build 全绿
- 待人评：真机问"这页面是关于什么"应直接读当前页；面板聊天输入框聚焦时 lastFocusedWindow 活动页仍指向页面标签（侧栏不改变 tab active 态）
- 另发现未修：模型选择按钮可发现性低（styles.css hover 才显可点），用户没找到模型切换入口即因此

## 2026-09-04 被中断任务找回（steer 失忆 / 光标可见性 / 刷新残留）
- 上一会话（session_a5d1ce67）在「当前页面感知」交付后，用户提三问题：① steer 打断后 agent 丢上下文（不认得之前定位的标签页）；② 虚拟光标可见性低；③ 扩展刷新后上一轮 overlay/mark/光标残留 + 侧栏关闭后位置偏移
- 断点：主代理发出两个排查子代理（steer 链路、cursor/mark 残留链路）后等待返回时被中断，**零代码改动、无完成标准**，根因排查未完成
- 线索：steer 失忆查 sidepanel main.ts:775 的 steer 发送 + pi-coding-agent SDK agent-session.js；残留问题查 extension/src/content/cursor.ts 的 host 清理路径（SW 重载后 content script 无清理）
- 找回方式：wire.jsonl 尾部回放（~/.kimi-code/sessions/wd_ego_ed8cb56eefd3/session_a5d1ce67.../agents/main/wire.jsonl）
- **已固化为完成标准 `docs/evals/20260904-steer-cursor-residue.md`，已领任务并完成机器项（见下节）**

## 2026-09-04 steer 失忆 / 光标可见性 / 刷新残留

- **steer 失忆根因**：Pi SDK 0.84.4 `steer()` 是往当前 turn 插入一条 user 消息，**不重置**对话历史。真正缺口是协议 `steer{text}` 没有 `context`，background `attachPageContext` 只处理 `user_message`，`BrowserAgentSession.steer` 也不走 `withPageContext`。运行中面板发的是 `steer` 不是 `user_message`，所以插话没有当前页锚点；prompt 又写「没有 current-page 行就去查/别猜」，模型容易改口问「哪个标签页」。
- **修复**：`steer` 与 `user_message` 同样可选 `context`；background 转发前附活动标签；`session.steer(text, context)` 走同一 `withPageContext` 前缀；SYSTEM_PROMPT 明确插话延续已认领 working tab，不重新询问。
- **光标**：36px（原 27）、白描边 2.2 + 深色外晕 3.8、白描边名牌。调色板不变。截图 `/tmp/sideagent-overlay/cursors-three-bg.png` 浅/深/花哨三底均压得住。
- **残留**：host 打 `data-sideagent-overlay`；新 isolated world 启动时 `sweepStaleOverlayHosts`；`pagehide` teardown。MV3 reload 不会触发 pagehide，所以启动清扫是主路径。
- **偏移**：mark 锚定目标元素（`mark(rect, label, target)` + `elementFromPoint` 兜底），`resize` / `visualViewport.resize` 用最新 `getBoundingClientRect` 重算文档坐标；光标/高亮是瞬时层，viewport 变化时收起。自检 mark 40→240 位移 200px。
- **验证**：139 tests / typecheck / build 全绿；`node extension/test/overlay-check.mjs` PASS；`npm run reload:ext` 已重载 `fnbjglhppbkgmjeehablkfilmmefjolo`。待人评条目 2、8（及 3/5/6 的真机观感）。

## 2026-09-04 协作协议可移植化

- 用户要求：把本仓库的开发规范、依据、人机协作、长期维护抽象出来，去掉产品私有信息，迁到别的仓库也能用；然后当面讲清楚。
- 产物：`docs/METHODOLOGY.md`。最小内核 = 完成标准 + NOTES + 开发日志 + 现象即信号；WikiSkill / 设计取向标成可选。
- 理论锚点不变：ContextPilot（单次任务上下文，规则必须写成习惯）+ WikiSkill（轨迹 / wiki / skill 三层，wiki 不回滚、推理期不注入 wiki）。
- 给目标仓库的粘贴引导和 `AGENTS.md` 模板在该文件第 6 节。

## 2026-09-04 并行呈现：人评功能 OK，设计另开

- 人评：点击不抢 Space OK；输入区模型选择 OK；并行功能 OK。不喜欢「工人」；要颜色+命名；等待/思考可有一点插科打诨。
- 任务时间线（`~/.sideagent/wrapper-err.log`）：`open_tab` flomo/bilibili 各 21.6s → `spawn worker=flomo/bilibili` 并行成立。热路径几乎全是 js（bilibili 14、flomo 17），所以面板是一墙「执行脚本 0.0s」。stderr 停在 flomo 最后一次 js，`post`/`await` 的 ok 还没落——阻塞中的 await 本来就不先打 ok。截图 2 的「处理中 226.3s」= Lead 写完「完成」后工人事件又 `ensureRun()` 开空壳。
- 卡：`docs/evals/20260904-cast-and-wit.md`。三案 HTML：`docs/evals/20260904-cast-compare.html`（已 `open`）。建议 B + 色名（青/棠/翠），等人挑再落地。
- 词表写死，不让模型编段子。完成/失败那一帧必须立刻停转（Claude Code spinner 残留坑）。
- 不做：假百分比、三个聊天线程、全局把「工人」搜替换当完成。

## 2026-09-04 完成后空转 loader（处理中 226s / 488s）

- 人评截图：Lead 已写出「完成」，底部仍有 flomo「处理中 · 488.8s」。任务早已结束，是面板空转。
- 根因：Pi `agent_end` 先 `setStatus("idle")` 再 emit。全员 idle → 面板 `finishRun()` 清掉 currentRun 和计时器；随后 `agent_end` 走 `ensureWorkerLane` → `ensureRun()`，新块带新的 100ms interval，再也没有 idle 帧来关。
- 修：`workerEventRunPolicy`（idle 后 reuse-last / drop，禁止新开）；`laneForWorker` 图已停只复用刚收掉的块。卡 `docs/evals/20260904-ghost-loader.md`。177 tests / typecheck / build 全绿；已 reload:ext。
- 侧栏若还挂着旧会话，关掉重开。已经转着的那块 488s 不会自己消失，是旧实例。

## 2026-09-04 名册 HTML（未落地）

- 用户把「先判断 → Will's S → 并排 HTML → 人挑再落地」收成长期习惯，已写入 `AGENTS.md`。
- 这一屏要判断：名是不是人；能不能分清谁在干活；动效帮不帮忙。对照：Labels last resort、Hick（三选）、从过多留白开始。
- 名册三列并排（不再点了再看）：律师 Kim/Mike/Lalo/Gus（建议）、Nacho 更冷、火线。页：`docs/evals/20260904-cast-names.html`。产品未改。
- 用户两册都喜欢，风格要靠苹果。新页 `docs/evals/20260904-apple-cast.html`：律师 ∥ 火线，同一套分组列表 + 语义灰 + 顶栏毛玻璃 + 等待用小转圈（名牌不闪）。对照 Color / Materials / Motion / Design Principles。产品仍未改。
- 字母圆头像不好看；「门口等着」太呆。对照图未收到。新页 `docs/evals/20260904-mark-and-wait.html`：名牌 / 小光标 / 色点 × 等待短句（还没到 / 等 Lalo / 笔记没过来 / 还在等）。产品未改。
- 按性格做人：参考 Peng Zheng / Grok Bot（persistent roles，扫一眼认出，状态在 avatar 上）。页 `docs/evals/20260904-character-roster.html`。律师 Kim 眼镜 / Mike 眯眼 / Lalo 圆笑会歪 / Gus 方正；火线 Kima 直视 / Omar 帽檐 / Bunk 眯眼 / Lester 圆眼镜。不画脸谱。产品未改。
- 人评否掉手写几何脸：「质量跟人家不是一个水平线；不要自己设计；开源库（游戏库，也指 Grok Bot 形象库）」。xAI 未放官方几何。开源复刻：`zhulin025/LaoA-GrokBot` MIT、`jeremy-prt/bloub` MIT；游戏：Kenney Shape Characters CC0。新页 `docs/evals/20260904-open-cast.html`，vendor 在 `docs/evals/vendor/`。
- 人评续：Grok Bot 律师/火线「这一块都行」，要能动；Mike 可用 Kenney 黄球皱眉（人设）；Omar 可用 Kenney 紫菱；不要局限，Mike 可以两种。页改为两列动起来 + 混用。
- **已落地（点头「对的」）**：律师班 Kim/Mike/Lalo/Gus（`shared/cast.ts` 纯函数，面板和光标同一套）。Grok Bot 弹簧在侧栏头像（LaoA `grok-original.js`，不改 path）。Mike 等待切 Kenney 黄球皱眉（`await_message` 期间）。chip/名牌/色条用短名和人的色。界面文案去掉「工人」（`请了 Kim`）。
- 人评：「律师和火线都可以。」名册扩成 8 人：律师 + 火线（Kima/Omar/Bunk/Lester）。Omar 常驻 Kenney 紫菱。散列仍按 worker id。待人评真机。
- 人评执行块布局挤、chip 跟人一个量级。对照 Hierarchy / 模糊间距 / 尺寸系统。人改成分组底 + 32 头像 + 名在上链在下；chip 缩进对齐名字、更小更淡；组间 12 组内 8/4。卡 `docs/evals/20260904-run-layout.md`。

## 2026-09-04 mark 内部滚动漂移

- 人评：flomo 圈住「第一条非置顶笔记」后拖动列表，框停在视口原处，笔记从底下溜走。
- 根因：`20260903-mark-tool` 假定「absolute 文档坐标天然跟随，不必听 scroll」。只对 window 滚动成立。笔记列表是内部 overflow 容器，`window.scrollY` 恒为 0；resize 会按元素重算，scroll 没听。
- 修：`cursor.ts` 在 window 捕获期听 scroll（scroll 不冒泡），按锚定元素最新 `getBoundingClientRect` 重算文档坐标。滚动只重锚 mark，不收光标/不拆高亮。锚点断开先藏圈，target 还能 resolve 再贴回去。
- 卡：`docs/evals/20260904-mark-nested-scroll.md`。`overlay-check.mjs` nested-scroll dy=90、四边误差 0；window-scroll 文档 y 74→74。178 tests / typecheck / build 全绿。已 reload `fnbjglhppbkgmjeehablkfilmmefjolo`。
- 人评：轻拖「基本上 ok」。压力测试任务：多圈同时在、从置顶翻到 9 月 1–2 日再让用户从顶拖到底。

## 2026-09-05 接管/交还 v1 首轮验收

- 机器项通过：`npm run typecheck`、241 项 `npm test`、`npm run build`、`node extension/test/overlay-check.mjs`。
- 暂不验收：接管期间刷新页面会清掉页顶「现在归你 / 交还」，没有在页面重新加载后补画；MV3 service worker 重启或 uplink 断线会丢内存中的 gate/状态，可能与 Agent 侧 held 状态分裂。
- 人评仍未完成：flomo 中途接管、用户改点另一条、交还后从当前条继续且不重复旧步骤。
- 两个阻塞问题已通过 CMUX 退回原 Grok；要求补失败复现测试，完成后向 `surface:32` 主动通知。
- 二次实现已补刷新恢复、断线保持、侧栏 `user != idle`，252 项测试全绿；复核发现启动竞态：`hydrateControl()` 尚未完成时 `uplink.start()` 会先触发 `connecting`，可能把持久化的 user 闸门重置并覆盖。已退回补真实顺序测试。后续完成通知改为 Grok 自己窗口留报告 + CMUX notification，不再向 Codex 输入框注入文字。
- 三次实现已把 `uplink.start()` 和首次连接状态处理都放到 `controlReady` 之后；新增顺序测试证明存储为 user 时立即 connecting 仍拦截 click/navigate。Codex 重跑 typecheck、253 tests、build、overlay-check、真实浏览器三轮均通过。机器部分通过，剩真人 flomo 连续路径。

## 2026-09-05 真实浏览器验收跑道通过

- 原版复制实现被退回。修订版通过 Debugger 暂停生产 listener，在模块闭包内挂最小调用入口；验收动作实际经过 `uplink.handleRaw -> onServerMessage -> executeToolCall -> gate.run -> handlers`，没有复制 snapshot/click/fill。
- Codex 独立重跑：`npm run accept:browser` 连续三次通过并连接 `local.yishu.chrome-main`；`npm run typecheck`、252 项测试、`npm run build` 全绿。证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-acceptance-2026-09-04T16-34-53-269Z`。
- 接管启动顺序修复后再次重跑三轮通过；证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-acceptance-2026-09-04T17-09-28-956Z`。

## 2026-09-05 接管/交还 v1 真机连续路径

- 真实 Wikipedia 路径已跑：运行中接管 → 刷新 → 点击 `Intelligent agent` 跨页。三步都保持「现在归你」，接管与持久化通过。
- 交还闭环失败：SideAgent 侧栏打开时，页顶「交还」处于侧栏覆盖区域，真实窗口不可见不可点；收起侧栏后控制条仍不可见。
- 为继续判断后端，触发了按钮同一条 `handback_click` 消息。`chrome.storage.session.controlGate` 随后为 `{owner:"agent", lastStatus:"running", generation:3}`，`workingTabs.main=29951853`，确实锚定当前 `Intelligent agent` 页。
- 可见结果仍失败：页面残留「现在归你 / 交还」；重开侧栏后原任务和对话为空，10 秒后仍无继续结果。`docs/evals/20260904-takeover-handoff-v1.md` 的 4–7 保持未完成。
- 证据：`docs/evidence/20260905-takeover-handoff/`，含 4 张页面截图、说明和 `takeover-handoff-real-browser.gif`；未使用系统录屏。

## 2026-09-05 接管/交还全流程展示页

- 展示页：`docs/evals/20260905-takeover-handoff-showcase.html`；同一页按“动作 / 产品实现 / 真实界面”串起 Agent 执行、接管、刷新保持、跨页保持和交还失败，并直接引用既有 4 张真机 PNG 与 GIF。
- 页面明确保留“部分通过，尚未完成”，没有把交还失败包装成成功；无外链、CDN、远程字体、脚本或构建依赖。
- ChromeMain 实测媒体 6/6 加载；390px 视口 `scrollWidth=390`，无横向溢出。展示页只负责留档，不改变 v1 的失败判定。

## 2026-09-05 接管/交还 v1 闭环修复

- 首次真机失败后继续修：控制协议改成 requestId + `control_result` 两阶段确认；接管排空已开始写操作，交还先抓用户当前活动标签与新 snapshot，再恢复原 Pi 会话；侧栏历史由 background 保存，重开不丢。
- 真机主路径通过：Radius 运行任务 → 接管 → 用户切到 Wikipedia → 交还 → 同一会话读取 Wikipedia 当前快照继续；没有切回、重载或重开 Radius，旧控制条已消失。证据为 `11`–`13` PNG。
- 验收中发现并修复主动中止误报：`agent/src/session.ts` 记录 expected stopped agent_end，用户中止不再追加 `Request aborted` 模型错误；focused 14 tests 通过。
- 验收中继续发现清理竞态：abort 立即回到 agent 时，已经进入 handler 的旧动作可能稍后重新画光标。`ControlGate.abort()` 现在暴露旧 inflight 真正 settled 的时刻，background 在其后做第二次 cursor/banner/replay 清理。
- 扩展 reload 还会留下旧 isolated world 的控制条。hydrate 为 agent 时现在主动清扫当前页；ChromeMain 复核 AX 中「现在归你 / 交还」节点随 reload 消失。
- 最终展示：`docs/evals/20260905-takeover-handoff-showcase.html` 与 `docs/evidence/20260905-takeover-handoff/takeover-handoff-v1.gif`。第 14 帧是独立中止清理复核；旧 `02`–`05` 保留为失败复现。

## 2026-09-05 全队接管/交还 v2 标准与设计对照

- 独立校验先锁定标准：`docs/evals/20260905-team-takeover-v2.md`。一次接管必须覆盖 Lead 与全部活跃成员；等已进入写操作全部结束后才能报成功；交还逐成员读取最新标签页与 snapshot；单个成员页面关闭时只暂停该成员；中止仍是独立动作。
- 当前差距：background 的全局 gate 已能拦住所有会话，但 Agent 侧只 hold Lead。fleet 成员会继续运行并撞上闸门，且 idle 后可能自动 dispose；交还也只恢复 Lead。v2 要把 Lead 与 workers 作为同一个受控小组冻结和恢复，同时保留每个成员自己的 tab 绑定。
- Will's S 对照：Human in the loop 要求 AI 是助手而非老板；Agentive UX 要求用户可随时切换领导权；Wayfinding / Feedback 要求动作反馈回答“发生了什么、正在发生什么、接下来会怎样”。
- 本地标本对照：PageFlow 的控件按需出现、Inline 的事实/补充/动作三级层次、GSAP 的有序状态转换。开源对照采用 Magentic-UI 的随时 steer/approve/take over、Liveblocks Presence 的临时成员状态、tldraw presence 的稳定成员颜色与页面信息。
- 临时三案：`/tmp/compound-engineering-501/ce-prototype/2026-09-05-team-takeover-v2/01-ownership-and-team-status/screens/001-team-takeover-variants.html`，本地预览 `http://localhost:49551`。推荐 A“一枚主状态”：网页只显示控制权与紧凑成员头像，侧栏按需展开逐成员状态；B 信息最全但过重，C 适合讲交接过程但静止时总览弱。
- 产品代码未改，等待人选 A / B / C 后再实现。

## 2026-09-05 全队接管/交还 v2 首轮实现复核

- 用户选择 A「一枚主状态」后，Grok 完成首轮生产实现和 `accept:team`。Codex 独立重跑：49 项 focused、290 项全量测试、typecheck、build、overlay-check、`accept:team` 连续三轮均绿。
- 独立校验判定不能验收：部分交还会整体打开全局闸门，关闭标签的 worker 仍可能认领别页写入；pending takeover 断线重连可能形成 UI 为 user、硬闸门为 agent 的 split-brain。
- 其余生产缺口：成员在 background 与 Agent 两次枚举，点击时的小组没有真正冻结；`accept:team` 静音真实上行并伪造确认，未进入 Fleet 暂停/续跑或覆盖在途排空；侧栏缺每名 Agent 的绑定页，隐藏 restored/aborted 终态，snapshot 失败会误报标签关闭。
- 已把 5 个阻断项和必须新增的集成/竞态/UI 测试退回原 Grok `surface:6`。完成后通过 CMUX notification 通知 `surface:32`；完成标准不改，真人双网页、关页部分交还、中止路径仍待机器闭环后验收。
- 真机路径已定：Lead 留在 Wikipedia `Intelligent_agent` 做长循环，运行中 steer 新增 `ai-worker` 到 `Artificial_intelligence`；接管后在两页搜索框分别写 `HANDOFF-LEAD-20260905` / `HANDOFF-WORKER-20260905` 但不提交，一次交还后用两名原 session 的输出、tabId、未重复 spawn 证明各自从 fresh snapshot 续跑。
- 异常路径：重新创建活动组，接管后关闭 `ai-worker` 标签，Lead 页写 `CLOSED-WORKER-LEAD-20260905` 再交还；要求 Lead 恢复、worker 明确保持暂停且不补开页。随后独立中止，要求界面明确显示已中止并清除控制条、光标和 loader。
- 证据同时保存 `workingTabs/controlGate` 五个检查点、Agent PID、wrapper 日志片段和接管前后 CDP tab 清单；页面正文、cookie、token 不入档。

## 2026-09-05 全队接管/交还 v2 第二轮独立复核

- 内部实现代理关闭了首轮 5 个阻断项中的 partial 硬闸门，并补上一次性本地 capability；Codex 独立重跑 `typecheck`、313 项测试、build、overlay 与 `accept:team` 三轮均绿。新证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-team-2026-09-04T21-45-10-741Z`。
- 独立校验仍判 BLOCKED：pending takeover 断线超过 10 秒会触发旧 timer，把 background gate 放回 Agent，而 Agent Fleet 仍 held；重连可能出现 UI 为 user、硬闸门为 agent。
- 冻结组的成员 ID 已固定，但 `activity/title/url` 没有端到端传给 Agent。`waiting_message` 会被误当 running 并 abort 等待；Agent 回包还会覆盖 background 的真实页面名。
- `accept:team` 已不再伪造 control_result，且确实复用同一个 `BrowserAgentSession` wrapper；但验收专用 continuity 分支没有让底层 AgentSession 真正运行/续接原任务，因此第 11 条仍未证明。
- 已退回继续修：跨 timeout 断线、等待状态、真实绑定页、底层 AgentSession 续跑；机器闭环前不进入第 12/13 条真人验收。
## 2026-09-05 全队接管/交还 v2 第一次真人正常路径失败

- ChromeMain pid `23055`，native Agent pid `77190/77191`；Lead `main` 与 worker `ai-worker` 分别绑定两个真实 Wikipedia 页面。
- 接管、两页用户输入、一次交还均真实发生。Lead 读取 `HANDOFF-LEAD-20260905` 并从第 12 次续到第 40 次。
- worker 交还后只继续旧 snapshot/mark/scroll 流，没有读取 `HANDOFF-WORKER-20260905`，没有 `tool post session=ai-worker`。
- 判定：第 12 条未通过。高概率为 `holdForUser()` 异步 abort 尚未结束时，`continueAfterHandback()` 把边界指令 steer 进旧流。已交实现者修复，要求等旧流真正停止后在同一 AgentSession 只 prompt 一次新续跑轮，并覆盖竞态测试。
- 证据：`docs/evidence/20260905-team-takeover-v2/normal/12-first-real-run-failed.md`。

## 2026-09-05 全队交还：等待旧流停止后再续跑

- 根因确认：Pi SDK 的 `AgentSession.abort()` 会等到 `waitForIdle()`，但 `BrowserAgentSession.holdForUser()` 过去丢掉这个 Promise。立即交还时 `session.isStreaming` 仍为 true，`continueAfterHandback()` 就把 `[HANDOFF BOUNDARY]` steer 进正在中止的旧流。worker 因而继续旧循环，没有读取用户的新页面状态。
- 修复：`BrowserAgentSession` 保存并复用同一次 stop Promise。交还始终等待旧流真正 idle，再在同一个 AgentSession 上 `prompt` 一轮 handback continuation；不再用 `steer` 交还。control epoch 会使重复接管或中止取消尚未启动的续跑，迟到的 agent_start 也会立即停止。
- `waiting_message` 仍在接管期间保留 waiter；交还时才停止旧等待流并等待 idle。空闲 session 直接 prompt，一次交还只启动一次。
- 红灯：可控 abort Promise 未 settle 时，旧实现立即调用一次 `steer`。修后 focused 覆盖快速接管→立即交还、重复接管、显式中止、waiting_message、空闲 session，20 项通过。
- 最终验证：`npm run typecheck`、全量 `npm test`（35 files / 324 tests）、`npm run build`、`git diff --check` 全绿。按编排要求未 reload ChromeMain，待独立重装/重载后重跑真人正常和异常路径。
## 2026-09-05 全队接管/交还 v2 最终真机验收

- 第一次正常路径失败：worker 没有读交还后的新值。根因是 SDK abort 未完成时把 handback steer 进旧流。
- 修复：`BrowserAgentSession` 保存 pending stop；handback 等旧流 idle 后在同一 AgentSession 只 prompt 一次；control epoch 取消重复接管/中止前排队续跑。新增 5 条竞态测试。
- 修复后正常路径通过：`main` tab `29952164` 读回 `PASS-LEAD-20260905`；`handoff-worker` tab `29952638` 读回 `PASS-WORKER-20260905`；两者继续原任务，pid/sessionId/tabId 不变。
- 异常路径通过：关闭 `closed-worker` tab `29952649` 后，Lead 读回 `PARTIAL-LEAD-20260905` 并恢复；worker 为 `paused_tab_closed`，没有替代标签；单独中止后 UI 显示“已中止”，页面无可见控制条/光标，不能交还。
- 独立复跑：typecheck PASS；35 files / 324 tests PASS；build PASS；overlay PASS；`accept:team -- --runs=3` 三轮各 10 项 PASS；diff-check PASS。
- 证据：`docs/evidence/20260905-team-takeover-v2/`；展示：`docs/evals/20260905-team-takeover-v2-showcase.html`；完成标准 13/13 已勾选。

## 2026-09-05 全队交还：只在新一轮真正启动后标记恢复

- 最终独立复核发现状态提前：`continueAfterHandback()` 过去只排队续跑便同步返回 true，Fleet 随即把成员标成 restored。旧流仍在停止、prompt 尚未调用或已经失败时，界面也会错误显示“已恢复”。
- 修复：`continueAfterHandback()` 现在返回一个与 control epoch 绑定的 Promise。旧流停止并在同一 AgentSession 发出 handback prompt 后，只有该 epoch 的 `agent_start` 才 resolve true；abort/prompt 失败、重复接管、团队中止和迟到 `agent_start` 均 resolve false，成员继续归 user 或进入明确的 `paused_snapshot_failed`。
- Fleet 按成员异步恢复并逐次发布 `team_status`。Lead 可以先进入 restored，worker 保持 restoring；background 根据每次团队进度更新 session 闸门、状态、控制条和侧栏。handback 的首个 `control_result` 只作“已接受恢复请求”的即时确认，避免 10 秒 timeout，不再代表全队已经恢复。
- 新增 focused 回归覆盖：abort pending、同 epoch `agent_start`、abort reject、prompt reject、重复接管/abort、stale `agent_start`、团队 epoch 中止、一成员恢复而另一成员失败，以及 partial 状态下逐成员闸门与控制条。
- 机器验证：focused 4 files / 58 tests PASS；全量 35 files / 331 tests PASS；`npm run typecheck`、`npm run build`、`git diff --check` PASS。
- 按编排约束没有 reload ChromeMain。当前已加载旧运行态执行 `npm run accept:team -- --runs=3` 三轮均在等待新 `team_status` 时超时，证据：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-team-2026-09-04T23-14-54-932Z`。这不是新构建的验收结果；需由编排者重载后独立复跑。

## 2026-09-05 全队接管/交还 v2 最终收口

- 编排者安装 native host、重载当前扩展后复跑 `npm run accept:team -- --runs=3`：三轮各 10 项 PASS，证据已复制到 `docs/evidence/20260905-team-takeover-v2/accept-team/`。
- 同一构建切回真实 `minimax-cn/MiniMax-M3`，在 ChromeMain 上重跑 Lead + worker 双 Wikipedia 路径。接管后两页分别写入 `FINAL-LEAD-20260905` / `FINAL-WORKER-20260905`。
- 一次交还后，界面先显示 `1 个已恢复 · 1 个仍暂停`；第二人真正 `agent_start` 后才显示“全队已恢复”。Lead 和 worker 最终各自读回自己的值，并各完成 12 次续跑，无串页、无重开。
- 机器检查为 35 files / 331 tests、typecheck、build、overlay-check、diff-check 全绿。完成标准 13/13 现可勾选。
- 独立校验复跑 session/fleet 33 项并审查端到端状态链，最终判定 PASS，无 blocker。非阻断风险是 provider 永久挂起时缺恢复超时，以及 prompt 启动失败时复用 `paused_snapshot_failed` 文案；建议作为下一个可靠性子任务先写新标准再实现。

## 2026-09-05 交还恢复超时与失败文案说真话（实现侧记录）

- 完成标准：`docs/evals/20260905-handback-restore-reliability.md`（标准文件未改）。
- session.ts：`HANDBACK_RESTORE_TIMEOUT_MS = 30_000`（构造器第 6 参可注入短超时）。handback prompt 发出后 `armHandbackRestoreTimer(epoch)` 开始计时，挂在 `pendingHandback.timer` 上；settle/cancel 统一 clearTimeout，接管/中止经 `cancelPendingHandback` 清理。超时走 `failPendingHandback(epoch, reason)` 同一条失败链，新增公开字段 `handbackFailureReason` 供 fleet 读原因（超时：「恢复超时，原会话仍归你。」；prompt reject 不传 reason，fleet 回退原「恢复失败」文案）。
- 竞态保持现有 epoch 语义：超时后 `pendingHandback` 已空，迟到 `agent_start` 落进既有 stale 分支（停旧流、状态归 user），不会标 restored。
- fleet.ts:189：reason 优先取 `session.handbackFailureReason`，缺省维持原字符串。
- 面板：shared/control.ts 新增纯函数 `memberStatusLabel(m)`（paused_tab_closed / paused_snapshot_failed 有 reason 显示 reason，否则回退 `memberPhaseLabel`），main.ts:722 名册行改用它。protocol.ts 未动。
- 测试：session-helpers +5（含默认常量 ≥30s、超时失败、迟到 agent_start、超时前接管/中止清 timer）、fleet +1（超时 reason 透传 + team_status 更新）、extension/test/team-member-label.test.ts +4。全量 36 files / 341 tests PASS；typecheck、build、overlay-check、diff-check 全绿。未 reload 扩展、未 commit。
- 独立校验（Kimi，2026-09-05）：复跑 341 tests / typecheck / build / overlay-check / diff-check 全绿；抽查 diff 与测试断言真实（fake timers、`vi.getTimerCount()===0`、迟到 agent_start 走 stale 分支）。机器项 1/2/4 已勾；剩标准 3 的面板文案真机观感与标准 5 的真机回归，需 reload 扩展后由人评。

## 2026-09-05 聊天框像素伴侣（Rauno lil pix）设计定位与原型

- 需求定位：用户提议将 Rauno Freiberg 的 "lil pix" 像素伴侣设计引入侧栏输入框。
- 代码定位：侧栏输入区核心在 `extension/src/sidepanel/main.ts`（#composer、#input、#composer-bar、#model-btn、#send-btn），样式在 `extension/src/sidepanel/styles.css`（第 971-1016 行），宿主为 `extension/sidepanel.html`。
- 原作要素解析：
  1. 像素小机器人（复古麦金塔/终端机身、双竖条眼神、手脚）；
  2. 拟物白手套光标（Hover 变手套指针）；
  3. 摸头微交互（按压 squash-and-stretch 压扁眯眼微笑、松手阻尼回弹、冒小心心）；
  4. 状态联动（打字侧身托腮思考、闲时站立眨眼、快捷键胶囊切换）。
- 对照 Will's S：Refactoring UI《Emphasize by de-emphasizing》与《Start with too much white space》——侧边栏仅约 360px，输入框必须保持高效清爽，不能让玩偶遮挡文字输入区；Apple Motion 弹性按压与阻尼（非无休止摇摆）；Shape of AI · Personality 赋予 Agent 陪伴感。
- 三案并排 HTML 原型：`docs/evals/20260905-lil-pix-composer.html`（已抽取并内嵌高清透明像素资产：站立/摸头/思考/白手套）：
  - 方案 A（胶囊收拢式）：原汁原味 Rauno 胶囊，空闲 36px 药丸，点击平滑展开为多行卡片；
  - 方案 B（卡片顶沿趴宠式·推荐）：保持现有输入卡片的多行与模型选择体验不变，小机器人趴在卡片顶沿左侧探头，随时可摸头，完全不侵占文字输入与按钮区；
  - 方案 C（底栏内嵌伴侣式）：嵌在输入区底部操作条与模型选择 chip 并排，紧凑度最高。
- 验收卡建立：`docs/evals/20260905-lil-pix-composer.md`。
- 遵循《AGENTS.md》协议：生产代码 `extension/src/` 未做任何改动，等待用户裁决挑选方案后再落地。

## 2026-09-05 一只手拿住：就地确认改光标名牌双键（C 案，实现侧记录）

- 完成标准：`docs/evals/20260905-one-hand-confirm.md`（未改）。视觉权威：`docs/evals/20260905-one-hand-confirm.html` C 列。
- 光标层（`extension/src/content/cursor.ts`）：新增 `hold(x,y,actions,target?)` / `releaseHold()` API。拿住 = 持久 pressing（不自动摘）+ holding class、禁 park、setResting(false) 保证 rest/flip 不藏名牌；名牌保持成员色 var(--c)，内嵌 `.hold-action.confirm`（红 #c43c32）/`.cancel`（灰 #eceef1）双键，pointer-events:auto，点击发既有 `mark_action`（协议未动）。`mark()` 带 actions 时自动 hold——held 拦阻与模型自绘 mark 两条路径同一形态，键永远只有一套（去重由构造保证）。scroll（含内部容器捕获期）/resize 走 `relayoutHolds()`，按锚定元素最新 getBoundingClientRect 重定位，anchor 断开先藏、恢复再贴回（与 relayoutMarks 同语义，`liveAnchor` 泛化共用）。`move`/`click`/`hide` 自动松开 hold。框外双键渲染（`armMarkActions`、`.mark-actions`/`.mark-action` 样式、LiveMark.actions、ns.markActionLabels/clickMarkAction）全删，无死代码。
- 执行层（`extension/src/background/exec/input.ts`）：pending/arm 台账抽成纯数据层 `extension/src/shared/held-clicks.ts`（HeldClicks 类，决策返回 dispatch/armOnce/cancelled）。held 分支改为存 pending + 画「待确认」mark（框保留作视觉锚）+ 光标拿住；point-only 点击画不出框时手仍飞过去拿住。`resolveHeldClick` 重写：confirm 有 pending → 先 releaseHold 再由同一只手播波纹真实派发；无 pending → armOnce 直接 arm（修两轮断点）；cancel → 清 pending + clearMarks + releaseHold。
- background（`index.ts`）：侧栏打「取消/算了/不要/no…」（新 `isCancelReply`，mark-actions.ts）→ 与页面取消同效（resolveHeldClick cancel）后照常上行；「确认/是/继续」维持 armDestructiveClick。
- 文案：`agent/src/prompt.ts` Safety 段改为「危险控件直接 click，执行层拿住等确认；禁止打开站点菜单冒充就地确认、禁止只圈不点；mark 圈当前目标，键在名牌上」（英文）；`tools.ts` mark description 与 held 提示语同步；`shared/protocol.ts:243`、`docs/protocol.md:68` 注释同步。
- 测试：`extension/test/held-clicks.test.ts` +7（pending 存取、dispatch/armOnce/cancelled、成员 session、注入失败兜底语义）、`mark-actions.test.ts` +3（isCancelReply）、`agent/test/safety-prompt.test.ts` +4（契约：直接 click/拿住/禁冒充/无 "outside the box"）、teach-prompt 标题同步。overlay-check.mjs：拿住姿态+名牌双键+去重（两套 mark 仍一套键）+resize/window/内部容器滚动跟随+点名牌 confirm 发 mark_action+releaseHold 恢复，截图确认 C 案视觉（手按住目标、名牌成员色内嵌红/灰双键）。
- 验证：357 tests 全绿（38 files）、typecheck、build、overlay-check、`git diff --check` 全绿。未 reload 扩展、未 commit。
- 未决：标准 9 人评（flomo 删「MiroFish 项目」真机）未做；伴随进程需重连才吃到新 prompt；拿住态的颜色细节（确认红 #c43c32 / 取消浅灰 #eceef1）与 HTML C 列（pill 整体变红、键反白）有出入——按标准第 1 条「名牌保持成员色，确认键红、取消键灰」落地，待人评裁决。

## 2026-09-05 点击健壮性防御与就地确认拿住兜底

- 完成标准：`docs/evals/20260905-click-robustness-and-hold-fallback.md`。来源：实测 ChatGPT 归档操作中暴露的后台失败链路。
- 根因与修复：
  1. Chrome MV3 `executeScript` 吞错陷阱：页面内部抛错时 Chrome 不 reject 而是返回 `[{ frameId: 0, result: null }]`，导致 `targetRect` 变为 `null` 并崩溃于 `targetRect.x`。修复：在 `callDom` 注入函数内包裹 `{ ok: true, rect }` / `{ ok: false, error }` 结果信封，对外抛出精确业务错误；`input.ts` 的 `click` / `fill` / `mark` 增加针对 `targetRect` 的非空断言保护。
  2. 危险词表与就地确认：`mark-actions.ts` 扩充 `DESTRUCTIVE_ZH` / `DESTRUCTIVE_EN` 与 `confirmLabelForDestructive`，支持 `归档` / `archive`。
  3. `mark` 语义兜底推导 actions：模型调用 `mark` 时若未显式传 actions，但 label 命中确认意图（以「待」开头如「待归档」「待删除」或命中危险词），自动推导出 confirm/cancel 并在名牌上拿住，防止模型声称“光标停在按钮上”而实际光标未就地拿住。
  4. AX ref 拿住态重布局容错：AX 树快照的 backendNodeId 无法通过 `dom.resolve` 反解，修复 `cursor.ts` 在 `relayoutHolds` 中无 liveAnchor 时误将光标设为 `hidden` 的问题，改为保持在 `hold.point`。
  5. 提示词同步：`agent/src/prompt.ts` 明确将 `archive` / `归档` 纳入危险操作与直接点击就地确认。
- 改动文件清单：
  - `extension/src/background/exec/input.ts`
  - `extension/src/content/cursor.ts`
  - `extension/src/shared/mark-actions.ts`
  - `agent/src/prompt.ts`
  - `extension/test/click-robustness.test.ts`
  - `extension/test/mark-actions.test.ts`
  - `agent/test/safety-prompt.test.ts`
  - `extension/test/overlay-check.mjs`
  - `docs/evals/20260905-click-robustness-and-hold-fallback.md`
- 验证：39 files 366 tests 全绿、`npm run typecheck` 全绿、`npm run build` 全绿、`node extension/test/overlay-check.mjs` 全绿、`git diff --check` 全绿。
- 未决/待人评：需真机 reload:ext 后在真实站点（如 ChatGPT 归档会话、flomo 删笔记）实测确认双键与手势观感。

## 2026-09-05 侧栏伴侣（GrokBot 矢量体系 + 边框爬行 + 前端生命周期解耦）

- 完成标准：`docs/evals/20260905-lil-pix-composer.md`。视觉与交互权威：`docs/evals/20260905-lil-pix-composer.html`。
- 关键决策与演进：
  1. **技术栈与割裂感根治**：早期像素马赛克与 macOS 现代 UI 严重冲突，用户裁决选定 **方案 A（SideAgent 原生矢量 GrokBot 伴侣）**。
  2. **悬浮“边框”疑窦消除**：用户指出的“鼠标靠近时出现的边框”，确认为借鉴 Rauno 摸头原型时附带的 36x23 像素手套切片（带有黑色外边框，在现代高清屏上极突兀）。已将其彻底移除，升级为 macOS 原生直接操纵（`cursor: grab / grabbing` + 小人身体物理弹性变形）。
  3. **前端架构对接规范**：建立零侵入独立模块 `extension/src/sidepanel/companion.ts`，持有独立的 SVG 几何与 RAF 物理阻尼，仅对外暴露 `onTyping()`、`onSend(bubbleEl)`、`onStepStart(stepEl)`、`onStepDone()`、`onTakeover(isUser)`、`onRunFinish()` 6 个生命周期钩子，绝不在 `main.ts` 混杂动画状态机。
  4. **零文字遮挡红线**：伴侣在输入框与步骤卡外轮廓（Outer Rim `-32px`）游走，气泡内部文字保护区遮挡率严格保持 **0%**。
- 改动与原型资产：`docs/evals/20260905-lil-pix-composer.html`、`docs/evals/20260905-lil-pix-composer.md`。
- 生产代码保持干净：`extension/src/` 未变动，待用户对对接方案点头后进入编码落地。

## 2026-09-06 AI Chat Bar 原位形变动效（方案 A 底部芯片原位液态舒展）与真实模型思考档位体系落地

- 完成标准：`docs/evals/20260906-chat-bar-morph.md`。视觉交互对照原型：`docs/evals/20260906-chat-bar-morph.html`。
- 背景与裁决：
  1. 用户提供 CollectUI 优秀动效交互案例（Arek @arknow91《AI chat bar - buttons morphing into dropdown lists》），要求探索侧栏落地形态、真实模型思考分层展示、双色调优（彻底根除纯黑纯白断层与泥浆感）。
  2. 经三案并排原型对照（方案 A 底部芯片原位舒展、方案 B 双胶囊裂变、方案 C 一体化抽屉），用户明确选定 **方案 A（底部芯片原位液态舒展 · Inline Chip Bloom）**。
  3. 色彩校准：消除写死深色底造成的“一块白一块黑”撕裂，浅色模式全面收敛至苹果 Sequoia 晨曦微晶白体系（深紫 `#6d28d9` 思考标签，苹果蓝高光描边）；深色模式收敛至深曜石炭黑体系（淡粉紫 `#d8b4fe` 高对比标签，杜绝死硬纯黑 `#000000`）。
- 落地实现清单：
  - `extension/src/sidepanel/models.ts`：导出 `ReasoningTier` 类型与 `modelReasoningMeta` 纯逻辑函数，严格根据真实模型能力映射（MiniMax 原生内置深度思考；OpenAI/Codex 支持档位调节；Kimi/Flash 极速直接响应）；
  - `extension/test/models.test.ts`：补充 `modelReasoningMeta` 单测（覆盖 OpenAI、MiniMax、Anthropic、Google、Kimi 等场景，3 个新测试全部通过）；
  - `extension/src/sidepanel/main.ts`：在 `#model-btn` 内置 `#model-reasoning-tag` 节点；在 `renderModelPicker()` 动态更新当前模型思考标签；在 `renderModelList()` 渲染各模型思考标签与对齐 checkmark；
  - `extension/src/sidepanel/styles.css`：定义 `--tag-native-*`、`--tag-direct-*`、`--tag-slider-*`、`--chip-active-bg` 等亮暗双模式变量；实现 `#model-btn` 原位弹簧形变、展开时 Chevron 180° 平滑自旋、`#model-popover` 弹簧舒展动效（`popoverSpringIn`）；
  - `extension/test/fixtures/model-picker.html`：同步更新为包含思考标签的完整双模式测试夹具。
- 验证闭环：
  - `npm run typecheck`：0 错误全绿；
  - `npm test`：41 个测试文件、385 个测试全绿；
  - `npm run build`：生产产物构建成功；
  - Playwright 多态真机截图无头核验：浅色收起/展开、深色收起/展开共 4 态，视觉层级分明、标签对比度达到 AAA 级。

## 2026-09-07（下午）PR #3 R1/R2 补证（fix/stability-issue2-model-capability-labels）

- 新增 extension/test/panel-states-check.mjs（真实构建扩展+标签页加载生产 sidepanel.html，仅 Port 边界注入真实格式信封）：R1 四组状态（旧四字段目录/未知模型、切换未回执不假更新并断言 set_model 信封、model_info 回执后芯片与选中项、真实格式 error 保留旧模型+错误可见）+ R2 五组几何（320/360/400×亮暗：模型入口/输入/发送/菜单可见不重叠可操作），9 场景全过，exit 0；HEAD 6606e81，dist sha256 e4e00429…。
- 新增 panel-container-probe.mjs：ChromeMain 真实容器只读探针（仅 /json/list + Runtime.evaluate）；本轮侧栏未打开 → no-target(exit 2) 如实记录，未代用户打开（不打扰前台）。
- 提交 961e86c 已推送；PR #3 描述已修订：三层证据区分、「切换失败由机制+单测证明」改为实际覆盖表述、未验证项按实更新；附审阅回应评论。
- 机器复跑：typecheck 绿、npm test 394/394。issue #4 修复在 PR #5，两交付独立，main.ts 改动区不相交。
- ChromeMain 当前：磁盘 dist 为本分支（#3）构建；会话期间 reload 过两次（先 #4 构建跑验收，后重建回 #3 构建），SW 下次重启自然拾取磁盘版本。

## 2026-09-07 BOSS 项目经历任务日志诊断

- 诊断：`docs/evals/20260907-boss-project-task-log-analysis.md`。
- `~/.sideagent/wrapper-err.log:1736-1780`：45 次工具调用、30 次 JS、4 次 click 中 3 次错误；工具合计 7159ms。两次无效 loc 选择器，一次 ref 失效。
- 进程窗口北京时间 18:50:59-18:59:16，不能当精确任务耗时。click ok 不证明编辑器打开；当前循环无业务进展停止条件。
- 未决：无持久化模型轨迹、JS 参数与结果、每轮模型耗时；无法确认每次 JS 具体效果和断连发起者。
- 仅新增诊断文档并追加本记录，未改产品、未跑测试、未操作用户页面。

## 2026-09-07 Browser recovery: persistent run trace

- Added `agent/src/run-trace.ts`, `agent/test/run-trace.test.ts`; connected SDK events and existing user/control entry points in `agent/src/session.ts`, preserving existing attachment handling.
- Trace path: `~/.sideagent/traces/<timestamp>-<session UUID>.jsonl`. Session/run/turn/toolCallId identify user goals, SDK tool args/results/errors/timings, first response and turn/run elapsed time, takeover/handback/abort/dispose. Handback and steering keep the original runId.
- No runtime/stop policy changes. Text is retained up to 64k per field with explicit truncation; images reduced to metadata. Private permissions, bounded queue and session bytes, retention cleanup; trace failures do not reject tool/session work.
- Credential redaction covers sensitive keys, password-target fill args, common labelled free-text credentials, bearer tokens and URL credentials. It is best-effort, not reliable classification of arbitrary unlabelled secrets. Disconnects are recorded when SDK tool errors expose them; idle connection state is not observed.
- Focused checks passed: `npm test -- agent/test/run-trace.test.ts agent/test/session-helpers.test.ts` (36 tests); `npm run typecheck -w @sideagent/agent` passed. Full checks and real-browser evidence remain owned by orchestration.
- Independent review follow-up: input payloads for `fill` and `type_text` are now omitted by default even for ref/point targets, including assistant toolCall arguments. Sanitization shares a 96k-character/1024-node budget across the entire record, slices before regex, and marks object/array truncation; screenshot `imageBase64` is summarized. Updated focused trace suite: 6/6 passed.

## 2026-09-07 浏览器恢复本地验收（独立执行代理）

- 新增 scripts/acceptance/recovery-run.mjs、extension/test/fixtures/recovery.html。真实 MiniMax-M3 + 生产 BrowserAgentSession/ToolRpc + 生产 SW 工具；仅本地 fixture。没有改产品代码。
- hover/selector/stale/noop 四场景均实际打开编辑器、fill 草稿、submit=0，人工介入均0；耗时42.825/46.614/77.195/58.770秒，模型工具8/9/12/11次。
- 详情与taskId、工件目录：docs/evals/20260907-browser-recovery-local-results.md。after.png均已查看。错误为校验者真实预置并明确交给真实模型，不是模型自主产生错误；页面自带hover提示，因此不是陌生站点成功率基准。
- 原BOSS路径与接管/交还UI仍由主编排接手；已释放浏览器。未提交git。

## 2026-09-07 浏览器恢复收尾

- 结果报告：`docs/evals/20260907-browser-recovery-results.md`；开发日志：`docs/devlog/20260907-05-browser-recovery.md`。
- 已接入真实hover、准确ref/定位反馈、多匹配拒绝、工具结果验证提示、本地有界脱敏轨迹。保留所有既有附件/侧栏等他人修改，未提交git。
- 最新检查：45文件422测试、typecheck、build通过，扩展已重载。最终相关改动diff检查通过。
- BOSS原页新会话：MiniMax-M3，69.198s/16工具/0人工，打开新增项目表单，字段为空未填写未提交。run=0ff74a5c-f25d-4aa8-ace4-a253209a0f89；工件 `out/acceptance/boss-recovery-2026-09-07T11-33-21-470Z/`。
- 原生接管第一轮：同run 07120d50-0586-459f-8530-13df6581e7a2，原目标→接管→模拟人工开编辑器→交还→fill/readback，28.457s，提交0。见原生轨迹及 `out/acceptance/handback-2026-09-07T11-19-38-268Z/native-timeline.json`。
- 验收采集脚本曾失败，产品结果由持久化轨迹/截图/现场状态复核；严格区分，不声称脚本命令通过。
- 未决：HANDOFF BOUNDARY污染新任务已实见，未修；AX viewport scope、截图0x0尺寸另需处理。BOSS只验证打开入口，未做完整填写保存。

## 2026-09-07 浏览器组合执行

- 独立标准：`docs/evals/20260907-browser-program.md`。实现与验收由主代理完成，只复用一位校验代理写标准。
- 新增 `agent/src/browser-program.ts`（QuickJS 0.32.0，browser方法组合、waitFor/sleep、资源边界、不可catch绕过控制）；tools/session/rpc/protocol/background/steps接入子步骤与programId。输入/源码/图片继续脱敏。
- 扩展执行链未另建；17个操作仍可独立调用，browser_run为本地可选工具。没有开放宿主Node权限或任意CDP。
- 结果：`docs/evals/20260907-browser-program-results.md`；用法：`docs/browser-program.md`；开发日志：`docs/devlog/20260907-06-browser-program.md`。
- 三个明确指定组合方式的真实MiniMax-M3任务均完成，但无稳定提速：隐藏入口32.332→54.470秒，延迟入口模型调用10→8但耗时29.800→47.862秒。撤回试验中的默认强引导，保留可选能力。
- 原生接管实机通过：一次程序，接管确认后10.5秒无新子动作、草稿为空；工件 `out/acceptance/program-control-2026-09-07T12-24-05-351Z/`。
- 全量439项测试、typecheck/build通过；最后策略回撤与测试日志隔离后定向61项通过。保留他人既有修改，未提交git。`out/acceptance/`已忽略，现场工件不默认提交。
- 已知未决：M3程序选择/分段不稳定；原HANDOFF跨任务约束、AX viewport、截图0x0问题仍未处理。下一步优先验证定位与分段，不能宣称整体成功率已提高。

## 2026-09-07 源码对照与产品路线判断

- 报告：`docs/research/20260907-browser-intelligence-source-comparison.md`。本轮主代理自行研究，未派子代理、未改产品/正式路线图、未跑新验收。
- 路线权威为docs/ROADMAP.md：阶段0稳定现有能力先行，后续会话/任务→明确示范纠正→记忆与语音/主动性按前提推进。
- 当前实际分支fix/stability-issue2-model-capability-labels，HEAD8c3fca3...+未提交工作树，和路线图页首集成分支不同；已区分。
- 对照固定源码：ego-lite5ca3c36(MIT)、Playwright312030c(Apache-2.0)、Stagehandd4f16a9(MIT)。重点：目标身份/帧与错误分类、输入探针、actionability/命中检查、观察ID转确定性动作、缓存失败回推理。
- 本地新增静态发现：screenshot CDP成功分支返回0x0，fallback可能拍到不同前台页；domops回退同一调用既dispatch click又HTMLElement.click，有双触发风险；坐标解析后等视觉效果再输入但无同等级稳定/命中检查。未冒称本轮真实事故复现。
- 已知补充：AX scope被忽略、ref仅数字Set/缺帧身份、HANDOFF约束串任务；点击源码固定650ms+最多480ms飞行仍解释不了前轮约6s，需要分阶段计时。
- 推荐下一步：观察与单次点击可信的小修复，随后小型模型×接口交叉对照。保留Pi/控制闸门/browser_run，不整体替换驱动，不借机启动全量记忆/语音。产品长期衡量是重复解释/接管减少且误操作不增加。

## 2026-09-07 cmux 三执行者开始可靠性修复

- 用户授权Codex为编排，同窗口OpenCode/Grok/Antigravity为执行者，完成后必须回应Codex。
- 已现场确认workspace:8：Codex surface:11；OpenCode surface:12（Muse Spark 1.3 Contributor/xhigh）；Grok surface:13（Grok4.6/high）；Antigravity surface:9（Gemini3.8Flash/medium），均在Desktop/ego。
- 编排先锁定 `docs/evals/20260907-observation-click-integrity.md`。任务合同位于 `docs/work/20260907-*-task.md`，已通过cmux send+enter发出。
- OpenCode拥有截图/快照/相关协议元数据；Grok拥有单次点击/目标重新确认/交还约束；Antigravity仅拥有前端干扰夹具和独立验收脚本。共享文件边界已明确，不互改、不开更多子代理、不自行build/reload/提交。
- 各自专属report.md记录进度，完成/阻塞后用cmux向surface:11发送执行回报；Codex负责完整检查、浏览器独占调度与最终验收。

## 2026-09-07 剩余完整性实机验收

Codex 经用户授权运行 A2/B1/B3。仅改 scripts/acceptance/integrity-fault-run.mjs（窗口装配与截图间隔）及 scripts/acceptance/handback-new-task-run.mjs（旁路点击/加载标识及错误描述），未改产品代码。A2/B1 首轮 2/6，前置条件修正后 6/6，故障包装已恢复。B3 首轮交还后计数由 1 归零，原因未定；第二轮同 MiniMax-M3 会话 A 保持 1、B 点击 1，19.079s，无会话重启。不能以重跑成功覆盖首轮失败。详见 docs/evals/20260907-integrity-remaining-results.md。浏览器测试标签及 CDP 已由脚本清理释放。

## 2026-09-07 教学模式手绘圈点勾画与通透批注落地

- 完成标准：`docs/evals/20260907-hand-drawn-teach-marks.md`。视觉原型：`docs/evals/20260907-hand-drawn-teach-marks.html`。开发日志：`docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`。
- 关键决策与实现：
  1. 借鉴 Danilaa1/drawably 风格，零外部依赖自研轻量几何库（`mulberry32` PRNG、双偏置 `roughEllipse`、引导弯曲线 `roughArrow`、3 帧微动变体 `variants`）。
  2. 动效偏好：默认方案 A（420ms 生长定格），支持切换方案 B（1200ms 3 帧微抖动）；侧栏 `#teach-toggle` 右键快捷切换动效档位，持久化至 `chrome.storage.local`；`prefers-reduced-motion` 自动定格。
  3. 荧光笔全面重构：采用 `mix-blend-mode: multiply`（正片叠底）+ 高明度底色，黑色文字 100% 锐利透出，根治遮挡发污。
  4. 模式自动感知：`teach` 模式自动采用 `sketch` 手绘风格，普通 `act` 执行模式保持精确实线矩形框；页面滚动与 resize 仅位移容器，固定 seed 确保路径不抖动重算。
- 改动文件清单：
  - `docs/evals/20260907-hand-drawn-teach-marks.md`（完成标准与裁决表）
  - `docs/evals/20260907-hand-drawn-teach-marks.html`（三案并排与荧光笔修复交互对照原型）
  - `docs/devlog/20260907-08-教学模式手绘圈点勾画与通透批注落地.md`（开发日志）
  - `extension/src/shared/rough/prng.ts`（确定性 32 位 PRNG）
  - `extension/src/shared/rough/geometry.ts`（手绘椭圆、弯箭头、马克笔平刷几何生成）
  - `extension/src/shared/rough/index.ts`（算法模块统一入口）
  - `extension/src/background/mode.ts`（动效偏好 MarkMotion 状态与持久化）
  - `extension/src/background/exec/input.ts`（toolMark 自动感知模式与动效）
  - `extension/src/sidepanel/main.ts`（教学按钮右键切换动效交互）
  - `extension/src/content/cursor.ts`（overlay 手绘渲染、CSS 动效、正片叠底与 test helper 暴露）
  - `extension/src/sideagent.d.ts`（MarkOptions 与 test helpers 类型契约）
  - `extension/test/rough.test.ts`（算法核心单测）
  - `extension/test/teach-mode.test.ts`（动效模式设置单测）
  - `extension/test/overlay-check.mjs`（无头 Chromium 端到端渲染与滚动断言）
  - `docs/NOTES.md`（会话工作笔记）
- 验证闭环：
  - `npm run typecheck`：全量零错误；
  - `npm test`：52 files / 489 tests 100% 通过；
  - `npm run build`：扩展构建成功；
  - `node extension/test/overlay-check.mjs`：端到端断言与截图全通过；
  - `npm run reload:ext`：Chrome 真实环境热重载生效；
  - `git diff --check`：无空白符与格式问题。
- 未决/待人评：
  - 标准 4：真机长文本高亮与深浅背景下的文字通透度；
  - 标准 6：真机教学模式下引导圈注的笔触质感与动效流畅度。

## 2026-09-08 会话管理现状核查

- 当前分支 `fix/stability-issue2-model-capability-labels`。静态代码核查：无用户新建/切换历史会话协议与入口；主进程创建单个 Lead，模型会话使用 `SessionManager.inMemory`。
- 空闲后新消息会重置面板回放缓存，但仍进入同一模型会话；界面记录清空不等于上下文重置。证据：`shared/protocol.ts:158-193`、`agent/src/main.ts:161`、`agent/src/session.ts:162`、`extension/src/background/index.ts:915,1037`。
- 产品讨论：新会话用于隔离不同事项的临时上下文并保留回头接续的入口；多任务同时执行另涉及浏览器资源与控制权。尚未确定方案或授权实现。
- 改动文件仅本笔记；未运行浏览器验收或测试。未决：新建时旧任务的运行语义、历史持久化范围。

## 2026-09-08 会话 Space 与同页多 Agent 调研

- 用户确认新建 B 不暂停 A；不同会话默认独立任务和页面。共同填写一份未保存简历时允许同页分工，期望各 Agent 使用不同颜色光标。
- 主源结论：ego-lite 的核心是任务身份/页面集合/控制权；Kimi WebBridge 1.11.5 是 session 标签组与默认仅搜索本会话页面。插件可用 Chrome tabs/tabGroups 实现分组，不能以分组代替执行范围检查。
- Luna Max 静态核查：已有 worker 新开 tab、session 路由、多色 cursor；没有 Chrome 原生标签组。显式 switch_tab 可双绑而 sessionForTab 只返回一个归属；ControlGate 是门禁/在途计数，不是页内输入互斥。尚未复现故障，不当作已实测 bug。
- 建议：跨会话默认独立标签；同页协作显式登记参与者，并行准备内容，按短动作协调定位/聚焦/输入/验证。新标签不保证未保存状态同步，也不隔离同一服务端对象。
- 改动文件：本笔记、docs/research/20260908-session-spaces-and-shared-tab.md、docs/devlog/20260908-01-会话独立运行与同页协作.md。无产品代码改动；未运行浏览器实验或测试。
- 未决：同页协作真实网站兼容性、调度粒度、共享页接管边界。研究文档含后续最小实验建议，尚非实施授权或冻结验收卡。

## 2026-09-08 开发前可点击前后对照

- 用户已授权开发，但随后明确要求：改动前和过程中先用临时 HTML 展示改前/改后使用方式；用户认可后才推进产品代码。当前只完成标准和原型，不开工产品。
- 独立校验使用 GPT-5.6 Sol medium，产物 docs/evals/20260908-session-management.md，锁定会话身份/上下文/标签/控制隔离与同页完整短动作协调；实现前人评待定。
- 原型 docs/evals/20260908-session-management-preview.html：改前按当前代码重绘，改后模拟“新建B/A继续/切回A”与“同份简历两位Agent分工/接管/交还”。顶部和页尾明确模拟数据；不调用模型或操作真实网站。
- 已读取 Will’s S 原文：Sidebars 217886bc60ff81b48be5da15f05d5d0e、Progressive Disclosure 20f886bc60ff816b86e1c9ce8dbfc3ea、Wayfinding/Feedback 20f886bc60ff81b980f7f60210dfebea。具体采用：当前会话标题常显，历史按需展开，后台任务状态不隐藏；沿用产品色彩，不新增另一套设计。living INDEX 的 inline 标本仅参考减少导航说明层级，不复制视觉资产。
- 原型本地 http://127.0.0.1:8878/docs/evals/20260908-session-management-preview.html；ego task space 92。浏览器已点通新建、切换、草稿保留、新会话尚未执行时不创建标签组、同页两光标、接管等待不写入、交还后完成；390px 无横向溢出。均为原型验证，不是产品验收。
- 产品代码改动为0。待用户裁决使用路径后才能开始实现。

## 2026-09-08 原型修订：Agent 主动判断分工

- 用户指出不应要求提示词写“请两位 Agent”。用户只给目标，产品自己判断并主动说明有益的分工；若拆分不划算则无需拆分。
- 临时 HTML 已将同页场景改前/改后统一为“帮我完善这份简历，先填内容，暂不提交”；改后由 Agent 说明工作经历与教育经历可同时准备并安排林/禾。演示播放按钮不是用户派工审批，亦不要求用户选择人数。
- 独立校验角色同步修订标准：共享页显式登记是运行时责任，不是要求用户点名子 Agent；增加主动派工与简单任务不强制拆分的正反例。
- 仅修改原型与文档，仍未改产品代码；用户已看过原型并提出这一修订，尚未将这句话记为完整实现批准。

## 2026-09-08 会话管理实现启动

- 用户在修订主动分工原型后明确“好的，没问题。那接下来就可以开始了”。独立评估卡的人评门由校验者更新；本轮已开始产品实现。
- 分工：conversation_runtime（GPT-6 low）负责agent/protocol/Pi持久化；conversation_extension（GPT-6 low）负责BG会话控制与relay；page_resources（Sol medium）负责页面归属/原生组/共享页短动作；主线程负责sidepanel和集成；session_evaluator（Sol medium）独立验收。
- 主线程侧栏已接会话标题菜单、新建、后台状态和cid筛选、切换后历史重放；草稿/附件按cid存储。附件异步读取在切会话后仍回原cid；focused attachment测试6项通过。全量类型检查等待后台page_operation/share_tab接口合并，目前不算通过。
- Pi最小持久化证明由runtime执行通过：两个独立Node进程使用原生SessionManager.create/open，真实SDK prompt marker，本地确定性provider收到恢复上下文；初始化0次请求，追问1次，未重放旧动作。它证明SDK上下文恢复，不是远端模型任务验收。实现将使用~/.sideagent/conversations索引。
- ChromeMain已实测发现：专用wrapper local.yishu.chrome-main 对应独立ChromeMain数据目录，CDP9222。禁止操作默认profile；后续只用仓库受限验收跑道。

### 2026-09-08 会话后台隔离实现（extension worker）
- `extension/src/background/index.ts` 将原 ControlGate/TeamControl/状态/历史/控制事务置于每 conversationId 的闭包实例；唯一 Uplink 以稳定 cid 分发。工具资源使用 `executionKey(cid,sid)`，控制门保留局部 sessionId。异步面板消息捕获接收时身份。
- `relay.ts` 新增 `select_conversation`、`conversations` 与各 envelope 的 conversationId；sync 按 cid 回放。选中 cid 用 storage.session 保存，历史用 storage.local 每 cid 保存（delta 100ms 合并，用户消息/idle 即刻落盘）；不再新一轮清空历史。草稿由主线程 UI 持久化。
- `mode.ts` 的模式与待教学标记按 cid 隔离；Chrome storage 不可用时保留原 fallback。`panel-history.ts` 支持恢复单调 seq。
- 页接管取该 tab 所有 collaborators，先阻止其门和页队列，等待短动作结束；其他会话和同会话其他独立页的成员不一起冻结。页上交还按钮按发送页归属找会话。完整 page_operation 传入 gate generation 检查，阻止 abort 后 queued 操作落地。
- 验证：extension typecheck 通过；session-management/history/teach-mode/click-robustness 20 项通过。新增 background 实际路由测试覆盖晚到事件、A/B 历史隔离、B abort 不改变 A、侧栏与 Service Worker 重建后历史恢复。
- 未执行扩展 reload/commit；真实验收由主线程与 evaluator 继续。资源 worker 仍在补 revoked collaborator 的锁后检查及队列接管 epoch。

## 2026-09-08 真实浏览器底层验收通过

- 独立校验 npm run accept:sessions 在专用ChromeMain上15/15 PASS：A运行中建B、列表、同URL独立tab与组、草稿隔离、共享writer登记与verified、输入事务顺序、未提交、接管共享页全部writer、迟到写阻断、B继续、中止隔离、持久状态、测试后恢复原模型。
- 证据目录 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-07T17-19-46-745Z。真实自然语言主动分工与侧栏关闭重开尚未通过，不将确定性验收模型结果冒充。
- 真实路径修复：hook改为捕获controller作用域而非旧module；Chrome组最后页关闭后的失效cache重建；同cid并发开页分组串行；共享spawn去掉被共享门拒绝的多余switch；最后worker退出收敛exclusive；工作指针离开不释放旧tab归属；组名取会话标题、颜色稳定；只有当前会话Lead激活tab。
- 主线程接着用生产sidepanel+真实模型验证上下文/草稿隔离。通用CUA工具不暴露chrome-extension页面，使用仓库限定ChromeMain的CDP测试方式触发生产UI的点击/输入，不修改后台业务状态。

## 2026-09-08 验收模型限定

- 真实sidepanel+M3上下文隔离和草稿恢复smoke 5/5通过，证据 /tmp/sideagent-session-ui-evidence/result.json。
- 主动派工第一次M3返回529 overload，无工具执行；临时尝试Kimi K3返回403周额度耗尽，也无工具执行。随后启动Sol验收时用户明确“就用M3来测试就可以”。已停止该Sol验收脚本，对唯一Sol验收会话131ea979-2305-4d15-aafa-a91c7e2512b2发出中止并切回M3；后续真实模型验收只使用minimax-cn/MiniMax-M3。
- 独立校验裁决主动分工人数：无需固定2children；至少一次成功spawn和至少两位实际writer（可含Lead），同一tab双字段正确且未提交。单字段反例不派工。判定在下一轮实际行为结果前修订，不以失败结果倒改断言。

## 2026-09-08 M3主动派工真实路径未过后的修正

- M3恢复可用后，原始材料简历任务完成了工作/教育两个字段且未提交，但全程只有Lead，无成功spawn。因此主动派工判定失败，不将表单正确当成这一项通过。原始证据 /tmp/sideagent-autonomy-evidence/attempt-m3-no-delegation.json。
- 最小修正仅agent/src/prompt.ts：在起草前按输出结构判断；多个需要独立分析/起草的实质内容先启动有用的并行准备，不把同页误当同一步骤；简单直接填值和依赖前一步结果的链仍单Agent。无关键词分支、无固定两worker。
- 已通过planning focused测试，已重载，再以相同用户请求/相同页面/M3复验；标准不改。用户明确真实模型只用M3，持续遵守。
- 通过真实Chrome点击临时验收入口已打开原生sidePanel，得到原生页面target与截图 /tmp/sideagent-session-ui-evidence/native-panel.png；该入口只用于触发Chrome要求的user gesture，不修改生产界面或业务状态。

## 2026-09-08 会话页面发现范围独立复核

- 独立校验复核 `extension/src/background/exec/tabs.ts`、`state.ts` 与 `conversation-tabs.test.ts`：`list_tabs` 只返回 `TabResource.conversationId` 等于当前会话的页面，不暴露未归属页或其他会话页面。
- 执行成员没有工作页时，`resolveWorkingTab` 只检查当前活动页，不扫描其他空闲标签。活动页属于其他会话或未向该成员共享时明确拒绝并要求 `open_tab`；活动页未归属时通过 `setWorkingTab` 同时写入 workingTabs 与 exclusive tabResources，成为当前会话的稳定资源。
- 该行为满足既定标准：同 URL 在其他会话存在时不能静默借走；普通查找限定在当前会话页面集合。`get_active_tab` 仍是纯查询，后续认领和写入继续经过 `resolveWorkingTab` 的归属检查。
- 完整验证：`npm run typecheck` 通过；`npm test` 为 59 files / 533 tests 全绿。未运行 `accept:sessions`，因为主线程正在重建并独占真实浏览器验收。

## 2026-09-08 read_element 与最终机器证据复核

- 独立校验确认 `read_element` 满足 eval 14a–14f：受 conversation/tab/collaborator 归属约束；完整返回 textContent/value；超 1,000,000 字符明确失败而不截断；AX/DOM ref 代际隔离；CSS 定位缺失、多匹配、非法均明确失败；读取函数不 focus、scroll、写 DOM 或派事件，也不接受任意 JavaScript。
- `read_element` 在 ControlGate 中为只读，用户接管时可读取，写工具仍阻断；browser program 仍经过既有顺序、取消与迟到结果检查。真实 Chrome shared/takeover 读取属于 14g，等待 build/reload 后跑道补证。
- mode 摘要恢复测试覆盖 default/B 独立恢复和晚到旧存储不覆盖新 mode。M3 真实伴随重启证据 `/tmp/sideagent-restart-evidence/result.json` 通过；UI 证据 `/tmp/sideagent-session-ui-evidence/result.json` 为 5/5。
- M3 最新自主分工证据 `/tmp/sideagent-autonomy-evidence/attempt-m3-complete-tools-no-spawn.json` 仍失败：字段正确但 spawns=0、writers=[]，不满足主动派工标准。
- 修正 `agent/test/session-planning.test.ts` 的段落截取：只检查 `# Parallel workers` 到下一标题，继续禁止任务关键词，没有放宽断言。最终验证日志 `/tmp/sideagent-session-final-verification.log`：`npm run typecheck` 通过；`npm test` 为 61 files / 550 tests 全绿；build/reload exit 0。

## 2026-09-08 M3 主动分工正例独立复核

- 独立逐项读取 fixture 与两份事件流，不只采用脚本 `ok`。`attempt-m3-first-pass-slow.json` 和最新版 `result.json` 均在一张未保存简历页成功 spawn 两名 worker；work/education 各自真实执行 `page_operation`，结果 `verified:true`，并有完整 `read_element` 读回与 done 工件。最终两个字段与原始材料一致，summary 空，状态“尚未提交”。eval 第 17 条据此通过。
- 最新一次 conversation `37ab2ace-43e3-4e77-ab9b-37cfab5b4f62` 耗时 59 秒。Lead 先 `read_element body` 获取完整材料，在可见回复中说明分工，并把对应原始材料交给 work/edu；不是只口头派工或失败后由 Lead 独做。
- 第 7a 条仍等待单字段简单任务负例，不因正例通过而提前勾选。
- `/tmp/sideagent-shared-read-evidence/result.json` 实际为 3/4、overall false。read 使用已被 stop_worker 撤销登记的旧 worker id，归属门正确拒绝；它不能证明 14g。等待通过生产 share_tab 登记测试成员后重跑。
- 后续 `/tmp/sideagent-shared-read-live-evidence/result.json` 用真实存活 M3 worker 验证了接管后 main/worker 完整读取同一 `main` 正文、两者 page_operation 阻断和页面状态不变；但两个字段当时为空，且没有逐项实测 fill/js。脚本自身 4/4 只是部分证据，eval 14g 保持未通过。
- 最后一次在相同证据路径重跑补齐 14g：M3 conversation `17147416-0ea6-4abb-b3c1-1395befb7a0d` 成功 spawn 存活 worker `reader`，共享 tab `29955618`。接管前 main/worker 用生产 page_operation 分别写入两个超过 150 字字段并逐字读回；接管后两人各读完整 main/work/education，共 6 次一致；两人各试 fill/js/page_operation，共 6 次全拒绝；正文、字段、focus、scroll、未提交状态不变。5/5 通过，随后 abort 并释放浏览器。原先旧 worker 被拒与空字段覆盖不足的失败记录保留。
- prompt/read_element 聚焦回归 3 files / 14 tests 全绿；未操作浏览器。

## 2026-09-08 原生历史耗时复核

- `PanelHistoryEntry.occurredAt` 保存 background 收到事件的原始时间；侧栏回放用原时间计算任务/思考/工具耗时。旧记录缺时间时隐藏耗时，不使用回放墙钟伪造。当前运行仍用 Date.now，各 conversation 的历史与起点独立。
- 独立聚焦测试 `history-timing/panel-history/session-management/steps` 为 4 files / 41 tests 全绿。
- 真实证据 `/tmp/sideagent-history-timing-evidence/result.json`：M3 conversation `795c5b74-9970-4da4-b1c8-3ec69e7b1acf` 首显 1.9s，关闭重开仍 1.9s；旧 `37ab...` 无可靠时间，回放耗时为空。两张截图位于同目录。eval 23/24 通过。

## 2026-09-08 M3 空白页复验与共享读取补齐

- 只清理本轮 local resume-autonomy.html 测试页后复测，cid436bba0c-e629-4cf9-be6b-d3412dcd77c7成功spawn edu，但goal明确只草稿不写，最终writer仅main，标准失败。证据/tmp/sideagent-autonomy-evidence/attempt-m3-draft-only.json。
- 实测shared snapshot正文200字/值60字截断，任意js读取被共享门拒绝。独立evaluator先写read_element标准14a–14g，resource实现受归属约束、无副作用的完整定位读取，禁止用任意JS补洞。
- 主线程更新结构性分工提示：shared字段负责人负责准备、填写和验证，Lead不重复接回全部填写；用户说明避免工具标识符。没有按简历关键词派工。
- 真实M3重启上下文验收通过：伴随进程53922于01:58启动后，旧01:20会话0358c113-860c-43c3-89d5-073a17915a5a仍正确回复原代号；证据/tmp/sideagent-restart-evidence/result.json。未重放任何浏览器动作。

### 2026-09-08 会话模式恢复修复
- 先用真实 background 路由 focused test 复现：扩展 mode storage 为空时，hello 会向 runtime 回写默认 act，且列表内持久 teach 没有同步到本地。
- 删除 hello 的 set_mode 回写；conversation_list/created/updated 的 summary.mode 恢复对应 controller 本地缓存和面板。只有用户显式 set_mode 才上行修改模式。
- getMode 在异步 storage 读取返回后再次检查缓存，避免晚到的空存储覆盖刚恢复的 teach。A/B 模式仍独立。
- 验证：extension typecheck 通过，session-management/teach-mode/click-robustness 15 tests 通过；补充晚到读取用例后，mode-focused 3 项通过。未 reload。

## 2026-09-08 M3 最终正反例与收尾时限

- prompt分工章节前置后，cid7498f8bb-3b27-4700-8c75-db45ac8936ea自主2spawn/education+work各自page_operation verified，同tab29955547未提交；首次通过但重复定位较多。
- 给read_element补充target=body的完整读取用法，并要求Lead把已读材料交给worker后，cid37ab2ace-43e3-4e77-ab9b-37cfab5b4f62再次2spawn/edu+work各自verified，同tab29955557；59秒。证据/tmp/sideagent-autonomy-evidence/result.json。不要把一次通过外推为普遍效率收益，早期单Lead同样例约24秒。
- 单字段反例cidb1248101-3c88-4050-970f-34cdca4f57d7：M3，8.2秒，0spawn，summary准确填写、work/education仍空、未提交；证据/tmp/sideagent-simple-evidence/result.json。
- 14g追加验收第一次误用已被stop_worker撤销的成员，读取被正确拒绝；第二次仅恢复浏览器登记后，runtime正确拒绝不存在的worker接管。均不能当作14g通过。独立evaluator用仍存活M3协作者补验，结果待回。
- 用户02:18要求总耗时≤2小时；截图当时1h33m26s，最终汇报须在约02:44前。主线程明确停止新增实现，仅收尾检查/证据/人评说明。

## 2026-09-08 最终收尾验证

- 14g由独立evaluator补齐全部条件：M3存活worker，接管前后完整长字段读取，main/worker各fill/js/page_operation共6次拒绝，页面状态逐字段不变；/tmp/sideagent-shared-read-live-evidence/result.json 5/5。
- 原生截图发现旧历史耗时59s被误算1.4s，编排先追加23/24，extension worker修复occurredAt+回放时钟；旧无时间数据隐藏耗时。真实M3 cid795c5b74-9970-4da4-b1c8-3ec69e7b1acf首显/重开均1.9s，旧37ab run-time为空，/tmp/sideagent-history-timing-evidence/result.json通过。
- 最终02:33全量typecheck/test/build通过，61files/550tests；扩展已重载最新产物。原生sidebar实际尺寸419x934，截图/tmp/sideagent-session-ui-evidence/native-panel.png；人工观感仍未替用户批准。
- 不再新增实现。明确短样本双Agent59s，早期单Agent约24s，当前不宣称总耗时收益；模型分工文字仍偏技术化。

## 2026-09-08 跨会话记忆原型准备

- 用户批准先交付独立完成标准和“记住—使用—管理”的可点击原型，未批准产品实现。
- 已读取 Will’s S 原文：渐进式揭示、指引与反馈、用户控制与自由；本地 living/inline 仅借文字层级，沿用现有侧栏视觉。
- 两个判断点：保存回执是否清楚；管理入口使用会话内抽屉还是独立视图。候选范围“所有会话/当前站点”保留人评。
- 本阶段不接真实模型、不保存正式记忆、不修改产品代码。待完成原型浏览器路径检查并交付人评。

## 2026-09-08 跨会话记忆原型交付

- 产物：`docs/evals/20260908-cross-session-memory.md`（独立标准）、`20260908-cross-session-memory-preview.html`（双方案）、同目录 design/results 文档；开发日志 `docs/devlog/20260908-02-跨会话记忆先看使用路径.md`。
- 原型浏览器事件链20项、独立脚本反例7项通过；原生点击主路径、390px深色/1440px浅色已检查。证据 `/tmp/sideagent-memory-prototype-evidence/`。测试初次误点遮罩的失败与纠正保存在results中。
- 只模拟显式记忆与会议材料；修正任意任务伪造使用、历史版本错显、删除后失败重试复活、来源会话不准确等问题。
- 产品代码0改动，未跑产品测试，未接真实Pi记忆。待用户选择A抽屉/B独立管理、第一版显式记忆及范围规则。

## 2026-09-08 跨会话记忆正式实现启动

- 用户选 A 并明确“开始吧”，不再优化原型。独立校验在实现前更新范围语义：site是适用范围，不是单用户管理权限边界；固定11项行为测试先红。
- 共享协议 `shared/memory.ts` 与 memory_list/update/forget、memory_result、memory事件已增加，协议聚焦5项通过。main将共享本地MemoryStore传入会话工厂与管理器。
- 工作区原有未跟踪目录和原型/研究文件保留。产品浏览器确认是local.yishu.chrome-main、ChromeMain profile、9222；未启动默认Chrome、未操作用户网页。
- 下一步等runtime/UI完成聚焦检查后集成，通过实际正式sidepanel与M3验证保存、相关使用、修改忘记和重启。

## 2026-09-08 记忆存储与M3首条链路通过

- 独立存储11项通过；7个独立Node进程中的5项持久化/版本失效检查通过，证据 `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-memory-persistence-QEIdiG/result.json`。
- 全仓typecheck通过，首轮全量65files/579tests通过（13:57），前端仍补CSS，不作为最终构建。
- M3真实模型用产品BrowserAgentSession+隔离临时MemoryStore验证：自然请求保存一条偏好；新建独立Pi会话仅给会议记录，出现used事件并输出3条。证据 `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-memory-model-FAet2j/result.json`。这不是浏览器UI验收。
- 主线程准备 `scripts/acceptance/memory-browser-run.mjs`，只用ChromeMain实际sidepanel原生Input与M3，不注入回复/内部状态，测试结束清理本轮合成记忆。
- 已修shared守卫hostname反斜线与sourceConversationId长度；运行时继续补自然句末“请记住”、明确域名范围和取消等待写入的检查。


## 2026-09-08 A 版记忆主路径落地

- 用户改为今后不再派子代理；已派出的完成后不再追加。用户要求按“点击/输入/看到”的产品语言沟通，已写项目 AGENTS.md。
- 正式侧栏真实 M3 保存→新会话使用→查看→修改→忘记 8/8；扩展和伴随进程重连后同路径 9/9，证据 `/tmp/sideagent-memory-reopen-evidence/result.json`。本轮测试记忆已清理，原有数据保留。
- 主要文件：shared/memory.ts、shared/protocol.ts、agent/src/memory-{store,runtime}.ts、session/conversation-{manager,runtime}/main、extension/src/sidepanel/{main,memory,styles,steps}；协议说明见 docs/protocol.md。
- 主线程修复中文数字标题相关性、通用词误选、句末明确记住授权、会话索引临时文件重连碰撞；noContextFiles:true 保留，产品不加载开发规范作为用户记忆。
- 14:39 typecheck/build 与 68files/586tests 通过；原有真实浏览器 accept:sessions 17项通过。新增两项可控的删除/接管晚到测试，运行时专项 8/8 通过。
- 尚缺完整 Chrome 重启、Chrome 配置隔离实现、本轮相反格式与接管交错的真实组合验收。不要宣称全部 R 项通过；标准和现有证据见 docs/evals/20260908-cross-session-memory.md。

## 2026-09-08 网页经验第一轮实现

- 用户授权执行“纠正一次默认当前页导出，下次参考并核对全量结果”的竖切；完成标准先写于 docs/evals/20260908-browser-experience-memory.md。无子代理。
- 已增加 ExperienceStore/Runtime：独立持久记录、纠正关联、后台普通模型提炼（无工具）、来源短引用校验、恢复重试。普通网页任务只留事实，第一轮仅从直接纠正提炼待验证做法，不自动升级技能或宣称任务成功。
- 通过 MemoryStore.createExperience 幂等发布到已有管理抽屉，按任务主题和网站选择，用户修改优先，忘记留下 runId 抑制记录防后台复活。MemoryRuntime 仍在单轮前重读版本和接管状态。
- 首轮真实 M3 导出已产生20/200的默认结果；提炼引用合并了不同原文片段，严格校验拒绝，未发布经验。失败在 /tmp/sideagent-experience-live-evidence/attempt1.json。改为短连续引用后相同材料真实模型来源检查通过，正在重新跑完整网页路径。
- 曾把后台模型调用和任务落盘排同一队列，已分开，模型等待时新任务记录仍可落盘；专项9项通过。14:39基线后最新全量69files/597tests通过（15:12，后续少量修正仍需最终检查）。
- EverOS 本轮尚未接入。已在开工前说明：先复用当前模型完成行为链路，独立服务接入留后续，不声称已有语义搜索。


## 2026-09-08 网页经验第一轮收尾

- 最终正式扩展sidepanel标签+真实M3，主路径7项通过，另实际CSV347条逐条核对通过，证据 /tmp/sideagent-experience-live-evidence/result.json；截图 experience-source.png / next-task.png，导出 exported-customers.csv。
- 实测场景为先按默认导出20/200，再明确纠正范围；B新任务改为347条和改版按钮，检索到了经验并完成全部导出。无关任务、忘记后新任务均未带入该经验。不要把这称为有对照的可靠性收益。
- 支持用户消息唯一明确网址优先于旁边活动页；不改变页面归属/接管权限。没有目标网址或起始PageContext时不在中途自动补入站点经验。
- 最终typecheck/build、69files/601tests通过；accept:sessions17项通过，证据 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-08T07-40-44-812Z/。
- 已检查final diff，未commit/push，原工作区变化保留。人评待验证文案清楚程度；EverOS/自动成功经验/技能升级未做。


## 2026-09-08 Apple UI 简易预览

- 用户要求先看改后效果。新增 docs/evals/20260908-apple-ui-preview.html，左右同任务：现有结构示意/推荐方案，发起/执行/结果三个阶段，可点接管、交还、记忆和依据。全是模拟，不接模型。
- 应用内浏览器实际截图及主路径已检查，交付用户判断；不继续打磨原型，不改正式产品。标准与检查见同名 md。

## 2026-09-08 父 Agent 管理 worker 页面

- 用户批准同会话父 Agent 可接管/关闭 worker 页，结束后回收全部历史页，跨会话继续隔离。冻结标准 `docs/evals/20260908-parent-tab-control.md`。
- 原因：页面授权名单没有父级管理语义；stop 只回收显式 sharedTab，独立页面没有移交。现新增生产管理 RPC、停止调用闸门和持久停止标记；页面移交前排空完整调用。
- 主代理独立实现。运行期间已有记忆工作被提交为 checkpoint；当前在最新 HEAD 上保留该成果，未回滚。
- 改动集中 fleet/tools、background state/worker-tab-control/controller、协议和聚焦测试。待全量检查与真实浏览器/模型清理路径验证。

- 父页面控制首轮真实 Chrome 生产链10项通过：跨会话/普通worker管理拒绝、旧操作结束后移交、迟到操作拒绝、两个页面全部关闭；证据 `/tmp/sideagent-parent-tab-evidence/result.json`。
- 新增共享页队列停写条件，防止已排队但未开始的动作在停止后执行。移交测试26项通过；类型检查/构建通过并重载。
- 模型验收第一次桥接遗漏原RPC id，修复脚本；第二次模型多开空白页导致两页条件失败，保留 `/tmp/sideagent-parent-model-evidence/attempt-extra-blank-tab.json`，不放宽标准，明确spawn初始URL再跑。


## 2026-09-08 用户收窄界面改动范围

- 用户只认可输出文字结构、排版和加粗，不认可更换原有界面设计。已按7a92d5f恢复main.ts及所有周边UI改动，仅保留assistant正文CSS和final reply格式提示。未回退另一组父级页面接管改动。
- 回退节点已提交；当前文字排版修改暂不提交，待用户判断。旧广泛改动差异存/tmp/sideagent-ui-scope-correction.patch仅供追溯，不作为实施方案。

- 用户随后认可截图中的“查看执行过程”，要求保持在正式回答上方。只保留该标题/列表图标，恢复原本先过程后回答的位置；不移动到回答末尾，不改变其他控件与配色。

- 父页面控制最终：真实 M3 worker 两页保留 → 自然请求父 Agent 清理 → Chrome 两页消失 4项通过（生产Fleet固定派工初始条件，未伪造模型输出），`/tmp/sideagent-parent-model-evidence/result.json`。
- 最终typecheck/test/build/diff检查通过（最新全量71files/616tests），权限真实Chrome10项、现有会话/共享页/接管回归全通过。扩展重载成功；清理了中断脚本遗留的本轮测试页，未关闭用户页面。没有commit/push。
- 尚无人评提示文案。自主派工失败/超时记录保留，未作为本权限修复的成功证据；最终标准与边界见 `docs/evals/20260908-parent-tab-control.md`。

## 2026-09-08 全双工视频学习与讨论准备

- 已完整读取 Google Cloud Tech / Annie Wang 的 `YGgErBnx6po` 英文字幕，并查官方 Live API 的异步工具调用和打断文档；视频画面下载 403、专用 Chrome 打开超时，未核对听感或测延迟。简介章节时间有误，笔记按实际字幕定位。
- 研究：`docs/research/20260908-full-duplex-video-study.md`；标准：`docs/evals/20260908-full-duplex-video-study.md`；日志：`docs/devlog/20260908-06-全双工先围绕持续纠正来讨论.md`。
- 当前源码有文字 steer、takeover/handback/abort 和会话隔离；未找到生产音频采集/播放入口。held 状态拒绝普通消息，因此后续“用户自己操作、同时问它”不能只接语音转写到现有消息入口。
- 待用户讨论的候选路径：Agent 操作网页时，用户口头改条件、询问进度、打断播报、拿回页面，再交还继续。停嘴、改任务、停手需要分别定义。未选择服务商、数值阈值或界面，未启动产品实现。
- 本轮只新增上述 3 份文档并追加本节；其他未提交改动保留。原字幕与元数据在 `/tmp/ego-YGgErBnx6po*`，不进入仓库。

## 2026-09-08 主 Agent 全局浏览器能力

- 用户进一步明确：主 Agent 代表用户全局查看/操作，隔离约束用于子 Agent 和执行冲突。要求最小有效改动，不跑全量测试。新标准 `docs/evals/20260908-lead-global-browser.md` 替代旧标准的跨会话主Agent拒绝项。
- 定点修改现有list/snapshot/read路径（全局只读不认领），复用worker_tabs检查/移交与ConversationManager运行时索引协调旧成员，不新增消息协议或合并会话上下文。
- 新增4条目标用例先红，正在跑权限/读取/协调相关文件和真实浏览器检查；不运行全量测试。原有侧栏和上一轮权限改动均保留。


## 2026-09-08 圈画手绘样式未出现的只读排查

- 当前工作区为 `/Users/mahaoxuan/Desktop/ego`，分支 `feat/session-management`，仅一个 worktree；手绘提交 `3d65fcb` 已在当前 HEAD `7a92d5f` 的祖先链中。五个本地分支并未造成此次手绘代码缺失。
- 经仓库 `discoverChromeMain` 校验，只连接 `local.yishu.chrome-main` 对应 ChromeMain（端口 9222）。读取实际运行的扩展 service worker 脚本，SHA-256 与当前 `extension/dist/background.js` 一致：`ecfc45e2e5821dca3fc99353991a49e308570651d4302d44a6e841dd9c9c9dce`；运行脚本已包含手绘选择逻辑。未重载扩展、未修改浏览器状态。
- `extension/src/background/exec/input.ts` 的 mark 默认规则为 teach → sketch、act → rect，与原手绘 eval 标准 2 一致。实读运行时存储的全局及所有会话模式均为 act，与用户截图的蓝色矩形相符。
- 另发现多会话接线遗漏：`background/index.ts` 已按 conversationId 写模式，`mode.ts` 已按 conversationId 存取；但 `input.ts:1152` 仍调用无参数 `getMode()`，固定读取 default，全局模式可能覆盖当前会话的教学选择。此项来自当前源码与实际运行脚本检查，尚未切换教学模式复现或修复。
- 本轮只作诊断，未改产品代码。待决：修复 mark 读取当前会话模式；若普通模式圈画也应手绘，需要更新原先仅教学模式采用手绘的产品范围。

- 全局能力最终：相关6组43项与补充5组46项测试通过（有重叠，不汇总），类型/构建/diff检查通过。按用户要求未跑全量测试。
- 真实Chrome生产ConversationManager→Fleet→RPC→controller验证10项通过，`/tmp/sideagent-lead-global-evidence/result.json`。全局查看和只读不移交；操作前等旧调用完成，实际关闭接手页，无关worker可继续读取。
- 扩展已重载。无commit/push。新标准明确替代上一轮对主Agent的跨会话拒绝边界，子Agent和用户接管约束保留。

## 2026-09-07（下午）issue #4 断线发送保留正文与引用（fix/stability-issue4-send-delivery）

- 标准文件：docs/evals/20260907-send-delivery-reliability.md（C1–C7 校验方原文 + 实现笔记含全部命令/退出码/剩余边界）。
- 改动：relay.ts 新增 `{kind:"delivery",seq,ok:false,original}` 最小回执；background client 分支畸形守卫 + 上行不可用回执（额外修复 C1 发现的畸形信封 TypeError）；main.ts send()→boolean、sendInput 失败保留正文/引用/存储 + 未发送提示、回执按 seq 标记气泡 + 原文重试（绝不碰输入框）；styles.css 未送达样式。
- 测试资产：extension/test/panel-delivery-check.mjs（生产 UI + Port 边界注入，8 场景 46 断言）、panel-delivery-e2e.mjs（真实扩展 + CDP 真实杀 SW，11 项）、delivery-receipt.test.ts（真实 background 路由，5 例）。Playwright 一律 headless（用户要求不抢前台）。
- 结果：旧代码 4+4 失败 → 修复后全绿；npm test 390 全过；overlay/browser/team 验收在新构建复跑 PASS（reload:ext 后再各一轮）。
- 证据（本地，按惯例不入库）：docs/evidence/20260907-send-delivery/（前后回归 log、e2e 三截图 + result.json 含 SHA）。
- 剩余边界：瞬死毫秒竞态、native 接受后 agent 崩溃的"已接受未知处理"、idle 态 steer 重试语义、真实 side panel 容器观感待人评——详见标准文件。
- ChromeMain 已 reload 到本分支构建；PR 开向 fix/takeover-handoff-closure，不自动合并，#1 保持开放。

## 2026-09-08 分支收拢

- 用户选择清单除本地工具记录外全部保留，最终仅main与feat/session-management并保持一致。先提交原有排版/研究记录，合入issue4真实分支，保留原提交祖先链。
- 合并适配现有多会话、附件与历史耗时：上行失败回执带原conversationId，失败状态随用户历史持久保存；重新打开可恢复重试入口，不重复气泡、不清空新输入。修复畸形Port消息守卫。
- mark默认样式改为读取执行成员所属conversationId的模式。真实Chrome teach绘手绘、act绘矩形通过。
- 针对性4文件30测试通过；浏览器8项通过（2个真实mark路径、6个生产sidepanel界面+Port故障注入场景），证据 `/tmp/sideagent-consolidation-browser/result.json`。后台回执另以生产controller测试，未把UI故障替身称为网络端到端。无全量测试。
- 首轮浏览器挂钩超时是重载后旧SW上下文chrome不可用，重新重载恢复；失败未算产品通过。

- 分支收拢完成：用户选中成果均已提交，main与feat/session-management已同步推送；三个旧fix分支在确认其全部本地/远端提交都是main祖先后删除。当前切到main。本地三个工具目录保留且忽略，工作区干净。完成标准 `docs/evals/20260908-consolidate-main.md` 已更新。

## 2026-09-08 全双工工程下一步讨论

- 当前 main 已核对。Pi SDK 的 steer 在当前工具批次结束后消费，held 仍拒绝普通消息；因此仅接转写不能满足“工具忙时继续聊、接管期间继续问”。
- 建议首个真实路径：选定会话开语音→发起网页任务→任务忙时追问/纠正→停播报/接管→交还继续。语音通过小接口交任务，执行层即时确认接收，随后推送真实进度结果；保持现有网页写入闸门。
- 本机候选音频资产已找到 `/Users/mahaoxuan/Developer/yishu-toolbox/toolbox/realtime-voice-probe/`，采集、播放、speech_started 处理存在；本轮未调用真实上游，未决定供应商。
- 细节追加在 `docs/research/20260908-full-duplex-video-study.md` 第 8 节与当日日志。只记录建议，未改产品代码、未启动实现。

## 2026-09-08 Step Plan 全双工官方调研与真实探针

- 用户确认“complain”指 Step Plan，并随后提供 Key。仅在隐藏输入的探针进程内存使用，未读取其他现存凭据、未落产品配置；包装进程已退出。供应商固定阶跃星辰，端点固定 `/step_plan/v1/realtime?model=stepaudio-2.5-realtime`。
- 官方模型/API/开发指南与 Step-Realtime-Console 源码已核对。音色“我的音色 03”实测接受。24 kHz PCM 流式输入、server_vad、ASR 和音频返回有成功样本；未开麦/播放/操作网页。
- P3 真实协议闭环通过：accepted/task_id → 后台延迟30秒 → 约3.1秒时完成独立问答 → 完成后回读新的随机词。system 角色注入返回400，仅 user/assistant 被支持；最终采用有应用数据标记的 user 消息，产品内仍需保留 task_result 来源。
- 自定义工具确能调用并回读随机结果，但 P2 重复/变体与 P6 自然语音出现未调用；自动与手动提交都曾成败，不能只凭单次成功选择模式。下一步建议先做语音查询真实任务进度与可见回执，再扩大网页操作。
- response.cancel 后收到 incomplete，严格终态检查失败；2个残留音频块需要播放器代次拒绝。conversation.item.truncate 两次获得确认，尽管当前API目录未列。不要整块照搬旧 OpenAI 派生示例或旧音频探针。
- 交付：`docs/research/20260908-step-plan-full-duplex-integration.md`；标准：`docs/evals/20260908-step-plan-full-duplex-research.md`；日志：`docs/devlog/20260908-08-StepPlan语音接通与任务回灌.md`。证据索引 `/tmp/ego-step-plan-research/results-index.json`，保留6轮全部结果。无产品代码改动、无commit/push。


## 2026-09-08 语音光球参考：用户调整设计方向
- 用户已认可输入区语音问进度入口，随后要求先参考 GitHub / 开源设计库中的光球式语音 Agent；暂停正式入口 UI 实现，保留已写的语音后端、协议、relay、音频基础文件。
- 已有生产进度观察与 Step 会话测试，上一阶段 3 个文件 12 项通过、typecheck 通过；新 relay/player/worklet 尚未完成集成与重新验证，不能称为已交付。
- 本轮在线核实参考：VoiceOrbs https://voiceorbs.vercel.app （14 种，可切换状态）；ElevenLabs UI https://github.com/elevenlabs/ui ；Agus Ruiz voiceorb https://github.com/aguscruiz/voiceorb （四种状态、音频响应的概念验证）。
- 首先让用户看 VoiceOrbs 中 Plasma / Glass / Nebula。尚未选定光球样式，未把参考搬进产品。CUA 打开图库超时，不能声称已观察实际动效。

## 2026-09-08 粒子球输入区预览
- 用户选中 VoiceOrbs Particles Orb，授权放入输入区动态预览。新增 docs/evals/20260908-particles-voice-preview.html 和 voice-orb-assets/particles.js、LICENSE。保留旧对照。
- 粒子算法从 MIT 来源改编为独立 Canvas 模块；原型仅模拟状态，不采集、不发声。入口 36px，展开 Canvas 160px；切换连接、聆听、思考、回答、插话、失败和结束。
- 浏览器已打开验证入口、展开和回答状态；粒子布局仍待用户主观认可，未接入正式 UI。

## 2026-09-08 正式语音入口实现，等待启用扩展验收
- 用户认可粒子球预览后，新增 voice-client.ts / voice-ui.ts / voice-orb.ts，main.ts 挂载输入区入口；build 拷贝 worklet 与 MIT 授权。保留原有任务入口。
- VoiceClient 等配置 ready 后才发 PCM；播放器返回实际播放位置用于 truncate；插话换代丢弃旧音频，stop/切会话/pagehide 释放麦克风与 AudioContext。语音路由绕过任务历史与 Pi 写入口。
- 修复实测发现的用户转写晚到覆盖助手回答（分两块展示）。修复错误事件后 idle 覆盖 error（保留 error 至新任务）。替换 native 客户端前关闭旧语音，避免串连接。
- Key 仅写入 ~/.sideagent/step-plan.key，0600；不进入仓库、前端或日志。
- 15 项语音聚焦测试、typecheck、build 已通过；上次全量 642 项通过，新增两项后的全量待收尾。
- 真实 Step 服务四轮：三个问题如实回答无任务、计算回答17。生产会话/观察器 + 本机合成音频。证据 docs/evals/20260908-voice-live-empty-state.json。运行中任务和真实麦克风均未验收。
- 正式 ChromeMain 扩展当前 DISABLED，reload:ext 返回找不到重载按钮。用户启用问题异步待回复。不要用默认 Chrome 代替，也不要把合成音频当作运行中真实网页任务验收。

- 收尾：77 文件 / 644 项测试、typecheck、build、diff --check、仓库和 dist 凭据扫描通过。顺带修复 experience.test.ts 清理竞态（dispose 后等待 flush，未改断言）。当前唯一外部阻塞是扩展 DISABLED，真实浏览器与真人听感待启用后验收。

## 2026-09-08 麦克风首次授权修复
- 用户真实截图 NotAllowedError。ChromeMain 原侧栏实时读取 permission=prompt、secure=true，定位为侧栏无法弹首次授权框；不等于用户明确拒绝。
- 新增独立扩展授权页，侧栏失败提供“开启麦克风”；用户点击后 getUserMedia(audio only)，立即 stop 所有轨道，回侧栏手动重试；不自动监听。授权失败给 Chrome/macOS 设置指引。
- 文件：extension/voice-permission.html，sidepanel/voice-permission.ts、voice-permission-page.ts，voice-client.ts、voice-ui.ts，build.mjs；voice-permission.test.ts。
- 8 个相关测试/typecheck/build/diff-check 通过，正式 ChromeMain 扩展重载成功。真实“允许→返回→听说”仍需用户选择授权后验证。CUA wrapper AX 超时，不能称整条真人路径已通过。

## 2026-09-08 语音调整任务：初版被实测推翻，应用路由已修正
- 用户正常语音对话测试通过，授权下一步语音操作；本轮首条路径仅调整运行中任务条件，暂停/继续、新建任务随后做。
- 新增 BrowserAgentSession.steerCurrentTask（await Pi队列，不idle fallback）、ConversationManager.steerFromVoice（同一startedAt运行校验、成功后notice持久回执）。
- 原生Step工具初版失败：口头说800但无工具回执，实际Chrome筛选仍1000/含899。证据 docs/evals/20260908-voice-steer-native-failure.json。不可称通过。
- 生产改为Step最终ASR→当前Pi模型无工具EDIT/NONE意图判断→应用await steer→回执→Step语音。只提交本轮原始转写；query/chat/quoted/pause不改任务；旧轮在分类后再次检验stillCurrent。
- 真实MiniMax-M3分类5/5通过，1.2–1.7s；真实Step无任务修改拒绝正确，确认ASR可以先于response.create得到，不需要先播放一次未确认回答。
- 新路由实测脚本 scripts/acceptance/voice-steer-run.mts：真实Pi+Step原生合成音频+Chrome本地表单（budget1000→800，单次agent_start）。复测时ChromeMain page count=0，No current window，待用户打开原Chrome窗口；未改默认Chrome。
- 49项相关测试已通过，最终typecheck/build/fulltests收尾中。仍不得标完整网页操作/真人体验通过。

- 最终655项测试、typecheck、build、diff-check与凭据扫描通过。新编译包未在无窗口的ChromeMain中重载，等用户开窗后重载并跑 voice-steer-run.mts；该脚本新增无窗口前置检查，避免模型无意义重试。

## 2026-09-08 用户两次语音失败，空转写恢复与日志补全
- 用户截图“你：”空白+通用操作意图错误。agent.log只有连接生命周期，wrapper-err.log只有provider启动，没有逐轮语音错误，不能追溯两次原始原因。
- 已复现确定缺陷：空ASR进入route，manager抛错，VoiceSession统一fail关闭连接。改为不发空转写事件、不route、不回答，ready提示“没听清这句话，请再说一次”，VoiceClient在thinking也能恢复listening。
- 真实Step静音→空ASR→原连接下一句合成问10+7→回答17通过；docs/evals/20260908-voice-empty-recovery.json。仍不声称真实用户采音正常，用户两次说了什么/球是否起伏的异步问题待回复。
- 新diagnostic经VoiceService接main.log，带voiceId/cid/turn和PCM量/RMS/峰值、ASR长度、route开始结果失败耗时；不记录录音、转写内容或凭据。VoiceIntentError区分模型不可用、超时、失败、格式无效。
- 657测试、typecheck/build/diffcheck通过，插件正在重载。预算操作的完整真实网页验收仍是未完成项，勿漏。

## 2026-09-08 分批提交与推送
- 用户明确授权将当前全部改动分批commit并push。按文档/测试清理/语音后台/前端接入拆分，目标分支codex/voice-task-progress。
- 提交前diff检查和凭据扫描通过；最近全量657项测试、typecheck和build通过。真实空输入恢复通过，预算800网页完整验收仍未通过，提交不改变这一结论。

## 2026-09-08 统一到 main
- 用户明确授权各分支统一到 main。fetch 后核对全部本地/远端分支：feat/session-management 已在 main；codex/voice-task-progress 仅领先5个提交，无分叉冲突。
- main 已快进吸收语音分支，工作目录切回 main。整合后78文件/657测试、typecheck、build、diff检查通过。
- 保留功能分支历史，不删除分支。语音预算调整的真实网页验收仍未完成，合入主干不等于该项验收通过。

## 2026-09-08 语音调度对齐与扩展执行方案
- 用户要求可验收工程方案；已新增 docs/evals/20260908-voice-dispatch-parity-plan.md，未改产品代码。
- 核对文字user_message/steer、语音EDIT/NONE及扩展control流程；方案统一操作回执和任务身份，暂停/继续必须复用页面冻结与快照交还。
- 分P0–P6：复现基线、可靠修改、启动与分流、控制任务、资料对齐、指定会话与连续指令、真实耳麦验收；12条用户路径、故障矩阵和真实Chrome证据门槛已列出。
- 4秒反馈、200毫秒检测后停声是拟定验收目标，不是已测结果。真实预算800路径仍待验收；本轮只检查文档diff，未跑运行测试或提交推送。

## 2026-09-08 P0文字／语音预算修改基线完成
- 用户只授权开始P0，未进入P1。冻结 docs/evals/20260908-voice-dispatch-p0.md，重建成对验收脚本和严格DOM判定器。
- 首轮文字遭遇真实529；语音测试等待门被模型同步返回，任务过早结束，语音正确拒绝。保留该轮并标明不用于运行中修改判定。修正测试同步，不改生产代码或断言。
- 有效第二轮两路均得到budget=800、prices=[699,799]、sort=asc，各一次agent_start；语音一次回执且先于音频。证据摘要 docs/evals/20260908-voice-dispatch-p0-results.json，原始 /tmp/ego-voice-p0-2026-09-08T13-47-32-153Z/。
- 聚焦与全量79文件658测试、typecheck、build通过。前置故障注入确认为blocked/exit1。单样本语音提交到首音频3423ms，不代表P95。
- 仍缺正式runId/requestId、持久回执、断线unknown与重启恢复；侧栏和真人麦克风未验收。未提交推送。

## 2026-09-08 P1自动部分完成，继续P2–P5
- 用户授权“先把不需要人工语音测试的做了”；范围包括自动可验的P1–P5及合成语音/故障/Chrome验证，真人听感最后保留；不新增子代理。
- 新增shared/task-actions.ts、agent/src/task-dispatcher.ts：正式请求/任务身份、按会话串行接收、本机私有回执记录、重复请求不重做、pending/损坏/落盘失败结果unknown。TaskProgress新增runId；主服务挂载TaskReceiptStore。
- 文字运行中输入和生产语音路由共用dispatchTaskAction与steerCurrentTask；语音请求ID固定到轮次，查询与重连回放结构化notice回执；侧栏历史/呈现去重并显示原话。
- P1自动验收81文件667项测试、typecheck/build/diff通过。P0真实两路回归 /tmp/ego-voice-p0-2026-09-08T14-48-54-962Z/通过。安装侧栏原生回执查询/刷新 /tmp/ego-receipt-ui-1788879284365/通过；截图已看。
- P2标准 docs/evals/20260908-voice-dispatch-p2.md 和48句分类集 scripts/acceptance/voice-intents.json 已在P2实现前冻结；下一步结构化分类与语音start。P3控制需沿真实扩展control协议；禁止仅停止模型就宣称页面停手。

## 2026-09-09 语音调度自动验收（续）
- 684项单测通过，typecheck/build通过。真实双成员控制 `/tmp/ego-voice-control-1788886567789` 已通过暂停回执、5秒零写入、暂停修改只保存；恢复失败定位为扩展将 `partial` 中仍有 `restoring` 成员误判终态。改为等全部恢复结束；同路径复跑中。
- P5 已接入讲话开始时捕获真实会话目录/runId，显式名称解析、跨目标输入隔离、回执来源/目标双写与磁盘查询、90秒且紧邻下一轮的另开确认。13项管理器测试通过，新增目标替换/重名/跨源资料/复合中断/换连接取消确认断言。真实Chrome尚待跑。
- P4新增真实图片和选区表单脚本 `voice-context-run.mts`：7391仅存在测试图中，海风选区读取后从网页删除，页面实际值和主动结束播报作判定。未以模型文字声称代替表单读数。
- P3完整真实路径第一轮通过：`/tmp/ego-voice-control-1788886790121`，13项检查（含人工标记、600预算、同runId、终止5秒零写、旧写拒绝）。新增扩展回归测试重放restoring→partial→restored，必须等最后成员。
- P4真实资料+主动播报第一轮通过：`/tmp/ego-voice-context-1788886954229`，实际输入7391与海风；主动结束播报未声称成功。
- P5真实第一段通过，第二段失败：`/tmp/ego-voice-target-1788887465193`。“暂停春日旅行并改600等我继续”生效且5秒稳定；“改800再600然后继续”被模型漏掉resume，页面保持暂停，已加结构检查与限时一次重分类，未重载/复验。更早失败保留（ASR绘画、数字名转换、模型超时）。48句3轮最近两次140/144，不能标通过；改为串行减少模型并发干扰，仍待新一轮。
- 2026-09-09用户明确回来可做人工语音测试。自动浏览器脚本已结束；真人页由 `voice-human-run.mts` 进程保持（exec session28186），http://127.0.0.1:59439/，conversation `7aa509f4-870e-4504-afc2-fa25303ff61e`，tab29956923，证据目录`/tmp/ego-voice-human-1788887715503`。已交给用户浏览器，等待第一句“预算800升序筛选一次”反馈。期间禁止自动浏览器写入/切换/重载，只跑本地检查。新增P6人工合同。
- 真人第一句已确认通过：用户反馈“听写正确，听到反馈，页面显示699和799”，截图显示预算800、升序、筛选次数1。只读事件快照保存 `/tmp/ego-voice-human-1788887715503/first-human-turn.json`。截图语音区仍显示“正在查看任务进度”，需核对状态收回，不据截图直接判bug。下一步请用户测讲故事时插话“别说了”，浏览器仍归用户。
- 真人连续对话/追问反馈正常，但首次故事请求未接上。用户明确尚未测“别说了”，不能记插话通过。只读证据 `/tmp/ego-voice-human-1788887715503/conversation-human-turns.json`：第二条语音连接turn2完整转写“可以给我讲个比较长的故事吗？”，随后空识别ready，turn4重说成功；第一条连接turn3也有完整转写后空轮。不能归因为麦克风完全没收到，也未证实空轮来自噪声。待定位空轮打断路由/回复，以及空识别提示覆盖正常对话的状态问题。
- 真人插话停播已确认：用户说“对，基本上就停了，直接就停”，截图转写“好了，别说了”。记为一次主观即时停止通过，不声称已测P95≤200ms。截图仍显示“正在查看任务进度”，silence结束后VoiceClient thinking→ready状态收回需修；当前用户浏览器不重载。下一项为持续筛选任务的语音暂停，区分停止音频与停止页面。
- 真人YouTube请求后持续重连：只读证据`/tmp/ego-voice-human-1788887715503/reconnect-human.json`。请求7fd2c424-21bf-4438-ae07-ec71a9f71de9-4已有accepted回执，run425d6fac-3034-4b82-b82e-f7bab8c105b3；不能把接收当打开网页已成功。语音多次connecting后用户closed。
- 已复现并修复无限重连计数错误：旧connectedAt超过一分钟，每次失败都清零reconnectAttempts。现在第一次断线后清空connectedAt，只让新的健康连接重置重试额度。新增测试先红（5个socket超过4上限），修后18项voice-session测试通过。未重载，浏览器仍归用户。待收回浏览器完成真实故障复验。
- 用户追加：希望语音助手也能通过截图看到当前页面。已冻结`docs/evals/20260909-voice-page-observation.md`并实现observe分类→固定提交tabId→只读snapshot+screenshot→现有M3多模态回答→固定内容语音回执；普通chat不读取，指定其他会话先澄清，旧轮失效不发布观察。类型检查与相关40项测试通过，真实路径尚待重载后验。范围是浏览器标签页，未实现桌面其他app屏幕。
- 同时修复VoiceClient收到无音频ready后仍停thinking的UI状态：明确ready且用户/播放器都没在说话时回到listening；补回归测试，构建完成。用户浏览器仍未重载。


## 2026-09-09 按项目规范补齐文档
- 用户要求先做文档整理，未授权本轮提交或重载。新增docs/STATUS.md作为进度入口；README和protocol链接到状态及docs/voice-dispatch.md，补齐任务身份、回执、控制确认、语音归属与只读观察语义。
- 总方案更新当前状态，P2–P6与页面观察标准逐份追加验收补记，不改冻结断言、不把部分通过勾成整项通过。P1保留已有阶段记录。
- 新增docs/evals/20260909-voice-dispatch-results.md与evidence.json。核对原始JSON，保存检查、实际页面值、失败分类与原文件SHA256；更正P3检查数为12而非此前笔记的13。原始大文件仍在本机临时目录，历史版本未完整记录的缺口明确保留。
- 更新当日开发日志，补真人反馈、重连/状态缺陷、只读看页方向与实际结果。最新全量694属于后续改动之前，相关18/40/22项集合不能相加。
- 待继续：首句空识别问题；获得用户交回浏览器后加载修复；真实看页/重连验证；P5复合恢复；完整分类和三轮回归；真人控制与时延。faults/extensions/restart脚本尚未运行，不能把存在当通过。
- 文档核对结果：检查16份Markdown的33个相对链接，均存在；5份归档摘要与原始JSON检查/计数/SHA256一致；git diff --check通过。与整理前的差异统计对照，产品与测试源文件没有新增改动。文档变更未重新跑产品测试，未重载浏览器，未提交推送。

## 2026-09-09 提交与云端评审准备
- 用户明确要求push，并把疑问写详细以转交云端ChatGPT6Pro。新增docs/reviews/20260909-voice-review-brief.md，列8组问题、观察事实/猜想/已试方案、源码阅读顺序和期望输出。新增脱敏真人诊断节选65条，包含9次重连，不上传原始录音或完整私人页面。
- 最后差异检查发现来源侧回执被parseServerMessage拒收；新增协议测试先红后修，目标或明确来源可接收，无关会话仍拒绝。用户可见双侧重载仍未验证。
- 推送范围是当前工作目录中的本轮源代码、测试、脚本、规范与证据；不是验收完成或发布。浏览器不重载。

推送前最终检查（2026-09-09）：85文件697项测试通过，typecheck/build/diff检查通过；新增来源侧回执测试先红后绿。暂存文本未命中配置的凭据模式，JSON与评审链接检查通过。未重载扩展、未重跑真实语音及浏览器验收。

## 2026-09-09 云端评审后的实施开始
- 用户已明确采用两项推荐：空识别后自动接回非操作回答；“当前页面”默认可见区域。其他可执行工程修复与测试一并授权。完成标准冻结于docs/evals/20260909-voice-reliability-r1-r5.md，保留旧时延/三轮门槛。
- R2先补恢复后缺ASR、缺指令配置确认的红测，两项均复现；保持原轮绝对等待期限，重连不清除它，创建回答不滚动延长。超时后如已有路由/操作结果，引导查看原回执，不让用户直接重做。20项voice-session测试通过，尚未真实复验。
- 异步route_result/route_error记录捕获的原turn及requestId，另记superseded，不再把旧路由错误错写到当前新轮。
- 当前只做本地实现，尚未重载用户扩展；R1、R3–R5与全部真实验收仍继续。

2026-09-09 R1/R2 实施中：新增原请求记录，候选空识别后等待旧判断结果；仅 chat 继续回答，observe/status 走受限只读恢复，action 只补已有回执。新非空轮丢弃旧恢复；旧写指令仍被 stillCurrent 拒绝。voice-session 25 项通过，新增空轮/接受回执/新输入/重新观察/生成后断线测试。全量首轮 703 通过、1 失败来自旧写指令原应 reject；已保持原 reject 契约修复，待重跑。重连保留初始30秒截止时间及待播放结果。未重载扩展、未运行用户浏览器。

2026-09-09 R3/R4/R5 实施中：新增 voice-observation 独立只读授权；实际活动页发放60秒令牌，不走任务控制门、工作页绑定、定位引用或标签激活。捕获前后核对 active tab、documentId、timeOrigin、URL、视口/滚动/可见文本，同URL重载亦拒绝混合证据。观察/relay/manager24项通过，typecheck通过。R4先红后绿7个合法形状错误候选（漏暂停/继续执行/否定/条件/引用/漏目标），全文片段覆盖检查已加；新每步text+target oracle另存文件，原48句要求保留；真实144分类运行中。R5新增 voice-plan-store 在分类前持久claim，步骤执行前记pending，重放只取原结果或unknown；稳定另开会话ID/持久proposal，控制版本阻止新接管后旧计划resume。针对磁盘/重启/并发/损坏/新接管测试22项通过。仍未重载或操作用户浏览器，已异步询问当前使用状态，尚未答复。

2026-09-09 R1–R5追加验证：全量87文件721测试通过（其后又加测试待最终全量）；新增source-plan协议与PanelHistory持久/去重测试，错误后unknown不误报未执行，空轮不延长原deadline，分组通过。复合计划摘要使用既有notice展示各步回执与未执行，来源侧按planID查询/重载；proposal消费落盘。新增voice-production-audio-run.mts准备生产VoiceClient/AudioWorklet/VAD/Player实际WebAudio注入流，尚未运行，不算人声或时延通过。144真实分类首轮仍在跑，已有start-03一次错误（整理选区误判observe），提示词已明确产出任务与页面问答边界，需下一轮验证最终源码。无浏览器交接答复；未reload/切页/commit/push。

2026-09-09 浏览器已由用户明确交回（request_user_input_async 回复“可以接回浏览器做测试”）。最终一次本地typecheck/test/build通过87文件726测试，扩展已重载。生产采音首轮实际WebAudio→VoiceClient→Worklet→VAD→Step→Player通过功能路径，/tmp/ego-voice-production-audio-1788925785957，单轮首音5.563秒，不满足20轮/P95≤4秒且不是真人麦克风。真实页面观察 /tmp/ego-voice-observation-1788925850668 6项通过，前台B蓝色小船、任务A红色山丘，回答读B且无屏外底部字、无切页/改绑定，旧授权切页拒绝。新增断言确认workingTabs证据非空与tabResources未变需再跑。144分类旧迭代完成 /tmp/ego-voice-intents-1788925081873：140/144，一次start-03误分类+3次15秒超时；没有降标准，提示词已修边界，最终源码需重跑。当前voice-control-run过程64170在跑新版主动探针+11秒稳定窗+暂停/终止观察；发现脚本worker探针写错wiki（真实ctrlworker）已修源文件，当前进行中这轮只作诊断、不计三连通过。没有其它浏览器脚本同时运行。

2026-09-09 强化控制验收两次失败均保留：/tmp/ego-voice-control-1788925938725 首次当前页不在HTTP测试页，正确拒绝观察（加明确选中测试页前置步骤）；/tmp/ego-voice-control-1788926022589 真实main/ctrlworker主动写探针、11秒暂停稳定、暂停观察、保存预算/恢复回执都通过，但90秒内worker未恢复计数，lead已600继续。日志worker误用page_operation（独占页），现有worker系统提示开头无差别给共享规则。新增红→绿worker-page-mode测试，fleet传shared标志、提示头明确exclusive/shared，保留共享约束；14相关测试及typecheck/build通过，扩展再次reload完成。fixture也修正等待指令用browser.sleep而非未定义setTimeout、无明确新预算的worker保留当前值；未改完成判据。增加acceptance_team_ready.models实测双会话选中模型。下一轮需验证恢复后的用户标记与预算，不宣称本轮控制已全过。分类reasoning-off仅脚本实验 --case start-03 正运行16240，生产仍minimal。

2026-09-09 控制真实路径完成一轮强化17项全过 /tmp/ego-voice-control-1788926481452，包括实际main/ctrlworker模型名均MiniMax-M3、双方主动写探针被挡、11秒稳定、新标记与lead600恢复、同runId、abort后观察仍可读、旧写被拒绝。此前失败不计三连。生产图停播脚本首版 /tmp/ego-voice-interrupt-audio-1788926952280 的918ms来自后台setTimeout轮询约1s，不等于实际音频继续；stop调用0–0.1ms，不能单独冒充停声。已改为独立AudioWorklet记录输出能量归零的audioTime，临时meter资源仅验收生成/清理；当前进程54609。VoiceClient新增可选诊断回调记录speech_detected的输出AudioContext时间，无UI改变。关闭推理实验完整144正在39374，已见start-05一次错误clarify，仍不采用到生产。

2026-09-09 性能/正确性后续：关闭推理完整首轮 /tmp/ego-voice-intents-1788926789761 137/144，p50=1.195s,p95=4.025s，失败为错误clarify、漏查询目标、未来继续误作resume及1超时，未采用生产。补4个红→绿候选校验（无对象歧义不得clarify、引用/假设/等待不能steer），重试提示明确条件和目标，compound-02无推理试点3/3。分类增加首请求6秒/次请求剩余9秒、总15秒不变的只读重试；虚拟钟红→绿。当前最终修订off144运行48399（仍实验）。Voice UI按真实阶段显示正在识别/理解/读取当前页/等待控制结果/准备回答，不再把所有thinking写成查进度。真实图停播 /tmp/ego-voice-interrupt-audio-1788927069246 20轮通过，audio quantum差值0、主线程回调约4.3–5.9ms，不能宣称零声学延迟；脚本已加入5.33ms采样量化上界，当前复跑92083。无真人P95结论。

2026-09-09 最新实测：修订后的无推理分类 /tmp/ego-voice-intents-1788927473925 全144/144，p50=1.130s,p95=3.361s,max7.214s；生产已去掉分类reasoning参数，保留总15秒及首6/后9秒只读重试，已reload。完整生产采音空轮恢复 /tmp/ego-voice-production-audio-1788927766559 通过，完整问题→真实噪声空ASR→turn2回答17，route_start只有1、无taskstart；停播图保守上界 /tmp/ego-voice-interrupt-audio-1788927484752 20轮P95=5.333ms，通过，非真人耳机测量。页面观察强化 /tmp/ego-voice-observation-1788927946977 9项全过，包含canvas独有3个圆、同URL捕获中重载拒绝、绑定/前台不变。前一观察失败仅oracle未忽略Markdown和数字空格，实际答3个；旧记录保留。faults suite /tmp/ego-voice-dispatch-1788928120700 全10项+native重启4项通过，重启证据 /tmp/ego-voice-restart-after-1788928289408；实际budget800+699/799、断线后无重路由，重启不重做。

2026-09-09 固定回执缓存：新增VoiceAudioCache，仅缓存供应商对应转写与应用固定文本匹配后音频，内存24条、不缓存动态内容。按音色/PCM/24k/文本版本隔离。VoiceService复用缓存，输出用local/cached IDs，绝不向供应商截断这些ID；重连待播放回执复用音频仍执行1次。测试改验实际重放音频而非强制response.create（实现替换、结果标准不变），28聚焦项及typecheck通过，build/reload完成。生产20轮脚本改交替短算术闲聊/空任务进度，声明有限scope，不冒充全业务/真人P95。当前独立target真实复合与来源UI重载脚本运行14029，其他浏览器脚本已结束。最后全量89文件732（缓存加入后未全量）；未commit/push。

2026-09-09 13:01 进度核对：extensions 三轮组合首轮 control/context/target（含 native restart）全过，第二轮 /tmp/ego-voice-control-1788929763525 在双方首次写入前失败。原始 events 明确 ctrlworker 请求 MiniMax 529 overloaded_error，既有三次重试用尽；worker 计数0、lead计数5。保留失败，不计三连，不据此归因暂停恢复逻辑。最新 typecheck、90文件737测试、build全过（含voice lease旧授权清理修复）；正在重载后继续真实回归。尚缺三轮连续组合通过、最终20轮生产首音时延、真人控制与时延验收；未提交推送。

2026-09-09 用户调整验收投入：询问连续回归/20轮耗时必要性，并授权低必要性项目改本人试用。判断：个人试用不应由固定重复数阻塞，仍保留机器正确性底线；更新R1–R5标准补记，原失败和数值门槛未伪造通过。最新控制 /tmp/ego-voice-control-1788930084105 17项通过。已停止extensions父调度83413，当前context子进程84584继续完成并自行清理，不再启动后续循环；浏览器交回前须确认其退出。用户另提订阅池选多个候选用于派发，认可方向，但当前尚未实现自动选取或故障转移。

2026-09-09 用户要求通用根因诊断，不做单句补丁。已完成真实M3六输入纯分类探针；另句“嗯，先打开购物网站，然后帮我查一下今天的天气”两次漏parts0，明确复现classifier_invalid_reply。源码确认routeInput业务错误→fail→关闭socket→VoiceClient释放麦克风，单句错误放大成连接故障；意图模型缺当前目标，openTab等complete，ASR→分类→回执生成串行叠加。报告docs/diagnostics/20260909-voice-root-cause.md及纯诊断候选JSON。未改产品/重载/操作用户浏览器，精确网络耗时占比仍未知。

2026-09-09 工程实现按新标准docs/evals/20260909-voice-turn-recovery-and-readiness.md推进。已做两条红→绿恢复测试：分类错误保留socket且下句只处理一次；未知路由结果不说未执行、不重放。意图接口由parts覆盖改成动作分界through，应用分配完整原话；保持原parse语义安全检查，传入600字符有界task.goal。第一轮真实六句暴露最后through冗余及任务分拆，修正等价末分界接受和同任务相邻动作合并，不删除控制检查。真实48一轮45/48失败保留/tmp/ego-voice-intents-1788931967110；针对匿名目标补澄清防误操作、重试传具体non_immediate_control原因，正在复验。页面就绪新增page-readiness模块，检查文档身份和DOM interactive，不等所有资源；4项测试通过，实际浏览器待验证。最近全量91文件747项通过发生在这些追加语义修正前，仍需最终重跑。未重载用户扩展。

2026-09-09 13:43 本轮工程本地验证完成：91文件754项测试、typecheck/build/diff通过；真实48/48 /tmp/ego-voice-intents-1788932319721，自然8/8 /tmp/ego-voice-natural-1788932500835。独立headless Chrome生产openTab/navigate 4项通过 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-page-readiness-tu07ng，资源仍loading而文档interactive、输入可用、同URL新documentId；进程退出。前两次测试脚本错选其它扩展worker导致startup timeout，已按manifest名称匹配并保留失败。不涉及用户Chrome。验收/STATUS/协议/devlog已记录本轮。未reload/commit/push；等待用户允许重载接入，再由用户判断连续语音体验。分类原句一次1.059秒，但未来条件一次重试6.388秒，不能声称整体4秒达标。

2026-09-09 用户明确同意重载后，npm run reload:ext成功，扩展报告新代码生效。用户可重新开启语音试用。本次只执行重载，未代替用户进行真人体验验收，未提交推送。

2026-09-09 14:16 语音连续对话实施启动：用户采纳调研建议，并明确指定同一 cmux 的 Kimi（K3-256k）和 Anti Gravity（Gemini 3.8 Flash）为实现者，Boss/Codex 独立 Evaluator。派发前冻结 docs/evals/20260909-voice-conversation-continuity.md，所有权与上下文接口见 docs/tasks/20260909-voice-conversation/CONTRACT.md。Kimi产出任务结果/近期上下文并接分类，Anti Gravity接语音消费/通知；双方不能改冻结标准与Boss测试。Boss独立7项验收测试已复现5红2绿。前轮脏目录基线已保存在临时目录，不commit/push/reload。下一步隔离浏览器与真实模型验证，再真人听感裁决。

2026-09-09 语音连续对话协调进展：Anti Gravity交回首版语音消费与通知，Boss初审发现按runId全局去重会吞同run控制/迟到结果、结果截断可能丢范围限制、缺runId仍接结果等缺口，已返工，未认可完成。Kimi仍在结果上下文生产实现。Boss隔离真实邮箱/任务/语音脚本 voice-conversation-run.mts 已写，语法打包通过（首次esbuild未指定esm导致脚本检查失败已纠正，非产品问题），尚未执行真实模型。

2026-09-09 14:33 Boss独立真实集成诊断：/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-voice-conversation-AUDMlz，隔离Chrome+生产工具handler/会话manager/真实M3任务+Step合成采音。实际读标题→具体发现已通过，但纠正“不是访谈，是活动邀请”后Step把橙湾访谈篡改为活动，违反事实/指代标准，整体失败并返工；口语也照搬Markdown清单。隔离浏览器确认退出；无用户Chrome操作。独立11项本地测试10通过，余一显式旧run结果被标成新run，已交Kimi修；两位执行者尚未最终停笔验收。

2026-09-09 14:42 第二次真实复验 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-voice-conversation-ZsB4U3：结果已口语化，但“活动那个呢”被分类成clarify并回“请说出目标会话的名称”，内容实体与调度目标混淆，整体仍失败；未到纠正/重开步骤。已交Kimi通用分类修复，Anti Gravity暂停等统一复验。Boss独立测试新增既定连续纠正标准的原话去重/下一轮传递案例，12项现全过。真实脚本下一轮将随机组织名称改为自然中文并换序（仍是随机实体+相同问题+事实约束，不改变通过条件），避免标题里人为哈希诱发无意义占位分析；保留前两次失败。

2026-09-09 用户指出协作中重复工作并要求执行者直接回报。Boss确认存在重复读链路、执行者也跑全量、排队旧反馈重复分析；源文件仍按所有权分工。已更新CONTRACT通信：执行者通过cmux向Boss workspace:3/surface:3发送带任务编号的ACK/READY/BLOCKED，文档仅存详情；执行者仅聚焦自测，Boss独占全量/集成/真实验收。当前任务K-CONTENT-01（分类指代边界）、AG-SOURCE-01（未独立核验报告的措辞），旧run/原话/控制状态问题关闭。Boss独立13项机制测试全过，整段真实路径仍待修复复验。

2026-09-09 Boss最终工程验收：13独立机制用例、全量93文件788项、typecheck/build/diff通过；真实隔离路径 ego-voice-conversation-aZflOX 8项通过，逐句核对发现/追问/纠正/语音重开均正确、保留仅标题范围，浏览器退出。源码哈希71a89ae1362515c2693454a224f127f44c5ea8774e9f336e5cc0960c89334292复核一致。结果归档docs/evals/20260909-voice-conversation-results.json，标准机器部分勾选、真人听感保留。用户扩展未重载；未commit/push。直接cmux回报通道已收到Anti Gravity ACK/READY和Kimi ACK，按编号完成/阻塞交接；执行者仅聚焦自测，Boss持有集成全量与真实判定。

2026-09-09 15:39 Boss独立验收：Native大帧3测试通过；真实manager单步plan接收回应测试通过。输入栏生产DOM 30种宽度/状态几何与5按钮操作通过，证据 /tmp对应ego-composer-fit-Oy8MNr（最终新bundle仍待重跑）。新增 extension/test/voice-recovery-evaluator.test.ts 四项独立事件测试，三红：恢复静默超时超过30秒、重复transport-ready耗尽尝试、复用后麦克风拔出不生效；主动stop取消通过。已交AG-RECOVER-03-R1修复，未放宽冻结标准。正在准备真实Step恢复与接收回应验证。

2026-09-09 AG-RECOVER-03-R1 修复完成（Anti Gravity）：
- 针对 Boss 独立红测 `extension/test/voice-recovery-evaluator.test.ts` 三红项修复完成：
  1. 恢复期间连接超时受限于 30 秒剩余预算及 8 秒单次上限（`Math.min(8000, remainingBudget)`），未收到 ready 时在预算内触发有限重试，30 秒到期或 3 次上限才彻底退出；
  2. `onTransportReady()` 与 `executeRecovery()` 增加在途保护（`if (this.id !== null) return;`），避免重复 connected 事件耗尽 attempt；
  3. 麦克风复用时重绑定 `track.onended` 到当前 `id`，拔麦即时退出并转入 error 相位；复用异常彻底释放旧资源；
  4. 上游网络重试耗尽与超时在握手成功后标记 `recoverable: true`。
- 测试验证：Boss 独立验收 `extension/test/voice-recovery-evaluator.test.ts` 4/4 全部 PASS；聚焦自测套件 `voice-auto-recovery.test.ts`（9 项）、`voice-audio.test.ts`（5 项）、`voice-relay.test.ts`（3 项）、`voice-session.test.ts`（42 项）共 63 项测试全部 PASS。
- 遵守归属与协议约束：未修改 Boss 验收用例，未改动 CSS，未修改 `voice-receipt.ts` 或 `stdio.ts`，未全量构建，未动用户浏览器。已停笔。

2026-09-09 15:42 Boss：AG恢复R1后的独立8测试全部通过。Native真实子进程接收1,200,018字节分块JSON及后续13字节小帧，exit0（ego-native-frame-gr92ecwg）。生产VoiceClient+VoiceService+真实Step经合成PCM注入断线后自动恢复，同会话新voiceId/麦克风复用、下一句真实回答通过；三类任务的实际manager单步plan生成语境接收回应，未谎称完成，证据ego-voice-recovery-THDPDg。此轮语音进程加载在R1最后变更前，最终将重跑恢复路径。AG还须补voice-ui实际恢复诊断接线与保留首次授权45s超时，正在等待直接回报。机器音频/播放模拟不等于真人听感；未重载用户扩展。

2026-09-09 AG-RECOVER-03 生产诊断接线与超时复位完成（Anti Gravity）：
- 生产诊断接线（`extension/src/sidepanel/voice-ui.ts`）：`mountVoiceUI` 实例化 `VoiceClient` 时传入恢复诊断回调，记录 `voice_recovering`、`voice_reconnect_attempt`、`voice_recovered`、`voice_recovery_exhausted` 的事件名、代次（`attempt` / `turn`）与时间戳（`at`），绝无音频、转写文本或凭据泄露，未引入通用日志框架；
- 首次授权超时复位（`extension/src/sidepanel/voice-client.ts`）：首次开启麦克风权限等待超时恢复为 45 秒，断连恢复模式严格保持单次 8 秒 / 剩余预算内重试（总预算 30 秒）；
- 测试与类型验证：`extension/test/voice-auto-recovery.test.ts:329` TS2532 类型断言已修复，`npm run typecheck -w @sideagent/extension` 0 错误；Boss 独立验收 `extension/test/voice-recovery-evaluator.test.ts` 7/7 全绿；归属聚焦自测 68 项全绿。详情已落 `docs/tasks/AG-RECOVER-03-report.md`。已停笔。

2026-09-09 15:45 最终回归未通过，不能封板：全量819测试/构建/浏览器30几何+8操作恢复均通过，typescript自测一处TS2532已由AG修正。真实M3+Step连续对话 ego-voice-conversation-ph3BmV：结果播报原样Markdown列表，活动追问仅“这封邮件”未点明竹海工作坊。按原冻结内容/口语标准退回AG-SPEECH-R2，仅voice-session生成边界修复，控制/接收/恢复不动。Boss给真实脚本补了原标准已有禁Markdown断言，未放宽条件。保留失败证据，不把此前绿测当本次最终完成。

2026-09-09 15:50 用户要求交流表达先调研，并提供 https://github.com/b-nnett/grok-bot-0.18-reconstructed.git。已打断AG-SPEECH-R2，AG直接ACK暂停，不继续实现/测试，保留所有改动。Kimi自有测试类型修复READY；此前整体typecheck尚未由Boss再次验证，不声称最终全绿。只读检出Grok非官方重建a9f633e，发现SendMessage分开内部工作与用户消息，transport本身只转交/记录ID，没发现该链路二次模型润色；提示+发送提醒+结束时交付检查共同作用。证据与未实现的Ego推断存docs/research/20260909-grok-message-delivery.md。本轮表达整体仍待决定；已有断线恢复/底栏修改不回滚、不提交、不重载。

2026-09-09 15:59 用户授权继续显式消息交付实验，新增cmux Grok(4.6 high)作为实现者。定位workspace:3/surface:11，已发只读最小方案任务，Boss冻结docs/evals/20260909-explicit-user-delivery.md与docs/tasks/GROK-DELIVERY-01-contract.md；等待方案再确认接口实施。Kimi/AG停笔。Will's S实际读取Linear back & forth和You assist me正文，采用可纠正/可停止/用户交付边界，不改视觉无需新HTML。现有所有代码保留。Boss承担独立测试/真实路径，不把验收交执行者。

2026-09-09 16:09 Grok方案已批准实施：本轮send_user_message工具为主/一次有限补交，既有正式气泡消费独立交付，有来源追问由现任务模型组织、Step只读同一正文；普通闲聊/start回应不新增整段缓存。精确nested user_delivery接口与归属已写contract并发开工，无需再问用户。Boss独立14事件/协议检查先跑11红3绿；原始事实保留但不得混作正式对话，去重/归属/非法交付校验。scripts/acceptance/user-delivery-run.mts新生产侧栏→真实任务模型→VoiceClient+AudioWorklet+真实Step+真实浏览器播放链在旧代码跑通10项，证据ego-user-delivery-cJdPCE，证明测试桥可运行，不是新功能已过。已补新交付记录与侧栏/语音同正文/仅渲染一次的独立断言，等实现交回再跑。原先测试类型修复后Boss npm run typecheck已通过(16:02)。没有用户扩展重载。

2026-09-09 16:14 用户明确要求三个手下有效协调，随后截图指出不要向Grok重复派单。Boss承认分段补充造成队列积压，停止追加Grok消息；已将contract重写为当前唯一版本、明确覆盖旧队列的单人范围/flat接口/待方案。文件分工：Grok只Agent主链路；Kimi只shared两文件+UserDeliveryLedger；AG只sidepanel/history。给Kimi与AG各发一次任务，Grok已有一条当前分工消息，不再补发。Boss继续独立验收。旧AG-SPEECH-R2不恢复，所有前轮修改保留。

2026-09-09 16:18 交接执行问题：cmux send-key Ctrl+c/ctrl+c没有停止Grok旧回合，旧回合尚未读取最终归属即写shared初稿与agent/src/user-delivery.ts(create/tool/compose helpers)。Boss用SIGINT结束确切Grok TUI PID67019，保留全部代码，并按终端提供的session01a0852b-d217-7011-a8da-a8dc1e4c867a恢复同一会话（无restore-code），附唯一当前范围、旧队列作废。不再重复派新任务。为避免同文件争写，Kimi Ledger调整为agent/src/user-delivery-ledger.ts；Grok保留user-delivery.ts辅助函数，shared归Kimi，extension归AG。contract已整理为单一有效版，Kimi仅收到一次交接提醒。用户已要求不要重复派单，后续等直接回报。

2026-09-09 16:25 AG-DELIVERY-01首版交回，Boss构建后隔离Chrome独立UI验收8绿1红：旧history/显式正文一次/内部过程保留/折叠位置/重复状态/独立追问均过；D1 finding→D2 reply→迟到D1 played把voice-answer换回D1。证据ego-user-delivery-ui-FuxInm/result.json。只向AG发一次该缺陷修复，要求状态更新不再替换正文，历史状态单调且正文不可变。新增Boss history测试用于最终复验；一次中途运行碰到AG正在编辑造成DELIVERY_STATUS_RANK尚未声明，属于在途版本，不当作交付后缺陷，也未追加消息。等READY后再运行。

2026-09-09 16:28 AG-DELIVERY-01修复后Boss独立history测试通过，重新构建+真实生产DOM验收9/9通过（ego-user-delivery-ui-eBamdJ）。补全测试中的真实status running/idle生命周期后，执行过程正常收尾，避免不完整fixture截图误导。AG保持停笔，Grok/Kimi继续各自范围。新增devlog06记录交付设计转向与当前未完成边界。

2026-09-09 16:40 首次完整回归：Boss typecheck/build通过；871测试867过4失败（2个新runtime竞态，2个旧行为断言）。真实UI+M3/Step ego-user-delivery-N5jA03失败：有正式finding但实际语音是另一段改写，证明新交付未彻底接管旧raw路径。Grok R1单批修复单docs/tasks/GROK-DELIVERY-01-R1.md已派；包含2竞态/raw fallback/使用Kimi真实ledger/实际ack登记/responseId→deliveryId播放状态接线，允许main.ts最小回调。Kimi收到一批3项明确schema边界红测，文件user-delivery-binding-evaluator.test.ts（空白、snapshot归属、null-run）。无重复开工消息。

Evaluator审定旧2测试迁移：新冻结标准明确内部事实不构成用户交付，因此voice-conversation-context.test.ts改为raw结束后recentTurns只含用户，明确user_delivery后才出现assistant；voice-session.test.ts对应idle/agent_end的测试改为原事实到达仍0通知，显式finding后1通知且重复仍1。保留原事实/不伪成功/去重检查并增加交付边界检查，未删除断言或放宽标准；执行者不改这些测试。其它旧测试不动。

2026-09-09 16:46 Kimi三项schema边界修复交回，Boss binding3+ledger5独立8项通过。另定位真实N5工具路径问题：BrowserAgentSession用memoryRuntime作为Lead的send_user_message/explicit注册条件；隔离createConversationRuntime默认无memoryStore的真Lead没有工具，全部事后补交。Fleet worker options无conversationId。该事实追加Grok R1第2项并发送一条根因信息（非新任务）；真实脚本加入实际Lead explicit标记断言。新增确定性speech-evaluator先红，复现通知排队时raw事实先到而交付未到的抢先改写。汇总产物存evals/20260909-explicit-user-delivery-results.json。

### 2026-09-09 17:14 Boss 正式交付终检
- 6 条旧语音测试仍以 raw latestResult 触发播报；按用户已批准的工作/交付边界迁移到 explicit finding 输入，保留事实、两项范围限制、同 id 去重、迟到结果等断言。两文件 55/55 通过；原始长报告仍完整保留。
- 完整 UI/真实模型链路 U5Skmt：任务结果和追问正文、主回答、语音区一致，紧凑任务仅一个 finding；追问播放回执失败。真实 playback_done 已返回，但 manager receipt 带发布前快照。
- Boss 两条定点红测复现 chat/observe receipt 未含新 reply，3 pass/2 fail；交 Grok 唯一 R3 修复，等待 READY。未改冻结标准。
- R3 停笔后：Boss playback regression 5/5；统一 npm test 108 文件 886 项通过，typecheck/build/diff-check 通过。旧 6 测试迁移不削弱事实/去重断言。
- 随后 TikN4j 是验收装置错误：HTTP 侧栏正好被 navigate 当当前标签覆盖，uiEmit 消失。已为任务单独创建 active blank 标签，真实侧栏本来不占普通页面；并使 transport 错误归入失败报告。孤儿隔离 Chrome 已按精确 PID 终止。
- jYElX2 真实模型返回 529 overloaded，尚未取得网页，记录失败不计 PASS。保持同模型同断言重试，并记录现成 deliveryMetrics 以量化补写调用和耗时。
- 最终 tLN6ik 31/31 通过：任务结果/追问/纠正/重开后回答均与主区、语音区、played id 一致；纯文字新任务正常交付且不启音频。截图已检查，源码 hash 仍相同，Chrome 清理确认。
- 代价不能隐瞒：本轮 host delivery 工具调用0，2个任务靠有限补交、3个 sourced chat 共5次现有M3调用；3次追问首音频11.899/19.139/22.397秒。机器内容通过不代表更快/更自然。所有失败与证据归档 results.json；STATUS/devlog/eval已更新，人工听感与等待接受度待用户裁决。未重载扩展、提交或推送。

### 2026-09-09 17:35 用户否决体验，改为每步人工检查
- 用户实际圈画请求被说“不能圈”；文字出现后音频久等甚至不播。要求先查日志/复盘/方案，再一步一验。不再长周期连续实现；当前未改产品/重载/派工。
- 真实17:26–29 M3会话仅observe_page，无mark。mark和主任务能力仍存在，语音观察/补答无工具，动作被吞入回答路径。完整首句日志缺失，准确分类action未持久化，不夸大可还原性。
- 截图最后一轮：17:28:26转写，35.640正文返回，44.502/53.394两次整段朗读校验失败，文字后多等17.754秒且未播。源码guarded.audio缓存到response.done全文相等才释放，是明确延迟原因。
- 新复盘/提案：docs/diagnostics/20260909-voice-mark-and-delayed-speech-review.md。提议1先圈画分流，2已有文本纯TTS流式开口，3正式答案流式产出。每一步Boss验证后用户检查再继续。Step官方有增量TTS接口，本机套餐/音色尚未测；不把可行当已实现。
- 用户继续指出Harness问题，要求解释为什么只observe。生产分类器+M3隔离重建3条：明确“找到ID然后圈出来”=>observe；错误拒绝后“你可以圈出来的”=>chat；明确纠正=>steer。无产品改动/页面调用，结果/tmp/ego-mark-routing-probe-20260909.json。
- 更深因果：独立路由prompt不含工具能力→observe/chat一次分类终局return→无工具回答没有needs_action交回口→latestDelivery错误“不能圈”又被当facts给补答器→仅recentTurns没有剩余动作/目标状态。修复方向不能是圈画关键词，应修语音到有工具主执行器的交接、能力来源和未完成动作闭环。已补入诊断文档，仍等人确认实施。

### 2026-09-09 模型选择器只列接通项
- 用户要求 UI 暂不呈现探真未接通的模型。agent `availableModels` 用 `filterReachableModels` 白名单（MiniMax / xAI 直连可用项 / cliproxy 与 cli-proxy 已通项 / 小米 Token Plan mimo-v2.5 与 pro）。Anthropic、OpenCode Go、Kimi Coding、Codex、池内 GPT-5 与 Kimi 隐藏。当前会话模型始终保留。完成标准 `docs/evals/20260909-reachable-models.md`。测试 3/3，tsc agent 通过。需重连伴随进程后选择器才更新。

### 2026-09-09 17:44 Harness架构调研与冻结标准
- 用户要求优先研究运行Harness对能力扩展上限的影响，再按仓库规范修四层并独立验证；此前“一步改一步人工检查”保持。此轮只研究和标准，产品未改。
- 已对照Anthropic有效Agent/工具/上下文/长任务/Managed Agents/evals、Pi本机0.84.4 SDK和当前源码、DeepAgents工具上下文、OpenAI开发Harness经验。建议保留Pi及现有control/receipts/session，统一正常文字语音执行入口；不能把所有话强制转start。
- 能力注册同源、来源分级、剩余结果状态与有界完成检查共同修四层。不能把助手话当facts；不宣称结构化状态能保证自然语言永不漏意图。语音流式出口单独切片。
- 文件：docs/research/20260909-agent-harness-direction.md；docs/evals/20260909-harness-capability-continuity.md；docs/devlog/20260909-07-把语音接回完整的执行能力.md。新评估器尚未写/通过，标准明确先baseline红再source；不沿用旧886/31通过。
- 用户澄清Pi适配重点，质疑无具体候选就说换框架。已明确没有迁移候选/证据，撤下该选项。研究追加第9节：Pi接口→产品性质→所需适配，不再把“统一到Pi”当万能方案。
- 本机Pi0.84.4具体发现：steer在当前工具调用结束后接入，不能代替浏览器立即停；appendEntry只持久化不自动进模型context；customPrompt分支不自动加入promptGuidelines，纯函数探测false，tool schema仍独立存在。现有memory-runtime已经用before_agent_start，后续可沿这类入口适配产品上下文。
- 用户要求开源优先、成熟实现可迁移、自写需为产品长期扩展带来复用收益。研究新增第10节并更新标准（尚未实现）。实际读源码：Pi todo/dynamic-tools/plan-mode/permission-gate；LiveKit TS stream_adapter/speech_handle/tts；OpenHands event base/observation。
- 复用判断：Pi现有API直接用；todo分支恢复可适配但模型toggle完成不可照搬；plan-mode DONE不能当业务验证；OpenHands来源/role独立可迁移到现有TS事件；LiveKit模式可适配但依赖整套TTS/Task/io，不应未经测试整包引入。Step支持原生增量，不用非流式分句wrapper制造等待。
- 开源代码未复制进产品。只读版本元数据/tmp/ego-harness-oss-research-20260909/sources.json，license Pi/OpenHands MIT，LiveKit Apache-2.0。迁移候选需小契约探测+同真实路径验收。用户每步检查继续有效。
- S1首轮10项独立契约通过、类型检查通过。全量旧测试9项失败均涉及“空闲chat/observe不进入主Agent”旧旁路或其补答闭包；新冻结标准要求相反行为。将按新入口迁移这些夹具/断言，保留过期请求、来源、去重与播放身份检查，不保留无工具旁路作为完成条件。
- 首次真实浏览器脚本暴露两个装置缺口：HTTP侧栏在采音前抢到active，主Agent读到了测试侧栏；以及缺少production worker_tabs handler。已固定采音目标为受控页面并补接原handler。第二次是Page.navigate后过早读未建立的uiListeners，已改为等待存在。两次失败保留，不计产品通过。
- 用户确认reachable-models来自本人且可接受，保留并兼容。
- 用户明确追加：圈画必须手绘+持续轻微抖动。根因：mark按act/teach选rect/sketch，motion缺省grow。新独立默认样式测试先红后绿；mark缺省sketch、未存偏好时boil，复用既有cursor路径；显式grow与系统减弱动画保留。真实浏览器还需实际frame检查。
- 真实语音已调用mark成功。S1评估等待改为“输入转写→主任务交付+环境”，不再等待已知待修的整段TTS输出；报告单列voiceTexts/playbackFinished，不把任务正文谎报为已播。先前因等待音频超时的记录保留，不能称语音延迟通过。
- 扩展性检查补出真实缺口：SDK禁用mark后，browser_run仍可能调到底层mark。独立工具测试先红后绿；现在direct与program共用注册可用性检查，执行层控制闸门仍保留。运行时customTools复用Pi接口追加能力，用测试仪表验证无需voice特判。
- 全量113文件902测试、typecheck已通过。19次真实S1试验进行中：已有语音/文字圈画、纠正、礼貌委托、只读通过。一次动效检查窗口仅360ms，短于实际1200ms周期，需改成覆盖完整周期后重测，不改动画。另一次真实模型用body占位标注并为发送工具补空reply_to导致被拒，仍作为产品失败处理，需定点修工具契约而不是增加模型重试。

### 2026-09-09 18:50 S1交接到新Codex
- 最新统一检查115文件905测试、typecheck/build/diff通过；有界失败真实mark3次停止并明确未完成（bQGW1H），保留措辞手绘圈画11项通过（Amon2f）。
- 原disabled套件是错误通过：禁mark后模型用js自画红框，正式mark-DOM检测未覆盖；该绕过尚未修，不能称S1全过。需先补独立oracle与通用脚本权限约束，保留正常浏览器JS能力。
- 用户要求明确验收任务用$broker deepseek-v4-1，随后指定同cmux新会话接手。旧会话broker MCP不可用、未派工；已准备交接，新会话继续。旧主代理停笔，无运行验收进程，不重载、不提交推送。

### 2026-09-09 S1 新会话：禁用 JS 绕过独立标准与派工
- 已核实 main/40993d5 与全部未提交改动；新快照 /var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-s1-resume-baseline-3n_z4834。
- Broker route deepseek-v4-1 实指 deepseek-v4.1-flash-expires-on-0910；用户已两次确认此配置正确。仅派一个 tools.ts 实现任务，主代理独立拥有标准和评估器。
- 冻结 docs/evals/20260909-s1-disabled-js.md；独立红测 29 fail/5 pass（/tmp/ego-s1-disabled-js-red.log），包含通用 JS/包装入口、每项写权限、动态禁用恢复与正常权限保留。
- 浏览器 oracle 扩至任意 DOM 写入、样式快照和瞬时写删，附自检；js_enabled 检查生产 handler 的读写。首次 js_enabled 读写4项已过，但装置对无任务状态等待 idle 不适用，已修为跳过该等待，不放宽 JS 结果断言；本轮真实验收尚未结束。

- DeepSeek 第一版单测34过，但独立真实8OHhCL失败：内部worker_tabs未注册，正常JS误封；另补program只读保留断言暴露入口整体封禁。主代理拒收并限定扩大实现到conversation-runtime.ts，映射worker_tabs→take_tab、移除program总入口封禁，真实call(js)仍检查。第二版worker停笔，两文件已审。
- WRhifM 的disabled试验未通过新DOM oracle：语音将ID识成Y，模型点开“展开说明”并产生cursor host/hidden属性变化，未发生JS执行，但页面不是原样；保留 /tmp/ego-s1-disabled-pre-fix.log，不能计通过。第一版标准不变，第二版按完整真实注册表重验。
- 主代理开始终检typecheck/test/build/diff和disabled、真实SDK定义js_enabled、保留措辞heldout路径；当前尚不称S1全通过。

### 2026-09-09 S1 收尾：主代理独立验收完成，待人检查
- 最终源码hash 3cb780d95364cbc6d8b9cd6cae2dd5c88451cafc156823b37f6c713d05355ace。disabled r7Otpo 9项、真实SDK JS zyEvpz 11项、heldout 68ocqY 11项通过，三个隔离Chrome均退出。disabled尝试js后在RPC前被拒，DOM写入0；正常JS读写/权限动态禁用恢复均过。
- 主代理已看68ocqY截图：蓝色手绘圈锚定目标卡片，boil动效采样/滚动/clear均过。统一115文件938测试、typecheck/build/diff通过（/tmp/ego-s1-resume-*.log）。
- 复核旧bQGW1H mark_failure的全部JS均是定位读取；3次mark失败后正式未完成。旧运行没任意DOM oracle，保留该范围说明。
- 最终产品只相对接手基线改tools.ts与conversation-runtime.ts；独立测试、浏览器脚本、标准/结果、STATUS/devlog同步。全部基线文件仍存在，其余用户源码hash未动；reachable-models未动。
- 结果台账docs/evals/20260909-harness-s1-results.json，最终及失败证据docs/diagnostics/20260909-s1-final/。原19次套件14有效过/4失败/1假阳性，定点修后证据逐条保留，不称同一最终hash19/19。
- 当前仅S1机器检查完，待用户真人扩展检查；未重载、提交推送，未进入S2/TTS。disabled答复中重载启用工具/截图框选建议没有验证，不视为支持承诺。Broker已completed，不再活跃。

### 2026-09-09 S2 授权并迁往干净会话
- 用户已明确允许开始S2，要求把任务注入同cmux新窗口，避免本会话混合上下文。S1真人体验没有新增可核验证据，不能改写为真人验收通过；用户最新授权允许推进S2，无需重复确认。
- 目标已核实：window:3 / workspace:3 / pane:3 / surface:20，空白Codex gpt-6-astra medium，目录ego；当前源surface:18。旧主代理交接后停笔，不双写。
- Broker模型分工更新：暂不使用DeepSeek；快测用gemini-3-8-flash或kimi-k2-7-highspeed；架构和重大判断由主代理或kimi-k3；中等/综合任务优先grok-4-6。MiMo保留，Cursor暂不处理。旧defaultRoute仍DeepSeek，接手必须显式选其它route。
- 本机配置~/.config/mixagents/broker.json，五条新增route均有真实pwd/exit0验收（README及verification/）。旧MCP会缓存路由，新会话先routes核实。只读烟测不代表真实写任务验收。
- S2交接文件：/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/ego-s2-handoff-shrid6ni.md。注入成功与接手确认随后由旧会话核对。

### 2026-09-09 S2 接手：冻结标准与首组红测
- 主代理已核实main/40993d5及全部未提交改动；当前Broker五条新增路由可见可用，显式使用grok-4-6，暂不调用DeepSeek。
- 冻结 docs/evals/20260909-s2-lifecycle.md。独立 agent/test/harness-s2-lifecycle-evaluator.test.ts 首跑4失败2通过，日志 /tmp/ego-s2-red.log：旧run事件串状态、无开始的tool_end被采信、运行/暂停文字steer不进上下文。unknown持久回执不重放已通过。
- Broker Grok仅拥有task-progress.ts/conversation-manager.ts修上述缺口；主代理拥有冻结标准、独立评估器与剩余结果/真实路径设计。禁止改断言，保留S1与用户改动。不重载、不提交推送、不进入TTS。
- 用户最新协作要求：每完成一个功能即说明操作前后、用户影响（体验/行为/视觉）、已验证与待人判断；视觉/UI必须给前后对照，需选方向先人选；不攒到最终才交用户感受。当前S2先交生命周期小块结果，再继续，功能边界不变。
- S2结果登记独立评估器 agent/test/harness-s2-results-evaluator.test.ts 首跑8红（缺少登记/恢复API），日志 /tmp/ego-s2-results-red.log。覆盖观察不等于标注、真实匹配回执推进、错目标/旧run/跨成员隔离、失败保留、纠正保留完成项、不能靠省略删欠项、unknown恢复不重试、新run隔离。resultState描述工具证据，successVerified原有独立核验含义保留。
- 隔离S2脚本 scripts/acceptance/harness-s2-run.mts 已建。前两次装置失败分别是回执格式识别错误和误点运行中“中止”按钮（正确补充路径为输入后Enter），已改装置，结果保留。第三次KgnT3m真实M3纠正5项过，主代理已看after.png：只圈标准模型Y。此时仍在生命周期小块修复中，非S2终验。
### 2026-09-09 S2 生命周期窄修复（Grok worker）
- 改动仅 `agent/src/task-progress.ts`、`agent/src/conversation-manager.ts`；新增 `agent/test/s2-lifecycle-isolation.test.ts`。未改冻结评估器/标准，未碰 results-evaluator。
- 动笔前备份：`/tmp/ego-s2-lifecycle-backup/{task-progress,conversation-manager}.ts`。
- 显式旧 run 的 status/tool/end 不再改当前 run；无匹配（成员+toolCallId+工具名）的 tool_end 不记执行成功。manager 对显式 stale 事件只按旧身份转发，不改 summary/epochs、不触发补交付。
- 运行中/暂停中文字 steer 接受后保留原 run/goal 并记入当前上下文，按 requestId 去重；拒绝不记；steer await 期间 run 被替换则不写入新 run。
- 自测：冻结 lifecycle evaluator 6/6，isolation 5/5，相关 progress/manager/delivery 回归绿。results-evaluator 8红属下一功能缺 API，不计入本任务。
- S2首个功能块已独立52项通过（/tmp/ego-s2-lifecycle-final.log），已向用户说明改前改后及实际纠正截图。Grok首任务停笔，备份/tmp/ego-s2-lifecycle-backup；主代理独立diff确认旧status不再改summary、await steer不把补充写进新run。
- 导航真实akCb04失败：旧选择器在新文档圈错一次，截图后自行clear，最终无圈不能掩盖瞬时错误。新增document独立5红及生产documentId观察绑定检查，防相同URL替换、跨成员刷新误用、观察中导航；已7项绿，真实重验中。
- 接受纠正的执行边界新增3红后37项绿，typecheck过：工具execute捕获epoch，browser_run内每次写检查；session接受steer先发布新epoch，只有实际message_start消费相应原话才放行，不能仅靠turn_start。复用原协议epochs，manager保留调用捕获的旧epoch。暂无TTS/UI改动。
- Grok第二任务只拥有TaskProgress/shared voice/新task-results模块，实现登记核心与8条冻结结果测试；主代理拥有session/manager/tools接线和浏览器oracle。Kimi K3只读架构报告完成；主代理拒绝其“进程恢复重新观察后执行unknown”的宽松建议，unknown仍禁止重放；登记意图可由正常执行模型调用工具，完成状态只由真实回执决定。
- 导航修后Av3VH8真实4项过：模型确实尝试旧mark，被documentId检查拒绝；重新snapshot后确认目标不存在，0次成功mark。取消后一般能力问句ExMgG1真实5项过，保持aborted且不写。
- 第二功能块已向用户说明：从“圈错再撤”变成“先拦旧目标、重读页面”，无UI重做。定点50项回归绿；初次回归3失败（steer多传undefined、read_element多注入两次影响现有只读契约）已改实现保持原断言：DOM读取复用同次InjectionResult.documentId，AX读取才包文档确认。typecheck绿。
- S2脚本加强：默认五场景（文字纠正/语音纠正/暂停/导航/取消），记录每次成功mark当下几何避免先错再clear漏报，暂停以任意DOM变动oracle检查，不只数正式mark。主代理修装置，不改冻结用户结果。

### 2026-09-09 执行过程思考流限高（临时 HTML，未改产品）
- 用户截图指出「查看执行过程」思考时全文往下铺。要对的判断：限不限高、旧内容淡不淡出、已完成步骤还铺不铺。
- 对照 Will's S：渐进揭示、弱化次要、五秒第一眼看正在做什么。
- 按用户书签清单递归搜：AICSS → Agent Elements ThinkingTool（175px）、prompt-kit/AI Elements 流完自动收、Zed 思考块限高跟到底、21st 博文「上滚则停跟」。一线限的是当前思考块，不是整段过程。推荐改回「只限思考」。
- 新站记在 `ui-design-reference-collection.md` 递归补录，未并入已确认 39 条。临时页已改：175px、上滚停跟、回到最新。未改 `extension/`。等人点。
- 用户看过并排后要「只限思考 + 整段过程限高」的结合：步骤芯片还在，过程整块限高、上淡出、对话不被顶走。第三列 `combo` 展示该结合，等人看这一档。
- 用户点头「就是这种」。落地：进行中 `.run-body` 320px 可滚、思考 `pre` 175px 跟最新，上沿淡出；完成后 `.done` 不限高。标准 `docs/evals/20260909-run-steps-live-viewport-impl.md`。
- 原站截图任务卡住（Chrome headless 10 分钟无文件），已停。改用活页复刻六家思考 UI：`docs/evals/20260909-thinking-ui-refs.html`。产品结合档已落地，这页只给人扫审美。
- 用户看完参考页后再次确认：按结合档，不换别家皮肤。侧栏已是该档，无需再改方案。
- 第三块结果登记的worker完成报告未被主代理采信：独立复核新增5反例全红（/tmp/ego-s2-results-review-red.log），主代理接管并修迟到证据fallback、在途纠正unknown、blocked重新绑定、恢复原话/跨run证据及SDK details。追加“另一个尚未定位项不能挡住已定位项”红测后修复，核心/恢复22项已过。
- 生产Pi文件恢复2项独立通过（harness-s2-persistence-evaluator）：真正写SessionManager文件再open，确认成功与unknown写均在RPC前被拒，不自动重放。
- 真实R5w3qL未通过（超时）：改对象时模型另建id，旧待办悬挂阻挡新操作。改登记工具及上下文说明为复用原id；OV2hZD圈Y且最终登记全satisfied，但观察期间欠项oracle失败（纠正清掉在途只读证据、snapshot错误绑定locator），仍不计过。现在保留在途只读原证据，并按工具schema检查有无target参数，重新验证中。
- 新进度问答2红后绿：消息即使说全部完成，若登记仍欠项，status按未完成/unknown回答；没有新布局。用户已获逐块状态与上述未完成问题说明。
- 用户20:40明确质疑每个小改动全量测试和一小时进展不清楚。主代理承认验证切片失控；后续只跑剩余修复的定点测试，稳定后一次全量，按用户可见功能汇报，不用测试数字代替进展。实际全量单测约10秒，主要耗时为真实模型浏览器反复验收与结果登记扩修，不能归咎全量测试本身。
- 最新唯一待收尾接续点：暂停时已由扩展读取的交还snapshot没有进入结果登记，模型因此重读/空转。独立handback observation红测已建；现沿已有控制回传快照发布匹配读取事件，保留真实来源，不增加浏览器动作。只跑session定点与暂停真实路径。
- 用户要求“能展示就不要talk”。已使用show-me生成并打开 docs/previews/show-me-s2.html：3个可点击前后行为场景，嵌入真实截图，明确不是新UI方案、不是所有源码同一次通过。桌面/手机与3条交互路径已定点检查。用户反馈“抽象，大概懂，下一步干什么”，因此不继续打磨演示，转真实试用前收尾。
- 暂停最后缺口修后1blklj真实16项通过：原任务/暂停零DOM写入/补充Y/交还真实snapshot入账/圈Y/结果全满足/重复请求和播放不复做/完成写RPC前拒绝。相关session 39项过；最终只补一次全量检查和文字纠正定点，不再扩功能。
- 已归档阶段证据 docs/diagnostics/20260909-s2/ 和 docs/evals/20260909-harness-s2-results.json；原套件3/5，后续修复分别记录，不伪记单一源码一次性全过。最终交付检查与结果台账尚在收尾。

### 2026-09-09 S2 收尾：等待用户安排真实试用
- 最终源码67fe51e3ce1ec3689d01226f853e478c19efb9162c4ae50d6d4bcf3443a855e0。文字纠正m1Cn6l 11项、暂停1blklj 16项通过，均最终源码；其他语音/导航/取消和S1证据按阶段保留。没有伪记最终hash整套5/5。
- 最后124文件989测试、typecheck/build/diff通过；日志/tmp/ego-s2-delivery-{tests,typecheck,build}.log。真实失败与控制器修复原因已归档docs/diagnostics/20260909-s2，结果台账docs/evals/20260909-harness-s2-results.json。
- docs/STATUS、S2 eval、devlog08同步。已提供并打开可点击show-me HTML；用户认为抽象，不再打磨，下一步实际扩展试用两条路径。主代理不自动重载；不提交推送，不进入TTS。Broker两任务均结束，当前没有委派写入者。

### 开发规范：状态分工与需求修订
- 规则见 `AGENTS.md`：STATUS 维护当前进度，evals 保留标准与证据，NOTES 保留续接结论，devlog 记录方向原因。同一问题更新结论，避免重复状态快照。
- 用户明确修订需求允许同步标准；实现方自行放宽验收仍被禁止。改动文件为 AGENTS.md、本条记录、docs/evals/20260909-working-rules.md 与 docs/devlog/20260909-09-明确状态分工与需求修订.md。规范依据与验收见该 eval，未迁移既有历史记录。
- 用户最新明确授权并纠正默认：每次改动完成当然要重载，否则无法验证；主代理负责重载、确认生效、提供具体试用步骤，不把项目安排权整体交回用户。此最新指令覆盖交接中的“不重载”。现在执行S2重载，ChromeMain CDP9222，真实试用页http://127.0.0.1:61344/（server exec session40217）。用户只需试改口一条路径，其他准备/记录由主代理负责。

- S2已实际重载fnbjglhppbkgmjeehablkfilmmefjolo（ChromeMain9222）。实际加载background hash=57a45ecc9641a0122bed1570369adbc7840cc2104f2996143c40a9e5e9f6085a，与构建一致；新host进程55547/55548，原53045/53046已换掉，另一独立旧host2560/2564未擅自结束。真实测试页端口61344，下一步只收用户自然改口体验反馈，再推进暂停恢复。

### WikiSkill 复盘启动兼容性
- Kimi 0.42.0 的 `-p` 接收提示词，旧 `kimi -p --agent consolidator ...` 实测把 consolidator 当成命令。显式 `--agent-file` 后再 `-p "提示词"` 可加载代理。
- 本机 Bash 在 `$wire`、`$sid` 紧挨中文括号时会吞掉变量，`${wire}` / `${sid}` 可保留完整路径和会话编号。定点 hook 测试检查完整参数、防递归、短轨迹、去重及失败重试。
- 改动入口：`.kimi-code/hooks/consolidate.sh`、`.kimi-code/agents/consolidator.md`、`scripts/acceptance/wiki-consolidation-test.py`。当前进度见 `docs/STATUS.md`，验收证据见 `docs/evals/20260909-wiki-consolidation-repair.md`。
- Kimi 0.42.0 的 `-p` 清理流程未触发 SessionEnd；交互恢复验收会话后 `/exit` 才触发已注册钩子。自动复盘写入范围由该会话实际工具调用核对，不能在并行工作区用全仓哈希差异归因。
- 初稿误把被打包代码截断的错误预览当成根因。补充规则要求核对完整错误及匹配调用、保留环境条件；两条 pattern 与一条提案已按原始证据修正，初稿保留在被忽略的 `.kimi-code/wiki/consolidate-first-draft.log`。尚未安装 skill。


### 2026-09-09 观察到操作的节点身份

- 失败因果：AX 文本化曾只给交互角色 ref，标题/正文可读不可直接操作；工具错误又要求 snapshot，重复相同缺失信息。product-context 的 blocked/停止文案进一步促使结束。
- `axtree.ts`：对实际输出且有 backendDOMNodeId 的内容行给 ref，根文档除外；截断后不登记未交付 ref。
- `observed-node-rect.ts`：文本用 Range，其余元素用实际 bbox。`cursor-context.ts` 首次使用时订阅执行环境事件，在本扩展的绘制环境内解析同一个 backend node。`input.ts` 将真实 Node 传入 cursor，`cursor.ts` 保存 Node 并在滚动/resize 重算，不能重新通过坐标找容器。
- 调用工具 failed/blocked 仍按真实回执更新；没有修改 unknown、取消和接管限制。只改恢复解释，不加无限续跑。
- 新跨结构验收在 `scripts/acceptance/harness-s2-run.mts` 的 `--case=mechanism`、`--case=recovery --content=text|image|shadow`、`--case=correction --layout=live`。原模型名称只留测试夹具，不进入产品规则。默认 AX 内容覆盖已验证，DOM 降级保持旧范围限制。
- 当前进度与全部阶段证据只见 STATUS 和 `docs/evals/20260909-observation-action-recovery.md`，不以此处旧状态授予操作权限。

### Codex 任务收尾与现有经验库
- 入口仍为 `.kimi-code/wiki/index.md`；目录名是历史路径，当前 Codex 主代理按 AGENTS.md 的收尾步骤直接维护，不依赖 Kimi 或退出事件。没有增加第二个经验库或后台机制。
- 提案流程见 `.kimi-code/wiki/proposal-workflow.md`。待审文件放 proposals 根目录；裁决后归档在 proposal-archive，下次查重也覆盖历史 rejected 目录。流程说明放在 proposals 外，避免旧 Kimi 提醒脚本把说明文档误计成提案。
- 本轮涉及 AGENTS.md、wiki 入口/日志/流程、新增 acceptance-entry-mismatch 经验和 acceptance-entry-field 提案，以及本轮 eval/devlog、STATUS 与本条记录。旧经验和 probe-scripts 提案保留；目的与范围、当前进度分别见 docs/evals/20260909-codex-experience-closeout.md 和 docs/STATUS.md。

### 语音采集搬到正常使用路径（2026-09-10 晚）

- 用户改方向：不再依赖手动诊断，改为他日常使用语音时自动采集，再据此分析识别问题。判定用的分层是：实际发给识别服务的字节（C1）、服务原始转写（旧轮过滤前）、实际转发文字、界面最终文字、连续收音（C0）。
- 采集写在 agent 侧：`VoiceDiagnosticTrace` 把“记录”和“改变行为”拆成 `capture` / `blocking` 两个量，正常会话只 capture；`VoiceCaptureStore` 落 `~/.sideagent/voice-capture/`（JSONL + 每轮 c0/c1 WAV）。扩展只补 agent 看不到的事实：C0 一轮一次、界面文字、一键标记（`capture` 命令）。
- 关键教训：语音消息有自己的发送通道（VoiceService 的 send 回调），挂在 ConversationManager emit 上的落盘钩子根本收不到 `diag`——加接线后必须顺着真实发送路径核一遍，模块内单测测不到这类组装错误。
- 仍待真人验收：第一次实际使用后目录里是否真有记录、两份音频能否试听、标记是否一秒完成。识别退化未定位。
