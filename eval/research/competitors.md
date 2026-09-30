# By Your Side（BYS）竞品调研：浏览器侧边栏 / AI 浏览器助手

> 调研日期：2026-09-30（北京时间）。资料来源：官方页面、帮助中心、科技媒体评测、X / Reddit / V2EX / 少数派等社区。
> 标注约定：✅ = 官方明确支持；◐ = 部分支持 / 有限制（仅付费、地区限制、预览版）；❌ = 未见支持；? = 未验证（只有搜索摘要或二手来源，没打开原文核实）。
> 引用只列本次实际抓取过或在搜索结果里看到的 URL。**标 [二手] 的是第三方转述，[未验证] 的是没打开原文核实的内容**。openai.com、perplexity.ai 对抓取工具返回 403 或超时，这两家的相关内容主要依据媒体评测和帮助中心的搜索摘要。

## 0. BYS 现状速览（依据仓库 README / usage.md / STATUS.md）

- Chrome MV3 侧边栏扩展，v0.2.0。
- 已有能力：
  - 网页理解；划词提问（Ctrl/⌘J，选区工具条上有"问 AI / 解释"）。
  - 原地整页翻译（双语对照 / 仅译文，可切宋体，可还原）。
  - 浏览器操作：导航、搜索、点击、填写、截图、多步任务，使用用户已登录的浏览器。
  - "圈给你看"手绘框选；任务中途插话纠偏；多个独立任务并行。
  - 自动记忆用户说过的个人信息（可撤销，可按站点区分）；历史任务记录。
  - "示范给 AI"和技能：**仅 native（本地 host）模式**。
  - 语音（StepAudio Realtime）。
  - 生成 CSV / MD / TXT / JSON / HTML / SVG 文件；下载前经 chrome.downloads 确认。
  - 危险点击（发送、删除、支付、发布、提交）需要用户在页面上确认。
- 翻译不支持 PDF、图片 OCR、跨域 iframe。
- 仓库里没找到以下能力：定时任务、"/"快捷指令、@标签页、PDF / 视频理解、生成 xlsx / pptx / docx。
- 现有 eval 全是本地 fixture 页面：`eval/runs/live-*`、`scripts/acceptance/product-journeys/cases.mts` 共 12 条、`docs/evals/20260925-sitegeist-parity.md`。**没有公网真实站点的任务分布**，这也是本次 tasks.jsonl 要补的。

## 1. 竞品 × 能力对比表

| 竞品 | 形态 | 页面问答/总结 | 划词 | 整页翻译 | 单步操作 | 多步代理 | 多标签上下文 | 表单填写 | 抽取→表格/文件 | 记忆 | 技能/快捷指令 | 录制/示范 | 定时/监控 | PDF/视频 | 语音 | 价格门槛 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **By Your Side** | Chrome 侧边栏扩展 | ✅ | ✅ Ctrl+J | ✅ 双语/仅译文 | ✅ | ✅ | ◐ 隐式（无 @tab） | ✅ 不提交 | ✅ CSV/MD/JSON | ✅ 自动记忆 | ◐ 仅 native | ◐ 示范给 AI（仅 native） | ❌ | ❌ | ✅ | 自带 |
| Claude in Chrome | Chrome 侧边栏扩展 | ✅ | ? | ? | ✅ | ✅ | ✅ tab group | ✅ | ✅ | ✅（Cowork 会话） | ✅ "/"快捷 + skills | ✅ 录制工作流（仅经典面板） | ✅ 定时任务 | ◐ 图片上传 | ? | 仅付费套餐 |
| ChatGPT Atlas / 代理模式 | 独立浏览器（macOS） | ✅ | ✅ 光标聊天 | ? | ✅ | ◐ 代理模式（付费预览） | ✅ 标签页命令 | ✅ | ◐ | ✅ 浏览器记忆 | ? | ❌ | ? | ? | ? | 代理需付费 |
| Perplexity Comet | 独立浏览器 | ✅ | ✅ | ? | ✅ | ✅ | ✅ @tabs | ✅ | ◐ | ? | ✅ "/"快捷 | ❌ | ◐ 后台助手（Max） | ? | ✅ | 免费；后台助手需 Max |
| Gemini in Chrome | Chrome 内置 | ✅ | ✅ | ? | ◐ auto browse | ◐ 仅美国、英文、AI Pro/Ultra | ✅ 最多 10 个标签 | ✅（发送/提交前确认） | ◐ | ? | ? | ❌ | ? | ✅ 音视频 | ✅ Gemini Live | 代理需付费 |
| Edge Copilot Mode | Edge 内置 | ✅ | ✅ | ✅（侧窗翻译） | ✅ Actions | ◐ | ✅ 多标签 | ✅ | ? | ✅ 历史（需开启） | ? | ❌ | ? | ? | ✅ 语音导航 | 免费（预览） |
| Opera Neon | 独立浏览器 | ✅ Chat | ? | ? | ✅ Neon Do | ✅ | ✅ Tasks 工作区 | ✅ | ✅ Make | ? | ✅ Cards | ❌ | ? | ? | ? | $19.9/月 |
| Dia | 独立浏览器 | ✅ | ✅ | ? | ? | ? | ✅ | ? | ? | ✅ | ✅ Skills + 市场 | ❌ | ? | ? | ? | 免费 + 付费 |
| Monica | 扩展 | ✅ | ✅ | ✅ | ✅ Browser Operator | ✅（积分） | ? | ✅ | ✅ | ? | ✅ | ? | ? | ✅ PDF | ? | 积分制 |
| Sider（Sider Hand） | 扩展 + 云电脑 | ✅ | ✅ | ✅ 50+ 语言 | ✅ | ✅ | ? | ✅ | ✅ 表格 | ? | ✅ | ? | ◐ 价格追踪 | ✅ PDF | ? | 免费 + 付费 |
| 豆包浏览器插件 / 豆包工作 | 扩展 / 浏览器 | ✅ | ✅ 自定义划词技能 | ✅ 逐段双语 | ✅ | ✅ | ? | ✅ | ◐ | ? | ✅ | ✅ 录制回放成技能 | ✅ 定时 | ✅ PDF、图片、音视频（带时间戳） | ✅ 朗读 | 免费 |
| Kimi 浏览器扩展 | 扩展 + 本地 bridge | ✅ | ✅（老版 Cmd/Alt+K） | ? | ✅ | ✅ | ? | ✅ | ✅ | ? | ✅ "/"调用 | ✅ 录制成 Skill | ? | ? | ? | 未验证 |
| Manus Browser Operator | 云端 agent + 本地扩展 | ◐ | ❌ | ❌ | ✅ | ✅ | ✅ 专属 tab group | ◐ 官方承认多步表单不完美 | ✅ | ? | ? | ❌ | ? | ? | ? | 付费 |
| HARPA AI | 扩展 | ✅ | ✅ {{selection}} | ✅ | ✅ | ✅ | ? | ✅ | ✅ | ? | ✅ "//"命令，100+ 模板 | ◐ | ✅ 页面变化、降价、到货监控 | ✅ YouTube 带时间戳 | ? | 免费 + 付费 |
| Nanobrowser | 开源扩展 | ◐ | ❌ | ❌ | ✅ | ✅ Planner/Navigator | ? | ✅ | ◐ | ❌ | ❌ | ❌ | ❌ | ❌ | ? | 自带 key |
| Browser Use | 框架 + 云 + CLI | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ CSV | ◐ profile 同步 | ✅ Skills API | ◐ code mode 生成脚本 | ✅ 定时 agent | ❌ | ❌ | 开源 + 云付费 |

## 2. 各竞品要点（功能 / 代表任务 / 用户评价）

### 2.1 Claude in Chrome（Anthropic）
- **存在性**：✅。2026-08-26 在全部付费套餐 GA。
  - https://support.claude.com/en/articles/12012173
  - https://claude.com/claude-for-chrome
  - Chrome Web Store 上有上架页。
- **功能**：
  - 侧边栏里读页面、点击、输入、导航、填表。
  - 用 tab group 管理多个标签页。
  - "/"快捷指令；录制工作流（仅经典面板）；定时任务。
  - 可读 console / network 日志；后台运行工作流并发通知。
  - 支持图片上传；可用 1Password 登录。
  - 内置 Gmail、Calendar、Docs、Slack、GitHub 等站点的使用知识。
  - 侧边栏已变成 Cowork 会话：会话可保存、跨设备，带 skills 和 connectors。
- **代表 demo**：
  - 从没有导出按钮的后台 dashboard 抽取数据
  - 收件箱清理、会前准备
  - 把竞品定价整理进演示文稿
  - 把发票录入表格
- **好评**（X）：
  - @AskMichaelTaiwo：抓数据比 Apify 好用。
  - @MoonDevOnYT：lifesaver。
- **吐槽**：
  - 慢、耗 token（Reddit，来自搜索摘要 [未验证原帖]；X @anaestheticdev "painfully slow"）。
  - 会话持久化上线前，聊天记录会丢失（X @pradeepXkapoor）。
- **安全**：Zenity 等研究披露了扩展劫持 / 提示注入类漏洞（PleaseFix、BragJack，CVE-2026-0628、CVE-2026-55945），影响多家 AI 浏览器 [二手，未逐一核对 CVE 原文]。

### 2.2 ChatGPT Atlas / 代理模式（OpenAI）
- **存在性**：✅。2025-10-21 发布 macOS 版。
  - 少数派：https://sspai.com/post/103275
  - MakeUseOf："A week with ChatGPT Atlas convinced me to uninstall it"
  - dev.to/aifrontierpost 评测
  - openai.com 对抓取返回 403，官方页面未直接读到。
- **功能**：
  - Ask ChatGPT 侧栏。
  - 光标聊天：在输入框里就地改写。
  - 代理模式（付费预览）。
  - 浏览器记忆；可按网站开关 ChatGPT 是否可见。
  - 标签页命令，如"关掉我的菜谱标签""重新打开昨天看的旅行网站"。
- **代表任务**（少数派文章举例）：分析百度热搜；汇总一部豆瓣电影的全部评论。
- **吐槽**：
  - MakeUseOf：让它把 Sheets 里的数据复制进 Docs，它写了一段摘要而不是粘数据，用了 3 分钟；代理还会跑偏、卡在滚动上。
  - dev.to [二手]：代理每天 40 次操作上限；约 14% 的引用是幻觉；测试优惠码时已经成功了还继续操作。
  - Reddit：代理报 500 错误 [搜索摘要]。
- **相关**：OpenAI 在 X 上发布过两项相关能力：
  - Codex Chrome 插件，可在后台并行标签页里执行任务（@OpenAI，2026-05-07）。
  - ChatGPT Work 登录站点（@ChatGPT，2026-08-25）。

### 2.3 Perplexity Comet
- **存在性**：✅。TechCrunch 2025-10-02 报道：对所有人免费，后台助手面向 Max 用户。帮助中心页面（perplexity.ai/help-center/comet/en/articles/11732243、11734688）抓取超时，内容依据搜索摘要 [未验证全文]。
- **功能**：
  - 侧栏助手，可用 @tabs 引用标签页，总结、比较多个标签页。
  - 表单自动化；Gmail / Calendar 集成；标签页分组。
  - "/"自定义快捷指令。
- **好评**：快捷指令好用；能利用已打开标签页的上下文；有人用快捷指令一键生成 Trello 卡片（Reddit r/perplexity_ai 1mo96zy、1m789pe）。
- **吐槽**：
  - 复杂网站上失败、卡住。
  - 截图点击模式点不准，还更慢。
  - 原本能用的快捷指令后来坏了。
  - 不会自己滚动页面。
  - 占内存多；有隐私担忧。
  - 来源：r/perplexity_ai 1mdimvq、r/PerplexityComet 1of9udi。

### 2.4 Gemini in Chrome（Google）
- **存在性**：✅。
  - https://support.google.com/chrome/answer/16283624
  - https://support.google.com/chrome/answer/16821166
- **功能**：
  - 可用当前标签页，外加最多 10 个标签页（@ 或"Add tabs"）。
  - 理解用户播放过的音视频；Gemini Live 语音。
  - **Auto browse**：
    - 限美国、英文、AI Pro/Ultra，每天 20 / 200 次任务。
    - 开始前先展示计划供用户确认。
    - 可接管、可交还。
    - 发送、提交、预约、修改数据前会确认。
    - 可用 Password Manager 登录。
- **代表任务**（帮助页示例）：
  - 总结、换个方式解释、出题考我、改写菜谱、比较多个页面、推荐、起草 Gmail
  - Auto browse：比价后加入购物车、旅行规划、预订、找收据
- **社区评价**：本次未系统收集 [未验证]。

### 2.5 Microsoft Edge Copilot Mode
- **存在性**：✅。
  - blogs.windows.com/msedgedev，2025-07-28 和 2025-10-23
  - PCMag 评测
  - Microsoft Support 的 Journeys 页面
- **功能**：
  - 多标签上下文，例如"哪套度假屋离海滩最近"。
  - 语音导航。
  - 侧窗里转换菜谱、翻译。
  - Actions：退订邮件列表、预订等。
  - Journeys：按主题整理浏览历史（美国预览）。
  - 历史记录上下文，需用户主动开启。
- **评测**：PCMag 称预订流程能跑通，但需要用户提供电话号码，而且慢。

### 2.6 Opera Neon
- **存在性**：✅。
  - Opera 博客 2025-09-30
  - The Verge 评测
  - $19.90/月
- **功能**：
  - Tasks 工作区。
  - Cards：可复用的 prompt "能力卡"，有卡片商店，比如"抽取详情 + 生成对比表"。
  - Neon Do：在本地已登录会话里操作；demo 是打开 NASA 飞掠任务页面。
  - Make：在云端 VM 里造小工具。
- **吐槽**（The Verge）：
  - Chat 信心满满地报错 Verge 文章的评论数。
  - Do 运行中无法纠正；把错的商品加进购物篮；谎称没有票。
  - 整体比自己动手还慢。

### 2.7 Dia（The Browser Company）
- **存在性**：✅。
  - https://www.diabrowser.com
  - TechCrunch 2025-07-21（技能库）
- **功能**：
  - 能结合标签页、选区、历史记录聊天。
  - Skills（/proof、/summary 等），有技能库，也能用自然语言生成技能。
  - 记忆；连接器。
- **吐槽**：
  - 技能在 New Chat 里失效；占内存；同步问题（Reddit，搜索摘要 [未验证原帖]）。
  - dev.to 称约 30% 幻觉 [二手]。

### 2.8 Monica
- **存在性**：✅。https://monica.im/help/Features/AI-Agent/Monica_Agent
- **功能**：
  - 多模型侧栏；Deep Research；生成幻灯片（Create Slides）。
  - Browser Operator（付费、消耗积分）：数据收集、竞品监控、表单处理。
- **吐槽**：积分体系复杂（评测站观点 [未验证具体出处]）。

### 2.9 Sider（Sider Hand）
- **存在性**：✅。
  - https://sider.ai/extensions/ai-chrome-extension
  - https://sider.ai/agents/claw（代理已更名 "Sider Hand"）
- **功能**：
  - 多模型并排对比。
  - 结合上下文的整页翻译，支持 50+ 语言。
  - 总结、划词解释、PDF、深度研究。
- **Sider Hand demo**：
  - Amazon 价格追踪写进表格
  - 活动情报表（日期、地点、票价）
  - 公司联系方式收集
  - Reddit 话题扫描、评论痛点挖掘
  - 能用已登录会话，也能用云电脑

### 2.10 豆包浏览器插件 / 豆包工作
- **存在性**：✅。
  - https://www.aigcdaily.cn/news/a24xeooj6lj21cg
  - https://ai-bot.cn/doubao-browser-recording-replay-review/
- **功能**：
  - 逐段双语翻译。
  - 网页、PDF、图片总结；搜索结果页的 AI 总结卡。
  - 划词工具条可自定义技能（用 {selection} 引用选中文字）。
  - 语法检查；朗读。
  - 视频 / 播客总结，带时间戳跳转。
- **豆包工作"录制回放"**：
  - 录一遍就变成技能；会追问规则细节。
  - 支持参数化和定时。
  - 例子：公众号文章分发到知乎草稿、小红书选题收集、按偏好筛酒店。
- **社区**：
  - V2EX https://www.v2ex.com/t/1179926 第 10 楼推荐豆包插件的翻译。
  - X @jasonzhouu：中文体验好，但细节粗糙。

### 2.11 Kimi 浏览器扩展（原 WebBridge）
- **存在性**：✅。https://www.kimi.com/products/kimi-browser-extension
- **功能**：
  - 侧边栏 agent：开页面、点击、填表、抽取。
  - 通过本地 bridge 走 CDP 控制浏览器。
  - 技能：可录制操作成 Skill；可根据页面生成指令；成功的会话可存为技能；用"/"调用。
- **代表 demo**：量化策略回测、自动调研成文、智能填写信息。
- **老版 Kimi 助手**：划词提问、页面总结（Cmd/Alt+K）。
- **社区**：aigcdaily 的对比称 Kimi 更轻、划词上下文更好，豆包功能更多、有技能库 [媒体观点]。另有 api.openstarry.com 2026-09-25 的博客 [二手]。

### 2.12 Manus Browser Operator
- **存在性**：✅。https://manus.im/blog/manus-browser-operator
- **功能**：
  - 云端 agent 驱动本地已登录的浏览器。
  - 每个任务单独授权一次；专属 tab group；操作审计日志。
  - 可从手机发起。
  - 可访问 Crunchbase、PitchBook 等付费数据源。
- **官方承认的局限**：拖拽、多步表单还不完美。

### 2.13 HARPA AI
- **存在性**：✅。https://harpa.ai
- **功能**：
  - Alt+A 唤起；100+ 个感知页面的命令；"//"快捷指令。
  - 命令里可用 {{page}}、{{selection}} 参数。
  - 页面变化监控；降价、到货提醒。
  - YouTube 总结带时间戳；Gmail 助手。
  - 自动化：导航、点击、抽取、填写，可由 Zapier / Make / n8n 触发。
  - 支持本地模型。
- **社区评价**：未系统收集 [未验证]。

### 2.14 Nanobrowser / Browser Use
- **Nanobrowser**：
  - https://github.com/nanobrowser/nanobrowser，约 13.8k stars。
  - 开源；Planner / Navigator 多 agent；自带 key；支持 Chrome 和 Edge；demo 是分析 HuggingFace。
  - GitHub issue #126：DOM 树构建失败。
  - Reddit：agent 进入死循环烧钱 [搜索摘要]。
- **Browser Use**：
  - https://browser-use.com/changelog
  - CLI 3.0 可连真实浏览器；code mode 生成可复用脚本；定时 agent；Skills API；profile 同步。
  - demo：抓 HN 前 10 条的标题和链接、GitHub trending 前 3 个仓库、抽 1000 个商品 → 过滤 → 导出 CSV、用 LinkedIn 数据补全 CSV。

### 2.15 其他发现
- **Sitegeist**（https://github.com/badlogic/sitegeist）：BYS 已做过 parity eval。
- **Codex Chrome 插件**：见 2.2。
- **Brave Leo**（dev.to 提及）。
- **Genspark、Fellou**（AI 浏览器 / 代理；只看到搜索摘要 [未验证]）。
- **中文社区**：
  - X @ledoker：很多 AI 浏览器只是"套了个侧边栏皮"。
  - V2EX 翻译插件讨论帖（t/1179926）：沉浸式翻译无法访问后，大家推荐的替代品有 Google / Edge 内置翻译、Hunyuan-MT-7B（硅基流动）、kiss-translator、豆包插件。

## 3. 用户最在意什么（跨竞品共性）

1. **速度和"不如自己动手"**：Claude、Atlas、Neon、Edge 都被吐槽慢。多步代理的价值要能盖过等待成本。
2. **结果真实性**：Neon 报错评论数、Atlas 引用幻觉、Dia 幻觉。"数得对、引得对"是底线。
3. **按原意执行**：Atlas 把"复制数据"做成了"写摘要"，任务成功后还继续操作。要能判断任务何时算完成。
4. **能中途纠正 / 接管**：Neon Do 不能纠正是槽点；Gemini、Manus 把接管做成了卖点（BYS 已有插话纠偏）。
5. **复用**："/"快捷指令、技能、录制回放是社区好评最集中的地方（Comet、Dia、豆包、Kimi）。快捷指令"后来坏了"也是 Comet 的高频吐槽。
6. **安全与隐私**：提示注入、扩展劫持研究；Comet 的隐私担忧；各家都在敏感操作前加确认。

## 4. BYS 值得补的功能缺口（按优先级）

| # | 缺口 | 谁有 | 说明 |
|---|---|---|---|
| 1 | **定时 / 周期任务 + 页面变化、降价、到货监控** | Claude（定时任务）、HARPA、豆包工作、Browser Use、Comet 后台助手 | BYS 没有 alarms / notifications 权限。"每天 9 点帮我看一下××"是高频需求 |
| 2 | **extension-only 模式也能用技能 / 示范，加"/"快捷指令和技能市场** | Claude、Comet、Dia、Neon Cards、Kimi、豆包、HARPA | 目前示范和技能只在 native 模式可用；普通用户装扩展后用不到 |
| 3 | **显式多标签上下文（@tab、选择标签组）** | Gemini（10 个标签）、Comet、Claude、Edge（"最多 30 个标签"为 [未验证]） | 用户想明确指定"比较这 3 个标签页" |
| 4 | **PDF、音视频、图片理解**（含 PDF 翻译） | 豆包（视频带时间戳）、Gemini、Sider、HARPA（YouTube） | BYS 翻译不覆盖 PDF 和图片 |
| 5 | **执行前展示计划 + 预计步骤** | Gemini auto browse、Fellou [未验证] | 缓解"慢且不可控"的焦虑 |
| 6 | **后台并行任务面板 + 系统通知** | Comet、Codex 插件、Claude | BYS 能并行，但缺少统一面板和完成通知 |
| 7 | **二进制办公格式输出（xlsx / docx / pptx）和连接器** | Claude Cowork、Monica Slides | BYS 目前只能出文本类文件 |
| 8 | **输入框内就地改写、语法检查** | Atlas 光标聊天、豆包 | 写作场景高频 |
| 9 | **浏览历史记忆 / 主题旅程** | Atlas、Edge Journeys | "上周看过的那个××" |
| 10 | **搜索结果页 AI 总结卡** | 豆包、HARPA | 低成本、高曝光 |
| 11 | **多模型并排对比** | Sider、Monica | |
| 12 | **跨设备会话延续 / 从手机发起** | Claude、Manus | |
| 13 | **密码管理器登录** | Claude（1Password）、Gemini（Password Manager） | |
| 14 | **开发者调试（console / network）** | Claude | 面向开发者 |
| 15 | **内置站点专属知识（Gmail、GitHub 等）** | Claude | 提升常用站点的成功率 |

## 5. 主要来源清单
- Claude：https://support.claude.com/en/articles/12012173 ・ https://claude.com/claude-for-chrome
- Atlas：https://sspai.com/post/103275 ・ MakeUseOf《A week with ChatGPT Atlas convinced me to uninstall it》・ dev.to/aifrontierpost
- Comet：TechCrunch 2025-10-02 ・ reddit.com/r/perplexity_ai/comments/1mo96zy、1m789pe、1mdimvq ・ reddit.com/r/PerplexityComet/comments/1of9udi ・ perplexity.ai/help-center/comet（搜索摘要）
- Gemini：https://support.google.com/chrome/answer/16283624 ・ https://support.google.com/chrome/answer/16821166
- Edge：https://blogs.windows.com/msedgedev/（2025-07-28、2025-10-23）・ PCMag
- Opera Neon：https://blogs.opera.com/（2025-09-30）・ The Verge 评测
- Dia：https://www.diabrowser.com ・ TechCrunch 2025-07-21
- Monica：https://monica.im/help/Features/AI-Agent/Monica_Agent
- Sider：https://sider.ai/extensions/ai-chrome-extension ・ https://sider.ai/agents/claw
- 豆包：https://www.aigcdaily.cn/news/a24xeooj6lj21cg ・ https://ai-bot.cn/doubao-browser-recording-replay-review/
- Kimi：https://www.kimi.com/products/kimi-browser-extension
- Manus：https://manus.im/blog/manus-browser-operator
- HARPA：https://harpa.ai
- Nanobrowser：https://github.com/nanobrowser/nanobrowser
- Browser Use：https://browser-use.com/changelog
- Sitegeist：https://github.com/badlogic/sitegeist
- V2EX：https://www.v2ex.com/t/1179926
