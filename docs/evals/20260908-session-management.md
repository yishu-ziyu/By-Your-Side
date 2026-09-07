# 任务: 会话独立运行，并让同一会话的多个执行者安全共用一张未保存页面

日期：2026-09-08。

本标准由独立校验角色在实现前锁定。实现方不得通过改测试断言、缩小真实路径或把前端演示状态当成运行时状态来满足本标准。标准需要调整时，由编排或用户裁决。

```text
Change:     用户新建或切换会话时，旧会话继续运行；各会话的聊天、目标、附件、权限和页面集合互不串线。Lead 判断拆分确实更高效时，主动向用户说明理由和分工，并让至少两位执行者在同一未保存页面上协作；执行者可由 Lead 和 worker 组成。实际写入以“定位并核对 → focus → 输入 → 读回验证”的完整短动作轮流发生。用户接管共享页时，这张页的全部写入者停止，其他会话继续。
Not this:   要求用户先说“请两位 Agent”或填写人数；把原型播放按钮当派工审批；凡事固定拆成两个 worker；按“简历”等关键词硬编码分工；清空前端消息后仍复用同一个 Pi AgentSession；只做会话列表 UI；用相同 URL 的两个标签冒充同一份未保存表单；让多个彩色光标同时输入；只锁单条 CDP 指令；把 A/B 历史合并为 C。
Evaluator:  临时 HTML 先由人评使用路径；获认可后，机器执行协议/运行时/标签归属/页级调度测试，最后在真实 local.yishu.chrome-main 浏览器走完整路径。
Evidence:   人评结论；测试命令与退出码；真实浏览器 result.json、会话/标签组截图、共享表单最终值与动作时间线。
```

## 实现前的人评门

- [x] 0. 在任何产品代码改动前，提供可点击临时 HTML，对照“改前 / 改后”走同一条使用路径：A 正在执行 → 新建 B → 切到 B 发起另一任务 → A 继续出结果 → 切回 A；再由用户只说“帮我完善这份简历，先别提交”，Lead 主动判断工作经历与教育经历可并行准备，向用户说明为什么分、分别做什么，随后实际派出子 Agent 在同一份未保存简历上协作，最后由用户接管该页。原型必须展示真实会话层级、运行/等待/被接管状态和页面归属，不能只有静态会话列表。— 谁检查: 人（2026-09-08，用户看过修订原型后回复“好的没问题，接下来可以开始”）
- [x] 1. 用户明确认可临时 HTML 中的会话入口、切换反馈、持续运行可见性和同页分工表达后，才允许修改产品代码。未认可只改原型。— 谁检查: 编排（2026-09-08，依据用户原文“好的没问题，接下来可以开始”，实现门已打开）

人评只决定交互表达，不得把下文的隔离、归属和串行安全条件降级。

## 身份与文件契约

实现可调整命名和文件位置，但必须保留以下边界，并用测试证明：

- 顶层用户会话使用稳定的 `conversationId`（推荐名）。现有 `sessionId` 继续表示 Lead / worker 执行成员。所有路由以 `(conversationId, sessionId)` 定位，禁止让两个顶层会话都落到隐含的 `main`。
- 每个顶层会话拥有独立的 Pi `AgentSession`、Fleet/worker 集合、消息与运行状态、当前目标、待发送附件、权限/接管状态、页集合。新建会话创建新的运行时实例；切换只改变面板当前展示项。
- Lead 根据任务依赖、可搬运的中间产物、共享页面状态和预期效率决定是否拆分；只有并行准备能减少等待且不会破坏页面状态时才派 worker。产品主动告诉用户拆分理由与分工，然后直接执行，不新增强制确认步骤。简单、短小或强依赖连续页面状态的任务保持单 Agent。
- 页绑定至少记录 `tabId + conversationId + mode(exclusive/shared) + collaborators`。普通标签只属于一个顶层会话；共享标签只允许同一顶层会话内被显式列出的执行成员访问。
- “显式共享”指运行时把被允许的执行成员登记进 `collaborators`，不是要求用户点名 Agent、选择数量或批准每次派工。
- 同 URL 查找限定在当前 `conversationId` 的页集合。目标只存在于别的会话时必须新建标签；对外会话 `tabId` 的 `switch_tab`、工具调用或隐式认领必须拒绝，并返回可识别的归属错误。
- 共享页写操作进入页级调度器。调度单位是一段完整短动作：重新定位并核对当前值 → 必要滚动/`focus` → 输入或点击 → 读回验证。锁在读回结束后才释放；锁单条 click/fill/CDP 命令不合格。
- 共享页材料与字段原值由受限只读工具 `read_element`（推荐名）读取。它接受当前 snapshot ref 或唯一 CSS locator，返回元素未经展示截断的完整 `text` 和表单 `value`；只读过程不 focus、不滚动、不改变选区、不派发 input/change/click 等事件。它不是 JavaScript 求值通道。
- 接管以 `tabId` 为边界：先阻止这张页的新写入，处理已在途短动作到安全停止点，随后将所有 collaborator 置为用户持有/停止。其他会话、其他独立页不受影响。

建议聚焦测试文件：`agent/test/conversation-manager.test.ts`、`extension/test/conversation-tabs.test.ts`、`extension/test/page-operation-queue.test.ts`。建议真实验收入口：`scripts/acceptance/session-management-run.mjs`，本地页面：`extension/test/fixtures/session-management.html`。这些路径由实现方或验收跑道负责方创建，本标准阶段不创建。

## 机器完成标准

- [x] 2. 新建 B 时得到与 A 不同的 `conversationId` 和 Pi `AgentSession`。A 已开始且尚未结束的任务继续产生只带 A 身份的状态、工具事件和最终结果；创建或切换 B 不调用 A 的 abort/reset/dispose。— 谁检查: `npx vitest run agent/test/conversation-manager.test.ts`
- [x] 3. A/B 各自保持聊天记录、当前目标、待发送附件、Lead/worker、运行状态和权限状态。向 B 添加消息/附件、接管或中止 B 后，A 的对应快照逐字段不变；切回 A 可继续对原上下文提问，底层收到的是 A 的历史，而非重新拼出的前端摘要。— 谁检查: `npx vitest run agent/test/conversation-manager.test.ts extension/test/session-management.test.ts`
- [x] 4. 用户在 A 运行时切至 B，分别中止 B、接管 B 的独立页，A 仍运行且可完成；中止 A 也不改变 B。迟到的 A/B 事件按 `conversationId` 归入原会话，不能落到当前屏幕所显示的另一会话。— 谁检查: 同上，使用可控 Promise 人为制造交错和迟到事件
- [x] 5. A 与 B 请求完全相同 URL 时创建两个不同 `tabId`，各在自己的 Chrome 标签组中，并分别绑定 A/B。组标题/颜色只用于展示，持久主键不得使用易变的 Chrome `groupId`。关闭、导航或激活其中一页不改变另一页。— 谁检查: `npx vitest run extension/test/conversation-tabs.test.ts`
- [x] 6. 当前会话内未找到 URL，但其他会话存在相同 URL 时，默认结果是新建标签。普通认领、恢复、`find/switch_tab` 及直接携带外会话 `tabId` 的工具调用均不能静默转移或双绑页面；显式共享请求也不得跨顶层会话。— 谁检查: `npx vitest run extension/test/conversation-tabs.test.ts agent/test/rpc.test.ts`
- [x] 7. 同一顶层会话的至少两位执行成员只有经过显式共享登记才可写同一个 `tabId`；有效组合可以是 Lead + 一名 worker，也可以是多名 workers，不要求固定两名子 Agent。登记后仍只存在一张表单页。未登记的额外成员和其他顶层会话写入同页均被拒绝。现有彩色光标身份与实际执行成员一致。— 谁检查: `npx vitest run extension/test/page-operation-queue.test.ts extension/test/tab-bindings.test.ts`
- [x] 7a. 用户只发送“帮我完善这份简历，先别提交”，没有提 Agent 或人数。Lead 根据可独立准备的字段主动说明拆分理由与分工，并实际调用 spawn；测试验证触发来自任务结构判断，不依赖“简历 / 工作经历 / 教育经历”等固定关键词。对一个短小单字段填写任务不得 spawn；对必须连续完成同页步骤的任务也应保持单 Agent，并给出可检验的合理不拆判断。不得始终创建两个 worker。— 谁检查: `npx vitest run agent/test/session-planning.test.ts agent/test/fleet.test.ts` + M3 真实正反例（2026-09-08）
- [x] 8. 页级调度测试人为安排 `甲 focus 上栏 → 乙请求 focus 下栏 → 甲输入`。可观察顺序必须是甲完成“核对、focus、输入、读回”后乙才开始；最终两栏分别得到甲/乙的预期值，任何步骤失败都返回操作者、目标、已发生修改和读回结果。— 谁检查: `npx vitest run extension/test/page-operation-queue.test.ts`
- [x] 9. 甲定位后由乙或页面脚本改变布局/字段值时，甲必须在获得写锁后重新定位并核对；目标过期或原值冲突则拒绝该次写入，不能按旧坐标点击。思考、生成文案和等待邮箱不占页锁。— 谁检查: 同上
- [x] 10. 共享页接管请求一到，新的写动作立即被挡住；已在途短动作完成或安全停止后，甲乙全部进入 user/held 状态。接管完成后注入迟到输入不得再改变 DOM。另一个顶层会话 B 的独立页仍可写入并完成。— 谁检查: `npx vitest run extension/test/page-operation-queue.test.ts extension/test/control-gate.test.ts`
- [x] 11. “中止顶层会话 A”只停止 A 的 Lead、workers、邮箱等待和页面动作；B 不受影响。“中止共享页中的单个 worker”只移除该 writer；“用户接管共享页”才停止该页全部 writers。— 谁检查: `npx vitest run agent/test/conversation-manager.test.ts extension/test/page-operation-queue.test.ts`
- [x] 12. 切换 A/B、关闭再重开侧栏后，会话列表、当前会话、各自消息/目标/附件、运行状态与页面归属仍可恢复；仍在运行的 A 继续把事件投递回 A。仅重新渲染 `panel-history` 或清空/重建前端数组不算恢复。— 谁检查: `npx vitest run extension/test/session-management.test.ts` + 真实浏览器验收
- [x] 13. `conversationId` 的协议解析覆盖合法值、缺失兼容、超长/错误类型拒绝；所有从 agent 发回的 `status`、`agent_event`、`tool_call` 及控制事件可无歧义地归属顶层会话。— 谁检查: `npx vitest run agent/test/protocol.test.ts extension/test/session-management.test.ts`
- [x] 14. 聚焦测试、全量回归、类型和构建全绿。— 谁检查: `npm run typecheck && npm test && npm run build`（2026-09-08 最终，61 files / 550 tests，typecheck/build/reload exit 0）

### 共享页完整只读回归标准

本组标准源于 2026-09-08 真实 M3 路径：snapshot 会截断较长文本节点和输入值，而共享页安全门又正确禁止 `js`，导致 worker 无法取得完整材料和可靠的 `expectedValue`。该问题不能通过放开共享页 JavaScript 或削弱写入门禁解决。

- [x] 14a. 新增受页归属约束的只读工具 `read_element`。参数至少包含 `target`，可选 `tabId`；成功结果包含实际 `tabId`、规范化目标、`tagName`、完整 `textContent` 和适用时的完整 `value`。fixture 使用超过 200 字的文本和超过 60 字的字段值，返回值必须逐字等于 DOM 当前值，不得沿用 snapshot/UI 的展示截断。若实现需要安全大小上限，超过上限必须明确失败，不能返回部分内容或用 `truncated` 结果冒充完整读取。— 谁检查: `npx vitest run extension/test/read-element.test.ts agent/test/protocol.test.ts`
- [x] 14b. `read_element` 只允许读取当前执行成员可访问的页：自己的 exclusive 页可读；显式登记的 shared collaborator 可读；其他会话页、同会话但未登记的 shared 成员、已关闭页均明确失败。失败结果需区分归属错误、目标不存在、目标过期和 CSS 多匹配，不能静默换页或退回当前活动页。— 谁检查: `npx vitest run extension/test/read-element.test.ts extension/test/conversation-tabs.test.ts`
- [x] 14c. 读取前后目标元素的 `document.activeElement`、value/text、selection、scroll 位置及 fixture 的 focus/input/change/click 计数全部不变。实现不得调用 `focus()`、`scrollIntoView()`、赋值 setter或事件派发。— 谁检查: `npx vitest run extension/test/read-element.test.ts`
- [x] 14d. 共享页进入用户接管后，写工具和 `page_operation` 仍被阻断，`read_element` 仍可读取最新完整值；读取不改变任何 writer 的 held/user 状态，也不解除页队列阻断。交还后 `page_operation.expectedValue` 可直接使用这次读取的完整 value。— 谁检查: `npx vitest run extension/test/read-element.test.ts extension/test/page-operation-queue.test.ts extension/test/control-gate.test.ts`
- [x] 14e. `read_element` 必须走现有协议解析、conversation/session 路由、页归属检查、`executeToolCall`/ControlGate 与 browser program 的取消/序列约束。browser program 被取消或失效后，迟到的 read step 不得被报告为当前 program 的有效结果。— 谁检查: `npx vitest run agent/test/browser-program.test.ts extension/test/read-element.test.ts`
- [x] 14f. 工具只接受定位串，不接受表达式、函数体、属性路径或任意脚本；生产与测试源码中不得用 `eval`、`new Function` 或把用户输入拼接进 `Runtime.evaluate`。CSS locator 必须用参数传递给固定读取函数。— 谁检查: 代码审查 + `npx vitest run extension/test/read-element.test.ts`
- [x] 14g. 真实本地 fixture 上，shared 的 Lead 与 worker 分别读取同一长材料与两个长字段，均得到完整一致结果；接管后重复读取仍成功，而 fill/js/page_operation 写入仍失败。所有读取经过扩展后台生产工具链，不用验收脚本直接读 DOM。— 谁检查: 真实 Chrome M3 存活 worker 路径（2026-09-08，5/5）

建议实现完成后增加一条稳定命令 `npm run accept:sessions`。它必须经过扩展 background/content script/CDP 和真实 agent 路由，任一步失败退出非 0；不得用 Playwright/Puppeteer 直接填写 fixture 绕过产品路径。

## 真实浏览器验收

只连接用户的 `local.yishu.chrome-main`，不打开或控制 `com.google.Chrome`。使用本地确定性 fixture，不访问真实账号和线上数据。

- [ ] 15. 两会话交错：在 A 提交一个带可观测等待点的页面任务；A 显示运行中时新建 B，在 B 打开另一 fixture 并完成填写；切回 A，A 已继续跨过等待点并完成。A/B 的对话、目标、附件瓷贴、运行结果和标签组各自正确。— 谁检查: 机器 `npm run accept:sessions` + 人看面板
- [x] 16. 同 URL 隔离：A/B 分别打开完全相同的 fixture URL。浏览器中可见两个不同标签，位于对应会话标签组；在 B 修改表单后，A 标签的未保存值不变；停止 B 后 A 仍可继续操作。— 谁检查: 同上
- [x] 17. 同页协作：在一张只保存在 DOM 的简历 fixture 中，用户只说“帮我完善这份简历，先别提交”。Lead 识别工作经历与教育经历可并行准备，先向用户说明拆分理由和执行者职责，再至少成功 spawn 一名 worker，并由运行时登记实际参与者为 collaborators；用户无需点名 Agent、填写数量或额外批准。至少两位执行者实际参与，可由 Lead + 一名 worker 组成。最终仍只有一个简历标签；工作经历与教育经历均由各自负责人产生可核对的真实产出且字段值准确；动作时间线证明准备可重叠，但完整写入短动作不重叠；每次写入都有 focus 和读回证据，且未执行提交。只口头宣布分工、spawn 失败后由 Lead 独自完成、或 worker 没有实际产出，均不通过。— 谁检查: 同上（2026-09-08，M3 连续两次真实正例通过）
- [x] 18. 接管与中止隔离：一名共享页 writer 正准备下一次写入时用户接管该页；两名 writer 均停止，等待后 DOM 不再变化。此时 B 的独立标签仍完成自己的任务。交还共享页后，只有拿到新快照并重新核对目标的成员可恢复。— 谁检查: 同上
- [ ] 19. 关闭再重开侧栏：A/B 内容和选中会话恢复，正在运行的会话仍正确更新。验收产物包含脱敏 `result.json`、动作时间线和关键截图；不得保存 cookie、token、完整浏览历史或用户页面正文。— 谁检查: 同上

## 持久化范围与重启核查

本轮最低完成线是同一浏览器/伴随进程生命周期内：切换会话、关闭再重开侧栏不丢上下文，后台 Service Worker 重启后可由持久浏览器状态和仍存活的 agent runtime 重新关联。

2026-09-08 已完成当前 `@earendil-works/pi-coding-agent` 的独立核查：两个独立 Node 进程先写后读同一个原生 Pi 会话文件，重开后保留唯一上下文 marker，动作计数未重复，证明没有重放旧任务。聚焦测试 `npx vitest run agent/test/pi-persistence.test.ts` 为 1/1 通过。生产实现使用 `ConversationStore` 为每个 `conversationId` 保存原生 `SessionManager` 指针，目录为 `~/.sideagent/conversations/<conversationId>/`；进程重启后摘要状态强制回到 idle，不自动续跑旧外部动作。

这项证据允许声明“伴随进程重启后可继续历史对话上下文”，不允许声明“重启后自动续跑中断前的浏览器任务”。2026-09-08 又在真实安装的 M3 会话上完成伴随进程重启：marker 保存于 01:20，进程 53922 于 01:58 启动后仍只回答原 marker，模型为 `minimax-cn/MiniMax-M3`。证据 `/tmp/sideagent-restart-evidence/result.json`，结果 `ok: true`。

- [x] SDK 原生持久会话跨进程核查通过，已允许把“伴随进程重启后继续历史对话”纳入实现。— 谁检查: `npx vitest run agent/test/pi-persistence.test.ts`（2026-09-08，1/1 通过）
- 如果真实安装版本恢复失败，不得回退为用前端历史冒充 Pi 上下文；应明确显示不可续跑的历史，并将其列为验收失败。这个约束不降低第 12、19 条的侧栏关闭/重开要求。

## 人评完成标准

- [ ] 20. A 运行时进入 B，用户仍能一眼看出 A 在继续、B 是独立上下文，并能低成本切回；运行/等待/完成状态来自真实事件。— 谁检查: 人
- [ ] 21. 用户只描述目标时，产品会在拆分更高效的情况下主动说明“为什么分、谁做什么”并开始分工；不把原型播放按钮、Agent 数量选择或重复确认变成使用前提。同页协作能看出“谁负责哪个字段、谁正在写、谁在等待页面”，彩色光标用于身份与位置反馈，不制造两套键盘同时输入的假象。— 谁检查: 人
- [ ] 22. 用户接管共享页后，界面明确表示这张页的全部 Agent 已停；其他会话继续，不让用户误以为全局暂停。— 谁检查: 人

## 2026-09-08 自动验收记录

校验裁决：第 17 条的目标是证明产品会自主形成有效分工，不是固定团队人数。正例必须至少成功 spawn 一次，且至少两位执行者实际参与同一页的两块工作；Lead 算一位执行者，因此 Lead + 一名 worker 可以通过。只有 spawn 调用或口头分工不够，必须看到双方各自的可核对产出与最终两块正确结果。负例的单字段简单任务不得派 worker。

`npm run accept:sessions` 已在 `local.yishu.chrome-main` 真实扩展上通过。15 项均为 PASS：A 的真实 acceptance Pi 任务运行时创建 B、会话列表、同 URL 不同 tab、不同 Chrome 标签组、A/B 草稿隔离、共享协作者登记、两名 writer 的读回验证、输入时焦点与完整事务串行、未提交、共享页接管包含两名 writer、接管后两名 writer 均无法写入、B 继续执行、B 中止不解除 A 的页级接管、浏览器状态持久化、default 会话模型恢复为验收前模型。

证据目录：`/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-accept-sessions-2026-09-07T17-19-46-745Z`。

这条确定性跑道不代替两项验收：真实侧栏关闭/重开后的可见恢复，以及用户只说自然语言目标时真实模型自主判断、说明分工并 spawn。二者仍按第 19、20、21 条由主线程实际操作。

真实侧栏机器证据 `/tmp/sideagent-session-ui-evidence/result.json` 为 5/5：A 运行时新建 B、B 不含 A marker、切回 A 后真实模型上下文保留、切换后草稿保留、关闭重开面板后仍选中 B 且恢复草稿。该证据与会话/附件/控制的聚焦测试共同支持第 2–4、12 条；第 19 条仍保留人评，因为该次证据没有覆盖关闭面板期间所有可见运行状态。

mode 摘要恢复已通过机器验证：`conversation_list` 恢复 default=teach、B=act 时不会被扩展空存储覆盖；显式修改 B 只更新 B；旧异步存储读取晚到也不能覆盖较新的 mode。对应测试位于 `extension/test/session-management.test.ts`。

`read_element` 静态与单测支持第 14a–14f：完整返回 260 字文本与 100 字字段值；上限 1,000,000 字符，超限明确失败且不返回部分内容；当前 AX/DOM ref 有代际检查；CSS missing/multiple/invalid、外会话与未共享均明确失败；固定 `Runtime.callFunctionOn` 或参数化 `querySelectorAll`，无 focus/scroll/事件/任意求值通路；ControlGate 把它列为只读，browser program 仍走既有顺序和取消检查。当时第 14g 尚待 build/reload 后的真实扩展跑道，最终结果见下文。

M3 曾在 `/tmp/sideagent-autonomy-evidence/attempt-m3-complete-tools-no-spawn.json` 中失败：页面两字段填写正确且未提交，但 `spawns=0`、`writers=[]`。随后连续两次真实正例通过：

- `/tmp/sideagent-autonomy-evidence/attempt-m3-first-pass-slow.json`：conversation `7498f8bb-3b27-4700-8c75-db45ac8936ea`，同一 tab `29955547`，2 次 spawn 均成功，`education` 与 `work` 分别执行 `page_operation` 并 verified；最终两字段有值，页面为“尚未提交”。
- `/tmp/sideagent-autonomy-evidence/result.json`：conversation `37ab2ace-43e3-4e77-ab9b-37cfab5b4f62`，耗时 59 秒。Lead 先用 `read_element body` 取得完整原始材料，在可见回复中说明工作/教育分工，再把对应完整材料交给 `work` 与 `edu` 两名 worker；两次 spawn 成功，两名 worker 在同一 tab `29955557` 各自 `page_operation` verified、`read_element` 完整读回并 post done。Lead 最终再次读取两字段；内容与 fixture 事实一致，未增加材料外数字，summary 为空，状态“尚未提交”。据此第 17 条通过。

单字段负例 `/tmp/sideagent-simple-evidence/result.json` 已通过：M3 conversation `b1248101-3c88-4050-970f-34cdca4f57d7`，耗时 8.2 秒，`spawns=0`、`writers=[]`，只填写 summary 为“擅长企业知识库与用户调研”，工作/教育为空且未提交。结合连续两次正例，第 7a 条通过。

早期 `/tmp/sideagent-shared-read-evidence/result.json` 未能支持第 14g：完整结果为 3/4、`ok:false`，两次 read 因测试使用已被 `stop_worker` 撤销登记的旧 worker id 而正确返回“未向当前成员共享”。该失败保留为归属边界证据，后续改用真实存活、已登记 worker 完成验收。

第一次存活 worker 补验只覆盖完整正文和 `page_operation`，未覆盖两个长字段及 fill/js，因此没有提前判定。最终 `/tmp/sideagent-shared-read-live-evidence/result.json` 已覆盖第 14g 全文并为 5/5、`ok:true`：M3 conversation `17147416-0ea6-4abb-b3c1-1395befb7a0d` 成功 spawn 存活 worker `reader`，共享 tab `29955618`；接管前 main/worker 分别通过生产 `page_operation` 写入两个超过 150 字的合成字段并 verified，随后逐字读回；页面接管后，main 与 worker 各自读取 `main` 完整正文、work 长值和 education 长值，共 6 次全部一致；两者分别尝试 fill、js、page_operation，共 6 次全部被拒；前后正文、两个长字段、summary、focus、scroll 和“尚未提交”完全一致。合成会话随后已 abort。第 14g 通过。

最终验证日志 `/tmp/sideagent-session-final-verification.log`：`npm run typecheck` 通过；`npm test` 为 61 files / 550 tests 全绿；`npm run build` 与 reload exit 0。第 14 条通过。

## 边界与不做

- 本轮不实现会话 A/B 的材料、对话或任务合并为 C。
- 不实现跨顶层会话共享同一个标签或同一份未保存 DOM。
- 不承诺两个标签对同一服务端自动保存对象的业务冲突隔离。
- 不为纯聊天会话预先创建空白标签组；会话首次需要页面时再创建。
- 不用标签组颜色、多个光标、前端缓存或 mock UI 代替运行时身份、页归属和真实动作证据。
- 不要求任意网站支持字段级并发；通用保证是同一页面上的完整短动作串行。

## 原生回放耗时补充回归（2026-09-08，编排先锁定）

观察：同一任务首次真实 UI 显示 59s，重开原生侧栏后显示 1.4s。后者是历史回放处理时间，不能当成任务耗时。该问题由编排发现；以下标准在委派修复前给出，实现者不得放宽。

- [x] 23. 同一段历史在任意回放速度下，都不能把重播墙钟时间显示为任务耗时。有可靠原始时间则恢复原时长；旧记录没有可靠时间时不显示伪耗时。— 谁检查: 聚焦历史回放测试 + 原生侧栏截图（2026-09-08）
- [x] 24. 当前运行仍实时计时；A/B 切换不互相继承计时起点。— 谁检查: 聚焦测试 + 既有会话回放用例（2026-09-08）

真实证据 `/tmp/sideagent-history-timing-evidence/result.json`：M3 conversation `795c5b74-9970-4da4-b1c8-3ec69e7b1acf` 首次实时显示“耗时 1.9s”，关闭重开后仍为“耗时 1.9s”；旧 conversation `37ab2ace-43e3-4e77-ab9b-37cfab5b4f62` 没有可靠 `occurredAt`，回放 `.run-time` 为空，没有显示伪造耗时。截图：同目录 `timestamped-replay.png`、`legacy-no-invented-time.png`。聚焦 `history-timing/panel-history/session-management/steps` 为 4 files / 41 tests 全绿。
