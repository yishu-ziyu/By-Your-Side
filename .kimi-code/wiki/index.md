# Wiki Patterns 索引

> 本目录是项目唯一经验库，`.kimi-code` 是历史路径名。Codex 主代理在开发任务验证后、最终交付前，按 [项目收尾规范](../../AGENTS.md#经验沉淀闭环codex-任务收尾)直接维护这里。
> 历史 Kimi 离线复盘也使用此库；Codex 收尾不依赖它。经验一事一页，纠正时保留依据；日常实现使用已生效规则和 skills，复盘与裁决时才定点读 wiki。

- `patterns/`：经过核对的经验及其适用条件、证据；不自动成为指令。
- [收尾流程](closeout.md)：有新经验或需要纠正旧经验时按需读取。
- [提案与裁决](proposal-workflow.md)：待审建议及接受、拒绝、修改后的处理。
- 待审提案：[完成标准模板使用入口字段](proposals/20260909-acceptance-entry-field.md)（2026-09-09）、[probe-scripts skill](proposals/20260909-probe-script-convention-skill.md)（2026-09-09）、[全量检查独占复跑](proposals/20260911-verification-exclusivity.md)（2026-09-11）；已采纳归档：[proposal-archive/accepted/](proposal-archive/accepted/)。
- [演化日志](logs.md)：记录知识和提案发生了什么变化；任务当前进度仍在 [STATUS](../../docs/STATUS.md)。

| Pattern | 一句话 | 来源会话 | 日期 |
|---|---|---|---|
| [tsx-adhoc-probe-scripts](patterns/tsx-adhoc-probe-scripts.md) | 区分导入路径、模块格式和依赖位置；脚本运行与网页操作成功分别核验，内联 import 禁令已被反例推翻 | session_236968c3（复盘 f0b4980d） | 2026-09-09 |
| [chrome-secure-preferences-default-dir](patterns/chrome-secure-preferences-default-dir.md) | 先确定实际 profile，再读取 Secure Preferences；本例为 Default，扩展消失根因仍未决 | session_236968c3（复盘 f0b4980d） | 2026-09-09 |
| [acceptance-entry-mismatch](patterns/acceptance-entry-mismatch.md) | 在旧宿主验收成功不等于用户当前入口可用；先把实际入口写清再定方案 | Codex 本轮目的纠正与收尾验收 | 2026-09-09 |
| [production-wiring-lowest-shared-module](patterns/production-wiring-lowest-shared-module.md) | 共享行为要接在所有入口都会构造的最低层生产模块，否则最小生产组合与验收驱动会漏掉 | 写入回执丢失 R1–R4 返工 | 2026-09-09 |
| [quota-limited-storage-silent-failure](patterns/quota-limited-storage-silent-failure.md) | 配额写满后所有写入静默失败；按会话分键会被广播状态批量放大；预算要按 UTF-8 字节算 | 侧栏「未连接」排查与修复 | 2026-09-11 |
| [observation-identity-mismatch](patterns/observation-identity-mismatch.md) | 按名字匹配命中别的扩展、共享 stderr 没有时间轴、并发工作区造出假回归；下结论前先钉死观测对象 | 同上 | 2026-09-11 |
| [cross-process-session-closeout](patterns/cross-process-session-closeout.md) | 收盘顺序错、结果被收走、归属依赖任务绑定：跨进程会话的尾巴会丢 | 示范录制第一刀真机模拟 | 2026-09-11 |
| [gui-test-window-steals-focus](patterns/gui-test-window-steals-focus.md) | 可见 GUI 测试窗口会抢用户前台；浏览器验收走 `--headless=new`，脚本自带拒绝 | 同上（用户反馈） | 2026-09-11 |
| [pi-opencode-missing-session-header](patterns/pi-opencode-missing-session-header.md) | Prime Agent 的 refine/子代理请求缺 `x-opencode-session` 被 400 拒；别假设 refine 成功 | 用户截图报错排查 | 2026-09-11 |
