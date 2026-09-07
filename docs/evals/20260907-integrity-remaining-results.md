# 剩余实机验收结果

日期：2026-09-07。执行与判定：Codex。
完成标准：`docs/evals/20260907-observation-click-integrity.md`，断言未放宽。

## 结果

- A2 截图故障与 B1 点击回退：修正验收器前置条件后，6/6 通过，进程退出 0。
- B3 同会话接管、交还与新任务：首轮失败，增加旁路观测后第二轮通过，首轮归零原因尚未确定。不能用第二轮成功抹掉首轮失败。
- 本次未改产品代码，未重新 build/reload 或重复全量检查。只修改两个验收脚本。

## A2 / B1

命令：`node scripts/acceptance/integrity-fault-run.mjs`。

首轮证据：`out/acceptance/integrity-faults-1788791112325/`。
2/6 通过。可见捕获出现 image readback failed，连续调用触发捕获限流；实际 CDP 点击计数为 0，不满足预设已送达场景。

用户批准仅修验收脚本后，验收器恢复并聚焦本地测试窗口，切页后等待 1100ms，保留非 main 的测试 sessionId。前台设置属于验收器装配，不是在产品截图失败分支抢前台。

重跑证据：`out/acceptance/integrity-faults-1788791246852/`。

- 非工作页在前台时拒绝回退，未调用可见捕获。
- 合法回退得到 ALPHA 图，2650x1852，CSS 1472x1029，DPR 约 1.8；已人工查看保存的 PNG。
- 捕获期间切页、导航均丢弃图片并明确报错。
- DOM 回退仅一次非 trusted click，其他目标计数 0。
- 真实 CDP mouseReleased 后注入响应异常，目标恰好一次 trusted click；返回不确定结果，未补点。
- 六项全部通过，临时 Chrome API 包装在 finally 中恢复。

## B3

命令：`node scripts/acceptance/handback-new-task-run.mjs`。
模型：`minimax-cn/MiniMax-M3`。通过真实 panel Port、生产接管/交还、原生模型会话执行。

首轮证据：`out/acceptance/handback-new-task-1788791138693/`。
人工 trusted 点击后 A=1，交还后 A=0，B 未开始。已有事件中交还后未见工具调用；原报错 Handback repeated completed task A 不准确，应当描述未保持计数 1。现有证据不足以区分页面重载、外部重置或其他原因。

重跑只增加独立点击日志、performance.timeOrigin 和可见计数读取，修正错误描述，不恢复或强行写入计数。
证据：`out/acceptance/handback-new-task-1788791293355/`。

- A 人工点击前 0，点击后 1，交还后 1；加载标识未变化，旁路日志只有目标的一次 trusted 点击。
- 新请求 B 实际 switch_tab 到 BETA，点击一次，再 snapshot 确认结果。
- B.otherClicks=1；A.targetCount=1，decoy/trap=0。
- 同一 trace 含 A/B 标记，同一 sessionId，connectionRestarts=0。
- 总耗时 19079ms，人工接管操作 1 次；已查看 task-b.png，显示点击次数 1。

## 下一步

当前不宣称 B3 稳定性闭环。保留首轮失败作为未决问题；若继续，优先在现有旁路观测下定位计数归零的条件，不扩大产品改动范围，也不以多跑几次绿替代因果解释。
