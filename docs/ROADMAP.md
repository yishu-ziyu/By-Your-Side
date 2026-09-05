# SideAgent 路线图

来源：2026-09-03 讨论（虚拟鼠标上线后的头脑风暴）。

## 看得见（overlay 层）
- [x] 操作前高亮：click/fill 前用呼吸框圈住目标元素 ~0.5s，确认"找对地方"（2026-09-03 已完成，复用 cursor overlay）
- [x] 教学模式：Agent 不直接操作，画箭头/圈一步步教用户点（2026-09-03 已完成：顶栏开关 + set_mode 协议 + 执行层硬闸门 + prompt 教学段，步骤标注复用 mark）
- [ ] 操作轨迹回放：任务结束后用户说「回放」，光标按浅弧在页上再飞刚才点过的位置。不是回退。人评未过（标准：`docs/evals/20260904-trace-replay.md`）
- [x] 圈画标注收编：mark/clear_marks 工具（2026-09-03 文档坐标锚定；2026-09-04 补内部滚动容器 scroll 捕获期重锚，卡：`docs/evals/20260904-mark-nested-scroll.md`）

## 人机协作（高交互性）
- [x] 插话 steer：运行中发消息自动转 steer（2026-09-03 已有，本轮补 UX 提示）
- [x] 危险操作确认（对话层）：2026-09-04 人评过——flomo「把这个笔记删掉」，Agent 列出对象+后果后停住等「确认」（标准：`docs/evals/20260904-dangerous-confirm.md`）。含糊回复/普通填入未测。不拦所有 click。
- [ ] 就地确认：要点删除 / 清空 / 支付 / 发送时先不真点，框外「删除 / 取消」；点删除或侧栏「确认」才执行。人评未过（标准：`docs/evals/20260904-on-page-confirm.md`）
- [ ] 接管/交接：按 B——运行中随时拿过来，它停手旁观；还回去读当前页接着干，不重来。2026-09-04 开始单 Agent、单标签页 v1（标准：`docs/evals/20260904-takeover-handoff-v1.md`；完整目标：`docs/evals/20260904-takeover-handoff.md`）
- [ ] 选中即问：右键/划词调起 Agent，带页面上下文问答
- [x] 多任务并行：Lead + 邮箱 + 工人各绑标签页；光标按 session 着色。2026-09-04 人评过：B 站抓视频评论 ∥ Formal 笔记写入，两页同时干活（标准：`docs/evals/20260904-parallel-workers.md`；原维基+飞书场景未再跑，同构任务替代）

## 面板与模型
- [x] 模型选择 UI（2026-09-03 已完成：status-pill 内模型名点开下拉，按 provider 分组、只列有凭据的，热切换不丢上下文，选择写回 ~/.sideagent/config.json；默认模型改 minimax-cn/MiniMax-M3）

## 自动化升级
- [ ] 技能录制：成功任务的操作序列存为确定性回放脚本，同类任务不调模型
- [ ] 页面哨兵：MutationObserver 盯页面区域，变化即通知（降价/放票）
- [ ] 多标签编排：background 管多 tab，sidepanel 分线程展示
