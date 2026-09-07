# 任务：解释 BOSS 项目经历操作为何长时间未完成

## 完成标准
- [x] 定位与截图“项目经历”点击失败对应的后台日志片段。检查：原始日志与截图交叉核对。
- [x] 统计工具次数、错误、执行耗时，区分进程窗口和任务时长。检查：日志解析。
- [x] 用代码解释错误与停止机制，明确证据缺口。检查：只读源码探索。

## 证据

- 工具日志：`/Users/mahaoxuan/.sideagent/wrapper-err.log` 第 1736-1780 行。
- 生命周期：`/Users/mahaoxuan/.sideagent/agent.log` 第 431-434 行，北京时间 2026-09-07 18:50:59.495 启动、18:59:16.505 stdio 关闭。约 8 分 17 秒为进程窗口，不能等同精确任务时长。
- 45 次调用：30 js、6 snapshot、2 screenshot、2 scroll、4 click、1 switch_tab。耗时合计 7159ms。
- 第 1757、1761 行：`loc=h3...:has-text(...)` 无效选择器。
- 第 1766 行：`ref @10464 已失效，请重新 snapshot`。
- 第 1773 行：唯一未报错 click 耗时 5809ms。此后仍有 snapshot、screenshot、5 次 js，未记录 fill 或提交工具。
- 最后 stdio 关闭。日志未提供是谁触发关闭的证据。

## 机制与判断

1. 当前 `extension/src/content/domops.ts:18` 仅剥离 `loc=css:`，其余进入原生 querySelector。日志中的 loc 写法不被支持；`:has-text` 也非这里支持的原生 CSS 语法。
2. `extension/src/background/exec/evaluate.ts:18` 将 code 交给 Runtime.evaluate；没有 JS 异常即可返回 ok，值可能是 undefined。日志不保存 code/result，不能断言这 30 次实际返回空值，也不能断言 JS 完全没有修改页面。
3. `extension/src/background/exec/input.ts:606` 的 click 派发鼠标事件后返回 clicked，不验证项目编辑器是否出现。
4. `agent/src/prompt.ts:38` 用提示要求同动作失败两次换策略；`agent/src/session.ts:154` 没有配置基于业务进展的停止钩子。换用 js/snapshot 后仍能继续循环。
5. 45 次工具执行总耗时仅 7.16 秒，不支持把数分钟等待主要归因于浏览器工具本身。模型推理、请求网络、调用间隙的分摊无日志可证。

## 日志缺口

- `agent/src/session.ts:159` 使用 SessionManager.inMemory；模型完整轨迹不落盘。
- `agent/src/rpc.ts:84` 工具日志只含工具名、状态、耗时、错误，不含时间戳、参数、正常返回值、runId、模型轮次耗时。
- PanelHistory 为 service worker 内存，最多 5000 条；可能包含 params/resultText，但没有跨重启持久化。本轮未提取。
- 源码为调查时工作区版本，仓库有其他会话正在编辑；未证明与 18:50 启动进程加载版本逐字相同。

## 下一步建议

先保留可回放轨迹，再针对本次无效定位反馈和无进展恢复做小范围修复。验收应要求项目编辑入口真正打开；失败时有明确障碍和恢复动作，不能只以工具 ok 判成功。是否更换模型，应在同一任务同一起点对照后判断。

## 边界与不做

本轮只诊断，不改产品代码，不操作 BOSS 页面，不重新执行简历修改。未跑测试或 UI 复现。未安装 Kun 工具。
