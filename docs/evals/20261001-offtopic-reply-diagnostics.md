# 任务: 答非所问能被事后复现，只读任务自称没做完时先核对再交付

[当前状态](../STATUS.md)

## 起因（10-01 实测）

用户在「提取字幕并且保存」对话里，上一个任务（上传 Drive）因原地打转停下后，发「在YouTube里面找到前两首歌。」并附歌单截图。新任务（新 runId）读了一条 flomo 笔记，只拿到时间戳，随后交付了上一任务的 Drive 上传状态（outcome partial）。

- 排除的解释：新消息被当成续接（记录为新任务）；停下说明没进模型历史；Drive 记忆与近期对话；截图；宿主「交付」下一步提示。用同一模型（mimo-v2.6-flash）按诊断记录重放决定那一步，共 56 次，0 次回到 Drive。
- 未复现的差距：真实请求里的系统提示词与工具说明（约 2.4 万 token）和每次插入的任务状态没进诊断记录，重放无法还原。根因未定。
- 确认的缺口：只读任务（无页面改动、无存文件、不在问用户）不做目标核对，答非所问的部分交付直接收尾。

## 完成标准

- [x] 1. 每次模型调用写一行 `model_request`：系统提示词与工具说明的 sha256、字数，本次由宿主插入的上下文消息原文（脱敏后），请求里每张图片的 sha256、mime、字节数；不含图片像素 — 谁检查: 机器，真实会话 + 脚本模型测试
- [x] 2. 同一诊断会话里某个系统提示词或工具说明第一次出现时写全文（分段，单行不超过行上限），之后同一 sha256 不再重复写 — 谁检查: 机器，同上
- [x] 3. 由诊断记录可还原出一次模型调用实际收到的系统提示词、工具名单与说明、宿主插入消息：与模型端收到的逐字相同（图片按 sha256 比对） — 谁检查: 机器，测试里比对脚本模型收到的 context 与从记录还原的结果
- [x] 4. 用户附图的 sha256 与原图文件算出的 sha256 一致，可凭用户提供的原图确认是同一张 — 谁检查: 机器
- [x] 5. ~~只读任务一轮结束且本轮正式交付为 partial（或带 unfinished）时，跑目标核对~~；判 continue 时按现有规则催续做（每任务至多 2 次），催续提示带用户这次的要求 — 谁检查: 机器，复现 10-01 场景的真实会话测试
  - 修订（10-01）：用过工具（交付、记忆、目标记账工具除外）的只读任务一轮结束都跑目标核对，不论交付自称 partial 还是做完；判 continue 的催续规则不变。
- [x] 6. ~~只读任务正常交付（done、无 unfinished）不核对，问答不多一次快速模型调用~~ — 谁检查: 机器，同上测试计数核对调用
  - 修订（10-01）：纯聊天（没用工具，或只用交付、记忆、目标记账工具）不核对，不多一次快速模型调用。
  - 修订依据：用户要求结构性规则、不按交付措辞加特例；主代理实测快速模型核对 30/30 判对（正常问答判 done，Drive 答非所问判 continue，答非所问却自称做完也判 continue），见「实测证据」。按 partial 加特例拦不住「答非所问却自称做完」。
- [ ] 7. 真实快速模型对 10-01 那一轮的核对输入（目标「在YouTube里面找到前两首歌。」、最后回复为 Drive 上传状态）判 continue — 谁检查: 机器，真实模型探针，记录次数与结果
- [ ] 8. 再遇到答非所问时，导出的诊断记录足以离线重放那一步 — 谁检查: 人，下次出现时

## 边界与不做

- 不存图片像素：截图可能含隐私且单张数百 KB；只存指纹。
- ~~不核对自称已完成的只读回答（问答延迟不变）；答非所问却自称完成仍拦不住。~~ 10-01 修订后用过工具的只读回答都核对，读页问答收尾多等一次快速模型（约 2–8 秒）；纯聊天延迟不变。
- 不改主模型选择，不改「停下说明不进模型历史」（重放未证明它导致本问题）。
- 不追加记忆分类规则修改（「存在我的 Google Drive」被记成长期偏好，用户已撤销，另行处理）。

## 实测证据

### 实现

- 诊断：`agent/src/pi-agent-loop.ts` 在 `convertToLlm` 记下本次请求里的 custom 消息（宿主插入），在 `streamFn` 调模型前把实际请求交给观察回调；`agent/src/model-request-trace.ts` 算指纹、首次写全文（每段 16000 字），写进会话的 `runTrace`（`agent/src/session.ts`）。只接在扩展内的循环（`PiAgentLoop`，产品唯一路径）；只给 Node 托管检查用的 `node-agent-loop.ts` 未接。
- 核对（`agent/src/session.ts`、`agent/src/goal-check.ts`）：`goalCheckEligible` 改为「本任务用过 `GOAL_CHECK_BOOKKEEPING_TOOLS` 以外的工具，或最后在问用户」；原「改过页面」「存过文件」两条被包含，删去。`[GOAL CHECK]` 提示加上用户这次的原话（最近 3 条要求，各 300 字内）。

### 机器检查（2026-10-01）

| 标准 | 证据 | 结果 |
|---|---|---|
| 1–4 | `agent/test/offtopic-reply-diagnostics.test.ts` D1–D6：真实会话 + 脚本模型（真实 lead 系统提示词与工具），两次调用；从记录按 sha256 拼回系统提示词、工具说明，与模型收到的逐字相等；injected 与模型收到的非用户原话 user 消息逐条相等，含 `sideagent-result-projection`；全文只写一次且确实分段；图片 sha256 等于原图文件的 sha256；无行超 256 KB；记录里没有图片 base64 | PASS |
| 5 | 同文件 G1/G2 两例：先一轮 Drive 纯聊天（不核对），再在 flomo 页发「在YouTube里面找到前两首歌。」，读一次页面后①交付 Drive 状态 partial + unfinished、②自称做完的答非所问；脚本核对判 continue → 模型收到 `[GOAL CHECK]`，含用户原话与「找到前两首歌」，诊断记录有 `goal_check{status:continue,attempt:1}` | PASS |
| 6 | 同文件 G3：纯文字回答、只用 `send_user_message` 交付两轮，核对模型调用 0 次，无 `goal_check` 事件 | PASS |
| 能否证伪 | 把 `session.ts`、`pi-agent-loop.ts`、`goal-check.ts` 换回 HEAD 跑新测试：D1–D6、G1/G2 两例失败（无 model_request 行；核对调用 0 次），G3 通过（旧规则同样不核对纯聊天）；把记账工具集合清空后 G3 失败（核对 2 次）；去掉提示里的用户原话后 G2 失败 | 符合预期 |

其他：`npm run typecheck` PASS；`npm run lint:changed` 无新增违规；`npm run check:architecture` PASS；相关测试 13 个文件 134 例 PASS（含 `goal-check-files`、`task-next-step`、`resume-entry`、`pi-agent-loop`、`system-prompt`、`run-trace`、`no-progress-session`、`continuous-steering`、`extension-hook-events`、`tool-surface`、`task-goal-tool`、`node-crypto-shim`）。未跑全量测试、扩展构建和浏览器验收。

### 标准 7：真实快速模型探针（2026-10-01）

输入即 10-01 那一轮：goal「在YouTube里面找到前两首歌。」，goalPage flomo，lastReply 为 Drive 上传状态，page null，files []；经 `checkGoal` 原样调用，OpenCode 头 `x-opencode-session`、`x-opencode-client: pi`。

| 模型 | 调用方式 | 5 次结果 | 耗时 |
|---|---|---|---|
| opencode-go/deepseek-v4.1-flash | `checkGoal` 原样 | 5/5 continue（remaining「在YouTube找到前两首歌」） | 3.4–5.8 s |
| opencode-go/mimo-v2.6-flash | `checkGoal` 原样（`reasoning:"minimal"`） | 5/5 null（核对不可用） | 0.8–6.2 s |
| opencode-go/mimo-v2.6-flash | 同上但去掉 `reasoning` | 5/5 continue | 4.2–9.1 s |

mimo 失败原因：OpenCode 对 mimo-v2.6-flash 的 `reasoning:"minimal"` 回 400「Invalid request parameters」（同一提示词不传 reasoning、传 `low`、`medium` 都正常）。所以 mimo 作快速模型时，目标核对按现有代码一律「不可用」，标准 7 对 mimo 只在判断质量上成立。是否改 `checkGoal`（及其他用 `reasoning:"minimal"` 的快速调用）的参数，待主代理裁决。

主代理另测（各 5 次，3 种输入 × 2 个模型）：核对 30/30 判对——正常问答判 done，Drive 答非所问判 continue，答非所问却自称做完（「字幕文件已经整理好…」）判 continue。耗时：

| 模型 | 耗时 |
|---|---|
| deepseek-v4.1-flash | 约 1.7–3.7 s |
| mimo-v2.6-flash | 3–8 s（一次 18 s 离群） |

### 交付顺序（评估，未改）

核对期间最终正文不先交付：先交付再核对机制上可行（续做一轮会再交付一次），但判 continue 时用户会先看到并听到答非所问的回答，且 `complete` 交付会先记入目标计划的「已交付回答」（`task-progress.ts` 的 `recordAnswerDelivery`），再被续做推翻。这是产品取舍，不在本次改动内；代价是用过工具的问答收尾多等一次核对（上表耗时）。

### 未覆盖

- 标准 8 待下次真实出现时人工判断。
- Node 托管检查用的 `node-agent-loop.ts` 没有 `model_request`（产品不走这条路）。
- 重启后从检查点继续的任务：若续做时模型没再用工具，旧规则会因恢复的账本里有改页面记录而核对，新规则不核对（用过工具按本会话内的工具调用计）。
