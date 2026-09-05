# 任务: 操作前元素高亮（派工卡，自包含）

## 背景（接手者需要的全部上下文）

Chrome MV3 扩展 + 本地 agent 进程。Agent 操作页面的链路：

- 入口：`extension/src/background/exec/input.ts` 的 `click()` / `fill()`
- click 流程：解析 target → 算出视口坐标 `point = [x, y]` → 驱动虚拟鼠标 → CDP `Input.dispatchMouseEvent` 派发真实点击（debugger 被占用时回退 domops 页面内合成事件）
- 页面内可视化统一走 **cursor overlay**：`extension/src/content/cursor.ts`，esbuild IIFE 打包为 `dist/content-cursor.js`，由 background 用 `chrome.scripting.executeScript` 按需注入（ISOLATED world），幂等，API 挂在 `window.__sideagent.cursor`（类型声明在 `extension/src/sideagent.d.ts`）
- 现有 cursor API：`move(x,y)` / `click(x,y)` / `hide()` / `for(id)`；closed shadow DOM，host `pointer-events:none` + `z-index:2147483647`；坐标一律视口坐标系
- background 侧调用页面的工具函数：`input.ts` 里的 `ensureCursor(tabId)` 和泛型 `callDom(tabId, func, args)`
- 构建：`npm run build -w @sideagent/extension`（build.mjs 里 content-cursor 是独立 IIFE entry）；检查：`npm run typecheck`、`npm test`（vitest，目前 56 个测试）

## 要做的功能

Agent 对元素执行 click/fill **之前**，在目标元素周围画一个呼吸高亮框（圆角矩形描边，透明度脉动 ~2 次，总时长 ≤600ms），高亮结束或消失后再执行真实操作。目的：让用户看清"Agent 找对地方了"。

建议做法（可按实际情况调整）：cursor.ts 加一个 `highlight(rect: {x,y,width,height})` 方法（与 cursor 同一 overlay host，新元素类型）；input.ts 在 click 已有 `point` 处、fill 在拿到 rect 处调用，await 高亮时长后走原逻辑。**注意坐标必须在 scrollIntoView 之后取**，失败必须静默兜底不阻塞主流程（参照现有 cursor 驱动的 try/catch 写法）。

## 完成标准
- [ ] 1. click 前目标元素出现呼吸高亮框，随后光标移动 + 波纹 + 真实点击按序发生 — evaluator: 人评（等待用户真实操作体验裁决）
- [ ] 2. fill 前同样有高亮 — evaluator: 人评（等待用户真实操作体验裁决）
- [x] 3. 高亮层不拦截页面事件、不留残影；多实例（for(id)）下高亮颜色跟随实例色 — evaluator: 代码审查 + 机器（host 与 .highlight 均设 pointer-events:none；动画结束 animationend 及 650ms 超时均调用 el.remove() 清理；多实例颜色跟随 inst.color 调色板并通过独立 highlightEl 管理；实测截图 630ms 后高亮框完全销毁无残影）
- [x] 4. 高亮注入失败（如 chrome:// 页面）静默跳过，click/fill 主流程不受影响 — evaluator: 代码审查（input.ts 中所有 ensureCursor 与 callDom(highlight) 均在 try/catch 块中静默兜底）
- [x] 5. `npm run typecheck` / `npm run build` / `npm test` 全绿 — evaluator: 机器（全绿，60 tests passed，构建成功）
- [x] 6. 高亮框样式用无头 Chrome 静态截图自检（深浅两种页面底色）— evaluator: 机器（无头 Chrome CDP 运行自检通过：浅色与深色背景下圆角矩形描边、外发光、白色高反差边缘均清晰可见，多实例红色与默认蓝色分别正确渲染）

## 边界与不做
- 不改 `shared/protocol.ts`，不动 agent 进程
- 不做教学模式、不做轨迹回放（路线图其他条目）
- scroll/type/key 不加高亮

## 验收结论与交付记录 (2026-09-03)

### 1. 架构与改动要点
- **类型定义** (`extension/src/sideagent.d.ts`)：`SideAgentCursor` 扩展 `highlight(rect: SideAgentRect): void`。
- **页面 Overlay 渲染** (`extension/src/content/cursor.ts`)：
  - 新增 `.highlight` 样式：圆角矩形描边 (`border: 2px solid var(--c)`)、半透明柔和底色 (`color-mix(in srgb, var(--c) 12%, transparent)`)、双重光晕与高反差白边 (`box-shadow: 0 0 0 1px rgba(255,255,255,0.4), 0 0 14px color-mix(in srgb, var(--c) 45%, transparent)`)，兼容浅色与深色背景。
  - 呼吸动效 `@keyframes highlight-breathe`：500ms 内完成 2 次透明度脉动（0% 隐 → 20% 峰值 1.0 → 45% 谷值 0.35 → 70% 次峰值 0.95 → 100% 淡出 0.0），平滑吸附无突兀感。
  - 多实例支持：按实例对象管理高亮元素 `inst.highlightEl`，颜色自动使用实例专属调色板；动画结束 `animationend` 及 650ms 兜底定时器均触发 `remove()`，`hide()` 时同步清空，彻底防止残影。
  - **关键 Bug 修复**：修复 closed shadow DOM 下 `host.shadowRoot` 外部访问为 `null` 导致子元素未成功挂载的问题，模块内持久保留 `shadow` 根引用。
- **执行层驱动** (`extension/src/background/exec/input.ts`)：
  - 新增 `rectOfBackendNode(tabId, backendNodeId)`：在 AX 快照路径下通过 CDP `Runtime.callFunctionOn` 执行 `scrollIntoView` 并获取精确 `getBoundingClientRect()`。
  - `click` 流程改造：在 `scrollIntoView` 之后获取元素 `targetRect`，优先触发 `cursor.highlight` 并等待 500ms（高亮完整播放），随后平滑移动虚拟鼠标 (300ms) + 播放波纹 (150ms) + 真实派发点击事件。
  - `fill` 流程改造：在填充前获取 `targetRect`，触发 `cursor.highlight` 并等待 500ms，随后派发原生 setter 及 input/change 事件。
  - 所有可视化注入均包裹在独立 `try/catch` 中，遇到特殊受限页面（如 `chrome://`）静默跳过，主流程不受阻碍。
- **单元测试** (`extension/test/highlight.test.ts`)：新增 4 项测试覆盖高亮包围盒 pad 外扩计算、非正尺寸过滤、中心点映射及多实例调色板循环。

### 2. 机器检验结果
- `npm run typecheck`：通过（extension + agent 均无类型错误）。
- `npm test`：通过（9 个测试文件共 60 个测试全部通过）。
- `npm run build -w @sideagent/extension`：构建产物正常生成（`content-cursor.js` 7.8kb）。
- `npm run reload:ext`：扩展热重载成功，即刻生效。
- **无头 Chrome 截图自检**：
  - 脉动峰值截图 (`element-highlight-peak.png`)：浅色（#f8fafc + 白卡片）与深色（#0b0f19 + #1e293b 卡片）背景下，圆角描边与光晕均极具辨识度，主实例蓝与 worker-red 红色实例着色完全正确。
  - 结束清理截图 (`element-highlight-finished.png`)：500ms 动画完成后高亮元素从 DOM 自动卸载，不留残影，光标保持正常落位。

### 3. 待人评裁决
- 条目 1：click 前目标元素呼吸高亮框随后移动点击的手感与视觉节奏。
- 条目 2：fill 前目标输入框呼吸高亮的手感与视觉节奏。

