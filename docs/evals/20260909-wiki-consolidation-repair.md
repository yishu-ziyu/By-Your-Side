# 任务: 会话结束后能自动复盘真实开发轨迹，形成有依据的经验与待审提案

## 完成标准
- [x] 1. 原启动命令复现 `unknown command 'consolidator'`，修复后的真实 Kimi CLI 能加载本地复盘代理并执行提示词。 — 谁检查: 主代理执行 CLI
- [x] 2. 定点检查验证非本项目、短轨迹、递归调用被跳过；连续触发去重；后台退出状态可查，失败后可重试。 — 谁检查: `python3 scripts/acceptance/wiki-consolidation-test.py`
- [x] 3. 用已有真实开发轨迹产出至少一条有来源定位、适用条件和验证依据的 pattern；有可推广经验时产出至多一条待审提案，不直接改 skill 或 AGENTS.md。主代理核对原始证据和写入范围；不足以提案时不能为通过而编造。 — 谁检查: 主代理审阅真实复盘产物与前后差异
- [x] 4. 真实 Kimi 会话结束触发已注册的 SessionEnd hook，日志能关联来源会话与后台结果；不能仅用手工发送 payload 代替实际事件验证。 — 谁检查: 真实会话、hook 日志与产物
- [ ] 5. hook shell 语法、`git diff --check` 及项目 typecheck/test/build 通过；已有无关失败如实记录。 — 谁检查: 机器

## 边界与不做
- 修复仓库现有 Kimi SessionEnd 复盘链路；不宣称其他宿主会话也会自动触发。
- 不替用户接受提案，不直接修改已有 skill，不提交或推送，不改变产品代码。
- 真实轨迹与含私密内容的运行日志留在本地忽略目录；提交候选文档仅保留必要、脱敏的经验与定位信息。

## 验收结果（2026-09-09）

- Kimi 0.42.0：旧命令退出 1，报 `unknown command 'consolidator'`；新 `--agent-file ... -p "提示词"` 真实回复 `CONSOLIDATOR_READY`，退出 0。
- 完整参数测试暴露第二个缺陷：Bash 中变量紧邻中文括号，未加花括号时路径和会话编号被吞。改为 `${wire}` / `${sid}` 后，完整路径与编号检查通过。
- `python3 scripts/acceptance/wiki-consolidation-test.py` 最终 4/4 通过；shell 语法与本次 diff 空白检查通过。测试目录采用真实路径，避免 macOS `/var` 与 `/private/var` 别名造成装置误判。
- 真实开发源：`session_236968c3-8bae-437a-9311-3bdccc4df91b`，2371 行；本轮只读复核会话：`session_f0b4980d-5078-4b2d-9712-034c6553c988`。
- 一次性 `kimi -p` 正常退出未产生 SessionEnd，不能算自动触发。随后用 `kimi --session session_f0b4980d-5078-4b2d-9712-034c6553c988` 进入交互会话，执行 `/exit`，终端退出 0。未手工发送正式 hook payload。
- 本地 `.kimi-code/wiki/consolidate.log` 记录该会话于 13:16:06 UTC 收到 SessionEnd 并开始；父终端退出后后台仍运行。13:20:26 UTC 记录 `finished exit=0`。复盘子会话为 `session_fd901a66-d6d8-4345-a0fb-79c1f4e0e1ff`，没有递归启动下一轮复盘。
- 自动产出：两条 [pattern](../../.kimi-code/wiki/index.md)、一条 [待审提案](../../.kimi-code/wiki/proposals/20260909-probe-script-convention-skill.md)，以及索引与演化日志。没有创建 `.kimi-code/skills/`。
- 产物并非未经审阅即通过：初稿把源轨迹 1546 的 `Cannot find module` 误归纳为内联 import 不可用。主代理读取完整错误，并执行 `npx tsx -e 'import { readFileSync } from "node:fs"; console.log("INLINE_IMPORT", typeof readFileSync)'`，输出 `INLINE_IMPORT function`、退出 0。已修正 pattern、索引、提案，并区分脚本执行与网页重载成功，限定 Chrome profile 结论。初稿保留在被 git 忽略的 `consolidate-first-draft.log`；原复盘轨迹和报告保留。
- 基于这次失败加强 consolidator 指令：原代理总结只能作线索，必须核对原始调用和完整错误，不从截断预览推广根因。这是提示词约束，不是保证所有未来经验正确的技术机制；候选提案仍须用户裁决。
- 写入范围审计：只读复核会话无 Write/Edit；复盘会话只有 3 次 Write、2 次 Edit，全部指向上述 wiki 文件，Bash 调用为读取和检索。主代理另行修改启动脚本、专项测试、复盘指令、规范中的触发范围及本次记录。

## 工程检查与并行改动

- 首次工程检查：124 文件、989 测试通过，typecheck/build 通过。
- 验收期间其他工作继续修改 agent/extension 相关产品文件；本轮未覆盖这些改动。不能用整个工作区哈希不变作为写入范围证明，改用本轮两个 Kimi 会话的实际工具调用审计。
- 最后 typecheck/build 通过；全量测试为 125 文件、991 项，990 通过、1 失败，另有 1 个关联 unhandled rejection。失败来自 `extension/test/click-integrity.test.ts:447`：`Node is not defined`，调用 `extension/src/background/exec/input.ts`，与 `.kimi-code` 复盘链路无调用关系。
- 因此第 5 项的全量测试全绿条件未满足，保留失败，不伪记全绿，不在本任务修改并行产品实现。最后日志：`/tmp/ego-wiki-final-{tests,typecheck,build}.log`。

## 交付边界

Kimi 交互会话的自动复盘路径已实测完成；一次性 `-p` 退出和其他宿主的结束事件没有接入保证。两条经验已由主代理核对修正；新 skill 提案只供用户裁决，尚未启用。未提交或推送。
