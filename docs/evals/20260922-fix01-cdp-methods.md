# 任务: FIX-01 半票 — raw CDP 方法与资源边界

## 完成标准

- [x] 1. 未授权场景下 raw CDP 调用 `DOM.setFileInputFiles`：`sendCommand` 未被调用，结果 `not_executed`，错误指向 `upload_file` — 谁检查: `npx vitest run extension/test/cdp-guard.test.ts`
- [x] 2. `Runtime.evaluate` 及列入的动态代码方法默认不执行 — 谁检查: 同上
- [x] 3. 伪造 `tabId` / `sessionId` / `targetId` 不能换目标 — 谁检查: 同上
- [x] 4. 现存仓库内合法只读 raw CDP 调用仍被允许；允许集手写在测试中 — 谁检查: 同上
- [ ] 5. 上传四入口宿主链（独立工具 / runtime / alias / Playwright）— 谁检查: 另一代理（本半票不做）
- [ ] 6. F1/F3 真实宿主与取消语义全量 — 谁检查: 另一代理 / 后续；本半票仅纯策略 + 扩展 `cdp()` 前置拒绝

## 边界与不做

- 不改 FIX-02、CAP、SEL；不改上传实现与 `agent/src/tools.ts` 等禁止文件。
- 不降低 `upload_file` 合法上传能力（正式入口仍走 `exec/upload.ts` 的内部 `sendCommand`，不受本允许集约束）。
- 控制闸门（`effect-policy` 对 `cdp` 恒为写）保留，不代替方法拒绝；本半票未改 `shared/effect-policy.ts`。
- 危险拒绝只在纯策略/单测；未用 `Browser.close` 探测日常扩展。

## 允许集（手写）

经 raw `cdp` 工具可执行的只读观察子集：

```text
Page.getLayoutMetrics
Page.getFrameTree
DOM.getDocument
DOM.describeNode
DOM.getAttributes
DOM.getBoxModel
DOM.getContentQuads
DOM.getNodeForLocation
DOM.querySelector
DOM.querySelectorAll
```

依据：验收 Case 4 实际调用 `Page.getLayoutMetrics`；工具说明中的只读示例含 `DOM.getDocument`。其余仓库内 CDP（`Input.*` / `Runtime.*` / `DOM.setFileInputFiles` / `Network.enable` 等）走正式执行器内部 `sendCommand`，不经本 escape hatch。

## 拒绝集（代表性）

| 类别 | 方法示例 | 错误指向 |
|---|---|---|
| 文件送入页面 | `DOM.setFileInputFiles` | 正式入口 `upload_file`，`not_executed` |
| 文件读出/写出 | `Page.printToPDF`、`Page.setDownloadBehavior`、`IO.read`、`Page.captureScreenshot` | 未支持 / 文件行为 |
| 动态代码 | `Runtime.evaluate`、`Runtime.callFunctionOn`、`Runtime.addBinding`、任意其余 `Runtime.*`、`Page.addScriptToEvaluateOnNewDocument`、`Emulation.setEmulatedMedia` | 动态代码拒绝 |
| 输入注入 | 任意 `Input.*` | 请用正式 click/fill/press 执行器 |
| Profile / 浏览器级 | `Network.clearBrowserCookies`、`Network.setCookie`、任意 `Network.*` / `Storage.*`；`Browser.*` / `Target.*` / `Debugger.*` / `Inspector.*` / `Chrome.*` | 越权 / profile 级 |
| 身份绕行 | 命令参数中的 `sessionId` / `targetId`；非工作页 `tabId` | 只绑当前工作标签 |
| 未知 | 不在允许集内的一切方法 | 默认拒绝（未支持） |

不确定但已拒绝（报告列出）：`HeapProfiler.*`、`Tracing.*`、`Memory.forciblyPurgeJavaScriptMemory` 等 — 按越界或文件/内存侧效应拒绝，未放行。

## 超时与截断语义（未改）

- 超时：可能已送达，不标 `not_executed`，不声称回滚。
- 截断：仅表示输出有界。

## 命令与证据

```bash
npx vitest run extension/test/cdp-guard.test.ts
```

```text
Test Files  1 passed (1)
Tests       15 passed (15)
退出码      0
```

## 本半票结论

**yes** — raw CDP 方法与资源边界（扩展侧 + 共享策略 + `cdp-guard` 单测）已满足本半票固定契约。

上传四入口 / F1 全路径宿主测试：**另一代理**。F3 真实 abort 派发：**未跑**（本半票范围外）。

## 需协调者同步

`agent/src/tools.ts` 里 `cdp` 工具说明仍举例 `Runtime.evaluate` / `Emulation.setEmulatedMedia` 及「只拒 Browser/Target… 前缀」——请改成「仅允许只读观察子集，其余未支持；上传用 upload_file」。
