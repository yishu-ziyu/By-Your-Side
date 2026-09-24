# copy-no-save 为什么要 80–220 秒（2026-09-24）

任务：在本地 fixture 页上说「把蓝色 Note 框里的第一句英文原文复制到下面的草稿框里，不要保存。」。正确结果是 `#draft` 的值恰好为 `Jev currently accepts text input only.`，并且没有 POST /save。模型：`zai-coding-cn/glm-5.3-flash`。5 次运行全部通过，差别只在速度。

## 结论

- 时间几乎全花在模型上。工具执行（包括宿主的两次核对调用）每次合计只有约 2.3 秒；另外 97–99% 是模型的轮次。
- 每轮模型调用都有约 3–5 秒的首 token 延迟，解码速度约 45–54 tok/s。所以耗时基本等于 **轮数 × 4 秒 + 推理 token ÷ 47**。
- 就算没有任何报错，协议本身也要 7 轮（inspect → read_observation → plan → capture → fill → verify → 回复），约 60 秒。其他日常任务只需要 1–2 轮。
- 每次运行都会额外浪费 1–4 轮，原因是 `task_goals` 的参数契约很容易调错：plan 被拒 5/5，verify 缺 target 5/5。浪费从 14 秒到 87 秒不等。
- 155 秒那次（12:13 全套运行）还叠加了测试框架的问题：open-tab 用例留下的 /job 标签页成了“当前页”，模型只能去另一个标签页找 Note，多出约 24 秒的轮次，第一轮的思考也更长。

## 每次运行的时间分解

| 运行 | 总耗时 | 轮数 | 模型时间（首 token / 解码） | 工具 | 推理 token | 报错轮次 | 可避免的重试 |
|---|---|---|---|---|---|---|---|
| A 11:57 全套（旧 fixture，行内有 "Note:"） | 217.9 s | 11 | 214.8 s（55.2 / 159.6） | 2.3 s | 6598 | plan 缺 id、fill 被 take_tab 拦截、verify 缺 target | ≈41 s |
| B 12:13 全套（原始的 155 秒） | 154.3 s | 11 | 151.0 s（45.7 / 105.4） | 2.4 s | 4183 | plan 缺 id、verify 缺 target | ≈14 s，另有框架造成的约 24 s |
| C 单独 #1 | 147.2 s | 11 | 143.9 s（32.7 / 111.2） | 2.2 s | 4124 | plan ×3（appendSourceUrl）、verify 缺 target | ≈87 s |
| D 单独 #2 | 79.3 s | 9 | 76.1 s（36.0 / 40.1） | 2.4 s | 1408 | plan 缺 id、verify 缺 target | ≈19 s |
| E 单独 #3 | 98.7 s | 11 | 95.4 s（45.1 / 50.2） | 2.4 s | 1481 | plan 缺 id、fill target 写法无效、verify 缺 target | ≈21 s |

“可避免的重试”只算修正轮本身的时间，不算第一次失败的那一轮，因为那一轮本来就要发生。去掉这部分后，C/D 都约 60 秒，E 约 77 秒，这个数就是现有协议下的结构性下限。

### 逐轮（秒，括号里是推理 token）

- A：T1 inspect 72.6（3105）· T2 read_obs 5.7 · T3 plan **ERR** 62.2（2466）· T4 plan 18.0 · T5 capture 7.0 · T6 fill **ERR 该页正在由其他会话使用** 7.5 · T7 take_tab 7.6 · T8 fill 10.6 · T9 verify **ERR** 2.9 · T10 verify 7.8 · T11 send_user_message 15.3
- B：T1 snapshot 另一标签页 + inspect 40.2（1424）· T2 plan **ERR** 37.3（1512）· T3 plan 6.8 · T4 inspect 6.1 · T5 read_obs 6.0 · T6 capture 21.4（首 token 16.5 s，属于供应商波动）· T7 tabs switch 11.9 · T8 fill 6.4 · T9 verify **ERR** 5.6 · T10 verify 7.3 · T11 回复 4.4
- C：T1 inspect 6.5 · T2 read_obs 8.3 · T3–T5 plan **ERR×3** 15.6 / 10.1 / 28.8（872）· T6 plan 41.8（1375）· T7 capture 10.9 · T8 fill 9.1 · T9 verify **ERR** 5.3 · T10 verify 6.3 · T11 回复 3.6
- D：T1 inspect 8.9 · T2 read_obs 4.5 · T3 plan **ERR** 13.0 · T4 plan 7.1 · T5 capture 8.7 · T6 fill 9.8 · T7 verify **ERR** 7.1 · T8 verify 11.5 · T9 回复 8.1
- E：T1 inspect 14.1 · T2 read_obs 9.2 · T3 plan **ERR** 26.9 · T4 plan 6.3 · T5 capture 4.9 · T6 fill **ERR loc=role:textbox** 8.8 · T7 snapshot 5.8 · T8 fill 3.4 · T9 verify **ERR** 5.4 · T10 verify 5.7 · T11 回复 7.4

宿主的核对调用：capture 的来源核对约 0.83–0.87 s，verify 的目标核对约 0.81–0.89 s（`reviewedBy: jev`）。两者都不是瓶颈。

## 原因排序（已观察到的事实）

1. **协议固定要 7 轮，每轮至少约 4 秒首 token 延迟。** 5 次运行里首 token 延迟合计 33–55 s，平均每轮 3.0–5.0 s。只有 inspect 和 read_observation 两轮是纯取数：模型拿观察编号和片段 id，宿主在循环开始前已经读过这些 fast observation。类别：产品/架构。
2. **`task_goals plan` 每次都被拒（5/5）。**
   - 4/5 是 `goals.N.id: must have required properties id`。schema 要求 id，但模型总是省略，每次多 1 轮（6–18 s，A 里还碰上缓存未命中，cacheRead=0）。
   - 1/5（C）是在 material 目标上写了 `appendSourceUrl:false`。`shared/task-goals.ts` 的 `isTaskGoalPlan` 只允许 field 带这个字段，可 `agent/src/task-goals.ts:112` 返回的通用错误只说“id 不能重复且不超过 64 字 / description / criterion / requirements”，完全没提 appendSourceUrl。模型对着错误信息猜了三轮，花了约 81 s，推理 token 也越来越多（287 → 872 → 1375）。
   - 类别：产品（工具契约和错误信息）。
3. **field 目标的 verify 缺 target（5/5）。** `agent/src/task-goal-tool.ts:142` 要求 field 核验必须带 target。可 schema 的描述只写了 tabId 必填，target 没有说明。每次都要多 1 轮（5.7–11.5 s）。类别：产品（工具契约）。
4. **首轮和 plan 轮推理 token 很多，而且波动大。** 单轮 1400–3100 推理 token 就是 30–70 s。看思考内容，主要在排协议步骤（先 inspect 还是先 plan、观察编号从哪来、materialId 怎么配对），B 里还要判断目标在哪个标签页。整次运行的推理 token 在 1408–6598 之间，同一个任务差了 4.7 倍。类别：模型/供应商波动，但决策面越大，波动越大。
5. **测试框架的问题（只出现在全套运行里）：**
   - B：open-tab 用例新开的 /job 标签页仍然是活动页，脚本只在原标签页导航到 /note，所以 `run_start.context` 是 /job。结果多了 snapshot 另一标签页、第二次 inspect、read_observation 和 tabs switch 这几轮（约 24 s），T1 的思考也拉长了。
   - A：前一个用例的会话占着这个标签页。脚本点了“新对话”后，fill 被“该页正在由其他会话使用，请调用 take_tab”拦下，多了 2 轮（约 15 s）。这一条是真实产品行为：用户在同一页开新对话，同样会碰到，只是这次由测试框架的用例顺序触发了。
6. **偶发的模型错误：** E 的 fill target 写成了 `loc=role:textbox`，没带 name，多了 snapshot 和重新 fill（约 9 s）。B 的 T6 首 token 用了 16.5 s，A 的 T4/T11 分别 14.8 s 和 11.7 s，这些属于供应商延迟的尾部。

## 推断（未验证）

- A 的 T1/T3 推理特别长（3105 / 2466），大概率是旧 fixture 里行内的 "Note:" 前缀带来的歧义：思考里一直在纠结要不要保留 "Note:"，最后捕获的是 `Note: Jev ...`。fixture 已经修掉，所以 A 不代表现状。
- 同一条消息里的多个工具调用是并发执行的（B 的 T1 里两个调用的开始/结束时间交错）。所以不能靠让模型一次发出 plan+capture+fill 来省轮次，capture 依赖 plan 已固定，fill 依赖 capture 已保存。

## 最小改动建议（按性价比排序）

| # | 改动 | 预计节省 | 依据 |
|---|---|---|---|
| 1 | plan 缺 id 时由宿主补上（如 `goal-1`），或把 schema 里的 id 改成可选；material/condition 上的 `appendSourceUrl:false` 当作未设置；通用错误信息要写出具体是哪个字段、哪个目标违规 | 每次 1 轮 ≈ 7–18 s，长尾里最多 ≈ 80 s（C） | 5/5 次 plan 被拒 |
| 2 | field verify 没带 target 时，默认用本任务里对这个 tab 最近一次成功 fill 的 target；或者 fill 成功后宿主自动做一次 field verify | 每次 1 轮 ≈ 6–11 s；自动 verify 能再省 1 轮 | 5/5 次缺 target |
| 3 | 注入 goal 指引时，把 requirements、fast observation 的 id 和片段 id 直接放进首条 prompt，模型就不用先 inspect 再 read_observation | 2 轮 ≈ 10–20 s | 每次 T1/T2 都是纯取数 |
| 4 | 测试框架：导航后激活工作标签页（或者 copy 用例前关掉 open-tab 开的新页），让 copy 用例从一个干净的归属状态开始 | 全套运行中约 15–40 s；只影响测量，不影响用户 | A、B 专有的轮次 |
| 5 | （需要产品决定）点“新对话”时，释放旧会话在当前标签页上的空闲占用，或者新会话首次写入时自动接管空闲标签页 | 每次撞上时 2 轮 ≈ 15 s | A |

1–3 都做完以后，干净路径预计从 7 轮降到 4 轮（plan → capture → fill → 回复），大约 30–40 s。瓶颈会变成每轮约 4 s 的首 token 延迟和首轮规划推理，这两样只能靠换模型或降低推理强度解决。这个数是推断，需要改完后重跑同一个脚本 3 次来验证。

## 不能删的部分

- capture_page_material 的来源核对（从观察片段里按原文复制，并做一次独立 review）。
- 写入后 field 核验里的精确相等检查（`actual !== fieldMaterialValue(goal, material)`，见 `agent/src/task-goal-tool.ts`）。这是“填进去的值就是捕获的原文”的唯一硬保证。改动 2 只是替模型补上 target，或者把这一步提前自动执行，比较逻辑本身一个字都不能改。
- plan 的确定性覆盖检查（每项用户要求都要被覆盖，material 和 field 要成对）。改动 1 只是放宽格式上的小问题、把错误写清楚，不削弱覆盖检查。

## 证据

- 复现命令：`npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --only=copy-no-save`
- A：[out/acceptance/real-path/2026-09-24T11-57-12-015Z-everyday-baseline/traces/1790251357863-90051c57-d1f1-4544-aecb-9c9b0a367b53.jsonl](../../out/acceptance/real-path/2026-09-24T11-57-12-015Z-everyday-baseline/traces/1790251357863-90051c57-d1f1-4544-aecb-9c9b0a367b53.jsonl)
- B：[out/acceptance/real-path/2026-09-24T12-13-21-279Z-everyday-baseline/traces/1790252210348-ee43693a-d562-48b0-8466-2f19dbf6019f.jsonl](../../out/acceptance/real-path/2026-09-24T12-13-21-279Z-everyday-baseline/traces/1790252210348-ee43693a-d562-48b0-8466-2f19dbf6019f.jsonl)
- C：[out/acceptance/real-path/2026-09-24T12-25-56-879Z-everyday-baseline/traces/](../../out/acceptance/real-path/2026-09-24T12-25-56-879Z-everyday-baseline/traces/)
- D：[out/acceptance/real-path/2026-09-24T12-28-44-964Z-everyday-baseline/traces/](../../out/acceptance/real-path/2026-09-24T12-28-44-964Z-everyday-baseline/traces/)
- E：[out/acceptance/real-path/2026-09-24T12-30-30-147Z-everyday-baseline/traces/](../../out/acceptance/real-path/2026-09-24T12-30-30-147Z-everyday-baseline/traces/)
- 相关代码：`agent/src/task-goal-tool.ts`（plan/verify/capture，第 142 行 target 检查）、`agent/src/task-goals.ts:112`（通用格式错误）、`shared/task-goals.ts`（`isTaskGoalPlan` 里的 appendSourceUrl 规则）、`agent/src/session.ts:1758`（goal 指引注入）、`extension/src/background/state.ts:288`（标签页归属报错）
- 没有做：没有改任何源码，没有测改动后的效果，mark（51 s）没有分析。
