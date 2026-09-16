# 任务：定位并行助手的分工、身份、等待与交付呈现缺口

## 范围与完成标准

用户于本轮授权按“真实双助手任务 → 截图 → 数据链路 → 最小方案”诊断；未授权实施产品改动。

- [x] 记录助手出现、等待、交付三个实际时刻 — 检查者：主代理，真实生产面板截图与事件。
- [x] 展开实际界面核对身份、职责、等待关系 — 检查者：主代理，05/07 截图与 DOM。
- [x] 将可见问题对应到当前代码，并分清已有信息未呈现和缺少持久数据 — 检查者：主代理，下面的代码定位。
- [x] 提供基于原图的说明页与最小改动建议 — 检查者：主代理，在 Codex 浏览器打开并检查标注。
- [ ] 产品目标：不展开工具日志能说清为什么拆分、每人的职责、等谁及结果归处 — 本轮实测不满足，尚未修复。

## 证据与运行边界

[原图标注页](20260915-cast-diagnosis/index.html)；[关键原始事件](20260915-cast-diagnosis/evidence.json)。

2026-09-15，已加载的 ChromeMain 扩展，侧栏生产 HTML 在后台标签页打开，通过文本输入 → 扩展 Port → native host → DeepSeek V4.1 Flash (Go) → 实际网页工具执行。面板视口设为 450×1050 CSS 像素，不是停靠侧栏的整窗截图。未重载扩展，未构建或修改产品源代码，当前 checkout 原有未提交改动保留。本次只读取临时本地素材，没有写入外部网站。

任务明确要求两位助手各读一份社区项目方案，然后主助手汇总；因此验证的是“指定并行”，不是模型自主拆分的可靠性。输入原文见 evidence.json。工具与事件未经模拟；截图原文件未修改，HTML 红框只做视觉标注。

会话 a30850ce-bfcb-4fdd-92a5-1b8a9c543bac。实际 worker 为 a-cbb6b6e5、b-d0df6c9f。运行界面显示耗时 57s，得到一份对比与建议。原图保留开始/等待和完成后展开状态；完成后补拍的展开图不冒充执行中的展开图。

未验：自主决定并行、原生停靠尺寸、网页光标、接管交还、语音、全部财务计算正确性。本轮页面操作以读取为主，没有捕获可辨认的角色网页光标，不能据此判断光标体验。未运行产品单测或构建，因为无产品改动。

此前派出的只读 DeepSeek 会话经路由核验为 opencode_go/deepseek-flash，360 秒到时未产生完整报告，不作为独立复核通过。用户随后要求本轮不再委派，后续诊断和收尾均由主代理完成。

## 实测问题及代码定位

### 1. 分工说明存在，但被隐藏为内部过程

模型普通文字原文：

> 我先把两份方案分开读，再汇总对比——两个页面内容各自独立，适合并行：一位助手读 /a，另一位读 /b，各自提炼目标、收支假设和三项风险，我来做横向比较和取舍建议。

它没有通过 send_user_message 的 ack 送出。用户必须先展开运行块，再展开“执行过程”才能读到。[截图](20260915-cast-diagnosis/07-reason-hidden.png)。

- agent/src/prompt.ts:25 规定只有 send_user_message 为用户消息；:30 要求派工前解释理由与分工，但没有把这一动作具体绑定到 ack。
- extension/src/sidepanel/main.ts:2505 在 explicit 模式将普通 text_delta 交给 appendLeadDelta。
- extension/src/sidepanel/main.ts:2233 创建默认关闭的第二层 details，标题“执行过程”。
- extension/src/sidepanel/main.ts:1857 主运行块默认关闭，这是既有收敛设计，不能用全部展开来回避信息分层。

结论：本例不是模型没有生成解释，而是解释走错了用户交付通道。其他运行是否相同未知。

### 2. 创建回执与执行身份不一致，而且两人撞名

[截图](20260915-cast-diagnosis/05-expanded.png)：回执“请了 Mike”“请了 Lalo”；两条执行行均为 Gus。

- extension/src/sidepanel/steps.ts:113 按 spawn 参数 id（a/b）计算角色名。
- agent/src/fleet.ts:279 实际 worker id 追加随机 UUID 后缀。
- extension/src/sidepanel/main.ts:1939、:1956 按真实 sessionId 计算执行行名字。
- shared/cast.ts:138 的 personFor 使用 hash(id) % CAST.length；没有同任务去重分配。实际两个随机编号均命中 Gus。
- extension/src/sidepanel/main.ts:2428 的工具结束逻辑只更新结果/时间/成功状态，不把创建 chip 的名字纠正为实际 worker 身份。

结论：一处按请求编号、一处按实际编号；散列稳定不等于实例之间唯一。不是仅仅措辞问题。

### 3. 本次职责有输入，但没有可展示的成员记录

spawn 的 goal 包含完整职责、URL 和交付要求，并经 agent/src/fleet.ts:314送入子会话。原始工具参数随事件抵达面板，可在工具详情中查看，但默认执行行只渲染名字和动作链。

- extension/src/sidepanel/main.ts:1939–1988 创建执行行，没有职责字段。
- extension/src/sidepanel/main.ts:2323 的工具详情用于原始参数和结果，不适合作为日常分工摘要。
- shared/protocol.ts:102 TeamMemberView 无 taskTitle/goalSummary/expectedOutput 字段；该类型本身服务控制态，不应未经设计直接扩为另一份日常任务状态。

结论：不是完全没有职责数据；缺少将长指令转为一行任务职责并和实际 worker 稳定绑定的路径。

### 4. 等待显示协议类别，未显示来源与所需结果

本轮主助手先两次 await done，再按 from=b-d0df6c9f 读取 notes。显示分别为等待「done」、等待「notes」。没有展示“等方案乙摘要”。

- extension/src/sidepanel/steps.ts:132 附近 await_message 分支只读取 params.kind，丢弃 from 的呈现。
- extension/src/sidepanel/main.ts:1929 setLaneWaiting 对 worker 使用固定角色 waitLine；该机制本轮没有作为主助手等待文案出现，不可把两者混为一项实测。
- 本例前两次等待未指定 from；不能靠格式化补出精确对象，需依靠已登记分工/实际未交付状态，或诚实显示“等待助手结果”。

结论：部分信息已有却没显示，部分等待调用本身没有明确来源。改文案不能补齐不存在的数据。

### 5. 团队卡片不是日常并行名册；统一交付已成立

本轮 team_status 数量为 0，team-card 为 hidden 空节点。必须修正此前将它描述为普通并行时必然可见的说法。

- shared/control.ts:999 TeamControl 默认 frozen=null，snapshotAndFreeze 进入控制快照。
- agent/src/fleet.ts:185 holdActiveGroup 用于接管冻结组。
- shared/control.ts:900 shouldShowTeamCard 只对非空且非 idle 的 TeamPhase 显示；TeamPhase 也没有普通 running。
- extension/src/sidepanel/main.ts:2039 renderTeamCard 是控制态渲染，不是常驻任务分工卡。

两位助手最终通过 post/自动 done 等现有通道交回内容，主助手用 send_user_message(kind=finding) 正式交付了比较和建议。[交付截图](20260915-cast-diagnosis/06-result.png)。不需要另造多个聊天线程；缺的是助手行与交付结果的清楚对应。

## 最小方案（尚未实施）

1. **稳定且不重复的身份**：在创建 worker 时确定一次实际身份，返回并随会话事件复用；请求创建阶段先显示中性“正在安排助手”，拿到实际身份后更新回执。同一次任务内避免角色重复，面板和光标同源。不要只按短 id 散列修回执，这会掩盖身份碰撞且无法解决重用。
2. **职责记录与分工交付**：复用现有 ack 交付一次出场理由；为 worker 增加简短的本次职责/预期产物元信息，并绑定实际 sessionId。保留完整 goal 作为执行输入，不把长 prompt 直接当 UI 文案。复用现有事件与历史机制，先确认最少字段，避免在控制快照、worker map、UI 各存一套可独立漂移的状态。
3. **摘要中可见，日志仍折叠**：复用当前运行块，在摘要层表达本次分工和真实状态；工具细节继续折叠。不要默认展开整棵运行日志，也不先增加常驻团队卡。
4. **真实等待与交付对应**：根据实际 from/kind 和职责映射展示等待关系；来源缺失时使用诚实的概括。用已存在的接收/完成事件给助手行收束状态，最终答案仍由主助手统一给出。

预计影响：agent prompt/fleet 的出场与身份元信息、共享事件契约及其历史回放、sidepanel steps/main 的摘要与状态；光标身份映射需随共享身份一起覆盖。保留 TeamControl 接管交还语义，不用控制状态承担普通工作进度。

后续实现验收：同类两方案任务中，不展开工具日志即可判断两份职责；创建回执、执行行、页面光标始终同名，二人不撞名；等候对象已知时显示真实对象与产物；结束后明确交给主助手并保留一份最终交付。边界覆盖：短任务不出现虚假成员；一人失败/停止不标成已交付；相同任务重跑和历史回放不换人；单人完成不使另一个运行中的助手消失。
