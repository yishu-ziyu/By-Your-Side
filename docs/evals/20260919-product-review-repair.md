# 任务：修复产品体验复核中的错误完成、材料丢失和评测假通过

## 完成标准

- [ ] T06：省略计数经过 TaskProgress、正式交付、协议和界面保持真实总数；无宿主完成依据时模型参数不能把结果标完整；工具与补发路径一致。— 谁检查：主代理，定点反例、类型检查、交付链路测试
- [ ] T01：当前 run 不接纳无身份交付，并发同名工具按精确 ID 配对；原始证据可独立核验。— 谁检查：执行子代理、主代理、独立复核
- [ ] T05：失败结束不显示已完成；已确认步骤、人工修改、剩余工作恢复场景有证据，P0 未跑项保持未通过。— 谁检查：执行子代理、主代理，真实事件/隔离路径；真人及付费矩阵另列
- [ ] T02：损坏枚举拒绝，合法协议不回归。— 谁检查：执行子代理、主代理
- [ ] T03：重开面板从宿主恢复当前 run 的材料，旧 run/跨会话不串；真人三态理解检查单列。— 谁检查：主代理，隔离面板路径；可读性由人判断
- [ ] 集成后检查实际 diff、工程检查及独立复核；STATUS 记录完成/待验/阻塞及下一步。— 谁检查：主代理、独立子代理

## 范围与执行安排

用户在 2026-09-19 授权按 T06 → T01 → T05 → T02/T03 → 独立复核推进并有效使用 subagent。基线 `60b3b62`，保留前一轮四份未提交进度文档。主代理负责 T06、集成、T03 和最终验收；原生子代理分别负责 T01、T05、T02，按文件互斥。各票原要求及[最新裁决](20260919-product-review-status-sync.md)不降低。

立即可开始：交付事实链、评测 ID、接续标题、协议枚举。完整恢复验收依赖可信评测与实际剩余工作；T07/T08 保持暂停。没有授权推送、重载日常环境或发布。付费模型与真人矩阵缺口如实保留；无头隔离验证不冒充日常或真人验收。

## 证据与结果

## 2026-09-20 续接与范围修订

后续授权：用户明确同意启动真实模型验收，质量优先、不担心计费。隔离恢复与 P0 模型调用不再受预算授权阻塞；日常重载、全局模型路由和发布不因此自动授权。先执行 A05-03 两套材料及原入口恢复，再按结果推进矩阵。

### 收口补记（03:00 后，只核对已有结果，不重跑）

`background-aged/status.json` 已为 EXITED、exitCode=0；对应 results.json 的 aged-checkpoint 为 PASS，7/7 检查、无副作用，约 40 秒、9 次模型调用。这是单独目录的一项检查，不与其他报告合并宣称整套通过。用户转为先收回工作树、汇总材料再判断产品方向；本轮不继续定位或修复四项失败。既有修复及原始未提交文件已逐字保存在 `3c52930`，收口检查与备份见[工作区收口](20260920-workspace-consolidation.md)。

### 02:30 扩大 P0 检查与后台执行（历史）

用户指出前台长测试无反馈、要求后台继续。本次七项串行命令前台运行超过二十分钟且日志重定向，不能看到逐项进度；用户中止后核查驱动已退出，不重复启动旧批次。已落盘 research FAIL（91 秒）、form-readback PASS（34 秒）、panel-reopen PASS（15 秒）、wrong-page FAIL（133 秒）、refresh-login FAIL（344 秒）、queue-recovery FAIL（499 秒）；最后 aged-checkpoint 尚未完成。并非二十分钟一直卡在一个动作，慢场景与串行等待叠加。队列场景有模型 500 system error；其他失败尚待原 trace 定位，不能推定全部是模型问题。

原结果仍在 `out/acceptance/p0-review-20260920/final-voice/results.json`，该文件已由先前单项结果追加为 3 PASS / 4 FAIL / 5 NOT_RUN；02:05 的单项 verifier 数字为历史检查结果，不再代表此文件现状。未覆盖失败。

仅未完成的 aged-checkpoint 在新目录 `out/acceptance/p0-review-20260920/background-aged/` 独立后台运行：`run.py` 启动真实无头驱动，`run.log` 留输出，`status.json` 每五秒记录 PID、耗时、最近日志和退出码；480 秒硬上限，超时标 TIMEOUT_NOT_PASS。启动时监督进程 15483、驱动 15486。该任务结束前不改产品或验收器，可继续只读分析；不把后台启动算通过，不承诺无宿主支持的自动通知。

### 02:05 续接结果（此前阶段）

- 本轮主代理接续两条原会话；未修改产品生产代码。DeepSeek 独立静态复核未发现 T01/T02/T03/T06 新的生产缺陷，但发现 T05/P0 可采旧 finding、P0 只认 steer 发出而不核验接收的验收缺口。
- 已修复验收器：点击/插话之后的事件窗口、requestId 配对 accepted/applied、同 run 且本轮 composedAt 的正式 finding；P0 还核对实际服务端记录。共用两个纯判据，新增 11 条反例；主代理进一步拒绝缺失身份/无效时间，并把新模块同时加入 P0 模板与运行器指纹。旧失败不删除。
- 主代理实跑：`npx vitest run agent/test/t05-resume-freshness.test.ts agent/test/p0-steer-receipt.test.ts agent/test/product-journeys-pairing.test.ts agent/test/session-run-tail.test.ts agent/test/task-acceptance-durability.test.ts`，34 项通过；执行子代理类型和架构检查通过。生产源码未变，沿用此前完整工程检查，不伪称本轮重跑全量。
- 加强后的真实 T05：`out/acceptance/20260920-fresh-t05-{0,1,reopen,voice,text}/` 五次均通过，覆盖两套人工修改后恢复、面板重开、文字/语音语义接收后重建。两套材料页面输入计数保持不重做；恢复后正式交付按新窗口检查。T05 输出尚无构建指纹；0/1 运行早于主代理新增“缺失身份失败关闭”的守卫，独立复核已从原 events 重新核实新鲜度与配对，不把它们伪称最终文件逐字同版运行。
- P0 原 current-voice/current-text 各五项 PASS、七项 NOT_RUN（旧指纹）。受影响的 receipt-loss 在当前指纹 `6987ed0e1ba1…` 分别重跑：`out/acceptance/p0-review-20260920/final-{voice,text}/` 各 10/10 检查通过；`final-corrupt/` 的损坏检查点 17/17 通过。三份 `npm run eval:p0 -- --verify <目录>/results.json` 均 errors=[]、passed=1/12、总体 NOT_RUN，exit 2 是未跑项，不是全套 PASS。一次误把目录传给 --verify 报 EISDIR，已改用 results.json 复验。
- 接收后真正 SIGKILL 的既有 v2 证据已核实：`out/acceptance/20260920-accepted-sigkill-v2/result.json` 文字/语音两项恢复通过；它是无模型存储检查，不能冒充真实模型崩溃恢复。首轮 `20260920-accepted-sigkill` 的 text 曾 rejected，原因未留充分证据，不覆盖该失败。
- 第二个独立 DeepSeek 会话复核修复后实际文件和证据，未发现旧交付/被拒 steer 的残留假通过路径；校验了 P0 指纹与 trace/state 哈希。新鲜度反例为单测，现场正例中没有恶意重放，证据分别记录。
- 原材料重开首轮目录只保存五个通过项，失败发生在结果落盘前；“目录保留”不等于失败原始内容可独立核验。
- 本次 TypeSafe 官方 index 与 building guide 可访问；时间、身份、回执属于确定性事实，继续由代码核验，无新增模型判断。
- Chrome 工具链是另一条明确授权：空闲时重载了专用 ChromeMain 的扩展，后台/侧栏已连接且 bundle hash 与 dist 一致。此后不能再笼统写“未重载”。未推送或发布，见[工具链记录](20260920-chrome-devtools-toolchain.md)。

### 已授权真实验收进展（00:35 历史快照，不代表最终缺口）

- A05-03 两套真实 MiniMax-M3 材料，`out/acceptance/20260920-t05-real-recovery-{0,1}/`：页面剩余字段完成、人工备注保留、已确认动作不重做均通过。但第二套未等宿主异步正式交付就退出，不能算完整交付通过。
- 发现并复现 `session-run-tail`：正式交付模式已有模型正文却提示“模型空响应/限流”。修成“执行已结束，正式结果尚未交付”，不把正文冒充正式交付；新增反例先红后绿。未交付空轮、真实模型错误仍保持原保护。
- T05 runner 已改为等待同 run 正式 finding；失败也持久化 events。`20260920-t05-final-delivery-1` 在加强后的等待下通过，正式回答明确保留人工备注。随后继续增加页面 inputCounts 前后比较，防止换工具/选择器重复填写；这版新增断言尚待两套材料重跑。
- P0 首轮 `out/acceptance/p0-review-20260920/voice`：4 PASS / receipt-loss FAIL。失败是驱动只等 idle 后 1 秒，正式补交付未到即收尾；修改为有界等待正式 finding，原失败保留。
- 当前源码 P0 `out/acceptance/p0-review-20260920/current-voice`：五项全部 PASS（receipt-loss、extension-reload、host-restart、resume-cancel、attachments-corrections），33 次统计模型调用。current-text 已开始同五项复验。
- 新生产改动后的 `npm run check` 全通过：2440 普通、2 规模、边界、类型、构建。第一次实现误用了当前 TS lib 不支持的 findLast，已改兼容表达式并重跑通过。
- P0 的 voice 是转写文本进入生产语义路由，不含真人麦克风/ASR/扬声器。原 P0 的 stop 实际先 disconnect 保存再 dispose，T05 也是运行时重建；均不得冒充 OS 硬杀进程。还需补独立进程 accepted 后 SIGKILL 的存储恢复检查。
- T05 runner 新增 `--input voice`（仅 A05-02），走真实 routeVoiceInput 并检查 source=voice 接收回执，避免把同一文字开始测试重复标成语音测试。尚未运行。

用户明确：直接接用子代理留下的成果；不再以 T01 旧原始文件缺失阻塞后续，不重做整张 T01。旧证据缺口保留为历史事实，不把不存在的文件记成已恢复。

Herschel/T01、Plato/T05、Aquinas/T02 均因 429 中断；T02 留下协议反例测试。主代理接手后已完成 T01 精确身份与 wire ID 配对、T02 枚举守卫、T05 错误完成标题、T06 宿主交付投影和计数、T03 材料持久化与面板恢复。代码修复不等于五票全部接受。

### 本轮验证

- `npm run check`：通过，边界、类型、2439 普通测试、2 规模测试和构建。随后只增加验收测试/脚本，未再改生产逻辑。
- `npm run test:p0`：163 通过，包含接受后立即重启的文字/语音请求；新增断言证实材料随磁盘检查点恢复到 TaskView。
- 定点六文件：99 通过，覆盖 T01/T02/T05/T06 及材料 UI 反例。
- `task-materials-reopen.mts --headless`：6 项通过，证据 `out/acceptance/2026-09-19T16-17-09-687Z-materials-reopen/result.json`。真实构建面板/background，受控宿主用真实 TaskProgress 投影；材料重开保留、不可移除、跨会话隔离、新任务清空、无面板异常。零模型，不能冒充真实模型任务恢复。
- 上述材料脚本首次在新任务步骤超时：测试只 request 未发 agent_start，视图仍为 none，按产品规则不显示。补真实开始事件后通过；原失败保留在 `out/acceptance/2026-09-19T16-16-32-470Z-materials-reopen/`。
- `task-bar-states.mts --headless`：25 项通过，含 320px、键盘、接管、重开、跨页与减少动态；证据 `out/acceptance/20260920-review-task-bar-states/states.json`。受控事件不是模型执行，也不是真人五秒理解检查。
- T05 验收器补“恢复前确有未完成字段”，避免任务已全部完成却算恢复成功；不重做检查按目标+值比较，避免不同字段同值误报。该真实模型脚本尚未重跑，待授权调用模型。
- 新独立 Sol 复核 Dirac 同样 429 中断，无复核结论；不再循环派发，主代理已读实际 diff。不能标为独立 review 通过。

### 仍未完成

- T05：本轮要求的两套部分完成恢复与五项双入口技术证据已补齐；不能扩大为 P0 全十二项通过，未跑项及真人声学仍保留。T05 全票外部最终裁决未更新。
- T03：真人三态五秒理解；机器检查已完成。
- 集成：独立代码复核完成，外部最终裁决未更新；T07/T08 仍暂停。没有推送或发布。专用 ChromeMain 已按另一条工具链授权空闲重载，默认 Chrome 未触碰。

### 429 调查与方案

已核对本机 `~/.opencodex/usage.jsonl`：三名 Sol 工作时段有 429，`upstreamError` 为上游连接在响应前关闭、停止自动重放。对应 23:19 附近请求耗时约 10037–10040ms。已安装 `@bitkyc08/opencodex/src/lib/upstream-retry.ts` 明确定义 `REPLAY_REFUSED_STATUS = 429`，在 `replaySafe !== true` 的连接重置分支返回这个状态，防止客户端自动重复发送不确定已处理的请求。账号用量接口仍允许使用，周用量为 5%；不是周额度耗尽的证据。连接为何被关闭尚未确定，不能推出并发限制或某模型本身不支持子代理。

可操作方案：恢复 GPT 原生路由可绕过本地代理，但会改变全局模型入口，需用户授权并检查代理压缩历史兼容；本轮未改。若保留代理，上游 [PR #4942](https://github.com/lidge-jun/opencodex/pull/4942) 提供自包含请求的有界 reset 重试，核查时仍 Draft，未把未发布选项写入配置。不要把 429 强改成 502 或强制无限重放，以免重复模型请求/费用；不要消耗额度重置来处理此故障。

### 维护性检查

宿主材料直接扩展已有 recoveryInput/TaskView，不新建状态机；旧检查点缺字段保持兼容。交付工具和补发共用 projectDeliveryFacts，去掉重复判断；精确回执配对提取为可单独反例测试的函数。新增量主要是材料短摘要/守卫和验收测试，不新增运行依赖。按 TypeSafe 技能把已知身份、回执与计数留在代码；UI Skills 文案检查保持结束与完成的区别。
