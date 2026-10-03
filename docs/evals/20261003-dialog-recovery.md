# 任务：原生弹窗不拖住输入工具，批准处理后网页恢复

## 完成标准

新版共 9 个场景，证据标记 `suiteVersion: dialog-recovery-9-case-v3`、`expectedCases: 9`。
旧版 6/8 场景证据不证明新增边界通过。

检查者：主代理独占运行 `npx tsx scripts/acceptance/dialog-recovery.mts --headless`。
脚本把当前源码构建到临时目录，动态加载隔离启动器。不读取旧 dist 作为候选实现。
构建限时 120 秒；`build.log` 保留构建输出。日常 `extension/dist` 全目录哈希须保持不变。

- [x] 拒绝 click：网页零打开事件、零完成事件，弹窗为空。
- [x] 批准 click 触发 confirm：原生事件后 1000 毫秒内收到成功与弹窗信息；网页仍等待。批准取消后结果为 false，后续 fill 生效。
- [x] 批准 click 触发 prompt：及时返回，类型、消息和默认值正确。批准填入精确文本后网页得到同一文本，后续 fill 生效。
- [x] 批准 double_click：原生 confirm 及时返回，取消后网页恢复，后续 fill 生效。
- [x] 批准 press_key ArrowDown：原生 prompt 及时返回，填写后网页恢复，后续 fill 生效。不用受限 Enter/Space。恢复后观察 1 秒，服务器 key-keyup 计数仍为零。
- [x] 拒绝 dismiss_dialog：工具返回 not_executed，弹窗仍打开，网页未完成；随后新的“允许一次”才能恢复。

- [x] mousedown 打开 confirm 中断 double_click：返回 doubleClicked:false 与正确弹窗。批准取消并 fill 后观察 1 秒；只有一次 mousedown，零 onclick，无迟发释放或第二次点击。
- [x] confirm A 关闭后立即 prompt B：dialog_info 必须保留 B。B 使用新的、精确匹配的批准卡；A 的批准不能完成 B。最终网页记录 A=true、B=精确文本，全链只完成一次，并可 fill。

- [x] 普通 press_key a：先批准 fill 空输入框，按键后实际值为 a。字母 keyup 恰一次，input 恰一次；ArrowDown keyup 仍为零。heldKeys 账本是否为空须独立探针证明，当前未暴露，记录 NOT_RUN，不从网页 keyup 推定。

每个动作都通过真实扩展 sidepanel.html 的“允许一次”或“拒绝”。
触发次数、完成次数来自 fixture HTTP 服务器；最终结果和值来自网页。
每个触发只打开一次、只完成一次。每次恢复后的 fill 只产生一次 input 事件。
工具必须先回传弹窗状态，再处理弹窗；不能用关闭弹窗来解开等待并算通过。

## 边界与不做

- 复用隔离启动器及生产 onMessage → executor 钩子。保留真实执行、授权和 CDP 输入路径。
- 不接模型或供应商，不证明公开 SDK 的整链路。脚本中的 `dialog_status` 是真实 `dialog_info` RPC 的证据字段。处理弹窗使用真实 `accept_dialog`/`dismiss_dialog`。
- 不绕过逐次确认，不直接调用 Page.handleJavaScriptDialog，不注入脚本代替工具输入。
- fixture 页面脚本定义按钮及 ArrowDown 事件，正常浏览器输入触发真正的 confirm/prompt。
- DOM fallback 未纳入：尚无真实、可控、保持授权边界的触发依据。不能伪造调试器错误或钩子结果来冒充验收。
- 不连接用户 ChromeMain，不创建可见窗口。只启动隔离无头 Chrome for Testing。

## 证据与失败记录

输出目录：`out/dialog-recovery/<UTC时间>/`。每轮保留独立证据。
成功写 `result.json` 与侧栏截图。失败写 `failure.json` 与尽力取得的截图。
失败记录保留用例、完整参数、侧栏决定、工具返回、网页状态和服务端事件计数。
原生弹窗可能阻塞网页状态读取；读取有 2 秒超时，超时作为证据，不标记通过。
批准后工具总返回等待上限 15 秒；afterDecisionMs 单列记录，不冒充原生弹窗延迟。
含 dialog 的 click/double_click/press_key 回执记录 SW 实际 returnedAt，
再通过 consume_events(clear:false) 找本次最新匹配原生 dialog 的 at；returnedAt-at 须小于 1000 毫秒。
工具返回轮询上限 15 秒，批准前等侧栏上限 8 秒。隔离启动与清理沿用启动器的固定期限。
`cleanup.json` 单独记录隔离资源释放结果。清理失败不能作为整体通过。
`daily-dist.json` 保留日常构建目录前后哈希。最终 result 在清理和哈希核对之后写入。

## 当前记录

2026-10-03：主代理第三轮执行已完成前五个场景。
证据：`out/dialog-recovery/2026-10-03T04-51-11-655Z/failure.json`。
失败发生在 `press_key-key-recover` 的准备 click `#after`；工具返回等待超时。
此时没有键盘弹窗，前三次恢复 fill 的 input 事件累计为 3，日常 dist 未变。
这次失败不能证明键盘弹窗恢复失败，也不能算第六个场景通过。

修订依据：前一场景已经真实 fill `#after`。删除多余准备点击，改为只读核对
`document.activeElement.id === "after"`。保留原失败，不给非弹窗准备点击新增 6 秒性能门槛。

审批校验已加强：必须只有一个可操作 pending 卡；请求 ID、任务、runId、activation用途、
工具动作及 pre 中完整 JSON 参数都匹配本次调用。每张卡只决定一次。
未知或不匹配卡逐张拒绝，并让验收失败。日志保存 requestId 与完整 details。

修订后的脚本只完成静态 lint，尚未重新执行浏览器。生产修复及独占执行由主代理负责。
首次 `gh issue view 23` 读取失败：GraphQL EOF；未据此声称已经核对 issue 原文。
这是失败验收的准备记录，不是产品通过结论。

## 新增边界的修订依据

主代理只读审查发现：modal 中断后迟发释放可能继续触发页面输入；未完整双击不能冒充完成；
处理旧弹窗 A 后不能清除刚打开的 B。新增场景均使用真实网页事件和独立服务器计数。

键盘 keyup 断言附加到原第六场景。另加 mousedown 中断和连续弹窗两个独立场景。
新场景使用 boundaryState，不改原六场景的 dialog 状态 oracle；只按批准 fill 增加 input 计数。
1 秒无迟发事件只是该观察窗内的证据，不扩展为任意时长保证。

新版只完成静态 lint，尚未运行浏览器或构建。父代理正在运行的旧版六场景保留为旧版证据。

## 9 场景测量修订依据

8 场景首轮失败保留于 `out/dialog-recovery/2026-10-03T04-57-29-118Z/failure.json`。
首 confirm-opened 已为 1，dialog_info 已读到真实 confirm，但批准后等待 6 秒超时。
主代理提供的旧 6 场景触发总耗时为约 5.2/5.7/5.8 秒。旧计时包括逐次批准核对，
不能单凭该超时判定原生弹窗事件之后工具仍挂起。

因此拆开两个测量：批准后的总等待上限为 15 秒，显著小于原 30 秒工具超时；
原生 dialog 事件到实际回执的延迟须小于 1000 毫秒。事件来自真实 consume_events 缓存，
回执时间在 SW 收到 tool_result 时记录，不用轮询完成时间替代。
只对含 dialog 的输入触发测量该延迟。处理弹窗仍必须晚于成功触发回执。
拒绝边界、网页恢复、精确参数和事件次数标准均保留，没有改变业务目标。

新增第九场景检查普通字母按键仍会释放。原 oracle 仅增加 seed fill 和字母 input 两次事件；
字符终值单列。共享 hook 未暴露 heldInputs，账本为空目前不能实测，明确保留 NOT_RUN。
9 场景版本只完成静态 lint，尚未运行构建或浏览器，不声称 PASS。

## 最终核心路径结果

`out/dialog-recovery/2026-10-03T05-06-20-769Z/result.json`：suiteVersion `dialog-recovery-9-case-v3`，9 PASS。真实侧栏逐次决定，拒绝零执行；点击confirm取消、prompt原文、双击、按键、mousedown中断、连续confirm→prompt独立批准、普通字母输入全部通过。六次原生弹窗事件到执行器回执均在同一毫秒刻度，判据小于1000ms；批准到工具返回的准备耗时单列，不能当用户端/模型耗时。

上一轮v3 `2026-10-03T05-03-55-246Z` 前8场景通过，普通字符keyup发生但没有插入a。原press_key把带text的字符发成rawKeyDown；真实失败后改用keyDown，普通控制键仍rawKeyDown。复测a写入、input一次、keyup一次通过。参考[官方CDP定义](https://raw.githubusercontent.com/ChromeDevTools/devtools-protocol/master/pdl/domains/Input.pdl)。

独立只读复核提出中断后迟发release、错误buttons、动作发生假报、清掉下一弹窗，以及自身DOM变化阻断release五类风险。当前序列在每次派发前同步检查中断；release用afterEffect文档/取消守卫，不重比已被自己改变的原DOM指纹。后台仍记录未释放输入供既有停止清理。实际派发计数决定真假回执，mouseup排除当前button，A收尾仅清A。新增边界场景验证没有迟发keyup/click，B保持待处理。未暴露held账本探针的项目明确NOT_RUN，不据网页事件推测内部状态。

最终工程：3057单元+2规模通过；类型、模块边界通过。先前单元失败及修复见[时间框记录](20261003-time-input.md)。源码变更已逐段读差异，生产增长集中于输入序列守卫与原生弹窗批准，没有新增依赖/全局配置。

仍待处理：DOM回退弹窗专门路径、日常模型与部署。当前9场景不代表这些已通过；#23保持打开，下一步复现并修DOM回退。

## 部署与备用路径核对

已加载日常，实际运行源码与已验收候选一致，数据与设置保留，见[部署](20261003-issue-fixes-deployment.md)。9 场景检查只证明原生主路径，当前模型日常任务未重新调用。DOM 回退是 input.ts 单击尚未派发时转 dom.click()，不是另一套 DOM 弹窗处理器；本轮没有改该分支。现有 B1/B3 单元仅证明普通按钮不重复，不能替代回退后原生弹窗恢复证据。该既有缺口后续另测，不为无法证明可达的分支扩大本轮实现。
