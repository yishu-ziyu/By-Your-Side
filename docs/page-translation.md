# 整页翻译

[返回协议](protocol.md) · [使用说明](guides/usage.md)

用户说“把这页翻译成中文”时，主模型调用 `page_translation` 的 `translate`。agent 里的 `runPageTranslation`（[`agent/src/page-translation.ts`](../agent/src/page-translation.ts)）负责分批和调用模型；页面一侧只提供 `begin`、`collect`、`apply` 三个动作（[`extension/src/shared/page-translation.ts`](../extension/src/shared/page-translation.ts)），准确类型见 [`shared/page-translation.ts`](../shared/page-translation.ts)。

## 分批与顺序

- `collect` 先给当前视口里的段落，再按离视口的距离排序；每批最多 8 块、3000 字符、24 个片段。
- `collect` 带 `exclude`（正在翻译的块号）时跳过这些块，并发的批次因此不重叠；agent 也会丢掉页面仍返回的在途块。
- `apply` 只写入完整且原文未变的段落；页面在翻译期间换掉的段落留给下一次 `collect`。

## 请求池

- 最多 4 批同时在途（`PAGE_TRANSLATION_CONCURRENCY`，允许 1–8）。哪一批先译完就先落页，不等同时发出的其他批次；用户会看到译文一批一批出现。
- 页面报告的剩余段都已在途时不再问页面；有空位且还有剩余时继续 `collect`。
- 一批最终失败后不再开新批，已在途的批次照常落页，然后如实报告已完成和剩余段数。连续 3 批写不进页面（页面一直在变）时停止并返回 `incompleteReason: "page-changing"`；一次调用最多启动 128 批。

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
