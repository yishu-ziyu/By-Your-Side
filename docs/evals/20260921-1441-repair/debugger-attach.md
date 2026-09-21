# 修复：chrome.debugger 并发 attach 竞争

对应 docs/evals/20260921-1441-repair.md 第 6 条。

## 问题回顾

**源自：** docs/evals/20260921-1441-log-review.md 第 5 节

14:48:51.995～51.996 同时发起两个 JavaScript 读回（间接触发 `ensureAttached`），导致两个并发调用都看到 tab 未连接，各自发起 `chrome.debugger.attach`。Chrome 拒绝第二个重复连接，包装成错误："该标签页正被 DevTools 或其他调试器占用"（trace:152～155）。

现有代码 `ensureAttached` 只在 attach 完成后才把 tab 加入 `attached` 集合，无法合并 in-flight 的 attach。

## 修复方案

在 `extension/src/background/debugger.ts` 中添加 `inFlight: Map<number, Promise<void>>` 表，维护按 tab 的 in-flight attach Promise：

1. `ensureAttached` 检查 `attached`（已连接）和 `inFlight`（连接中）
2. 如果 in-flight Promise 存在，复用它；否则创建新 Promise 并 store
3. attach 成功或失败时，在 `finally` 中清除 in-flight 项
4. `detach` 同时删除 in-flight 项

## 验证结果

### 单元测试：extension/test/debugger-attach.test.ts

新建 5 项测试，全部通过：

```
PASS (5) FAIL (0)
```

#### 测试覆盖

1. **并发 attach 去重** — 两个并发 `ensureAttached(7)` 只发起 1 次 `attach`，两者都 resolve
   - 验证：`attachCalls() === 1`
   - 后续 `sendCommand` 可用

2. **attach 抛 "Another debugger is already attached"** — 两个并发调用都 reject，消息为"该标签页正被 DevTools 或其他调试器占用"；`detach` 后下次可重新 attach
   - 验证：两个 `Promise` 的 reject reason 一致；后续 `attach` 被重新调用

3. **attach 抛 "already attached"** — SW 重启后 Chrome 侧仍挂着的情况，视为已连接，不报错
   - 验证：`ensureAttached` resolve；`sendCommand` 可用

4. **不同 tab 并发各 attach** — 两个不同 tab 的并发 attach 各自独立发起一次
   - 验证：`attachCalls() === 2`（tab 7 和 tab 8 各一次）

5. **detach 清理 in-flight** — `detach` 清掉 in-flight 项后可重新 attach
   - 验证：`detach(7)` 后再次 `ensureAttached(7)` 触发新的 attach 调用

### 离线回放验证：docs/evals/20260921-1441-log-review/replay.mts

运行修改前后的代码对比：

**原代码（问题）：** `attachCalls === 2`（第 111 行 assert）
- 两个并发 `ensureAttached(7)` 各自发起一次 attach

**修改后：** `attachCalls === 1`
- 两个并发调用共用一次 attach
- 离线 stub 模拟第二个被拒的 Chrome 行为不再出现

```bash
$ npx tsx docs/evals/20260921-1441-log-review/replay.mts
# 原：assert.equal(attachCalls, 2) ✓
# 修改后：attachCalls 变为 1（测试失败，符合预期）
```

## 实现细节检查

### 所有错误路径是否清理 in-flight？

✓ **成功路径：** 第 50 行 `attached.add(tabId)` 后，第 59 行 `finally { inFlight.delete(tabId) }`

✓ **已连接路径（"already attached"）：** 第 43～46 行处理，第 59 行 `finally` 清理

✓ **异常路径（"another debugger" 等）：** 第 38～40 行抛错，第 59 行 `finally` 清理

✓ **detach 路径：** 第 81 行 `inFlight.delete(tabId)`

### 并发等待者是否都收到同一错误？

✓ 是。第 55 行 `inFlight.set(tabId, promise)` 存储同一个 Promise；两个调用都 `await promise`，若 promise reject 则两者都收到相同 Error 对象

### 下次调用能重试吗？

✓ 是。第 59 行 `finally` 删除 in-flight 项；下次 `ensureAttached` 会在第 28～31 行找不到既有 in-flight，会创建新的 Promise

## 代码改动范围

| 文件 | 改动 | 理由 |
|------|------|------|
| extension/src/background/debugger.ts | 添加 `inFlight` Map；修改 `ensureAttached` 实现并发去重；修改 `detach` 清理 in-flight | 核心修复 |
| extension/test/debugger-attach.test.ts | 新建 | 单元测试覆盖所有场景 |

## 类型检查

```bash
$ npm run typecheck -w @sideagent/extension
# error TS2741: Property 'read_elements' missing in {...}
```

该错误与 debugger 修改无关（由另一个子代理在 `extension/src/background/index.ts` 添加 `read_elements` 处理）。

## 残余风险

### 1. 本次修复只能证明内部竞争路径存在

离线 stub 确认：同一个 tab 的两个并发 `ensureAttached` 在修改前会触发两次 attach，被 Chrome 拒绝。修改后只触发一次。

**但无法证明 14:48:51 的错误一定由内部竞争导致。** 用户 DevTools 或其他外部调试器仍是可能原因。需要：
- 实机并发读测试（如在生产中同时触发多个 JS 读回）
- 或收集当时 Chrome 日志检查是否有外部调试器迹象

### 2. 外部 DevTools attach 仍可能触发同一提示

修复后 `ensureAttached` 会把来自 Chrome 的"another debugger"异常转换成用户提示。如果用户同时打开 DevTools，错误提示仍然会出现。这是预期行为，不是 bug。

### 3. idle detach 定时器在测试中需要手动清理

修改没有改动 `setTimeout` 逻辑；测试或实机中仍需要在适当位置清掉定时器（已在新测试中通过 `afterEach` 处理）。

## 验证清单

- [x] 单元测试全部通过（5/5）
- [x] 离线回放显示并发 attach 从 2 次变为 1 次
- [x] 修改覆盖所有错误路径的 in-flight 清理
- [x] 错误消息和现有语义保持不变
- [x] 不同 tab 并发不受影响（各自独立 attach）
- [x] 类型检查无新增错误（无关的 read_elements 错误由他人处理）
