# 任务: 被拦下等待确认的点击，不再被记账成"已执行"

2026-09-10 21:29 真机：ChatGPT 页面上 Agent 点发送按钮被拦成"待确认"，工具却回报 `ok:true` + `executionFact:"executed"`，任务账本直接把这项待办标成已完成——实际上一个鼠标事件都没派发。模型随后自己起疑（thinking："Hmm, but the snapshot says satisfied"），又读了一次页面才确认消息真的发出。

## 完成标准

- [x] 1. 点击被拦成"待确认"（没有派发）时，回执不再算"已执行"。— 谁检查: `npx vitest run extension/test/held-clicks.test.ts`
- [x] 2. 账本收到这类回执时，写作项转"结果未定"（只能靠页面证据解除）、只读项退回待做，二者都不判完成。— 谁检查: `npx vitest run agent/test/write-receipt-loss.test.ts`
- [x] 3. "结果未定"不会被重新登记洗回待做，模型不能把它当可重试项再点一次。— 谁检查: 同上
- [x] 4. 真正点成的点击、以及非 click 工具带 `held` 字段时不受影响。— 谁检查: 同上
- [x] 5. 全量回归。— 谁检查: `npm test` / `npm run typecheck` / `npm run build`

## 边界与不做

- 不改"哪些点击要被拦"的判定，不改按住形态、双键与状态层。
- 不改"取消会清掉整页标注"（未授权，见[上一轮验收](20260910-held-confirm-mark-cleanup.md)的"未决"）。
- 代价（本轮已知、未处理）：写作项转"结果未定"期间，同一轮里的其它写操作会被账本暂停（只读不受影响），必须先拿页面证据解除。用户确认后这条路走得通（真机那次页面上确实出现了新消息，可核查）；用户点"取消"时页面没有新证据，这一轮会一直卡在"结果未定"，直到用户下一条消息开新一轮才清账。没有改成"可重试"是有意的：确认后扩展自己派发那一击，若账本允许重试，模型可能再点一次造成重复动作。
- 本轮未提交、未推送。

## 证据

真机日志 `~/.sideagent/traces/1789046800691-94854dbb-f39a-408a-b6c6-bfd7b7b2fe2d.jsonl`：

（注：该文件当晚被 `RunTrace` 的自身轮转删掉——它只保留最近 20 份 trace，22:00 新宿主写入一批后把这份挤出了窗口。下列关键行是读取时抄录的。）

- 13:29:00 `click{label:"发送按钮"}` → `Held click on 发送按钮`，`isError:false`，没有任何鼠标事件
- 13:29:14 模型 thinking 自疑："Hmm, but the snapshot says satisfied"
- 用户确认后点击才真实派发，消息进入对话

改动：`extension/src/shared/held-clicks.ts` 新增 `isHeldClickResult`；`extension/src/background/index.ts` 回执按它决定 `executionFact`；`agent/src/task-results.ts` 的 `noteEnd` 在"成功但未执行"时不再判 `satisfied`。

| 层 | 入口 | 结果 |
| --- | --- | --- |
| 定向（扩展） | `npx vitest run extension/test/held-clicks.test.ts` | PASS（新增"回执执行事实"3 项：被拦算未执行、真点成算执行、其它工具带 held 不改判） |
| 定向（账本） | `npx vitest run agent/test/write-receipt-loss.test.ts` | PASS（新增 2 项：held 拦阻转未知且重新登记洗不掉、只读未执行退回待做） |
| 全量 | `npm test` | 136 文件 1122 项通过 |
| 类型/构建 | `npm run typecheck` / `npm run build` | 通过 |
| 部署一致 | CDP 取运行中扩展 | `background.js` `4937ea3a4631…`、`content-cursor.js` `922c78833fcd…` 与构建一致；扩展已重载 |

## 未决

1. ~~**agent 侧要宿主重连才生效**~~ 已做（22:32）：ego lite 与 Dia 两边的宿主都重连过，新宿主 21044/21046（ego lite）、21045/21047（Dia）启动于 22:32:16，晚于 21:55 的源码改动，日志有"面板已连接（native messaging）"。同时清掉了 Dia 那个 9 月 9 日拉起的旧宿主（2560/2564）。真实路径（再次被拦一次点击、看账本不再判完成）尚未跑，等日常使用时观察。
2. **确认/取消后没有回执把这一项收尾**：扩展在用户确认时自己派发点击，但不会就原来那次调用再发一条结果；账本只能靠模型读页面解除。要让"确认后自动转已完成、取消后自动回到可重做"，需要扩展把拿住结果连同调用 id 一起记下来并在确认/取消时补发回执，agent 侧 `resolveLateResult` 目前只接受成功回执，取消路径还要一并改。
3. 同段日志里另有两条观察，未在本轮处理：一次"确认"被记成两条 steer（同一毫秒重复，取证噪声）；13:28:34 一轮 `Connection error.` 自动重试，那一轮实际白跑。
