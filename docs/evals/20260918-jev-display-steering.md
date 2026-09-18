# Jev 运行中显示修改加速

范围：把已有的新任务 Jev 显示判断，扩展到运行中的明确显示修改（文字与语音共用一条路径）。
本文件先固定完成标准；每张 ticket 完成后补对应检查命令与证据。真实验收结果在 Ticket 6 追加。

## 完成标准（对应 ticket 总 spec）

- [ ] S1 运行中明确要求的宋体、双语、仅译文可由 Jev 判断，可同时指定字体和模式；缺失参数不猜默认值，判断模块不执行操作。
- [ ] S2 命中的修改通过原工具应用于原任务页面；`runId` 不变、不新建任务、不提前结束原任务。
- [ ] S3 原任务知道最新要求及该修改是否已执行并核验；后续不重复执行、不恢复旧设置，其余未完成要求保留。
- [ ] S4 不确定/超时/混合要求回原路径；取消、接管、任务变化、同 URL 刷新后晚到候选不写入；连续修改同一属性后者覆盖，不同属性互不丢失。
- [ ] S5 文字与语音复用同一条运行中显示修改路径，结果一致；语音不新增确认循环，不吞原任务播报。
- [ ] S6 新能力独立开关默认关闭；关闭后行为不变；有可复现的真实浏览器配对证据与耗时/直达率。

## Ticket 1 统一显示判断结果与独立开关

- 判断结果改为三态：`candidate`（无执行授权）/ `fallback`（含 `partialScope` 观察）/ `cancelled`。
- 新增 `displaySteerFastPath`，默认关闭，且受现有 `displayFastPath` 总开关约束。
- 保留固定模型 `jev-1.13.0`、单次 1 秒、无重试；未指定的字体/模式不补默认值。
- 检查：`npx vitest run agent/test/display-steer-routing.test.ts agent/test/display-fast-path.test.ts agent/test/config.test.ts`（26 通过）。

## Ticket 2 拆开显示执行与整任务结束

- 复用已注册工具执行器，执行前后核对文档身份，核验字体与显示模式；不匹配/回执丢失/异常不报告成功。
- 可复用执行部分不发出整任务完成事件；新任务收尾留在新任务调用方。
- 检查：`npx vitest run agent/test/display-fast-path.test.ts`（13 通过，含可复用执行 7 项）。

## Ticket 3 接入文字运行中修改

- `dispatchTaskAction` 的运行中 `steer` 命中显示候选时经统一执行器直接应用，保留同一 `runId`。
- 先登记修改（挡住在途旧写入）再等待异步判断与执行；应用后把最新要求与已核验事实交回原任务。
- 同一请求重放不重复执行；开关关闭保持原修改行为。
- 写闸门按具体工具调用放行显示直达本身，旧计划调用仍返回「旧步骤未执行」。
- 检查：`npx vitest run agent/test/display-steering.test.ts`（10 通过）；
  回归：`display-fast-path/continuous-steering/page-translation/page-translation-executor/conversation-manager/task-dispatcher/task-queue/voice-control-confirmation` 共 128 项通过。

## Ticket 4 连续修改、范围回退与晚到结果

- 等待判断、等待执行、执行后核验三个阶段各有失效检查；`agent_end`/取消/接管会中止在途直达调用。
- 同一属性新要求覆盖旧要求，不同属性互不丢弃；混合请求完整回退，局部约束随回退保留，后续整页请求可重新授权。
- 已执行但结果未知时不自动重做，账本保留未决写入并暂停后续写入。
- 检查：`npx vitest run agent/test/display-steering.test.ts`（22 通过，含 Ticket 4 竞态 12 项）；
  `npx vitest run agent/test/display-steer-routing.test.ts`（答案形态与响应边界）。

## Ticket 5 语音复用同一路径

- 语音判定为运行中显示修改后进入 Ticket 3 的统一入口，保留请求/任务/页面身份。
- 相同文字与转写输入结果一致；不新增确认循环；不吞原任务播报。

## Ticket 6 真实配对验收与 review 交付

- 新增 `scripts/acceptance/jev-display-steering.mts`（隔离无头浏览器），关闭/开启各一次相同修改，至少 10 组配对，单列边界场景。
- 报告全样本成功率、直达率、耗时分布、失败耗时与模型调用；新增能力保持关闭。

## 边界与不做

- 不新增显示能力；恢复网站字体、局部样式、新翻译、混合任务仍走原路径。
- 不替换 Pi/浏览器执行器/ASR/TTS，不改未知写入恢复政策。
- 语音仍先经过现有意图判断；不宣称已省掉语音分类开销。
- 性能门槛未定；本轮只测量，不据此启用新开关。真人听感另行验收。
