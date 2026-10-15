# 任务: 模型请求卡住不出第一个字时，用户不再先干等满 15 秒、再等重试从头开始

用户遇到的问题：一周日常使用里首字超时 14 次（StepFun 9、Kimi 3、MiniMax 2），每次先白等约 15.5 秒，重试后再等 4.5–13 秒才出字。成功请求的首字最慢也只有约 14 秒，所以超时的那些基本是挂住的长尾，不是在慢慢思考。这 14 次全是“sent nothing”：服务端连第一个原始流事件都没发（没受理）。

做法是对冲请求（Dean & Barroso《The Tail at Scale》）：原请求到对冲时间点既没出第一个事件、也没被受理，就再发一份完全相同的请求，原请求不取消；先出第一个事件的那份胜出，另一份立即取消。代码见 [pi-agent-loop.ts](../../agent/src/pi-agent-loop.ts) 的 `withFirstEventDeadline`。

## 规则
- R1 单次挂住时，用户在对冲时间点后不久看到回答，侧栏只有一份回答。
  - 例子(正)：原请求一直不出事件，对冲那份照常回答；用户约 8 秒看到回答，旧代码要约 15.8 秒 — 谁检查：`npx tsx scripts/acceptance/real-path/hedged-first-event.mts --headless --case=wins`
  - 例子(反)：两份都写出了字，侧栏先后出现两份回答。原请求 10 秒写出“甲”，对冲那份 10.3 秒写出“乙”，侧栏只能出现“甲”，“乙”一次也不能出现 — 谁检查：同上 `--case=late-loser`
- R2 对冲不让用户比以前等得更久：两份都没被受理时，在原上限（15 秒或登记的 `firstEventMs`）放弃，照旧重试或换备用模型。对冲那份已被受理（服务还活着）时，才允许它受理后再等 `MODEL_STALL_AFTER_START_MS`；它随后出错被丢掉，就退回原上限。
  - 例子(正)：两份都只回响应头，15.5 秒发出重试；对冲那份受理后连接断开，同样 15.5 秒重试 — 谁检查：同上 `--case=unaccepted`、`--case=accepted-error`；备用模型那条路径：`model-failover.mts --headless --case=hang`（约 15.2 秒换到备用）
  - 例子(正)：对冲那份 8 秒受理、16.6 秒出字，用户看到它的回答，没有重试 — 谁检查：同上 `--case=accepted`
  - 例子(反)：两份都挂住，用户要等到 23 秒才看到重试或换模型 — 谁检查：同上 `--case=unaccepted`
- R3 对冲那份失败不连累整次调用：被拒（并发上限、429 等）或出错时静默丢掉，只等原请求。
  - 例子(正)：对冲那份收到 403 “You've reached your concurrent request limit”，用户 10 秒看到原请求的回答，没有错误卡，也没有重试 — 谁检查：同上 `--case=throttled`
- R4 效果能从日常记录量出来：发出对冲记一条 `model_hedge`（模型、对冲时间点），调用结束记一条 `model_hedge_winner`（first / hedge / none、胜出时刻、对冲那份的错误）。
  - 例子(正)：上面每个用例导出的诊断记录里都有这两条 — 谁检查：同上；真实效果：`npm run logs`

## 还没答上的问题
- 无

## 技术前提
- 前提：OpenAI 兼容适配层对每个原始流事件都调 `onProviderStreamEvent`，不带正文的首个事件（`role: "assistant", content: ""`）只算受理、不算第一个内容事件；只回响应头不算受理。小实验：`hedged-first-event.mts --case=accepted` 与 `--case=unaccepted` 结果：通过
- 前提：两份请求体完全相同，前缀能命中供应商的提示词缓存。小实验：`--case=wins` 比对两份请求体 sha256 结果：通过

## 各模型对冲时间点的依据

取用户日常记录（10-07 至 10-15）里该模型首字耗时 p90 左右，登记在 [model-capabilities.ts](../../shared/model-capabilities.ts) 的 `hedgeMs`：

| 模型 | 首字 p90 | 对冲时间点 |
|---|---|---|
| gpt-6-luna | 4.5 s | 6 s |
| gpt-6.1-sol | 6.9 s | 8 s |
| step-5-preview | 9.9 s | 11 s |
| MiniMax-M3.1-Flash-Preview | 11.5 s | 12 s |
| Kimi（kimi-coding 全部模型） | — | 不对冲 |
| 没有登记的模型 | — | 8 s |

更早对冲会给大多数正常请求白发一份；更晚就省不下等待。

## 边界与不做
- 只在原请求还没被受理时对冲。已受理的挂起交给“受理后 `MODEL_STALL_AFTER_START_MS`”那条规则；在已受理时再对冲，长前缀、慢思考的请求会多付一份，而实测 14 次超时没有一次是受理后才挂住。
- Kimi 不对冲：编程套餐同一时间只允许 1 个请求，同时发 2 个必有 1 个被拒，对冲那份必然失败。
- 不改首个事件上限、受理后上限和重试次数。
- 额外用量：约 10% 的调用（超过 p90 的那些）多发一份。输入大部分命中缓存；输掉的那份在另一份出第一个事件时取消，几乎不产生输出。
- 用例只证明程序这一层（本机脚本模型）；真实供应商上省了多少时间，要从 `npm run logs` 的 `model_hedge_winner` 量。
