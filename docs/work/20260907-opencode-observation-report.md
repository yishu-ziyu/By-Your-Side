# OpenCode 进度报告：截图与快照可信（A1/A2/A3）

- 路径：`/Users/mahaoxuan/Desktop/ego`；分支：`fix/stability-issue2-model-capability-labels`（已用 `git branch --show-current` 核实，与派工预期一致）。
- 范围：完成标准 A1/A2/A3（`docs/evals/20260907-observation-click-integrity.md`，Codex 已锁定，不自行放松）。只动：`extension/src/background/exec/screenshot.ts`、`extension/src/background/exec/snapshot.ts`、`extension/src/background/axstate.ts`、`extension/src/background/axtree.ts`、`shared/protocol.ts`（截图/快照契约）、`agent/src/tools.ts`（screenshot/snapshot 定义）＋新建 `extension/test/observation-integrity.test.ts`。不碰 input.ts、domops.ts、shared/control.ts、prompt.ts、session.ts、background/index.ts；不 reset/revert/清理他人改动，不提交/push，不跑全量测试/build，不操作浏览器。
- 状态：REVIEW_READY（复核补强后） —— 反例先行，聚焦测试 20/20 通过，extension＋agent tsc 干净。

## 截图元数据字段约定（供 Antigravity 验收脚本读取）

`tool_result.data`（screenshot）字段，来源 `shared/protocol.ts` ToolContract：

| 字段 | 含义 | 未知/失败语义 |
|---|---|---|
| `imageBase64` / `mediaType` | PNG 图数据（去 dataURL 前缀）/恒 `"image/png"` | 解码失败则整个调用抛错，不返回 |
| `width` / `height`（= `pixelWidth` / `pixelHeight`） | 图像像素尺寸，PNG 解码实测，恒大于 0 | 恒正数；失败即抛错，无 0 成功包 |
| `cssWidth` / `cssHeight` | CSS 视口＝click point 坐标系；读取链：CDP `Runtime.evaluate` → `chrome.scripting` 页内读取 | 都读不到时为 0（未知，仅 chrome:// 类不支持页）；此时不得做图像→坐标换算 |
| `devicePixelRatio` | 同上读取链 | 未知为 0 |
| `tabId` / `url` / `title` | 捕获后重读的工作页身份；`url/title` 取捕获后值 | 捕获前后 URL 不一致则整个调用抛错（导航丢弃），不返回旧图配新 URL |
| `capturedAt` | `Date.now()` | — |
| `source` | `"cdp"` 指定页直接捕获；`"visible-tab"` 捕获前后均核对工作页在前台 | 回退前/后任一次核对失败即抛错；捕获后切页则已拍图片被丢弃，调用方只收到错误 |

模型换算关系：`image_px / DPR ≈ css_px`（页面占满视口时）；`cssWidth==0` 时 agent 文案明确声明不可换算。

## 修改文件

- `extension/src/background/exec/screenshot.ts`（重写主体逻辑）
  - A1：CDP 成功分支解码 PNG 实测像素宽高（`width/height`＋`pixelWidth/pixelHeight`，恒大于 0，解码失败整个调用抛错）；CSS 视口/DPR 读取链为 `Runtime.evaluate` → `chrome.scripting` 页内读取（debugger 不可用时的正常网页回退），都不支持才为 0（未知），不写固定假值；捕获前后各读一次视口，已知值变化即丢弃重拍（旧图不配新 CSS 尺寸），任一侧未知则不拦截；返回 `tabId/url/title/capturedAt/source`，URL/title 取捕获后重读值。
  - A2：CDP 失败后先核对同窗口活动页是工作页才做可见捕获；捕获后再次重读工作页 URL（前后不一致即导航丢弃，不返回旧图配新 URL）＋复核活动页仍是工作页（切页则丢弃已拍图片并抛错）；只有 CDP 捕获本身失败才进回退，导航/切页丢弃错误直接上抛。`maybeActivateTab(tab, sessionId)` 原样透传 session，worker 仍不抢前台；全程无 `windows.update`/聚焦调用。
- `extension/src/background/exec/snapshot.ts`
  - A3：`scope=viewport` 不再走全量 AX，直接用已有 DOM 视口快照（`content-snapshot.js` 真做视口过滤），首行声明降级＋ref 空间切换；`full_page` 保留原始 AX 路径；AX 失败回退 DOM 与 viewport 路径都调 `clearAxSnapshot`。
- `extension/src/background/axstate.ts`：新增 `clearAxSnapshot(tabId)`（确有需要才动：DOM ref 自增小编号与 backendDOMNodeId 同数字空间，不清会导致 `input.ts` 经 `isAxRef` 误走 CDP）。
- `extension/src/background/axtree.ts`：截断标记改为有效恢复方式（先滚动目标进入视口再 `snapshot(scope=viewport)`，或用 js 精确提取），保留 `[truncated` 前缀；仅此一处文案小改。
- `shared/protocol.ts`：仅改 screenshot 数据契约（新增像素/CSS 视口/DPR/tab 身份/source 字段，`width/height` 保留为像素尺寸兼容旧义）。
- `agent/src/tools.ts`：仅改 screenshot/snapshot 两个定义——screenshot 结果文本报 tab/URL/source＋像素与 CSS 视口/DPR 换算关系（视口未知时声明不可换算）；snapshot 说明 scope 语义与 ref 空间不可混用＋一条 promptGuideline。
- `agent/src/browser-program.ts`（A1 贯穿授权）：screenshot 分支去掉 base64 后保留全部真实元数据（`delete meta.imageBase64`，其余透传＋`image` 占位），图片仍走 images 通道；其他执行/控制逻辑不动。
- `agent/src/run-trace.ts`（A1 贯穿授权）：图片脱敏分支保留白名单元数据（尺寸/视口/DPR/tabId/url/title/source/capturedAt；数字直留，字符串走 visit 脱敏，URL 凭据仍被 redact），base64 继续只留长度、不落盘。
- 新建 `extension/test/observation-integrity.test.ts`（14 用例）与 `extension/test/content-snapshot-viewport.test.ts`（4 用例：视口外丢弃/视口内占位不递归/普通内容不受影响/full_page 回归）。
- `extension/src/content/snapshot.ts`（编排补充授权，最小改 iframe 分支）：`viewportOnly` 时先判 `inViewport`——视口外 iframe 整行丢弃（含其同源子文档）；视口内 iframe 仅输出 `[iframe src=… not-expanded]` 占位、不递归（不做子文档坐标换算，不声称覆盖 frame 内容）。`full_page` 保留旧行为。

## 旧行为反例与修改后命令/结果

- 命令：`npx vitest run extension/test/content-snapshot-viewport.test.ts extension/test/observation-integrity.test.ts extension/test/axtree.test.ts`
- 初版修复后：`Test Files 2 passed (2)；Tests 14 passed (14)`。
- 复核补强（捕获后核对、解码失败抛错、scripting 视口回退＋6 新反例）后：`Test Files 2 passed (2)；Tests 20 passed (20)`。新反例在旧逻辑下均失败（0 尺寸成功包、无捕获后核对、无 scripting 回退）。
- iframe 视口语义补充后：`Test Files 3 passed (3)；Tests 24 passed (24)`（fake-DOM 专属测试，无需浏览器；full_page 旧行为回归守卫在内）。
- A1 视口双读边界后：`Test Files 3 passed (3)；Tests 25 passed (25)`（新增捕获期间视口变化丢弃反例）。
- A1 贯穿链路（browser-program 去 base64 留元数据、run-trace 白名单留元数据＋凭据脱敏）：`npx vitest run agent/test/browser-program.test.ts agent/test/run-trace.test.ts` → `Test Files 2 passed (2)；Tests 25 passed (25)`（含 2 新增；既有脱敏/预算测试未动全绿）。此后冻结修改，待编排集成。
- 类型：`npx tsc --noEmit -p extension/tsconfig.json` 与 `-p agent/tsconfig.json` 均退出 0（未跑全量 `npm test`/`npm run build`，未操作浏览器，按分工留给 Codex 统一执行）。
- 说明：以上均为 mock 边界测试（测试内标注 CDP 失败为人工制造，未改产品错误分支）；真实 ChromeMain 截图/长页验证待 Codex 验收。

## 剩余风险和需要主代理的事项

1. `Runtime.evaluate` 与 `chrome.scripting` 都不可用的页面（chrome:// 类），CSS 视口/DPR 为 0（未知）——截图本身仍成功（像素真实），模型侧文案声明不可换算；Codex 真实验收时请覆盖 DevTools 占用场景。
2. 捕获与捕获后核对之间仍有极小竞态窗口（核对通过后、返回前用户切页/导航），属已知残余，未宣称根除；但错页图片与旧图配新 URL 两条已分别被前后双核对拦截。
3. frame 覆盖声明：viewport 下 iframe 仅占位未展开；full_page 下同源递归、跨域单行占位。深层 OOPIF 未覆盖，不声称（与标准边界一致）。
4. 工作树有大量他人未提交改动，我只改了上述所属行；请 Codex 在统一 build/验收前复核。
