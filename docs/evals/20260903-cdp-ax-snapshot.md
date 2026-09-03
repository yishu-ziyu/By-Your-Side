# 任务: CDP Accessibility 快照升级

snapshot 工具从「content script 手搓 DOM 遍历」升级为「chrome.debugger + Accessibility.getFullAXTree」：跨 shadow DOM、节点自带稳定 backendNodeId，让模型在 YouTube 这类重度虚拟化页面上不再退回 screenshot 瞎试。

## 设计要点（已确认方向）

- 协议不变：`snapshot` 返回仍是 `{ text }`；click/fill 的 target 仍是 `@N` / `loc=css:...` / 裸 CSS 三种。
- ref 映射改为 background 侧 `ref → backendNodeId`（SW 内存，SW 重启后 ref 失效报错「请重新 snapshot」，可接受）。
- click/fill 收到 `@N` 走 `DOM.resolveNode` → `DOM.getBoxModel` 拿坐标，复用现有 `Input.dispatchMouseEvent` 路径；`loc=`/裸 CSS 维持现有 domops 路径。
- debugger 被占用（DevTools 开着）时回退旧 DOM 快照，输出首行标注回退原因。
- ax→text 转换做成纯函数，vitest 覆盖。

## 验收标准

- [ ] 1. 复杂页面真机任务（通用性验证，不针对单一站点）：YouTube、B站（或知乎）各完成一个「找到首屏某个条目并点进其作者主页」类任务，模型全程用快照 ref 点击，不退回 screenshot 试探；步数明显少于改造前（改造前 YouTube：viewport 快照→全页快照→截图 3 步还没点上）— evaluator: 人评
- [ ] 2. shadow DOM 页面（如 shoelace 组件文档页）快照能看到 shadow 内元素并能点击成功 — evaluator: 人评
- [ ] 3. `npm run typecheck` 全绿；`npm test` 全绿；`npm run build` 通过 — evaluator: npm run typecheck / npm test / npm run build
- [ ] 4. ax→text 纯函数测试：ignored 节点过滤、无 name 节点处理、缩进树形、12KB 截断标记、ref 分配与保号（同 fixture 两次转换 ref 不变）— evaluator: npm test
- [ ] 5. 三种 target 回归：`@N` 点击、`loc=css:` 点击、裸 CSS fill 各成功一次 — evaluator: 人评（真机各一次）
- [ ] 6. debugger 闲置 15 秒自动卸载行为不变（黄条消失）— evaluator: 人评观察
- [ ] 7. DevTools 打开占用 debugger 时，快照回退 DOM 版且输出首行有回退标注 — evaluator: 人评
- [ ] 8. agent/src/prompt.ts、tools.ts 描述、README、docs/NOTES.md 与新行为一致（不再自称名不副实的描述）— evaluator: typecheck + 人评扫一眼

## 边界与不做

- OOPIF 跨域 iframe 深层拉取（Target.attachToTarget flatten 会话）不做，二期单开；本期对跨域 iframe 输出占位行（与现状一致）。
- SW 被回收导致宿主进程被杀的问题单开任务处理（保活或会话恢复），不在本卡。
- 交互/视觉优化不做。
