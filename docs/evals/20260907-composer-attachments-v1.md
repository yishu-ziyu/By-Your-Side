# 任务: Composer 附件瓷贴（方案 A）与多模态图片闭环落地

来源：2026-09-07 用户选定方案 A（复合上下文分层流 Context Ribbon），并明确讨论产品底层功能缺口：SideAgent 原有架构中缺少用户主动截屏与文件投喂能力。本期打通「用户主动截屏 / 粘贴剪贴板图片 / 本地选图 → 56px 瓷贴微动效 → 协议传递 → Pi SDK 多模态投喂」完整闭环。

```
Change:     1. 协议层（shared/protocol.ts）：新增 Attachment 契约定义；ClientMessage (user_message / steer) 扩充 attachments 字段并完善校验与契约测试。
            2. 伴随进程（agent/src/session.ts & main.ts）：解析 attachments，将图像转换为 Pi SDK 原生 ImageContent[]，传入 session.prompt / session.steer，打通多模态投喂。
            3. 后台服务（extension/src/background/index.ts）：监听 sidepanel_capture_tab 内部消息，基于 chrome.tabs.captureVisibleTab 实现当前活动页安全捕获。
            4. 侧栏界面（extension/src/sidepanel/）：
               - 落地方案 A 布局：保留顶部 PagePill（活动页锚点）与 ask-cite，下方紧随 #attachments-strip；
               - 1:1 复刻 Board UI 动效：56px Squircle 瓷贴、顺时针 SVG Accent Ring 描边、9px 百分比数字、100% 原位 Blur Cross-Fade 关闭 ✕；
               - 交互源支持：左下角 "+" 呼出动作菜单（📸 截取当前网页、📁 上传本地图片）、输入框 Cmd+V 粘贴图片、文件拖拽；
               - 消息渲染：用户消息气泡展示已发送附件缩略图。
Not this:   本期不做复杂跨域框选截图（保持一键截取 Viewport）；暂不处理复杂多页 PDF/Excel 的服务端文本解析（第一期聚焦高频图片多模态）。
Evaluator:  机器：npm run typecheck、npm test（协议与 session 多模态单测全绿）、npm run build。
            人评：侧栏截图当前页、粘贴图片、观察 56px 瓷贴动效、发送后 Agent 正常响应。
Evidence:   本卡 + docs/NOTES.md + 单元测试覆盖。
```

## 完成标准

- [x] 1. 协议定义与单测：`shared/protocol.ts` 扩充 `Attachment` 定义与 `user_message.attachments` 校验；针对合法/非法附件的契约测试全绿 — 谁检查: `npm test`
- [x] 2. 伴随进程多模态对接：`agent/src/session.ts` 将图像附件转化为 `ImageContent[]` 并传递给 Pi SDK `session.prompt` 与 `session.steer`；单测全绿 — 谁检查: `npm test`
- [x] 3. Background 截图链路：实现 `sidepanel_capture_tab` 消息处理，安全截取当前活动标签页并返回 DataURL — 谁检查: `npm run typecheck`
- [x] 4. SidePanel 方案 A 视觉与动效：落地 56px 瓷贴容器，实现顺时针 Ring 描边与 9px 数字/关闭 ✕ 的原位 Blur Cross-Fade — 谁检查: 人 & 机器构建
- [x] 5. 输入动作源：支持 `+` 菜单截图与选图、`Cmd+V` 粘贴图片、拖拽图片自动入场 — 谁检查: 人
- [x] 6. 发送与清空：点击发送后附件随消息上屏并清空瓷贴栏，伴随进程无异常，代码构建通过 — 谁检查: `npm run build`

## 边界与不做

- 保持第一期聚焦图片多模态闭环，不引入重型 PDF 文本提取依赖；
- 不改变底层 CDP 调试器已有的安全策略。
