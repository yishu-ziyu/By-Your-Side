# 任务: 按仓库规范把本轮经验沉淀进唯一经验库

2026-09-10/11 的侧栏「未连接」排查与修复交付后，按 `AGENTS.md`「经验沉淀闭环」执行收尾：
先查 [经验索引](../../.kimi-code/wiki/index.md) 的 pattern 与 proposals，只记录代码、测试或既有文档不能直接解释的教训。

## 完成标准

- [x] 1. 只记录有证据、且未被现有 pattern/提案覆盖的经验；没有新发现不凑文档。— 谁检查: 主代理核对
- [x] 2. 新增 pattern 含现象、根因、方法、适用条件、验证与来源，事实与推断分开。— 谁检查: 文档检查
- [x] 3. 更新索引表与演化日志各一行。— 谁检查: 文档检查
- [x] 4. 至多形成一条原子提案；提案不落地、不当作已生效规则。— 谁检查: 用户裁决
- [x] 5. 所有相对引用可打开。— 谁检查: 脚本检查

## 边界与不做

- 不为走流程创建文档；不把未验证的推断写成有效经验。
- 不修改 `AGENTS.md` 的规则文本（相关建议走待审提案）。
- 不安装 skill、不启动 Kimi、不新增子代理。

## 记录了什么

| 产物 | 一句话 |
| --- | --- |
| `patterns/quota-limited-storage-silent-failure.md` | 配额写满后所有写入静默失败，且失败现场离根因很远；按会话分键会被广播状态批量放大；预算要按 UTF-8 字节算 |
| `patterns/observation-identity-mismatch.md` | 按名字匹配命中别的扩展、共享 stderr 没有时间轴、并发工作区造出假回归 |
| `proposals/20260911-verification-exclusivity.md` | 待审：全量检查前确认独占，失败先单独复跑再归因 |
| `index.md` / `logs.md` | 索引两行、演化日志一行 |

## 没有记录什么（以及为什么）

- **`transport.start()` 曾写在无 `catch` 的 `.then()` 里**：代码与[本轮验收](20260910-panel-history-quota.md)已直接说明，
  且没有证据表明它触发过用户那次「未连接」，不作为有效经验另立一页。
- **用户改需求时重记决定、不为迁就实现改断言**：`AGENTS.md` 已有「不得为迁就实现降低要求、删除有效失败或把未跑记成通过……
  保留原记录、修改理由及新结果」覆盖，属既有规则的执行，不算新发现。
- **光标缩小 20%、是否连文字牌一起缩**：属产品决定，记在[光标验收](20260910-cursor-visibility.md)的修订段，不是可迁移经验。

## 证据

- 覆盖核对：`grep -rniE 'quota|配额|storage\.local|字节|UTF-8' .kimi-code/wiki/` 只命中本轮新增文件；
  `grep -nE '并发|独占|并行' AGENTS.md` 无命中 —— 两条经验与提案均未被现有库覆盖。
- 链接检查：3 个新文件的全部相对引用可打开（patterns → `docs/evals`、proposals → patterns）。
- 事实依据：[panel-history-quota 验收](20260910-panel-history-quota.md)、[STATUS](../STATUS.md) 顶部未决项。

## 交付后状态

新增 pattern 与待审提案都不自动成为指令；提案需用户裁决。本轮未修改 `AGENTS.md`、未安装 skill。
