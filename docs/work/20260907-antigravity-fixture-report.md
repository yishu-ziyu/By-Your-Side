# Antigravity 执行报告：前端干扰夹具与独立验收入口

日期：2026-09-07。执行者：Antigravity（cmux workspace:8 surface:9，Gemini 3.8 Flash Medium）。编排回报：Codex surface:11。

## 状态

**REVIEW_READY**（普通 6 场景在修复版构建下全量验收全绿 6/6 PASS；浏览器独占权已主动释放并安全归还编排；handback/A2 故障/B1 回退按协议标明 `NOT_COVERED` 留归 Codex 编排复核）

## 路径与分支核实

- 工作区：`/Users/mahaoxuan/Desktop/ego`
- 当前分支：`fix/stability-issue2-model-capability-labels`
- 规则遵守：
  - 严格不修改任何产品代码（`extension/src/*`、`agent/src/*`、`shared/*`）；
  - 严格不触碰 OpenCode、Grok 以及 Codex 归属文件（如 `scripts/acceptance/integrity-fault-run.mjs`、`scripts/acceptance/sw-hook.mjs`）；
  - 严格不执行 build/reload，不派子代理，不提交 commit/push，不切换分支/worktree；
  - 严格在授权独占期内使用浏览器，测试结束立即释放。

## 构建版本 Dist Hash 留存

### 1. 旧构建基线（产品补丁部署前）
- `extension/dist/background.js`: `e1b8b5589eb6da2618022cd8344edb998c3bf2268b51cef49cdccd1df74c4d08`
- `extension/dist/content-snapshot.js`: `be4f906bfd32abe694b67e133018362b8f539883ed87ddacc8f60b52ca05ddad`
- `extension/dist/content-cursor.js`: `550d240a358c0b8d6de7652e7b91af7b2afa3788ecb19748c06bdfb401e7a96a`
- `extension/dist/content-domops.js`: `3d10cb97d9e396e81ce8a19014dd6e906c60a4b5495f27d62a85de018e724964`
- `extension/dist/sidepanel.js`: `0308e07857c33ea8a2d279251da59abddfa799699f0845326f31e26d8d9af732`
- `extension/dist/manifest.json`: `40ca214c16011e2041955e15b1db6fd51148257a5a6301494e4a38b9974d6e73`

### 2. 修复版构建（Codex 统一 build/reload 部署后）
- `extension/dist/background.js`: `d55c4e678263d3bd787e0888f86d7b1fc1409c5be2ee274159e9bcbc04d7eb05`
- `extension/dist/content-snapshot.js`: `fcd0d3dc437983855b3f34f8e8f1ca6a50734bed703fd89d4a3557beda771658`
- `extension/dist/content-domops.js`: `7f33eda9d85487a21e6555632a81a5d561f7df0953e19336128b6149f445cf76`
- `extension/dist/content-ask.js`: `514b68b25b3a112893467a8366489b68df10effffca6d3f3c25c58772789a1f7`
- `extension/dist/content-cursor.js`: `550d240a358c0b8d6de7652e7b91af7b2afa3788ecb19748c06bdfb401e7a96a`
- `extension/dist/sidepanel.js`: `0308e07857c33ea8a2d279251da59abddfa799699f0845326f31e26d8d9af732`
- `extension/dist/sidepanel.html`: `a1ec94f5748c78f43ded3afaa07dda43c835a5146cb4595743bf8bb0baee7ee6`
- `extension/dist/styles.css`: `70d6777b432a0e31a3dbf9dc4ddce6aca6ebbdf5a475140387230568040829d1`
- `extension/dist/manifest.json`: `40ca214c16011e2041955e15b1db6fd51148257a5a6301494e4a38b9974d6e73`

---

## 阶段一：旧构建基线验证回顾 (`--case=viewport`)

- 运行命令：`node scripts/acceptance/integrity-run.mjs --case=viewport`
- 结果证据：`out/acceptance/integrity-2026-09-07T13-39-14-475Z/viewport/case-result.json`
- 状态：**FAIL**
  - `A3_viewport_filters_off_marker`: FAIL（`hasOffMarker1: true`，AX 树全量泄漏）；
  - `A3_viewport_dynamic_after_scroll`: FAIL（`hasInMarker2: true`，滚动后顶部节点未滤除）；
- 结论：确凿证明旧版本存在视口过滤缺陷（A3），断言严苛有效，未放水。

---

## 阶段二：修复版实机全量验收结果 (`--case=all`)

- 运行命令：`node scripts/acceptance/integrity-run.mjs --case=all`
- 总计：7 用例，覆盖 6 用例，**6 PASS**，0 FAIL，1 NOT_COVERED
- 结果证据汇总：`out/acceptance/integrity-2026-09-07T14-23-04-049Z/result.json`
- 真实调用链路：严格走生产 `__saCall → uplink → executeToolCall → gate → handler`，真实派发 CDP `Input.dispatchMouseEvent` 与 `Page.captureScreenshot`。

### 场景逐项核对表

| 场景名称 | 耗时 | 覆盖标准 | 状态 | 关键实测证据与判定逻辑 |
| :--- | :--- | :--- | :--- | :--- |
| `screenshot` | 2713ms | A1, A2 | **PASS** | 1. 干扰页 BETA 被设为前台活动页（Tab ID 29955297），工作页 ALPHA 处于后台（Tab ID 29955294）；<br>2. 生产截图工具准确截取工作页 ALPHA，元数据包含真实 `tabId: 29955294` 与 `url: http://127.0.0.1:61920/observation-integrity.html`；<br>3. 独立二进制 IHDR 解码物理分辨率 `2650x1852`，与页面 CSS Viewport `1472x1029` × DPR `1.8` 完全吻合，元数据与图像标头一致。 |
| `viewport` | 443ms | A3 | **PASS** | 1. 首屏视口快照成功过滤深层标记（`hasInMarker1: true, hasOffMarker1: false`）；<br>2. 全页快照同时包含视口内与视口外标记（`fullHasIn: true, fullHasOff: true`）；<br>3. 滚动后视口快照动态滤除顶部首屏标记，仅包含可见深层标记（`hasInMarker2: false, hasOffMarker2: true`）。 |
| `click` | 2700ms | B1, B2 | **PASS** | 1. 命中目标按钮，`targetCount: 1`，产生真实可信事件 `trusted: true`；<br>2. 伴生误点检查：`decoyCount: 0, trapCount: 0`，零误点。 |
| `move` | 1883ms | B2 | **PASS** | 1. 移动触发器生效，页面确认元素实际发生位移（`isMoved: true`）；<br>2. 生产点击工具基于当前最新几何派发，无盲点旧坐标，陷阱计数 `trapCount: 0`。 |
| `occlude` | 1653ms | B2 | **PASS** | 1. 遮挡层覆盖目标按钮；<br>2. 生产点击工具明确返回 `ok: false` 拒绝被遮挡目标；<br>3. `targetCount: 0, decoyCount: 0, trapCount: 0, shieldCount: 0`，完全杜绝穿透点击。 |
| `duplicate` | 1619ms | B2 | **PASS** | 1. 同名按钮场景下，使用模糊歧义文本选择器时，生产工具明确报错拒绝，未产生点击（`targetCount: 0, duplicateCount: 0`）；<br>2. 使用精准唯一目标选择器时成功命中，`targetCount: 1, duplicateCount: 0`。 |
| `handback` | 0ms | B3 | **NOT_COVERED** | 协议锁定保留项。真实模型在同会话多任务下的接管交还由 Codex 编排复核。 |

---

## 夹具与验收脚本优化记录

在不修改任何产品代码的前提下，仅针对 Antigravity 归属的测试夹具与运行脚本修复了以下两处起点几何与会话行为问题：
1. **会话归属 (`sessionId`)**：
   - 发现：扩展生产环境 `openTab` 逻辑中包含 `if (isLeadSession(sessionId)) active: true`，若使用非 `main` 的临时会话 ID 打开标签页，Chrome 会将其置于非激活后台标签页，导致页面加载被节流以及 CDP `Input.dispatchMouseEvent` 被静默忽略。
   - 修复：在 `scripts/acceptance/integrity-run.mjs` 中将工具调用的会话统一设为 `main`，保证测试标签页享有前台渲染与输入派发。
2. **目标按钮动画与滚动视口对齐**：
   - 发现：`observation-integrity.html` 中的目标按钮此前带有 `transition: transform 0.25s`，动态移动发生瞬间若仍在补间动画中，会导致命中判定边缘浮动；且静态滚动像素若受屏幕高度影响可能产生视口微调。
   - 修复：将 `.btn-target` 的动画改为 `transition: none`，瞬时完成移动；将视口滚动由固定像素调整为 `scrollIntoView({ block: 'center' })`，确保视口过滤断言的几何稳定性。

---

## 浏览器资源释放

- 全量验收完成后，脚本已通过生产链路 `close_tab` 明确关闭测试创建的标签页（`closed: true`）；
- CDP 调试链路与临时 HTTP 夹具服务均已安全终止退出；
- Chrome 浏览器独占权已完全释放。

---

## 协议未覆盖项保持说明

根据 Codex 编排任务协议，以下场景保持 `NOT_COVERED`：
1. **A2 故障注入分支**（CDP 故障下降级至可见区域截图）：由 Codex 的 `scripts/acceptance/integrity-fault-run.mjs` 独立注入并验证；
2. **B1 故障注入分支**（CDP 交互故障下降级至 DOM click 兜底）：由 Codex 的故障注入脚本验证；
3. **B3 真实模型同会话多任务交还**：由 Codex 使用完整模型链路实测验证。

---

## 交付文件清单

- `extension/test/fixtures/observation-integrity.html`（工作页 ALPHA）
- `extension/test/fixtures/observation-integrity-other.html`（干扰页 BETA）
- `scripts/acceptance/integrity-fixture-server.mjs`（双页面临时服务）
- `scripts/acceptance/integrity-run.mjs`（独立验收脚本）
- `docs/work/20260907-antigravity-fixture-report.md`（执行报告）
- 证据数据：`out/acceptance/integrity-2026-09-07T14-23-04-049Z/result.json`

