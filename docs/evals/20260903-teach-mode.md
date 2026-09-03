# 任务: 教学模式——Agent 不直接操作，画箭头/圈一步步教用户点

来源：docs/ROADMAP.md「看得见」层第 2 项（2026-09-03 继续推路线图）。

## 验收标准
- [ ] 1. sidepanel 顶栏有教学模式开关，状态持久化（chrome.storage.local），面板重开后显示正确 — evaluator: 人评 + 无头截图
- [ ] 2. 教学模式下 click/fill/type_text/press_key/js 被扩展执行层硬拒，返回明确错误；snapshot/screenshot/scroll/mark/clear_marks 不受影响 — evaluator: npm test（isBlockedInTeachMode 单测）
- [ ] 3. set_mode 协议帧解析正确，panel→background→agent 全链路透传；agent 重连后 background 补发当前模式 — evaluator: npm test（protocol 解析测试）
- [ ] 4. agent 收到 set_mode 后系统 prompt 追加教学段落（禁操作工具、改用带步骤序号的 mark 引导、每步说清"点哪里/为什么"）— evaluator: npm test + 人评实际对话
- [ ] 5. 教学模式视觉复用 mark 标注层（描边框+箭头+步骤文字 pill），文档坐标滚动不漂移 — evaluator: 无头截图自检 + 人评
- [ ] 6. typecheck / build / 全部测试绿 — evaluator: npm run typecheck && npm run build && npm test

## 边界与不做
- 不做轨迹回放、不做并行 session 编排（路线图后续项）
- 不做单个 mark 的删除/步骤回退（clear_marks 全清已够）
- scroll 不拦截（教学需滚动定位）；js 一律拦截（可绕过一切）
- 教学模式是软引导（prompt）+ 硬闸门（执行层）双层；不保证模型不产生操作意图，只保证操作不落页面
