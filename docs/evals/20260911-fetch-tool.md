# 任务：数据层工具第一步 —— `fetch`（带登录态取接口，结果落盘）

用户 2026-09-11 批准按顺序做大件（数据层工具）。本文件是实施前冻结的标准；本轮只做 `fetch` 切片，`network`（被动看页面调了哪些接口）与批量翻页/`download` 留后。

**目标（用户可观察）**：抓数据类任务不再只能 snapshot/js。Agent 能带当前浏览器的登录态直接取接口，大响应落盘、只把摘要和路径带回上下文。

## 结果（2026-09-11）

- 机器：`npm test` 148 文件 1277 项、typecheck 0 错误、build 通过（新增 `extension/test/fetch-guard.test.ts` 5 项、`agent/test/fetch-format.test.ts` 4 项）。
- 实现中发现并修掉一个真缺陷：`savePath` 含 `/` 时本应退回生成名，首版却仍用原串，形成路径穿越（`../../etc/passwd` 会写到上级目录）。已改为一律取 `basename` 并过滤，测试断言跟着覆盖。
- 边界全部由扩展侧拒绝（本地/私网、非 http(s)、GET/POST 之外、GET 带 body）；`Cookie`/`Host` 不采纳调用方覆盖。
- **第 6 条（真实站点样本）已于同日补跑**：隔离 headless Chrome 加载真实构建的扩展，B 站视频页与 Hacker News 首页两个样本，fetch 进上下文 538 / 527 字符，同页 snapshot 11,541 / 23,786 字符（1:21、1:45）；私网守卫在生产路径上复验拒绝且不产生请求。原始数字见[真实站点对比](20260911-fetch-real-site.md)。
- 进上下文的内容同样过不可信边界与凭据隐去；落盘文件不脱敏（用户自己的数据），文档已写明。

## 完成标准

- [x] 1. 新工具 `fetch{url, method?, headers?, body?, savePath?}`：默认 GET，只允许 GET/POST；只接受 http(s)；拒绝本地/私网地址（127.0.0.1、localhost、10./172.16-31./192.168.、[::1]、*.local、.internal）。 — 谁检查: npm test（`extension/test/fetch-guard.test.ts` 纯函数）
- [x] 2. 带登录态：请求由扩展发出，`credentials:"include"`；Cookie 不出扩展边界。 — 谁检查: 代码评审 + 真实站点样本（见 6）
- [x] 3. 大小上限 512 KiB：超出截断并在回执里明确 `truncated`；响应体只经 RPC 回给伴随进程，不回侧栏。 — 谁检查: npm test（guard）
- [x] 4. 落盘：>4000 字符或显式 `savePath` 时由伴随进程写入 `~/.sideagent/downloads/`，回执只给路径、字节数、状态码、content-type 与 300 字预览；小响应直接内联。 — 谁检查: npm test（`agent/test/fetch-format.test.ts`，假 RPC）
- [x] 5. 进模型的响应内容同样过不可信边界 + 凭据隐去（与 snapshot 一致）。 — 谁检查: npm test（同上）
- [x] 6. 真实站点样本：对同一份数据，`fetch` 一次调用的上下文占用低于 snapshot（耗时如实记录，不宣称更快）。 — 谁检查: 隔离 harness 两个真实样本；见[本轮补跑](20260911-fetch-real-site.md)
- [x] 7. 全量测试、typecheck、build 通过。 — 谁检查: `npm run typecheck && npm test && npm run build`

## 边界与不做

- 不做被动 `network` 观测（CDP Network 域 + 环形缓冲），下一轮。
- 不做扩展侧翻页/批量；翻页由模型多次调用（保持单次调用语义简单）。
- 不做 `download`（浏览器原生下载）与文件上传。
- 不做写类方法（PUT/PATCH/DELETE）——需要时再单独授权，避免"取数据"顺手改成"改数据"。
- 落盘文件不脱敏（是用户自己的数据）；只有进上下文的部分隐去凭据。
- 不改执行事实/控制闸门：`fetch` 是只读类工具（不改页面），但受工作页无关的控制权约束照旧（接管期间不执行）。
