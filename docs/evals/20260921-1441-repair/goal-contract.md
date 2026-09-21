# 修复：目标契约（A1 方案可审计修订 / A2 材料上限报错可操作 / A3 condition 核验接入 read_elements 证据）

对应 docs/evals/20260921-1441-repair.md 第 1、2、3 条。源自 docs/evals/20260921-1441-log-review.md 第 1、2 节。

## 问题回顾

1. 执行器把"完整保存文章为 article-body"规划成必须满足的 material 目标；一旦该目标固定，`TaskGoalBook.install()` 在 `coverage==='verified'` 时直接拒绝任何重新登记，没有"移除内部方法、保留用户要求"的路径（真实 trace 第 84 行的拒绝正是这个缺口）。
2. `task-evidence.ts` 把"材料为空"和"超过 8000 字符"混成一句模糊错误，不报实际长度、上限，也不给出可行续接方式。
3. `task_goals verify` 对 condition 目标的统一核验固定读 `snapshot`（+可选 `read_element`），从不读回选择器命中的全部标注节点；`goal-evidence-judge.ts` 喂给 Jev 的 state 里没有任何标注/高亮证据，Jev 判断"证据不足"是必然结果，不是模型判断力问题。

## 修复方案

### A1：目标方案可审计修订

- `shared/task-goals.ts`：`TaskGoalPlan` 新增可选 `amendments?: Array<{at, reason, removed, added}>`；`isTaskGoalPlan` 增补对应校验（≤16 条，`reason` ≤500 字，`removed`/`added` 每项 ≤64 字符、每个数组 ≤32 项）。
- `agent/src/task-goals.ts`：
  - 抽出私有 `assertCoverage(revision, goals, requirementCount)`，把 `install()` 原有"requirements 全覆盖 + field→material 引用 + materialId 唯一"校验原样移入，`install()` 行为逐字不变（错误消息、判定条件未改一个字符）。
  - 新增 `amend(revision, definitions, requirementCount, reason)`：只允许在 `coverage==='verified'` 时调用；`reason` 为空/纯空白直接拒绝；把现有目标分成"locked"（`kind` 为 condition/field/answer，或任意已 `satisfied` 的目标，含 material）与"可替换"（仍 `pending` 且没有任何现有 field 目标引用其 `materialId` 的 material）两类。locked 目标若在新提案里缺失（真被删除）直接拒绝并点名 id；若存在，则**无视提案内容**，原样克隆旧目标（id/kind/criterion/requirements/materialId/status/reason/evidence 全部逐字保留）——这是刻意选择：真实 trace 第二次 plan 同时重写了两个 condition 目标的 criterion 文案，若按"内容必须逐字相同才放行"来做，带 reason 也无法通过；而"允许模型重新表述、但落盘时用原文覆盖"既满足"用户要求不能被改写"的硬约束，也不会让一次良性复述式重发被拒。可替换目标可以被删除或替换为新定义（重置为 `pending`，不带旧 `reason`/`evidence`）。新目标可以任意新增。最终结果统一交给 `assertCoverage` 校验，再写入一条 `amendments` 记录（`reason.slice(0,500)`，`removed`/`added` 为实际发生的目标 id 列表），整体裁到最近 16 条。
- `agent/src/task-goal-tool.ts`：
  - `GoalToolHost.read` 签名新增可选第 4 参 `elements?: {selector: string}`。
  - `GoalOperationInput` 新增 `reason?: string`、`elements?: {selector: string}`。
  - `plan` 动作：`snapshot.goalPlan?.coverage==='verified'` 时视为修订：缺 `reason`（或纯空白）直接报错说明；否则先用一个**独立的临时 TaskGoalBook**（`restore(..., false)` 克隆当前快照）跑 `amend()` 做纯本地校验（不改动真实账本、不调用模型），通过后才调用同一个 `reviewEvidence('plan', {requirements, goals}, signal)`（与 `install` 路径完全同一次 Jev 审核，同一返回形状：不通过原样 `return result(review)`，不落盘）；通过后才在真实 `host.book()` 上执行 `amend()` 并 `persist()`。`coverage==='unplanned'` 时行为与之前完全一致（走 `install()`）。
  - 工具 `description` 与 `parameters`（新增 `reason`、`elements` 两个可选字段）同步更新，说明修订规则与 condition-only 的 `elements` 用法。

### A2：材料上限报错可操作

- `agent/src/task-evidence.ts`：导出 `MATERIAL_VALUE_MAX = 8000`（上限数值不变）。`material()` 私有方法拆成两条独立判断：
  - 空/纯空白：`所选范围为空，请重新选择包含正文的范围`
  - 超限：`所选范围共 ${实际字符数} 字符，超过单份原文预算上限 8000 字符。只保存用户实际要求的这一段；如果这份来源只是内部方法的中间步骤（不是用户明确要求的内容），改用 task_goals 的 plan 动作并带上 reason 修订目标方案，移除这个内部来源目标。`（同时点出真实字符数、上限、两条可执行续接路径：只存用户真正要的那段 / 用 A1 的 amend 去掉纯内部依赖）。
  - `restore()` 里原来内联的 `text(m.value, 8000)` 改为复用 `MATERIAL_VALUE_MAX`，上限判定逐字不变，只是不再硬编码两处数字。
- 未新增多段材料能力；单份 >8000 字符的整篇原文仍不可作为一份材料保存，按任务书要求记为已知限制，不在本轮解决。

### A3：condition 核验接入 read_elements 证据

- 契约前提：`shared/protocol.ts` 的 `TOOL_NAMES`/`ToolContract.read_elements` 已由主代理写好（`params:{tabId?,selector,limit?}`，`data:{tabId,documentId?,selector,total,truncated,elements:[{index,tagName,text,visible,rect,style,scopeLabels?}]}`），本次未改该文件；扩展侧执行器由另一子代理实现（`extension/src/background/exec/read-elements.ts`，其证据见同目录 `read-elements.md`）。
- `agent/src/tools.ts`：紧邻 `read_element` 新增 `read_elements` 工具定义，参数 `tabId?/selector/limit?`，`execute` 直接 `call("read_elements", params)`，结果经 `wrapPageContent(redactCredentialText(JSON.stringify(data)), {tabId})` 回模型；`canExecute`/权限判定完全照抄 `read_element`（不额外加检查，交给 `call()` 里已有的通用 `canExecute(modelToolOf(name))` 闸门）。
- `agent/src/session.ts` `goalToolHost()` 的 `read` 闭包：新增第 4 个可选参数 `elements`。原逻辑先 `snapshot`，有 `target` 时再叠 `read_element`（这两段判定与返回形状逐字未改）；新增：有 `elements` 时再额外 `invokeDisplayTool(..., 'read_elements', {tabId, selector: elements.selector, limit:120}, ...)`，校验其 `tabId`/`documentId` 与本次 `snapshot` 一致（复用与 `read_element` 分支完全相同的身份校验模式），通过后把结果并入 `data.elements`；任一环节身份不符或调用失败都直接 `throw`（整个 `read()` promise 拒绝），不会把半份证据合并进已返回的 `data` 里。
- `agent/src/task-goal-tool.ts`：`verify` 动作里，只有 `goal.kind==='condition'` 时才把 `input.elements` 传给 `host.read(...)`；`field`/`material` 目标始终传 `undefined`，不受影响。模型能传入的仅有 `elements.selector` 这一个字符串——工具参数模式里没有任何 `evidence` 字段，代码也从未读取 `input.evidence`，因此"模型伪造证据"这条路径在协议层就不存在。
- `agent/src/goal-evidence-judge.ts`：
  - `ReviewPage` 增补 `elements?: unknown`。
  - 新增纯函数 `summarizeElements(raw)`：无 `elements` 或非对象直接返回 `undefined`（不携带该字段，行为与此前一致）；否则取 `selector/total/truncated`，样本裁到前 60 条（`text/tagName/visible/style/rect`），文本按 `trim()+折叠内部空白` 归一后计数，取出现次数最高的前 30 个词写入 `textCounts`。
  - `goalReviewState` 的 condition 专属返回块（该函数里 target/plan/answer/reuse/source 均有各自的显式分支，唯一落到最后这个 catch-all 分支的 stage 就是 `condition`）新增 `...(elements?{elements}:{})`。
  - `condition` 的 Jev `instructions` 补一句：elements 是宿主按执行器选定的选择器新鲜读回的命中集合，用其文本、样式、可见性与数量判断标注是否覆盖要求的对象，选择器本身不证明含义。**`GOAL_REVIEW_GATES.condition` 仍是 0.9，未改动任何门槛。**

### 交叉确认（未改动，仅核对）

`shared/task-results.ts` 的 `RESULT_VERIFY_READ_TOOLS` 现已是 `["read_element", "read_elements", "snapshot"]`（含 `read_elements`）——这是 `record_task_results`/`task_results` 执行回执账本用来判定"哪些工具的读取算作刷新页面观察"的另一张表，与本次 `task_goals verify` 的 condition 路径是两套独立机制。`read-elements.md` 曾把它列为"留给 agent 侧子代理确认"的残余风险；核对后发现该文件已经包含 `read_elements`，应为主代理或其他并行工作补上，本次未改动此文件，仅确认现状。

## 验证结果

### 单测（Hard bar 指定的六个文件 + 新增状态测试文件）

```bash
$ npx vitest run agent/test/task-goals.test.ts agent/test/task-goal-tool.test.ts \
    agent/test/task-evidence.test.ts agent/test/task-evidence-budget.test.ts \
    agent/test/task-evidence-recovery.test.ts agent/test/browser-material.test.ts \
    agent/test/goal-evidence-judge-state.test.ts --reporter=verbose
PASS (43) FAIL (0)
```

分布：task-goals.test.ts 14（9 项原有 + 5 项新增 amend 回归）、task-goal-tool.test.ts 10（4 项原有 + 6 项新增：2 项 A1 修订路径、2 项 A1 拒绝路径、2 项 A3 elements 有/无对照）、task-evidence.test.ts 6（4 项原有 + 2 项新增 A2 报错拆分）、task-evidence-budget.test.ts 1、task-evidence-recovery.test.ts 2、browser-material.test.ts 4、goal-evidence-judge-state.test.ts 4（全新，直接测 `goalReviewState`）。

### 类型检查

```bash
$ npm run typecheck -w @sideagent/agent
> tsc --noEmit -p tsconfig.json
(无输出，通过)
```

### 架构边界检查

```bash
$ npm run check:architecture
Architecture boundaries: 222 production files passed.
```

### 用真实 trace 参数做的回归（对应验收契约第 1 条"用真实 trace 参数"要求）

`agent/test/task-goals.test.ts` 的"真实 trace 回归"用例直接嵌入 trace 文件 `~/.sideagent/traces/1789972957328-301bc278-8936-41c4-8912-7b11f4a32da8.jsonl` 第 42、82 行的真实 `goals` 参数（`article-source`/`keywords-marked`/`top-word-marked`，criterion 原文一字不差抄入）：

1. 先用第 42 行的 3 个目标 `install()`。
2. 直接对第 82 行的 2 个目标（同样真实文案）调用 `install()`（无 reason 概念），复现真实拒绝路径：抛错含"固定"——与真实 trace 第 84 行的实际拒绝一致。
3. 对同一份第 82 行目标调用 `amend(..., '')`（空 reason）：抛错含"理由"。
4. 对同一份第 82 行目标调用 `amend(..., 非空理由)`：被接受；结果目标顺序为 `['keywords-marked','top-word-marked']`；两个 condition 目标的 `criterion` 是**第 42 行的原始文案**（不是第 82 行提案里改写过的文案），`status` 仍为 `pending`；`amendments` 记录 `removed:['article-source'], added:[]`。

这条用例同时验证了三件事：真实数据下"删内部保存目标、留用户可见目标"确实能被接受；被保留目标即使提案文案不同也不会被悄悄改写；`install()` 本身（回放脚本 `replay.mts` 直接调用的那个方法）在没有 reason 概念时仍然拒绝，与历史证据脚本的既有断言不冲突。

### 对历史回放脚本的只读复核（不属于 Hard bar，供参考）

按边界要求未修改 `docs/evals/20260921-1441-log-review/replay.mts` 或其输出，只用 `npx tsx` 只读运行了一次以自查是否有意外破坏：

```bash
$ npx tsx docs/evals/20260921-1441-log-review/replay.mts
AssertionError: Expected values to be strictly equal: 0 !== 1
    at .../replay.mts:81  (assert.equal(createsBeforeNextResponseCreated, 1))
```

脚本跑到第 81 行（语音 `response.create` 竞争检查，对应验收契约第 5 条，`agent/src/realtime-voice-connection.ts`——不在本工作包范围，由另一子代理负责且当前仍在并发修改中）才失败；这意味着第 31 行的材料预算断言（`r.chars>8000 && r.prepare.includes('预算')`）和第 41 行的 `install()` 固定拒绝断言（`replanError.includes('固定')`）**都顺利通过**，没有被我的改动打断。为避免我的 A2 改动意外让第 31 行断言炸掉整个脚本（该脚本是顺序执行的裸 `assert`，前面炸了后面全部检查不到），有意在超限错误文案里保留了"预算"一词（"超过单份原文预算上限"），只增不减信息，不影响 A2 本身的验收断言（含实际字符数、上限、可行做法）。

## 实现细节复查（第一次绿后按要求专项复查）

1. **修订后 goal 的 status 是否被误重置？** 已用专项测试核对：locked 目标（含已 `satisfied` 的）整份克隆，`status`/`reason`/`evidence` 原样带过去；仅"可替换"材料在被保留/替换时才重置为 `pending`（这类目标此前也只能是 `pending`，重置前后状态本身不变，只是清空了可能过期的 `reason`）。见 `task-goals.test.ts` 的真实 trace 回归与"修订可以新增目标"用例。
2. **amendments 是否随检查点持久化并被 restore 接受？** `task-goals.test.ts` 新增专项测试：`amend()` 后 `JSON.parse(JSON.stringify(snapshot))` 再 `restore()`，`amendments` 逐字相等；`isTaskGoalPlan` 的新校验分支已覆盖数组长度、`reason` 长度、`removed`/`added` 项格式。
3. **read 出错时是否泄漏半个证据？** 复查 `session.ts` 的 `read()`：`elements` 分支的身份校验失败或 `invokeDisplayTool` 本身抛错都会让整个 `read()` promise 直接拒绝，函数在到达 `return {id, data}` 之前就已经中断，不存在"合并了一半 `data.elements` 又继续往下走"的路径；`executeGoalOperation` 侧 `await host.read(...)` 失败会直接向上抛出，`verify` 动作不会执行到 `host.book().verify(...)`，目标状态不会被改动。
4. **A1 的合法删除判定是否漏掉"字段引用"这条边界？** 已用 `task-goal-tool.test.ts` 的"修订试图删除仍被字段引用的材料"用例验证：即便该 material 仍是 `pending`（尚未核验），只要还有一个 field 目标引用它的 `materialId`，就会被判定为不可删除，且这一步在调用 Jev 之前就已经用代码拒绝（`f.completeSimple` 未被调用）。
5. **A3 的 elements 是否只影响 condition，不影响 field/material？** `task-goal-tool.test.ts` 新增对照用例：同一 fixture 下，带 `elements` 的 condition 核验让 `host.read` 收到 `{selector}`、`page.elements` 出现在交给 Jev 的 state 里；不带 `elements` 时 `host.read` 第四个参数收到 `undefined`、state 里没有 `elements` 键——与改动前行为一致。
6. **goalReviewState 是否会把顶层伪造的 `evidence` 字段带给 Jev？** `goal-evidence-judge-state.test.ts` 专项验证：即便调用方在顶层塞入 `evidence:{fabricated:true}`，`goalReviewState` 的返回对象里没有 `evidence` 这个键；同一次调用里合法的 `page.elements` 仍正确出现。

## 代码改动范围

| 文件 | 改动 | 理由 |
|------|------|------|
| shared/task-goals.ts | `TaskGoalPlan.amendments` 类型 + `isTaskGoalPlan` 校验分支 | A1：修订记录的数据形状与边界 |
| agent/src/task-goals.ts | 抽出 `assertCoverage`；新增 `amend()` | A1：可审计修订，`install()` 行为不变 |
| agent/src/task-goal-tool.ts | `GoalToolHost.read` 加第4参；`GoalOperationInput` 加 `reason`/`elements`；`plan` 动作分叉 install/amend；`verify` 对 condition 传 `elements`；工具描述与参数模式同步 | A1 工具层接线 + A3 verify 入参 |
| agent/src/task-evidence.ts | 导出 `MATERIAL_VALUE_MAX`；拆分空/超限错误；`restore()` 复用常量 | A2 |
| agent/src/goal-evidence-judge.ts | `ReviewPage.elements`；`summarizeElements`；condition 分支拼入 `elements`；condition instructions 补一句 | A3：Jev 输入状态 |
| agent/src/tools.ts | 新增 `read_elements` 工具定义（紧邻 `read_element`） | A3：模型侧只读工具，按契约调用扩展执行器 |
| agent/src/session.ts | 仅 `goalToolHost()` 的 `read` 闭包新增 `elements` 分支 | A3：宿主自己取证，不改其余区域 |
| agent/test/task-goals.test.ts | 新增 5 项（真实 trace 回归、缺 reason/非法删除两类拒绝、新增目标、持久化） | A1 回归 |
| agent/test/task-goal-tool.test.ts | fixture 增加 `reviewCalls` 捕获；新增 6 项（A1 修订路径×2、拒绝路径×2、A3 elements 有/无对照×2） | A1/A3 工具层回归 |
| agent/test/task-evidence.test.ts | 新增 2 项（超限报错含实际数字与做法、空选区为另一条错误；另有独立 restore 超限用例） | A2 回归 |
| agent/test/goal-evidence-judge-state.test.ts | 新建，4 项 | A3：直接测 `goalReviewState` 的 elements/textCounts 投影与伪造字段隔离 |
| docs/evals/20260921-1441-repair/goal-contract.md | 新建（本文件） | 验收证据 |

未改动、且明确不属于本工作包范围的文件：`shared/protocol.ts`（契约已由主代理写好）、`extension/` 下任何文件（`read_elements` 执行器由另一子代理实现，见同目录 `read-elements.md`）、`extension/src/background/debugger.ts`（另一子代理已修复并发 attach，见 `debugger-attach.md`）、`agent/src/realtime-voice-connection.ts`（语音 response 竞争，见 `voice-race.md`，仍在并发修改中）、`shared/task-results.ts`（`RESULT_VERIFY_READ_TOOLS` 是另一套账本机制，已含 `read_elements`，本次仅核对未改动）。

## 残余风险

1. **单份 >8000 字符的整篇原文仍不可保存为一份材料。** 这是任务书明确的已知限制，不是本轮修复目标；A1 提供的出路是用 `amend()` 把这类内部依赖从"必须完成的目标"里摘掉，而不是绕过字符上限。
2. **真实页面圈注核验待加载后复验。** 扩展侧 `read_elements` 执行器由另一子代理实现（离线单测通过，见 `read-elements.md`），我这边的 `session.ts`/`task-goal-tool.ts`/`goal-evidence-judge.ts` 改动全部基于**模拟的 `host.read`/`invokeDisplayTool`** 验证；condition 目标在真实浏览器里能否真的被判定为"已核验标注覆盖"，需要人在扩展加载后用真实圈注页面复验，本文件的单测不能替代那一步。
3. **`amend()` 对"可替换"材料采用整体替换语义，不支持部分字段修改后再校验差异。** 例如同一个 materialId 想只改 `criterion` 的一个措辞、保留其余不变，代码上等价于"整条替换成新定义"，不会单独校验"这条改动是不是只改了无害的措辞"——这与任务描述的规则（只要求"未被引用的 pending material 可替换"，未要求做更细的字段级 diff）一致，但如果未来需要"防止 material 被换成完全不同的来源却复用旧 id"这类更细的保护，需要另行设计。
4. **`goalReviewState` 对 condition 阶段之外的 stage（例如 `reuse`/`answer`）从未读取 `elements`。** 这是刻意的范围限定（任务书只要求 condition），如果未来其他 stage 也需要选择器证据，需要单独评估是否合适（例如 `target`/`field` 已经有更强的"exact material equality"代码校验，不一定需要 elements）。
5. **历史回放脚本 `replay.mts` 在语音 response 竞争检查处失败**（见上文"对历史回放脚本的只读复核"），与本工作包无关；已确认失败点在语音相关的第 81 行，我负责的材料预算断言（第 31 行）与 `install()` 固定拒绝断言（第 41 行）均在此之前顺利通过。是否需要重新运行整份 `replay.mts` 判定"缺陷仍在的检查应当失败"（验收契约第 8 条），留给主代理在所有工作包都收尾后统一执行。

## 验证清单

- [x] A1：`agent/test/task-goals.test.ts`、`agent/test/task-goal-tool.test.ts` 全部通过，含真实 trace 参数的回归
- [x] A2：`agent/test/task-evidence*.test.ts` 全部通过，超限错误含实际字符数与上限，空材料是另一条错误，restore 仍拒绝 >8000
- [x] A3：`agent/test/task-goal-tool.test.ts`（elements 有/无对照）、`agent/test/goal-evidence-judge-state.test.ts` 全部通过；真实页面核验留待人工复验（残余风险 2）
- [x] `npm run typecheck -w @sideagent/agent` 通过
- [x] `npm run check:architecture` 222 文件通过
- [x] `npx vitest run` 六个 Hard bar 指定文件 + 新增状态测试文件，43/43 通过
- [x] 未改动 `shared/protocol.ts`、`extension/` 下文件、`debugger.ts`、`realtime-voice-connection.ts`、`docs/evals/20260921-1441-log-review/replay.mts`
- [ ] 真实浏览器加载后的圈注/标注人工复验（留给用户/主代理）
- [ ] 全量 `replay.mts` 复核（等语音、debugger 等其他工作包收尾后由主代理统一执行）
