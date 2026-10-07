# 当前状态

复核日期：2026-10-07。开发预览版，尚无发布通过结论。

会话恢复与菜单已部署（[部署](evals/20261003-session-deployment.md)）。本机模式已退役，产品仅为扩展（[退役验收](evals/20261001-retire-native-and-dead-code.md)）。10-04 删掉没人用的半成品与预判，模型工具 45→30 个（[删减验收](evals/20261004-cut-unused.md)，未进日常构建）。

## 现在能用什么、还差什么

| 能力 | 现在 | 还差 | 证据 |
|---|---|---|---|
| 侧栏会话与外观 | 任务卡、掀原文、AI 边注、投喂、反查、直连按钮、改方向已合并；隔离路径通过 | 新交互未重载；首开新建曾卡住，重开恢复 | [伴读](evals/20261005-killer-interactions.md) · [直连](evals/20261005-ghost-hud-and-steering.md) |
| 回答交付 | 正文直接交付，未完成项只标注；问答中位约 10 秒；目标核对移到回答后，不拖慢回答（10-04，未进日常） | 复制任务中位约 26 秒 | [开发日志](devlog/20260924-02-回答不再被核验扣下.md) · [没做完的一行](evals/20260925-unfinished-line-and-answer-reveal.md) |
| 读页 | 大页面读完不再被记为结果未知而锁住后续操作；网址中的密码类信息遮掉 | 原 MiMo 会话定位失败、「继续」不恢复，根因未确认 | [MDN 修复](evals/20260930-mdn-reading-recovery.md) · [MiMo 试用](evals/20260930-first-user-mimo.md) |
| 整页翻译 | 4 路并发，109 段约 70 秒；待翻段落先出占位，Kimi 限流时自动降速（用户试过：满意） | 说完后主模型先想约 8 秒，页面不动 | [提速](evals/20260926-translate-fast.md) · [占位](evals/20260927-translate-marks.md) |
| 即时动作（快速模型） | 解释约 2 秒出字；翻译、定位的意图预判已删（10-04） | 未达 2 秒，瓶颈是智谱首字 | [验收](evals/20260926-instant-2s.md) |
| 记忆与任务感 | 接回记忆与过往任务，跨轮续接；纠正后开口问「要我记住吗」，点「记住」后在该网站照做（DeepSeek、GLM 场景 1–10 全对）；GLM 只思考不回正文时当场放宽重试（记忆底座 1/6→6/6） | 已进日常构建（10-01），待真人试用；方法只作上下文（10-04）；其他方法执行和检索待加强（见下一步） | [纠正](evals/20261001-remember-corrections.md) · [加固](evals/20261001-memory-hardening.md) · [端到端](evals/20260926-e2e-before-daily-install.md) |
| 网页操作 | 点击、填写、回车直接执行，不弹卡（[10-04](evals/20261004-remove-approvals.md)）；圈画、下载完成/中断如实回报；取到的数据可直接存成侧栏文件、不经模型重打；原地打转连续 6 步无进展自己停下并说明（[数据存文件](evals/20261001-data-to-file.md)） | 失败时露出 Chrome 错误码；出错换快速模型，真故障未验 | [下载](evals/20260926-page-download.md) · [界面 10 项](evals/20260926-ux-fixes.md) · [扩展内核](evals/20260924-core-into-extension.md) |
| 侧栏视觉语言 | 10-06 统一重画，合并选定版 | #53 待手试 | [日志](devlog/20261006-02-侧栏统一视觉语言.md) · [选定版](evals/20261006-sidepanel-picks.md) |
| 语音 | 插话约 0.25 秒停声；StepFun 挂住约 22 秒发现并请用户重说 | StepFun 傍晚挂住率高；外放回声阈值未经真人 | [插话](evals/20260925-voice-barge-in.md) · [日常纯扩展](evals/20260925-pure-extension-daily.md) |
| 模型思考档与后台判断 | 后台判断（目标核对、记忆、语音）统一取模型允许的最低档，档位被拒换档、格式不对修复各重试一次，失败带原因；主任务从中档起、按失败/打转/没做完/用户纠正升档；阶跃登记为可看图。探针：M3.1 作主模型带工具跑通，目标核对 M3.1、GLM 9/9，阶跃可解析 0/9→9/9 | 已进日常构建（10-02）；扩展里选 M3.1 对话待真人（标准 9）；MiniMax-M3 目标核对正确率 4/9 | [验收](evals/20261001-model-effort-and-side-judgments.md) · [说明](model-effort.md) |
| 结果未知的边界 | 一步结果未知后，只拦点击、填写、按键、页面脚本、POST；读页、导航、开标签页、GET、关/确认弹窗照常；同一项只核验一次，查不清由任务宿主说明后停下；被覆盖/不可填记为没执行；点击遇原生弹窗立即返回 | 已进日常构建（10-02）；只读脚本超时仍记为结果未知；弹窗恢复修复在验收中 | [验收](evals/20261001-unknown-lock-scope.md) · [规则](unknown-results.md) |
| 文件与回答显示 | 模型直接写正文时回答逐字出现（首段比模型晚约 13 ms，真侧栏 + 脚本模型）；设置里能选能力表登记的模型（MiniMax-M3.1）；生成的文件可点「打开」在隔离查看页看（网页脚本可运行、碰不到扩展数据） | 已进日常构建（10-02）；三项都待真人试（见下一步） | [流式](evals/20261002-plain-text-streaming.md) · [打开文件](evals/20261002-open-artifact-in-browser.md) |
| 第一档产品缺口 | 截图以图片卡片给到用户；读页附上被截断名字的完整文字；时间/日期/数字框读出允许范围，填超范围会明说；网站连不上时说明一次就停（不再被目标核对催回去重试） | 已进日常构建（10-02）；124 次复测完成；截图、时间与 PDF 题两配置通过，商品全名和部分计数/CSV 仍失败（见下一步） | [截图与读页](evals/20261002-tier1-product-gaps.md) · [受阻](evals/20261002-goal-check-blocked.md) · [测量规则](../eval/README.md) |

## 仍需解决

- 改口后改写已有成功回执有缺口；[接管/交还](evals/20261005-takeover-handback.md)、[药丸](evals/20261005-edge-pill.md)、[淡出](evals/20261005-chrome-quiet.md)真路径过；#48、50–52、54 已快查余[待测](guides/usage.md)；[复测](evals/20260922-computer-use-product-path.md)。
- 扩展外跑任务核心的检查与调试通道已于 10-04 删除；`eval:live` 如实报 BLOCKED，需要在扩展里跑的真实模型评测（[删减验收](evals/20261004-cut-unused.md)）。
- 去掉批准卡后，网页注入可让助手在已登录网站上动手（[说明](browser-confirmation.md)），防护待定。
- 上传本机文件、请帮手并行、富文本粘贴的代码已于 10-04 删除，要做应另起。DeepSeek 在字幕站找不到内嵌数据的接口，两次放弃（[数据存文件](evals/20261001-data-to-file.md)）。
- CAP-02 的 filechooser 停止清理、疑似重复测试未处理；见[清理记录](evals/20260923-repo-cleanup.md)。
- 长任务与旧票组不因新专项通过自动关闭；见[产品复核](evals/20260919-product-review-repair.md)。

## 下一步

62 题两配置复测完成（[复测验收](evals/20261002-tiers12-after-fixes.md)）。

本轮进展：

1. 记忆与重启（10-07，#89–#98）：没说「记住」的改口也更新旧值；同一件事 3 个对话做过就弹卡问；后台重启后安全的任务自动续做；首次配好后的第一句不丢。合并前跑 `npm run smoke`（真实模型约 1 分钟）。
1. 记忆露出来、圈给它看（10-07，YIS-83/84 已关）：回执写新旧值可撤销；回答下面点名用了哪条；按记忆填的格子标「记得的」；「圈出来问」可连圈、带圈内文字，回答里的 ①② 能点回原处。第一句「记住…」偶尔卡住已修（YIS-92）。
1. 提速（10-07）：会动手的日常任务 98% 时间在等模型（[时间拆分](evals/20261007-time-breakdown.md)）；多页调研中位 34→10 秒（[验收](evals/20261007-navigate-returns-page.md)）。「走老路」（YIS-91）：能记下做法照着走，再订会议室 12 秒（[验收](evals/20261007-route-replay.md)）。
2. PDF 下载（#25）：两模型的原 arXiv 请求通过，日常 Chrome 可见实录为 2 步、8 秒（[验收与录像](evals/20261002-pdf-download.md)）。
3. #32 环境分类独占通过；#35 共 124 次运行判分完成（[环境验收](evals/20261002-eval-environment.md)）。
4. 会话/文件恢复、40px 截图卡（[验收](evals/20261002-session-durability.md)）、会话菜单（[验收](evals/20261003-conversation-menu.md)）、MiniMax 记忆分类与备注提交（[分类](evals/20261003-memory-classification.md)、[执行](evals/20261003-method-form-enforcement.md)）、备注补填与撤销（[验收](evals/20261003-memory-rule-replacement.md)，下一步用在线 MiniMax 复测）均已部署。

进展见 [Linear](development/checks.md#给用户看的进展linear)。

默认测试模型 gpt-6-luna（10-06）。

## 历史

10-01 整理前的原文见[快照](history/20261001-status-before-cleanup.txt)；09-23 及更早的专项见[较早结论](status-earlier.md)；其余旧顺序与原件见[历史索引](history/README.md)。历史只用于追溯，不作当前指令。
