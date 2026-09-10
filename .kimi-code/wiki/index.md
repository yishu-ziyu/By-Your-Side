# Wiki Patterns 索引

> 本目录是项目唯一经验库，`.kimi-code` 是历史路径名。Codex 主代理在开发任务验证后、最终交付前，按 [项目收尾规范](../../AGENTS.md#经验沉淀闭环codex-任务收尾)直接维护这里。
> 历史 Kimi 离线复盘也使用此库；Codex 收尾不依赖它。经验一事一页，纠正时保留依据；日常实现使用已生效规则和 skills，复盘与裁决时才定点读 wiki。

- `patterns/`：经过核对的经验及其适用条件、证据；不自动成为指令。
- [收尾流程](closeout.md)：有新经验或需要纠正旧经验时按需读取。
- [提案与裁决](proposal-workflow.md)：待审建议及接受、拒绝、修改后的处理。
- [演化日志](logs.md)：记录知识和提案发生了什么变化；任务当前进度仍在 [STATUS](../../docs/STATUS.md)。

| Pattern | 一句话 | 来源会话 | 日期 |
|---|---|---|---|
| [tsx-adhoc-probe-scripts](patterns/tsx-adhoc-probe-scripts.md) | 区分导入路径、模块格式和依赖位置；脚本运行与网页操作成功分别核验，内联 import 禁令已被反例推翻 | session_236968c3（复盘 f0b4980d） | 2026-09-09 |
| [chrome-secure-preferences-default-dir](patterns/chrome-secure-preferences-default-dir.md) | 先确定实际 profile，再读取 Secure Preferences；本例为 Default，扩展消失根因仍未决 | session_236968c3（复盘 f0b4980d） | 2026-09-09 |
| [acceptance-entry-mismatch](patterns/acceptance-entry-mismatch.md) | 在旧宿主验收成功不等于用户当前入口可用；先把实际入口写清再定方案 | Codex 本轮目的纠正与收尾验收 | 2026-09-09 |
| [production-wiring-lowest-shared-module](patterns/production-wiring-lowest-shared-module.md) | 共享行为要接在所有入口都会构造的最低层生产模块，否则最小生产组合与验收驱动会漏掉 | 写入回执丢失 R1–R4 返工 | 2026-09-09 |
