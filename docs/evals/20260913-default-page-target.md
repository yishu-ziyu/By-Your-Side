# 任务：发送任务时的页面成为这次任务的缺省页，不再随用户之后切页漂移

用户实际入口：侧栏发文字任务（同一会话），扩展 `extension/src/background`，工人在同一次任务里跑 `browser_run`。

## 完成标准

- [x] 在 B 发送、之后活动页变成 A 时，缺省读取（`snapshot`）出站仍带 B，而不是活动页 A。— 谁检查：`npx vitest run agent/test/rpc-default-page.test.ts`
- [x] 缺省写入/读取只补“协议里本来就接受 `tabId` 的页面工具”；显式 `tabId` 原样保留；`list_tabs`/`get_active_tab`/`worker_tabs inspect` 不被注入。— 谁检查：同上
- [x] B 关闭后缺省调用继续点名 B 并失败，不退到活动页 A。— 谁检查：同上
- [x] 显式 `switch_tab`/`open_tab`/`worker_tabs claim` 成功才改变缺省页，失败不变；显式只读别的页不改变缺省页。— 谁检查：同上
- [x] 缺省页按 session 隔离（缺省页 / worker 各一份）。— 谁检查：同上
- [x] 新任务设置缺省页后，旧调用晚到的成功回执不能覆盖它。— 谁检查：同上
- [x] `browser_run` 子调用与普通工具走同一条出站路径，都能拿到缺省页。— 谁检查：同上（`createBrowserTools` + 真实 `browser_run`）
- [x] 运行中普通插话（附带的是用户当时的活动页）不改变缺省页。— 谁检查：同上（真实 `BrowserAgentSession`）
- [ ] 原生同题复测（真 Chrome：B 发送 → 切 A → 首次 `browser_run` 只动 B）。— 谁检查：主代理

## 已确认原因（有证据）

trace `~/.sideagent/traces/1789274847140-ffca25eb-e464-4e4a-b356-8c06230ea096.jsonl`：第 0 条 `run_start.context.tabId=29960189`（B），第 1 条 `pre_observation.tabId=29960189` 成功；第 1 轮 `browser_run` 的读取却落到 `29960182`（A，`?scenario=a`），并在 A 上点了“开始步骤”；第 3 轮模型才自己 `tabs action:"switch" tabId:29960189`。

程序侧原因（不靠 trace 逐帧推断）：`agent/src/rpc.ts` 出站只带模型给的参数；扩展里 `resolveReadableTab`（`extension/src/background/state.ts:130`）与 `resolveWorkingTab`（同文件 343）在没有绑定时都退到 `chrome.tabs.query({active,lastFocusedWindow})`；预观察是只读的，不建立绑定。于是“发送时的页”从未进入后续缺省调用的参数。

## 改动

- `agent/src/rpc.ts`：`ToolRpc` 按会话（缺省页 / worker）保存缺省页与单调设置序号；出站时只给“接受 `tabId` 的页面工具”（`snapshot`/`read_element`/`network`/`page_operation`/`close_tab`）补缺失的 `tabId`，显式参数与全局管理工具不动；`switch_tab`（参数里的 tabId）、`open_tab`（回执 tabId）、`worker_tabs claim`（回执 tabId）成功回执按序号更新缺省页，失败不动，晚到结果被更早的设置挡住。
- `agent/src/session.ts`：`sendUserMessage` 起新任务时（非插话分支）用 `context.tabId` 设置本会话缺省页。

未改：`shared/protocol.ts`、扩展代码与状态、权限门；`tools.ts` 未改（出站注入放在 `rpc.call`，两条工具路径共享）。

## 实测证据

- `npx vitest run agent/test/rpc-default-page.test.ts`：13 项通过（B 发送仍点名 B、只读显式别页不改缺省、B 关闭不退 A、switch/open/claim 成功才改、session 隔离、晚到不覆盖、`browser_run` 子调用与普通工具都注入、普通插话不漂移）。
- 定点回归：`rpc`、`session-helpers`、`conversation-manager`、`task-result-turn-economy`、`tool-surface`、`handback-constraint`、`parent-tab-control`、`foreign-takeover`、`browser-recovery-tools`、`browser-program(-binding)`、`pre-observation-identity-order` 共 10 文件 119 项通过。
- `npm run typecheck`（两端）通过。

## 执行者阶段的边界（历史，以下由主代理补齐）

1. `click`/`hover`/`fill`/`type_text`/`press_key`/`scroll`/`js`/`navigate`/`screenshot` 的协议里没有 `tabId`（`shared/protocol.ts` ToolContract），扩展侧 `resolveWorkingTab(undefined, sessionId)`（如 `extension/src/background/exec/input.ts:828`）仍按“已认领页 → 活动页”解析。缺省页只改了读取与接受 tabId 的写工具；这些输入类工具在缺省页尚未被认领时仍可能落到活动页。要彻底关掉，需要在协议/扩展侧给它们可选 `tabId`，或让 Agent 用不加激活的绑定动作落一次归属——两者都超出本次授权范围。
2. 恢复路径（接管后 `continueAfterHandback`、验收续跑）不重设缺省页：交还是“同一轮任务的继续”，缺省页应保持在原任务页；若用户真的换了页并在插话里明确指代，模型可用显式 `tabs switch` 改缺省页（成功回执会更新）。
3. 没有任何 `context` 的新任务不改缺省页（保持上一次任务页）。当前入口都会带上页面上下文；“缺上下文时是否清空缺省页”属于产品取舍，未擅自决定。
4. 未跑全套 `npm test`/`build`/浏览器验收；原生同题复测由主代理执行。


## 主代理最终补齐与原生验收

输入执行器click/hover/fill/type_text/press_key/scroll/js/navigate/screenshot/mark/clear_marks已接受可选tabId，RPC名单完整补齐。shared ToolContract同步可选参数；screenshot handler保留参数，close_tab在takeTab前也解析默认页。新标签点击成功跟随新目标；无context新任务保持现有目标但推进版本，防旧回执覆盖。

原生Chrome：B(final)发送“先等5秒再填成都，不保存”后切A(final)，B填成都、未保存，A零事件；随后B发送“等10秒再填苏州，页关闭就停止”并关闭B，任务报告已停止，A仍零事件，没有新开页。见interaction-loop-audit证据08/09/10。原任务默认页漂移的真实路径已修后通过；不以此替代所有网站情况。

最终全量179文件1569项、类型检查和构建通过；本地扩展已重载；未提交推送。
