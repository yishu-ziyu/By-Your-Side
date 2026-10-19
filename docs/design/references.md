# 原件清单

[文档导航](../README.md) · [口味记录](taste.md)

改侧栏或网页上的样子之前，先在这里按“用户看到的地方”挑一个原件，提案把原件截图放在旁边。这里没有合适的，先去用户的[设计笔记](file:///Users/mahaoxuan/Desktop/AI工作资料/Design%20note/living/INDEX.md)找，找到后补进本页。

为什么要有这一页：10-19 两轮界面提案，方向用户认可，但样子凭感觉画，被判为“丑”“很 normal”。好看的样子已经有人做出来并开源了，先照着学再微调，比自己从零画可靠。

| 用户看到的地方 | 原件 | 学它什么 | 能不能搬代码 |
|---|---|---|---|
| 对话流、输入框、空会话 | [assistant-ui](https://www.assistant-ui.com/) | 一句问候加居中输入框，消息、工具调用、附件的层次 | MIT，可以 |
| 会话菜单、回答动作、@ 标签页、/ 技能 | [cmdk](https://github.com/dip/cmdk) | 一个输入框筛选所有动作，键盘上下选，分组标题 | MIT，可以 |
| 回答卡片、表单卡、确认卡 | [shadcn/ui Card](https://ui.shadcn.com/docs/components/card) | 标题、说明、内容、底部动作四层，按钮一个实心一个描边 | MIT，可以 |
| 字号、颜色、间距的整套档位 | [Vercel Geist](https://vercel.com/geist/introduction) | 少量字号档位、高对比灰阶、每种颜色有固定用途 | 看做法，不搬代码 |
| 执行反馈、完成提示、页角胶囊 | [Sonner](https://sonner.emilkowal.ski/) | 进出方向一致、叠放、悬停展开，默认值就好看 | MIT，可以 |
| 记忆抽屉、阅读外观这类从下面拉出的面板 | [Vaul](https://vaul.emilkowal.ski/) | 拖动有阻尼、快速一甩就关、背景跟着缩 | MIT，可以 |
| 侧栏导航、当前项指示 | 设计笔记 `living/spine` | 父项弹簧展开，选中光点滑动 | 用户自己的样本 |
| 批量核对、先选后操作的列表 | 设计笔记 `living/triage` | 勾选后批量操作条浮现，键盘 j/k/x | 用户自己的样本 |
| 网页上圈出一块讲解 | 设计笔记 `living/lasso` | 圆角框圈住一块，其余变淡，镜头平移过去 | 用户自己的样本 |
| 菜单动效、拖动手感 | 设计笔记 `living/skill-samples` | Apple 面板已经过用户确认；菜单动效改前改后对照 | 用户自己的样本 |

动效和细节的判断先读用户设计技能（`~/Desktop/AI工作资料/Design note/skills/INDEX.md`）里的 emil-design-eng 与 web-frontend-style：进出动画、按下有反馈、图标用开源图标库不用 emoji、白为主黑蓝为辅。
