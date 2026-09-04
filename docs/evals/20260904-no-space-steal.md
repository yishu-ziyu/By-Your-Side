# 任务: 操作标签页时不要拽走 macOS Space

来源：2026-09-04 用户。Agent 点击时 `windows.update({focused:true})` 把 Chrome 窗口拉到前台，人在另一个 Space 工作会被拽回去。

## 验收标准
- [x] 1. `activateTab` 不再调用 `chrome.windows.update({ focused: true })` — evaluator: 代码走查
- [x] 2. 工作窗口当前未聚焦（人在别的 Space / 别的应用）时，连 `tabs.update({ active: true })` 也不做，CDP 点击/输入仍走后台标签 — evaluator: `mayActivateTabInWindow` 单测 + 代码走查
- [x] 3. 窗口已在前台时，仍把工作标签页切到该窗口内前台，方便盯着看 — evaluator: 单测 focused===true
- [x] 4. screenshot 一律先 CDP `Page.captureScreenshot`，失败再 `captureVisibleTab`（不靠抢前台才能截） — evaluator: 代码走查
- [x] 5. typecheck / build / test 绿；产物同步到 Chrome 正在加载的 `Desktop/ego/extension/dist` — evaluator: npm + rsync（151 tests）

## 边界与不做
- 不改光标动画本身；后台标签里光标你看不见是预期
- 不处理「同一 Space 里两个 Chrome 窗口」的精细策略
