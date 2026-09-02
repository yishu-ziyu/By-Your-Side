# AGENTS.md

## 协作协议：先验收，后实现

核心原则：人负责定义价值函数，机器负责搜索。每个需求先转化为可执行的验收标准和 evaluator，确定什么情况算成功，再动手实现。

### 流程

1. **验收卡先行** — 收到需求后，先输出验收卡再写代码。需求模糊时，先澄清"什么现象出现时，算它确实更好了"。
2. **evaluator 分层** — 每条验收标准标明归属：
   - **机器执行**：`npm run typecheck` / `npm test` / `npm run build` / 针对 `shared/protocol.ts` 的契约测试。agent 必须自己跑到全绿才交付，未绿继续迭代，不拿半成品占用用户判断。
   - **人评**：体验、观感、设计意图等机器判不了的。交付时明确列出，请用户裁决。
3. **现象即信号** — 用户说"太慢""不好用"时，agent 负责追问成可观测现象（数值、行为、截图特征），再翻译成测试或检查脚本。尽量把验收标准拆到机器可执行，剩余部分显式标记"人评"。
4. **验收卡存档** — 实质性任务的验收卡存入 `docs/evals/YYYYMMDD-<任务名>.md`，commit message 引用之，便于回溯"当时我们承认什么算好"。

### 验收卡格式

```markdown
# 任务: <一句话>

## 验收标准
- [ ] 1. <可执行标准> — evaluator: npm test
- [ ] 2. <可执行标准> — evaluator: 人评

## 边界与不做
- <明确的非目标>
```

## 上下文管理默认行为

无需用户指示，默认执行：

- **探索走子代理**：摸清调用链、跨多文件找线索等探索性工作优先派 `explore` 子代理，只把结论带回主上下文。
- **先外置再丢失**：每完成一个子任务，立即把关键结论、改动文件清单、未决问题追加到 `docs/NOTES.md`——不等上下文压缩，压缩随时可能发生。
- **压缩后回溯**：需要早期细节时先读 `docs/NOTES.md`；仍缺失再查 `.kimi-code/wiki/fold-archive/` 里的压缩前轨迹归档（由 PreCompact hook 自动落盘）。

## 经验沉淀闭环（WikiSkill 试点）

- `.kimi-code/wiki/` 是持久知识层：`patterns/`（一坑一页，只增不删、永不回滚）、`index.md`、`logs.md`、`proposals/`（待审 skill 提案）。
- `consolidator` agent 由 SessionEnd hook 在会话结束后自动离线复盘，只更新 wiki、只往 `proposals/` 投提案，**不直接改 skills 或 AGENTS.md**。
- 用户裁决提案后：接受的落地为 skill 或规则并记 git；拒绝的把提案移到 `proposals/rejected/`（保留记录，防止重复提出）；都在 `logs.md` 记一行。
- 日常会话不主动读 wiki——知识通过 skills/AGENTS.md 生效，wiki 只在复盘和裁决时打开。
