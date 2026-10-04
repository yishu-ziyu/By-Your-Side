# 浏览器 Agent 接口调研：对照 Playwright、agent-browser、EGO Lite、Chrome DevTools MCP

来源：用户 10-04 提供的调研材料（资料访问日 2026-10-04）。本文只做摘要与对照本项目，不代表已实现；未运行文中工具，厂商宣传与源码可核实的内容分开标注。

## 结论

- 没有公开评测在同模型、同任务、同权限、同登录状态下比较这些方案，“总冠军”无法确认。
- 工具数量与任务质量没有单调关系。决定质量的是一条链：观察 → 目标身份 → 动作 → 执行回执 → 效果核验。
- 暂无证据要求换掉 Chrome 扩展：`chrome.debugger` 已能用 Accessibility、DOM、DOMSnapshot、Input、Network、Page、Runtime、Target 等 CDP 域（[Chrome debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)）。
- 分工参考：动作执行语义看 Playwright；模型可见接口压缩看 agent-browser；人机共用浏览器与回执看 EGO Lite v2；底层最贴近的实现参考是 Chrome DevTools MCP。

## 分层

用户目标 → Agent 决策循环 → 模型可见工具（MCP/CLI/Skill/本项目工具协议）→ 执行层（定位、等待、引用、回执、恢复）→ 浏览器底层（CDP、扩展 API）。MCP 是工具描述协议，CDP 是底层控制协议，Playwright 是自动化抽象，三者不在同一层。本项目扩展同时承担执行层与产品安全层。

## 各方案可借之处（版本截至 10-04）

| 对象 | 值得学 | 局限 | 证据 |
|---|---|---|---|
| Playwright 1.63 / MCP 0.0.83 | Locator 每次动作重新解析；click 前检查可见、稳定、可接收事件、可用（[actionability](https://playwright.dev/docs/actionability)）；先挂下载事件再点击；扩展模式可接用户现有 Chrome | MCP 的 ref 只在当次快照有效；运行时不能直接塞进 MV3 | 强 |
| agent-browser 0.38.1 | delta 快照、画面不变不重发截图、`--pin-tab` 目标消失即报 `tab_gone` 不换页 | batch 默认出错继续；公开 [#1922](https://github.com/vercel-labs/agent-browser/issues/1922)：导航后旧 ref 点击未发生却报成功（未复现） | 源码强，任务成功率证据弱 |
| EGO Lite v2.0.0 | ref/文档身份账本；只在输入发出前重试，发出与否不确定就不重做（[#364](https://github.com/citrolabs/ego-lite/pull/364)）；结构化回执；用户/Agent 归属与交接 | 浏览器本体与 Snapshot 生成闭源；“最强 Snapshot”“2.5× 更快”为厂商自测 | 接入层强，核心 Snapshot 不可审计 |
| Chrome DevTools MCP 1.10.1 | `fill_form` 中途遇弹窗即停并说明后续字段未填；网络、console、性能诊断 | “Successfully clicked”只证明操作层 | 强 |
| Browser Use 0.13.10 | 完整 Agent 循环、DOM+AX+视觉、打转检测 | 每步最多 5 个动作；公开 bug 曾把找不到元素包装成非错误，后续动作继续执行 | 源码强 |

## 与本项目对照

已有（不必重做）：
- 三态执行回执（已执行／未执行／结果未知），结果未知不自动重试，见[结果不确定边界](../unknown-results.md)。
- `browser_run` 组合已有工具，每个子动作仍逐次确认，见[浏览器逐次确认](../browser-confirmation.md)。需持续审计：任何能绕开逐次确认、直接在页面执行副作用脚本的入口。#22 实验已证明“开启副作用拒绝”不等于只读（[实验](20261003-readonly-js.md)）。

差距（候选，未立项）：
1. **目标身份与生命周期**：元素引用、确认卡都应绑定标签页、frame、文档版本、节点与任务 run；变化即失效，跨导航不偷偷换目标。本项目实例：10-04 发现续接读页确认绑定旧 runId，批准与 run 切换赛跑（[验收](../evals/20261004-shared-approval-plan.md)）。
2. **效果核验**：区分“动作已派发”“浏览器已执行”“观察到的效果”（导航、弹窗、下载、网络请求、DOM 变化）与“用户要的结果成立”；非幂等动作核验“恰好一次”。
3. **批处理观察屏障**：读取、独立字段填写可连续；导航、提交、发送、删除、付款、下载、结果未知之后必须停下重新观察；取消时逐项报告前缀动作的执行状态。
4. **观察压缩**：delta 快照需带基准版本，不确定时退回完整快照；canvas、地图、富文本等保留截图路径。

## 可推翻的对照实验（候选）

在同一扩展、同一执行器上比较：A 当前实现；B 加目标身份与可操作检查；C 再加效果核验与观察屏障（另可加“激进批处理”组检验屏障是否过保守）。固定模型、提示、思考档、Chrome 版本、权限、账号、视口、初始状态。

五类任务：跨 iframe 读取并保存 20 条；React 表单填写中重渲染；6 个字段中途弹窗后提交；导出并核对下载内容；创建记录时服务器故意延迟到超时（服务器计数，理想为恰好 1 次）。

记录最终成功、严重副作用、错误目标、重复写入、结果未知及其安全恢复、耗时 P50/P95、模型轮次、token、快照大小、确认次数。每组每任务至少 30 次、打乱顺序、配对比较给置信区间，判定用服务器与网络记录等确定性证据（参考 [WebArena-Verified](https://github.com/ServiceNow/webarena-verified)），不让模型自评。

预先写下的推翻条件：B 在 DOM 频繁变化下没减少错目标/旧引用失败而成本明显上升，则不优先做身份账本；激进批处理在注入超时、取消、部分失败下仍零重复且省 ≥15% 耗时/token，则放宽屏障；delta 常漏关键变化导致频繁退回完整快照，则保持完整观察。

## 仍未知且会改变选择的事

EGO 闭源 Snapshot 改了 Chromium 什么；同一 Profile 下不同 Space 的存储隔离程度；各方案在同一真实登录 Chrome 与同模型下的成功率；复杂 iframe、closed Shadow DOM 上的实际失败率；不同压缩策略省多少 token、丢多少观察；用户同时操作同一 Chrome 时的标签页竞争。
