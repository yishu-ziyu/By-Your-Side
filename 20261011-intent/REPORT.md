# 意图识别 / 路由（intent routing）：行业怎么做，BYS 该不该给文字输入加路由器

日期：2026-10-11（UTC+8）。代码：`By-Your-Side main @ 6a8587b`，只读，没改产品代码。
本报告故意不预设「现状对」或「加路由器对」。每条判断都标了依据：一手来源（官方文档 / 工程博客 / 开源代码 / 论文）、仓库代码行，或本次在 Step Plan 上跑的小实验（§5，样本小，只说明量级）。

---

## 0. 结论先行

1. **前沿产品基本不在主循环前放「读 / 做」分类器来删工具。** 公开资料里有两种主流做法：
   - **用户显式选模式**：ChatGPT Atlas 的 Ask 侧栏和 Agent mode、ChatGPT「agent mode」、Cursor 的 Ask/Agent/Plan、Claude Code 的 plan mode。
   - **一个模型循环自己决定，副作用动作前加确认闸门**：Claude in Chrome、Perplexity Comet、Gemini in Chrome auto browse（先出计划，用户点 Start Task）。

   公开说明自己用路由器的，路由的是**选哪个模型**，不是选哪套工具：GPT-5 的实时 router、Copilot Smart mode、Stagehand `model:"auto"`。工具太多时，行业给的答案是**模型自己按需加载工具**（Anthropic Tool Search Tool、OpenAI `tool_search` + `defer_loading`、Claude Code 默认开启），不是前置分类器。
2. **BYS 只读问题慢 22–55 秒，主因不是没路由，是首轮读页质量差。**
   - 本次把产品真实请求体原样重放：12k 字 AX tree 里真正的正文只有约 1.5k 字，结尾还带 `[same-page observation truncated]`。
   - 在全量 32 个工具不变的情况下，模型首轮去调工具（`js` / `browser_run` / …）的比例是 **6/20**；读页换成正文抽取后是 **0/11**。
   - 首个输出中位数从 5.9 秒降到 3.3 秒，和「去掉全部工具、短提示词」的 3.9 秒（n=3）同一量级。
   - 路由器省不掉这一轮：只读道拿着同样的烂读页，要么也重读，要么没有工具，只能凭残缺内容答。
3. **你的提案（规则 + 小模型路由器）在 BYS 现有数据上，净延迟大概率为负。**
   - 小模型分类要串行加 0.8–2 秒：仓库实测旧语音分类器中位 1974 ms、p90 6877 ms；Jev 单句 820–922 ms。
   - 读页修好后，提示词变小只省 ≤1 秒。
   - 把要动手的请求错发到只读道，代价不对称：要么失败（9/09 语音「圈出来」事故就是这条），要么多一轮升级，在 step-5 上每轮 5–10 秒。
   - 纯规则路由在 205 条真实请求上离线回放（以 Jev 标签为参照）：召回 45%，精度 84%，误路由 5 条。几乎拿不到收益。
4. **比路由器便宜、确定、零误路由风险的杠杆有四个：**
   - (a) 读页给正文抽取，不给截断的 AX tree。
   - (b) 把 system prompt 末尾的动态内容（日期、runId、对话 JSON）挪到工具定义之后。实测首轮缓存命中从 0–3.3k 升到 14.1k token。
   - (c) 思考档默认 low。来自上一份追踪报告，能砍 20–34 秒长尾。
   - (d) 「事后分流」：模型一轮没用工具就答完的，判定为纯问答，跳过 goal check / memory 后台调用和调试器挂载。
5. **路由器真正该在的位置：** 语音的**控制面**（pause / abort / status / steer，必须在全双工里秒级判定，而且不该打断主循环）。还有将来可能的**选模型 / 思考档**。不该在文字输入上做「读 / 做」二分来删工具。

---

## 1. BYS 现状（从代码确认）

| 面 | 现状 | 代码 |
|---|---|---|
| 语音 | 先走正则快路（`停止/停` → clarify，`别说了` → silence，附和语不算 resume）。再走 LLM 分类器，提示词 3,835 字，分 11 个动作，输出 JSON，加大量正则校验，不合法就确定性失败 | `agent/src/voice-intent.ts:17-27`（提示词）、`:55-140`（校验）；`conversation-manager.ts:203 routeVoiceInput`、`:609 proposeVoiceTurn` |
| 语音 observe | 不走主循环，单独 `answerVoiceObservation`：无工具的只读调用 | `conversation-manager.ts:423-451`；`session.ts:1177` |
| 语音 chat | 回到主循环，**保留全部工具**，只把读页改成按需（`pageObservation:'on-demand'`）。注释写明 *"Classification still resolves controls, but cannot strip tools from ordinary content."* | `conversation-manager.ts:409-414`；`session.ts:982-987` |
| 文字 | 无路由。先读当前页（AX tree，经 `chrome.debugger`，截到 12,000 字加截断标记），再带 32 个工具和约 16k 字 system prompt 发主模型 | `session.ts:113`、`:1068-1069`；`prompt.ts:42` |
| system prompt 动态段 | 前 14,338 字稳定，之后拼「Product conversation context」：`Today is …` 和整段 `JSON.stringify(context)`（含 runId、conversationHistory） | `agent/src/product-context.ts:51-58` |
| 工具 | 32 个，定义合计 41,922 字。最长的几个：`read_element` 4,139、`browser_run` 3,472、`mark` 2,782、`artifacts` 2,385、`page_translation` 2,176 | 本次从 `bys-trace/runs/*/bodies.json` 统计 |

仓库自己已经有两条很关键的历史证据：

- **9/09 事故**：语音把「你可以圈出来的」判成 observe / chat。observe 道没有工具，`mark` 没执行（`docs/diagnostics/20260909-voice-mark-and-delayed-speech-review.md:18`）。这就是**只读道删工具的误路由代价**。之后语音 chat 改成「保留工具」。
- **9/21 路由对照**（`docs/evals/20260921-routing-experiment.md`）：
  - 旧分类器在 24 句里判对 14 句，中位 1974 ms，p90 6877 ms。
  - Realtime 3 在 28 句里判对 12 句。
  - Jev 判对 21/24 和 26/28，单句 820–922 ms。
  - 225 条已派成任务的请求里，Jev 认为 78 条不需要任务引擎。
  - 当时的建议是先做「影子路由」，只记录、不干预。

---

## 2. 行业怎么做（表 a）

「公开」= 官方文档 / 博客 / 开源代码；「逆向」= 第三方拆包，可信度低。

| 产品 / 方案 | 读 / 聊 / 做怎么分 | 工具怎么给 | 选模型 / 思考 | 来源 |
|---|---|---|---|---|
| **ChatGPT Atlas** | **用户显式切换**：Ask ChatGPT 侧栏用于问答、总结、提取。要点击、导航时，从 + 菜单选 Agent mode | 两种模式两套能力。内部路由未公开 | 未公开 | https://help.openai.com/en/articles/12628199 |
| **ChatGPT agent（含原 Operator）** | **用户显式进 agent mode**（composer 工具下拉）。进入后由一个统一模型自己挑工具：可视浏览器、文本浏览器、终端、API、connectors。原话 "proactively choosing from a toolbox"、"chooses its own tools" | 全给，模型自选。有后果的动作前要确认，发邮件等要 Watch Mode | 未公开 | https://openai.com/index/introducing-chatgpt-agent/ |
| **GPT-5（ChatGPT）** | 不分读 / 做。**实时 router 选模型**：main 或 thinking，依据对话类型、复杂度、工具需要、显式意图。用用户切换模型、偏好、正确率持续训练 | — | router 选；说明里写了「将来并入单模型」。上线当天 autoswitcher 故障，GPT-5 显得「way dumber」，之后恢复 Auto / Fast / Thinking 手动选择 | https://openai.com/index/gpt-5-system-card/ ；https://arstechnica.com/information-technology/2025/08/the-gpt-5-rollout-has-been-a-big-mess/ |
| **Claude in Chrome** | **不分**。单个 agent 循环。用户选的是**权限模式**，不是意图模式：Manual / Auto（逐个动作做安全审查）/ Skip | 全给。Auto 模式下只读工具自动放行，写操作由 Claude 判断或询问 | 用户选模型 | https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide ；https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork |
| **Perplexity Comet** | **隐式检测 + 询问**："when you make a request that would work better by interacting with your browser, Comet will ask you first"，选择在整个任务里沿用。检测机制未公开（分类器还是主模型不清楚）。逆向显示：问答走 SSE，要动浏览器时后端下发 `entropy_request`，另开 WebSocket 驱动 agent 扩展 | 泄露的 system prompt 把动作分三类：禁止 / 需明确许可 / 自动。另有注入检测分类器 | 未公开 | https://www.perplexity.ai/hub/blog/the-new-comet-assistant ；https://www.perplexity.ai/hub/blog/comet-assistant-puts-you-in-control ；逆向：https://labs.zenity.io/post/perplexity-comet-a-reversing-story |
| **Gemini in Chrome（auto browse）/ Mariner** | 同一个 Ask Gemini 输入框。多步任务时 **Gemini 先给计划，用户点 Start Task** 才动手，相当于模型判定加用户确认。机制未公开 | 只在与任务相关的站点和动作内活动。敏感步骤要确认或让用户接管 | 未公开 | https://support.google.com/chrome/answer/16821166 |
| **Microsoft Copilot（Edge Copilot Mode）** | Actions 可以自然语言触发。**Smart mode 用 GPT-5 router 选模型** | 未公开 | router | https://www.microsoft.com/en-us/microsoft-copilot/blog/2025/08/07/release-notes-august-7-2025/ |
| **Dia（Browser Company）** | 逆向称有端侧 DistilBERT + LoRA 分类头：`cmd_t_router`（3 标签输入意图）、`skills`（排序建议哪个 skill）、`sensitive_content`。看起来用于**主动建议**，不清楚是否用于删工具。**非官方** | Skills = 可复用的提示词工作流；@ 提及插入上下文 / 工具 | 未公开 | 逆向：https://www.skillsdirectory.com/skills/termio-sh-dia-source-analysis |
| **Cursor** | **用户显式选** Agent / Ask / Plan。Ask 只读：禁编辑和 MCP 执行，保留 Read / Grep。Plan 先出方案，批准后再改 | 按模式给工具子集 | Auto 模型选项（细节未公开） | https://prod.cursor.com/help/ai-features/agent |
| **Claude Code** | 用户切 plan mode。默认一个循环 | **Tool search 默认开启**：MCP / 非核心工具延迟加载，Bash / Read / Edit 常驻。`auto` 模式在工具定义达到上下文 10% 时才启用。文档原话："Tool selection accuracy degrades with more than 30-50 tools"，"With fewer than ~10 tools … loading everything upfront is typically faster" | — | https://code.claude.com/docs/en/agent-sdk/tool-search.md |
| **Anthropic API** | — | **Tool Search Tool + `defer_loading`**：Opus 4 在大工具库 MCP 评测上 49%→74%，Opus 4.5 79.5%→88.1%。"adds a search step"，适用于工具定义 >10K token 或 10+ 工具；小库不划算。**不破坏 prompt cache**。另有 Programmatic Tool Calling：多工具编排写成代码，省掉中间推理轮 | — | https://www.anthropic.com/engineering/advanced-tool-use |
| **OpenAI API** | Agents SDK 的 handoff：triage agent 把专家 agent 当工具（`transfer_to_x`），模型自己决定交接 | `tool_search` + `defer_loading`，gpt-5.4 起支持；hosted 或 client 执行。文档表格：eager loading 的代价是「改定义会让缓存前缀失效」，deferred 的代价是「多一步，且依赖搜得到」 | — | https://developers.openai.com/api/docs/guides/tools-tool-search ；https://openai.github.io/openai-agents-python/handoffs/ |
| **Stagehand** | **开发者在代码里选** `act` / `extract` / `observe` / `agent`，路由在 API 设计层面 | 每个原语固定能力 | `model:"auto"`：服务端按每次调用选最便宜够用的模型，自称省 30–40% 成本（厂商数据） | 本地代码 `packages/docs/v3/configuration/models.mdx:50-110`（commit f261c38） |
| **Nanobrowser** | **Planner 同一次调用里既分类又回答**：输出 `web_task` 布尔值，false 就直接在 `final_answer` 里答完；true 才交给 Navigator | Navigator 拿全部浏览器动作 | 可给 Planner 和 Navigator 配不同模型 | `src/background/agent/prompts/templates/planner.ts:8-37`；`executor.ts:157`（commit ad47282） |
| **browser-use** | 不做意图路由。单循环，一步最多 5 个动作 | 按 **URL 域名过滤动作**（`domains` / `page_filter`，`create_action_model(include_actions, page_url)`）；可 `exclude_actions`。`page_extraction_llm` / `judge_llm` 可配便宜模型 | flash_mode 关掉思考字段 | `browser_use/tools/registry/service.py:519-544`；`agent/service.py:178-256`（commit c75e847） |
| **Skyvern** | 任务级 planner（task_v2）把目标拆成 navigate / extract / loop 子任务，**按子任务类型换提示词**。extract 有专门提示词 | 子任务类型决定动作集 | — | `skyvern/forge/prompts/skyvern/task_v2.j2`（commit f5f3f28） |
| **Anthropic browser-use-demo（quickstart）** | 不路由。单循环 | **只有 1 个 browser 工具**，action 枚举 20+ 种。`get_page_text` 返回整页正文（带 source element），不截断。提示词："Prefer get_page_text over scrolling" | — | `claude-quickstarts/browser-use-demo/browser_use_demo/tools/browser.py:31,857-900`；`loop.py:48-54`（commit 9ec32b9） |

**模式归纳：**

- **显式模式**（Atlas / ChatGPT / Cursor / Claude Code）：误路由归零，代价是用户要多点一下。产品方明确愿意付这个代价。
- **单循环 + 闸门**（Claude in Chrome / ChatGPT agent 内部 / Comet / Gemini）：「做不做」交给主模型，「能不能做」交给确认闸门和权限模式。
- **路由器**：公开的几乎都在**选模型**（GPT-5、Copilot、Stagehand、RouteLLM、NVIDIA blueprint），没有公开的「浏览器 agent 前置读 / 做分类器删工具」案例。最接近的是 Nanobrowser 的「planner 分类并顺便回答」，它不多花一次调用。
- **工具多**：行业答案是 tool search / 延迟加载 / 合并工具（Anthropic 演示只用 1 个工具），不是前置分类器。

---

## 3. 框架、模式与证据

### 3.1 路由（routing）

- **Anthropic《Building effective agents》**：routing 适用于「有明确不同类别、分开处理更好，**且分类能做准**」的场景。全文主张「先找最简单的方案」，「只在能证明改善结果时才加复杂度」。https://www.anthropic.com/engineering/building-effective-agents
- **OpenAI《A practical guide to building agents》**：先把单 agent 能力用满。工具混乱更多来自**相似重叠**，不是总数，要先改名字和描述。只有单 agent 持续选错工具时才拆。https://openai.com/business/guides-and-resources/a-practical-guide-to-building-ai-agents/
- **OpenAI Agents SDK handoffs**：路由由主模型以工具调用的形式完成，不是外置分类器。https://openai.github.io/openai-agents-python/handoffs/
- **LangGraph** routing 工作流：结构化输出 + 条件边，与 Anthropic 定义一致。https://docs.langchain.com/oss/python/langgraph/workflows-agents
- **semantic-router（Aurelio）**：用 embedding 相似度路由，不调用 LLM，延迟极低。适合类别固定、例句充足的场景，需要阈值和例句维护。https://github.com/aurelio-labs/semantic-router
- **RouteLLM**：学的是强 / 弱**模型**选择。MT-Bench 上在 95% GPT-4 质量下最多省 3.66× 成本，但 GSM8K 上只有 1.49×（87% 质量）。说明收益高度依赖任务分布。https://arxiv.org/abs/2406.18665
- **Arch-Router（1.5B）**：93.17% 路由准确率；**自托管** 51±12 ms，对比商业 API router 510–1450 ms。延迟优势依赖自己部署 GPU，BYS 是 Chrome 扩展加第三方 API，拿不到这个数。https://arxiv.org/abs/2506.16655
- **NVIDIA LLM Router blueprint**：任务 / 复杂度分类器选模型。v2 用 Qwen 1.7B 做意图路由。https://github.com/NVIDIA-AI-Blueprints/llm-router
- **Rasa CALM**：NLU 意图分类（便宜、适合定义清楚的意图）和 LLM command generator（上下文、间接表达）**并存**，冲突时 NLU 优先。行业的对话系统已经从纯意图分类转向「LLM 理解 + 确定性流程」。https://rasa.com/docs/reference/config/components/nlu-command-adapter/ ；https://rasa.com/docs/reference/config/components/llm-command-generators/
- **Dialogflow CX** 也是意图 + 生成式 playbook 混合。

### 3.2 工具数量 / 提示词大小的证据

| 证据 | 结论 | 局限 |
|---|---|---|
| Anthropic Tool Search（内部 MCP 评测） | Opus 4 49→74%，Opus 4.5 79.5→88.1% | 内部评测，**大工具库**（50+ 工具、55k+ token），不是 32 个工具 |
| Claude Code 文档 | 30–50 个工具以上选择准确率下降；<~10 个工具全量加载更快 | 经验阈值 |
| OpenAI（经 Microsoft Research 转述） | 建议 <20 个工具；有模型在大工具空间下性能最多降 85% | https://www.microsoft.com/en-us/research/blog/tool-space-interference-in-the-mcp-era-designing-for-agent-compatibility-at-scale/ |
| RAG-MCP | 检索工具后选择准确率 43.13%，全量 13.62%，prompt token 减半 | 单工具 web-search 任务，未开源代码。https://arxiv.org/abs/2505.03275 |
| Less is More | 动态选工具子集，边缘设备执行时间最多 −80% | 量化小模型，Jetson。https://arxiv.org/abs/2411.15399 |
| StepFun 文档 | 「过多的函数定义会消耗较多 prompt token，并可能降低模型的命中准确率」 | 无量化 |

对 BYS 的含义：32 个工具、约 10k token，正好落在「该考虑精简 / 合并」的灰区，但远没到「必须 tool search」的规模。而且上面这些证据主要讲**准确率**，不是**首字延迟**。延迟见 §5 的实测。

### 3.3 Prompt caching：缩提示词的替代方案

- **StepFun 支持自动前缀缓存**：请求超过 256 token 自动启用，按前缀匹配，LRU 淘汰。step-5-preview 命中价是未命中的 5%（0.35 元 / 1M）。文档说特定场景首字最多快 90%。最佳实践原文：「在 Prompt 的开头使用静态或者重复的内容，而在整个 Prompt 结尾放置动态的内容」。https://platform.stepfun.com/docs/zh/guides/developer/prompt-cache
- **StepFun 没有 `tool_search` / `defer_loading`**：工具调用文档只支持 `type:function`。要做只能在客户端实现「搜工具」元工具，每次搜索多一轮模型调用。https://platform.stepfun.com/docs/zh/api-reference/tool-call.md
- OpenAI 文档也写了：eager 加载时，改工具定义会让缓存前缀失效。按路由切换工具集，本身就会**打碎缓存**：两套工具 = 两个前缀，各自冷启动。

---

## 4. 开源浏览器 agent 代码阅读要点

- **Nanobrowser**：`web_task=false` 时 planner 直接回答（`planner.ts:8-15`），executor 第 0 步先跑 planner（`executor.ts:157`）。分类和回答是**同一次调用**，没有额外的路由延迟。代价是每个任务都先过一次 planner，动作任务因此多一次调用。
- **browser-use**：没有意图路由。降低工具噪音的方式是**按页面 URL 过滤动作**（`registry/service.py:519-544`），这是确定性的、零误判风险的子集化。读页抽取可以配单独的便宜模型（`page_extraction_llm`）。
- **Skyvern**：路由发生在**规划出的子任务**层面（navigate vs extract），不是在用户原话层面。
- **Stagehand**：读 / 做由**调用方代码**决定（`extract` / `observe` 和 `act`），模型 router 只选模型。
- **Anthropic quickstart**：1 个工具；`get_page_text` 抽正文（`browser_text_script.js`，带 source element），**不截断**。提示词明确让模型优先用它读正文。BYS 的读页正好相反：给 AX tree，截 12k，加截断标记。
- **OpenAI CUA sample app**：单个 Responses 循环（`javascript-app/src/responses-loop.ts`），没有意图路由。它的提速思路是让模型在持久运行时里**写代码**，把多个动作合成一段程序执行，减少模型往返轮数（README）。这和 BYS 的 `browser_run`、Anthropic 的 Programmatic Tool Calling 是同一方向。

---

## 5. 本次补做的小实验（Step Plan，step-5-preview，reasoning_effort=low）

脚本和原始数据在 `/workspace/bys-intent-research/probe/`。请求体取自产品真实请求 `bys-trace/runs/summary-r1`（Miyazaki 页「Summarize this page in 3 sentences」）。key 从环境变量读，没有打印。运行时间 2026-10-11 傍晚（UTC+8）。**每格 n=3–20，只说明方向，不是结论。**

### 5.1 缓存被 system prompt 末尾的动态段打碎（`cache_probe.py`）

| 变体 | prompt token | cached_tokens（3 次） |
|---|---:|---|
| A 产品现状（每次新 runId） | 19.1k | 0 / 0 / 3,328 |
| A2 完全相同的请求体重复发 | 19.1k | 16,384 / 18,688 / 18,688 |
| B 把动态段挪成 system 之后的一条 user 消息 | 19.1k | 2,816（冷）/ **14,080** / **14,080** |

- 推断：StepFun 的模板把 tools 渲染在 system 之后。system 末尾的 `Today is…` 和 runId JSON 一变，后面约 10k token 的工具定义就全部失去缓存。上一份追踪报告里「首轮只命中 3.3k」正是这个原因（3,328 = system 稳定前缀）。
- 代价：改 `product-context.ts:58` 的拼接位置，不涉及路由。

### 5.2 只读问题首轮会不会多走一轮（`firstround_probe*.py`，全部 32 个工具不变）

| 首轮读页内容 | n | 首轮先调工具 | 首个输出中位（最小–最大） | prompt token |
|---|---:|---:|---|---:|
| 产品现状：AX tree 截 12k + 截断标记（全工具） | 20 | **6**（js、browser_run 等） | 5.9 秒（3.7–12.1） | 19.1k |
| 只给 8 个读类工具，同样的 AX tree | 3 | 1 | 6.5 秒 | 12.2k |
| **正文文本 12k（Wikipedia 正文抽取），全工具** | 11 | **0** | **3.3 秒**（2.4–9.7） | 17.8k |
| 无工具 + 一句话 system（即「只读道」上限） | 3 | 0 | 3.9 秒（3.6–14.2） | 4.6k |

- 12k 字 AX tree 里，`text:` 节点合计约 1.5k 字，其余是导航和 ref 标记。模型「不信」它是合理的。
- 只把工具删到 8 个，没能消除多读（1/3）；换成正文后，全工具也 0/11 多读。**决定多不多走一轮的是读页质量，不是工具集。**
- 19k 对 4.6k token 的首字差在服务端抖动里看不出来（首事件 2–8 秒波动）。提示词大小对首字的影响**小于 1 秒量级**。
- 局限：正文用 Wikipedia API 抽取，是理想情况。真实网页要用扩展内的 Readability 类抽取，效果要另测。只测了一个页面、一类问题；回答质量没判分（抽看 8 条回答开头都是正确摘要）。

### 5.3 纯规则路由离线回放（`rules_router_offline.py`）

- 数据：9/21 实验的 225 条真实任务请求，去掉 steer / control / status / incomplete 后剩 205 条。参照标签是 Jev 的 lane，是模型标的，不是人工真值。
- 规则：问句特征词，且不含动作词，才判为只读。
- 结果：参照只读 58 条。规则判只读 31 条，其中对 26 条、错 5 条：**精度 0.84，召回 0.45**。
- 5 条误判都需要工具。例如「这个视频的字幕你能获取到吗？」「他的这条推特底下大家的评价是怎么样的？」（要滚动、展开评论）。**「只读」不等于「工具少」**：很多读问题要翻页、展开、取字幕。
- Jev 标签本身也有错，例如「点击并且帮我确认……」被标成 answer。说明连参照标签都不稳。

---

## 6. 挑战 BYS 现状（b-1）

| 假设 / 做法 | 判断 | 理由 |
|---|---|---|
| 「文字不设路由，主模型全权决定」 | **方向与前沿一致，不是问题根源** | Claude in Chrome、ChatGPT agent 内部、Comet、Gemini 都是单循环加闸门。慢的根源在 §5.2 的读页 |
| 首轮读页给 AX tree 前 12k 字 | **不成立，是首要病灶** | 正文占比约 12%，又带截断标记。行业参考实现给正文（Anthropic `get_page_text`、Comet `GetPageText` 转 markdown） |
| `prompt.ts:42`「switch to it if it isn't your working tab」 | 诱发多余的 `tabs` 轮 | 追踪 r2 第一轮想了 15 秒，结论是切标签页 |
| system prompt 末尾带日期和运行时 JSON | **不成立，白白丢缓存** | §5.1：首轮缓存 0–3.3k，改位置后 14.1k |
| 32 个工具 / 42k 字定义 | 偏多，是次要问题 | 超过 OpenAI 建议的 <20。`read_element` 一个就 4.1k 字。有重叠（click / double_click / hover，read_element / read_elements / snapshot / js / fetch）。主要影响准确率，不是延迟 |
| 语音分类器（3.8k 字提示词 + 大量正则校验） | 控制面上有必要，但**维护成本已经显性化** | 提示词几乎全是边界案例补丁（steer vs start、listen、clarify、引用不执行……）。9/21 旧分类器只判对 14/24，中位 2 秒、p90 6.9 秒 |
| 语音 observe 走独立的无工具道 | **和你的文字路由提案是同一种风险，而且已经出过事** | 9/09「圈出来」没执行。现在 chat 已改回保留工具，observe 道仍是无工具道 |
| 语音和文字两套入口逻辑 | 一致性风险 | 同一句话，语音和文字可能走不同的道、得到不同结果 |
| 回答后的 goal check / memory | 与路由无关，但浪费 | 纯问答也跑，还会重新挂调试器（上一份报告 §4.4） |

---

## 7. 挑战你的路由提案（b-2）

提案：规则 + 低思考小模型，把文字输入分成「只读问答」（少工具、短提示词）和「动作任务」。

| 提案隐含的假设 | 是否成立 | 依据 |
|---|---|---|
| H-a：只读问题慢，是因为 15k 固定提示词 / 32 个工具 | **基本不成立** | §5.2：全工具 + 好读页 3.3 秒，和无工具短提示词 3.9 秒同一量级。慢在多出来的 2–3 轮 |
| H-b：只读道能消灭多余轮次 | **不成立，除非同时修读页** | 只读道拿着同样的截断 AX tree：给读工具就照样重读（§5.2 C：1/3）；不给工具就只能凭 1.5k 字正文答，质量风险更大 |
| H-c：小模型分类够快 | **在 BYS 的供应商上不成立** | 本仓库：旧分类器中位 2.0 秒、p90 6.9 秒；Jev 0.8–0.9 秒。追踪报告：step-3.5-flash 做 350 token 分类也会思考到 5–10 秒，还会撞 1600 上限。51 ms 级只出现在自托管（Arch-Router） |
| H-d：误路由代价小 | **不成立，而且代价不对称** | 动作错进只读道：失败或多一轮升级（step-5 每轮 5–10 秒），有 9/09 事故为证。只读错进动作道：等于现状。要安全就得在只读道留「升级」工具，那又回到多一轮 |
| H-e：规则能覆盖大头 | **不成立** | §5.3：召回 0.45。真实用户话语口语化、带 ASR 噪声、指代多 |
| H-f：前沿产品这么做 | **没有公开证据** | §2：要么显式模式，要么单循环加闸门；公开的路由器都是选模型 |
| H-g：维护成本可控 | **存疑** | 语音分类器提示词和校验器的膨胀，就是现成的反例 |
| H-h：两套工具集不影响缓存 | **不成立** | 两个前缀各自冷启动；StepFun 是 LRU，低频的那套更容易被淘汰 |

**期望值粗算**（每条文字输入的平均首字变化，负数表示变慢）：

ΔT ≈ p_只读 × 省下的时间 − 分类器延迟 − p_误路由 × 误路由代价

- **LLM 路由，读页修好后**：p_只读 ≈ 0.28（58/205），省下 ≤1 秒，分类器 1–2 秒、对 100% 的输入都加，p_误路由 ≈ 0.02–0.05，代价约 10 秒。
  ΔT ≈ 0.28 × 1 − 1.5 − 0.03 × 10 ≈ **−1.5 秒**。
- **LLM 路由，读页不修**：省下的时间理论上有 15–45 秒（多读轮），但前提是只读道不多读，§5.2 说明做不到。
- **纯规则路由**：分类器 0 秒；只路由约 13% 的输入，每条省 ≤1 秒；误路由 2.4%。
  ΔT ≈ 0.13 − 0.24 ≈ **0 到负**。

**提案里值得保留的部分：**

1. 「只读的请求不该挂调试器、不该跑 goal check / habit」。这个对，但可以**事后**判定（模型一轮没用工具就交付了），零误路由。
2. 「纯闲聊 / 知识问答不必先读页」。这个也对。可以把读页做到足够便宜：content script 抽正文约 100 ms，不挂 debugger。也可以像语音 chat 那样按需读，但按需读又要先分类，所以优先做便宜读页。
3. 「选思考档」可以按规则做（例如有选中文本、或请求很短时用 low），但追踪报告显示 low 对两类请求都不伤，直接默认 low 更简单。

---

## 8. 备选方案对比

| 方案 | 首字收益 | 误路由风险 | 实现 / 维护成本 | 供应商依赖 | 判断 |
|---|---|---|---|---|---|
| **A. 读页改正文抽取 + 删截断恐吓 + 去掉「先切标签页」** | 高（消灭 30% 的多余轮次，−15~45 秒长尾） | 无 | 中：要在扩展里加正文抽取；AX tree 留给动作时用 snapshot | 无 | **先做** |
| **B. 动态段移出 system，稳定前缀在前** | 每轮约 −0.5~1 秒（待测），成本 −70% | 无 | 低 | 所有支持前缀缓存的供应商 | **先做** |
| **C. 默认思考档 low** | 长尾 −15~30 秒 | 无 | 低 | StepFun / OpenAI 系 | **先做**（上一份报告） |
| **D. 事后分流：零工具答完的不做 goal check / habit / 不再读页** | 不影响首字；调试器横幅早关，省 15–26 秒后台 | 无 | 低 | 无 | 做 |
| E. 工具合并 / 精简描述（32→≤20，42k→≤20k 字） | 小（<1 秒） | 无，但改错会伤准确率 | 中–高，要跑评测 | 无 | 用评测驱动，第二批 |
| F. Tool search / 延迟加载 | 负（StepFun 要客户端实现，每次搜工具多一轮 5–10 秒） | 有（搜不到工具） | 高 | 只有 Claude / gpt-5.4+ 原生支持 | **现在不做**；工具 >50 或接入 MCP 时再看 |
| G. 前置 LLM 路由器（你的提案） | 负到 0（§7） | 有，且不对称 | 中–高，持续维护 | 依赖快速、不思考的小模型 | **不做**；先做影子模式收数据 |
| H. 规则快路由（只路由极高置信的子集，例如有选中文本的「解释」） | 小 | 低（范围极窄时） | 低 | 无 | 已有：划词解释就是这条路。不要再扩大 |
| I. 显式「只问不做」模式开关（类 Atlas Ask / Cursor Ask） | 只读请求可走无工具短提示词，零误路由 | 由用户承担 | 低（UI）+ 用户摩擦 | 无 | 备选。A–D 之后只读仍慢才考虑；或者做成**权限**（只读权限），不做成意图 |
| J. Nanobrowser 式「同一次调用里分类并回答」 | 0 额外延迟 | 低（模型自己判） | — | — | BYS 的单循环本来就是这样：模型不调工具就是在直接答。不需要新组件 |

---

## 9. 建议：写成可证伪的假设，各配一个便宜实验（c）

统一指标定义：
- **首字** = 发送到侧栏第一个正文字（不是首个流事件）。
- **轮数** = 主模型请求次数。
- **成功率** = eval harness judge v3 判定。
- **误路由率** = 路由判定 ≠ 事后真值。事后真值从 trace 自动得出：本轮用过任何写工具 = 动作；零工具或只用读工具答完 = 只读。

| # | 假设 | 实验（复用现有 harness） | 通过标准 | 成本 |
|---|---|---|---|---|
| H1 | 只读问题多走的轮次，主要由读页质量造成 | ① 离线重放：把 `bys-trace` 里 7 个总结请求体，以及 eval 中 `page_understanding` 18 题、`selection_ask` 10 题的首轮请求体，读页换成扩展端正文抽取（Readability 或 `innerText` 主体），每题 5 次，比首轮先调工具率。② 真实路径：`eval/harness/run.mjs --tasks <page_understanding 18 题>`，基线与补丁各 1 遍 | 首轮先调工具率从约 30% 降到 ≤5%；首字 p50 ≤6 秒、p90 ≤12 秒；成功率不降 | 半天 + 约 200 次调用 |
| H2 | 动态段移出 system 后，首轮缓存命中 ≥14k，首个事件 p50 降 ≥0.5 秒 | 重放 A / B 两种请求体各 20 次，交错发送（抵消服务端时段波动），记录 `cached_tokens` 和首个事件时间 | 缓存命中率 ≥70%；首个事件 p50 差 ≥0.5 秒（达不到就只当省钱改动） | 1 小时 |
| H3 | H1、H2 做完后，提示词和工具规模对首字的边际影响 <1 秒，所以「为缩提示词而路由」不划算 | 同一个只读题，3 种请求体（全工具 / 8 个读工具 / 无工具），各 20 次交错重放，比首个正文字 | p50 差 <1 秒，则否决「为缩提示词加路由」；≥2 秒则重开路由讨论 | 1 小时 |
| H4 | 前置路由器（规则或 LLM）在 BYS 上净首字收益 ≤0 | **影子路由**（9/21 已提议）：每条文字输入并行跑候选路由器（规则 / Jev / step-3.5-flash low），只记录不干预；trace 里同时记录事后真值。跑 1 周日常使用 + eval 全集 | 算出每个候选的误路由率、分类延迟 p50 / p90，代入 ΔT 公式。ΔT >+1 秒且「动作被判成只读」<1%，才进入真实分流 A/B | 1 天实现 + 1 周数据 |
| H5 | 事后分流（零工具答完就跳过后台调用和二次读页）不影响记忆和结果质量 | eval `memory_skill` 34 题 + `page_understanding` 18 题，开 / 关各一遍；同时量调试器 detach 时间 | 记忆题成功率不降；只读题回答后调试器 ≤2 秒 detach | 半天 |
| H6 | 工具合并和描述精简（≤20 个、≤20k 字）提升动作题成功率、减少错误首步 | eval `browser_action_single` 17 题 + `browser_action_multistep` 18 题 + `form_fill_no_submit` 14 题，基线对比；记录首步工具分布 | 成功率 ≥ 基线，首步 `tabs` 误切换减少；任何类别下降 >5 个点就回滚 | 2–3 天 |
| H7 | 思考档默认 low 不伤成功率 | eval 全集抽 40 题，默认档与 low 各一遍 | 成功率差 ≤3 个点，p90 首字降 ≥10 秒 | 半天 |
| H8（可选） | 显式「只问不做」开关有人用，且比自动更受信任 | 只在 H1–H3 后只读 p90 仍 >10 秒时做：灰度上线开关，看使用率和只读首字 | 使用率 >10% 且满意度上升 | — |

建议顺序：H2（1 小时，零风险）→ H1 → H7 → H5 → H3 → H4（影子数据）→ H6。只有 H3 和 H4 都给出正值，才重新考虑文字路由器。

---

## 10. 不知道 / 没公开的

- GPT-5 router、Copilot Smart mode 的特征、准确率和延迟：只有一句话描述。
- Comet「检测到需要动浏览器就先问」、Gemini「先给计划」：不清楚是独立分类器还是主模型的输出。Atlas 的 Ask 侧栏具体有哪些工具，也没公开。
- Claude in Chrome 的内部工具集和提示词：没有官方公开。
- Dia 的端侧分类器信息来自第三方逆向，且是旧版本（1.34.2 起不再附带 source map），不能当事实。
- StepFun 模板里 tools 的渲染位置：没有文档，是从 §5.1 的缓存数据**推断**的。
- 本次实验：n 小（3–20），单一页面，单一时段，用的是理想化正文抽取；回答质量没判分。Jev 标签不是人工真值。
- 「只读请求占比」：只有 9/21 的 225 条，其中混有评测夹具，不代表用户日常分布。

---

## 11. 文件

- 报告：`/workspace/bys-intent-research/REPORT.md`
- 实验脚本和数据：`/workspace/bys-intent-research/probe/`
  - `cache_probe.py` / `.json` / `.log`（§5.1）
  - `firstround_probe.py`、`firstround_probe2.py` 及其 `.json` / `.log`（§5.2；probe2 额外保存回答开头）
  - `rules_router_offline.py` / `.log`（§5.3）
  - `miyazaki.txt`（正文抽取样本）
- 读过的开源代码（浅克隆）：`/workspace/bys-intent-research/src/`：browser-use c75e847、nanobrowser ad47282、stagehand f261c38、skyvern f5f3f28、claude-quickstarts 9ec32b9、openai-cua-sample-app f2a3dc5
