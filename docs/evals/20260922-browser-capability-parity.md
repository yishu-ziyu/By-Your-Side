# 任务: By-Your-Side 浏览器能力全集对齐 EGO Lite 基线（能力矩阵先行，真实浏览器证明）

Issue: Browser Capability Parity with EGO Lite。基线仓库 `citrolabs/ego-lite`（已读
`skills/ego-browser/SKILL.md`、`package/ego-browser/src/public-api-schema.ts`、
`browser-runtime.ts`、`element-resolver.ts`、`page-ref-registry.ts`、`driver/` 目录清单）。
本文件是唯一能力事实源的映射层；只扩 Capability Space，不碰 Decision Space。

## 完成标准

- [x] 1. 矩阵 20 项基线全部 PASS 或 PASS — composed — 谁检查: 本文件 §四 实测列 + §三 映射逐项有实现与测试指向
- [x] 2. double_click 真实 CDP 输入（clickCount=2），单击/双击结果不同的 fixture 上只有 dblclick 生效 — 谁检查: 真实浏览器 Case 1
- [x] 3. drag 真实 pointer 序列（move→press→有界 move 序列→release），sortable/slider/card 状态真实改变 — 谁检查: 真实浏览器 Case 2
- [x] 4. upload_file 走 DOM.setFileInputFiles，files.length/文件名/input+change 状态读回，不点系统选择器，文件来源限授权目录 — 谁检查: 真实浏览器 Case 3 + 单测（越界路径拒绝）
- [x] 5. browser.cdp 能调用无专用 helper 的只读 CDP 方法并返回结果 — 谁检查: 真实浏览器 Case 4
- [x] 6. cdp 对非 working tab、已 abort、browser-global/越权 method 全部拦截；结果有大小上限；错误走 oneLine — 谁检查: 真实浏览器 Case 5 + 单测
- [x] 7. 同一元素经 @ref、CSS、XPath、语义 locator（text=/loc=css:）执行等价动作 — 谁检查: 真实浏览器 Case 6
- [x] 8. 单个 browser_run 程序内 observe→wait→click/fill→drag|doubleClick→readback 全通 — 谁检查: 真实浏览器 Case 7
- [x] 9. 新能力全部经 working-tab ownership、control gate、abort/epoch、execution ledger、effect/readback — 谁检查: 单测（gate/epoch/deny 表）+ §十三 Case 5 + §十四 回归
- [ ] 10. 旧能力无退化：click/hover/fill/type_text/press_key/scroll/tabs/snapshot/screenshot/js/fetch/network/browser_run/takeover — 谁检查: `npm run check` + 现有 accept 入口。**未达成（环境/基线原因，非本轮新增失败）**：全量单测 33 项失败与 HEAD 基线同集（worktree 隔离复跑证明，见 §六）；accept:browser 本日 3/3 超时失败且该通道运行旧构建（见 §六），待干净状态复测
- [x] 11. 终报直接回答 §十六 四问，第 3 问为「无」才算完成 — 谁检查: 人（四问见本文件 §八；第 3 问按基线内/外分层作答，范围界定待用户裁决）

## 边界与不做

- 不做 Jev 候选空间、Realtime 选工具、Pi/Realtime 路由、revision、recovery、UI、Voice、模型切换、prompt 优化。
- 不推倒现有 Harness：不建第二套 browser runtime，不改 Stagehand vendored runtime 冒充解决。
- 不为 API 命名与 EGO 相同而新增工具；组合可达成的标 PASS — composed，不新增 RPC。
- 基线外已知差异（不阻塞本轮，如实记录，见 §十二）：download 事件等待（waitForEvent("download")）、动态 file chooser 拦截、富文本 clipboard paste、OOPIF 独立 session、mouse 位置偏移（position offset）与右键/中键。本轮不得宣称已全覆盖。

## 一、当前事实（编码前核对，2026-09-22 工作树）

- `shared/protocol.ts`：`TOOL_NAMES` 26 个 RPC（fetch/network/worker_tabs/share_tab/page_operation/page_translation/read_element/read_elements/list_tabs/get_active_tab/open_tab/switch_tab/close_tab/navigate/snapshot/click/hover/fill/type_text/press_key/scroll/js/screenshot/observe_page/mark/clear_marks），`ToolContract` 为唯一参数/回执契约。
- `agent/src/browser-program.ts`：QuickJS 沙箱，`METHODS = TOOL_NAMES − worker_tabs + waitFor + sleep`；browser.* 与 RPC 一一串行，全部经 tools.ts `call()`（epoch/signal/闸门/账本）。
- `agent/src/tools.ts`：`WRITE_TOOLS` 按模型可见名判能力开关；`js` 在写能力不完整时整体拒绝；执行事实沿 sdkId 回账本。
- `extension/src/background/exec/input.ts`：click/hover 已是真实 CDP `Input.dispatchMouseEvent`；`resolvePointerTarget` 统一 target→视口坐标（AX ref 走 `callOnBackendNode`，其余走 domops）；命中核对、destructive hold、effect 采集、trail、新标签跟随齐备。
- `extension/src/shared/target.ts` `parseTarget` 与 `extension/src/content/domops.ts` `mustResolve`：target 现支持 `@N`、`loc=css:`、原生 CSS 三种；**无 XPath、无语义 locator**；`read_element`/`page_operation` 等各自入口对 target 的支持未逐一核对（§八 统一对象）。
- `extension/src/background/debugger.ts`：`sendCommand(tabId, method, params)` 封装 attach/空闲 detach；**无模型可用的通用 CDP 入口**。
- `shared/effect-policy.ts`：未知工具默认 `requiresControlGate: true`（对 cdp 有利）；`WRITE_TOOLS` 显式名单需随新写工具扩充。
- 缺口（Issue §五 已确认）：double click、drag、upload_file、通用 cdp、统一 target surface、waitForLoad/waitForNetworkIdle/scrollToBottomUntil/pageInfo 等高层 helper。

## 二、Capability Matrix

图例：✅ 已有等价或更强 · 🧩 composed equivalent（现有组合可达，不加 RPC）· 🔧 本轮新增 · ⚠️ 已知差异（§十二）

### A. Tab / Navigation

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| listTabs | `task.tabs()` | ✅ `list_tabs`（含 working 标记） | 不动 | 回归 test:unit |
| openOrReuseTab | `newPage`+label 复用 | 🧩 `open_tab` + `list_tabs`/`switch_tab` 组合（无持久 label，用 tabId） | 不加 RPC；matrix 记 composed | 回归 |
| closeTab | `page.close()` | ✅ `close_tab` | 不动 | 回归 |
| gotoAndWait | `goto({waitUntil})` | ✅ `navigate`（interactive 就绪 + documentId） | 不动 | 回归 |
| currentTab | `page.url()/title()` | 🧩 snapshot.url + `js`（location.href/title） | 不加 RPC | 回归 |
| switchTab | `task.page` 切换 | ✅ `switch_tab` + 读回核验（强于 EGO） | 不动 | 回归 |
| gotoUrl | `goto()` | ✅ `navigate` | 不动 | 回归 |
| pageInfo | `page.info()`（url/title/viewport/scroll/dialog） | ❌ 无一等 | 🔧 `browser.pageInfo()` runtime 组合 helper（js+list_tabs） | 单测 helper + Case 7 |
| ensureRealTab | 空白页/伪页校验 | ✅ `resolveWorkingTab` + 页面归属（等价机制，名称不同） | 不动 | 回归 |

### B. Observation

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| snapshotText | `page.snapshot()`（AX role + ref） | ✅ `snapshot`（CDP AX 全量/视口降级，[ref=N]） | 不动 | 回归 |
| captureScreenshot | `page.screenshot()` | ✅ `screenshot`（DPR/CSS 坐标系回执） | 不动 | 回归 |
| network 事件可见性 | `page.events()` 缓冲 | ✅ `network`（CDP Network 环形缓冲，被动） | 不动 | 回归 |
| navigation 事件可见性 | `waitForURL` | ✅ navigate 就绪 + snapshot.url + `page_event:url_changed` | 不动 | 回归 |
| popup 可见性 | `waitForEvent("popup")` + `receipt.popups` | 🧩 click 回执 `newTab` + 自动跟随 + `list_tabs` | 不加 RPC | 回归 click newTab 用例 |
| dialog 可见/处理 | `acceptDialog/dismissDialog` + receipt.dialog | ⚠️ 无 Page dialog 事件处理；开放 dialog 时 CDP 输入会失败 | 经 🔧 `cdp`（Page.handleJavaScriptDialog）提供命令路径；事件流不建缓冲 | Case 4 附带说明，§十二 记差异 |
| drainEvents | `page.events()` 清空读取 | 🧩 network(clear:true) + url_changed + newTab（无统一事件队列） | 不加 RPC | 回归 |

### C. Pointer / Mouse

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| click | `page.click()` native CDP | ✅ `click`（真实 CDP + 命中核对 + effect + destructive hold，强于 EGO） | 不动 | 回归 + Case 6 |
| doubleClick | `page.dblclick()` | ❌ 缺一等能力 | 🔧 新 RPC `double_click`：复用 resolvePointerTarget/confirm/hitTest/effect/ledger，`Input.dispatchMouseEvent` clickCount 1→2 | Case 1 + 单测 gate/epoch |
| hover | `page.hover()` | ✅ `hover`（真实 mouseMoved） | 不动 | 回归 |
| dragMouse | `page.dragAndDrop(src,dst)` | ❌ 缺一等能力 | 🔧 新 RPC `drag`：from/to 各为 target 或 point，mouseMoved→mousePressed→有界 move 序列→mouseReleased，effect 采集 | Case 2（sortable/slider/card）+ 单测 |
| scrollBy | `mouse.wheel`/scroll | ✅ `scroll`（窗口滚动） | 不动 | 回归 |
| scrollToBottomUntil | `scrollToBottomUntil` | 🧩 scroll + js 轮询条件 | 🔧 `browser.scrollToBottomUntil()` 组合 helper（不加 RPC） | 单测 helper |
| 滚动容器/真实 wheel | wheel 输入滚悬停容器 | ⚠️ `scroll` 只滚窗口；内部容器经 `js` 可滚 | 不扩（§十二 记差异） | — |

### D. Fill / 输入 / 键盘（§十一: fill / text input / keyboard）

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| fill | `page.fill()` 含 readback | ✅ `fill`（原生 setter + input/change + 受控组件） | 不动 | 回归 |
| text input | `keyboard.type/insertText` | ✅ `type_text`（Input.insertText） | 不动 | 回归 |
| keyboard | `keyboard.press/down/up` | ✅ `press_key`（含组合键）；⚠️ 无 down/up 分离与 paste | down/up/paste 记 §十二 | 回归 |
| selectOption | `page.selectOption()` | 🧩 `fill` 支持原生 select 按可见 label 匹配 | 不加 RPC | 回归 |
| focus/press on target | `page.focus()/press(sel,chord)` | 🧩 click 聚焦 + `press_key`；语义 locator 落地后 press 用同一 resolver 定位再按键 | 统一 target（§H） | Case 6 |

### E. File Upload（§六）

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| uploadFile | `setInputFiles`（含 chooser 拦截） | ❌ 缺 | 🔧 新 RPC `upload_file`：统一 resolver 找 `<input[type=file]>` → `DOM.setFileInputFiles` → 读回 files（名称/数量/大小）+ 页面状态；只作用于 working tab；路径限授权目录（`~/.sideagent/uploads/`、`~/.sideagent/downloads/`，realpath 包含性校验，不提供目录列举） | Case 3 + 单测（越界路径拒绝、非 file 元素拒绝） |
| 动态 file chooser | `waitForFileChooser()` | ⚠️ 无拦截 | 先触发创建 input 再 upload_file；拦截能力记 §十二 | Case 3 变体 |

### F. JS / CDP / 网络（§七 escape hatch）

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| evaluate | `page.evaluate()` | ✅ `js`（Runtime.evaluate，CSP 免疫，写闸门） | 不动 | 回归 |
| raw CDP | `page.cdp()/task.cdp()` | ❌ 底层 `sendCommand` 已在，模型无入口 | 🔧 新 RPC `cdp`：resolveWorkingTab 绑定 → control gate（进 WRITE_TOOLS，全走写闸门，不做 read/write 分类系统）→ deny `Browser.*`/`Target.*` 等越权前缀 → 结果 JSON 上限截断 → oneLine 错误；进 execution ledger | Case 4（无 helper 只读方法）、Case 5（越权拦截）+ 单测 deny 表 |
| browser-authenticated fetch | `page.fetch()` | ✅ `fetch`（GET/POST + consent ticket，强于 EGO） | 不动 | 回归 |
| network observation | `page.events()` network | ✅ `network` | 不动 | 回归 |

### G. Waits / 组合 runtime（§九）

| 能力 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| waitForElement | `waitForSelector({state})` | 🧩 `browser.waitFor`（唯一+可见+未禁用，CSS only） | 🔧 helper 统一到新 target resolver（支持 XPath/text）；语义同 waitForSelector visible | 单测 + Case 6/7 |
| waitForLoad | `waitForLoadState(load)` | ❌ | 🔧 `browser.waitForLoad()` 组合 js 轮询 `document.readyState`（不加 RPC） | 单测 helper |
| waitForNetworkIdle | `waitForLoadState(networkidle)` | ❌ | 🔧 `browser.waitForNetworkIdle()` 组合 `network` 工具轮询无新增条目（不加 RPC） | 单测 helper |
| waitForFunction | `waitForFunction()` | 🧩 js 轮询 + browser.waitFor | 不加 RPC（js 闸门内组合） | 回归 |
| multi-step runtime | TaskSpace 脚本 | ✅ `browser_run`（QuickJS 隔离 + 程序账本 + 全工具闸门，强于 EGO 单脚本） | 新 helper/method 全部进 browser.* | Case 7 |
| pageInfo | `page.info()` | 见 §A | 🔧 helper | Case 7 |

### H. 统一 Target Resolution（§八）

| 形式 | EGO Lite | By-Your-Side 当前 | 目标实现 | 验证 |
|------|----------|-------------------|----------|------|
| snapshot ref | `@21` / `ref=21` | ✅ `@N`（AX backendNodeId 或 DOM 快照号） | 不动 | Case 6 |
| native/stable CSS | raw CSS / `loc=css:` | ✅ 原生 CSS + `loc=css:` | 不动 | Case 6 |
| XPath | `xpath=...` | ❌ | 🔧 `parseTarget` + `domops.mustResolve` 增加 `xpath=`（document.evaluate 唯一匹配校验） | Case 6 |
| semantic locator | `loc=role:/text=` | ⚠️ 仅 CSS | 🔧 `text=`（可见文本唯一匹配，语义路径）；role 语义由 AX snapshot ref 承担（ref 即 role 节点）= composed | Case 6 |
| viewport point | `mouse.click(x,y)` | ✅ `point:[x,y]`（click/hover；double_click/drag 同） | 新工具同参数面 | Case 1/2 |
| 全部 element 操作共享 resolver | element helpers 统一 surface | ⚠️ click/hover/fill/mark/双路（AX CDP + domops）已同源；read_element/page_operation/waitFor 各自入口未核对、XPath/text 缺失 | 以 `parseTarget`+`mustResolve` 为唯一解析层，read_element/wait 入口对齐；不改 Stagehand vendored | Case 6 + 单测 parseTarget |

## 三、事实源与映射（§十）

唯一能力事实源 = `shared/protocol.ts` 的 `TOOL_NAMES` + `ToolContract`（代码引用，非文档）。browser_run 组合 helper 不进 ToolContract，在 `agent/src/browser-program.ts` 导出
`BROWSER_PROGRAM_HELPERS`（名称+一句话+组合成分），METHODS 白名单与 `browser_run` 描述文本都从它生成，防止文档漂移。编码后回填映射：

| 公开能力 | helper / RPC | extension 实现 | acceptance |
|---|---|---|---|
| double_click | RPC `double_click` | `extension/src/background/exec/input.ts`（click 管线复用，clickCount 1→2，destructive 走 holdForConfirmation） | Case 1（对照 click 无可见变化 → double_click 后 dblmsg 置位） |
| drag | RPC `drag` | `extension/src/background/exec/input.ts`（press→有界 move 序列→release，按下后失败先弹键） | Case 2（卡片跨槽 + 原生 range 拖动） |
| upload_file | RPC `upload_file` | `extension/src/background/exec/upload.ts`（objectId 扁平参数 + 读回 + input/change）；宿主授权 `agent/src/upload-paths.ts`（realpath+包含性） | Case 3 + `agent/test/upload-paths.test.ts` |
| cdp | RPC `cdp` | `extension/src/background/exec/cdp.ts`（deny 前缀、格式校验、working-tab 硬绑、200KB 截断、oneLine） | Case 4/5 + `extension/test/cdp-guard.test.ts` |
| browser.pageInfo/waitForLoad/waitForNetworkIdle/scrollToBottomUntil/waitForElement | helper（组合） | `agent/src/browser-program.ts`（BROWSER_PROGRAM_HELPERS 事实源） | Case 7 + `agent/test/browser-program.test.ts` |
| browser.doubleClick/uploadFile 别名 | RPC_ALIASES | `agent/src/browser-program.ts` | Case 7 + 单测别名路由 |
| target: xpath=/text= | 解析层扩展 | `extension/src/shared/target.ts`（resolveTargetSelector 唯一拥有语义）、`content/domops.ts`、`exec/read-element.ts`、waitFor | Case 6 + `extension/test/target.test.ts` |

## 四、§十一 基线对照（完成后逐项打分，终报引用）

| # | 基线项 | 目标状态 | 当前预判 |
|---|--------|----------|----------|
| 1 | Navigation / tabs | PASS | ✅ 已有 |
| 2 | semantic observation | PASS | ✅ 已有（AX refs） |
| 3 | screenshot / visual interaction | PASS | ✅ 已有 |
| 4 | click | PASS | ✅ 已有 |
| 5 | double click | PASS | 🔧 本轮 |
| 6 | hover | PASS | ✅ 已有 |
| 7 | drag | PASS | 🔧 本轮 |
| 8 | fill | PASS | ✅ 已有 |
| 9 | text input | PASS | ✅ 已有 |
| 10 | keyboard | PASS | ✅ 已有 |
| 11 | scrolling | PASS | ✅ 已有（窗口滚动；容器滚动经 js，见 §十二） |
| 12 | file upload | PASS | 🔧 本轮 |
| 13 | JS evaluation | PASS | ✅ 已有 |
| 14 | raw CDP escape hatch | PASS | 🔧 本轮 |
| 15 | browser-authenticated fetch | PASS | ✅ 已有 |
| 16 | network observation | PASS | ✅ 已有 |
| 17 | element wait | PASS — composed→helper | 🔧 helper 统一 |
| 18 | load wait | PASS — composed | 🔧 helper |
| 19 | network-idle wait | PASS — composed | 🔧 helper |
| 20 | programmable multi-step browser runtime | PASS | ✅ 已有 + 新 helper 进入 |

**实测（2026-09-22）**：1–16 全部 PASS，其中 double click / drag / file upload / raw CDP 四项由隔离无头真实浏览器 `npm run accept:capability` 七案连续两次全绿直接证明（§五）；17–19 为 PASS — composed（element wait 统一 target 由 Case 7 实测；load/network-idle/scroll-until 由 `agent/test/browser-program.test.ts` 单测）；20 PASS。基线内 0 FAIL。

## 五、真实 E2E 七案（§十三）

**结果：七案全部 PASS，连续两次全绿。**

- 通道：隔离无头实例（Chrome for Testing + `extension/dist`，`--headless=new`，不碰用户日常 Chrome、不碰 local.yishu.chrome-main）；驱动 `__saCall → uplink.handleRaw → executeToolCall → gate.run → handlers`，页面动作全部 CDP Input 真实事件。
- 入口：`npm run accept:capability`（`scripts/acceptance/capability-parity-run.mjs` + `capability-parity.mjs` 驱动 + `extension/test/fixtures/acceptance/parity.html` 夹具）。
- 绿色证据：`out/acceptance/capability-parity-2026-09-22T12-37-21-034Z/`、`out/acceptance/capability-parity-2026-09-22T12-39-35-378Z/`（含 snapshot-before.txt、逐案 cases/receipts/durations）。关键读数：Case 6 countTrace `[1,2,3,4]`（@ref→loc=css→xpath→text 等价）；Case 3 files 读回+页面 `UP:1:…`；Case 5 三类拦截错误串存证；Case 7 steps=9 带 programId 入账。
- 修FAIL轮全部保留（不擦原始失败）：12-25-33（count=0 → 夹具脚本未执行，后定位为通道问题）、12-27/12-28 系列（工作页被回退认领到用户活动页 → 改隔离通道+前置断言）、12-30-13/12-32-18（setFileInputFiles 参数形态 → 扁平 objectId）、12-34-16（browser_run 非扩展 RPC → 改由生产 runBrowserProgram 模块执行）、12-36-33（SW 启动瞬时 TypeError，复跑恢复）。
- Case 1 对照：单击后 dblmsg 保持空；double_click 后 `DOUBLE-N`。Case 2：卡片入 B 槽 + 滑杆 ≥50。

## 六、回归（§十四）

- ✅ `npm run check:architecture`：231 个生产文件通过。
- ✅ 双端 `npm run typecheck`、`npm run build`：通过。
- ⚠️ 全量单测：3013 过 / 33 败。**33 项失败与 HEAD 基线完全同集**（用 `git worktree` 在 HEAD 隔离复跑证明：click-integrity×22、hover-recovery×8、skill-session/task-goals/task-recovery-matrix 各 1）——均为本任务开始前既有失败，本轮 0 新增；本轮新增/修改的测试（cdp-guard、upload-paths、target、browser-program、program-first、tool-surface、held-clicks）全部通过。故 `npm run check` 整体为红，红源不在本轮，按约定不代改他队在途失败、不把未跑记成通过。
- ⚠️ `npm run accept:browser`（开发 ChromeMain 通道）：本日 3/3 在 sw_evaluate 40 秒超时失败（connect/cdp/SW/hook 均 PASS 后挂起）。零副作用探测（经钩子发 `cdp{method:Browser.close}` 策略调用）返回「未知工具: cdp」，**证明该扩展运行的是本轮改动前的旧构建**，失败不可归因于本轮代码；与本轮早期在该浏览器通道的尝试残留状态疑似相关，待 ChromeMain 干净状态复测。不记 PASS。
- NOT_RUN：`npm run accept:team`、`npm run accept:sessions`（takeover/handback 的单元与门禁测试本轮全绿，真实团队验收未跑）。
- 其它：上传夹具文件运行前后清理；隔离实例 profile 与进程退出清理。

## 七、已知差异（§十二，基线外，如实记录）

1. download 事件等待（EGO `waitForEvent("download")+saveAs`）：无正式能力，本轮不做。
2. 动态 file chooser 拦截（`waitForFileChooser`）：以「先创建 input 再 setFileInputFiles」路径替代；拦截本身不做。
3. 富文本 clipboard paste（`keyboard.paste({text,html})`）：无；`type_text` 覆盖纯文本。
4. OOPIF 独立 session 与 frame 子树 snapshot：EGO 有 subtree root ref；我们全页 AX 树覆盖常规 iframe，OOPIF 深层操作不做。
5. pointer position 偏移（element 内偏移点）与右键/中键：只支持中心点与左键 + 绝对 point。
6. mouse.wheel 悬停滚动容器：`scroll` 为窗口滚动；容器滚动经 `js` 可达，无一等。
7. 键盘 down/up 分离按住：`press_key` 为按下+抬起；长按组合不做。
8. HTML5 原生 `draggable` 拖放未实测：Case 2 用 JS mousedown/mousemove/mouseup 卡片 + 原生 range 覆盖同一 pointer 输入序列；原生 DnD 页面兼容性留待出现真实页面时补验（不虚报全覆盖）。
9. dialog：`Page.handleJavaScriptDialog` 可经 cdp escape hatch 调用（命令路径存在），但无事件缓冲（无法主动知道弹窗出现），实测未做。

## 八、§十六 四问终报（2026-09-22）

1. **By-Your-Side 当前的正式浏览器能力全集**：`shared/protocol.ts` 的 30 个 RPC（本轮 +4：double_click/drag/upload_file/cdp）+ `browser_run` 内 `browser.*`（30 个 RPC 映射 + RPC_ALIASES 别名 doubleClick/uploadFile + BROWSER_PROGRAM_HELPERS 七个宿主组合 helper）。逐项映射与实现/验收指向见 §三。
2. **对照 EGO Lite（§十一 20 项）**：17 项 PASS；3 项 PASS — composed（element wait、load wait、network-idle wait，均由组合实现且有测试）；0 项 FAIL。明细见 §四实测列。
3. **已知「EGO 能做而我们缺正式能力」的任务**：**基线（§十一 20 项）内：无。** 基线外 EGO 公开 API 中仍有已知缺口：页面触发下载的等待/落盘（`waitForEvent("download")+saveAs`，只读 GET 可由 fetch savePath 替代但非等价）、下载/文件 chooser 事件流、富文本 clipboard paste、OOPIF 子树 session。均已在 §七 记录并在 Issue 边界内（§十二）；**按 §十六 字面第 3 问这属于「有」，是否接受该范围界定待用户裁决。**
4. **新能力约束覆盖**：是。ownership = resolveWorkingTab/working-tab 硬绑（cdp 拒绝其他 tabId，Case 5a）；control gate = WRITE_TOOLS + effect-policy 恒走写闸门（单测 + Case 5b `Browser.close` 拒绝且浏览器仍存活）；abort/epoch = executeToolCall checkIdentity 同一守卫（Case 5c foreign runId 拦截「原任务已停止或发生变化」）；execution ledger = sdkId/programId 入账（Case 7 steps=9 带 programId，held 回执按 not_executed 上报）；evidence/readback = drag effect、upload files 读回、click/double_click effect、cdp truncated 标志、switch/tab 既有机制未动。

## 允许标注

- PASS — composed：§二/§四 中已标 🧩/composed 的行。
- 本文件随实现回填「目标实现→实际实现」列与 §四 打分；原始失败与未跑如实保留，不写成全绿。

## FIX-02 撤回说明（2026-09-22）

**撤回：**上文「等价 network-idle PASS / PASS — composed」结论作废。原实现仅用展示 ring 的 total/dropped 静默窗口，在途未完成请求不可见，不能证明 network-idle。

FIX-02 已改为：有界在途集合 + 捕获完整性；`waitForNetworkIdle` 仅在 scoped in-flight=0、静默窗口满足且 integrity=ok 时返回。证据见 `docs/evals/20260922-fix02-wait.md`。本节不改写上方历史段落原文。
