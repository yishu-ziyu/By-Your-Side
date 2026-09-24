# 任务核心搬进扩展（④）工作流

开始：2026-09-24。每完成一步更新本页并与代码同一提交。上下文压缩或换会话后，从「当前位置」接着做。

## 目标与硬门槛

- 目标：扩展里只跑一套任务核心（与本机伴随进程同一份代码），`extension/src/inproc/host.ts` 的简化循环退役。
- 硬门槛：`extension/test/entry-contract.test.ts` 里扩展入口的 4 条契约全部通过并去掉 `it.fails`；本机入口保持 4/4；`inproc-mark --via-settings` 与 `inproc-voice --voice=...` 两条真实路径通过；`check:architecture` 不再报 extension → agent 直接导入。
- 不可接受的替代：给简化循环逐条补丁；放松契约或验收判据；屏蔽架构检查。

## 当前位置

- [x] ① 分批提交（`2793c42`、`de381b0`）
- [x] ② 语音 key 只给本扩展发起的连接（`d19cb33`，判据 `pageCannotBorrowKey`）
- [x] ③ 双入口契约（`6ede6ab`）；构建改用直接依赖（`b662dc7`）
- [x] 4a 会话层接口：`agent/src/agent-loop.ts` 的 `AgentLoop`（按 TS 类型检查器统计的真实访问：AgentSession 16 个成员 + `agent.state.tools/messages`、`agent.waitForIdle`、`sessionManager.appendCustomEntry/getBranch`）。本机直接传 AgentSession，纯类型改动；session 相关 40 个测试文件 520 通过，2 个失败与改动前相同（repository-boundaries、task-recovery-matrix）
- [x] 4b 工具调用身份显式传递：`tools.ts` 用 `makeCall(scope)` 绑定每次执行的身份，每次执行按需生成绑定身份的工具定义（定义内部无跨调用状态，已核对）。新测试 `agent/test/tool-execution-scope.test.ts`（交错的 download_delete；换成全局变量实现会变红，已做变异验证）。工具/会话相关 61 个文件 844 通过；失败 3 个：两个与改动前相同，browser-program 超时用例单独连跑 3 次都过（负载下计时不稳）。本机真实路径 point-then-mark 通过（首跑遇供应商 500 ×8 失败，改动前代码同时段通过，重跑通过）
- [ ] 4c 浏览器版会话实现：pi-agent-core `Agent` + 钩子适配 + 自定义消息 + 条目存储 + 系统提示词重建
- [ ] 4d 浏览器替身：同步 sha256、Buffer、`crypto.randomUUID`、`process.env` 不读；回执/队列内存存储；轨迹、记忆、技能、下载空实现
- [ ] 4e 扩展改用同一核心：`inproc/main.ts` 启动 ConversationManager；语音调度走 `dispatchTaskAction`（修语音停止）；删除 `host.ts` 简化循环
- [ ] 4f 真实路径 + 架构检查 + 文档（STATUS、handoff）

## 每步验收

| 步 | 验收 |
|---|---|
| 4a | `agent` 类型检查；会话相关测试（continuous-steering、session-helpers、browser-loop-direct-delivery 等）与本机入口契约 4/4 不变 |
| 4b | 同上，另加：并行两个工具调用各自带对的身份（新测试） |
| 4c | 同一组可用工具下，Node 与浏览器两种实现给模型的系统提示词逐字一致（新测试）；浏览器实现跑本机入口契约 4/4 |
| 4d | 按浏览器环境打包任务核心（esbuild platform=browser）无 Node 内置模块残留 |
| 4e | 扩展入口契约 4/4，去掉 `it.fails`；语音停止契约（新增） |
| 4f | 两条真实路径通过；`check:architecture` 通过 |

## 已定的决定

- 第一版只保文字任务主线：开始、补充、停止、工具调用、回执、去重、版本校验。记忆、技能、经验、下载、上传、诊断轨迹、上下文压缩先关。
- 不把 `pi-coding-agent` 的 AgentSession 打进扩展（浏览器打包 7.8 MB，拉入 pi-tui、undici、child_process）。
- 回执与队列第一版只放内存；offscreen 重启后的去重持久化以后再做（接口按「启动全量读入、同步读写、异步回写」设计）。
- 一条 main、不开工作树；每步只跑相关测试 + 必要的真实路径，全量测试留到发布前。

## 已知风险（容易悄悄出错）

1. **工具身份串号**：`tools.ts:121` 的 `executionScope` 靠 AsyncLocalStorage；pi-agent-core 默认并行执行工具（`agent.js:134`）。用全局变量模拟会串号 → 4b 改成显式传递。
2. **系统提示词悄悄变了**：AgentSession 的 `setActiveToolsByName` 会重建系统提示词，把工具的 `promptSnippet`/`promptGuidelines` 拼进去（`agent-session.js:659-770`）。浏览器实现只过滤工具不会报错但指令变了 → 4c 的逐字一致测试。
3. **同步哈希**：`createHash('sha256')` 分布在 12 个模块；`subtle.digest` 是异步的，不能直接替换。
4. **真实路径要屏幕解锁**：锁屏时无窗口 Chrome 的侧栏视口是 0×0，连干净 HEAD 也失败，不是代码问题。
5. **不要直接跑 `extension/build.mjs`**：会重写日常 Chrome 加载的 `extension/dist`；验收脚本会构建到独立目录。

## 参考

- 调研结论（2026-09-24，两份只读调研）：会话层依赖面与替代方案；任务核心 Node 依赖清单。要点已并入上面的风险与决定。
- 评审原文五项问题与契约的对应：执行事实 → heldClick；会话归属 → ownership；重复请求 → duplicate；过期修订 → staleSteer；语音停止 → 4e 新增。
