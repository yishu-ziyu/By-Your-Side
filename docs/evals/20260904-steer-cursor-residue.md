# 任务: 修三个实测问题 —— steer 失忆 / 光标可见性 / 刷新残留与侧栏偏移

> 来源：2026-09-04 用户实测反馈（session_a5d1ce67 被中断的第二轮任务）。
> 排查线索已存 `docs/NOTES.md`「2026-09-04 被中断任务找回」节；根因排查（两个 explore 子代理）被中断未完成，领任务后**先补排查再动手**。

## 背景与线索

1. **steer 打断后失忆**：任务运行中用户插话后，agent 忘记之前已锁定的标签页，反问"在改哪个标签页"。线索：sidepanel 运行中发 `{type:"steer"}`（`extension/src/sidepanel/main.ts` ~775）→ relay → background → `agent/src/session.ts` → Pi SDK 0.84.4 `session.steer()`。需确认：① steer 文本是否走了 `withPageContext` 前缀（普通 prompt 走，steer 可能没走）；② SDK 的 steer 是插入当前 turn 还是重置上下文（读 node_modules pi-coding-agent 的 agent-session.js dist 源码）。
2. **虚拟光标可见性低**：用户希望光标更醒目。现状：`extension/src/content/cursor.ts`，27px 品牌蓝箭头+白描边+"SideAgent" 名牌（20260903-cursor-restyle 定稿）。方向：放大/加粗描边/提高对比，具体形态先出方案。
3. **扩展刷新后残留 + 侧栏关闭后偏移**：`reload:ext` 后页面残留旧光标/高亮/mark 不消失；侧边栏关闭（viewport 变宽）后残留 overlay 位置偏移。线索：cursor.ts 三类 overlay（光标 fixed / 高亮 fixed / mark absolute 文档坐标）的 host 生命周期；MV3 reload 后旧 content script 上下文销毁但 DOM 残留，新实例无清理旧 host 的逻辑；fixed+坐标快照在 reflow 后失效。

## 完成标准

### 问题 1：steer 失忆
- [x] 1. steer 路径与普通 user_message 一样携带 page context 前缀（或证明 SDK steer 丢上下文另有根因并修复）— evaluator: 针对 session  steer/prompt 组装纯函数的单测（agent/test/session-helpers.test.ts 增补）
- [ ] 2. 真机：任务运行中插话后，agent 不再反问"哪个标签页"，延续原任务 — evaluator: 人评

### 问题 2：光标可见性
- [x] 3. 光标在浅色/深色/花哨背景上均清晰可辨（尺寸、描边、投影方案自定，参考 tldraw/ChatGPT Agent 克制基调）— evaluator: 无头 Chrome 双底色截图自检 + 人评（机器项已过：`/tmp/sideagent-overlay/cursors-three-bg.png`）
- [x] 4. 多实例光标配色区分度不劣化 — evaluator: 截图自检

### 问题 3：残留与偏移
- [x] 5. 扩展 reload 后，页面上的旧光标/高亮/mark 全部消失（content script 启动时按标识清理旧 host，或监听 unload）— evaluator: 无头自检（注入→模拟重注→断言无重复/无残留节点）+ 人评（机器项已过：`node extension/test/overlay-check.mjs`）
- [x] 6. 侧边栏开关导致 viewport 变化后，overlay 不偏移（坐标不缓存快照，渲染时实时重算；或监听 resize 重定位）— evaluator: 无头自检（改窗口尺寸断言位置跟随）+ 人评（机器项已过：mark 40→240 位移 200px）

### 通用门槛
- [x] 7. `npm run typecheck` / `npm test` / `npm run build` 全绿 — evaluator: 机器执行，未绿不交付
- [ ] 8. 完成后 `npm run reload:ext` 热重载，真机复测 — evaluator: 人评

## 边界与不做
- 不改 steer 的产品语义（插话仍是插话，不做"打断即取消"）
- 不做多 session 并行编排（路线图项）
- 不做模型选择按钮可发现性（已记录为独立遗留项，另开任务）
- 光标样式重做大改需先给用户看方案，微调可直接做

## 机器项结论（2026-09-04）

- SDK `steer()` 插入当前 turn，不丢历史；缺口是插话帧没带 page context。
- 光标：36px + 白描边 2.2 + 深色外晕 3.8。截图 `/tmp/sideagent-overlay/cursors-three-bg.png`。
- 残留/偏移：`data-sideagent-overlay` 启动清扫 + resize 按元素重算。`node extension/test/overlay-check.mjs` PASS。
- 139 tests / typecheck / build 全绿；`npm run reload:ext` 已重载 `fnbjglhppbkgmjeehablkfilmmefjolo`。
- 待人评：条目 2（真机插话）、3/5/6 的真机观感、8 真机复测。
