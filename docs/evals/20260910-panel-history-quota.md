# 任务: 侧栏历史不再写爆扩展存储，断线不再因恢复失败而永久发生

2026-09-10 23:23 真机：侧栏显示「未连接」。排查结论：后台 service worker 没有运行，因此没有进程去拉伴随进程。
进一步查后台异常，发现 `chrome.storage.local` 已被 `history:<会话 id>` 键写满——10,485,715 / 10,485,760 字节（99.9996%），
后台持续抛 `Resource::kQuotaBytes quota exceeded`，草稿、教学模式、标注动效、token 全部静默写入失败。

成因：`background/index.ts` 每个会话把整份面板历史（含每条 thinking 增量）写进一个 `history:` 键，108 个会话各一份、从不清理，最大单键 905 KB、合计 9.65 MB。
另有脆弱点：唯一拉起宿主的 `transport.start()` 写在 storage 读取的 `.then()` 里且无 `catch`，该链一旦 reject 就不会连接、也不再重试。

用户已批准方案，并先手工清空现存键（备份 `~/.sideagent/backups/panel-history-2026-09-10T15-46-13.jsonl`，9.85 MB / 108 键，逐行校验可解析）。

## 完成标准

- [ ] 1. 单个会话落盘的历史有上限：从最新往回取，超过 256 KB 即截断，非空历史至少保留 1 条。— 谁检查: `npx vitest run extension/test/panel-history.test.ts`
- [ ] 2. 只保留最近 8 个会话的 `history:` 键，更旧的删除；排序按 `updatedAt`，旧格式（裸数组）视为最旧。— 谁检查: 同上
- [ ] 2c. 只有 status 条目、没有实际内容的会话不落盘（服务端给每个会话都推状态，否则一次连接就写满一轮键）。— 谁检查: 同上
- [ ] 2b. 清理不能只在启动时跑：服务端给每个会话都推 status，一次 idle 就落盘一个会话键；会话进行中也要收敛到 8 个。— 谁检查: CDP 实测键数
- [ ] 3. 落盘失败不再产生未处理异常。— 谁检查: 代码检查 + 全量测试
- [ ] 4. 恢复兼容两种形状：新版 `{updatedAt, entries}` 与旧版裸数组。— 谁检查: 同上
- [ ] 5. `transport.start()` 不再依赖 storage 恢复成功：恢复抛错也要连接，且失败有日志。— 谁检查: 代码检查
- [ ] 6. 全量回归：`npm test` / `npm run typecheck` / `npm run build` 通过。— 谁检查: 上述三条命令
- [ ] 7. 重载扩展后连续使用，`chrome.storage.local` 用量保持在小量级（< 3 MB），写入自检成功。— 谁检查: 人 + CDP 读数

## 实施中发现（原方案没覆盖）

清空后只过了一小时，存储又长出 **119 个 `history:` 键**。查键内容：全是 `status` 类型的条目——服务端会为**每个会话**推送状态，`recordAndBroadcastHistory()` 在 `status idle` 时落盘，于是「每个会话一个键」是被这条路径批量写出来的，而不只是历史积累。
只做启动时清理不够（后台在一次生命周期里就能写满所有会话的键），因此补了合并清理：每次落盘请求一次延后 5 秒的清理，多次落盘只触发一次。

## 边界与不做

- 不改内存里 PanelHistory 的 5000 条上限与 seq 语义，只截断落盘的那一份。
- 不动草稿键（用户输入内容），不做自动清理。
- 不改协议与面板侧渲染。
- 本轮不重载用户扩展：重载时机由用户的光标验收决定（重载会断开面板约 10 秒）。

## 证据

改动：

- `extension/src/background/panel-history.ts`：新增 `HISTORY_PERSIST_BUDGET_BYTES`（256 KB）、`StoredPanelHistory`、`historyUpdatedAt`、`historyKeysToDrop`；`PanelHistory.persistWindow()`（从最新往回按 **UTF-8 字节**取窗口，非空历史至少留 1 条）；`restore()` 兼容 `{updatedAt, entries}` 与旧版裸数组。
- `extension/src/background/index.ts`：`flushHistory()` 落盘窗口 + 写失败打日志（不再产生未处理异常）；新增 `pruneStoredHistory(8)` 在启动恢复时清理更旧的会话键；启动链从 `.then()` 改为 `try/catch` + 末尾无条件 `transport.start()`。

| 层 | 入口 | 结果 |
| --- | --- | --- |
| 定向单测 | `npx vitest run extension/test/panel-history.test.ts` | PASS：14 项（新增 5 项：截断窗口、单条超预算仍留最新一条、空历史、按 updatedAt 保留最近 N、两种形状恢复） |
| 全量 | `npm test` | 136 文件 1127 项通过（原 1122 + 新增 5） |
| 类型检查 | `npm run typecheck` | 两个 workspace 通过 |
| 构建 | `npm run build` | 通过；`background.js` 由 `4937ea3a4631…` 变为 `16bb80df7e1b…`（**尚未重载，用户运行中的仍是旧代码**） |
| 手工清空（用户批准） | CDP 读 `chrome.storage.local` | 10,485,715 → 5,804 字节（释放 9.99 MB）；写自检由 `Resource::kQuotaBytes quota exceeded` 变为成功；备份 `~/.sideagent/backups/panel-history-2026-09-10T15-46-13.jsonl`（9.85 MB / 108 键，逐行可解析） |

既有测试同步更新（落盘形状变化，断言意图未变）：`extension/test/session-management.test.ts`、`extension/test/delivery-receipt.test.ts` 改为读 `{updatedAt, entries}.entries`。

## 未跑 / 待办

- 标准 7：重载扩展后的实测（连续使用后 `chrome.storage.local` 是否保持小量级、写自检是否仍成功）——重载时机等用户的光标验收结束后再定。
- 落盘窗口对面板回放的实际影响（后台重启后能恢复多少历史）未在真机上复核。

## 实测（重载后）

`npm run reload:ext` 已重载（新代码生效）。重载前存储里有 119 个 `history:` 键 / 555,037 字节；重载后后台启动即清理：

第一轮（只有「启动时清理」）实测到问题：连上后键数会从 8 跳到 **124**、用量到 590 KB，5 秒后才回落——说明清理时机不够，且键是被 status 批量写出来的。补了「只剩 status 不落盘」后再测：

| 时点 | history 键 | 存储用量 |
| --- | --- | --- |
| 修前（旧代码跑一小时） | 119 | 555,037 字节 |
| 只做启动清理，连上瞬间 | 124（峰值） | 590,761 字节 |
| 最终版本，连续 40 秒 | 8（峰值 9） | 60,216 字节 |

运行中的 `background.js` 与磁盘构建逐字节一致（CDP 取回比对，hash `a0af82a7de5f3a6e`）。重载会关闭侧栏页面，需要用户重新点开（属预期，不是故障）。

