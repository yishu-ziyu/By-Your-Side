# 任务: 建立可重复的离线/隔离评测入口，故意失败和缺证据不能晋级

## 完成标准

- [x] 1. 锁定 `eval/protected/quality-gates.json`，SHA 与执行包一致；篡改被拒绝 — 谁检查: `npx vitest run agent/test/eval-gates.test.ts`
- [x] 2. 故意失败候选（S01=1）被 `release:verify` 判 FAIL — 谁检查: `npx tsx scripts/eval/release-verify.mts --run=fixture-fail-s01`
- [x] 3. 缺真人/模型证据的报告判 BLOCKED，不算 PASS — 谁检查: `release:verify --run=fixture-missing-human`
- [x] 4. 伪造 artifact SHA 被拒绝 — 谁检查: `release:verify --run=fixture-fail-s01 --artifact=package.json`
- [x] 5. `eval:integration` 无 `--headless` 拒绝运行 — 谁检查: 命令退出码 2
- [x] 6. GitHub `main` 未保护、无 CODEOWNERS、无独立留出集保管人，记为 BLOCKED，不宣称保护已启用 — 谁检查: `gh api` 404 + doctor
- [x] 7. 现有 `npm test` / `typecheck` / `build` 仍可用 — 谁检查: 本轮实测

## 边界与不做

- 不连接个人 Chrome，不重载日常扩展。
- 不跑付费 live 评测（无预算文件）。
- 不把作者 STATUS 里的 153 文件 / 1341 项当作本次实测。

## 环境

- HEAD（开始时）: `4dd07bd6855d5c9f7839b59d4f8ff15a8b86c08a`
- 审阅基线: `176e23fd103497e522c5fc0428af2c559733e6c8`
- 相对基线: 1 commit（语音听错之后怎么办）
- 机器: Apple M2, 24 GiB, macOS 15.5, Node v22.23.1, Chrome 152.0.7977.83
- 工作区未提交产品改动开始时只有 `.mirasim/mcp.json`，已保留

## 实测

| 检查 | 首次结果 | 终结果 |
|---|---|---|
| `npm test` | 本轮新增后 2 项失败（回执目录混入 `_index.json`；1MiB 输出上限改 900KiB） | 161 文件 1382 项通过 |
| `npm run typecheck` | 先红（`.mts` import / 测试类型） | 通过 |
| `npm run build` | 通过 | 通过 |
| 故意失败候选 | FAIL S01 | FAIL（保留） |
| 缺证据报告 | BLOCKED | BLOCKED（保留） |
| 篡改 gates SHA | 单测抛 mismatch | 通过 |
| 分支保护 | HTTP 404 Branch not protected | BLOCKED |

## 证据

- 失败/缺证据报告: [fixture-fail-s01.json](20260911-release-converge/fixture-fail-s01.json), [fixture-missing-human.json](20260911-release-converge/fixture-missing-human.json)
- doctor: [doctor.txt](20260911-release-converge/doctor.txt)
- 评测规格: `eval/protected/`

## FAIL / BLOCKED

- 远端评测保护、独立留出集、真人签字、付费 live 预算: BLOCKED
- 正式发布: 不晋级
