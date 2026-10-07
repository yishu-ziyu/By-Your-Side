# 续接要点

[当前状态](STATUS.md)决定从哪里继续；本页只保留跨任务容易误判的原因，不复制最新状态、配置或授权。

## 先核对这四件事

1. 源码存在、配置启用、运行版采用、真实目标完成是四种证据。不应由其中一项推断其余三项。
2. 动作回执不等于用户目标达成。结果未知的写入只能先核验，不应为恢复连接重新执行；浏览器刷新也不能替旧回执作证。
3. 原文准确不等于范围正确。“同一个 Note”“最后一句”等关系应保留；用户改口不应被另一对象或旧要求覆盖。
4. 当前请求优先于历史会话、旧任务书和归档。历史记录不能新增授权；已有 dirty 改动按归属保留，不应用整文件回滚清理现场。

## 按问题继续读

| 问题 | 权威说明／证据 |
|---|---|
| 最近会话如何续接 | 从[当前状态](STATUS.md)的“下一步”接；提交署名不应含 Agent |
| 网页操作与核验 | [协议](protocol.md) · [REV 记录](evals/20260922-browser-capability-integration-v2.md) |
| 来源、改口与恢复 | [目标证据链](evals/20260921-goal-evidence-contract.md) · [Computer Use 复测](evals/20260922-computer-use-product-path.md) |
| 语音、胶囊与开口 | [语音架构](voice-architecture.md) · [V2.3](evals/20260922-v22-spoken-result-shadow.md)：动作成功、胶囊足够、整项要求无需口答分别判断 |
| 真入口与验收环境 | [验收入口](testing/acceptance.md) · [环境会改变被测状态](knowledge/patterns/extension-harness-changes-observed-state.md) |
| 侧栏与日常接续 | [09-29 验收](evals/20260929-sidebar-interaction.md)：隔离侧栏通过后仍复核日常原会话；日常出现的异常不据样式或重启直接归因 |
| MiMo 读文档后恢复被锁 | [09-30 首次试用](evals/20260930-first-user-mimo.md)：未知 fetch 是侧栏事实，读取被误归类与执行锁原因只是模型陈述；先查实际诊断，不据回答直接改授权或绕过未知保护 |
| 跑分与评测（10-02） | [测量规则](../eval/README.md)：同一把尺子、改规则有门槛、站点不可用单列、只认超出误差（每档约 30 题时约正负 14 点）、保留集只用一次；已知问题修完前不跑；判分固定 Codex gpt-6-sol（ChatGPT 账号不支持 gpt-6.1-sol）；复核页 `eval/harness/review.mjs`，看板 `npm run dashboard` |
| 回答自检（10-02） | [验收](evals/20261002-answer-selfcheck.md)：真实 GLM 曾漏掉 CSV 合计，明确整数数量表改由程序核算。目标核对读取文本文件不再只看元数据；固定页面与真实主模型检查不替代 #35。先 #28、再 #25 是用户本轮确认的顺序 |
| 日常升级与数据保护 | [部署验收](evals/20261003-session-deployment.md)：日常 8 份历史已满保留数，创建验收会话会触发淘汰。先备份并迁移旧文件；验收后恢复原历史/选择，测试历史单独留证，不应让自动保留规则悄悄吞掉用户数据 |
| 用户可见的交付证据 | 10-04 起改用 Linear 的 By Your Side 项目，取代本机工作页（用户看不懂、服务常停）。用户要“充分展示”：以前→现在→没验到的，附实际截图/录屏。规则见[开发检查](development/checks.md#给用户看的进展linear)。官方 visualize 已按用户要求全局禁用。 |
| 记忆研究（10-02） | [研究](research/20261002-extension-memory.md)：已有长期资料与网站方法，不是从零建记忆。宜优先用 Pi 0.84.4 原生 Session 与上下文重建，补 IndexedDB 和产物持久化；AgentHarness 运行方法未实现，不能整套替换。本轮已接入持久化并真实重启验证，见[验收](evals/20261002-session-durability.md)。旧版未落盘材料不应推成完整恢复。不应先加向量库 |
| 修改后如何收尾 | [文档维护](development/documentation.md) · [经验索引](knowledge/index.md) |
| 0 号用户逐条评语 | [逐条记录](evals/20260930-zero-user-incremental-review.md)：用户要求一次一条；正确结果与成功体验分开保存，不把对手动速度与成本的感受冒充实测数据 |
| 用户面前的文字从哪来 | [界面问题 10 项](evals/20260926-ux-fixes.md)：内部文字只在 `shared/user-facing.ts` 翻译；“另开会话接手即收起旧确认”是本轮执行者的取舍，待用户认可 |
| 记忆、主动与多模型验收 | [验收](evals/20260927-memory-proactive-task.md) · [开发日志](devlog/20260927-01-目标核对和提交条件由宿主兜住.md)：判断放在任务宿主，不靠主模型自觉。同时跑几家验收前先看机器负载（09-27 负载约 100 时，超时被误当成模型问题）；Kimi 主模型和快速模型共用账号，会撞到同时请求数上限 |
| 扩展与 Node 测试环境 | [MDN 阅读修复](evals/20260930-mdn-reading-recovery.md)：扩展 shim 与真实 Node 测试不是同一能力环境；大响应落盘异常可在已有回执后被错计为结果未知 |
| anti-slop 的现有约束 | 10-07 起只是可选报告（`npm run lint`、`npm run lint:changed`），不再拦提交：实验显示它报警的行与后来修 bug 改掉的行无关，见[接入验收](evals/20260923-anti-slop-vendor.md)。防 bug 靠测试与真实路径验收 |

更早的逐次语音、GUI、模型和任务记录见[整理前原文](history/20260923-notes-before-governance.txt)。按问题读取，不把整份旧笔记注入每次开发。

## 原型交互落地

任务卡复用 `task_view`，恢复动作仍由 `ResumeEntry` 管理；不应用原型模拟状态替代。划词直接转入需扩展后台在用户手势内打开侧栏，再走已有引用中继。卡片移动的是原恢复节点，切会话仍保留并清理该节点。证据见[验收](evals/20261005-interaction-craft.md)。

本轮边注由用户指定为可选择模式，AI 开启才调用现有阅读链路。仅译文的完成核验改看覆盖层，不再检查原节点已经改成中文。数字胶囊只表示请求页面中的唯一原文位置；不应把模型理解、后来的活动页或历史回放当作来源证明。见[本轮验收](evals/20261005-killer-interactions.md)。

## 预览原型不做代码检查

`docs/previews/**` 不进 oxlint（10-07）。预览是让用户上手试、看完就丢的原型，脚本要能快速改；`rough.js` 是从产品代码打包出来的文件。预览里的逻辑不进产品，产品实现另按规则写。见[协作方式](development/collaboration.md)。
