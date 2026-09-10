# 任务：批量翻页（`fetch` 一次调用取多页）

数据层第三步之一。用户 2026-09-11 批准顺序：`fetch` → `network` → 批量翻页 / `download`。本文件只冻结「批量翻页」这一刀；`download` 另开验收。

**目标（用户可观察）**：分页接口不用一页一轮。Agent 一次 `fetch` 指定页码范围，每页落盘，回执只给路径、状态、字节数与第一页预览；上下文占用由页数决定，不由数据量决定。

## 完成标准

- [x] 1. `fetch` 新增 `pages:{from,to,step?}`：`url` 必须含 `{page}` 占位符（`body` 里的占位符同样替换）；整数校验、`from<=to`、`step>=1`、页数上限 20；缺占位符 / 参数非法 / 超页数一律拒绝且**不发任何请求**。 — 谁检查: npm test（`agent/test/fetch-pages.test.ts`，假 RPC）
- [x] 2. 每页按 `from..to` 顺序请求；`method`/`headers`/`body` 沿用单页语义；GET 不带 body 的约束照旧；每页仍受 512 KiB 上限与私网/协议守卫（复用既有 `normalizeFetchRequest`，不绕过）。 — 谁检查: npm test + 真实路径（批量里私网地址仍被拒）
- [x] 3. 每页落盘 `~/.sideagent/downloads/`，文件名带页码且互不覆盖；无 `savePath` 时从 URL 生成基础名；`savePath` 带扩展名时插在扩展名之前（`x.json` → `x-p3.json`）。 — 谁检查: npm test
- [x] 4. 回执：每页一行「HTTP 状态 / content-type / 字节 / 路径」，HTTP 非 2xx 标 `(not ok)`、网络错误写原因；只给第一页 300 字预览（过凭据隐去 + 不可信边界）；汇总「成功 n / 失败 m、共 N 页、总字节」。不编造状态。 — 谁检查: npm test + 真实路径
- [x] 5. 单页 `fetch` 行为与回执不变，现有全量测试全绿。 — 谁检查: npm test
- [x] 6. 真实站点：真实分页接口一次调用取 3 页，3 个文件落盘、页码不同、内容确实是不同页；回执上下文占用记录原始数字。 — 谁检查: 隔离 harness（真实站点、真实扩展构建）
- [x] 7. 全量测试、typecheck、build 通过。 — 谁检查: `npm run typecheck && npm test && npm run build`（151 文件 1326 项）

## 结果（2026-09-11）

真实路径：`node node_modules/tsx/dist/cli.mjs scripts/acceptance/fetch-pages-run.mts`（isolated `isolated-extension.mts`），GitHub issues 公开接口 `per_page=5&page={page}` 取 3 页。全部 PASS，原始 JSON 见[运行结果](20260911-fetch-pages-results.json)：

- 一次工具调用：3 页顺序请求，**1,880ms**，落盘 `harness-issues-p1/p2/p3.json`，每页 5 条且三页 issue 号互不重复（真的是不同页）。
- 回执 **1,232 字符**（三页合计约 105 KB 在磁盘上）：每页状态/字节/路径 + 只有第一页一份预告；过不可信边界。
- 真实 404（不存在的接口走同一批量）：逐页写 `HTTP 404 (not ok)`，不拋错、不冒充数据；私网地址在批量里仍被守卫拒绝且 fixture 请求数不变。

真实运行暴露并修掉一个既有真缺陷（不是本刀引入）：`redactCredentialText` 的词级 token 字符集含 `/`，把 URL/路径按分隔符拼成长串，把 `https://api.github.com/repos/microsoft/vscode/issues/335552` 隐成 `https://api.github.[redacted]`（批量回执的文件路径也被隐成 `[redacted].json`）。已把 `/` 从 token 字符集去掉（它是分隔符，不是凭据字符），补两条回归（长 URL/路径不误伤；小写+数字超长串仍隐去）；批量回执是产品自己的元信息 + 内部已脱敏的预告，不再被二次脱敏。

## 未跑 / 未决

- 大页码（接近 20 页）与慢站点的超时行为未测；本样本 3 页。
- 批量里单页网络中断（而非 HTTP 错误）的恢复路径只有单测（假 fetch 抛出）。

## 边界与不做

- 不并发：顺序请求，避免打站点。
- 不自动合并 JSON（不猜数据形状）：每页原始落盘，合并交给后续处理或模型。
- 不做非数字游标分页（cursor/offset）：那类由模型多次单页 `fetch` 完成。
- 不改写 `network` 行为；批量翻页是 `fetch` 的参数扩展。
- `download`（浏览器原生下载）不在本文件，另开验收。
