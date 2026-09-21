# EGO lite / Jev 与现有浏览器流程对齐

用户补充：原浏览器控制参考 EGO lite，要求继续使用这些已有资料，不按翻译、表单等业务堆专用捷径。本轮亲自核对来源与关键代码，未安装外部项目、未运行其浏览器脚本、未切换日常宿主。

## 来源与事实边界

- 官方 [citrolabs/ego-lite](https://github.com/citrolabs/ego-lite)：本轮看到 main 为 dca70033，最近合并为 09-17 文档更新；公开最新 release v2.0.0 为 09-10。公开博客、主分支路径和仓库 issue/PR 搜索暂未找到官方内置 Jev 的明确记录。不能据此断言官方没有任何社交文章，也不能把社区集成冒称官方已实现。
- 官方 [snapshot requirements](https://github.com/citrolabs/ego-lite/blob/main/docs/native-snapshot-ref-requirement.md)：压缩无意义容器但保留兄弟分组、顺序、语义对象、frame 边界；ref 与 renderer-local backendNodeId/frameId 区分；稳定 locator 必须唯一且仍指向原节点。该文明确部分目标为要求/延期事项，不能全当作已发布能力。
- 社区 [romaluev/jev-ego](https://github.com/romaluev/jev-ego)：读 README、src/agent.ts、src/browser.ts、src/browser-side/guard.ts。把 Browser Use Jev Ultrafast 的动态元素表与动作选择搬到 ego-browser 的持续 Node 进程/TaskSpace 中，按需调用文字生成，并保留历史和有界退出。其上传、frame、canvas 等仍交原 ego-browser 路径，非万能替代。
- 社区 [jiangkoumo/ego-jev](https://github.com/jiangkoumo/ego-jev)：读 README 及 scripts/ego-jev.mjs 的观察/文字生成/执行入口。视口内索引表包含 role、名称、值、勾选态、原生下拉选项/值和路径；一次请求并行问动作及各兼容目标，按需生成文字，显式回填已完成动作。其约 2 倍提速来自两个任务各三对、高方差，且对照每步重建进程；不能搬成我们的性能预期。
- 官方 [ego-browser-benchmark-framework](https://github.com/citrolabs/ego-browser-benchmark-framework)已发现，可进一步评估作为独立任务/公平比较的来源。本轮不提前查看具体任务内容，不把官网演示题直接充当陌生留出集。

本轮下载证据在 `/tmp/bys-ego-research/`，仅用于源码阅读；可长期续接的来源以上述 URL 与这里记录的边界为准。

## 与我们的代码逐项对应

| 参考机制 | 我们已有的基础 | 本轮应对齐的缺口 / 不照搬项 |
|---|---|---|
| 持续进程、持续浏览器连接，在程序内完成连续动作 | Native Node + Chrome 扩展本来常驻；browser_run 在一个程序中可连续调用 | 不把别人的“省掉每步起进程”算成我们的新增收益；重点减少不必要的模型往返和重复浏览器读取 |
| 有层级、来源明确的快照和 ref | axtree.ts 已按 ego-browser 格式输出；CDP backendNodeId、任务页面绑定和现有动作工具已在用 | 新 Jev 表需要保留所属表单/弹窗/行等关联范围，区分正文截断与控件缺失，不能拍平后比较全页控件 |
| 动态、动作兼容的目标列表 | browserCandidates + browser-decision-model 已有动作分组与并行目标问题 | 补只读/可选值/缺材料后续接；不添加某网站的词表、固定选择器路线或业务口令 |
| TYPE_TEXT 被选中才获取字段文字 | 当前先由主模型提供 materials，再供 Jev 选择 | 应能在循环中按需请求文字/原文材料后接回同任务，避免必须由主模型先组织整套操作 |
| 操作前核对真实对象，操作后重读，独立检查最终目标 | 现有工具权限、接管、任务结果账本与实际 CDP 输入 | 部分社区项目用页面脚本 dispatchEvent 模拟点击以减少往返，不能直接绕开我们已有点击授权、真实输入与回执。可以合并只读采集，不直接移植其写入路径 |
| Jev 判断，程序记录进度与退出 | 新 loop 有动作回执、预算和 needs_verification | 保留明确的目标/已执行/未完成要求及原因，不能让 done、URL 部分匹配或高置信度单独证明完整任务完成 |

## 采用结论

页面与候选组织主要对照 Browser Use Jev Ultrafast 及上述 ego 版本；对象/动作身份与核验对照 Cua；接入方式必须保留我们已有的 Chrome 扩展/Native 执行和授权，不需要切到 EGO 应用或另安装一个宿主。

沿[具体卡点](../evals/20260920-general-browser-blockers.md)修正共同路径：不是让强模型偶尔调用一个 Jev 工具，而是让通用循环能持续处理动作、按需请求生成/推理帮助，并回到原任务。六类跨领域能力和冻结后陌生任务的要求保持，参考项目的演示与计时不能代替本产品实测。
