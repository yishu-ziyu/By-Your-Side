# 结果不确定的边界

[返回协议](protocol.md)

结果不确定只拦再做一次可能重复造成后果的调用（10-01 用户裁决：不确定刷卡成没成，就不让它再点付款）。规则只有一条，定义在 [`shared/task-results.ts`](../shared/task-results.ts) 的 `repeatsHarm` / `commitsHarm`：控制闸门的写类工具去掉「再做一次也不会让同一件事多发生一次」的那组（导航、开/切/关标签页、页面归属、滚动、悬停、圈画、点选、等页面事件、确认或关闭原生弹窗、松开按住的输入、取消下载），再加上 POST 或带 body 的 `fetch`。

- 被拦：点击、填写、输入、按键、选择、拖拽、上传、页面 JS、CDP、POST/带 body 的 `fetch` 等。
- 照常：读页、截图、滚动圈画、导航与标签页、不带 body 的 GET `fetch`、存文件、等页面事件、`accept_dialog`/`dismiss_dialog`。这些调用不核销旧的不确定项，也仍受用户接管、取消、重启检查点和页面归属约束。
- 谁会上锁：只有 `commitsHarm` 的调用结果不确定时才记成「结果不确定」。它比 `repeatsHarm` 多一个 `accept_dialog`：确认弹窗可能就是「确定付款」那一下，但弹窗只能确认一次，所以它本身不被锁拦。GET `fetch` 出错或超时只是取数失败。
- 确定没执行（扩展回 `executionFact: "not_executed"`）的不上锁：派发前的目标核对失败（被覆盖、已失效、找不到）、`fill` 目标不可填或下拉框没有该选项（页面函数先核对再聚焦写入）、脚本编译失败、断连或超时后扩展补报未执行。
- 核查一次：`resolve_unknown_result` 对同一项只核查一次，查不清就标记 `checkFailed`、保持不确定，不再进入 `verify_unknown`；模型再要核查同一项时宿主不读页面，直接交付「这一步结果查不清、没有重复执行、请你看一眼」并结束本轮（诊断记录 `unconfirmed_result_stop`）。

点击后页面弹出原生 alert/confirm/prompt 时，派发输入的 CDP 命令会被对话框挡住；`click` 一收到 `Page.javascriptDialogOpening` 就返回 `{clicked:true, dialog:{type,message}}`，不等满超时。`browser_run` 逐个子调用按同一规则判定，见[组合执行](browser-program.md#控制与权限)；验收见 [20261001-unknown-lock-scope](evals/20261001-unknown-lock-scope.md)。
