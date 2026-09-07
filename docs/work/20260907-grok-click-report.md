# Grok 执行报告：单次点击与交还约束可信

日期：2026-09-07。执行者：Grok（Codex 编排，surface:13）。编排回报：surface:11。

## 状态

REVIEW_READY（代码冻结，待编排实机）。B2 AX/shadow host 刺入保留；集成 typecheck 三处已补类型：`domops.ts` 循环 `root`/`host` 显式 `Node | null` 与 `Element | null`；`click-integrity.test.ts` 的 `elementFromPoint` 返回 `FakeEl | null`。反例语义未改。`npx tsc --noEmit -p extension/tsconfig.json` exit 0。未跑全量。

## 路径与分支核实

- 工作区：`/Users/mahaoxuan/Desktop/ego`
- 当前分支：`fix/stability-issue2-model-capability-labels`（与任务预期一致）
- 工作树：大量未提交改动（本会话与其他执行者共存）。未 reset/revert/commit/push，未切 worktree。
- 锁定标准：`docs/evals/20260907-observation-click-integrity.md`（B1/B2/B3，未放松）
- 阶段：ROADMAP 阶段 0

## 修改文件

生产：
- `extension/src/content/domops.ts` — 去掉 click 双发；`confirmForClick` / `hitTestAt` / `rememberPoint` / `confirmPoint`；命中身份去掉祖先放行
- `extension/src/background/exec/input.ts` — 视觉等待后可重定位；**真实 mouseMoved 之后**在原按下坐标 hitTest，变化拒绝不追逐；纯坐标按下前核对同一节点
- `extension/src/sideagent.d.ts` — 编排已认可为配套类型所有权：`confirmForClick` / `hitTestAt` / `rememberPoint` / `confirmPoint`
- `shared/control.ts` — 仅 `handbackContinueText` 增加到期范围（保留原字符串；未改 ControlGate）
- `agent/src/prompt.ts` — 仅追加 HANDOFF 约束优先级一条；保留 browser_run / hover / recovery 等既有规则
- `extension/src/sideagent.d.ts` — 为 `confirmForClick` 补类型（domops 契约，不在原所有权名单，属配套类型）

未改：`agent/src/session.ts`（B3 不必改会话结构）、screenshot.ts、snapshot.ts、axstate.ts、axtree.ts、shared/protocol.ts、agent/src/tools.ts、background/index.ts、Antigravity 夹具。

测试：
- 新建 `extension/test/click-integrity.test.ts`
- 新建 `extension/test/handback-constraint.test.ts`
- 新建 `agent/test/handback-constraint.test.ts`
- 未改既有测试断言。`control-gate.test.ts` 与 `session-helpers.test.ts` 原断言仍通过。

## 旧行为反例（修改前聚焦测试）

命令：`npx vitest run extension/test/click-integrity.test.ts extension/test/handback-constraint.test.ts agent/test/handback-constraint.test.ts`

结果：10 failed / 2 passed（exit 1）

| 标准 | 旧现象 |
|---|---|
| B1 | `dom.click("#counter")` 处理器计数 **2**（`dispatchEvent(click)` + `HTMLElement.click()`） |
| B1 | CDP `mousePressed` 成功、`mouseReleased` 失败后仍 `clicked: true`，并再走 DOM 点击 |
| B1 | CDP 一开始不可用时回退成功，但计数仍为 **2** |
| B1 | CDP 中途 detach 后仍当未执行去补点 |
| B2 | 目标从 x=10 移到 x=200 后，仍在旧中心 **(50,40)** 按下，会点到原位另一个按钮 |
| B2 | 目标被覆盖后仍报告点击成功 |
| B2 | `@7` 等待期间断开后仍点击成功，未拒绝同名另一按钮 |
| B3 | `handbackContinueText` 无「只约束本次恢复的原任务 / 到期」 |
| B3 | `SYSTEM_PROMPT` 无 HANDOFF 与后续换页新请求的优先级 |

坐标危险确认旧路径已成立：`click({ point, label: "删除项目" })` 仍 `{ clicked: false, held: true }`。

## 修改后命令与结果

同一命令再跑：12 passed（曾因假计时器出现 unhandled rejection，已把 `expect` 挂到 `advanceTimers` 之前；随后全绿）。

扩大到相关既有测试（未跑全量）：

```text
npx vitest run \
  extension/test/click-integrity.test.ts \
  extension/test/handback-constraint.test.ts \
  agent/test/handback-constraint.test.ts \
  extension/test/hover-recovery.test.ts \
  extension/test/click-robustness.test.ts \
  extension/test/control-gate.test.ts \
  agent/test/session-helpers.test.ts \
  agent/test/safety-prompt.test.ts \
  agent/test/teach-prompt.test.ts
```

结果：9 files / **96 passed**，exit 0。

```text
npx vitest run extension/test/held-clicks.test.ts extension/test/team-control.test.ts
```

结果：2 files / **20 passed**，exit 0。

合计本执行者跑过 **116** 个测试，exit 0。

## 行为对照

- B1 DOM：一次 `click()` 只触发一次 click 处理器；保留 pointer/mouse down-up + `HTMLElement.click()` 默认行为（如链接跳转），不再额外 `dispatchEvent(click)`。
- B1 CDP：`mouseMoved` 一旦成功即视为已开始输入。按下已成功则报「可能已送达」；仅 moved 后失败则报「无法确认」。两种都不二次点击。只有第一条 CDP 命令都没出去（如 debugger 占用）才允许 DOM 回退一次。
- B2：高亮 500ms + 波纹 150ms **未改**。视觉等待后可确认同一目标（等待期间位移仍不点原位 trap）。随后只 `mouseMoved` 一次，**按下前**用 `hitTestAt` 核对「当前点下的节点是否仍是原目标」。mouseenter 把目标移走则明确拒绝，**不追逐**新坐标。命中身份：同一对象、目标合法后代、或从 hit 沿 shadow host 走到目标；若 `document.elementFromPoint` 落到**目标所在 shadow 的 host**，再对该 shadowRoot `elementFromPoint`，仍是该内部目标才放行。**禁止** `top.contains(el)`。纯坐标：视口内、点下有对象、按下前同一节点；canvas 只认元素身份。不引入 iframe 新系统。
- B3：交还文本仍要求继续原任务、不重做、不换页；并写明这些 stay-on-page 指令只作用于这次恢复的原任务、原任务结束即到期。系统提示规定后续明确点名另一页的用户请求不再沿用旧约束，且保持同一会话。

## B2 编排复核补强

旧实现失败（先补测试再改）：

```text
npx vitest run extension/test/click-integrity.test.ts
```

当时 **6 failed / 10 passed**：追逐 mouseenter 后新坐标仍 `clicked:true`；`confirmForClick`/`hitTestAt` 对祖先/body 放行；shadow 合法后代被拒；纯坐标视口外/空点/替换后仍成功。

修改后：

```text
npx vitest run extension/test/click-integrity.test.ts extension/test/hover-recovery.test.ts extension/test/click-robustness.test.ts
```

3 files / **27 passed**，exit 0。click-integrity **16 passed**。身份反例直接调用注入后的 `dom.confirmForClick` / `dom.hitTestAt`，不是 mock `sendCommand` 返回 rect。

```text
npx vitest run extension/test/click-integrity.test.ts extension/test/handback-constraint.test.ts agent/test/handback-constraint.test.ts extension/test/control-gate.test.ts agent/test/session-helpers.test.ts agent/test/safety-prompt.test.ts extension/test/held-clicks.test.ts
```

7 files / **94 passed**，exit 0。B1/B3 断言未弱化。未改 Antigravity 夹具，未操作浏览器。

### AX/shadow host 回归（本轮）

旧实现：AX ref 指向 shadow 内按钮时，`document.elementFromPoint` 返回外层 host，从 hit 向上走不到内部 `el`，判覆盖。

反例（先失败后修）：
- `AX/shadow 内按钮：document.elementFromPoint 返回外层 host 时，仍应命中内部目标，且不靠祖先 contains 放行`（直接跑 `hitTestAt`/`confirmForClick`）
- `AX ref 路径执行页面内确认函数`（`Runtime.callFunctionOn` 真执行 `CONFIRM_CLICK_JS`/`HIT_TEST_AT_JS`，`this` 为内部按钮）
- 同 shadow 内另一按钮、或 hit 为 body：仍拒绝

```text
npx vitest run extension/test/click-integrity.test.ts
```

修改后 **18 passed**。相关 `hover-recovery` / `click-robustness` / `held-clicks` / `control-gate` / `session-helpers` / handback 共 **82 passed**，exit 0。代码冻结，实机由编排统一跑。

## 风险与需要编排的决策

1. **人/实机（Codex）**：计数按钮 CDP/回退各点一次；**移动场景必须走真实 mouseMoved→mouseenter 位移**，断言 trapCount===0 且不得在原坐标按下；遮挡拒绝。同会话任务 A 接管交还完成后发新任务 B 由编排用真实模型验收。我未操作浏览器。
2. **B3 仍依赖模型读提示**：没有改 `session.ts`，没有清空历史、没有新任务库。旧 `[HANDOFF BOUNDARY]` 仍留在对话里，只是加了到期范围和优先级。若实机模型仍留在旧页，需要编排决定是否再在空闲新用户消息上加标记（会碰到 `session-helpers` 里 `prompt("see this")` 的精确断言）。
3. **仅坐标点击**：有 target 才重确认。纯 `point` 仍点给定坐标（画布路径、协议保留），不宣称已证明对象；危险名仍 held。
4. **`sideagent.d.ts`**：编排已认可属本任务配套类型所有权。
5. **CDP 命中检查源码**在 `CONFIRM_CLICK_JS` 字符串里，单元测试 mock 了 `sendCommand`，不执行该页内函数。DOM `confirmForClick` 有反例覆盖。
6. C2 全量 typecheck/test/build 未跑。

## 未决项

- B2 含 AX/shadow host 刺入已冻结。真机 `--case=move` / occlude 及含 shadow 的同页 AX ref 由编排跑。
- B3 代码未再改；同会话真实模型 A→交还→B 由编排验收。
- 未跑全量 typecheck/test/build。
