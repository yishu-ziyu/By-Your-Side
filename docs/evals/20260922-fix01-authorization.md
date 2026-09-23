# 任务: FIX-01 上传与共同调用边界（宿主半票）

版本日期：2026-09-22。本文件只覆盖 FIX-01 的上传授权 / 共同 call 边界半票；不覆盖 CDP 方法闸门半票，也不覆盖历史能力矩阵。

## 完成标准

- [x] 1. 同一未授权测试文件经独立 `upload_file`、`browser.upload_file`、`browser.uploadFile`、Playwright `setInputFiles` 被拦，且 `ToolRpc.call` 未收到 `upload_file` — 谁检查: `npx vitest run agent/test/browser-capability-authorization.test.ts`
- [x] 2. 授权文件经上述四入口成功；规范化 realpath / 任务 fileId 身份一致 — 谁检查: 同上
- [x] 3. 禁用 `upload_file` / `fill` 后，`browser_run` 别名不能派发等价写入 — 谁检查: 同上
- [x] 4. 实际当前 run 的 abort：排队中与进行中后续业务上传派发为 0 — 谁检查: 同上
- [x] 5. 测试打到 `createBrowserTools → call → ToolRpc`，不只测纯函数 — 谁检查: `browser-capability-authorization.test.ts`
- [x] 6. 拒绝信息不含未授权文件内容 — 谁检查: `upload-paths.test.ts` + 宿主链测试
- [ ] 7. raw CDP `DOM.setFileInputFiles` 拒绝 — 谁检查: **另一代理（CDP 半票）** `extension/test/cdp-guard.test.ts`（本半票未改、未重跑记为另一代理证据）
- [ ] 8. 真实浏览器 input/change 事件恰好一次、服务器收件为 0/1 — 谁检查: 隔离浏览器验收 — **未跑**（本半票仅宿主链 mock；`upload.ts` 已改为先计数再条件补发）

## 边界与不做

- 不改 `shared/cdp-method-policy.ts`、`extension/src/background/exec/cdp.ts`、`extension/test/cdp-guard.test.ts`、`shared/protocol.ts`、`shared/effect-policy.ts`、`agent/src/session.ts`、选择链、STATUS、历史能力矩阵。
- 不接新 power tool 到自动选择或日常入口；不 commit/push；不重载日常扩展。

## 实现要点

1. `TaskUploadLedger`：本任务最薄文件授权记录（fileId ↔ realpath）；目录白名单仍保留，但不足以单独放行。
2. `authorizeUploadPaths`：空数组 = 清空；非空必须命中账本；兼容 fileId 与绝对路径。
3. `tools.ts` 的 `call`：所有 `upload_file` RPC 派发前授权；失败 `markCallRejected`（not_executed）。
4. `browser-program.ts`：RPC 派发前再走同一 `authorizeUpload`。
5. `stagehand-bridge.ts`：`setInputFiles` 只走 `upload_file`。
6. `upload.ts`：安装计数器观察 Chrome 是否已派发 input/change；仅缺失时补发；支持清空 / multiple 前置拒绝。
7. `cdp` 工具说明改为只读观察子集口径，并含「上传文件必须走 upload_file…」固定句；method 示例仅为 `Page.getLayoutMetrics` / `DOM.getDocument`。

## 定点命令与结果

```bash
npx vitest run \
  agent/test/upload-paths.test.ts \
  agent/test/browser-program.test.ts \
  agent/test/tool-surface.test.ts \
  agent/test/browser-capability-authorization.test.ts
```

| 项 | 值 |
|---|---|
| 退出码 | 0 |
| Test Files | 4 passed |
| Tests | 67 passed |
| 失败 | 0 |

## 任务书条目 yes/no（本半票范围）

| 条目 | 结论 | 说明 |
|---|---|---|
| F1 未授权四入口（独立/runtime/alias/Playwright） | **yes** | 宿主链 mock；浏览器未接收 = 零 `upload_file` RPC |
| F1 raw CDP | **另一代理** | 不改 cdp.ts；见 CDP 半票 |
| F2 授权文件身份/别名一致 | **yes** | 四入口同源 realpath |
| F2 multiple/clear/事件次数（真实页） | **部分** | 扩展已条件补发；真实浏览器事件次数 **未跑** |
| 禁用 fill/upload 后换入口 | **yes** | 宿主 call 路径 |
| abort 排队/进行中后续派发 0 | **yes** | 宿主链；非 foreign runId |
| 超时 ≠ not_executed / 禁止立刻换 JS 重做 | **缺口（session）** | 闸在 `session.ts`，本半票未改；见协调缺口 |
| 日志不含未授权文件内容 | **yes** | 错误只含路径/身份 |
| createBrowserTools→call→ToolRpc | **yes** | |

## 协调者合并缺口

1. **`session.ts` 未接线 `uploadLedger`**：生产 run 开始时需创建账本；用户提供文件 / fetch 落盘制品需 `ledger.grant(...)`。否则合法上传在生产也会因无账本被拒。
2. **超时语义**：CDP/工具超时后禁止同任务立刻换 JS/新 run 重做——若闸在 session，需另一票或协调者改 `session.ts`。
3. **CDP 半票**：raw CDP deny 与只读白名单以 CDP 代理落盘为准；本半票只同步了 `tools.ts` 说明文案。
4. **真实浏览器 F1/F2 事件与服务器收件**：需隔离验收补跑，不能用本 mock 冒充。

---

## 生产接线补票（2026-09-22 续）

### 目的

把已实现的 `TaskUploadLedger` 接到真实会话路径：每个 `BrowserAgentSession` 持有本任务账本；`createBrowserTools` 三处传入；fetch 落盘后 `grant({ source: "task_artifact" })`。不解决用户本地文件选入 UI。

### 完成标准

- [x] 1. Lead / worker / session 回退三处 `createBrowserTools` 都能读到会话账本 — 谁检查: 代码接线 + `browser-capability-authorization.test.ts`（`workerExecution` getter）
- [x] 2. 不传账本时非空上传拒且零 RPC；空 paths 清空仍允许 — 谁检查: 同上 + `upload-paths.test.ts`
- [x] 3. 本任务 fetch 刚落盘文件可授权上传；同目录未 grant 历史文件被拒 — 谁检查: `browser-capability-authorization.test.ts`
- [x] 4. 新任务开始清空账本，不继承上一任务 — 谁检查: `session.ts` `sendUserMessage` 非流式新任务路径调用 `uploadLedger.clear()`（代码审查）

### 边界与证据

- **session.ts 回退路径**：生产 Lead 走 `conversation-runtime.ts`（始终传 `customTools`）；工人走 `fleet.ts`（始终传 `customTools`）。因此 `session.ts` 约 804 行回退 `createBrowserTools` 在日常会话里**今天不执行浏览器工具装配**。证据：`createConversationRuntime` / `Fleet.createWorkerSession` 均传入 `customTools`；`continuous-steering.test.ts` 等无 `customTools` 的 `BrowserAgentSession.create` 才会命中回退。回退仍已接上 `get uploadLedger()`，避免日后漏账本。
- **用户供文件**：`Attachment` 仅图片 base64（`shared/protocol.ts`）；仓库内无「用户明确给出的本地文件路径」生产入口。结论：**用户供文件的生产入口仍缺**（未发明侧栏选文件 UI）。
- **grant 位置**：`agent/src/tools.ts` 的 `fetch` 工具 execute——单页经 `formatFetchReply(..., onSaved)`；批量经 `batch.data.saved` 循环。`saveFetchBody` / `formatFetchReply` 本身不 grant。来源名用已有 `task_artifact`。

### 定点命令与结果

```bash
npx vitest run agent/test/upload-paths.test.ts agent/test/browser-capability-authorization.test.ts
```

| 项 | 值 |
|---|---|
| 退出码 | 0 |
| Test Files | 2 passed |
| Tests | 29 passed |
| 失败 | 0 |

### 本补票 yes/no

| 条目 | 结论 |
|---|---|
| 会话自有账本（非全局单例） | **yes** |
| 三处 createBrowserTools 传账本 | **yes** |
| fetch 落盘 grant task_artifact | **yes** |
| 历史 downloads 未 grant 仍拒 | **yes** |
| 用户本地文件生产入口 | **no（仍缺）** |
