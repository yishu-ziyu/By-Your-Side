# 原始报告：浏览器 Agent 提速调研（ChatGPT Deep Research）

来源：ChatGPT Deep Research，2026-10-07 生成（9 分钟，425 次搜索）。原标题“浏览器 Agent 怎样‘更快’而‘不变得更不准’：面向 Chrome 扩展、多模型架构的深度调研”。正文逐字保留，只把引用标记换成编号链接。提示词见 [prompt.md](prompt.md)。理解与对照见[上级文档](../20261007-browser-agent-speed.md)。


## 一页结论

先给判断：**对你们现在这套架构，最大机会不在把 `click()` 再优化几十毫秒，而在减少“必须等一次模型”的次数。** 你们是本机 Chrome + `chrome.debugger/CDP`，已经没有云浏览器 RTT 这一大块损耗；Stagehand v4 的实验也显示，把执行逻辑下沉到浏览器附近时，远程场景收益很大，但作者明确指出本机浏览器的可优化空间会小得多。另一方面，2026 年的 Agent JIT 论文在 Browser-Use 基线中测到约 **73% 延迟来自 LLM 调用**，其核心优化正是把“每一步问一次模型”改成“一次生成/编译一段可执行流程”。 [1](https://www.browserbase.com/blog/stagehand-v4)

结合你们自己的中位数——页面问答约 10 秒、多步复制约 26 秒、两步 PDF 下载约 8 秒、划词解释约 2 秒且几乎卡在 TTFT——我会按下面顺序投入。

| 路线 | 最值得先试的做法 | 为什么适合你们 | 我对收益的判断 |
|---|---|---|---|
| **少走几步** | **成功轨迹编译/缓存成可参数化 replay，失效才回 Agent** | Skyvern 已经把 explore→deterministic replay 做成产品；你们又已经有批量动作工具，改造面最小。Skyvern 厂商自测平均 278.95s→119.92s，即 **2.3×**；Agent JIT 在小型学术评测上比 Browser-Use **10.4×**。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/) | **最高优先级**，尤其是“复制类”与重复网站工作流 |
| **少走几步** | **读操作优先走 direct URL / 页面结构化工具 / 已观察到的只读接口，并用 verifier + browser fallback** | Skim 证明“识别任务模板→直接构造目标 URL→轻量抽取→校验失败再走完整 Agent”在三个 web-agent backbone 上可把延迟降 **33.4% 且不掉准确率**。Chrome 2026 的 WebMCP 正把“网站主动暴露结构化工具”标准化。 [3](https://arxiv.org/abs/2605.16565) | 对问答、查询、下载尤其好；对提交表单要保守 |
| **每步更快** | **全量 AX 改为“基线 + diff + 按需展开”，而不是单纯继续裁剪** | 2026 的观察表示研究得出了很关键的反例：AX/紧凑表示对较弱模型更好，但强模型反而可能从详细 HTML 布局中获益；**diff observation 是更安全的省 token 路线**。 [4](https://arxiv.org/abs/2604.01535) | **先做**。便宜、跨模型、不会要求额外模型供应商 |
| **每步更快** | **只读投机：模型思考时并行预取下一页/解析候选元素/准备候选 snapshot，但不提前提交副作用** | ICLR 2026 的 Speculative Actions 最高做到 **20% 端到端降延迟**、下一动作预测最高 55%；它之所以能称“lossless”，关键是 authoritative actor 确认后才 commit。 [5](https://arxiv.org/html/2510.04371v2) | 中优先级；实现复杂度高于 diff，但很符合“不能更不准” |
| **感觉更快** | **不要等模型第一字才开始 UI：由扩展本地立即显示阶段/进度** | ChatGPT agent、Claude in Chrome 都把执行过程可见化；但我没有找到公开的受控实验能证明这会缩短实际完成时间。它解决的是等待感。 [6](https://openai.com/es-ES/index/introducing-chatgpt-agent/) | 对你们“划词解释 2 秒 TTFT”尤其值：实际总时长不变，也能把“黑屏等待”近乎消掉 |
| **感觉更快** | **先给经过工具事实确认的部分结果，再继续完成剩余工作** | 这不应该靠模型提前猜答案，而应先展示已经确定的中间产物，如“找到 8 项/已复制 3 项/文件地址已找到”。公开产品普遍展示过程，但本次调研**未找到 browser-agent 的严格 A/B 提速数据**。 [7](https://claude.com/claude-in-chrome) | 高性价比 UX 改动；准确率风险主要来自把 provisional 内容伪装成 final |

这里最重要的架构原则是：

> **Fast path 不应该取代可靠路径；它应该是可靠路径前面的一层“可验证捷径”。**

Stagehand 的缓存设计、Skyvern 的 replay、Skim 的 speculative fast path、Agent JIT 的编译执行其实都收敛到同一个结构：**尝试便宜且快的执行 → 检查假设是否仍成立 → 命中就省掉模型循环 → 不命中就回到通用 Agent，而不是硬着头皮继续。** Stagehand 甚至直说了设计取向：错误的缓存点击比慢一次点击更糟，所以页面漂移时宁可 cache miss，再调用模型。 [8](https://www.browserbase.com/blog/stagehand-caching)

这也解释了为什么我**不建议把“更小模型执行每一步”排在第一位**。StepWise 在 OSWorld/WebArena-Verified 上的事件驱动级联最高减少 **45.8% 请求延迟**、推理成本最高减少 74.6%，说明方向确实有效；但它依赖可靠的升级门控，而你们又必须兼容 GLM、MiniMax、Kimi、DeepSeek、OpenAI 等不同入口。相比之下，“少调用模型”和“模型调用期间做安全预取”天然更 vendor-neutral。 [9](https://github.com/yale-nlp/StepWise)

截至 **2026-10-07**，几个产品状态也值得校准：Claude in Chrome 已经是 GA，并允许在护栏下连续执行而不逐步确认；Google 的 Gemini in Chrome/Mariner 已进入 multi-step / auto-browse 路线，Mariner 公开展示了“teach and repeat”；Perplexity Comet 已加入浏览器操作中的偏好记忆；OpenAI 的独立 Operator 早已并入后续 Agent 产品，而当前 ChatGPT Agent 帮助页又注明该产品形态已不再提供、转向 ChatGPT Work；Atlas 则是 OpenAI 2025 年推出的 ChatGPT-centric 浏览器。它们都说明行业正在从“每一动作都临时 reasoning”转向**更长的自治段、记忆/技能和可复用执行结构**，但除少数开源框架和论文外，消费级产品几乎没有公开可比的 latency A/B。 [7](https://claude.com/claude-in-chrome)

## 三条提速路径的证据地图

### 少走几步：真正值得追的是“少一次模型”，不是“少一次 CDP”

目前最强的公开证据来自 **Agent JIT Compilation**。它不再使用标准的“观察→LLM→动作→观察→LLM”循环，而是让模型生成可执行代码计划，再静态检查工具约束、选择成本更低的方案。论文只覆盖 **37 个任务、5 个 web 应用、3 次重复**，因此不能直接把 10.4× 外推到真实 Chrome 产品；但数据非常有启发性。 [10](https://arxiv.org/pdf/2605.21470)

同模型比较中，论文报告：

| 模型 | Browser-Use | Browser-Use + cache | JIT Planner |
|---|---:|---:|---:|
| GPT-4.1 | 150.1s / 61% | 105.2s / 88% | **15.4s / 90%** |
| Gemini 2.5 Flash | 100.3s / 59% | 69.3s / 81% | **7.2s / 94%** |
| Gemini 2.5 Pro | 115.9s / 77% | 65.8s / 86% | **12.6s / 97%** |

这里最值得你们借鉴的不是“照抄 JIT compiler”，而是**把一次模型决定扩展成一段带条件的执行程序**。论文整体汇总为对 Browser-Use **10.4× speedup、+28 个百分点准确率**；作者也明确限制结论：实验是 REAL/WebArena 的 sandbox/self-hosted 环境，并没有验证真实第三方网站、验证码、反爬或大量用户态浏览器状态。 [11](https://arxiv.org/html/2605.21470v2)

产业里更贴近你们的是 Skyvern。它先让 Agent **Explore** 一遍，把成功 trajectory、动作意图和异常恢复信息记下来；之后 **Replay** 编译出的 Playwright，只有页面变化时才重新让 Agent reasoning。Skyvern 报告客户 workflow 的平均运行时间从 **278.95 秒降到 119.92 秒，2.3×**，成本 $0.11→$0.04；这是**厂商自测**，文章没有披露任务总数、具体模型构成和分布，因此可信度低于受控论文，但模式非常贴近生产。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)

Browser Use 也已经提供 rerunnable scripts：把一次成功运行保存，之后直接重跑，网站变化时再 self-heal；它的普通 Agent 也允许一次模型 step 执行最多 **5 个 actions**，减少模型 round trip。但 Browser Use 对 rerunnable scripts **没有公开端到端提速数字，本次调研未找到**。 [12](https://docs.browser-use.com/cloud/agent/scripts)

Stagehand 的粒度更细：缓存 `act()/observe()/extract()` 的解析结果。其 2026 缓存工程文章称，在重复型 workload 中性能提升**最高约 80%**；这是**厂商自测**，采用首跑写 cache、第二次命中 cache 的顺序比较，未披露完整任务数量和模型，因此应理解成“理想重复工作负载上限”，不是通用 Agent benchmark。它还会先做页面 fingerprint，发现漂移就放弃 cache、重新调用 LLM。 [8](https://www.browserbase.com/blog/stagehand-caching)

你们已有“批量多个子动作”工具，所以进一步收益很可能来自**让模型输出更长但受约束的段**，而不是再新增另一套 low-level action。一个可行结构是：

`task → 识别是否已有 skill/replay → 参数绑定 → 一次 batch 执行一个页面阶段 → checkpoint → 继续/回 Agent`

其中 skill 不应只是“click selector A, selector B”，而是保存“意图 + 页面前置条件 + 可参数化变量 + 成功后置条件”。这正是 Skyvern 从“脆弱生成脚本”走向 explore/replay 的经验：它公开展示过简单静态脚本在互相关联的 radio、条件页面和门户随机错误下很快失效，所以 replay 必须保留意图和 fallback。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)

Google Project Mariner 的 **teach and repeat**、Claude 的 reusable skills、Perplexity Comet 的 browser preference memory 都说明“以后不从零学同一件事”正在成为消费产品模式，但三者都**未公开可用于横向比较的提速百分比**。 [13](https://blog.google/innovation-and-ai/technology/ai/io-2025-keynote/)

另一个高价值方向是绕开 UI。2026 的 **Skim** 专门研究这种 fast path：离线学习网站稳定的 URL pattern、答案结构和 task→trajectory 映射；运行时用轻量分类匹配任务模板，直接合成目标 URL，甚至绕过浏览器渲染，用小模型提取，然后 verifier 检查；猜错才升级到完整 WebVoyager、AgentOccam 或 BrowserUse，而且从 fast path 已抵达的 URL warm-start。三个 backbone 合计的结果是**中位任务成本降低 1.9×、延迟降低 33.4%，报告无准确率损失**。这是目前“缓存成功路径 + 直接网页/URL + 验证 fallback”最干净的学术证据之一。 [3](https://arxiv.org/abs/2605.16565)

Chrome 自己也在往更正规的一层推进：2026 年 WebMCP early preview 允许网站直接向 browser agent 暴露声明式或程序式结构化工具，Google 给出的目标就是让 agent 以更高的 **speed、reliability、precision** 完成如订票、提交支持请求、导航数据等操作；目前没有公开统一 latency benchmark。 [14](https://developer.chrome.com/blog/webmcp-epp)

对你们而言，我会把“直接网站接口”拆成三级：

**首选网站明确暴露的 WebMCP/公开 API；其次是稳定、只读、从当前登录页面已经观察到的 fetch/XHR；最后才是 UI。** 对写操作则反过来保守：除非接口语义、CSRF、幂等性和结果确认都明确，否则不要因为 POST 更快就绕 UI。后一点是工程建议，不是现有厂商 benchmark 的结论。

### 每步更快：压 observation 要“差分化”，不能只“一刀切变短”

你们已经用 AX tree、只给可操作控件、限制 viewport、约 24k 字。这其实已经站在 Playwright MCP、agent-browser 等工具选择的主流方向上：Playwright MCP 默认利用结构化 accessibility snapshot，还提供针对 snapshot 的查找和深度/目标限制；agent-browser 同样强调语义化 AX snapshot 和 compact text representation。它们的公开材料里，我**没有找到严格的端到端 latency A/B 数字**。 [15](https://github.com/microsoft/playwright-mcp)

但 2026 年的《Read More, Think More》给这里加了一个重要限定：**“越少上下文越准”并不成立。** 实验发现，较低能力模型通常更喜欢 compact accessibility tree；较强模型在有足够 thinking budget 时，详细 HTML 中的布局和结构信息反而能帮助 grounding。作者同时发现 observation history 普遍有帮助，而 **diff-based representation 是一种 token-efficient compromise**。 [4](https://arxiv.org/abs/2604.01535)

这对你们的直接含义是：下一步不应该变成“24k → 12k → 6k，一直砍”，而应变成：

`完整基线 AX → action → 只发送 changed subtree + 少量 retained anchors → action → diff ...`

并保留三个逃生门：模型请求“expand element/context”；检测导航/大规模 mutation 时重置 full baseline；grounding 置信度下降时附局部 DOM/截图。这样省的是**重复上下文**，不是可能有用的信息。这个方案完全不依赖模型供应商。

2026 年另一篇 Filtering 工作也说明合理过滤未必牺牲准确性：在 WebArena 上，用学习到的相关元素过滤器后，旧基线 LLaMA-2-70B Agent 成功率从 **1.97% 提高到 2.96%**；但这个绝对成功率非常低，而且论文本身**没有提供可直接用于你们的 latency 降幅**，所以它只能作为“过滤可以同时改善 signal/noise”的弱证据，不能用来预测提速。 [16](https://arxiv.org/abs/2609.27770)

EGO browser 在 2026 年给了一个更激进、但与你们不能直接照搬的例子：它把 semantic snapshot 做进自定义 Chromium，并让 Agent 一次提交一段 JS，把多个 in-page action 合并执行。厂商在一项同任务、同 Claude Code/Opus 4.8 对比里称：ego 约 **18 秒、2 次模型往返**，Playwright MCP 约 **43 秒、9 次往返，即约 2.4×**；官网另称复杂任务最高比 agent-browser **3.45×**。这是**厂商自测**，其中 2.4× 对比只披露了一个示范任务，因此不能视为 benchmark。更重要的是，EGO 是自定义 Chromium，不满足你们“不另开浏览器/在当前 Chrome 工作”的约束。真正值得拿走的是**“一段代码/批处理替代一 action 一 round trip”**这个执行模型。 [17](https://lite.ego.app/)

Stagehand v4 也做了类似下沉。它在一个 50-action Wikipedia crawl 的实验性单次运行中，batch 版本用 **14.22s**，Playwright 用 **22.65s**，即约 **1.59×**，且两边 50/50 actions 成功；作者明确写明这只是**单次 run，不是 benchmark**。它还披露了远程浏览器往返约 42.2ms，并指出本地 laptop 的收益会低很多——这正说明你们本机 Chrome 不该过度投资在 CDP dispatch 微优化。 [1](https://www.browserbase.com/blog/stagehand-v4)

第二类单步加速是模型级联。**StepWise** 默认让小 GUI/web model 工作，只在检测到 “stuck” 或关键 milestone 偏离时升级到大模型。在 OSWorld 与 WebArena-Verified 上，作者报告最高 **45.8% latency reduction、74.6% inference cost reduction**；例如 WebArena 的 `gpt-oss-20b → GPT-5.2` cascade 达 57.8% 成功率、12.2s/request。这说明“不是每一步都值得付 frontier-model latency”是成立的，但它并非天然 lossless：一旦升级检测器漏掉了真正困难的步骤，小模型就可能把状态带偏。 [9](https://github.com/yale-nlp/StepWise)

对你们，多模型 cascade 可以实现成 provider-neutral 接口，而不是绑定某一家：

`fast_policy(state) → confidence/stuck gate → selected_primary_model`

问题在于：用户可能只授权了一个 ChatGPT 登录模型，或者只配置一家的 API，后台悄悄使用第二模型涉及产品、成本和隐私语义。因此我把它列为**有条件推荐**，而不是默认架构。对于能明确提供 fast-model 配置的用户再启用比较合适。

第三类是 speculation。ICLR 2026 的 **Speculative Actions** 用快模型提前猜慢 authoritative actor 的下一动作，并提前发起未来工作；猜中就节省串行等待，猜错则不改变 authoritative 结果。论文跨游戏、电商、web search，下一动作预测最高 55%，**端到端最高降低 20% latency**。这里“lossless”的关键不是“猜得准”，而是**猜错不会被 commit**。 [18](https://arxiv.org/abs/2510.04371)

对浏览器，我不建议你们一开始投机 `click Submit`。最安全的投机对象反而是：

**候选 URL DNS/网络预取、下一页只读 fetch、候选 tab 的 snapshot、下一步 AX ref 解析、目标文本提取、下载链接 HEAD/metadata 请求。**

这样模型仍然拥有最终决策权。用户看不到一半的 speculative branch；猜错最多浪费一点计算。

并行也不能无脑开。Agent JIT 的调度实验是个很好的反例：在它的一组调度结果里，简单的 full parallel 平均 **148.5s / 88.9%**，反而比 serial 的 **129.6s / 70.4%** 更慢；hedging 能做到 **98.4s**，但成功率只有 **71.6%**；成本感知的 JIT Scheduler 则做到 **109.9s / 86.4%**。也就是说，**并行能提高准确率、降低延迟，也能两头都赔，取决于任务分解和共享状态。**  [11](https://arxiv.org/html/2605.21470v2)

因此你们应该只优先并行**彼此独立的 read-only 子任务或不同 tabs 的搜索/提取**。两个 worker 同时修改购物车、表单、当前 active tab 或 session-global 状态，都不应默认并发。

Prompt caching 也值得做，但我不会把它当核心项目。本次调研**未找到覆盖 GLM、MiniMax、Kimi、DeepSeek、ChatGPT-login 且能在 browser-agent workload 上横向比较 TTFT 的公开数据**。最通用的工程做法仍然是把 system prompt、tool schema、稳定 policy 放在稳定前缀，把动态 AX/diff 放后面，并根据 provider capability 有缓存就吃缓存、没有也不影响正确性。尤其你们有约 30 个工具，可以额外试验“按任务动态暴露相关工具子集”；Playwright MCP 现在也明确把大 tool schemas 和完整 AX tree 视为 token 开销来源。 [15](https://github.com/microsoft/playwright-mcp)

不过对你们的“划词解释约 2 秒出首字”，这些浏览器执行优化几乎无关。它已经是一次模型调用的 TTFT 问题。除非换/路由到更快模型、命中 provider prefix cache、维持热连接或减少 prompt prefill，否则完成时间基本没有可砍的 Agent loop。**这里最现实的产品优化反而属于第三条路：先让 UI 活起来。**

### 感觉更快：进度应该来自真实系统状态，不要再花一次 LLM 生成“我正在努力”

消费级 browser agents 已经普遍采用“执行过程可见”设计。ChatGPT agent 的官方介绍描述了任务运行时的 on-screen narration；Claude in Chrome 现在可以后台运行任务，用户可以离开当前操作，且浏览器工作过程仍可查看。二者都说明行业认为“用户不要盯着空白等待”是重要交互，但本次调研**未找到它们公开的 perceived-latency A/B 或 abandonment 数据**。 [6](https://openai.com/es-ES/index/introducing-chatgpt-agent/)

你们反而有一个优势：扩展能准确知道它自己的执行状态，所以**没有必要请 LLM 写旁白**。可以直接从事件机产生：

`已读取当前页面 → 找到 6 个候选项 → 正在打开第 2 个页面 → 已复制 3/5 → 正在核对结果`

这些消息几乎零推理成本，而且不会像自由文本 narration 那样幻觉。对 2 秒 TTFT 的划词解释，可以在本地交互后立即显示“正在解释选中文本…”以及选中文本摘要/语言检测；第一条模型 token 到达时直接替换为答案。实际 TTFT 没变化，但“点击后完全没有响应”的时段消失了。

部分结果也应采取同样原则。**先输出工具已经确定的事实，而不是模型尚未验证的推断。** 例如：

“找到 PDF，正在下载……”可以在 URL 与 MIME 类型已确认后展示；“已找到 8 条记录，正在整理第 5–8 条”可以在 extractor 已拿到前四条后展示；但一个复杂研究问题的最终结论如果还需要多源验证，不应因为追求 TTFF 就把第一个猜测当答案流出来。

Claude in Chrome 的安全架构也提供了一个与“感觉更快”相关的好例子：它允许用户选择让任务连续运行，但在动作前另有独立安全检查，对购买、金融等单向门仍停下来。这本质上是**把普通步骤的交互摩擦消掉，而不是把风险检查消掉**。 [7](https://claude.com/claude-in-chrome)

## 做法清单

下面“公开提速数据”只写找到原始证据的数字；没有就明确写“未找到”。“厂商自测”与论文结果分开标记。

| 做法 | 路线 | 代表产品 / 项目 | 公开提速数据与可信度 | 准确率代价 / 风险 | 不适用条件 | 你们能否做 |
|---|---|---|---|---|---|---|
| **成功 trajectory → 编译/replay → 失败再 Agent** | 少走几步 | Skyvern Explore/Replay；Browser Use rerunnable scripts；SkillRT | Skyvern：278.95s→119.92s，**2.3×**；厂商自测，客户 workload，任务数/模型未披露。SkillRT 在跨模型 skills 中报告 code solidification **19–50× latency reduction**，但不是纯 browser benchmark。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/) | stale flow；条件分支未覆盖；旧 selector 命中语义不同的元素 | 一次性任务；页面每次都完全不同；大量随机状态 | **强烈可以**。现有 batch tool 正好做 replay executor |
| **一次规划一段代码/批动作** | 少走几步 | Agent JIT、EGO、Stagehand v4、Browser Use | JIT：**10.4×** vs Browser-Use、+28pp accuracy，37 tasks/5 apps；EGO：18s/2 loops vs 43s/9 loops，**2.4×，厂商单任务自测**；Stagehand v4 单个 50-action crawl **1.59×，厂商单次 run**。 [19](https://arxiv.org/abs/2605.21470) | plan 中间状态与预期不符后，剩余 actions 可能全错 | 高动态页面；下一动作强依赖前一步未知结果 | **可以**。建议 batch 到“页面阶段”，不要默认整任务一次到底 |
| **action/locator cache + fingerprint** | 少走几步 | Stagehand auto-cache | 重复 workload **最高约 80%**；厂商自测，任务数/模型未披露。 [8](https://www.browserbase.com/blog/stagehand-caching) | 最危险是 stale selector 执行到错误但仍“可点击”的对象 | A/B 页面、随机 URL、个性化列表、频繁 DOM 重排 | **可以**；cache miss 必须比错误 hit 更容易发生 |
| **宏 / skill / teach-and-repeat** | 少走几步 | Project Mariner、Claude Skills、Browser Use | Mariner 有 teach-and-repeat；Claude skill 可复用；Browser Use 可保存 script；**统一公开提速数字未找到**。 [13](https://blog.google/innovation-and-ai/technology/ai/io-2025-keynote/) | skill 把旧假设固化；跨模型对 skill 解释不一致 | 高变异任务、低重复率 | **可以**，skill 编译成你们自己的中间表示，不把自然语言 skill 当最终执行器 |
| **direct URL synthesis / 绕过中间 UI** | 少走几步 | Skim | 三个 backbone 上 median latency **−33.4%**、cost 1.9× lower，报告**无 accuracy loss**；学术原始来源。 [3](https://arxiv.org/abs/2605.16565) | URL pattern 变更；漏掉必须经过的 UI 状态/权限 | write-heavy flow；URL 受动态 token 驱动 | **很适合读/搜/下载** |
| **直接调用网站结构化工具 / API** | 少走几步 | WebMCP；Skyvern HTTP Request blocks | WebMCP 官方称目标为更快、更可靠、更精确；**公开受控 speed 数字未找到**。Skyvern workflows 支持 HTTP Request。 [14](https://developer.chrome.com/blog/webmcp-epp) | undocumented API 语义/CSRF/权限；重复 POST | 支付、删除、提交订单等 irreversible actions | **读操作强适合**；写操作默认 UI/官方工具更稳 |
| **AX snapshot 差分 / incremental observation** | 每步更快 | 2026 observation-reduction 论文；agent-browser | 论文认为 diff 是 token-efficient alternative；**未公开统一 wall-clock 降幅**。 [4](https://arxiv.org/abs/2604.01535) | diff 漏掉关键未变化上下文，造成 grounding 错误 | 大导航、大量 virtualized rerender、SPA 全局状态重置 | **强烈可以**，而且最符合现有 AX 架构 |
| **只保留 task-relevant elements / snapshot find** | 每步更快 | Playwright MCP、Filtering work | Filtering 将旧 LLaMA2 WebArena success 1.97→2.96%，但**没有 latency A/B**；Playwright MCP 有定向 snapshot/find，无官方速度数。 [16](https://arxiv.org/abs/2609.27770) | **过度过滤会伤强模型**；详细 HTML 有时更好。 [4](https://arxiv.org/abs/2604.01535) | 需要布局/视觉关系的任务 | **可以**，必须保留“expand”工具 |
| **更小模型默认执行，卡住才升级** | 每步更快 | StepWise | OSWorld/WebArena-Verified **最高 −45.8% latency/request、−74.6% inference cost**；学术原始实现。 [9](https://github.com/yale-nlp/StepWise) | escalation false negative 会真正降成功率，不是 lossless | 用户没有第二模型；困难度不可预测；高风险动作 | **条件可做**，provider-neutral router 即可，但产品授权问题要先解决 |
| **speculative next action / prefetch** | 每步更快 | Speculative Actions | 下一动作预测最高 55%，端到端 latency **最高 −20%**；ICLR 2026，跨 gaming/e-commerce/web search。 [5](https://arxiv.org/html/2510.04371v2) | 提前执行 side effect 就不再 lossless；猜错浪费资源 | 支付、发送、删除、上传等 | **可以**，先限定为 read-only preparation |
| **自适应串行/并行/hedging** | 每步更快 | Agent JIT Scheduler；Mariner multitasking；EGO Spaces | JIT Scheduler vs OpenAI CUA 报告 **2.4×、+9pp**；简单 Parallel 在一组实验中反而慢于 Serial。 [19](https://arxiv.org/abs/2605.21470) | shared state race、重复提交、资源竞争 | 同一表单/购物车/active-tab 状态 | **只建议 independent tabs/read-only subtasks** |
| **执行层下沉至浏览器、批 JS** | 每步更快 | Stagehand v4、EGO | Stagehand 单次 crawl **1.59×**；EGO 单任务 **2.4×**；均为厂商自测。 [1](https://www.browserbase.com/blog/stagehand-v4) | 更大的批处理会降低中途可纠错性 | 动作结果高度不可预测 | **你们已部分具备**；不用换浏览器，只借鉴 executor 设计 |
| **稳定前缀 / prompt cache** | 每步更快 | 多家 LLM API 均有各自机制；browser-agent 横向证据不足 | **未找到**能覆盖你们 GLM/MiniMax/Kimi/DeepSeek/ChatGPT-login 的统一 browser-agent latency 对照 | cache miss、不同 provider 语义不同 | 登录型接口不暴露缓存能力；动态前缀变化大 | **可做 capability-based optimization，不能成为正确性依赖** |
| **按任务裁剪工具列表** | 每步更快 | Playwright MCP 的 CLI/skills 设计可作为旁证 | 官方文档指出避免大 MCP tool schemas/冗长 AX 有利于 token efficiency；**无直接 wall-clock 数字**。 [15](https://github.com/microsoft/playwright-mcp) | 把真正需要的工具裁掉会增加 replan | task intent 不明确 | **可以**，但要有“请求更多工具”逃生口 |
| **本地即时状态 + 流式进度** | 感觉更快 | ChatGPT agent；Claude in Chrome | 产品已采用；**未找到受控 perceived-latency 数字**。 [6](https://openai.com/es-ES/index/introducing-chatgpt-agent/) | narration 与实际动作不同步会损害信任 | 极短 <300ms 操作，状态提示反而闪烁 | **非常适合**，且不依赖模型 |
| **已验证 partial results 先展示** | 感觉更快 | 多步骤 agent UI 的过程输出 | **未找到** browser-agent 严格 A/B speed 数据 | provisional result 被用户误认为 final | 答案必须全局综合后才有意义 | **可以**，只流工具已确认的事实 |
| **后台任务 / 用户继续浏览** | 感觉更快 | Claude in Chrome、Mariner/EGO multitasking | 产品能力公开；**总完成时间的受控改善未找到**。 [7](https://claude.com/claude-in-chrome) | 当前 Chrome 共享状态可能被用户同时修改 | 任务强依赖 active tab / focus；写操作 | 你们比 EGO 难，因为共享当前 Chrome；更适合独立后台 tab |

一些被点名项目的结论也可以直接收束：

**Chrome DevTools MCP** 与你们的 CDP 思路最接近，官方实现使用 Puppeteer 自动化并等待 action result，但没有公开一个可用于比较“Agent 每任务几秒”的 benchmark；公开 issue 甚至出现过“获取用户当前选中 tab 实际需要 `list_pages → select_page → snapshot`”的额外往返问题，以及约 2000 tabs 下初始化导致 Chrome 无响应/崩溃的报告。这说明“工具接口设计本身创造多少 round trip”值得你们持续审计。 [20](https://github.com/ChromeDevTools/chrome-devtools-mcp)

**Playwright MCP** 的主要速度价值是结构化 AX、定向 snapshot/find、批量 form fill、可接现有 Chrome，而不是已发表的秒数；**agent-browser** 同样主打 compact semantic snapshot/diff，但本次未找到官方控制实验的 latency 数字。 [15](https://github.com/microsoft/playwright-mcp)

**Claude in Chrome、Comet、Gemini/Mariner、OpenAI Atlas/Agent** 更适合作为产品交互和架构趋势证据，而不是性能证据：它们公开了连续自治、跨 tab、skills/memory、teach-and-repeat、过程 narration 等能力，却基本不公开“同一批任务、同一模型、优化前后快多少”的完整实验。没有数字的地方不应该用演示视频中的体感补齐。 [7](https://claude.com/claude-in-chrome)

## 推荐做法的小实验设计

下面不是为了先证明论文，而是为了尽快回答一个产品问题：**“在你们现有 10s / 26s / 8s / 2s 的量级上，它到底值不值得做？”**

我建议所有 latency 实验都用**paired run**：同一个任务、同一网站初始状态、同一模型、尽可能同一网络条件，让 control 和 treatment 成对比较。至少记录 p50、p90，而不是只看平均数。LLM 不确定性较大，所以每个任务至少重复 3 次。

### 成功轨迹编译与 replay

**改什么。** 在正常 Agent 成功后，把 trajectory 编译成一个你们自己的中间表示：

```text
skill:
  intent: "从 CRM 联系人页复制姓名和邮箱到指定表单"
  preconditions:
    - page_kind = crm_contact
  variables:
    - destination
  stages:
    - read(name, email)
    - navigate(destination)
    - fill(name, email)
  checkpoints:
    - after navigation
    - before irreversible submit
  fallback:
    - resume_agent(current_state, intended_stage)
```

第一次照旧；第二次遇到同类 task 时先 replay。页面 signature 不匹配或 checkpoint 失败，立即从**当前已完成状态**恢复 Agent，而不是整任务重来。这个结构分别对应 Skyvern explore/replay、Browser Use rerunnable script 与 JIT “编译掉 step-wise reasoning”的共同思路。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)

**对照。** 当前完整 Agent loop + 当前已有 batch tool。

**样本。** 先选 **40 个可重复 workflow**，每个准备 3–5 组不同输入，至少跑 5 次：约 200 次 treatment/control pair。刻意让其中约 1/3 出现轻微页面变化，例如列表顺序、非关键文案、插入 banner、字段数据不同。

**指标。** 总耗时、LLM round trips、browser action 数、模型总耗时、p50/p90、fallback rate、skill hit rate、success rate；单独计 stale-path 错误和 irreversible error。

**我会判定“不值得”的条件。** replay 命中任务的 p50 没有至少降低 **20%**；或者全体任务净 p50 降幅低于 **15%**；或者成功率下降超过 **1 个百分点**；或者出现任何 replay 导致的不可逆错误。另一个坏信号是 fallback >25%——说明这批任务根本没有足够稳定的重复结构。

以你们的现测看，**26 秒多步复制**最应该放进第一批，而 8 秒、两步即可完成的 PDF 下载不是最能体现这项优化的任务。

### Direct URL / API / WebMCP fast path

**改什么。** 给读操作做 capability discovery：

`task → route classifier → [known URL template / WebMCP / safe GET-XHR / UI agent]`

第一次通过 UI 成功时，用 CDP Network 观察“哪些请求真正返回了所需数据”，记录 endpoint 的**读取语义和参数绑定方式**；如果站点有 WebMCP，优先使用站点声明工具。fast path 返回后跑一个极便宜 verifier，例如 schema、关键词、目标实体、URL/domain、数据新鲜度检查；失败再进入普通 Agent。Skim 的核心也是 fast path 前置、验证失败再 cascade。 [3](https://arxiv.org/abs/2605.16565)

第一版只覆盖：

`GET / read-only API / stable direct URL / PDF-download URL`

不要把订单提交、删除、发邮件、支付等纳入实验。

**对照。** 所有任务都从 UI/AX Agent 开始。

**样本。** **60 个任务**：20 个页面问答、20 个查找/提取、20 个下载；跨至少 10 个站点。每任务 3 次。再人为造成 20% fast-path cache miss，例如 URL template 变体或登录状态不同。

**指标。** 总耗时、Agent loops、fast-path hit rate、verifier false accept、fallback cost、成功率。特别记录“猜错 fast path 后，fallback 总时长是否比一开始直接 UI 更慢”。

**失败条件。** 总体 p50 提升不足 **15%**；fast-path hit rate <25%；false accept >0；或 fallback 任务 p90 比 control 慢 >20%。false accept 必须是硬红线，因为一旦错误结果被当真，“快而不准”就发生了。

你们的 **10 秒页面问答和 8 秒 PDF 下载**是最合适的对象；PDF 如果能从链接语义/Network response 直接确定资源，可能直接省一整个 observation→model→click loop。

### AX 基线加 diff 与按需展开

**改什么。** 保留你们当前 AX snapshot 作为 baseline，但下一步不再默认再发 24k：

```text
stable_context:
  current_url / title / task
  retained semantic anchors

delta:
  nodes_added
  nodes_removed
  nodes_changed
  focus_changed
  live_region_changes
  navigation/result events

history:
  last 2–3 action outcomes
```

模型永远可以调用 `expand(ref) / inspect_region(ref) / full_snapshot()`；发生 navigation、大规模 subtree replacement 或 diff 信心低时，自动重新建立 full baseline。这比“继续粗暴压缩 AX”更符合 2026 observation-reduction 的结果。 [4](https://arxiv.org/abs/2604.01535)

**对照。** 你们现在的每轮 viewport/actionable AX snapshot。

**样本。** **60 个任务 × 3 次**，一半普通 CRUD/复制，一半动态 SPA、autocomplete、modal、virtualized list、infinite scroll。必须故意包含“布局关系重要”的任务，因为那才容易暴露 observation 太瘦的问题。

**指标。** 每 step 输入字符/token、序列化耗时、model TTFT、model total latency、step latency、full-snapshot fallback 次数、grounding retry 次数、总成功率。

**失败条件。** 平均模型输入没有至少下降 **25%**，或者每步 wall time 没有下降 **10%**，则工程收益不足；成功率降低 >1pp、grounding retries 增长 >10%，立即判负。还要按模型分层看：GLM/MiniMax/Kimi/DeepSeek/OpenAI 可能对 compact representation 的最佳点不同，这正是论文观察到的核心现象。 [4](https://arxiv.org/abs/2604.01535)

这项实验不要只看“输入 token 少了多少”。真正要看的是 **TTFT 是否跟着少**。某些后端 TTFT 主要来自队列和模型固定开销，砍 30% prompt 不一定能给你 30% latency。

### 只读 speculative prefetch

**改什么。** 当 authoritative LLM 正在生成下一动作时，基于缓存 trajectory/当前 URL/最近动作做很便宜的 next-step prediction，但只准备可丢弃的结果，例如：

`prefetch probable URL`、`resolve probable AX target`、`snapshot probable tab`、`read probable API response`。

LLM 输出后，如果和 speculative branch 一致，直接使用已经准备好的 observation；不一致则丢弃。

这保留 Speculative Actions 的“确认后 commit”原则，而不需要让快模型拥有写权限。 [5](https://arxiv.org/html/2510.04371v2)

**对照。** LLM 返回后才开始所有页面/网络工作。

**样本。** **50 个三步以上任务 × 3 次**。把任务按“下一动作可预测性”预先分为高/中/低三组，避免只选最容易猜的任务。

**指标。** prediction hit rate、LLM wait 与 browser work overlap 的毫秒数、端到端 p50/p90、额外网络/CPU 开销、误投机数量、success rate。

**失败条件。** hit rate <30%，或端到端 p50 没有降低 **10%**，或额外请求/资源 >1.5×，则先停；**任何未经 authoritative decision 的不可逆 action 都算设计失败，而不是实验失败。**

论文最高 20% latency 改善，所以这里不该设一个不现实的 30–40% 门槛。 [5](https://arxiv.org/html/2510.04371v2)

### 本地即时进度

**改什么。** Agent 请求发出前，由扩展同步切换 UI：

```text
0 ms       已收到
<本地一步> 正在读取当前页面…
tool event 找到 7 个可操作项
navigation 正在打开目标页面…
result     已完成 2/4
LLM token  实际答案开始流式出现
```

不要调用模型生成这些句子。文字可以固定模板，数据来自真实 tool event。

**对照。** 当前模式：等待模型首 token/Agent 自己开始输出后才出现反馈。

**样本。** 工程测试 **40 个任务**足以验证 TTFV；UX 决策再找约 **15–30 名真实用户**做 within-subject A/B，比单看秒表有意义。

**指标。** `time-to-first-visible-feedback`、time-to-first-useful-result、总完成时间、用户中途重复点击/重新提交率，以及主观“等待感”。成功率必须保持不变。

**失败条件。** TTFV 没有降低至少 **50%**；或者进度信息频繁倒退/与实际状态不符；或者用户因为看到“正在执行”而误以为危险动作已经发生。

你们划词解释目前约 **2 秒首字**，这项优化的价值尤其直观：无法把模型 TTFT 魔法般降到 200ms，但可以让 2 秒不再是完全无反馈的 2 秒。

### 已验证 partial results

**改什么。** 设计一个 `publish_partial()`，它只能接受已经由工具状态确认的数据，不接受 Agent 的“未来计划”作为事实。

例如批量复制 10 条记录时，在 3 条已经读到之后即可展示这 3 条；研究多个 tab 时，在每个来源提取完成后展示“来源已完成”；PDF 下载可以先显示“已定位文件：X.pdf”，然后再完成保存。

**对照。** 等整个 task success 后一次性显示所有结果。

**样本。** **40 个可拆分任务 × 3 次**；至少一半为 10 秒以上的任务，否则 progressive disclosure 很难体现价值。

**指标。** first-useful-result time、最终 total time、最终 success、partial→final 修订率、用户是否提前开始消费结果。

**失败条件。** partial 结果后来被改正的比例 >2%；或者 first-useful-result 没有至少提前 **30%**；或者为了生成 partial output 反而使最终 total time 增长 >5%。

这里的目标不是“让模型更早说话”，而是**让已完成的工作不被剩余工作扣押**。

## 风险与反例

最值得警惕的是：很多“加速技巧”在平均 latency 看起来漂亮，但恰好会放大 browser agent 最危险的错误类型。

### 缓存命中比 cache miss 更危险

Stagehand 的缓存实现非常有启发性：它不是把“以前点击过这个 selector”直接当事实，而是验证当前页面是否“足够等价”；漂移时宁可 miss、回 LLM。官方工程文章明确强调，错误的 cached click 比慢一次 click 更糟。其缓存对动态 URL、显著页面变化等场景会主动失效。 [8](https://www.browserbase.com/blog/stagehand-caching)

Skyvern 也公开展示了 static replay 为什么容易崩：radio/checkbox 之间存在 DOM 没显式表示的耦合，选择一个项后页面分支改变；政府网站还会随机不可用、改变字段布局或出现额外流程。它最后不得不让每个动作同时保存“为什么做”，失败时先重新定位同一意图，再回 Agent。 [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)

所以你们的缓存 key 不应只是：

`domain + selector + action`

至少应该是：

`task-template + page-kind + semantic-intent + relevant-page-signature + action`

而 cache validator 要把**false hit**成本设置得远高于 false miss。

### 无脑并行可能“更快地做错事”，甚至更慢

Agent JIT 的调度数据直接反驳了“能并行就并行”：某组实验中 full Parallel 148.5s，Serial 129.6s；hedging 虽降到 98.4s，却只有 71.6% 成功率，而 Parallel 的成功率为 88.9%。只有根据任务特征进行成本感知选择，才同时改善 latency/accuracy Pareto frontier。 [11](https://arxiv.org/html/2605.21470v2)

在你们当前用户 Chrome 环境，这个问题比隔离云浏览器还明显：两个并发 worker 可能共享 cookie、localStorage、购物车、active tab、焦点和页面 session。**跨 tab 只读提取可以并，写同一个业务对象默认不要并。**

EGO 用独立 Spaces 解决 agent/user 与 agent/agent 的碰撞，但那是它自定义浏览器架构的能力；你们不能假设当前 Chrome 天然具有同样隔离。 [17](https://lite.ego.app/)

### “更短的页面表示”并不总是更准

这是 2026 年最重要的反例之一。过去很容易形成一个直觉：HTML 啰嗦，所以越压缩越好。但《Read More, Think More》观察到，高能力模型能够利用 HTML 中的布局信息，给予更多 thinking budget 后优势还会扩大；对低能力模型，长 HTML 则更容易诱发 hallucination。 [4](https://arxiv.org/abs/2604.01535)

因此你们现有 AX 优先是一个很好的默认值，却不应该变成**不可逃逸的唯一观察模式**。对表格列关系、复杂菜单、视觉分组、canvas-like UI、相邻标签等场景，要允许模型升级为局部 HTML/截图。速度优化应该省“重复信息”，而不是禁止模型取得必要信息。

### 小模型执行并不天然保持准确率

StepWise 的成功点恰恰是它没有假定 small model 永远够用，而是训练 stuck/milestone detector 决定何时升级。即便如此，它仍然是在特定 benchmark 和模型对上评估，而不是“任意小模型替换大模型都不掉点”。 [9](https://github.com/yale-nlp/StepWise)

所以“大模型规划一次、小模型执行所有后续步骤”没有 verifier/fallback 时，我不会把它定义为“更快且不更不准”；最多是 latency–accuracy trade-off。更保险的路线是**确定性 executor 执行模型已经决定的动作**，而不是让另一个弱模型重新解释整个目标。

### 投机执行只有在“提交受控”时才是 lossless

Speculative Actions 能宣称 lossless，是因为 faster speculator 的结果最终由 authoritative actor 验证，错误 branch 可以丢弃/覆盖；它不是允许快模型先把所有副作用真的做掉。论文和开源实现都把 verify-before-commit 作为核心。 [21](https://github.com/naimengye/speculative-action)

对于浏览器，这条边界尤其清楚：

`GET / prefetch / snapshot / parse / search / resolve` 可以大胆一些；

`Send / Pay / Delete / Submit / Publish / Book` 不应该 speculative commit。

否则“重复提交”根本没有通用 rollback。

### 减少确认步骤不能等于减少安全检查

Claude in Chrome 现在支持在用户选择后连续完成普通动作，不再要求每一步人为确认，但 Anthropic 的设计是**把用户确认从普通路径移除，同时保留独立安全检查，并在购买、金融等 one-way doors 前停住**。 [7](https://claude.com/claude-in-chrome)

这很值得你们借鉴，因为它证明“速度 vs 安全”不必设计成同一个开关。

Prompt injection 是这里最明显的反例。Anthropic 2025 的浏览器安全测试即使经过显著改进，仍强调约 **1% attack success rate 依然是有意义的风险**，并明确说没有 browser agent 对 prompt injection 免疫。 [22](https://www.anthropic.com/news/prompt-injection-defenses)

因此未来如果做 replay/API fast path，反而要问：**原先每轮 Agent reasoning 中隐含承担的安全判断，有没有被一起编译掉？** 如果有，就需要把相应 guard 变成显式 runtime policy，而不是为了省一次 LLM 调用直接消失。

### 当前 Chrome 自身也可能成为性能状态

Chrome DevTools MCP 的公开 issue 提供了两个很现实的反例。一例是 agent 想读取“当前 tab”，实际接口设计迫使它先 `list_pages`、再 `select_page`、再 snapshot，白白创造往返；另一例是在约 2000 个打开 tabs 的极端用户环境里，初始化上下文就能让浏览器卡住/崩溃。 [23](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/933)

你们因为直接活在用户真实 Chrome 里，更应该把：

`tab count / attached targets / AX build time / mutation volume / page weight`

纳入 latency telemetry。否则某天看到“Agent 慢了 2 秒”，可能会错怪模型。

### benchmark 的速度数字不能直接当你们的目标值

Agent JIT 的 10.4× 很惊艳，但只有 37 个任务、5 个 benchmark apps；Skim 的 33.4% 是更偏 read-heavy、能利用稳定站点结构的工作负载；Skyvern 2.3× 是厂商客户数据但未披露样本数；Stagehand 的 1.59× 明确是单次 50-action demo；EGO 的 2.4× 对比也是厂商展示的单任务。 [10](https://arxiv.org/pdf/2605.21470)

因此真正值得追的不是某个“行业平均 2×”，而是建立你们自己的 latency decomposition：

\[
T_{total}
=
T_{model\_wait}
+
T_{observation}
+
T_{browser}
+
T_{network}
+
T_{verification}
+
T_{user\_gates}
+
T_{retries}
\]

每个 Agent turn 再记：

`input tokens / TTFT / generation / AX size / snapshot build / tool dispatch / network idle wait / verification / retry reason`

一旦这样拆开，你们会很快知道：26 秒复制任务到底是“3 次 4 秒模型”还是“网页自己加载 10 秒”；2 秒划词解释则已经明确是另一种问题，不能拿 replay 优化来治。

在 benchmark 选择上，也应避免只跑 sandbox。Online-Mind2Web 的设计是 **300 个真实任务、136 个网站**，目的正是捕捉在线网站变化；相关研究也提醒，离线/受控环境的排名并不能保证在真实网页上保持。 [24](https://arxiv.org/abs/2504.01382) 你们可以不直接复现整个 benchmark，但内部测试集至少应保留一部分“真实、今天正在变化的网站”，否则 cache/replay 会显得异常美好。

BrowseComp 更偏开放式 web research 的最终答题能力，OpenAI 也主要用它报告研究正确率，而不是浏览器 action latency；**本次没有找到原始 BrowseComp 给出可直接用于你们产品的“平均 UI 步数 / 每轮 browser latency”指标**。因此它适合验证“提速后研究质量有没有掉”，不适合做你们的主性能 benchmark。 [6](https://openai.com/es-ES/index/introducing-chatgpt-agent/)

## 来源与证据说明

**访问日期：以下在线来源均于 2026-10-07 查阅。** 厂商自己测自己的数据均在正文标为“厂商自测”；“未找到”表示我没有在本次检索到的官方文档、仓库、论文或作者材料里找到可核验数字，而不是断言该数字绝不存在。

| 来源 | 用途 / 关键证据 | 证据性质 |
|---|---|---|
| **Winston et al., “Agent JIT Compilation for Latency-Optimizing Web Agent Planning and Scheduling”, 2026**  [19](https://arxiv.org/abs/2605.21470) | 37 tasks / 5 apps；JIT-Planner 10.4×、+28pp；JIT-Scheduler 2.4×、+9pp；串行/并行/hedge 反例 | 原始论文 |
| **Wong et al., “Skim: Speculative Execution for Fast and Efficient Web Agents”, 2026**  [3](https://arxiv.org/abs/2605.16565) | direct URL/template fast path；三个 backbone；median latency −33.4%，无 accuracy loss | 原始论文 |
| **Ye et al., “Speculative Actions: A Lossless Framework for Faster Agentic Systems”, ICLR 2026 Oral**  [5](https://arxiv.org/html/2510.04371v2) | next-action prediction ≤55%；end-to-end latency ≤20%；verify-before-commit | 原始论文 / 作者页 |
| **StepWise / Yale NLP**  [9](https://github.com/yale-nlp/StepWise) | event-driven small→large model cascade；最高 latency −45.8%、inference cost −74.6% | 原始项目 / 论文结果 |
| **Enomoto et al., “Read More, Think More: Revisiting Observation Reduction for Web Agents”, 2026**  [4](https://arxiv.org/abs/2604.01535) | AX 对低能力模型更友好；强模型可能受益于详细 HTML；diff observation | 原始论文 |
| **Guo et al., “Improving LLM-based Autonomous Web Agents with Filtering”, 2026**  [16](https://arxiv.org/abs/2609.27770) | filtering 对 WebArena action success 的影响；无 latency 数 | 原始论文 |
| **SkillRT: Compiling Skills for Efficient Execution Everywhere, 2026**  [25](https://arxiv.org/abs/2604.03088) | 118k skills；token ≤−40%；parallelism ≤3.2×；code solidification 19–50× | 原始论文；非纯 browser benchmark |
| **Skyvern, “Asking AI to build scrapers should be easy right?”**  [2](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/) | Explore→Replay；278.95s→119.92s，2.3×；intent fallback | 官方技术博客，厂商自测 |
| **Skyvern 2026 Docs update**  [26](https://www.skyvern.com/blog/new-month-new-docs/) | Workflows、HTTP Request、self-hosting、多 LLM、adaptive caching | 官方 |
| **Browserbase / Stagehand caching engineering blog**  [8](https://www.browserbase.com/blog/stagehand-caching) | 缓存 action resolution；最高约 80%；fingerprint 验证；drift→miss | 官方技术博客，厂商自测 |
| **Stagehand v4 architecture / batching**  [1](https://www.browserbase.com/blog/stagehand-v4) | browser-side state/AX pruning；50 actions 14.22s vs 22.65s；本地 RTT 收益较小 | 官方技术博客，单次厂商实验 |
| **Stagehand caching docs**  [27](https://docs.stagehand.dev/v3/best-practices/caching) | act/observe/extract cache key、命中行为、Local browser 限制 | 官方文档 |
| **Browser Use rerunnable scripts**  [12](https://docs.browser-use.com/cloud/agent/scripts) | 成功 trajectory 保存为可重跑 script、变化时 self-heal | 官方文档；无 speed 数 |
| **Browser Use agent parameters/source**  [28](https://docs.browser-use.com/open-source/customize/agent/all-parameters) | `max_actions_per_step=5`、flash/compaction 等机制 | 官方文档/源码 |
| **ego (lite) 官方主页**  [17](https://lite.ego.app/) | semantic snapshot、批 JS、Spaces、最高 3.45× 厂商主张 | 官方，厂商自测 |
| **ego browser-testing 页面**  [29](https://lite.ego.app/solutions/browser-testing) | 同一任务 Claude Code/Opus 4.8：18s/2 loops vs Playwright MCP 43s/9 loops | 官方，单任务厂商自测 |
| **Playwright MCP**  [15](https://github.com/microsoft/playwright-mcp) | AX snapshot、browser_find、target/depth、existing Chrome、tool-schema/token 设计 | 官方 GitHub；未找到 speed benchmark |
| **agent-browser**  [30](https://github.com/vercel-labs/agent-browser) | compact semantic snapshot/ref/diff 思路 | 官方项目；未找到可信 latency A/B |
| **Chrome DevTools MCP**  [20](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Live Chrome、Puppeteer automation、自动等待结果 | Google/Chrome 官方 GitHub |
| **Chrome DevTools MCP issue #933**  [23](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/933) | 当前 tab 操作产生额外 `list/select/snapshot` 往返的实际案例 | 官方 issue tracker |
| **Chrome DevTools MCP issue #1921**  [31](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921) | 超大量 tabs 下启动/首工具调用卡死的实际案例 | 官方 issue tracker |
| **Chrome WebMCP early preview, Feb 2026**  [14](https://developer.chrome.com/blog/webmcp-epp) | 网站向 Agent 暴露结构化工具，目标是 speed/reliability/precision | Google Chrome 官方 |
| **Claude in Chrome**  [7](https://claude.com/claude-in-chrome) | GA、跨 tab、skills、background tasks、连续执行 + 独立 safety check | Anthropic 官方 |
| **Anthropic prompt-injection defenses**  [22](https://www.anthropic.com/news/prompt-injection-defenses) | Browser prompt injection 风险；约 1% ASR 仍不可忽略 | Anthropic 官方安全研究 |
| **Google Project Mariner / Gemini in Chrome**  [13](https://blog.google/innovation-and-ai/technology/ai/io-2025-keynote/) | multi-step、multitasking、teach-and-repeat / auto browse | Google 官方 |
| **Perplexity Comet docs/changelog**  [32](https://www.perplexity.ai/en-GB/hub/getting-started) | 跨 tabs browser action、2026 preference memory | Perplexity 官方 |
| **OpenAI ChatGPT agent / Operator / Atlas**  [6](https://openai.com/es-ES/index/introducing-chatgpt-agent/) | narration、产品演进与截至 2026 的状态 | OpenAI 官方 |
| **Online-Mind2Web**  [24](https://arxiv.org/abs/2504.01382) | 300 tasks、136 websites、live-web evaluation | 原始论文/项目 |

**最终建议可以浓缩成一句话：先把 Agent 从“每一步都思考”改成“只在不确定的地方思考”。** 对你们现有架构，最值得做的组合不是换一套 computer-use model，而是：

`成功轨迹 → 可验证 replay`  
`普通读取 → direct fast path → verifier → fallback`  
`full AX → diff AX → 按需扩展`  
`LLM 等待时间 → 只读 speculative work`  
`模型还没出字 → 本地真实进度先出现`

这五件事都不要求绑定 OpenAI、Anthropic 或 Google 的专属 computer-use 能力；其中前三件甚至越是多模型产品，价值越大。公开证据也显示，**真正大的速度提升基本都来自消灭重复的模型循环，而不是让浏览器本身再快一点。**  [19](https://arxiv.org/abs/2605.21470)

## 引用链接

1. [Introducing Stagehand v4: The SDK for browser agents. | Browserbase](https://www.browserbase.com/blog/stagehand-v4)
2. [AI Scrapers: Should It Be Easy? (Updated June 2026)](https://www.skyvern.com/blog/asking-ai-to-build-scrapers-should-be-easy-right/)
3. [Skim: Speculative Execution for Fast and Efficient Web Agents](https://arxiv.org/abs/2605.16565)
4. [Read More, Think More: Revisiting Observation Reduction for Web Agents](https://arxiv.org/abs/2604.01535)
5. [A Lossless Framework for Faster Agentic Systems](https://arxiv.org/html/2510.04371v2)
6. [Presentamos el agente ChatGPT: un puente entre la ...](https://openai.com/es-ES/index/introducing-chatgpt-agent/)
7. [claude.com](https://claude.com/claude-in-chrome)
8. [How Caching Works in Stagehand (and Where It Breaks) | Browserbase | Browserbase](https://www.browserbase.com/blog/stagehand-caching)
9. [yale-nlp/StepWise](https://github.com/yale-nlp/StepWise)
10. [Agent JIT Compilation for Latency-Optimizing Web ...](https://arxiv.org/pdf/2605.21470)
11. [Agent JIT Compilation for Latency-Optimizing Web Agent Planning and Scheduling](https://arxiv.org/html/2605.21470v2)
12. [Rerunnable scripts - Browser Use](https://docs.browser-use.com/cloud/agent/scripts)
13. [Google I/O 2025: Sundar Pichai's opening keynote](https://blog.google/innovation-and-ai/technology/ai/io-2025-keynote/)
14. [WebMCP is available for early preview  |  Blog  |  Chrome for Developers](https://developer.chrome.com/blog/webmcp-epp)
15. [GitHub - microsoft/playwright-mcp: Playwright MCP server · GitHub](https://github.com/microsoft/playwright-mcp)
16. [Improving LLM-based Autonomous Web Agents with Filtering](https://arxiv.org/abs/2609.27770)
17. [Fastest Browser for AI Agents to Run Web Automation | ego (lite)](https://lite.ego.app/)
18. [Speculative Actions: A Lossless Framework for Faster Agentic Systems](https://arxiv.org/abs/2510.04371)
19. [Agent JIT Compilation for Latency-Optimizing Web Agent Planning and Scheduling](https://arxiv.org/abs/2605.21470)
20. [Chrome DevTools for coding agents · GitHub](https://github.com/ChromeDevTools/chrome-devtools-mcp)
21. [naimengye/speculative-action](https://github.com/naimengye/speculative-action)
22. [www.anthropic.com](https://www.anthropic.com/news/prompt-injection-defenses)
23. [Bug: Get the currently selected browser tab · Issue #933](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/933)
24. [An Illusion of Progress? Assessing the Current State of Web Agents](https://arxiv.org/abs/2504.01382)
25. [SkillRT: Compiling Skills for Efficient Execution Everywhere](https://arxiv.org/abs/2604.03088)
26. [New Month, New Docs Update | Skyvern Updated for July 2026](https://www.skyvern.com/blog/new-month-new-docs/)
27. [Caching Actions - Stagehand](https://docs.stagehand.dev/v3/best-practices/caching)
28. [All Parameters](https://docs.browser-use.com/open-source/customize/agent/all-parameters)
29. [Super Fast Browser for AI Browser Testing | ego (lite)](https://lite.ego.app/solutions/browser-testing)
30. [vercel-labs/agent-browser: Browser automation CLI for AI ...](https://github.com/vercel-labs/agent-browser)
31. [Browser hangs / crashes when MCP connects to Chrome ...](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1921)
32. [Getting started with Perplexity: Research, browse, and build](https://www.perplexity.ai/en-GB/hub/getting-started)
