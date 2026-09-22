# 任务: anti-slop 规则集接入仓库，lint 入口可用且违规量可度量

## 目标

把上游 [anti-slop](https://github.com/dmmulroy/anti-slop)（Opinionated Oxlint 规则，专门拒绝"低证据"TypeScript 模式）接进本仓库，让这类模式在提交前可被机器检查，并先把真实违规量测出来，再决定怎么收敛。

本轮只做接入与度量：不改产品源码消红，不改上游规则实现。

## 完成标准

- [x] 1. 上游 `src/` 未修改复制到 `tools/oxlint/anti-slop/`，随带 MIT `LICENSE` 与 `VENDOR.md`（固定 revision、vendor 日期、更新方式）。— 谁检查: `diff -r` 对比上游 clone + `git status`
- [x] 2. `oxlint` 与 `@oxlint/plugins` 以**同一个精确版本**进入 devDependencies（1.85.0 / 1.85.0），lockfile 只新增、不改动既有依赖。— 谁检查: `package.json` / `package-lock.json` diff（+387 行，0 删除）
- [x] 3. `oxlint.config.ts` 注册 `jsPlugins` 与全部 19 条通用规则；**未**注册 5 条 Effect 规则——本仓库不使用 Effect 库（`grep 'from "effect"'` 无命中），注册即死配置。— 谁检查: 探针文件一次性触发 3 条规则报错
- [x] 4. `npm run lint` / `npm run lint:fix` 可用；`npm run check:architecture` 仍 243 production files passed；`typecheck`、vitest 的 include 白名单均不受 `tools/` 影响。— 谁检查: 实跑三条命令
- [ ] 5. 违规量收敛到可交付水平。— **BLOCKED：收敛范围与顺序需要用户裁决，见下。**

## 边界与不做

- **不运行 `oxlint --fix`。** `require-readable-spacing` 命中 697 个文件、20,621 处；全量 autofix 会产生跨 700 文件的空白行 diff，和当前工作树里大量未提交 WIP 混在一起，无法 review。
- **不把 `lint` 并进 `npm run check`。** 现在有 26,405 条 error，并进去会立刻让 `check` 变红，堵死日常检查入口。
- 不修改任何产品源码来消红；不在本轮放宽或注释掉任何规则。
- 上游规则实现保持未修改状态，本地策略只写在 `oxlint.config.ts` 与文档里。

## 证据：基线违规量（2026-09-23，全仓库）

`oxlint --format json`：744 个被检文件，115 条规则，26,604 条 diagnostics，其中 error 26,405、warning 199。oxlint **自带**默认规则只报 199 条 warning——也就是说这些 error 基本全部来自 anti-slop 策略本身，不是代码原本就脏。

| 规则 | 条数 | 备注 |
| --- | --- | --- |
| `anti-slop/require-readable-spacing` | 20,621 | 纯空白行，**唯一有 autofix** 的规则；697 个文件 |
| `anti-slop/require-safety-comment-for-type-assertion` | 2,548 | 每个非 `as const` 断言都要 nearby `// SAFETY: <理由>` |
| `anti-slop/no-runtime-typeof` | 939 | 要求边界解析替代临时 `typeof` 收窄 |
| `anti-slop/no-unsafe-dictionary-type` | 572 | `Record<string, unknown>` 一类字典值契约 |
| `anti-slop/no-unknown-parameters` | 457 | 入参 `unknown` |
| `anti-slop/no-conditional-empty-object-spread` | 385 | `...(x ? {a} : {})` |
| `anti-slop/no-known-value-widening` | 313 | 已知值被显式 widened |
| `anti-slop/no-chained-type-assertions` | 195 | `as X as Y` |
| `anti-slop/no-unknown-returns` | 112 | 返回 `unknown` |
| `anti-slop/no-array-filter-map` | 103 | 相邻 filter/map 应走 lazy iterator |
| `anti-slop/no-module-mocking` | 92 | 测试里的 `vi.mock` 等，要求真实依赖缝 |
| `anti-slop/no-shape-in-symbol-names` | 32 | 局部符号名含 "shape" |
| `anti-slop/no-object-parameters` | 31 | 入参 `object` |
| `oxc/no-accumulating-spread` | 3 | oxlint 原生，与 reducer 复制类规则配对 |
| `anti-slop/no-reflect-get` | 2 | `Reflect.get` |
| 其余 oxlint 自带 warning（no-unused-vars 等） | 199 | 既有代码基线，与本次接入无关 |

按区域（剔除空白行规则后）：`agent/` 2,681、`scripts/` 1,373、`extension/` 1,274、`shared/` 575、`docs/` 80，共 5,983 条，涉及 538 个文件。

接入方式与 pinned revision 见 `tools/oxlint/anti-slop/VENDOR.md`（`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`，2026-09-10）。

## 待用户裁决（不阻塞已完成的接入）

1. **收敛范围**：只对新改动生效（changed-files lint / 提交前钩子），还是全量收敛？
2. **`require-readable-spacing` 单独处理**：占违规量 78% 且可 autofix，是否作为一次独立的机械提交先消掉？
3. **起始严苛度**：是否先把高信号类型证据类规则保持 error，其余暂设 warn，分批收紧？
