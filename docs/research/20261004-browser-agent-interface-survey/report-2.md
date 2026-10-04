# 调研原文二：执行层、EGO 拆解与实验设计

> 用户 2026-10-04 提供的调研原文，逐字保留（只去掉外层括号）。资料访问日 2026-10-04；本项目未运行文中工具。理解与对照见[上级摘要](../20261004-browser-agent-interface-survey.md)。

对你们，最值得参考的不是单一工具：交互语义以 Playwright 为基线；EGO lite v2 的 ref 生命周期、失败回执和“只在输入发出前重试”最值得借鉴；agent-browser 的增量观察值得抄。EGO 的核心 Snapshot 生成在闭源浏览器中，无法审计。现有公开评测没有同时固定模型、任务、登录态、权限与成功判据，因此无法确认“总冠军”。

以下资料均实际联网核查，访问日为 2026-10-04。版本日期只写能从 release/源码确认的内容。我没有运行这些工具，也没有对你们的源码做审查；下面的“工程判断”会明确标出。

## A. 模型和浏览器之间，究竟是谁在包装和执行接口

```text
┌──────────────────────────── 完整 AI 浏览器 / Agent 产品 ────────────────────────────┐
│  用户 UI、登录态、权限、确认、工作区、审计、下载、接管/取消、恢复                    │
│                                                                                     │
│      ┌──────────── Agent 决策循环 ────────────┐                                     │
│      │ LLM：观察 → 选择动作 → 读回 → 判断 → 下一步 │                              │
│      └──────────────────┬─────────────────────┘                                     │
│                         │ tool call / result                                         │
│      ┌──────────────────▼─────────────────────┐                                     │
│      │ 模型可见工具层                         │                                     │
│      │ snapshot / click / fill / wait / ...  │                                     │
│      │ MCP、CLI+Skill、Function Calling       │ ← 这些是“怎么暴露工具”              │
│      └──────────────────┬─────────────────────┘                                     │
│                         │                                                           │
│      ┌──────────────────▼─────────────────────┐                                     │
│      │ 执行/适配层                            │                                     │
│      │ 权限检查、ref解析、等待、回执、重试    │ ← Playwright 可位于这里             │
│      └──────────────────┬─────────────────────┘                                     │
└─────────────────────────┼───────────────────────────────────────────────────────────┘
                          │
        ┌─────────────────▼────────────────────┐
        │ Chrome 扩展 API / chrome.debugger   │
        │ CDP / 页面脚本 / Input / DOM / AX   │ ← 浏览器底层控制能力
        └─────────────────┬────────────────────┘
                          ▼
                   Chromium + 真实网页
```

你原来的理解基本正确，还需要补一句：**Agent 质量很大一部分产生在“底层浏览器能力”和“LLM”中间这层。** 同一个 CDP，可以包装成很脆的 `click(x,y)`，也可以包装成带页面身份、actionability、ref 生命周期、执行回执和后置验证的 `click(target)`。

Chrome 官方把 `chrome.debugger` 定义为 CDP 的替代传输方式；扩展可以向 tab/iframe/worker 目标发 CDP 命令，但出于安全原因只开放部分 CDP domain。跨进程 iframe 还需要处理 `Target.setAutoAttach(... flatten:true)` 和递归子目标。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?hl=zh-CN)

MCP 则只是工具协议/契约层。当前规范是 2026-07-28 revision；它规定请求、工具调用、授权等，不负责浏览器自动化本身。[Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-07-28/)

所以：

- CDP：浏览器底层协议。
- Playwright：建立在浏览器能力上的自动化 runtime/API。
- MCP：把某组能力暴露给 Agent 的协议。
- LLM：选择动作的人。
- Browser Use：还额外提供了 Agent loop。
- EGO lite：再往外包了一层自己的浏览器、Spaces、登录数据和 Agent 接入。
- 你们的 Chrome 扩展：目前同时承担“适配/执行层 + 产品安全层”。

### 接口数量和质量：没有单调关系

我没有找到一项公开、可复现研究能证明“工具数量增加 → 浏览器任务成功率单调上升”。真正有证据支持的是下面这些局部关系。

| 维度 | 有公开证据的部分 | 工程判断 |
|---|---|---|
| 页面观察 | Playwright MCP、DevTools MCP 都用结构化 a11y snapshot；Browser Use 会组合 DOM/AX 等；agent-browser 有 snapshot delta。[GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/snapshots.mdx) | 观察覆盖率比“read 工具有几个”重要。AX、DOM、截图最好互补。 |
| target/ref | Playwright MCP 的 ref 只在当前 snapshot/page state 有效；Playwright locator 每次操作重新解析最新 DOM。[GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/snapshots.mdx) | ref 应绑定 document/frame/page 身份，而非只是一个短数字。 |
| 动作语义 | Playwright 在 click 前检查 visible、stable、receives-events、enabled 等条件。[Playwright](https://playwright.dev/docs/actionability) | “CDP Input 已发出”远弱于“正确目标可操作且动作真的产生预期效果”。 |
| 等待/时序 | Playwright 下载示例明确要求先监听 `download`，再点击。[Playwright](https://playwright.dev/docs/downloads) | 对导航、弹窗、下载等，应先挂事件观察，再触发动作。盲 `sleep` 应是最后退路。 |
| 错误/回执 | EGO v2 只在输入尚未 dispatch 时重试 iframe lifecycle 错误，目的就是避免不确定状态下重复 gesture。[GitHub](https://github.com/citrolabs/ego-lite/pull/364) | 你们已有 executed / not-executed / unknown，比单纯 success/error 更适合非幂等动作。 |
| 结果核验 | BU Bench V2.1 的 Judge 看完整轨迹、deliverables 和动作后的截图，且明确要求验证任务是否真正发生，而非相信 Agent 自报成功。[GitHub](https://github.com/browser-use/benchmark/blob/main/README.md?utm_source=chatgpt.com) | 工具成功只是中间状态；产品应该验证用户真正要的 postcondition。 |
| Token/上下文 | Playwright/DevTools 支持搜索、分页、文件输出；agent-browser 0.38 加了 snapshot delta 和 unchanged screenshot suppression。[GitHub](https://github.com/microsoft/playwright-mcp/releases) | 压缩“重复观察”往往比少暴露几个动作更有效。暂无公平数据能说谁 token 最低。 |
| 批量执行 | Browser Use 默认每 step 最多可做 5 个 action；公开 bug 显示，某些失败动作曾被报成成功，使后续 `multi_act` 继续跑。[GitHub](https://github.com/browser-use/browser-use/blob/main/skills/open-source/references/agent.md) | 批量越长，越依赖准确的中间回执。跨状态变化的 batch 会把一次错误放大成连续错误。 |
| 安全 | MCP 官方明确说 `readOnlyHint` 等只是 hint，不是 enforcement；Playwright MCP 把任意服务器端 JS 明确标成 RCE-equivalent。[Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/) | “沙箱中执行”只说明隔离边界，不证明代码对网页没有副作用。 |

因此我会把工具数量理解成：

> 能力缺失时，新增接口能提升上限；能力覆盖之后，继续拆工具的边际收益迅速下降。此后质量主要取决于 observation、identity、action semantics、receipt、verification 和 safety。

这是工程判断，不是已有 benchmark 得出的普适定律。

---

## B. 当前方案比较

版本均截至 2026-10-04。

| 对象 | 主要优势 | 关键局限 | 对你们 Chrome 扩展的可迁移性 | 证据强弱 |
|---|---|---|---|---|
| **EGO lite 2.0.0**，2026-09-10 [GitHub](https://github.com/citrolabs/ego-lite/releases) | ref 生命周期、OOPIF 处理、安全重试边界、TaskSpace receipt；JS 组合工具这一思路与你们相近 | Snapshot 真正生成器和浏览器定制闭源；“最强 Snapshot”“2.5×”是厂商自测 | **高：**ref/回执/重试思想；**低：**内核 Snapshot、Space | 连接层高；核心 Snapshot 未知；性能宣传弱 |
| **Playwright MCP 0.0.83**，2026-09-28 [GitHub](https://github.com/microsoft/playwright-mcp/releases) | 成熟 actionability/locator；结构化 snapshot/ref；现在能通过扩展连接用户现有 Chrome，复用登录、cookie、扩展 [Playwright](https://playwright.dev/mcp/configuration/browser-extension) | MCP ref 本身仍是 snapshot scoped；完整 Playwright runtime 不适合直接塞进普通 MV3 扩展 | **很高：**交互语义、等待模型、extension bridge 设计 | 高 |
| **Playwright CLI/Skills 0.1.22**，2026-09-28 [GitHub](https://github.com/microsoft/playwright-cli/releases) | Agent 用 CLI + Skill；适合 coding agent，支持组合代码、snapshot、session | 更像开发者 Agent 工具，不是面向普通 Chrome 用户的产品权限模型 | 中高，重点看 Skill 和 bounded composition | 高 |
| **Playwright 原生 API 1.63.0**，2026-09-04 [GitHub](https://github.com/microsoft/playwright/releases?utm_source=chatgpt.com) | 最成熟的 locator/actionability/wait/download primitives；直接代码最灵活 | **它本身不是模型接口**；Node/browser-context 架构与你们扩展运行时不同 | 设计语义极高；代码级迁移低—中 | 很高 |
| **Browser Use 0.13.10**，2026-09-04 [GitHub](https://github.com/browser-use/browser-use/releases) | 完整 Agent loop；DOM/AX/视觉、watchdog、跨源 iframe 可选；多 action/step | 带了你们已经拥有的大量 Agent 层；batch 对错误回执极敏感；公开 #5361 正好展示风险 | DOM/恢复/watchdog 可借；整体替换意义不大 | 源码高；跨框架排名中 |
| **Chrome DevTools MCP 1.10.1**，2026-09-23 [GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases) | 最贴近 Chrome；网络、console、performance、CSS、extension 调试能力非常强 | snapshot 是 a11y UID 模型；安全策略明确交给 calling agent/client；更偏 DevTools | **非常高**，尤其网络/console/下载/诊断能力 | 高 |
| **Vercel agent-browser 0.38.1**，2026-09-16 [GitHub](https://github.com/vercel-labs/agent-browser/releases) | Rust 原生 daemon + CDP；delta snapshot、conditional screenshot、明确 wait 指南；CLI 对 Agent 很干净 | 仍存在重要 ref/receipt 边界问题；自己 benchmark 主要测 command latency，不是任务成功率 | snapshot delta、tab pin、输出设计值得借 | 源码高；端到端质量证据弱 |
| **Browser Harness 0.1.13**，2026-09-04 [GitHub](https://github.com/browser-use/browser-harness/releases) | 极端“代码/可编辑 helper”路线；直接连接真实登录 Chrome；适合研究工具组合 | 同时暴露 `browser_js`、`browser_cdp` 等强能力，若权限层不在下面会形成策略逃生口 [GitHub](https://github.com/browser-use/browser-harness/blob/main/docs/MCP.md) | 你们已有更受控的 `browser_run`，主要用于反证/安全设计参考 | 源码高；任务质量证据有限 |

我不会给“第一名”。

如果限定为“**你们这种真实用户 Chrome 扩展应该读谁的设计**”，我的顺序是：

**Playwright 的交互语义 → EGO v2 的 identity/recovery → agent-browser 的 observation compression → Chrome DevTools MCP 的诊断能力。**

Browser Use 更适合研究完整 Agent orchestration；Browser Harness 更适合研究“代码作为工具接口”的极端形态。

一个很有代表性的反例来自 agent-browser：2026-09-18 的公开 #1922 显示，click 引发导航后，旧 snapshot ref 仍可被解析；下一次对旧 ref 的 click 实际没有发生，却输出 `✓ Done` 并 exit 0。问题在 0.37.1 发现，报告称 0.38.0 相同代码路径；截至访问时 issue 仍 open，而 0.38.1 release notes 没列该修复。我没有自行复现 0.38.1。[GitHub](https://github.com/vercel-labs/agent-browser/issues/1922)

这件事比“它有多少个动作接口”重要得多。

另外，agent-browser 自带的 benchmark 明确主要测 daemon command latency、内存和启动等；它不能支持“任务质量最好”的结论。[GitHub](https://github.com/vercel-labs/agent-browser/blob/main/benchmarks/README.md)

---

## C. EGO lite：实际拆开以后是什么

当前公开 release 是 v2.0.0，2026-09-10。[GitHub](https://github.com/citrolabs/ego-lite/releases)

### C1. 开源部分和闭源部分的边界

最关键的一手证据来自它自己的 `AGENTS.md`：

> `ego-browser` 是 Node.js CDP harness；真正的 `globalThis.ego` bindings 由 **closed-source ego lite app** 提供；公开 repo 包含 harness 和 Skill，**不包含浏览器本身**。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

真实调用链大致是：

```text
Agent 生成 JS
   ↓
ego-browser 开源 helper
   ↓
TaskSpace / Page / ref resolver / CDP runtime       ← 大量代码公开
   ↓
globalThis.ego
   ↓
ego lite App / 浏览器                              ← 闭源
   ↓
Chromium / 定制部分
```

### C2. Snapshot 到底怎么生成

公开源码中的 `snapshot()` 最终做的是：

```text
browserEgo().snapshot(options)
       ↓
closed-source binding 返回结果
       ↓
公开层 compact / ref bookkeeping
```

这可以直接从 `observe.ts` 定位到：`snapshot()` 调用 `browserEgo().snapshot(options)`。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/driver/observe.ts)

因此可以确认：

**公开：**
- snapshot 返回后的压缩/映射；
- ref 管理；
- frame/document/OOPIF 处理；
- CDP session/runtime；
- action/retry；
- Skill 和 JS 组合层。

**无法从公开源码确认：**
- 原始 Snapshot 树究竟如何合成；
- DOM/AX/layout/浏览器内部数据各占多少；
- “browser engine customization”具体改了 Chromium 哪些地方；
- 深层 iframe 优势究竟多少来自内核修改，多少来自公开 OOPIF runtime；
- closed Shadow DOM 如何处理。

README 的确明确宣称“通过 browser engine customization”取得更好的 Snapshot，并称可以可靠处理 deeply nested iframes。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

这能证明**他们这样声明**，不能证明“市场最强”，也不能把具体算法从 README 倒推出来源。

**Shadow DOM：未知。** 我没有找到截至 2026-10-04 足够的一手材料，能证明其 Snapshot 对 open/closed shadow root 的完整语义。

### C3. ref 为什么值得看

v2 最近专门改过 ref 生命周期：

- 普通连续输入可以沿用相同 ref；
- node replacement/navigation 后必须拒绝；
- OOPIF document read failure 不再留下不完整 document map；
- 保留 exact node/document checks；
- PR 报告 488 unit + 69 real-browser E2E。[GitHub](https://github.com/citrolabs/ego-lite/pull/377)

这比简单规定“每次 action 后所有 ref 作废”更精细。

对照 Playwright MCP，它采用更保守的规则：ref unique within snapshot，页面变化后失效，stale ref 明确要求重新 snapshot。[GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/snapshots.mdx)

两者没有谁天然正确：

```text
Playwright MCP
页面变化 → 默认重新观察
优点：规则简单、保守

EGO v2
节点/文档身份未变 → 尽可能保留 ref
节点替换/导航 → invalidate
优点：少 snapshot / 少 token
代价：identity ledger 更难实现正确
```

这正是你们值得做对照实验的地方。

### C4. iframe

公开层确实有实质工作，不全是营销。

EGO runtime 会维护 CDP target/session，并处理 OOPIF；公开代码能看到 auto-attach/session lifecycle。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/browser-runtime.ts)

更重要的是其 2026-09-04 iframe 修复：

> 只在 input dispatch 之前重试 element resolution；一旦输入是否已经发出变得不确定，就不自动重做，从而防止 duplicate gesture。[GitHub](https://github.com/citrolabs/ego-lite/pull/364)

这一条与你们的 unknown-result 原则高度一致。

但“嵌套 iframe 的结构化 Snapshot 为什么比其他方案强多少”，因为原始 Snapshot 生成闭源，仍然**无法核实**。

### C5. 工具组合

README 描述的核心形式确实是：

```javascript
// 概念形态
const s = await snapshot();
await fill(...);
await click(...);
await wait(...);
```

Agent 写一段 JS，一次交给 `ego-browser`；公开架构文档也把数据流写成 `stdin JS → helperContext → browser runtime/CDP → snapshot/DOM/AX`。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

因此 EGO 的速度论点并非凭空来的：一次模型回合可以组合多个确定动作。

但它 README 中的：

- “faster runs on fewer tokens”
- “higher task success”
- “strongest page Snapshot”
- 对 agent-browser “up to 2.5× faster”

目前都应标成**维护方自评/宣传**。README 的 2.5×来自四个任务。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

他们另一个新的 benchmark framework 反而写得比较严谨：默认一次只改变 model，其他 provider route/browser/skill/task/judge/limits/concurrency 固定，而且明确说结果“not a universal leaderboard”。它还保存 JSONL、screenshots、judge artifacts，并提醒 live site/反爬会污染结果。[GitHub](https://github.com/citrolabs/ego-browser-benchmark-framework)

所以我不会用 README 的四个任务证明 EGO 总体更快或更准。

### C6. 登录状态

README 说首次启动可选择**迁移 Chrome 数据**，包括 existing logins、cookies、extensions、bookmarks。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

注意“迁移”和“直接控制用户当前 Chrome”完全不同。

你们已经运行在用户真正的 Chrome 中，这一点反而天然更直接。

Playwright MCP 现在也已经支持 browser extension mode，官方明确说连接 existing browser tabs 并复用 logged-in sessions、cookies、installed extensions。[Playwright](https://playwright.dev/mcp/configuration/browser-extension)

### C7. 独立工作空间

EGO 的公开 API 确认 TaskSpace 是带 `agent/user` ownership 的 isolated browsing contexts，并支持 handoff/takeover。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

但实际浏览器 context/Space 的底层实现位于闭源产品一侧。

在你们“控制用户当前 Chrome profile”的约束下，**不能直接等价复制真正 BrowserContext 级的 cookie/storage 隔离**。作为对照，agent-browser 自己的文档也明确说：每个独立启动的浏览器 session 可以有独立 cookies/storage/auth；如果多个 session 通过 CDP 共用同一个 Chrome，则只有 tab selection 隔离，并没有 cookie/storage 隔离。[GitHub](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/sessions/page.mdx)

这个边界非常值得记住。

### C8. failure recovery / receipt

EGO v2 这一块比宣传性的 Snapshot 更值得你们研究：

- click 被遮挡/不可操作时返回 actionable blocker；
- TaskSpace finish 返回 structured receipt 和 cleanup outcome；[GitHub](https://github.com/citrolabs/ego-lite/pull/356)
- iframe transport uncertainty 后不重复已可能 dispatch 的输入；[GitHub](https://github.com/citrolabs/ego-lite/pull/364)
- download 使用 Playwright 风格的 `waitForEvent("download")`，并测试 concurrent TaskSpaces 和跨 round recovery。[GitHub](https://github.com/citrolabs/ego-lite/pull/353)

这是我认为 EGO 最扎实的部分。

---

## D. 对你们项目，我优先做这 3 件事

先说迁移边界。

**可以直接借：** Playwright actionability、explicit event wait；EGO 的 ref/document ledger、安全 retry boundary、receipt；agent-browser 的 delta/conditional observation。

**需要较大重构才能借：** 如果你们现有结构化观察对 OOPIF/AX/layout coverage 不够，那么 Browser Use 那种 DOM+AX+frame 组合、完整 CDP frame/session lifecycle 才值得做。Chrome 扩展本身已经能通过 `chrome.debugger` 递归挂 OOPIF，所以这是“实现成本问题”，不是原则上做不到。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?hl=zh-CN)

**不能直接复制：** EGO 的定制浏览器 Snapshot 内核和真正独立 Spaces。换浏览器/复制 Chrome profile 才能得到类似的 browsing-context isolation；这与你们“就在用户当前 Chrome 中工作”的核心价值冲突。

### 1. 把 ref 提升成“页面身份 + 元素身份”，并把 actionability 放到 dispatch 前

我会优先于增加任何新工具。

理想上，一个 target 至少逻辑绑定：

```text
tab/page identity
  + frame identity
  + document revision
  + node identity
  + semantic fingerprint
```

动作过程：

```text
resolve ref
   ↓
确认仍是相同 page/frame/document
   ↓
visible / stable / hit-test / enabled
   ↓
dispatch
   ↓
返回 dispatch 状态
```

Playwright locator 每次 action 都重新定位当前 DOM；EGO 选择更复杂的 ref ledger；agent-browser 的公开 stale-ref bug 则展示了 identity 出错的后果。[Playwright](https://playwright.dev/docs/locators)

**改善的用户结果：** 少点错按钮、少对旧页面执行动作、少“界面说成功但其实什么都没发生”，尤其减少随后错误恢复造成的二次操作。

**成立条件：** 你们能够稳定观察 page/frame/document change，并给每次动作绑定执行时的 target identity。

**不值得采用：** 如果绝大多数任务仅做一次只读提取、页面基本不变，复杂 ref ledger 的收益会小很多。

---

### 2. 保留 `browser_run`，加入“危险动作屏障”，而不是追求最长 batch

你们已经有正确的基础：`browser_run` 只是组合已有工具，每个子调用仍走权限检查。

我建议进一步规定：

```text
可连续 batch
读取 → 读取 → 填字段A → 填字段B → 填字段C

需要屏障
──────────────
提交表单
导航
发送消息
创建/删除
付款
下载触发
打开/确认 dialog
权限变化
切 tab / popup
外部副作用
```

遇到屏障：

```text
执行一个动作
→ 收 receipt
→ 重新观察 / 验证
→ 才决定下一步
```

Browser Use 默认支持一 step 多个 action，这确实能省模型轮次；但它自己的 #5361 很好地展示了另一面：某个动作如果实际失败却报告成功，`multi_act` 会在错误前提上继续执行后面的 action。[GitHub](https://github.com/browser-use/browser-use/blob/main/skills/open-source/references/agent.md)

Chrome DevTools MCP 的 `fill_form` 文档也直接称批量填表“更快、更可靠、减少 turn”，但其 tool reference 没提供控制实验，因此我把它视为实现建议，不把这句话当成普适性能证据。[GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/tool-reference.md)

取消语义也建议明确：

```text
batch = [A, B, C, D]

用户在 C 时取消

A: executed
B: executed
C: executed / unknown / not-executed
D: not-executed
```

绝不要返回一个模糊的：

```text
batch cancelled
```

因为它掩盖了前缀动作已经产生的副作用。

**改善的用户结果：** 普通填写/提取仍然快，同时避免“一次错误把后面五步一起带歪”和重复提交。

**成立条件：** 每个子动作都有独立 receipt，而且 executor 能区分“输入还没发出”和“发没发出未知”。

**不值得采用：** 如果页面每一步都会强烈改变状态，或者动作天然非幂等，batch 本身就没多少价值，顺序执行更好。

另外要专门 audit 一个边界：

> 如果 `browser_run` 内 JS **只能**调用那些已经过权限检查的 helper，它是受控组合器；如果它还直接获得 `evaluate`、raw CDP、任意 network/fetch 或网页执行上下文，则它可能绕过声明式工具权限。

不能因为 runtime 在 sandbox 里就认定安全。MCP 官方同样明确说 `readOnlyHint` 是 hint，不是 enforcement。[Model Context Protocol Blog](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/)

这条目前只是你们应该做的 capability-closure 审计，我没有证据说你们存在这个漏洞。

---

### 3. 把“动作后观察”改成“delta + 明确 postcondition”

我会参考 agent-browser 0.38 的两项设计：

- `snapshot --delta`：首次 full，之后返回结构变化；
- screenshot `--if-changed`：画面不变就不重复传图。[GitHub](https://github.com/vercel-labs/agent-browser/blob/main/CHANGELOG.md)

但再加一层你们自己的结果验证：

```text
fill
→ field.value == expected

click "Save"
→ 保存提示出现 / network mutation完成 / dirty state消失

download
→ download event发生
→ 文件完成
→ filename / size / hash/内容符合要求

send
→ 对话中只出现 1 条目标消息

delete
→ 对象不存在 + 没有重复副作用
```

**改善的用户结果：** 少 token、少模型轮次，同时 Agent 不再把“click API 返回成功”当作任务完成。

**成立条件：** delta 有 revision/base ID；不确定时能自动退回 full snapshot/截图；postcondition 是独立观察得到的。

**不值得采用：** canvas、游戏、重动画、视觉编辑器等结构化 diff 很弱的场景。那些页面应该更频繁用视觉观察。

这也是我认为“接口数量”最容易误导的地方：

> 一个 `click` + 好的 receipt + postcondition，往往比 `click / double_click / force_click / smart_click / semantic_click` 五个接口更有价值。

后半句是工程判断，需要下面的实验来证伪。

---

## E. 一个最小、公平、可以推翻上述推荐的实验

我不会现在拿 EGO README 的四个任务和别家的不同 benchmark 拼成排行榜。

先测试你们最关心的“接口设计”。

### 实验臂

保持**同一个模型、同一系统 prompt、同一 Chrome build、同一测试账号、同一权限、同一页面初始状态、同一 token/时间上限**。

```text
A  当前实现
   现有 ref / browser_run / 回执 / 观察

B  Reliability-first
   + document/frame scoped refs
   + actionability
   + pre-dispatch retry boundary
   + hazard barrier
   + postcondition verification

C  Speed-first
   同样底层动作
   允许更长 batch
   尽量减少中间重新观察
```

C 很重要，因为它真正测试“批量操作更快是否值得代价”。

以后若想比较 EGO/Playwright/agent-browser，再把它们做成 D/E adapter；不要一开始把“框架不同、模型不同、浏览器不同”全混在一起。

### 5 类任务

| 类别 | 一个真实任务 | 故意制造的变化 | 最终成功判据 |
|---|---|---|---|
| 1. 动态表单 | 已登录后台修改 5 个字段并保存 | fill 后 React rerender 替换节点 | 5 个值全正确且仅保存一次 |
| 2. 非幂等动作 | 创建一条记录/发送一条测试消息 | submit 刚 dispatch 后断 CDP/延迟 receipt | **恰好一条**；不得 unknown 后盲重试 |
| 3. 下载 | 登录站点下载指定 PDF/附件并保存 | click 同时出现 navigation abort / 延迟 | 文件存在且 hash/内容正确，只下载一次 |
| 4. iframe/overlay | 跨源 iframe 内填写并提交；中途弹 overlay | iframe reload/OOPIF session replacement | 正确 frame 中最终状态成立，无错点 overlay 背后元素 |
| 5. 多 tab + 用户打断 | A 页读取信息，B 页填写；用户中途切 tab/取消 | tab change、popup、takeover/cancel | 不操作错误 tab；取消后无后续动作；已执行动作记录准确 |

测试网站最好分两组：

1. **可控 fixture/sandbox**：用于精确注入 node replacement、transport failure、delay、duplicate-risk。
2. **真实登录站点**：验证生态真实性。

这是因为 live site 会变化。EGO 自己的 benchmark framework 也明确要求把 anti-bot/site drift 与 agent failure 分开。[GitHub](https://github.com/citrolabs/ego-browser-benchmark-framework)

BU Bench V2.1 当前也是按“fresh browser + 完整轨迹 + deliverables + browser-event 后截图 + rubric judge”组织证据，而不是数 click 成功次数。[GitHub](https://github.com/browser-use/benchmark/blob/main/README.md?utm_source=chatgpt.com)

### 每次运行记录

至少保留：

```text
task_success                 最终任务是否真的完成
side_effect_count            多发/多建/错删/错tab/错站点
confirmation_violation       是否越过应确认动作
unknown_count                出现多少次 unknown
unknown_safe_recovery_rate   unknown 后安全恢复比例
stale_target_failures        ref/文档身份相关失败
recovery_steps               从失败回到正确轨道要几步
wall_time                    总耗时
model_turns                  模型轮次
input/output/cache_tokens
browser_subcalls
snapshot_bytes
cancel_correctness
```

评判者不要只看 Agent 的最终文字。

以独立证据为准：

```text
服务器状态
DOM/页面最终状态
下载文件 checksum
消息/记录实际数量
浏览器 screenshot
执行 journal
```

EGO benchmark framework 目前同样把 session JSONL 作为 duration、turns、tokens、cost、tool usage 的源数据，而不是从最终报告倒推。[GitHub](https://github.com/citrolabs/ego-browser-benchmark-framework)

### 如何推翻我上面的推荐

这部分要在实验前写死，否则很容易事后解释。

**推翻建议 1——复杂 ref/document ledger：**  
如果在大量 DOM replacement、导航、iframe replacement 场景中，B 相比 A 没有降低 stale target、错动作和 unsafe recovery，同时明显增加延迟/复杂度，那么不值得做复杂 ledger，改用 Playwright MCP 那种“页面变了就重新 snapshot”的简单策略。

**推翻建议 2——batch hazard barrier：**  
如果 C 在注入 transport uncertainty、取消、partial failure、非幂等提交以后，仍然与 B 保持同样的零重复/零错操作，同时稳定显著降低 wall time、turn 和 token，那么我的屏障策略过于保守，应该允许更长 batch。

**推翻建议 3——delta + postcondition：**  
如果 delta 经常漏掉影响下一步判断的页面变化，导致不得不频繁 fallback full snapshot，最后 token/延迟并没有下降，甚至降低成功率，那么保持 full observation 更合理。

最核心的总指标可以非常简单：

```text
                  完整完成任务
                       │
           ┌───────────┴───────────┐
           │                       │
       没有副作用？             有副作用
           │                       │
      PASS / 看效率               FAIL
           │
     再比较 time
        turns
        tokens
       recovery
```

这会比“30 个接口 vs 20 个接口”“一次能跑 10 个 action vs 5 个 action”更接近你们产品真正想优化的东西。

综合目前的一手证据，我会把你们下一阶段的技术假设写成一句：

> **先提高 observation→identity→action→receipt→verification 这一条链的可信度，再优化一轮里能塞多少动作。工具数量只补能力缺口；batch 只在中间状态不影响下一决策时换取速度。**

这部分目前有 Playwright、EGO 的实现证据，以及 Browser Use / agent-browser 的公开失败案例支撑；但“这一定能让你们总体成功率提升多少”仍然必须由上面的同条件实验回答。
