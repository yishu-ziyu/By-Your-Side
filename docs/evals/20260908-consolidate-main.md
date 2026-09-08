# 任务：保留已选择成果，只留下同步的 main 与 feat/session-management

## 完成标准
- [x] 除 .omo/.statamcp/.video_agent 本地工具记录外，清单中的产品改动和研究文档全部保留；不删除这些本地目录。
- [x] 手绘默认样式读取当前成员所属会话模式，而不是 default 模式。— 针对性测试/浏览器
- [x] 断线发送保护合入现有多会话：发送失败保留输入和引用，未送达可重试；另一会话的失败回执不得污染当前会话。— 针对性测试/浏览器
- [x] 类型检查、构建、针对改动的测试通过，不跑无关全量测试。
- [x] main 与 feat/session-management 本地和远端指向同一提交，三个旧fix分支的成果可追溯后删除本地及远端旧分支。


## 结果

- 原有排版、全部选中研究文档已保存；issue4通过真实合并保留历史，并适配多会话和附件。手绘读取所属会话模式已修复。
- 类型检查、构建、4文件30项针对性测试通过。真实Chrome8项通过（2项生产mark路径，6项生产侧栏+Port故障注入），证据 `/tmp/sideagent-consolidation-browser/result.json`。后台路由另由生产controller测试。未跑全量测试。
- 三个旧fix分支的本地/远端提交均经祖先检查确认已包含在main后删除；main与feat/session-management均已推送到相同版本。
- .omo/.statamcp/.video_agent留在本地并加入忽略规则，没有提交内容。工作区无其他未提交成果。
