# Jev 网页循环与实时判断

[协议](protocol.md) · [架构](architecture.md) · [浏览器组合执行](browser-program.md)

`browser_loop`（Pi）和实时判断 `judge_browser_action`（语音）都由代码掌控流程，每看到一次页面只问 Jev 几个窄问题，再由代码组合答案决定悬停、续读、执行或停止。2026-09-26 起替换了原来「在十几种操作里选下一步」的单一问题；原因和对照数据见[设计调查验收](evals/20260926-jev-narrow-questions.md)。

## 问什么

状态只含：用户这一步的原话（`request.task`，另附整体任务或改口，如果不同）、URL 与当前分区名、可操作控件清单（每个一行：角色、名字、所在分区、状态），以及执行过动作之后由代码写的事实 `actions_done`。不发页面正文和历史提醒。模板在 [`browser-questions.ts`](../agent/src/browser-questions.ts)。

| 问题 | 类型 | 何时问 | 代码怎么用 |
|---|---|---|---|
| `target` | Choice（控件 + none） | 每次 | 用户接下来要点、选、切换或填写的控件；已操作过的控件不再是选项 |
| `target_listed` | Noul | 每次 | 低于 0.5 时不采信 `target`，继续读 |
| `opener` | Choice | 每次 | 要先打开的菜单或分区：先悬停；悬停没有新内容才点开 |
| `part` | Choice | 还有两个以上未读分区 | 决定续读顺序，不设门槛 |
| `goal_done` | Noul | 执行过动作后 | ≥ 0.85 时以 `needs_verification` 结束，并在 `completion` 里附上事实 |
| `browser_tab` | Choice（其他标签页 + none） | 目标提到标签页或点名另一个标签页 | ≥ 0.85 时切换 |
| `risky` | Noul，只问选中的那个控件 | 点击前 | ≥ 0.5 不点，交回 `permission_required` 请用户确认 |
| `turn_on` / `option` / `value` | Noul / Choice | 开关、下拉、填写前 | 开关已在要求状态就不点；下拉只选观察到的选项；填写只从宿主材料里选，没有就交任务模型准备 |

`risky` 只针对删除、付款或购买、发送、发布；保存、打开、切换设置这类用户明确要求的可逆写入按普通点击处理。

## 代码负责的规则

- 动作门槛 0.85 不变；同一控件一个循环里只操作一次；悬停只用来展开。
- 读完所有未读窗口（先游标，再按 `part` 排序的分区）才说 `no_match`；整页一次看全时没有未读分区；控件集合和已判断过的窗口相同就跳过，不再问 Jev。
- 动作后用 `snapshot({viewScopeId, fresh:true})` 重读动作所在分区；分区不在了回到新采集的默认视图。
- 填写和下拉写入后读回核对；切标签页以执行器回报的工作标签页为准。未知写入不重放。
- 一个循环最多 16 次 Jev 请求；实时判断最多 6 次，自己续读未读窗口，从不执行。

## 传输

[`jev-client.ts`](../agent/src/jev-client.ts) 固定 `jev-1.13.0`，单次请求总时限 3 秒。只对连接层失败（TCP/TLS 建连超时、连接被重置等）重试一次；Jev 是只读判断，重试没有副作用。响应阶段超时、HTTP 错误不重试。[`jev-transport.ts`](../agent/src/jev-transport.ts) 使用独立连接池：建连 1 秒上限，空闲连接保留 120 秒；配置了 `proxy` 时同样走代理。扩展内构建换成浏览器自带 `fetch`。

## 直接交付（开关）

`browserLoopDirectDelivery`（`~/.sideagent/config.json`，或环境变量 `SIDEAGENT_BROWSER_LOOP_DIRECT_DELIVERY=1`）默认关闭。打开后，循环自己判定完成（`goal_done` ≥ 0.85）、写入只有执行器确认送达的低风险点击、仍在请求所在页面时，直接交付「已完成：点击了……」，不再让主模型复核（[`browser-loop-delivery.ts`](../agent/src/browser-loop-delivery.ts)）。填写、下拉、切标签页和其他情况照旧交主模型。是否打开取决于验收里「误报完成」是否为 0，当前结论见 [STATUS](STATUS.md)。
