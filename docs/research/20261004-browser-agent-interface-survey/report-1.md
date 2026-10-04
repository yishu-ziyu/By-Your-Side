# 调研原文一：分层、方案比较与 D1–D3 建议

> 用户 2026-10-04 提供的调研原文，逐字保留（只去掉外层括号）。资料访问日 2026-10-04；本项目未运行文中工具。理解与对照见[上级摘要](../20261004-browser-agent-interface-survey.md)。

截至 2026-10-04，我最建议你们以 Playwright 的定位/动作语义为基线，吸收 agent-browser 的紧凑观察与会话身份、EGO Lite v2 的回执/OOPIF/人机交接设计；不要照搬 EGO 浏览器。EGO 的内核 Snapshot 很值得研究，但核心实现闭源。现有公开评测没有在同模型、同任务、同权限、同登录状态下比较这些方案，因此无法确认“总冠军”。

下文资料访问日期均为 2026-10-04。版本日期只在官方 release / 源码能核实时写。

## A. 模型与浏览器之间，到底有哪几层

```text
用户目标
  │
  ▼
┌──────────────────────────────┐
│ ④ Agent 决策循环             │
│ 观察 → 判断 → 选动作 → 执行   │
│ → 看结果 → 恢复 / 结束        │
│ Browser Use 主要覆盖到这一层   │
└──────────────┬───────────────┘
               │ tool call
               ▼
┌──────────────────────────────┐
│ ③ 模型可见的工具接口          │
│ snapshot / click / fill       │
│ wait / download / evaluate…   │
│                              │
│ MCP、CLI、Skill、你们的工具协议 │
│ 都属于“怎么把能力交给模型”     │
└──────────────┬───────────────┘
               │ translate
               ▼
┌──────────────────────────────┐
│ ② 自动化/执行层               │
│ Playwright / Browser Use DOM  │
│ agent-browser / EGO harness   │
│ 负责定位、等待、重试、事件关联 │
└──────────────┬───────────────┘
               │ CDP / extension APIs / JS
               ▼
┌──────────────────────────────┐
│ ① 浏览器底层能力              │
│ Chrome + CDP + DOM/AX/Input   │
│ Network / Target / Storage…   │
└──────────────────────────────┘
```

所以你的初步理解基本正确，但需要补一层：**模型调用的工具通常不会直接等价于 CDP 指令。中间还有定位、等待、引用管理、回执、恢复等执行语义。**

MCP 是工具传输/描述协议；CDP 是 Chrome 的底层控制协议；Playwright 是浏览器自动化抽象；模型负责决策。它们不在同一层。

Chrome 扩展通过 `chrome.debugger` 已能访问 Accessibility、DOM、DOMSnapshot、Input、Network、Page、Runtime、Storage、Target 等大量 CDP domain。换句话说，你们并不因为“是扩展”就天然缺少构建高质量 Agent 接口的底层原料。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger)

---

## 2. 工具接口越多，任务质量越好吗？

结论是：

**没有单调关系。**

我没有找到任何可信公开实验，能够“只改变工具数量，其他全部固定”，然后证明工具越多成功率越高。

真正影响质量的是下面这条链：

```text
看得对
  ↓
指的是同一个目标
  ↓
动作在正确时刻真正执行
  ↓
知道执行到了哪一步
  ↓
确认页面/业务状态真的变成预期
  ↓
失败时不会重复造成副作用
```

### 观察质量

结构化 Accessibility Tree 很适合按钮、输入框、文本；DOMSnapshot还能带 DOM、布局、`backendNodeId`、frame，并把 Shadow DOM 展平。CDP 自身的 `captureSnapshot` 明确包含 iframe、template 等文档，并 flatten Shadow DOM。[GitHub](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOMSnapshot.pdl)

因此，“Snapshot 好”不等于“工具多”。

真正的问题是：

- 有没有漏掉跨域 iframe；
- 可点击性是否准确；
- 页面视觉上重要但 AX Tree 中很弱的东西怎么办；
- 动态页面变化后旧观察如何失效；
- 输出是否压缩得足够好。

EGO 宣称拥有“市场最强 Snapshot”，并称优势来自浏览器内核修改，但公开仓库没有 Snapshot 内核生成算法，无法独立验证这个最高级比较。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

### 目标定位与引用失效

这是我认为比“工具数量”重要得多的一项。

Playwright 原生 `Locator` 每次执行动作都会重新查找当前 DOM，因此 React 重渲染后，如果语义目标仍然成立，它可以命中新元素；click 前还检查 visible、stable、receives events、enabled 等条件。[Playwright](https://playwright.dev/docs/locators)

这和“Snapshot 给模型一个 `@42`，以后一直点 `@42`”完全不同。

agent-browser 到 v0.38.1 又走了另一种路线：同一存活 DOM 元素的 ref 可以跨 Snapshot 保留；页面或 iframe navigation 才失效，同时支持 delta Snapshot。[GitHub](https://github.com/vercel-labs/agent-browser)

EGO v2.0.0 也专门修了 iframe ref provenance、iframe 生命周期重试和跨 action/round 的 Page ref 保留。这说明引用生命周期本身就是核心工程问题。[GitHub](https://github.com/citrolabs/ego-lite/releases)

### 动作语义

`click` 不是一个简单指令。

高质量的 click 至少要回答：

```text
目标唯一吗？
可见吗？
还在动吗？
有没有被弹窗挡住？
真的能接收 pointer event 吗？
点击前页面还是我观察到的那一版吗？
```

Playwright 把这些 actionability checks 做成底层契约，这是目前我认为最值得你们借鉴的部分。[Playwright](https://playwright.dev/docs/actionability)

### 等待与时序

低质量接口经常让模型自己写：

> click → sleep 2 秒 → snapshot

Playwright 把很多等待放进动作内部；Chrome DevTools MCP 的动作则有 `waitForEventsAfterAction`；显式 `wait_for` 会在满足条件后返回新 Snapshot。[GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/input.ts)

关键不是“有没有 wait 工具”，而是：

**动作完成的定义是什么？**

“DOM click 已 dispatch”与“订单已经创建”是两件事。

### 执行回执与结果核验

这是你们当前思路里非常重要的一块。

Chrome DevTools MCP 的 `fill_form` 就提供了一个很好的反例：如果填写第 2 个字段时弹出 JS dialog，它会停止，并明确告诉调用者后面的字段没有填。它不会把整批任务简单标成 success。[GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/src/tools/input.ts)

但它返回：

> Successfully clicked

也仍然只证明操作层成功。

它并不自动证明：

> 邮件真的发出了。

这是两个层级：

```text
execution receipt
“我点击了 Submit”
       │
       ▼
effect verification
“服务器中确实只创建了 1 条记录”
```

这里“应该分层”属于工程判断；Chrome DevTools MCP、EGO v2 的 receipts 和 WebArena-Verified 的 network-event evaluator 都提供了公开证据说明这种区分是实际需要。[GitHub](https://github.com/citrolabs/ego-lite/releases)

### Context / token

工具更多确实可能增加模型上下文成本。

Playwright 自己现在明确区分：

- MCP：结构化 tool schema + Snapshot，适合持续探索式 Agent loop；
- CLI + Skills：命令更短，Skill 按需加载，官方称 token 开销更低。[GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/introduction.mdx)

这是官方设计判断，不是证明“CLI 成功率更高”的对照实验。

此外，页面 Snapshot 本身常常比 tool schema 更大。agent-browser 因此提供 interactive / compact / depth / scope / delta 等压缩方式。[GitHub](https://github.com/vercel-labs/agent-browser)

### 批量执行

批量执行的收益是真的：少模型轮次、少进程启动、少重复 Snapshot。

风险也是真的：

```text
fill A
fill B
click Continue   ← 页面改变
fill C           ← 这里的 C 可能已经不是原来的 C
click Submit     ← 更危险
```

agent-browser 的 `batch` 默认可以继续执行；要显式 `--bail` 才在第一个错误时停止。[GitHub](https://github.com/vercel-labs/agent-browser)

Browser Use 默认允许一个 step 最多产生 5 个 actions；其 2026-08 的一个公开 issue 就指出某些“element not found”曾被包装成非错误结果，这种错误分类会让后续排队动作继续执行。这个是**公开 bug 报告，不等于我确认 v0.13.10 仍存在同一 bug**。[GitHub](https://github.com/browser-use/browser-use/blob/main/browser_use/agent/service.py)

因此我会把批量执行规则写成：

> 可以跨“无副作用、目标彼此独立”的操作批量执行；一旦下一步依赖上一动作造成的新页面状态，就插入 observation barrier。

这部分是工程建议，不是某个项目已经证明的定律。

### 任意页面 JavaScript

这里必须非常谨慎。

`evaluate(() => ...)` 可以：

- 改 DOM；
- `form.submit()`；
- 发 fetch；
- 改 localStorage；
- 触发导航；
- 调站点自己的 JS API。

所以“沙箱里运行 JavaScript”只能证明宿主语言隔离，不能证明页面没有副作用。

agent-browser 自己的安全文档甚至明确警告：如果允许 `eval`，页面脚本理论上可以恢复它为了域名隔离而覆盖的构造函数，因此最大保护模式建议直接 deny `eval`。它的 domain allowlist 甚至不能与既有 CDP session / Chrome profile 等模式同时使用，因为浏览器可能在防护安装前已经运行页面代码。[GitHub](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/security/page.mdx)

Chrome 也明确警告 MAIN world 脚本与宿主页面共享 JS 环境，页面可以访问、干扰它；默认 ISOLATED world 才是隔离环境。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts)

对你们来说，已有的 `browser_run` 如果**只能组合已有权限检查工具**，这一点反而很好。需要单独审计的是任何可以绕开这些工具、直接在页面执行副作用 JS 的入口。

---

# B. 当前方案比较

| 对象 | 最值得学的东西 | 关键局限 | 对 Chrome 扩展可迁移性 | 证据 |
|---|---|---|---|---|
| **EGO Lite / ego-browser v2.0.0**，2026-09-10 | Task Space、用户/Agent ownership、OOPIF/ref ledger、组合 JS、下载/receipt | 真正浏览器与 native bridge 闭源；“最强 Snapshot”无法审计 | **中**：harness 思路可学；Space/内核能力不能原样搬 | harness 源码强；浏览器核心弱 [GitHub](https://github.com/citrolabs/ego-lite/releases) |
| **Playwright MCP 0.0.83** | 很成熟的动作语义、Snapshot→ref Agent loop、现有 Chrome extension 模式 | MCP Snapshot refs 本身仍会随页面变化失效；schema/context 较重 | **高**：尤其定位、actionability、wait 语义 | 强 [GitHub](https://github.com/microsoft/playwright-mcp/blob/main/package.json) |
| **Playwright CLI + Skills 0.1.22** | 更紧凑的 Agent surface；Skill 按需加载；可运行组合代码 | 面向 coding agent/terminal，不等于消费级侧栏产品接口 | **中**：适合参考协议形状 | 强 [GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/introduction.mdx) |
| **Playwright 原生 v1.63.0**，2026-09-04 | Locator、auto-wait、frame locator、网络/下载/断言体系 | 本身不是给 LLM 的工具协议；需要你们再包装 | **高（设计层）** | 很强 [Playwright](https://playwright.dev/docs/actionability) |
| **Browser Use 0.13.10**，2026-09-04 | 完整 Agent loop、DOMSnapshot+AX、视觉、失败/规划/loop detection | 把 Agent 策略与浏览器接口混在一起比较容易失真；多 action 更依赖正确回执 | **中** | 源码强；其 BU Bench 属厂商自有评测 [GitHub](https://github.com/browser-use/browser-use/releases) |
| **Chrome DevTools MCP 1.10.1**，2026-09-23 | 最接近你们底层；CDP、console/network/performance；部分批量操作有清晰中断语义 | 更偏 DevTools/debugging，Agent 浏览 UX 未必最简 | **很高** | 很强 [GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases) |
| **Vercel agent-browser v0.38.1**，2026-09-16 | 极紧凑 Agent UX、delta snapshot、持久 ref、严格 tab pin、安全 policy | 安全默认 opt-in；batch 与 eval 需谨慎；profile copy ≠ 用户实时 Chrome | **高（模式层）** | 很强 [GitHub](https://github.com/vercel-labs/agent-browser/releases) |

如果强迫我各选一个：

**动作执行契约：Playwright。  
Agent-facing 接口设计：agent-browser。  
人和 Agent 共用浏览器的产品架构：EGO Lite。  
与你们当前 Chrome 扩展底层最贴近：Chrome DevTools MCP。**

我没有证据把其中任何一个宣布成“总体最好”。

还有一点值得纠正 EGO README：它把其他方案描述成登录状态“rarely carries over intact”，现在至少不能泛化到 Playwright。Playwright MCP/CLI 已正式提供 Extension 模式，可以直接连接现有 Chrome/Edge 标签页并复用登录、cookie、扩展和已有 tab。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

---

# C. EGO Lite：实际能确认到什么

最重要的结构是：

```text
开源
ego-browser JS harness / Skill
       │
       │ globalThis.ego
       ▼
闭源
native EgoBindings
       │
       ▼
单独下载的 ego lite 浏览器
       │
       ▼
Chromium / Browser Process
```

EGO 自己的 `AGENTS.md` 写得非常明确：仓库包含的是 open-source harness 和 Skill，**不是浏览器本体**；`globalThis.ego` 由 closed-source ego lite app 提供。`CONTRIBUTING.md` 也明确浏览器 application 与 native bindings 单独提供。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

### 1. Snapshot 怎么生成？

能确认的是：

- 开源 runtime 通过 `globalThis.ego.sendCDPMessage` 与浏览器通讯；
- harness 管理 session、ref、DOM/AX resolution、OOPIF 等；
- ref 中涉及 browser/native 返回的节点身份和 frame provenance；
- EGO 声称 Snapshot 还利用浏览器内核定制。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/package/ego-browser/src/browser-runtime.ts)

不能确认的是：

**native/browser process 究竟怎样生成最终语义 Snapshot。**

我没有找到其浏览器内核对应的公开实现。

所以 README 的：

> strongest page Snapshot on the market

目前只能标为**厂商主张**。

而且 Chromium 自己的 `DOMSnapshot.captureSnapshot` 已经能返回 iframe、布局信息并 flatten Shadow DOM，所以仅仅“能读 iframe / Shadow DOM”本身并不能证明 EGO 有内核独占优势。[GitHub](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOMSnapshot.pdl)

### 2. 哪些确实依赖定制浏览器？

公开资料能确认：

**依赖浏览器/native 层：**

- `globalThis.ego`；
- Task Space 创建与 ownership；
- Profile 选择；
- Browser Process 内对 Task Space/ownership 的校验；
- EGO 自己的 native Snapshot 接口。[GitHub](https://github.com/citrolabs/ego-lite/wiki/Ego-Browser-CLI-Architecture)

**不必然依赖定制浏览器：**

- CDP 控制；
- OOPIF auto-attach；
- BackendNodeId / frame identity；
- AX/DOMSnapshot；
- click/fill/wait；
- ref ledger；
- recovery policy；
- JS 组合 runner。

这些能力 Chrome/CDP 本身基本都有构建材料。你们已有的 Chrome 扩展尤其如此。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?authuser=0000)

### 3. 工具如何组合？

EGO 的 agent 输出一段 JavaScript；CLI 把它作为 async JS 执行，预注入 snapshot/click/fill/wait 等 helper。

因此可以：

```text
snapshot
→ 找 20 行数据
→ loop
→ fill/click/wait
→ 汇总结果
```

在一轮模型输出里完成，而不需要每个动作回模型。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

这一思想与你们已经存在的 `browser_run` 是同一类设计空间，所以我不会把“增加代码执行器”列为建议。

### 4. 登录状态

EGO 首次启动可以迁移 Chrome 数据，包括 login、cookie、extension、bookmark。Task Space 创建时关联一个 Profile；Profile 包括 cookie、site storage 和登录状态。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

但这里有一个重要未知：

**我没有找到足够公开证据证明“两个使用同一个 Profile 的 Task Space，其 cookie/localStorage 写入相互隔离”。**

能确定的是 window/tab/ownership 的隔离。

所以 README 中“fully isolated Space”不能自动解读成“完整独立浏览器存储沙箱”。

### 5. iframe

这一块证据比较扎实。

v2.0.0 专门包含：

- iframe ref provenance；
- iframe lifecycle retries；
- OOPIF/跨 frame 相关修复；
- ref 跨动作保存。[GitHub](https://github.com/citrolabs/ego-lite/releases)

开放 runtime 又维护 CDP session attach/re-attach。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

但“deep iframe Snapshot 比其他所有实现强”仍然没有公平独立比较。

甚至 2026-08 还有一个公开 issue 指出多个 Task Space 当时共享一个 effectively global CDP channel，可能产生并发 race。它是公开 issue，不应扩大成“EGO Spaces 不可靠”，但说明产品隔离和 CDP transport 隔离并非天然同义。[GitHub](https://github.com/citrolabs/ego-lite/issues/213)

### 6. Shadow DOM

公开 CDP 已能 flatten Shadow DOM。[GitHub](https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOMSnapshot.pdl)

我没有找到 EGO 闭源 browser core 对 closed shadow root 等边界的公开实现，因此这里写：

**未知。**

### 7. 失败恢复

EGO v2 值得借的东西很多：

- session 丢失自动 reattach；
- iframe 生命周期 retry；
- ref provenance；
- action/task receipt；
- user/agent ownership；
- handoff 后禁止 Agent 继续抢控制。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/AGENTS.md)

但 receipt 依然不能自动等于业务效果验证。

### 8. “2.5× faster / fewer tokens”宣传

README 的确写了：4 个复杂任务，对 agent-browser，最多 2.5× faster、tokens 更少。[GitHub](https://github.com/citrolabs/ego-lite/blob/main/README.md)

我没有在这份对比旁找到足够信息证明：

- 相同模型；
- 相同模型 effort；
- 相同任务网站状态；
- 相同登录状态；
- 相同权限；
- 相同 token 预算；
- 相同确认机制；
- 相同成功判据。

因此不能用它决定谁总体更好。

Citro 后来公开了一个 benchmark framework，而且文档明确要求固定 provider route、browser runtime/skill、任务、judge、limits、concurrency，并记录 turns/tokens/cost/tool usage；这套方法本身比 README 对比表严谨得多，但项目自己也标注 Public Beta、非 universal leaderboard。[GitHub](https://github.com/citrolabs/ego-browser-benchmark-framework)

---

# D. 对你们项目，我现在优先做的 3 件事

### 1. 把“元素 ref”升级成“目标身份 + 生命周期”

我会优先借 Playwright + agent-browser，而不是先增加更多工具。

一个 ref 至少绑定：

```text
tab / targetId
frameId
document generation
backendNodeId
role + accessible name
stable semantic locator fallback
```

DOM/navigation 发生哪些变化时失效，要有明确规则。

对于 React 重渲染，可以像 Playwright Locator 一样重新解析语义目标；跨 document/navigation 则拒绝偷偷重定向到“看起来像”的另一个元素。[Playwright](https://playwright.dev/docs/locators)

**用户结果：**少点错按钮、少在重渲染后操作旧目标。

**成立条件：**你们能通过 CDP 维护 frame/document/BackendNodeId 身份。

**不值得做：**纯 canvas、地图、富文本编辑器等主要靠视觉坐标的区域，应该保留截图/视觉路径。

---

### 2. 在你们已有三态回执上，再加“Effect Verification”

你们已有：

```text
executed
not executed
unknown
```

这个方向是对的。

下一步不要再增加一个“success”布尔值，而是分开：

```text
Dispatch
动作有没有送出去？

Execution
浏览器有没有执行？

Observed effects
发生了 navigation / dialog / download /
network request / DOM change 吗？

Postcondition
用户要的结果真的成立吗？
```

例如：

> 创建备忘录

点击完成只是 execution。

真正完成是：

> 新记录存在，而且只存在一份。

WebArena-Verified 已经把 mutation 的检查大量转向 network event，而不是只看页面文字，这一点很值得借鉴。[GitHub](https://github.com/ServiceNow/webarena-verified)

**用户结果：**timeout 后不重复下单、不重复发消息、不重复下载。

**成立条件：**任务有可观察 postcondition。

**不值得做：**纯滚动、读取、无副作用搜索，不需要每一步都做重型核验。

---

### 3. 给已有 `browser_run` 增加“观察屏障”，而不是限制它能执行几个动作

我建议：

```text
安全连续组合
────────────────
read
extract
scroll
wait
fill independent field A
fill independent field B

必须暂停重新观察
────────────────
click that navigates
submit
open modal
switch account
delete
send
purchase
任何 outcome=unknown 的动作
```

尤其：

```text
browser_run:
  fill name
  fill email
  ─── observation barrier ───
  click Continue
  ← inspect new state
```

而不是：

```text
fill → continue → select → submit
```

一次全部跑到底。

同时每个子动作必须继续走你们现有 permission check；直接 page JS 如果能够产生副作用，应作为单独 capability 管理。

**用户结果：**保留批量操作带来的速度，同时避免中间页面变化后连错操作。

**成立条件：**runner 能停止、取消剩余动作，并逐项返回 receipt。

**不值得做：**如果任务每一步天然都需要模型读复杂新状态，那么直接逐步 Agent loop 更简单。

---

# E. 一个最小、公平、可证伪的实验

我不会现在拿 EGO、Playwright、Browser Use 跑一个排行榜。

先在**你们同一个 Chrome 扩展、同一个底层执行器**上测接口设计，才能知道改进来自哪里。

三个实验组：

```text
A  当前实现
B  A + Playwright式 target resolution / actionability
       + 更严格 ref 生命周期
C  B + effect-aware receipts
       + observation barrier / 安全批量执行
```

模型、prompt、reasoning level、Chrome 版本、权限、登录账户、viewport、任务初态全部固定。

选五类：

| 任务 | 故意测试什么 |
|---|---|
| 1. 登录后的后台跨 iframe 读取 20 条数据并保存 | Snapshot / iframe / extraction |
| 2. React 动态表单：填写时触发重渲染 | stale ref / re-resolution |
| 3. 填 6 个字段，中途出现 modal，然后 Submit | batch partial success |
| 4. 点击 Export，等待真正下载完成并核文件内容 | async effect / download |
| 5. “创建一次记录”，服务器响应故意延迟到 timeout | unknown outcome / duplicate prevention |

第 5 类非常重要。

服务器保存 request log：

```text
理想：
create request × 1
record × 1

严重失败：
Agent timeout
→ retry
→ create request × 2
→ record × 2
```

每个任务不要只统计 click success。

记录：

```text
最终任务成功率
严重副作用率
错误目标动作数
重复 mutation 数
unknown outcome 数
恢复成功率

总耗时 / P50 / P95
模型轮次
输入 + 输出 token
Snapshot 字符/token
browser tool calls
用户确认次数
```

建议同一个 task seed 每组至少重复 30 次，并打乱组别顺序。结果用 paired comparison / bootstrap CI，别只比较平均数。

评价方法可以借 WebArena-Verified：最终状态和服务器/network trace 尽量由确定性 evaluator 检查，不让 LLM 自己评价自己的成功。WebArena-Verified 当前明确使用版本化任务和 network-trace/结构化 deterministic evaluator，去掉 LLM-as-judge，是这一类实验很好的方法参考。[GitHub](https://github.com/ServiceNow/webarena-verified)

为了让建议真正可被推翻，我会预先写：

- 如果 **B 在 DOM churn 条件下没有降低 wrong-target / stale-ref failure**，同时耗时或 token 明显增加，那么“不应优先重做 ref/locator 层”。
- 如果 **C 的 conservative barrier 没降低 partial/duplicate mutation，而 latency 明显恶化**，那么我的批量策略不成立。
- 如果 **无 barrier 的 aggressive batch 能稳定降低 ≥15% latency/token，且 95% CI 下 partial/duplicate/wrong action 没增加**，那么应放宽我的保守建议。
- 如果复杂 Snapshot 带来的成功率没有改善，却持续增加 context，则直接砍掉多余观察字段。

这样得到的是你们自己的因果证据，而不是另一个 README 排名。

---

# F. 目前真正还不知道、且会改变技术选择的事

1. **EGO 的闭源 Snapshot 内核具体改了 Chromium 什么。**  
这是最大的未知。没有源码就无法判断其优势能否在普通 Chrome + CDP 重建。

2. **EGO “Space isolation”的存储边界。**  
可以确认 tab/window/ownership/Profile 绑定；同一 Profile 下不同 Space 的 cookie/localStorage 写隔离程度，我没有找到充分公开证据。[GitHub](https://github.com/citrolabs/ego-lite/wiki/Ego-Browser-CLI-Architecture)

3. **各方案在同一个真实登录 Chrome、同一个模型下的成功率。**  
目前没有我能确认的独立 apples-to-apples 评测。

4. **复杂 iframe / OOPIF / closed Shadow DOM 上谁真正最好。**  
EGO 有宣传和相关修复记录；Browser Use、CDP、Playwright 也都有对应机制。缺少同网页 fixture 的独立 failure-rate 数据。

5. **不同接口压缩策略到底省多少 token，又损失多少观察。**  
Playwright 官方认为 CLI+Skills 比 MCP token-efficient；agent-browser 有 delta；EGO 宣传更少 tokens。但没有统一实验。[GitHub](https://github.com/microsoft/playwright.dev/blob/main/mcp/introduction.mdx)

6. **用户正在使用同一 Chrome 时的竞争条件。**  
“Agent tab 身份不漂移、用户切 tab 不影响 Agent、用户关闭目标 tab 后绝不偷偷换到另一 tab”值得单独做压力测试。agent-browser 的 `--pin-tab` 在这里尤其值得抄：目标消失直接 `tab_gone`，而不是 fallback 到别的 tab。[GitHub](https://github.com/vercel-labs/agent-browser/blob/main/docs/src/app/sessions/page.mdx)

所以我对你们当前架构的判断很明确：**暂时没有一手证据要求换掉 Chrome 扩展。最值得投入的是把 CDP 已经提供的能力，变成更强的“观察—目标身份—动作—回执—效果核验”契约。** EGO Lite 最值得学习的是它暴露出来的工程思想；Playwright 最值得学习的是执行语义；agent-browser 最值得学习的是 Agent 接口压缩和失败身份；Chrome DevTools MCP 则是与你们现有底座最直接的实现参考。[Chrome for Developers](https://developer.chrome.com/docs/extensions/reference/api/debugger?authuser=0000)
