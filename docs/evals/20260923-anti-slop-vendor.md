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

## 落地进度（2026-09-23，三个提交）

裁决结果：按「先机械消空白行 → 再只卡新改动 → 最后分批收紧」执行。

| 提交 | 内容 |
| --- | --- |
| `f71dfef` | `require-readable-spacing` 机械消红：611 个**无未提交改动**的文件，+18,557 行、全部为插入空白；逐个文件验证剥离空白后与 HEAD token 一致，因此不可能改变行为。该规则基线 20,621 → 4,694。 |
| `1d5fd33` | `scripts/lint-changed.mjs` + `scripts/git-hooks/pre-commit` + `tools/oxlint/anti-slop-baseline.json`：只 lint 在改文件，且仅当「文件×规则」计数超过 baseline 才失败。已 `git config core.hooksPath scripts/git-hooks`。 |
| `2e49428` | vendor 规则集、`oxlint.config.ts`、验收文档；`package.json` 只提交本轮新增的 4 个 script 与 2 个 devDependency，**未**夹带工作树里别人的未提交改动。 |

当前入口：`npm run lint`（全量）、`npm run lint:changed`（在改文件）、`npm run lint:baseline`（重算 baseline）。`lint` 仍未并入 `npm run check`。

baseline 快照（生成时 10,681 条 / 548 文件）分布见上表；其中 `require-readable-spacing` 4,694 条全部落在 86 个**当时有未提交改动或未跟踪**的文件里，等它们落地后重跑一次 autofix 即可归零，不需要额外设计。

## 已生效的行为，续接前必须知道

- **pre-commit 钩子已启用**（`core.hooksPath`）。以后每次 `git commit` 都会跑 `lint:changed --staged`，新增违规会直接挡住提交。绕过方式是 `git commit --no-verify`，但要在 commit message 里写原因。
- 闸门判据是「文件×规则」计数不超过 baseline，不是逐行对比：改文件不会释放它的历史额度，只有真正修掉违规才会。代价是「修掉一条旧违规、新增一条同规则新违规」会算通过——这是棘轮的有意取舍。
- **baseline 是快照，工作树是活水。** 生成 baseline 时（03:29）之后仍有文件在被继续修改，再次运行 `npm run lint:changed` 立刻报出 `hover-recovery` / `click-integrity` / `pointer-input` / `clipboard-bridge` / `cap02c-locator` 等文件各多出 1–2 条新违规（mtime 03:34–03:35，晚于 baseline）。这不是误报，是闸门在抓真实新增。WIP 稳定后可用 `npm run lint:baseline` 重算，但重算等于把当时的新违规一并认成历史额度，要有意识地做。

## 在途清理结果（2026-09-23，提交 `1e3ae6f`，已 push）

WIP 从 8 条涨到 231 条超额后做了全量清理，闸门回到 0，并把这轮在途的 CAP-02 工作一并落库。

**策略**：只把「文件×规则」计数压回 baseline 之下即可提交；但实际修得比下限更多——21 个文件里修掉的不只是超额那几条。修完重算 baseline：**10,681 → 9,071（546 文件）**。

**验证（都是前后对比，不是单次通过）**
- `npm run lint:changed`：0 条新增（101 个在途文件）。
- `npm run typecheck`：0 错（修改前也是 0）。
- `npm run test:unit`：2 failed / 3205 passed（3207），与修改前快照**逐条一致**；两条失败 (`task-goals`、`task-recovery-matrix`) 是既有红灯。
- `npm run check:architecture`：243 production files passed。
- 两个 `.mts` 验收脚本只做静态复核，**未运行**（需真实 Chrome + 构建产物）。

**主要修法**
- 159 处间距：空白 autofix，逐文件验证剥离空白后与 HEAD token 一致。
- 测试契约：未用参数改名 `_name`；`Record<string, unknown>` 桩换成从生产类型推导的具名接口；7 处 `as any` 直接删除，其余补真实 `// SAFETY:` 不变量。
- 边界解析：`parseViewport` 收 `RawViewportReading` 出 `ViewportMetrics | null`；两处 rect 校验合并为 `isDomRect`；tabIds 走 `isTabId`（正整数，即 chrome.tabs 的 id 契约，比原来的 `typeof === "number"` 更严，已在提交说明中披露）。
- `no-module-mocking`：`decision-view-integrity.test.ts` 直接删掉 `vi.mock`；`browser-decision-trace.test.ts` 改用真实 `readTypeSafeKey` + `TYPESAFE_API_KEY`（沿用 `display-steer-routing.test.ts` 的做法）。

**两个必须记住的坑**
1. `debugger.ts` 的模块级监听登记包了 `typeof chrome !== "undefined"` 守卫，好让模块能在 Node 下被 import。第一版把 `chrome.debugger?.onEvent?.addListener` 写成了硬访问，**一下挂掉 7 个测试文件**——那些测试只桩了 `chrome.debugger` 的一部分 API。逐 API 的 `?.` 必须保留。
2. `no-runtime-typeof` 开了 `allowInTypeGuards: true`（见下）。这是有意的策略决定，不是顺手放宽。

## 策略变更：`no-runtime-typeof` 允许类型谓词内的 typeof

`oxlint.config.ts` 里该规则现为 `["error", { allowInTypeGuards: true }]`。

理由：本仓库既有的边界解析约定就是 `isXxx(value: unknown): value is Xxx` 谓词（`shared/*.ts`、`extension/src/shared/*.ts` 大量存在），上游也为无 schema 项目提供这个开关。开启后 **197 处谓词内部的 typeof 不再计入，749 处业务逻辑里的临时 typeof 仍然全数拒绝**——是让规则贴合仓库约定，不是放水。要回退只需删掉这个 option。

## 分批收紧计划（剩余 9,071 条）

按「价值/风险比」排序，每批独立可 review，完成后必须同步下调 baseline（`npm run lint:baseline`）——不下调就等于没做。

| 批次 | 规则 | 量 | 做法与风险 |
| --- | --- | --- | --- |
| A | `require-readable-spacing` | 4,694 | 等 86 个 WIP/未跟踪文件落地后重跑 autofix，无需设计。 |
| B | `no-conditional-empty-object-spread` | 385 | 机械改写：把 `...(x ? {a} : {})` 拆成先建对象再有条件赋值。无接口变化；该规则故意不提供 autofix，因为「省略字段」与「赋 undefined」不等价，需人工确认。 |
| C | `no-array-filter-map` 103 + `oxc/no-accumulating-spread` 3 | 106 | 改 lazy iterator 管线。**先确认运行时支持**：扩展跑 Chrome、agent 跑 Node 22，都要实测；TS lib 声明不构成 polyfill。 |
| D | `no-shape-in-symbol-names` 32 + `no-object-parameters` 31 + `no-reflect-get` 2 | 65 | 纯重命名 / 换类型，风险低但涉及面广，按目录分批。 |
| E | `no-chained-type-assertions` 195 + `no-known-value-widening` 317 + `no-unknown-parameters` 457 + `no-unknown-returns` 112 + `no-unsafe-dictionary-type` 572 | 1,653 | 类型证据组，需要在 I/O 边界补 schema / 具名域类型，是真正的大头。按目录推进，每步守住对外行为不变。 |
| F | `no-runtime-typeof` | 939 | 与 E 同主题（边界解析替代临时 typeof），可并入 E 的同一批改动，也可单独按模块推。 |
| G | `no-module-mocking` | 92 | 测试替身改真实依赖缝；与全局 Testing Rules 同向，但改测试容易破坏现有覆盖，需逐文件确认替换后仍能失败。 |
| H | `require-safety-comment-for-type-assertion` | 2,548 | 每条断言都要有真实的 `SAFETY:` 依据。**禁止批量生成占位注释**——那正是本规则要防的 slop。建议随文件被修改时顺手补，不单独扫。 |
| I | oxlint 自带 warning（`no-unused-vars` 79、`no-unused-expressions` 57、`unicorn/*` 45 等） | ~199 | 与本策略无关的既有基线，量小，可随手清。 |

建议顺序 A → B → C → D → I → E/F → G → H。
