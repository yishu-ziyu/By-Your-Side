# Antigravity 执行任务：前端干扰夹具与独立验收入口

用户已授权Codex编排、你作为执行者。你当前cmux workspace:8 surface:9，Gemini 3.8 Flash Medium。工作目录 `/Users/mahaoxuan/Desktop/ego`。先核对实际路径/分支和AGENTS。

先读：
- `docs/evals/20260907-observation-click-integrity.md`（Codex派工前锁定，不能改变）
- `docs/research/20260907-browser-intelligence-source-comparison.md`
- 已有 `scripts/acceptance/discover.mjs`、`cdp.mjs`、`sw-hook.mjs` 与近两轮run脚本。特别注意UI事件常装在kind=history entries里，别重复旧采集脚本漏事件问题。

你负责前端夹具和自动验收脚本，利用你对DOM/CSS/浏览器交互的能力做真实可检查的条件，不做产品视觉改版。

## 唯一文件所有权

- 新建 `extension/test/fixtures/observation-integrity.html`（及该前缀必要辅助HTML）
- 新建 `scripts/acceptance/integrity-run.mjs`（可拆同前缀辅助脚本，但不要改既有公共helper）
- `docs/work/20260907-antigravity-fixture-report.md`

不修改任何产品src、shared、既有验收标准/路线图；不改OpenCode和Grok的文件。

## 要交付的真实条件

1. 两个明确不同的页面标识/配色，让工作页与活动页混淆能被检测。截图像素尺寸、CSS viewport、DPR都能独立读取核对。配合OpenCode截图分支，错误页必须拒绝；CDP失败可在验收边界注入，但不能另写截图实现冒充生产路径。
2. 长页上视口内/外有唯一标记，用来检查viewport快照是否真实过滤，而非只比较行数。
3. 计数按钮：点击一次计数加一；旁边放另一个计数目标，检测误点。
4. 用显式测试控件触发目标移动、覆盖和同名按钮条件。测试页可制造干扰，待测点击必须走生产工具链。不要用直接JS.click/赋值冒充模型或工具操作成功。
5. 如能复用已有入口，提供同会话任务A接管交还→任务B新页的场景支持；核心源码修复由Grok负责。不要新造另一套Agent。

脚本至少提供 --case=screenshot|viewport|click 等可独立跑的场景，保存JSON、截图、准确起点/耗时/实际状态和明确PASS/FAIL/BLOCKED。真实调用优先复用 `__saCall → uplink → executeToolCall → gate → handler`，不要平行重写snapshot/click。

可以读取两位执行者报告获取接口，但先自行准备不依赖结果的HTML和脚本结构。需要协议字段时在报告列出，Codex协调。

你不是独自工作，保留全部既有修改。不要派子代理，不安装框架，不切分支/建worktree，不提交/push，不运行全量测试/build/reload。
你可以先做语法与静态检查。暂不操作浏览器，等待Codex给“浏览器验收独占权”再运行；最终Codex独立复核。

## 必须回应

开始后先更新报告首段。准备好可运行脚本时或完成/阻塞时，先更新报告，再发送：

```sh
cmux send --workspace workspace:8 --surface surface:11 '[执行回报][Antigravity] READY_FOR_BROWSER或REVIEW_READY或BLOCKED；报告 docs/work/20260907-antigravity-fixture-report.md；简述已完成和需要事项。'
cmux send-key --workspace workspace:8 --surface surface:11 enter
```

把示例状态和摘要换成真实结果。不要声称未运行的实机通过，不请求用户重复授权。你的报告不是最终验收结论。
