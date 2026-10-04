# 当前状态

核对日期：2026-10-03。开发预览版，尚无发布通过结论。

日常会话/文件恢复和菜单已加载，关键验收通过（[部署](evals/20261003-session-deployment.md)）。PDF有可见录像；本机模式已退役，产品仅为扩展（[退役验收](evals/20261001-retire-native-and-dead-code.md)）。真人试用另计。

## 现在能用什么、还差什么

| 能力 | 现在 | 还差 | 证据 |
|---|---|---|---|
| 侧栏对话与外观 | 长名称两行＋更新时间；第二版连续对话；模型切换在「更多」里，展开/收起有轻动效（用户认可手感）；真侧栏 23/23 | 首开新建曾卡住，重开恢复 | [侧栏](evals/20260929-sidebar-interaction.md) · [动效](evals/20260930-model-picker-motion.md) |
| 回答交付 | 正文直接交付，未完成项只标注；问答中位约 10 秒 | 只装扩展时侧栏「还差：…」一行为空（10-01 检查发现，两个模型都复现，原因未查）；复制任务中位约 26 秒 | [开发日志](devlog/20260924-02-回答不再被核验扣下.md) · [没做完的一行](evals/20260925-unfinished-line-and-answer-reveal.md) |
| 读网页 | 大页面读完不再被记为结果未知而锁住后续操作；网址里的密码类信息遮掉 | 原 MiMo 会话里定位失败、「继续」不恢复，根因未确认 | [MDN 修复](evals/20260930-mdn-reading-recovery.md) · [MiMo 试用](evals/20260930-first-user-mimo.md) |
| 整页翻译 | 4 路并发，109 段约 70 秒；待翻段落先出占位，Kimi 限流时自动降速（用户试过：满意） | 说完后主模型先想约 8 秒，页面不动 | [提速](evals/20260926-translate-fast.md) · [占位](evals/20260927-translate-marks.md) |
| 即时动作（快速模型） | 解释约 2 秒出字，一屏变中文 6–11 秒 | 未达 2 秒，瓶颈是智谱首字 | [验收](evals/20260926-instant-2s.md) |
| 记忆与任务感 | 接回记忆与过往任务，跨轮续接，提交前确认由扩展拦下；纠正后开口问「要我记住吗」，点「记住」后在那个网站照做（DeepSeek、GLM 场景 1–10 全对）；GLM 只思考不回正文时当场放宽重试（记忆底座 1/6→6/6） | 已进日常构建（10-01），待真人试用；明确字段规则已在提交前检查，MiniMax缺备注先问、原文续办通过；其他方法执行和检索待加强（见下一步） | [纠正](evals/20261001-remember-corrections.md) · [加固](evals/20261001-memory-hardening.md) · [端到端](evals/20260926-e2e-before-daily-install.md) |
| 页面操作 | 圈画、下载完成/中断如实回报，发送类点击先确认；取到的数据可直接存成侧栏文件、不经模型重打；原地打转连续 6 步无进展自己停下并说明（[数据存文件](evals/20261001-data-to-file.md)） | 失败时露出 Chrome 错误码；备用模型真实切换未验 | [下载](evals/20260926-page-download.md) · [界面 10 项](evals/20260926-ux-fixes.md) · [扩展内核](evals/20260924-core-into-extension.md) |
| 语音 | 插话约 0.25 秒停声；StepFun 挂住约 22 秒发现并请用户重说 | StepFun 傍晚挂住率高；外放回声阈值未经真人 | [插话](evals/20260925-voice-barge-in.md) · [日常纯扩展](evals/20260925-pure-extension-daily.md) |
| 模型思考档与后台判断 | 后台判断（核对、续接、记忆、意图、语音）统一取模型允许的最低档，档位被拒换档、格式不对修复各重试一次，失败带原因；主任务从中档起、按失败/打转/没做完/用户纠正升档；阶跃登记为可看图。探针：M3.1 作主模型带工具跑通，核对 M3.1、GLM 9/9，阶跃可解析 0/9→9/9 | 已进日常构建（10-02）；扩展里选 M3.1 对话待真人（标准 9）；MiniMax-M3 核对正确率 4/9 | [验收](evals/20261001-model-effort-and-side-judgments.md) · [说明](model-effort.md) |
| 结果不确定的边界 | 一步结果不确定后，只拦点击、填写、按键、页面脚本、POST；读页、导航、开标签页、GET、关/确认弹窗照常；同一项只核查一次，查不清由宿主说明后停下（10-01 那次空转 6 次 → 测试复现为 2 次）；被覆盖/不可填记为没执行；点击遇原生弹窗立即返回 | 已进日常构建（10-02）；只读脚本超时仍记不确定；弹窗恢复修复在验收中 | [验收](evals/20261001-unknown-lock-scope.md) · [规则](unknown-results.md) |
| 文件与回答显示 | 模型直接写正文时回答逐字出现（首段比模型晚约 13 ms，真侧栏 + 脚本模型）；设置里能选到能力表登记的模型（MiniMax-M3.1）；生成的文件可点「打开」在隔离查看页里看（网页脚本可运行、碰不到扩展数据） | 已进日常构建（10-02）；三项都待真人试（M3.1 逐字、选模型、打开论证链条 HTML）；调过工具的一轮仍先核对再显示 | [流式](evals/20261002-plain-text-streaming.md) · [打开文件](evals/20261002-open-artifact-in-browser.md) |
| 第一档产品缺口 | 截图以图片卡片给到用户；读页附上被截断名字的完整文字；时间/日期/数字框读出允许范围，填超范围会明说；网站连不上时说明一次就停（不再被核对催回去重试） | 已进日常构建（10-02）；124次复测已完成；截图、时间与PDF题两配置通过，商品全名和部分计数/CSV仍失败（见下一步） | [截图与读页](evals/20261002-tier1-product-gaps.md) · [受阻](evals/20261002-goal-check-blocked.md) · [测量规则](../eval/README.md) |

## 仍需解决

- 改口后改写已有成功回执、真人接管/交还仍有缺口；基本重启续接本轮已有证据；不靠放松核验消除失败。见[Computer Use 复测](evals/20260922-computer-use-product-path.md)。
- 本机模式退役后仍有 3 组检查（发布评测 `eval:live`、用户旅程、P0）在电脑上直接跑任务核心，用的循环不是扩展里实际运行的那套；用户旅程与 P0 还经扩展里带口令的调试通道连入（脚本先让扩展内 agent 建不起来），`eval:live` 直接调扩展执行器。原语音 v23 检查依赖 Jev 播报闸门，已随 Jev 删除；要改成在扩展里测，完成后删除该循环与调试通道。见[退役验收](evals/20261001-retire-native-and-dead-code.md)。
- 提交安全候选见[验收](evals/20261003-security-confirmation.md)：网页激活逐次批准，脚本模型真实入口通过；合并状态见PR，日常未发布。
- 扩展里不再提供（10-01 起不列给模型，原本也用不了）：上传本机文件、请帮手并行、富文本粘贴；是否在扩展里做出来待用户定。DeepSeek 在字幕练习站找不到页面内嵌数据指向的接口，两次都放弃（[数据存文件](evals/20261001-data-to-file.md)）。
- CAP-02 的 filechooser 停止清理、疑似重复测试未处理；见[清理记录](evals/20260923-repo-cleanup.md)。
- 长任务、技能复用与旧票组不因新专项通过自动关闭；见[产品复核](evals/20260919-product-review-repair.md)。

## 下一步

62题两配置复测完成，环境单列；见[测量规则](../eval/README.md)。比较见[复测验收](evals/20261002-tiers12-after-fixes.md)。

本轮进展：

1. 自检（#28）：GLM、M3.1 定点各5/5；M3.1 文件转义失败已修复并复测，日常已加载。见[验收](evals/20261002-answer-selfcheck.md)。
2. PDF 下载（#25）：两模型的原 arXiv 请求通过，日常 Chrome 可见实录为2步、8秒；见[验收与录像](evals/20261002-pdf-download.md)。
3. #32环境分类已在独占条件下完整通过；#35共124次运行与判分完成。M3.1正常任务52/55，GLM50/56；环境分别7、6次。见[环境验收](evals/20261002-eval-environment.md)与[复测验收](evals/20261002-tiers12-after-fixes.md)。
4. Pi会话/文件恢复与40px截图卡已部署，关键验收通过。见[验收与录像](evals/20261002-session-durability.md)。会话菜单已部署（[验收](evals/20261003-conversation-menu.md)）。MiniMax记忆分类与备注提交检查通过，日常已加载；见[分类](evals/20261003-memory-classification.md)与[执行](evals/20261003-method-form-enforcement.md)。备注补填、电话规则替换、撤销恢复备注的整条扩展路径通过，日常已加载；本轮使用脚本模型，在线MiniMax复测为下一步。见[验收](evals/20261003-memory-rule-replacement.md)。

UI旧提案仅供[追溯](research/20261002-uiux-memory.md)。

Issue：#27、#40和#23原生路径已部署，#23备用待验。见[部署](evals/20261003-issue-fixes-deployment.md)。

进展见 [Linear](development/checks.md#给用户看的进展linear)。

日常扩展：主模型 MiniMax-M3.1-Flash-Preview、快速模型 GLM-5.3-flash（10-02配置，未改）。待真人试：M3.1 回答逐字出现、设置里选 M3.1、打开生成的 HTML、要截图。

## 历史

本页 10-01 整理前的原文见[快照](history/20261001-status-before-cleanup.txt)；09-23 及更早的专项见[较早结论](status-earlier.md)；其余旧顺序与原件见[历史索引](history/README.md)。历史只用于追溯，不作为当前指令。
