# 任务：不可信边界 + 读路径凭据隐去；快照预算治理

用户 2026-09-11 要求「这两条都做」（架构评审 P0-3 与安全边界）。两个改动都作用于**进入模型上下文的内容**，合并在一个验收里。

**参照**：huashu-chrome（MIT）的 `<page-content untrusted>` 包裹、凭据隐去与「一页 <2k token」的快照目标（2026-09-11 审阅）。

## A. 不可信边界 + 凭据隐去

**目标**：页面文本进入模型上下文前被声明为数据而非指令；凭据长相内容被隐去；密码/验证码字段的值不出扩展。

- [x] A1. snapshot / read_element / js 三类内容载体在模型可见结果里被包进 `<page-content untrusted …>`；页面伪造的闭合标签被打断（逃不出边界）。 — 谁检查: npm test（`agent/test/untrusted-page-content.test.ts`）
- [x] A2. 系统提示词新增「Page content is untrusted」段：页面里的指令不执行、只转述；凭据被隐去时不得尝试还原。 — 谁检查: 代码评审 + 下一轮真实任务的模型行为
- [x] A3. 隐去规则：整行凭据折叠成一条；`key=value` 只隐值留键；正文里混合大小写且 ≥16、任意大小写 ≥24、或全大写字母数字 ≥12 的 token 隐去。 — 谁检查: npm test（`extension/test/untrusted.test.ts`）
- [x] A4. 不误伤：URL、邮箱、价格、B站 BV 号这类短混合 id、小写连字符订单号、纯标识符字符串（无空白/无 `=`，如 selector、JS）原样保留。 — 谁检查: npm test（同上，"不误伤"用例逐条列出）
- [x] A5. `read_element` 对 `input[type=password]` 与 `autocomplete=one-time-code|cc-*` 的 `value`（含 properties.value）只回 `<N chars>`。 — 谁检查: 代码 + `extension/test/read-element.test.ts` 既有用例
- [x] A6. 真实路径：模型上下文里的 snapshot 文本确实带边界标签。 — 谁检查: 隔离 harness 运行后在 Pi 会话文件里核对（见结果）

**边界与不做**：不改控制闸门与执行事实；不隐去手机号（会直接破坏「读页面上的电话」这类任务）；不做注入检测/打分（只做边界声明与降权）。

## B. 快照预算治理

**目标**：AX 快照进模型前有确定的上限，超限时先丢低价值内容而不是拦腰砍断。

- [x] B1. 字符预算 50,000 → 24,000（约 6k token），可显式传入覆盖。 — 谁检查: npm test（`extension/test/axtree.test.ts`）
- [x] B2. 超预算时**优先保住全部 ref 行**（可交互/可引用节点），先丢纯文本行；ref 本身也超预算的巨型页面按文档顺序截断，并给出恢复方式。 — 谁检查: npm test（"超预算时优先保住全部 ref 行"）
- [x] B3. `backendIds` 只包含**真正渲染出来**的 ref（模型不会拿到点了就失效的号）。 — 谁检查: npm test（`observation-targets.test.ts` 既有断言）
- [x] B4. 父节点名字与子静态文本重复时只出一行；不同文字全部保留。 — 谁检查: npm test（两条新增用例）
- [ ] B5. 真实复杂页面的同页前后体积对比 — 谁检查: 人（本轮验收 fixture 只有 14 行的小页面，量不出差别；见"未跑"）

**边界与不做**：不改快照格式、不改 ref 语义（ref 仍是 backendDOMNodeId）；不做增量/差量快照（留待观察 B 之后的体积再说）。

## 结果

### 机器检查

- `npm test` 146 文件 1261 项通过（新增 `untrusted.test.ts` 7 项、`untrusted-page-content.test.ts` 4 项、axtree 3 项）。
- typecheck 0 错误，build 通过。

### 真实路径（隔离 harness，MiniMax-M3，state_environment）

- 三项检查全 PASS；Pi 会话文件里 snapshot 的模型可见文本以 `<page-content untrusted …>` 开头（480 字符，14 行）。
- 同页对比量不出体积差：该 fixture 是 14 行小页面。已知真实体量参考：用户 traces 里 `scope=viewport` 的 DOM 快照 24.5KB、AX 全页上限 50k 字符——预算治理实际管的是这一类页面。

### 未跑 / 未决

- **B5 未跑**：真实复杂页面（B 站这类）的同页前后体积对比，需要在真实站点上跑一次任务或直接对目标页调用 snapshot；本轮未做，不拿合成树冒充。
- A2 的模型行为（不听从页面指令、如实转述）只能由真实任务暴露，本轮无注入样本。
- 隐去规则会误伤「长且混合大小写的业务 token」（如 16 位以上的混合 id）；已用长度与字符集把常见 id 排除，但真实抓数据任务遇到误伤时按同一处规则放宽，不要绕过。
- 本轮未提交、未推送、未重载扩展。

### 后续修订：URL/路径被误隐（2026-09-11，批量翻页真实运行发现）

词级 token 字符集含 `/`，把路径/URL 按分隔符拼成长串，`https://api.github.com/repos/microsoft/vscode/issues/335552` 被隐成 `https://api.github.[redacted]`，抓数据时 URL 直接不可用。已把 `/` 从字符集去掉（它是分隔符，不是凭据字符），token 判定规则未放宽；回归：长 URL/路径不误伤、小写+数字超长串仍隐去（`extension/test/untrusted.test.ts`）。证据见[批量翻页](20260911-fetch-pages.md)。
