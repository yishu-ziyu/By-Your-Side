# 从业务捷径改为通用浏览器决策循环

## 方向与依据

用户认可 Realtime 3 / Jev / 强推理模型分工，但明确反对继续围绕翻译等少数演示领域添加硬编码。上一版“先做几个简单操作直达”的实施方案过窄，现作为被替代的提案，不据此开工。用户要求当前主代理亲自研究，不派子任务。

本轮只读官方文档与开源实现，未安装外部项目、未执行其程序、未跑新增付费比较、未修改产品行为。下面是待实施方案，不把文档作为扩大操作权限的授权。

## 查阅事实（2026-09-20）

- [StepFun 实时开发指南](https://platform.stepfun.com/docs/zh/guides/developer/realtime.md)与[事件 API](https://platform.stepfun.com/docs/zh/api-reference/realtime/chat.md)：session.tools 支持参数 schema 的自定义函数；arguments.done 与 response.done.output 示例均携带函数调用；function_call_output 用 call_id 对应，再用 response.create 续答。最长会话 30 分钟；取消语音响应不是取消网页任务。指南列出 web_search/retrieval，但事件 API 的 tools.type 列表未完整列出 web_search，因此具体 preview 版本支持情况需真实探针确认，不能盲抄。
- 当前产品只暴露 browser_request/read_page/task_status，前者不带结构化操作参数，把用户原话交给旧任务路线。已有函数返回回路，但尚未构成通用浏览器逐步决策接入。response.done 目前未统一接收其 output 中的工具调用，接入扩展时需以实际事件轨迹检验、补幂等，而非直接断言过去故障由此导致。
- [Browser Use Jev Ultrafast](https://github.com/browser-use/jev-ultrafast)：读 README 及 agent.py/model.py/snapshot.js；观察后动态构建元素表、操作和兼容目标候选，一次 Jev 请求同时问动作及各动作的候选目标，只执行选中分支。文字由独立生成模型提供；每步重新观察、检查过期引用、记录实际动作、防止无进展循环。主循环 DONE 是模型声明，README 明确要求独立结果验证。README 自述存在 iframe/shadow DOM/canvas/上传/弹窗标签等未覆盖边界，不把其演示速度视为产品实测。
- [Jev Browser Use](https://github.com/wy-coliney/jev-browser-use)：Jev 负责连续导航与控件选择，Codex 负责文字、视觉和核验；可保留进度交接，不要求每次点击都回强模型。
- [TypeSafe Computer Use](https://github.com/awlevin/typesafe-computer-use)：OCR + 系统无障碍信息形成候选，Jev 选择，再由程序执行；视觉信息并非 Jev 原生看图。本轮借鉴观察组织方式，不扩大到桌面控制。
- [Jev Voice Browser](https://github.com/moritzkremb/jev-voice-browser)：一次请求并行多项语义判断可借鉴；固定网站表、搜索模板和半句话提前动作不直接搬入本产品。
- [Jev 已知限制](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)：计数、复杂间接推理、无关长上下文等需规避；概率不能替代权限或完成证据。

## 修订后的实施方案

1. 以“原始要求/约束 → 观察 → 从动态候选选择动作 → 执行 → 核验 → 新观察”作为跨网站通用循环，而不是为翻译/搜索/表单分别编写自然语言分支。
2. 复用现有浏览器执行、授权、任务身份与结果账本，先补观察与决策适配；页面元素引用、页面身份和要求版本必须绑定，换页、改口、取消使旧决定失效。
3. Realtime 3 管连续对话、目标交接与纠正；Jev 可持续承担有限候选下的逐步操作决策，不只几个显示开关；强模型负责开放式规划、自由内容、需要视觉理解的情况和复杂恢复，不必每步经由它。具体任务可由不同决策模型驱动同一执行接口，用等条件实验比较，不硬性每步串三种模型。
4. 代码定义通用动作及硬约束，不定义某网站固定选择器、预制业务答案或口令白名单。精确原文可以直接复制；开放文本才生成。结构化专业工具仍可用，但不是普通网页能力的替代品。
5. Realtime 适配检查工具参数、调用完成事件和去重、异步结果、停声/停任务分离、重连与会话续接；内置搜索/知识库按事实需求选择，不能把云端检索冒充当前登录网页观察，也不自动上传用户记忆。
6. 验收覆盖导航/检索、表单、筛选/设置、多页比较、动态页面与失败恢复，并保留未参与调试的网站和新任务组合。同一套实现跑全部任务，比较用户说完至有效动作、完整成功率、误操作/假完成、恢复与成本；不用 Jev 单次延迟或翻译专项速度代替通用体验。现阶段尚无通用循环实测结果。

## Cua 文章后的收敛

用户追加 [Cua 文章](https://x.com/trycua/status/2101437979180904640)并强调陌生任务验收。已读文章正文及其链接的 jev-use README：采用不可变候选、重新观察/弃权出口、截图身份绑定、独立结果检查；不采用其英文表单研究模型作为通用浏览器方案，不把专用准确率和不等边界耗时作产品承诺。感知、候选构建与升级判断本身也会错，不能把全部故障归模型。

细化为[通用浏览器方案与运作规范 v0.1](../evals/20260920-general-browser-contract.md)。熟悉任务只作回归；版本冻结后才揭晓留出任务，基于失败修改后原任务必须退出新鲜留出集。用户要求的顺序为先确定方案/规范，再实施；本轮不改产品运行。
