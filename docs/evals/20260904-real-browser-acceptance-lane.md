# 任务: 真实浏览器任务验收跑道 —— 一条命令证明扩展真的看见、点击、填写并识别页面变化

本标准由 Codex（校验）在 Grok（实现）动手前锁定。Grok 不得修改本文件或扩展生产代码。

```
Change:     在本地确定性网页上，一条命令驱动已构建、已加载的 SideAgent 扩展走真实 Chrome 执行链，完成读取当前页、点击、填写、页面变化后的重新读取，并留下可复核证据。
Not this:   只跑纯函数单测；直接用 Playwright 操作网页绕过扩展；用截图存在冒充动作成功；访问或改写用户的真实网站数据。
Evaluator:  Codex 重跑命令、检查退出码和证据；现有 typecheck/test/build 作为回归证据。
Evidence:   每步结构化结果、最终页面状态、截图和失败分类，写入临时证据目录，不提交用户数据。
```

## 完成标准

- [x] 1. 新增一个确定性本地 fixture，至少包含：可读文本、点击后计数器变化、可填写输入框、一次 DOM/页面状态变化。fixture 不依赖外网。— 谁检查: Codex 读 fixture + 实际打开
- [x] 2. 提供一条稳定命令运行整条验收；成功退出 0，任一步失败退出非 0，并在终端逐项打印 PASS/FAIL 和失败阶段。— 谁检查: Codex 重跑
- [x] 3. 验收必须经过已加载扩展的真实 background/content-script/CDP 执行链；禁止让 Playwright、Puppeteer 或浏览器脚本直接代替扩展完成点击、填写或读取。— 谁检查: Codex 代码审查 + 运行日志
- [x] 4. 自动路径至少验证四件事：snapshot 读到 fixture 唯一文本；click 使计数器发生预期变化；fill 产生预期输入值；页面变化后重新 snapshot 能看到新状态。— 谁检查: 命令输出 + 最终 DOM 断言
- [x] 5. 每次运行在独立临时目录写出 `result.json` 和关键截图；`result.json` 包含步骤、耗时、预期、实际结果和失败类别，不包含 cookie、token、完整浏览历史或其他页面内容。— 谁检查: Codex 查看证据
- [x] 6. 只连接用户的自定义 `local.yishu.chrome-main` Chrome 实例；不启动或控制 `com.google.Chrome`，不清理、重置或关闭现有 Chrome。找不到正确实例或扩展时明确失败并给出恢复说明。— 谁检查: 进程/连接信息 + Codex
- [x] 7. 同一 fixture 连续运行三次均通过；每次开始前重置 fixture 状态，运行之间不相互污染。— 谁检查: Codex 连续重跑
- [x] 8. `npm run typecheck`、`npm test`、`npm run build` 全绿；新增验收脚本自身的聚焦测试覆盖成功、步骤失败和证据脱敏。— 谁检查: 机器

2026-09-05 Codex 复核：`npm run accept:browser` 连续三次通过，实际路径为 `uplink.handleRaw → onServerMessage → executeToolCall → gate.run → handlers`；证据目录 `/var/folders/k6/7c96rbxd1r782myg_bnlqshw0000gn/T/sideagent-acceptance-2026-09-04T16-34-53-269Z`。`npm run typecheck`、252 项测试、`npm run build` 均通过。

## 文件所有权

Grok 只可新增或修改以下范围：

- `scripts/acceptance/**`
- `extension/test/fixtures/acceptance/**`
- `extension/test/acceptance-*.test.*`
- 如确有必要，可在根 `package.json` 只新增一个验收命令；不得改现有脚本语义

不得修改：

- `shared/protocol.ts`
- `agent/src/**`
- `extension/src/**`
- `scripts/reload-ext.mjs`
- `docs/ROADMAP.md`、`docs/NOTES.md`
- 本完成标准

## 边界与不做

- 本任务建设验收跑道，不修复跑道暴露出的产品缺陷；失败要如实分类并交回编排。
- 不访问 flomo、B 站、邮箱等真实账号页面。
- 不复制或输出浏览器凭据。
- 不建立通用 E2E 框架；只做这条最小核心路径。
- 不验收正在开发的接管/交接；它有独立标准。
