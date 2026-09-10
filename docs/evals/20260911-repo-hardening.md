# 任务：全仓库恶性 bug 复查 + 代码简洁（行为不变）

用户 2026-09-11 要求复查全仓库恶性 bug，并在不影响功能实现的前提下简化代码。本文件是动工前冻结的标准。

**目标**：给出可信的复查结论（修掉确认的缺陷并留回归，查过但未见问题的面也写明证据），删掉编译器确认的死代码；不改变任何对外行为。

## 复查方法（可复核）

1. 机器检查：`npm run typecheck`、`npm test`、`npm run build`；数据层三条真实路径 harness 复跑（fetch 对比、network、批量翻页），确认修完与简化后仍与上一轮同量级。
2. 危险面逐项过：
   - 外部输入拼路径（fetch savePath、技能 id、会话 id、下载名）——检查是否有路径穿越；
   - 无界增长/无界循环（环形缓冲、Map/Set 生命周期、页码范围、运行记录裁剪）；
   - 单文件损坏是否拖垮整条读取路径；
   - 未捕获异步与消息通道不回应；
   - 扩展存储配额、后台内存态重启后行为；
   - 权限/控制闸门是否有旁路。
3. 死代码判定只认编译器 `TS6133/TS6196`（未使用 import/局部/参数），逐条人工确认无副作用再删。

## 完成标准

- [x] 1. 全量检查绿 + 三条真实路径 harness 通过；现有测试不加修改全绿。 — 谁检查: `npm run typecheck && npm test && npm run build` + 三个 harness 命令（见结果）
- [x] 2. 确认的缺陷修掉且带回归：
  - 观察候选「以后替我跑」的 accept 分支没有消费候选（下次还问），`consumeCandidate` 导入后从未使用；
  - `fetch.pages` 允许 `to` 为超大整数时页码生成循环无上限，会把伴随进程挂死；
  - `network` 的 `limit` 收到非数值时筛选退化（不受限）；
  - `ExperienceStore.list()` 遇到一个坏 JSON 文件会整条抛错，拖垮全部经验读取。
  — 谁检查: npm test（新增对应回归）
- [x] 3. 死代码按编译器证据删除；`TOOL_ICONS`（开放产品决策）不删。 — 谁检查: typecheck 无新增 TS6133/6196 + 测试全绿
- [x] 4. 行为不变：没有为“简洁”改控制流语义、协议字段或工具行为；真实路径数字与上一轮同量级。 — 谁检查: 差异评审 + harness 输出
- [x] 5. 复查覆盖面与未覆盖边界写进本文档。 — 谁检查: 人

## 结果（2026-09-11）

### 机器检查

- `npm test`：151 文件 **1330 项**通过（新增 4 项回归）；typecheck、build 通过。
- 真实路径复跑（isolated headless Chrome + 真实扩展构建）：
  - fetch 对比：B 站 fetch 532 字符 / snapshot 10,314；HN fetch 521 / 23,987；私网守卫仍拒绝且不发请求；
  - network：102 条真实请求、默认/urlContains/clear 全过，取页面自己的接口 fetch 回 200；
  - 批量翻页：三页落盘且互不重复、回执 1,232 字符、404 不冒充、私网不发请求。

### 修掉的缺陷

| # | 缺陷 | 后果 | 修法 | 回归 |
|---|---|---|---|---|
| 1 | `handleObserveControl` 忽略 `accept`，`consumeCandidate` 导入未用 | 用户点「以后替我跑」后候选不消失，同一件事反复问 | 把动作语义移入 `observe.ts` 的 `applyObserveAction`，`accept` 消费候选；index.ts 只广播状态 | `demo-session.test.ts` 新增 accept 用例 |
| 2 | `pageNumbers` 先生成完整页码再查上限 | `to` 传超大整数（如 `1e15`）时循环无上限，伴随进程挂死 | 边生成边检查，超 20 页立即报错 | `fetch-pages.test.ts` 新增超大范围用例 |
| 3 | `selectNetworkEntries` 的 `limit` 非数值时 `Math.round(NaN)` 失效 | `limit: NaN` 时筛选不受限 | `Number.isFinite` 回退默认、`Math.trunc` 取整 | `network.test.ts` 新增 limit 边界用例 |
| 4 | `ExperienceStore.list()` 逐文件 `JSON.parse` 未捕获 | 一个坏 JSON 文件让所有经验读取抛错，功能整体不可用 | 单文件 try/catch 跳过（与 SkillStore 同约定） | `experience.test.ts` 新增坏文件用例 |

### 查过、未见问题的面

- 路径穿越：`fetch savePath`/分页名只取 basename（`safeDownloadName` 既有回归）；技能 id `^[A-Za-z0-9_-]{1,64}$`、会话 id 同类严格校验，均在建路径前判定；经验/技能目录文件名另有正则过滤。
- 无界增长：network 环形缓冲 300/页、tab 数上限 20；观察证据 16KB 字节预算（中文按 UTF-8 计）；技能运行记录 200 条封顶；面板历史 256KB/最近 8 键（上一轮修）。
- 消息通道：`cross_page_click` 三条分支都回 `sendResponse` 且 `return true`；观察/示范上行监听同步、不占通道；`void` 异步均为显式 `.catch` 或内部 try/catch。
- 控制闸门：`fetch`/`network` 只读，不受示范期写工具闸门影响；私网守卫本轮在真实扩展路径上复验。
- 单坏文件：排查了 `conversation-store`/`memory`/`voice-plan`/`skill`/`task-dispatcher` 的读取，只有 experience 逐文件解析未兜底（已修）；task-dispatcher 对坏回执故意报错（不静默重放）。

### 简洁化（行为不变）

- 删死代码：`input.ts`（未用 import + `centerOfBackendNode`）、`index.ts`（`PROTOCOL_VERSION`、未用 `sender` 参数）、`content/cursor.ts`（`spawnMark` 的未用 `actions` 参数、`waitReplay` 的未用 `gen` 参数）、`companion.ts`（`idleToken`）、`main.ts`（三个未用图标、`formatDuration`、未用回调参数改名）、`voice-orb.ts`（`clamp01`）、`shared/untrusted.ts`（`hasWhitespace`）、`conversation-manager.ts`/`voice-service.ts`/`voice-session.ts`（未用类型导入）、`session.ts`（steer 分支两个算了不用的局部值）。
- 结构小改：观察动作派发从 `background/index.ts` 移回 `background/observe.ts`（`applyObserveAction`），index 只剩一行 + 广播。
- 故意保留：`TOOL_ICONS`（状态里未决的产品取舍）、`routeVoiceInput` 的 `startedAt` 形参（测试/harness 大量位置传参的公开签名）、voice 测试里可能带副作用意图的未用局部。

### 未覆盖 / 未决

- 没做大文件结构重构（`sidepanel/main.ts` 3123 行、`content/cursor.ts` 1633 行）：收益与风险不匹配，本轮只清死代码。
- 语音子系统只做了未用导入清理，未审完整语义；`startedAt` 形参保留。
- 本轮改动未提交、未推送（等用户决定）。

## 边界与不做

- 不重构 `sidepanel/main.ts`、`content/cursor.ts` 等大文件的结构（风险大于收益）。
- 不动控制闸门、协议契约与既有工具语义。
- 不删除开放产品决策的代码（`TOOL_ICONS`），也不删除编译器未标未使用的“疑似”代码。
- 不把“没查”写成“没问题”：覆盖面按上述清单逐项给结论。
