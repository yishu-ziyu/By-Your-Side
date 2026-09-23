# 任务: CAP-02C 定位 / frame / select / 等待四态 / 截图选项

## 完成标准

- [x] 1. `loc=role:` 按可访问名（≠ textContent）唯一命中；歧义失败 — 谁检查: vitest `extension/test/cap02c-locator.test.ts` + `target.test.ts`
- [x] 2. 开放 Shadow DOM 内 CSS 可命中 — 谁检查: 同上（嵌套 open shadow 反例）
- [x] 3. 同源 iframe 有作用域（先 top 再 frame；多命中歧义）— 谁检查: 同上
- [ ] 4. 真实跨站 OOPIF child/flat session 可操作 — 谁检查: 隔离浏览器 — **未跑**（已落地 `ensureChildFrameSessions` / `sendCommandOnSession` 登记面；无真实跨站 target/session 证据）
- [x] 5. `select_option` value/label/index、多选、清空；回执最终选中集合 — 谁检查: vitest selectOption + 工具接线
- [x] 6. `waitFor` state=attached|detached|visible|hidden|visible+enabled — 谁检查: vitest waitFor 四态 + `browser-program.test.ts`
- [x] 7. screenshot `fullPage` / `clip` / `scale`；clip CSS 与点击坐标同系 — 谁检查: 工具接线 + clip 契约单测（真实 CDP 全页/局部 **未跑隔离浏览器**）
- [x] 8. 不进 Realtime 固定工具表；不改 CAP-02A/B 语义；`:has-text` 仍拒绝 — 谁检查: vitest
- [x] 9. 矩阵状态列保持 NOT_RUN — 谁检查: 人（未改 PASS）

## 边界与不做

- SEL-01/02/03
- `:has-text` / `:text-is` / `>> nth` 兼容子集（未做正式语义，保持拒绝）
- 把新定位塞进 Realtime / 让 Jev 选择
- 重写 `shared/network.ts`；不把 FIX-02 network-idle 改回 quiet 冒充
- 改掉 CAP-02A arm/download/dialog 与 CAP-02B wheel/mouse/key/paste/html5_drag 语义
- commit / push / 重载日常 / 新建 worktree

## 矩阵行结论（相对 `20260922-ego-fixed-sha-behavior.md`，状态列仍 NOT_RUN）

| 行 | 结论 | 说明 |
|----|------|------|
| 37–38 role+name / name* | yes（单测） | `loc=role:` 已解析；ARIA≠textContent |
| 39 loc=href | yes（入口） | 已解析；无独立隔离浏览器案 |
| 40 open shadow CSS | yes（单测） | queryAllOpenShadow |
| 41 同源 frame 作用域 | yes（单测） | top 先、再 frame、歧义失败 |
| 42 snapshot subtree/root | 未做 | 未扩 snapshot.scope |
| 43 真实跨站 OOPIF | 未跑 | child session 脚手架有；无跨站证据 |
| 44 frame 替换 / 跨 session 同 backendNodeId | partial | 旧 ref 失效仍拒；OOPIF session 身份未真实复验 |
| 45–47 selectOption | yes（单测+接线） | 新 RPC `select_option`；fill 单值仍保留 |
| 48–49 attached/detached | yes（单测） | waitFor state |
| 51 hidden | yes（单测） | 不等于「可见且启用」 |
| 52 waitForURL | 未做 | |
| 53 networkidle | 以 FIX-02 为准 | 不改 quiet 冒充；本票未动 network.ts |
| 55 goto waitUntil | 未做 | |
| 56–59 screenshot 选项 | partial | 协议/实现有 fullPage/clip/scale；隔离浏览器未跑 |
| 62 snapshot includeStableLocator | 未做 | |
| 65 :has-text 子集 | 未做 | 仍明确拒绝 |
| 67–68 focus / press(sel) | 未做 | |

## 命令与退出码

```bash
npx vitest run extension/test/cap02c-locator.test.ts extension/test/target.test.ts \
  agent/test/browser-program.test.ts agent/test/cap02a-events.test.ts agent/test/cap02b-input-wiring.test.ts
# 退出码 0；53 passed

npx vitest run extension/test/hover-recovery.test.ts extension/test/click-integrity.test.ts \
  extension/test/cap02c-locator.test.ts …（含上述）
# 退出码 0；84 passed（含 hover/click 回归）
```

隔离无头真实浏览器：**未跑**。

## 主要改动文件

- `extension/src/shared/target.ts` — role/href/shadow/frame 解析
- `extension/src/content/domops.ts` — selectOption；统一 resolveArgs
- `extension/src/background/exec/read-element.ts` — 对齐共享定位
- `extension/src/background/exec/input.ts` — selectOption RPC 实现
- `extension/src/background/exec/screenshot.ts` — fullPage/clip/scale
- `extension/src/background/exec/upload.ts` — resolveArgs
- `extension/src/background/debugger.ts` — OOPIF child session 登记脚手架
- `extension/src/background/index.ts` / `shared/protocol.ts` / `shared/control.ts` / `shared/task-results.ts`
- `agent/src/tools.ts` / `agent/src/browser-program.ts` / `agent/src/prompt.ts`
- `extension/test/cap02c-locator.test.ts` / `extension/test/target.test.ts`

## 当前是否已满足

**部分满足**用户结果：可访问名、open shadow、同源 iframe、select 多选清空、等待四态、截图选项面已有正式路径与单测证据。真实跨站 OOPIF 与隔离浏览器截图/frame 案 **未跑**；`:has-text`、snapshot subtree、waitForURL 等矩阵行 **未做**。
