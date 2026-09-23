# Acceptance scripts

只保留当前仍能被团队找到和重复运行的验收入口。

## 正式入口

- `npm run accept:browser`：浏览器主链。
- `npm run accept:capability`：浏览器能力对齐。
- `npm run accept:team`：多 Agent 协作。
- `npm run accept:sessions`：会话管理。
- `npm run eval:integration -- --headless`：发布集成评测。
- `npm run eval:live`：需要真实供应商或真实环境的评测。

## QA-01 任务书 v2 隔离无头验收（browser-capability-integration-v2）

```bash
# 整轮（留证用这个）
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless

# 只跑指定场景（迭代用，约 8 秒；整轮约 7 分钟）
ONLY=C5 npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S4,S6
```

场景 ID：`F1 F2 F3 F4 F4b F5 C1 C2 C3 C4 C5 S1 S2 S3 S4 S5 S6 S7`（`C6` 富文本粘贴走单独通道 `browser-capability-paste.mts`）。

**过滤轮的三个信号别混用**：

| 字段 | 含义 |
|---|---|
| `exitCode` / `status` | 本次**实际执行**的 yes/no 场景是否全 yes（过滤集内是否干净） |
| `ok` | 仅**整轮**（无 `ONLY`）且全 yes 才为 `true`。过滤轮恒为 `false` |
| `runKind` | `full` / `filtered`；`executed` 与 `filteredOut` 列出实际跑了哪些、过滤掉哪些 |

被 `ONLY` 过滤的场景**一个工具调用都不会发**，verdict 记 `未跑` 并进 `notRun`——过滤不等于通过。要证明整套通过，必须再跑一次不带 `ONLY` 的整轮。

任务专用脚本只有满足至少一条时才留在主线：

1. 被 `package.json`、本文件或另一个活跃脚本引用；
2. 是多个任务共用的驱动、fixture 或独立 oracle；
3. 属于当前发布门禁，并会产出可复验 artifact。

一次性探针在任务完成后应合入共用驱动，或随 Git 历史保留后从 HEAD 删除。评测文档记录命令、结论和证据位置，不靠永久堆积脚本保存历史。

