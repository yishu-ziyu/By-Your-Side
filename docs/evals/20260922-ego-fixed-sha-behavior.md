# CAP-02 输入：EGO 固定 SHA 可观察行为矩阵

**性质：**固定版本行为矩阵；不是整体完成声明。初稿为只读拆解，2026-09-23 起按具体行为追加真实证据，不用同组通过推导未跑行。

**对标固定版本：**`citrolabs/ego-lite@dca7003349c5f7132189ba00547cbbd7ff8e597e`

**本文件读取来源（该 SHA，非 online main）：**

| 来源 | 路径 |
|------|------|
| Skill | `skills/ego-browser/SKILL.md` |
| Public schema | `package/ego-browser/src/public-api-schema.ts`（`PUBLIC_API_SCHEMA`，74 个入口名） |
| 许可证 | 仓库根 `LICENSE` |

**本地事实源（只读，未改）：**`shared/protocol.ts` 的 `TOOL_NAMES` / `ToolContract`；`agent/src/browser-program.ts` 的 `BROWSER_PROGRAM_HELPERS` / `RPC_ALIASES`；历史矩阵 `docs/evals/20260922-browser-capability-parity.md`（§二/§七 仅作历史对照，不改写其结论）。

**状态列约定：**没有本行等价行为证据仍为 `NOT_RUN`；已跑但失败为 `FAIL`，部分行为有证据为 `PARTIAL`。`PASS` 必须对应下述增量证据及明确适用条件。

## 2026-09-23 REV 增量证据

- 截图 #56–59：最新续接 `out/acceptance/browser-review-2026-09-22T23-53-49-667Z/result.json`，隔离真实 Chrome、源码前后指纹一致、日常 dist 未变、cleanup PASS。viewport/clip/fullPage × DPR 1/2 × css/raw 共 12 条 PNG 像素/尺寸对照；自定义 clip.scale=0.5/1.5 与两种外层模式及 DPR 组合、scale=4 小数区域、滚动后图片坐标点击和文档/视口变化。四行 PASS 仅限所测 CDP 行为，filtered 不代表整套 v2 通过；visible-tab 回退明确返回 raw，不冒充 CSS 缩放。历史 18 项和本次修前 2 项失败制品均保留。
- C3：`out/acceptance/browser-capability-integration-v2-2026-09-22T23-19-34-312Z/result.json`。popup、chooser arm→screenshot→触发→wait、真实 confirm 处理有独立证据；下载设置被 Chrome 扩展调试后端拒绝，blob 落盘与两个下载归属没有通过。不得将“诚实拒绝”算下载能力 PASS；下载组仍待适合该后端的受控实现，不能照搬需要浏览器级权限的调用。
- 其他行没有因本轮截图/输入通过而批量改绿；OOPIF、waitForURL、选择器兼容子集及未知写入继续链仍按各自证据验收。详情以 [REV 执行记录](20260922-browser-capability-integration-v2.md) 为准。

**分组约定：**

- **CAP-02A** — 事件 / 下载 / 动态文件选择 / dialog（及订阅先于触发等关键语义）
- **CAP-02B** — 右键、中键、wheel、按住、HTML5 拖放、富文本粘贴（及元素内偏移等真实输入选项）
- **CAP-02C** — role+name、shadow、frame/OOPIF、select 多选清空、等待状态、截图选项（及同源定位语义）
- **已有本地入口待复验** — 本地已有正式 RPC/helper/别名，CAP-02 前仍需按固定 SHA 语义复验
- **受保护边界** — 浏览器级危险操作 / 任意 OS 文件；不承诺无授权一比一复制

---

## 许可证（不贴原文）

| 项 | 结论 |
|----|------|
| 名称 | MIT License |
| Copyright | Copyright (c) 2026 CitroLabs |
| 是否允许参考其实现 | 是：MIT 允许使用、复制、修改、合并、发布等，无 copyleft 限制 |
| 若后续抄代码必须保留的声明 | 须在**所有副本或实质性部分**中保留上方 copyright 声明与 MIT permission notice（典型位置：引入文件头注释，和/或仓库第三方声明/`NOTICE`；以律师/项目惯例最终落点为准） |

**一句话：**MIT，可参考甚至抄实现，但抄入后必须在副本/实质性部分保留 CitroLabs 版权与 MIT 许可声明。

---

## 行为矩阵

未标 REV 更新的“本地入口”描述保留 2026-09-22 初次拆解时的历史状态，不当作 2026-09-23 最新源码盘点；NOT_RUN 表示该行为没有本行验收，不自动等于今天没有实现。当前执行结果只按明确的增量证据更新，不靠名称或大类补全。

| # | EGO 方法与关键选项 | 用户可观察行为 | 建议落入 | 本地是否已有正式入口 | 状态 |
|---|-------------------|----------------|----------|----------------------|------|
| 1 | `page.waitForEvent("popup", { timeout? })`（触发动作前 arm） | Agent 先挂等待再点击后，能拿到新开页并继续操作，不会因串行队列先阻塞 wait 再排 click 而死锁 | CAP-02A | REV：arm_event→click→wait_event 真实拿到本页 popup ID；完整单程序后续操作待补 | PARTIAL |
| 2 | 高层动作 receipt `popups: [{ label, targetId }]` | 一次点击若立刻弹出新页，回执里能看见 popup 身份并切过去 | CAP-02A | 部分：`ToolContract.click`/`double_click` 的 `newTab`；无 label/targetId 收据面 | NOT_RUN |
| 3 | `page.waitForEvent("download", { timeout? })`（触发前 arm） | 点击/页面生成下载前已订阅，能关联到**本页触发**的下载事件 | CAP-02A | REV：arm_event 存在，但 Page.setDownloadBehavior 被当前 Chrome 扩展调试后端拒绝；见 C3 原始错误 | FAIL |
| 4 | `download.url()` / `download.suggestedFilename()` | 用户能看到下载 URL 与浏览器建议文件名 | CAP-02A | 无 | NOT_RUN |
| 5 | `download.saveAs(absolutePath)` | 下载完成并落到指定路径；缺父目录会创建；blob/页面生成下载可用，不用 `fetch(GET)` 冒充 | CAP-02A | REV：存在 download_save_as 路径，但上游 arm 失败，真实 blob 落盘未通过；不使用普通 fetch 代替 | BLOCKED（依赖 #3） |
| 6 | `download.path()` | 可取到本轮临时文件路径 | CAP-02A | 无 | NOT_RUN |
| 7 | `download.failure()` | 下载失败时能读到失败原因（成功为 null） | CAP-02A | 无 | NOT_RUN |
| 8 | `download.cancel()` | 可取消进行中的下载 | CAP-02A | 无 | NOT_RUN |
| 9 | `download.delete()` | 可删除本轮临时下载产物 | CAP-02A | 无 | NOT_RUN |
| 10 | `download.page()` | 下载归属到启动它的 Page，两页同名下载不串任务 | CAP-02A | REV：两页场景未取得真实 download ID，不能证明归属 | BLOCKED（依赖 #3） |
| 11 | Skill：下载 wait 只配置/恢复**当前 Page session**，禁止 raw CDP 设全局下载目录 | 用户无关下载不被接管；未关联当前任务时安全失败 | CAP-02A | 无（且全局目录属边界策略，见受保护行） | NOT_RUN |
| 12 | `page.waitForFileChooser({ timeout? })`（click 前 arm） | 点击动态创建 `<input type=file>` 的按钮时，chooser 被拦截并可继续设文件 | CAP-02A | REV：arm→screenshot→click→wait 真实获得 chooserId/backendNodeId；使用该 chooser 设文件的完整链待补 | PARTIAL |
| 13 | `fileChooser.isMultiple()` | 能区分单选/多选文件选择器 | CAP-02A | 无 | NOT_RUN |
| 14 | `fileChooser.setFiles(pathOrPaths)` → 可能返回 `result.dialog` | 设文件后若页面立刻弹 JS dialog，能看到并处理；上传失败时文件状态可核验 | CAP-02A | 无 | NOT_RUN |
| 15 | `page.setInputFiles(selector, pathOrPaths)`（已有 file input） | 不经 OS 选择器，直接给现有 file input 设文件并读回 | 已有本地入口待复验 | `upload_file`（`ToolContract` / `extension/src/background/exec/upload.ts`）；`RPC_ALIASES.uploadFile` | NOT_RUN |
| 16 | `page.acceptDialog(promptText?)` | alert/confirm/prompt 可接受；prompt 可填入文本；无 dialog 时返回 false | CAP-02A | REV：browser.dialogInfo→accept_dialog，真实 confirm 结果 DLG:true；alert/promptText/无弹窗的分支待补 | PARTIAL |
| 17 | `page.dismissDialog()` | JS dialog 可取消/关闭；无 dialog 时返回 false | CAP-02A | 无正式入口（同上） | NOT_RUN |
| 18 | `page.info()` 中的 dialog 字段 | 未处理前能观察到当前打开的 dialog 类型与消息及页面归属 | CAP-02A | 部分：`browser.pageInfo`（`BROWSER_PROGRAM_HELPERS`）组合 url/title/viewport/scroll/工作页；**不承诺 dialog 状态** | NOT_RUN |
| 19 | 动作 receipt 同步 `dialog` | 触发动作后立刻出现的 dialog 出现在回执，须先处理再继续 | CAP-02A | 无 | NOT_RUN |
| 20 | `page.events()` 读清缓冲 | 能读并清空本页缓冲的协议事件，非常规 EventEmitter | CAP-02A | 部分：`network({ clear:true })`；无统一 popup/download/dialog 事件队列 | NOT_RUN |
| 21 | Skill：popup/download/chooser listener 在完成/超时/取消/页面销毁后清理 | 停止任务后迟到事件不串入新任务；错误 token 安全失败 | CAP-02A | 无（无对应 listener 生命周期） | NOT_RUN |
| 22 | Skill：浏览器设备/权限提示 ≠ 网页 JS dialog | 系统权限/设备选择器不会被当成 `acceptDialog` 自动点掉 | CAP-02A | 无（亦见受保护边界） | NOT_RUN |
| 23 | `page.click(sel, { button: "right" })` / `mouse.click(x,y,{ button:"right" })` | 右键打开仅 contextmenu 可达的菜单 | CAP-02B | 无（`click`/`double_click` 固定 `button:"left"`，`extension/.../input.ts`） | NOT_RUN |
| 24 | `page.click` / `mouse.click` `{ button: "middle" }` | 中键打开新页或中键专属行为 | CAP-02B | 无 | NOT_RUN |
| 25 | `page.dblclick(sel, { button: "right" 或 "middle" })` | 右键/中键双击有独立页面效果（若页面监听） | CAP-02B | 无（`double_click` 仅左键 clickCount 1→2） | NOT_RUN |
| 26 | `page.click`/`hover`/`dblclick` `{ position: {x,y} }`（相对元素左上角 CSS 像素） | 点到元素内非中心区域，命中结果与中心点不同 | CAP-02B | 无（有绝对 `point:[x,y]`，无元素内 offset） | NOT_RUN |
| 27 | `page.dragAndDrop(src, dst, { sourcePosition?, targetPosition?, button? })` | HTML5 `draggable` + DataTransfer 场景下源入目标；非仅 pointer 轨迹 | CAP-02B | 部分：`drag`（pointer press→move→release，`ToolContract.drag`）；历史矩阵记 HTML5 DnD 未实测 | NOT_RUN |
| 28 | `page.mouse.wheel(deltaX, deltaY, { label? })` | 在当前指针位置派发真实 wheel；可水平/垂直滚**命中容器**，非 `scrollTop=` 赋值 | CAP-02B | 无（`scroll` 为窗口 `scrollBy`/`toBottom`） | NOT_RUN |
| 29 | `page.mouse.down({ button?, clickCount? })` + 后续动作 + `mouse.up` | 按住鼠标键完成拖/框选等；取消/异常时安全释放 | CAP-02B | 无独立 down/up RPC（`drag` 内部序列不对外） | NOT_RUN |
| 30 | `page.keyboard.down(key)` + `keyboard.up(key)` | 按住 Shift/ControlOrMeta 等再点选/拖动；取消后松键 | CAP-02B | 无（`press_key` 为按下+抬起一体） | NOT_RUN |
| 31 | `page.keyboard.paste(string)`（macOS 原生粘贴快捷键后恢复剪贴板） | 纯文本经原生粘贴进入焦点控件 | CAP-02B | 无（`type_text`→`Input.insertText`） | NOT_RUN |
| 32 | `page.keyboard.paste({ text, html })` | 富文本编辑器出现表格/链接等 HTML 结构；不以 `innerHTML=` 冒充；不破坏用户并发剪贴板 | CAP-02B | 无 | NOT_RUN |
| 33 | `page.click`/`mouse.click` `{ clickCount: N }`（N>2 等） | 多次连击触发页面专属计数逻辑 | CAP-02B | 部分：仅 `double_click` 固定 2 次；无通用 clickCount | NOT_RUN |
| 34 | `page.click`/`hover`/`dragAndDrop` `{ force: true }` | 绕过指针拦截检查仍派发输入（页面可观察副作用） | CAP-02B | 无（本地有命中核对，无 force 旁路选项） | NOT_RUN |
| 35 | `page.mouse.move(x, y, { steps? })` | 指针沿多步轨迹移动，可触发 hover 路径依赖 | CAP-02B | 无独立入口（hover/click 内含单次 move） | NOT_RUN |
| 36 | `page.keyboard.type(text, { delay? })` | 尽量走物理按键序列打字（与 insertText 可区分） | CAP-02B | 部分：`type_text` 为 insertText；无物理键序列正式面 | NOT_RUN |
| 37 | 选择器 `loc=role:button[name='…']`（accessible name，≠ textContent） | ARIA 名与显示文本不同时仍能唯一点到正确控件 | CAP-02C | 无（`parseTarget` 支持 `@N`/`loc=css:`/CSS/`xpath=`/`text=`；**无 `loc=role:`**） | NOT_RUN |
| 38 | `loc=role:…[name*="…"]` 可访问名子串 | 部分名称匹配定位到唯一控件；多命中歧义失败 | CAP-02C | 无 | NOT_RUN |
| 39 | `loc=href:…` | 按链接 href 语义定位 | CAP-02C | 无 | NOT_RUN |
| 40 | Skill：CSS 搜索嵌套 **open shadow root** | 开放 Shadow DOM 内控件可被 CSS/动作命中 | CAP-02C | 部分：`domops` 命中/含 host 后代逻辑；无「CSS 穿透 open shadow」正式契约与验收 | NOT_RUN |
| 41 | Skill：动作先 top document 可操作命中，再搜 frames；多命中歧义 | iframe 内控件可达且不会误点顶层同名节点 | CAP-02C | 无正式跨 frame 解析契约（历史：全页 AX 常规 iframe；OOPIF 深层不做） | NOT_RUN |
| 42 | `page.snapshot({ scope: "subtree", root: "@iframeRef" })` | 只看某一 iframe 子树 refs，并用这些 ref 在 frame 内动作 | CAP-02C | 无（`snapshot.scope` 仅 `full_page` 或 `viewport`） | NOT_RUN |
| 43 | Skill：跨进程 OOPIF 用 child/flat session，宿主绑定 parent tab/frame/document/backend node | 真实跨站 OOPIF 内控件可操作，有 target/session 证据 | CAP-02C | 无 | NOT_RUN |
| 44 | Skill：frame 导航替换 / 跨 session 同 backendNodeId / 跨页旧 ref 区分 | 旧 ref 不静默打到错误文档 | CAP-02C | 部分：`documentId`/`nodeIdentity` 在 `read_element` 等；无 OOPIF session 模型 | NOT_RUN |
| 45 | `page.selectOption(sel, string 或 { value? / label? / index? })` | 按 value、可见 label 或 0-based index 选中，最终选中集合与 change 事件可证 | CAP-02C | 部分：`fill` 对 `<select>` 按 label/value 子串匹配单值（`domops.fill` / `fillBackendNode`）；无 index、无独立 select API | NOT_RUN |
| 46 | `page.selectOption(sel, string[])` 多选 | multiple select 最终选中集合为数组指定项 | CAP-02C | 无 | NOT_RUN |
| 47 | `page.selectOption(sel, null 或 [])` 清空 | 清空当前选择且页面状态可证 | CAP-02C | 无 | NOT_RUN |
| 48 | `page.waitForSelector(sel, { state: "attached" })` | 等到节点挂入 DOM（可尚不可见） | CAP-02C | 无（`waitFor`/`waitForElement` 仅可见+未禁用） | NOT_RUN |
| 49 | `page.waitForSelector(sel, { state: "detached" })` | 等到节点从 DOM 移除 | CAP-02C | 无 | NOT_RUN |
| 50 | `page.waitForSelector(sel, { state: "visible" })` | 等到可见 | 已有本地入口待复验 | `browser.waitFor` / `waitForElement`（`BROWSER_PROGRAM_HELPERS`） | NOT_RUN |
| 51 | `page.waitForSelector(sel, { state: "hidden" })` | 等到隐藏 | CAP-02C | 无 | NOT_RUN |
| 52 | `page.waitForURL(matcher, { timeout? })`（exact / glob / RegExp / predicate） | URL 满足条件后再继续，避免固定 sleep | CAP-02C | 无独立入口（`navigate` 就绪 + `snapshot.url` / 事件不等价） | NOT_RUN |
| 53 | `page.waitForLoadState("networkidle", { idleMs? })` | 按可证明请求生命周期达到空闲窗口（非仅环形缓冲静默） | CAP-02C | 部分：`waitForNetworkIdle` helper 自述为 quiet-window **近似**；FIX-02 已否认可冒充 network-idle | NOT_RUN |
| 54 | `page.waitForLoadState("domcontentloaded" 或 "load"，默认 load)` | 文档就绪态可等待 | 已有本地入口待复验 | `waitForLoad`（`BROWSER_PROGRAM_HELPERS`） | NOT_RUN |
| 55 | `page.goto`/`reload` `{ waitUntil: commit / domcontentloaded / load / networkidle }` | 导航完成语义可选；networkidle=500ms 无网络活动（schema） | CAP-02C | 部分：`navigate` 有 interactive/complete 就绪，无 waitUntil 四态 | NOT_RUN |
| 56 | `page.screenshot({ fullPage: true })` | 截取可滚动全页 | CAP-02C | `screenshot({fullPage:true})`：真实全页 PNG，顶部/底部像素及 DPR 1/2 尺寸证明；有图像预算 | PASS（见 REV 增量证据） |
| 57 | `page.screenshot({ clip: {x,y,width,height,scale?} })` | 局部矩形截图，坐标与后续点击一致 | CAP-02C | `screenshot({clip})`：文档 CSS 区域及 origin/scroll/density；真实坐标点击、自定义正 scale 与小数区域通过，clip 优先于 fullPage | PASS（所测 CDP 组合，见续接证据） |
| 58 | `page.screenshot({ scale: "css" })`（默认） | 输出按 CSS 像素尺寸 | CAP-02C | CDP 路径 viewport/clip/fullPage 的 DPR 1/2 输出均为 CSS 像素；回退标 raw | PASS（CDP 路径） |
| 59 | `page.screenshot({ raw: true })` | 绕过 DPR 校正的原始像素截图 | CAP-02C | 等价入口 `screenshot({scale:'raw'})`，真实设备像素与 DPR 对应 | PASS（见 REV 增量证据） |
| 60 | `page.snapshot({ scope: "full_page" })` | 全页语义快照（含滚动外内容） | 已有本地入口待复验 | `snapshot` `scope:"full_page"`（默认 AX） | NOT_RUN |
| 61 | `page.snapshot({ scope: "only_within_viewport" })`（默认；Skill：含浏览器返回的可见 iframe） | 视口语义快照 | 已有本地入口待复验 | `snapshot` `scope:"viewport"`（实现自述为 DOM 降级，iframe 内容未展开） | NOT_RUN |
| 62 | `page.snapshot({ includeStableLocator?, includeActionMarks? })` | 快照可带稳定 locator / action marks | CAP-02C | 无对应选项（本地另有 `mark`/`clear_marks`） | NOT_RUN |
| 63 | 选择器 `xpath=…` 唯一匹配 | XPath 唯一定位后动作 | 已有本地入口待复验 | `parseTarget` `xpath=`（`extension/src/shared/target.ts`） | NOT_RUN |
| 64 | 选择器 `text=…`（引号精确 / 非引号规范化子串） | 文本语义唯一定位 | 已有本地入口待复验 | `parseTarget` `text=`（规范化唯一最深）；引号精确语义待复验 | NOT_RUN |
| 65 | 兼容子集 `css=…`、`:has-text` / `:text-is`、`>> nth=N` | Playwright 风格子集定位（含第 N 个） | CAP-02C | 无（`parseTarget` 明确拒绝 `:has-text` 等） | NOT_RUN |
| 66 | `page.fill(sel, value, { clearFirst? })` | 填充前可先清空；确认编辑生效 | 已有本地入口待复验 | `fill`（无 clearFirst 选项面） | NOT_RUN |
| 67 | `page.focus(sel)` → wrapper 的交互祖先/唯一可编辑后代 | 点标签/包装仍能聚焦真实控件 | CAP-02C | 无独立 `focus` RPC；fill/press 路径部分隐式 focus | NOT_RUN |
| 68 | `page.press(sel, chord, { delay? })` | 先聚焦目标再按组合键 | CAP-02C | 部分：`press_key`（无 selector）；需先 click/fill 聚焦 | NOT_RUN |
| 69 | `page.waitForFunction(fn, arg?, { timeout?, polling? })` | 等到页内业务条件为真 | 已有本地入口待复验 | 组合：`js` 轮询 + `waitFor`；无同名 helper | NOT_RUN |
| 70 | `page.evaluate(fnOrString, argument?)`（安全超时报告 executionStopped / mayHaveLateEffects） | 页内 JS 取值；超时语义可决策是否需 reload | 已有本地入口待复验 | `js`（`ToolContract.js`）；超时报告字段形态待复验 | NOT_RUN |
| 71 | `page.fetch(url, { method, headers, body, saveAs, cache, credentials, … })` | 带页面 cookie/CORS 的 in-page fetch；可二进制 saveAs | 已有本地入口待复验 | `fetch`（GET/POST + `savePath`；选项子集不同） | NOT_RUN |
| 72 | `page.cdp(method, params?, { timeout? })`（Page session） | 无专用 helper 时的页级 CDP escape hatch | 已有本地入口待复验 | `cdp`（`extension/src/background/exec/cdp.ts`，working-tab 绑定） | NOT_RUN |
| 73 | `page.click` 左键 / `point` / `label` | 真实 CDP 左键点击；可选光标文案 | 已有本地入口待复验 | `click`（`ToolContract.click` / `input.ts`） | NOT_RUN |
| 74 | `page.dblclick` 左键 | 真实双击，单击无效而双击有效的控件可区分 | 已有本地入口待复验 | `double_click`；`RPC_ALIASES.doubleClick` | NOT_RUN |
| 75 | `page.hover` | 真实 mouseMoved 悬停 | 已有本地入口待复验 | `hover` | NOT_RUN |
| 76 | `page.keyboard.insertText(text)` | 不合成按键的插入文本 | 已有本地入口待复验 | `type_text` | NOT_RUN |
| 77 | `page.keyboard.press(chord, { delay? })` | 按键/便携和弦（含 ControlOrMeta） | 已有本地入口待复验 | `press_key` | NOT_RUN |
| 78 | `page.url()` / `page.title()` | 读当前 URL/标题 | 已有本地入口待复验 | `snapshot.url` + `pageInfo` / `js` | NOT_RUN |
| 79 | `page.reload({ timeout?, waitUntil? })` | 刷新并等待选定导航态 | 已有本地入口待复验 | 组合：`navigate` 同 URL 或 `js` location.reload；无专用 reload+waitUntil | NOT_RUN |
| 80 | `page.close()` | 关闭 Agent 页并确认 tab 消失 | 已有本地入口待复验 | `close_tab` | NOT_RUN |
| 81 | `page.waitForTimeout(ms)` | 固定毫秒等待且不激活页 | 已有本地入口待复验 | `sleep`（`BROWSER_PROGRAM_HELPERS`） | NOT_RUN |
| 82 | `task.tabs()` / `task.pages()` / `task.newPage()` / `task.page(label)` | 列页、开空白页、按标签复用 | 已有本地入口待复验 | `list_tabs` / `open_tab` / `switch_tab`（无持久 p1 标签，用 tabId） | NOT_RUN |
| 83 | `task.adopt` / `task.release` / `task.userPage` | 接管未管理标签 / 归还用户 / 取交接时活动页 | 已有本地入口待复验 | 部分：`worker_tabs` / `share_tab` / takeover·handback 协议；语义非 1:1 | NOT_RUN |
| 84 | `task.handOff()` / `takeOverTaskSpace` / `waitForControl` | 用户接管与恢复同一空间 | 已有本地入口待复验 | 产品侧 takeover/handback（非 browser_run API） | NOT_RUN |
| 85 | `task.finish({ keep })` | 结束任务并按保留策略关页 | 已有本地入口待复验 | 产品任务结束路径；非同名 API | NOT_RUN |
| 86 | `browser.scrollToBottomUntil`（EGO Skill/legacy；schema 称 legacy 在 schema 外） | 滚到底或直到条件 | 已有本地入口待复验 | `scrollToBottomUntil`（`BROWSER_PROGRAM_HELPERS`） | NOT_RUN |
| 87 | `task.cdp(method, params)` — **Target / Browser 域** | 浏览器级 CDP（关浏览器、枚举全部 Target 等） | 受保护边界 | 无放行入口：`CDP_DENY_PREFIXES` 含 `Browser.`/`Target.`（`exec/cdp.ts`） | NOT_RUN |
| 88 | 任意绝对路径读写 OS 文件（`setInputFiles` / `saveAs` / `screenshot.path` / `fetch.saveAs` 无授权） | Agent 读写用户任意磁盘路径 | 受保护边界 | 上传限 `~/.sideagent/uploads` 与 `downloads`（`upload-paths.ts`）；不承诺无授权复制任意路径 | NOT_RUN |
| 89 | Skill `references/clearing-state.md`：清 cookie/cache/storage 可能达**整 profile** | 清掉用户整站登录态/缓存 | 受保护边界 | 无「无授权清整 profile」承诺；若经 `cdp` 触及需显式授权审查 | NOT_RUN |
| 90 | `profiles()` / `taskSpace(..., { profileId })` 选浏览器配置 | 切换/使用指定浏览器配置文件 | 受保护边界 | 无（产品不暴露任意 profile 切换作默认自动化） | NOT_RUN |
| 91 | 浏览器自有设备/权限/通行密钥等系统 UI | 自动点击系统级权限提示 | 受保护边界 | 无；Skill 要求交还用户 | NOT_RUN |

---

## 计数（互斥归属）

| 分组 | 行数 | 行号 |
|------|------|------|
| CAP-02A | 21 | 1–14, 16–22 |
| CAP-02B | 14 | 23–36 |
| CAP-02C | 25 | 37–49, 51–53, 55–59, 62, 65, 67–68 |
| 已有本地入口待复验 | 26 | 15, 50, 54, 60–61, 63–64, 66, 69–86 |
| 受保护边界 | 5 | 87–91 |
| **合计行为行** | **91** | |

说明：#50（`state: "visible"`）表内标注与已有 `waitFor` 重叠，互斥计数归入「已有本地入口待复验」；#15（已有 `upload_file`）同理不计入 CAP-02A。

---

## 任务书 5.2–5.4 已知缺口对照（须能在表中找到）

| 任务书缺口 | 本表行 |
|------------|--------|
| popup 观察/等待（订阅先于触发） | #1–2, #21 |
| download 等待/落盘/失败取消 | #3–11 |
| 动态 file chooser | #12–14 |
| JS dialog 类型/消息/处理 | #16–19, #22 |
| 右键 / 中键 | #23–25 |
| 元素内 position | #26 |
| 真实 wheel 水平/垂直与容器 | #28 |
| keyboard/mouse down/up 按住 | #29–30 |
| HTML5 drag/drop | #27 |
| 富文本 paste `{text,html}` | #31–32 |
| role+accessible name | #37–38 |
| shadow | #40 |
| frame / OOPIF | #41–44 |
| select 多选/清空/value·label·index | #45–47 |
| 等待 attached/detached/visible/hidden | #48–51 |
| 截图 fullPage/clip/CSS-DPR 选项 | #56–59 |
| 受保护：Browser/Target、任意 OS 文件 | #87–91 |

---

## 无法从该 SHA 单独确认的点

1. **`dragAndDrop` 运行时是否走 Chromium HTML5 DataTransfer 路径**：schema/Skill 只保证「拖」语义与 position/button 选项；本票未读该 SHA 的 driver 实现，不能断言一定覆盖原生 DnD（故 #27 仍进 CAP-02B，待实现时对照源码）。
2. **OOPIF 的具体 CDP session API 形状**（Skill 要求 child/flat session，但 public schema 无独立方法名）；细节需再读该 SHA 的 runtime/driver，不能仅凭 schema 列方法签名。
3. **`keyboard.paste` 剪贴板保存/恢复的并发竞态处理**：Skill 描述 macOS 行为；恢复失败或用户中途改剪贴板时的精确语义未在 schema 选项中出现。
4. **Legacy helpers**（schema 写明 intentionally outside `PUBLIC_API_SCHEMA`）：除 Skill 点名的行为外，是否还有未进 schema 的公开浏览器能力，本票未枚举完整 runtime 导出。
5. **`page.info()` dialog 字段的精确形状**（类型/消息/默认值）：summary 仅写 “dialog state”，无 TypeScript 字段表。
6. **本地 `waitForNetworkIdle` / `pageInfo` 与 EGO 是否语义等价**：历史矩阵与 FIX-02 已提示不等价风险；等价性只能靠复验，本票一律 `NOT_RUN`。

---

## 修订记录

- 2026-09-22：CAP-02 只读对标首版；固定 SHA `dca7003349c5f7132189ba00547cbbd7ff8e597e`；未改产品源码/测试/STATUS/历史验收矩阵。
