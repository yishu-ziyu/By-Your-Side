# 整页翻译

[返回协议](protocol.md) · [使用说明](guides/usage.md)

用户说“把这页翻译成中文”时，主模型调用 `page_translation` 的 `translate`；配了快速模型时，先由快速模型判断意图，是就直接调用同一个工具，不经主模型（[`agent/src/translate-intent.ts`](../agent/src/translate-intent.ts)，见[使用说明](guides/usage.md#快速模型与即时动作)）。agent 里的 `runPageTranslation`（[`agent/src/page-translation.ts`](../agent/src/page-translation.ts)）负责分批和调用模型；页面一侧只提供 `begin`、`collect`、`apply` 三个动作（[`extension/src/shared/page-translation.ts`](../extension/src/shared/page-translation.ts)），准确类型见 [`shared/page-translation.ts`](../shared/page-translation.ts)。

## 分批与顺序

- `collect` 先给当前视口里的段落，再按离视口的距离排序；每批最多 8 块、3000 字符、24 个片段。最先并行发出的 4 批每批只取 2 块（`maxBlocks`，`PAGE_TRANSLATION_FIRST_BATCH_BLOCKS`），当前一屏分几路先落页，不等一整批。
- 翻译批次优先用快速模型（`ModelPort.fastModel`），不开思考；没配时用会话主模型。
- `collect` 带 `exclude`（正在翻译的块号）时跳过这些块，并发的批次因此不重叠；agent 也会丢掉页面仍返回的在途块。
- `apply` 只写入完整且原文未变的段落；页面在翻译期间换掉的段落留给下一次 `collect`。

## 待翻占位

- `begin` 与 `collect` 时，每个还没有译文的段落末尾插入一条占位（`data-bys-translation="pending"`，`aria-hidden`，淡蓝色流光，系统设置减弱动态效果时静止）。占位是独立元素，取词时与译文一样被排除，不改网站元素自身的样式。
- 某段译文写入时撤掉这段的占位；`restore` 与页面换掉段落时一并撤掉。
- 翻译结束时，agent 在 `finally` 里发 `settle`：译完、用户停止、看门狗到时立即撤掉所有剩余占位；「翻译生成失败，可继续」时带 `delayMs`（`RESUME_GRACE_MS` = 15 秒），模型再次调用翻译的 `begin` 会取消这次撤除，占位保持不动，避免两次调用之间成片消失又出现、页面跳动。用户停止后任务的执行闸门会拒绝后续页面动作，所以 `settle` 走不登记任务步骤的直连调用，扩展侧也对它豁免任务身份检查；它只删产品自己的占位。收尾失败不会覆盖翻译本身的结果。
- 兜底：页面上 185 秒没有任何 `begin`／`collect`／`apply` 就自行撤掉占位（比 agent 的 180 秒无进展停止略长），防止流程意外中断后占位常驻。
- 实测见[验收记录](evals/20260927-translate-marks.md)：改后约 5–8 秒出现占位，停止后 0.25 秒收掉。

## 请求池

- 最多 4 批同时在途（`PAGE_TRANSLATION_CONCURRENCY`，允许 1–8）。哪一批先译完就先落页，不等同时发出的其他批次；用户会看到译文一批一批出现。
- 页面报告的剩余段都已在途时不再问页面；有空位且还有剩余时继续 `collect`。
- 一批最终失败后不再开新批，已在途的批次照常落页，然后如实报告已完成和剩余段数。连续 3 批写不进页面（页面一直在变）时停止并返回 `incompleteReason: "page-changing"`；一次调用最多启动 128 批。

## 服务商限流

- 服务商以「同时请求太多」拒绝（`isProviderThrottle`：`concurrent request`、`rate limit`、`too many requests`、429；含额度、余额、账单字样的不算）时，这批段落不写页面，请求池宽度降到仍在跑的批数（最少 1），并退避 1、2、4、8 秒后再发；被拒的段落由下一次 `collect` 重新取到。限流不做同批立即重试。
- 连续 8 次限流仍无一批写入时按失败报告「模型服务商一直以同时请求太多拒绝」。有批次写入即清零。
- 起因：Kimi 编程套餐并发上限低，4 路并发时每次调用 3 批 403，长文只译出几十段（[验收](evals/20260927-translate-marks.md)「日常试用」）。

## 时限

- 不再有固定的 240 秒工具时限。连续 180 秒没有任何一批落页才停止（`PAGE_TRANSLATION_IDLE_MS`），并报告“长时间没有进展”；单次调用另有 15 分钟硬上限（`PAGE_TRANSLATION_MAX_MS`）。
- 单次模型请求仍是 60 秒超时、`maxTokens` 10000。用户停止时立即中止在途请求，晚到的译文不写入页面。

## 失败与重试

- `length`（写满输出上限，多半是思考失控）：把这批对半拆开再翻，最多拆两层（8 → 4 → 2 块）；已经拆到底或只有一块时只原样重试一次。
- `aborted`、`error` 等生成中断：同一批原样重试一次。
- 返回的 JSON 无效或段落对不上：同一请求带纠错提示重新生成一次，仍不对就算这批失败。

## 诊断记录

每次翻译请求写一行 `page_translation_request`，只装扩展时随设置页「诊断记录」一起导出：

- `batch`（在池里的序号）、`depth`（因 `length` 拆分的层数）、`retry`（是否同批重试）、`attempt`（格式纠错的第几次）；
- `stopReason`、`elapsedMs`、`blocks`、`segments`、`inputChars`、`usage`（token 用量），失败时带脱敏后的 `error`；
- 格式无效或段落对不上另记一行 `phase: "validation"`，`reason` 为 `invalid_json` 或 `segment_mismatch`。

工具整体的开始、结束、耗时和回执照常记在 `tool_execution_*` 行。长文翻译的耗时实测见[验收记录](evals/20260926-translate-fast.md)。
