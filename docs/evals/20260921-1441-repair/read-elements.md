# 修复：扩展侧新增只读工具 read_elements

对应 docs/evals/20260921-1441-repair.md 第 3 条的扩展侧部分（condition 目标核验需要宿主自证据：让扩展自己按选择器读回全部命中元素，不由模型替代提供）。

## 问题回顾

**源自：** docs/evals/20260921-1441-log-review.md 第 2 节

圈注/标注类结果核验缺少一个宿主自己产出、模型不能伪造的证据源：`read_element` 只能读唯一匹配的单个元素，无法回答"选择器命中的全部元素分别是什么状态"。`shared/protocol.ts` 已由主代理补上 `read_elements` 契约（`TOOL_NAMES`、`ToolContract.read_elements`），但扩展侧尚未实现，导致：

1. `extension/src/background/index.ts` 的 `handlers: Record<ToolName, Handler>` 缺 `read_elements` 键 → `npm run typecheck -w @sideagent/extension` 报错（`error TS2741: Property 'read_elements' is missing`）。
2. 没有任何执行代码，`read_elements` 调用无法落地。

## 修复方案

1. 新建 `extension/src/background/exec/read-elements.ts`：
   - 参数校验：`selector` 非空、拒绝 `@ref`、拒绝非 `loc=css:` 的 `loc=` 形式，归一化为 `loc=css:<css>`；`limit` 缺省 60，1–200 整数，越界报错。校验在解析工作页之前，纯参数错误不依赖标签页状态。
   - 解析 tab 复用 `getWorkingTabId` / `resolveReadableTab`（与 `read_element` 完全同一套成员权限规则，未新增权限逻辑）。
   - 执行：单次 `chrome.scripting.executeScript`（`world:"MAIN"`），传入可序列化纯函数 `readElementsInPage(selector, limit)`：页面内 `querySelectorAll` → 按文档顺序（`querySelectorAll` 原生保证）取前 `limit` 个 → 每个元素输出 `tagName`（小写）、`text`（trim 后截 200 字）、`visible`（client rects + visibility/display，与 `read_element` 的 visible 规则逐字一致）、`rect`（`getBoundingClientRect` 四字段取整）、`style`（`getComputedStyle` 的六个原字符串字段）、`scopeLabels`（向上最多 8 层、最多 4 条，只认 form/dialog/region/group/row/article/section/fieldset，与 `read_element` 的 scopeLabels 代码逐字一致）。
   - `documentId`：直接使用 `chrome.scripting.executeScript` 本次注入结果自带的 `documentId`（Chrome 原生字段），用 `recordObservedDocument` 记录并在返回值中带出。**未使用** `withObservedDocumentIdentity`——那是 `read_element` 专为 ref/AX 路径和 `expect` 轮询设计的前后一致性包装（内部会额外调用两次 `readCurrentDocument`，本身又各触发一次 `executeScript`）；`read_element` 自己的单次 CSS 读取路径（`readDom`）同样只用 `recordObservedDocument`，不套那层包装。本工具是纯单次读取，与 `readDom` 而非 ref/AX 路径对应，因此照抄 `readDom` 的做法更准确，也少两次往返。这是唯一偏离任务描述字面表述（"用 withObservedDocumentIdentity / recordObservedDocument"）的判断，出于对现有代码实际行为的一致性考虑而非偷懒；如需改回重包装版本可另行调整，不影响契约或测试。
   - 输出有界：`assertBounded` 在 `recordObservedDocument` **之前**执行（与 `read_element` 的 `assertComplete` 同序）——超限时既不返回数据，也不把这次读取记为"已观察"，避免用一次被拒绝的读取污染后续 staleness 判断。上限 200,000 字符（`JSON.stringify(elements).length`），与 `read_element` 的 `MAX_ELEMENT_CHARS` 同为字符数口径，不是严格字节数。
   - 零命中返回 `{total:0, truncated:false, elements:[]}`，不抛错——这正是本次修复要解决的"没有标注"这一事实需要能被核验器看到。
2. `extension/src/background/index.ts`：新增 `import { readElements } from "./exec/read-elements.js"`；`handlers` 增加 `read_elements: (p, sid) => readElements(p, sid)`；`READ_TOOLS`（驱动光标"正在读这个页面"状态）增加 `"read_elements"`。
3. `extension/src/background/state.ts` 的 `guardToolAccess`：主 Agent 全局只读白名单 `["snapshot", "read_element"]` 增加 `"read_elements"`——否则主 Agent 对非自己工作页调用 `read_elements` 会被资源归属检查拦下，而 `read_element` 不会，行为不一致。
4. `shared/effect-policy.ts` 的（模块内部，未导出）`READ_TOOLS`：增加 `"read_elements"`。这张表驱动 `classifyToolEffect`→`requiresControlGate`，被 `shared/control.ts` 的 `ControlGate.canLand/run` 用来判断该工具要不要走接管闸门。不加的话 `read_elements` 会落进默认分支（`class:"unknown", requiresControlGate:true`），在用户接管期间会被当成写操作直接拒绝执行——对一个声明只读的取证工具是错误行为，且找到时未在原始任务描述的例子里，是本轮自行搜出的同类表。
5. `docs/protocol.md`：在 `read_element` 段落后补一段 `read_elements` 的参数、语义与边界说明。

### 认定为"同类表"但决定不改的位置（已核对，非遗漏）

- `extension/src/sidepanel/main.ts` 的 `TOOL_ICONS`（工具名→图标）：文件注释明确写"05 之后 chip 的图标位换成了光球，这里暂时没有调用方"，即当前是死代码，改了没有任何可观察差异。
- `extension/src/sidepanel/steps.ts` 的 `ACTION_NAMES`（工具名→中文动作短语，用于"执行步骤"聚合块展示）：`Record<string,string>`，取值处 `ACTION_NAMES[name] ?? name` 有安全回退（未登记时显示原始工具名，不报错、不崩溃）。这是纯 UI 文案，不是权限/只读分类表，且不在本任务列出的文件范围内；不动。
- `shared/task-results.ts` 的 `RESULT_VERIFY_READ_TOOLS`：`grep` 显示其唯一消费者是 `agent/src/task-results.ts`、`agent/src/task-progress.ts`、`agent/src/session.ts`——全部在 `agent/` 下。这张表决定哪些读工具的回执可以解除任务结果的"未决"状态，属于任务书里"另一子代理负责 agent 侧挂载与核验接线"的范围；本任务明确不许改 `agent/` 下文件。**这正是本任务 Goal 里点名的证据缺口**：`read_elements` 现在能产出证据，但核验器（agent 侧）是否已经把它纳入 `RESULT_VERIFY_READ_TOOLS`，需要负责 agent 侧接线的子代理确认——若未纳入，圈注证据仍不会被核验器采信,这是留给协调方的衔接点，不是本文件范围内的缺陷。

## 验证结果

### 类型检查

```bash
$ npm run typecheck -w @sideagent/extension
> tsc --noEmit -p tsconfig.json
(无输出，通过)
```

### 单元测试

```bash
$ npx vitest run extension/test/read-elements.test.ts extension/test/read-element.test.ts
PASS (29) FAIL (0)
```

新增 `extension/test/read-elements.test.ts` 19 项，覆盖：

1. selector 归一化（原生 CSS 与 `loc=css:` 前缀返回同一个 `loc=css:...`）
2. `@ref` 明确报错
3. 非 `loc=css:` 的 `loc=` 形式明确报错
4. 空 selector / 空 `loc=css:` 明确报错
5. limit 边界：0、201、非整数（1.5）均报错
6. 缺省 limit 为 60：61 个命中只取前 60 个，`truncated:true`
7. 命中数不超过 limit 时 `truncated:false`
8. 无命中返回 `total:0` 与空列表，不算错误
9. 文本 trim 后截 200 字
10. tagName 归一为小写
11. rect 四字段取整
12. visible 规则：无 client rects 或 display:none 时为 false，否则为 true
13. style 六字段原样传回
14. scopeLabels：祖先 form 按 aria-label 命名，正确收集
15. documentId 记录并返回
16. 非法 CSS 选择器语法（querySelectorAll 抛错）明确报错
17. 标签页已关闭（resolveReadableTab 返回 `id:undefined`）明确报错
18. 跨会话/未共享标签页的错误原样抛出，不回退活动页
19. 输出超过安全上限（200,000 字符）时报错，不返回部分内容

原有 `read-element.test.ts` 10 项全部保持通过，证明未破坏既有 `read_element` 行为。

### 架构边界检查

```bash
$ npm run check:architecture
Architecture boundaries: 222 production files passed.
```

### 扩大范围回归（超出 Hard bar 要求，主动补做）

由于本次改动触及 `extension/src/background/index.ts`、`extension/src/background/state.ts`、`shared/effect-policy.ts` 三个被广泛引用的文件，额外跑了：

```bash
$ npx vitest run extension/test/control-gate.test.ts extension/test/fetch-effect-policy.test.ts \
    extension/test/conversation-tabs.test.ts extension/test/page-transfer.test.ts \
    extension/test/lead-global-browser.test.ts agent/test/effect-policy.test.ts
PASS (66) FAIL (0)

$ npx vitest run extension/test/delivery-receipt.test.ts extension/test/session-management.test.ts
PASS (16) FAIL (0)

$ npx vitest run extension/test/
PASS (902) FAIL (0)
```

扩展全量测试（902 项）与直接命中 `guardToolAccess`/`effect-policy`/`background/index.ts` 的测试均全绿，未发现回归。`agent/test/effect-policy.test.ts` 通过確认对 `shared/effect-policy.ts` 的改动未影响 agent 侧既有断言（该改动只对此前不存在的 `"read_elements"` 名字生效，对其他工具名的分类结果不变，属加法变更）。

## 实现细节检查（第一次绿后按任务要求专项复查）

### 序列化函数里是否误用了外部符号？

逐一核对 `readElementsInPage` 函数体内引用的每个标识符：`document`、`getComputedStyle`、`Array`、`String`、`Math`、`Error` —— 均为任意 JS 执行环境（含被注入的页面 MAIN world）自带的全局内建对象。未引用模块作用域内的 `MIN_LIMIT`/`MAX_LIMIT`/`DEFAULT_LIMIT`/`MAX_OUTPUT_CHARS`/`parseSelector`/`parseLimit`/`assertBounded`/`recordObservedDocument`/`getWorkingTabId`/`resolveReadableTab`/`LEAD_SESSION_ID` 中任何一个；`ElementSummary`/`ElementsReply` 仅作为类型标注，编译后从 `.toString()` 序列化结果中完全消失。确认无外部符号泄漏。

### 超大页面的输出上限是否真的生效？

新增专项测试验证两个方向：
- **假阳性方向**：61 个正常元素（短文本、默认样式）——不触发上限，正常返回 `truncated:true`。
- **真阳性方向**：5 个元素每个 `backgroundColor` 人为撑到 60,000 字符（总计 300,000+ 字符，超过 200,000 上限）——触发 `assertBounded`，报错信息命中 `/超过安全上限.*未返回部分内容/`，且确认该场景下不返回任何元素数据。

两个方向都通过，确认上限逻辑真实生效而非摆设。

### assertBounded 与 recordObservedDocument 的执行顺序

确认 `assertBounded` 在 `recordObservedDocument` 之前执行（详见"修复方案"第 1 条），与 `read_element` 的 `readDom` 顺序一致：超限时不会把这次失败的读取误记为"已成功观察该文档"。

## 代码改动范围

| 文件 | 改动 | 理由 |
|------|------|------|
| extension/src/background/exec/read-elements.ts | 新建 | 工具核心实现 |
| extension/test/read-elements.test.ts | 新建 | 单元测试覆盖 Hard bar 全部要求场景 + 3 项自选加固测试 |
| extension/src/background/index.ts | 新增 import、handlers 路由、READ_TOOLS 登记 | 让 `Record<ToolName,Handler>` 完整，恢复 typecheck 绿；接入光标"正在读页面"状态 |
| extension/src/background/state.ts | `guardToolAccess` 白名单加 `"read_elements"` | 主 Agent 全局只读权限与 `read_element` 保持一致 |
| shared/effect-policy.ts | 模块内 `READ_TOOLS` 加 `"read_elements"` | 避免接管闸门把新只读工具误判为需要写权限，本轮自行发现的同类表 |
| docs/protocol.md | `read_element` 段落后补一段说明 | 文档同步 |
| docs/evals/20260921-1441-repair/read-elements.md | 新建（本文件） | 验收证据 |

未改动、且明确不属于本任务范围的文件：`shared/protocol.ts`（契约已由主代理写好）、`agent/` 下任何文件（另一子代理负责 agent 侧挂载与核验接线，含是否要把 `read_elements` 纳入 `RESULT_VERIFY_READ_TOOLS`）、`extension/src/background/debugger.ts` 与 `extension/test/debugger-attach.test.ts`（另一子代理已完成并发 attach 修复）。

## 残余风险

1. **真实页面未验。** 全部验证基于 vitest 里对 `chrome.scripting.executeScript`/`document`/`getComputedStyle` 的桩替换，`readElementsInPage` 的实际 DOM 行为（尤其 `getComputedStyle` 在真实渲染树上的取值、`querySelectorAll` 在真实大页面上的性能）未经真实浏览器加载验证。任务书要求"真实页面圈注核验由人在加载后复验"，本文件不能替代那一步。
2. **跨 iframe 不覆盖。** `chrome.scripting.executeScript` 默认只作用于目标 frame（未传 `allFrames`），与 `read_element` 现有行为一致，但 iframe 内的圈注元素读不到；如核验器需要跨 iframe 证据，需要额外设计（本任务未要求）。
3. **agent 侧是否已接纳 `read_elements` 为核验证据源未知。** 已在"决定不改的位置"一节写明：`shared/task-results.ts` 的 `RESULT_VERIFY_READ_TOOLS` 仍只有 `["read_element", "snapshot"]`；`agent/test/task-goal-tool.test.ts` 是否已把 `read_elements` 接入核验路径，需要负责 agent 侧的子代理或主代理确认，不在本文件验证范围内。
4. **200,000 字符上限为字符数（UTF-16 code unit）口径，非严格字节数。** 与 `read_element` 的 `MAX_ELEMENT_CHARS` 一致选择，中文等多字节字符下真实字节数会明显更大；如果协调方期望严格 KB 字节上限，需要另行调整为按 UTF-8 编码后字节长度计算。
5. **未使用 `withObservedDocumentIdentity` 包装单次读取。** 已在"修复方案"第 1 条详细说明理由（与 `read_element` 的 `readDom` 单次 CSS 路径行为一致，且避免两次多余的 `executeScript` 往返）；如协调方认为任务描述的字面意图是必须套用该包装以获得更强的前后一致性保证，可在此基础上追加，不影响契约形状或现有测试。

## 验证清单

- [x] `npm run typecheck -w @sideagent/extension` 通过
- [x] `npx vitest run extension/test/read-elements.test.ts extension/test/read-element.test.ts` 29/29 通过
- [x] `npm run check:architecture` 222 文件通过
- [x] 扩大回归：`extension/test/` 全量 902/902 通过；`agent/test/effect-policy.test.ts` 通过
- [x] 序列化函数无外部符号泄漏（逐一核对）
- [x] 输出上限真实生效（假阳性、真阳性两个方向均验证）
- [x] 未改动 `shared/protocol.ts`、`agent/` 下文件、`debugger.ts`、`debugger-attach.test.ts`
- [ ] 真实页面/真实圈注场景验证（留给人工复验）
- [ ] agent 侧 `RESULT_VERIFY_READ_TOOLS` 是否纳入 `read_elements`（留给负责 agent 接线的子代理/主代理确认）
