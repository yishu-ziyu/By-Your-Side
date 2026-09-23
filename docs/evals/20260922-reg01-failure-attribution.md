# 任务: REG-01 历史 33 项全量单测失败逐项归因（只读）

依据：工程任务书 v2 §10 REG-01；历史验收 `docs/evals/20260922-browser-capability-parity.md` §六；原始 vitest 输出 `/tmp/bys-test2.log`（本机，`2026-09-22 20:20:35`，`Tests 33 failed | 3013 passed (3046)`）。

本文件只做归因，不改产品源码、不改测试、不重跑全量、不宣称放行。

## 完成标准

- [x] 1. 对声称的约 33 项失败给出可核对的测试名清单；找不到的标「名单缺失」，不编造 — 谁检查: 人（对照 `/tmp/bys-test2.log` 与验收文档）
- [x] 2. click-integrity / hover-recovery 给出原因类别与证据（路径 + 断言在等什么） — 谁检查: 人
- [x] 3. skill / goal / recovery 标「本轮相关」或「另票，本轮不修」 — 谁检查: 人
- [x] 4. 未跑会加载 FIX 并发改动文件的测试；未跑命令如实记录 — 谁检查: 本文件「命令」节

## 边界与不做

- 不修 fixture、不删断言、不 skip、不 commit、不新建 worktree、不 stash/reset。
- 不编辑 `docs/evals/20260922-browser-capability-parity.md`、`docs/STATUS.md`。
- 不以「失败集合没增加」「npm run check 全绿」「都是无关历史失败」作为结论。

---

## 0. 证据来源与计数校正

| 来源 | 内容 |
|---|---|
| 验收文档 §六 | 称 3013 过 / 33 败；分解为 click-integrity×22、hover-recovery×8、skill-session / task-goals / task-recovery-matrix 各 1；称与 HEAD worktree 同集 |
| `/tmp/bys-test2.log` | 同日全量 `npm run test:unit` 原始输出：`33 failed \| 3013 passed`；**逐项名单完整** |
| 当前测试文件 | `extension/test/click-integrity.test.ts` 含 **24** 个 `it`；`extension/test/hover-recovery.test.ts` 含 **7** 个 `it`（HEAD 同数） |

**计数校正（验收文档 vs 原始日志）：**

| 类别 | 验收文档声称 | `/tmp/bys-test2.log` 实测 |
|---|---:|---:|
| click-integrity | 22 | **24**（文件内全部失败） |
| hover-recovery | 8 | **6**（7 例中 6 败 1 过） |
| skill-session | 1 | 1 |
| task-goals | 1 | 1 |
| task-recovery-matrix | 1 | 1 |
| **合计** | **33** | **33** |

验收文档的 22/8 与原始失败报告不一致；**以 `/tmp/bys-test2.log` 为准**。总条数 33 一致，子类误计。仓库 `out/`、其他验收 md **未**另存这份全量失败名单；名单本身不缺失，但验收文档未逐项抄录。

---

## 1. 逐项失败名单（33）

### 1.A click-integrity（24）— 本轮相关，须在 CAP/FIX 时恢复有效回归

文件：`extension/test/click-integrity.test.ts`  
共同错误（24/24）：`SyntaxError: Cannot use import statement outside a module`  
栈顶：`installPage` → `runInThisContext(transformSync(domops.ts, { loader: "ts" }).code)`（约 L173）

| # | 测试名（describe › it） | 断言在等什么（未到达） | 原因类别 |
|---:|---|---|---|
| 1 | B1 › 真实 release 返回后才显示已点击，且没有高亮或波纹固定等待 | cursor `endAction` 在 release 后才为 `done`；无固定高亮等待 | 构建/stub 与源码不一致 |
| 2 | B1 › 目标被覆盖时结束为失败，不播放已点击反馈 | 覆盖时失败反馈，非「已点击」 | 同上 |
| 3 | B1 › release 回执失败只能显示结果待确认，不能显示已点击 | release 失败 → unknown/待确认 | 同上 |
| 4 | B1 › 计数按钮一次 click 调用只触发一次处理器，不能 dispatchEvent(click)+HTMLElement.click 双发 | DOM 回退路径 clickCount===1 | 同上 |
| 5 | B1 › CDP mousePressed 已成功后 mouseReleased 失败，不得再走 DOM 点击 | 已 press 后异常不补 DOM 点 | 同上 |
| 6 | B1 › CDP 从一开始就不可用时，仍允许 DOM 回退一次，且只一次 | debugger 不可用 → 恰一次 DOM 回退 | 同上 |
| 7 | B1 › CDP 已开始输入但按下是否送达未知时，返回明确不确定，不当作未执行去补点 | mouseMoved 后失败 → 不确定文案，不补点 | 同上 |
| 8 | B3 › CDP 路径遇 debugger 不可用时回退 domops，AX ref 只被 DOM 点击一次 | AX+debugger 不可用 → 一次 DOM | 同上 |
| 9 | B3 › AX ref 普通失效（非 debugger 问题）不回退 DOM 点击 | 普通失效拒绝，无 DOM 回退 | 同上 |
| 10 | B3 › AX ref 确认阶段报遮挡时不回退 DOM 点击 | 遮挡拒绝，无 DOM 回退 | 同上 |
| 11 | B2 › 目标移动后点击新坐标，不点原坐标处的另一个按钮 | confirm 后点新坐标 | 同上 |
| 12 | B2 › 真实 mouseMoved 触发目标移走后，拒绝按下，不追逐新坐标、不打中 trap | hitTest 拒绝，trap 未点 | 同上 |
| 13 | B2 › 目标被覆盖时拒绝点击，不 force 点遮挡物 | 覆盖拒绝 | 同上 |
| 14 | B2 › 目标重渲染失效后拒绝，不默选同名按钮 | 失效拒绝，不点 twin | 同上 |
| 15 | B2 › 仅坐标无法证明对象时不把操作标成已确认安全，危险名仍走确认边界 | held/确认边界 | 同上 |
| 16 | B2 命中身份 › elementFromPoint 落到祖先/body 时 confirmForClick 与 hitTestAt 拒绝（含 pointer-events:none） | confirm/hitTest 拒绝祖先 | 同上 |
| 17 | B2 命中身份 › 命中目标内部子节点时允许 | 子节点命中允许 | 同上 |
| 18 | B2 命中身份 › 命中目标 shadow 内节点时允许，不能靠任意祖先放行 | shadow 内命中允许 | 同上 |
| 19 | B2 命中身份 › AX/shadow 内按钮：document.elementFromPoint 返回外层 host 时，仍应命中内部目标，且不靠祖先 contains 放行 | host 下刺入目标 | 同上 |
| 20 | B2 命中身份 › AX ref 路径执行页面内确认函数：host 命中且 shadow 内仍是该按钮则可点 | AX 路径页面确认可点 | 同上 |
| 21 | B2 纯坐标 › 视口外或非有限坐标明确失败，不派发点击 | 无 `Input.dispatchMouseEvent` | 同上 |
| 22 | B2 纯坐标 › 坐标处没有对象时明确失败 | 无对象拒绝 | 同上 |
| 23 | B2 纯坐标 › mouseMoved/视觉等待后坐标处对象被替换则拒绝，不点新对象 | 替换拒绝 | 同上 |
| 24 | B2 纯坐标 › 同一 canvas 元素在坐标处保持则允许点击，不假装识别画布内部业务 | 同 canvas 允许 | 同上 |

**因果（事实 → 推断）：**

- **事实：** fixture 用 `esbuild.transformSync(..., { loader: "ts" })` + `vm.runInThisContext` 注入 `extension/src/content/domops.ts`，**不打包依赖**。
- **事实：** HEAD 起 `domops.ts` 已有 `import { replaceEditableText } from "../shared/editable-text.js"`；CAP 工作树又增加 `import { parseTarget, resolveTargetSelector } from "../shared/target.js"`。
- **事实：** 变换后的代码仍含 `import`，在非 module 的 `runInThisContext` 中抛 `SyntaxError`；**全部 24 例在装页阶段失败，未执行到 click/CDP/DOM 行为断言。**
- **推断：** 主因是 **fixture/stub 与源码形状不一致**（假定 domops 是无 ESM import 的自包含脚本）。这不是「点击语义断言失败证明的生产回归」；当前日志**不能**证伪/证实 click 生产行为本身。
- **与 CAP 关系：** 统一 target 加剧了对 import 的依赖，但失败模式在 HEAD（已有 editable-text import）即可出现；验收文档「与 HEAD 同集」与此相容。仍属 **本轮相关路径**（click / 定位 / hover 共用 `input` + `domops` + `target`），**必须修复 harness 或改注入方式后恢复有效定点回归**，不能因「非新增失败」忽略。

生产函数：`extension/src/background/exec/input.ts` 的 `click` / 确认与 hitTest 路径；页面侧 `domops`（`confirmForClick` / `hitTestAt` / `click`）；定位 `extension/src/shared/target.ts`。

### 1.B hover-recovery（6 败 + 1 过）— 本轮相关

文件：`extension/test/hover-recovery.test.ts`

| # | 测试名 | 结果 | 原因类别 | 证据 |
|---:|---|---|---|---|
| 1 | 定位错误可恢复 › 多个 CSS 匹配拒绝点击和悬停，使用明确 ref 后才能继续 | FAIL | 构建/stub 与源码不一致 | 同 click：`installPage` L51 `SyntaxError`；未跑到「匹配 2 个元素」/`hover({target:"@7"})` 断言 |
| 2 | 定位错误可恢复 › 本次 loc=h3:has-text 错误给出支持格式和下一步，绝不派发点击 | FAIL | 同上 | 同上；断言本应拒绝 Playwright 式 loc 且 `sendCommand` 未调用 |
| 3 | 定位错误可恢复 › 失效 ref 不改绑，重新 snapshot 登记的新 ref 可以继续 | FAIL | 同上 | 同上；断言本应旧 ref 抛 / 新 ref 可用 |
| 4 | 真实 hover › 协议暴露 hover，并遵守接管闸门 | **PASS** | — | 不调用 `installPage`；只查 `TOOL_NAMES`、`ControlGate.takeover`、`describeTool("hover",…)` |
| 5 | 真实 hover › 元素悬停只派发 CDP mouseMoved，保留 worker 标签和光标 | FAIL | 构建/stub 与源码不一致 | `installPage` SyntaxError；断言本应 `sendCommand(…, mouseMoved, {x:50,y:40})` 且 cursor.move |
| 6 | 真实 hover › CDP 不能悬停时明确失败，不把虚拟光标或合成事件当成功 | FAIL | 同上 | 本应 reject `debugger occupied` |
| 7 | 真实 hover › AX ref 经当前节点解析后悬停；过期节点要求新快照 | FAIL | 同上 | 本应先 hover 成功、再因 No node 要求新 snapshot |

验收文档写「hover-recovery×8」：**名单缺口（文档误计）**；文件仅 7 例，日志 6 败。不另编造第 8 个名字。

生产函数：`input.hover`（含 `assertObservedDocument`、`resolvePointerTarget`、CDP `mouseMoved`）；定位错误路径与 click 共用 `domops` / `target`。

### 1.C skill / goal / recovery（3）— 另票，本轮不修

| # | 测试名 | 断言失败 | 与点击/悬停/定位/上传授权/CDP 闸门 |
|---:|---|---|---|
| 1 | `agent/test/skill-session.test.ts` › T02 任务视图：自动技能回放期间沿用真实任务身份与页面，结束后只读收敛为 idle | `getTaskProgress(...).results` 期望 length **3**，实得 **10**（L266） | **无关** → 另票。任务结果自动记账 / 技能回放视图；不经 extension input/hover/upload/cdp |
| 2 | `agent/test/task-goals.test.ts` › 审计完整性不能把成功的通用脚本冒充没有其他变更 | `executionAuditComplete` 期望 **false**，实得 **true**（L154）；`js` 成功执行后仍标审计完整 | **无关** → 另票。TaskProgress 审计语义；同见 `docs/evals/20260922-automatic-result-registration.md` / voice-feedback 在途记录 |
| 3 | `agent/test/task-recovery-matrix.test.ts` › keeps an interrupted auxiliary script uncertain although it had no result slot | `untrackedWritePending` 期望 **true**，实得 **undefined**（L129） | **无关** → 另票。中断辅助脚本未知写标记；任务恢复矩阵，非浏览器输入路径 |

---

## 2. 汇总标签

| 标签 | 条数 | 说明 |
|---|---:|---|
| 本轮相关，须在 CAP/FIX 时恢复有效回归 | **30** | click-integrity 24 + hover-recovery 6；先修 vm/esbuild 注入（打包 target/editable-text 或改加载方式），再跑通行为断言；通过前不得宣称点击/悬停回归有效 |
| 另票，本轮不修 | **3** | skill-session / task-goals / task-recovery-matrix |
| 名单缺失 | **0**（逐项名） | 原始日志齐全；验收文档缺逐项抄录且 22/8 误计（记为文档缺口，不是失败项无名） |
| 本会话通过的 hover 例（不计入 33） | 1 | 「协议暴露 hover，并遵守接管闸门」 |

**禁止误读：**

- 不能说「失败集合没增加所以可以放行」——30 项本轮相关路径的回归**当前无效**（装页即崩）。
- 不能说「npm run check 全绿」。
- 不能把 click-integrity 整包标成「无关历史失败而忽略」。

**尚未用本日志证明的事项：**

- 修好 harness 之后，`assertObservedDocument`、effect ack、CAP 新增 double_click/drag 等是否再让行为断言失败——**未知**；需 harness 修复后的定点复跑（避开 FIX 并发写文件时段）。

---

## 3. 命令（本会话）

| 命令 | 结果 |
|---|---|
| 全量 `npm test` / `npm run test:unit` | **未跑**（任务禁止；且避免污染 FIX 并发文件） |
| 定点 `click-integrity` / `hover-recovery` | **未跑**（加载 `input.ts`/`domops.ts`/`target.ts`/`protocol`/`steps`；与 CAP 在途改动重叠，无把握与 FIX 文件完全无关） |
| 定点 skill/goal/recovery | **未跑**（归因已足够；非本轮修复范围） |
| 只读检索 | 使用已有 `/tmp/bys-test2.log`、`/tmp/bys-test.log`、验收 md、`git show HEAD:…/domops.ts`、当前测试与 `input.ts`/`target.ts`/`domops.ts` diff |

---

## 4. 给后续票的可操作结论

1. **REG 修复入口：** 改 `click-integrity` / `hover-recovery` 的 `installPage`，使注入的 domops **带上** `shared/target`（及既有 `editable-text`）——例如 esbuild `bundle: true` + 合适 `format`，或改为 vitest 正常 import 生产模块并 stub 全局；**不要**为变绿删行为断言。
2. harness 恢复后，用同一 30 项作为 CAP 点击/悬停/定位回归门禁；若再失败，按断言重分类为「真实行为」或「observation/effect stub 缺口」。
3. 3 项任务台账失败交原所有者（结果自动登记 / 审计 / 恢复矩阵），不并入 FIX-01 上传或 CDP 闸门。

## 当前是否已满足：REG-01 对约 33 项失败完成逐项归因

**是**（只读归因交付完成）。修复与复绿不在本票范围。

---

## 装载修复后的复跑

**范围：** 仅修 `extension/test/click-integrity.test.ts` 与 `extension/test/hover-recovery.test.ts` 的 `installPage`：把 `esbuild.transformSync`（不打包）换成 `esbuild.buildSync({ bundle: true, format: "iife", platform: "browser" })`，再 `vm.runInThisContext`；两处同一种写法。未改产品源码、未删/skip/放宽断言。

**命令：**

```bash
npx vitest run extension/test/click-integrity.test.ts extension/test/hover-recovery.test.ts
```

| 项 | 结果 |
|---|---|
| 退出码 | **0** |
| 测试文件 | 2 passed |
| 用例 | **31 passed / 0 failed**（click-integrity 24 + hover-recovery 7） |
| 装载 `SyntaxError: Cannot use import statement outside a module` | **已消失** |
| 剩余行为断言失败 | **无** |

**结论：** 本票目标（装载故障消除）**达到**。原先 30 项「装页即崩、未执行行为断言」在 harness 修复后全部跑到断言且通过；本轮未观察到残留行为失败。skill / goal / recovery 三例仍属另票，未在本命令中复跑。
