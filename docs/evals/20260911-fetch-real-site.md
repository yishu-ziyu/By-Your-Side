# 任务：`fetch` 真实站点前后对比（数据层第一步补最后一条证据）

`fetch` 已落地（见[本轮标准与证据](20260911-fetch-tool.md)），唯一没跑的是第 6 条：真实站点上「同一份数据，fetch 一次调用比 snapshot 省多少」。验收 harness 的 fixture 服务在本机回环地址，会被 `fetch` 的私网守卫按设计拒绝，必须换真实公网站点。

**目标（用户可观察）**：拿真实页面的同一份数据，`fetch` 进上下文的字符数明显低于 snapshot，且 fetch 返回的字段与页面显示的是同一份；数字有原始记录，不是估算。

## 完成标准

- [x] 1. 真实路径：headless Chrome for Testing 加载**真实构建的扩展**，通过生产 `executeToolCall` 路径调用 `fetch`（真实网络请求）与 `snapshot`（真实 CDP AX 树），不重写这两个工具。 — 谁检查: `node node_modules/tsx/dist/cli.mjs scripts/acceptance/fetch-realsite-run.mts`（先 `npm run build`）
- [x] 2. 至少两个真实站点样本；每个样本里 `fetch` 返回的字段值能在同页 snapshot 文本中找到（证明两份材料是同一份数据，而不是拿两个无关数字对比）。 — 谁检查: 脚本断言 + 原始输出
- [x] 3. 上下文占用：同一份数据，`fetch` 的模型可见字符数 < `snapshot` 的模型可见字符数；记录精确数字。模型可见 = 走生产格式化代码（agent 侧 `formatFetchReply` / `wrapPageContent(redactCredentialText(...))`）之后进入上下文的文本。 — 谁检查: 脚本输出 + 人看数字
- [x] 4. 耗时：记录两者各自的墙钟毫秒与 fetch 的 HTTP 字节数；不预设 fetch 一定更快（fetch 是真实网络往返，snapshot 是本地 CDP），数字只作事实记录。 — 谁检查: 脚本输出
- [x] 5. 私网守卫在真实扩展路径上仍然拒绝：从已加载的扩展里 fetch `http://127.0.0.1:<fixture>/`，必须报「拒绝本地/私网」且不产生请求；公网地址同一路径可通。 — 谁检查: 脚本断言（`npm test` 只覆盖纯函数，这条补真实路径）
- [x] 6. 机器检查：`npm run typecheck && npm test && npm run build` 通过。 — 谁检查: 命令

## 结果（2026-09-11）

原始数字见[运行结果](20260911-fetch-real-site-results.json)。所有检查 PASS，两个样本的 fetch 字段都命中同页 snapshot：

| 样本 | fetch 返回字段在 snapshot 里 | fetch 上下文 | snapshot 上下文 | 比值 | fetch 耗时 | snapshot 耗时 |
|---|---|---:|---:|---:|---:|---:|
| B 站视频页 `BV1GJ411x7h7`（匿名 view 接口，7,507 B） | 标题 + UP 主 2/2 | 538 字符 | 11,541 字符 | 1:21 | 112ms | 296ms |
| Hacker News 首页（Algolia front_page 接口，17,624 B） | 前 5 条标题命中 3 条 | 527 字符 | 23,786 字符 | 1:45 | 753ms | 46ms |

- 两个响应都超过 4,000 字符，走的是生产「落盘 + 只回状态行与 300 字预览」路径；这就是上下文从五位数掉到三位数的原因。
- 耗时是事实记录，不构成“fetch 更快”：HN 上 snapshot 是本地 CDP（46ms），fetch 是真实外网往返（753ms）。省的是上下文，不是固定省的延迟。
- 私网守卫在生产路径上复验：`fetch http://127.0.0.1:<fixture>/private-probe` 回「拒绝本地/私网地址」，且 fixture 服务计数在调用前后不变（2 → 2），证明拒绝发生在请求之前。
- 隔离：临时扩展目录删掉 manifest `key`（随机扩展 ID），所以连不上用户正在跑的伴随进程；扩展 JS 与 `extension/dist` 逐字节相同。未加载、未重载用户浏览器里的扩展。
- GitHub issues 页曾作为第三样本尝试：headless 里客户端渲染的 issue 列表为空（原始 snapshot 只剩 “Search results” 标题与分页，无行），fetch API 本身 200。这是页面渲染问题，不是 fetch 缺陷，未计入验收样本。

## 未跑 / 不做

- **登录态未验**：本轮不建、不使用任何真实账号；只打匿名公开接口。「Cookie 只在扩展与目标站点之间流动」仍由代码评审 + 既有单测支撑，不因本轮样本宣称已验。
- 不启动、不修改、不重载用户的 ChromeMain 与已加载扩展；隔离实例与用户浏览器无关。
- 隔离实例的扩展去掉 manifest `key`（Chrome 给随机扩展 ID），防止连上用户正在运行的伴随进程；扩展 JS 与生产构建逐字节相同，只动 manifest 的 key 字段。
- 只 GET，不写任何真实站点数据。
- 不改 `fetch` 行为本身；本轮只补证据。若脚本暴露真缺陷，另开修复并回来加回归。
