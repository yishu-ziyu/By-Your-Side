# 任务: 用户在侧栏说一句话，助手更快在浏览器里做完；没人用的半成品与预判从代码里删掉

起因（用户裁决，10-04）：产品只做好一件事——侧栏一句话，助手在浏览器里快速做完。17 次日常运行 + 112 次评测运行的记录里，下列功能没被用到、到不了，或花时间却没有收益证据。删代码，不加开关。

## 规则

- R1 模型看到的工具与提示词里不再有已删除的能力。
  - 例子(正)：只装扩展的会话第一次请求里，工具从 45 个降到 30 个，没有技能、`task_goals`、`capture_page_material`、`ask_user_to_point`、`cdp`、拖拽与按住类输入、下载查询/取消/删除；`browser_run` 没有 `api:"playwright"` 与对应方法。 — 谁检查：`scripts/probes/model-surface.mts --headless`（前后读数）；`agent/test/extension-runtime-tools.test.ts`、`agent/test/tool-surface.test.ts`
  - 例子(反)：圈画 `mark` 仍在——语音的固定工具表用它（`realtime-browser-tool-defs.ts`），不是只有指导模式和快捷定位在用。 — 谁检查：同上（active 清单含 `mark`）
- R2 新任务发出前只读一次当前页，不再先走技能快捷路径、翻译与定位的意图预判。
  - 例子(正)：读页超时 4 秒就不带页面直接发，不会再读第二次（改前快捷路径与普通路径各读一次，慢页面多等 8 秒）。 — 谁检查：`agent/test/browser-initial-path.test.ts`
  - 例子(反)：读页途中用户停止或改口，迟到的页面不再发起主模型调用。 — 谁检查：同测试「a cancelled preparation…」
- R3 回答不等目标核对：主模型写完，正式回答马上交付、任务回到空闲；核对随后进行，判「没做完」才作为看得见的后续一轮接着做，判等用户/受阻/还差只更新「还差…」一行；每任务最多续做 2 次不变。
  - 例子(正)：核对请求被扣 5 秒时，正式回答在主模型写完后 27 ms 出现、130 ms 回到空闲，都早于核对放行（5139 ms）。 — 谁检查：`scripts/acceptance/real-path/answer-before-goal-check.mts --headless`
  - 例子(反)：同一脚本在改动前的代码上失败：回答与空闲都在 5150 ms，晚于核对放行的 5123 ms。 — 谁检查：同脚本在 `HEAD` 工作树上跑（结果另存，见结果节）
  - 例子(反)：核对期间用户停止、接管、补充或另发任务，这次核对作废、不续做。 — 谁检查：`agent/test/goal-check-blocked.test.ts`、`agent/test/offtopic-reply-diagnostics.test.ts`、`agent/test/main-effort-session.test.ts`
- R4 文字补一句接着做没做完的任务，按简单规则判断（等用户回话或助手上一句在问用户），不再调快速模型。 — 谁检查：`agent/test/conversation-manager.test.ts`、`agent/test/voice-multi-request.test.ts`
- R5 保留项照常：语音（含自定义人设）、整页翻译工具、记忆、结果不确定锁、原地打转停下、连续失败停下、思考档升档、模型换快速模型、接管/交还与 `take_tab`、划词工具条、文件卡片、`browser_run` 与 `saveFile`、任务回执与排队。 — 谁检查：`npm test`（2389 项）；真实路径 north-star N1/N2、script-friction、model-failover、data-to-file、dialog-recovery
- R6 扩展启动时清掉已删功能的旧存储（观察开关与它悄悄记下的页面骨架、指导模式、小伙伴开关、调试口令）；旧会话记录里的 `mode:"teach"` 读入按 `act`，不丢会话。 — 谁检查：`extension/src/background/index.ts` 顶层清理；`isConversationSummary` 接受旧值（人工核对）

## 还没答上的问题

- 无。用户已裁决删除范围；技术判断记在结果节。

## 技术前提

- 前提：脚本模型能把目标核对请求单独扣住，而不影响主任务请求。小实验：本机转发服务按请求体里的核对提示词前缀识别（`answer-before-goal-check.mts` 内）。结果：通过（核对请求在 137 ms 收到、5139 ms 放行，主任务请求不受影响）。
- 前提：在 git 工作树里跑旧代码做反例，构建打包的是工作树自己的源码。小实验：在旧代码里加一行日志，经 `watchInproc` 读到。结果：起初失败——`node_modules/@sideagent/*` 是 npm workspaces 链回主仓库的符号链接，打包的是新代码；改成工作树自己的链接后通过（见[经验](../knowledge/patterns/worktree-workspace-link-builds-main-tree.md)）。

## 边界与不做

- 不改 `TaskGoalBook`、`shared/control.ts` 的接管状态机与 `worker_tabs` RPC 名（接管/交还与 `take_tab` 仍用它们）。
- 不删 `grok-bot.ts`：页面光标的头像用它；只删侧栏小伙伴 M（`companion.ts` 与素材）。语音球保留。
- `eval:live` 命令保留：原 Node 套件已删，有预算时也如实报 BLOCKED，不改锁定评测文件。
- 不进日常构建、不重载日常 Chrome；只在隔离临时构建里验收。

## 结果（10-04）

| 读数（只装扩展、第一条主任务请求） | 改前 | 改后 |
| --- | --- | --- |
| 发给模型的工具数 | 45 | 30 |
| 工具定义总字符（JSON） | 54,045 | 35,360（−34.6%） |
| 系统提示词字符 | 14,790 | 14,113（−677：执行约定段、`download_stat`、助手相关句） |

- 代码：`git diff --shortstat`（未提交工作区对 `8c017c2`）：246 个文件，+1,044 / −31,290；其中产品源码（`agent/src`、`extension/src`、`shared`）+473 / −16,170，测试 +417 / −7,156，脚本 +175 / −7,928。
- 删除：技能（编译、快捷执行、学习、路由、存储、判断）与侧栏技能区；经历提取（`isUserCorrection` 移到记忆的 `memory-correction.ts`）；示范录制与观察（含页面脚本）；并行助手（Fleet 收成只管接管与 `take_tab` 的 `tab-control.ts`，邮箱、同页协作、`page_operation`、侧栏助手车道与协作进度）；Stagehand 兼容层与 `api:"playwright"`；上传与上传授权账本；本机会话循环、cliproxy、扩展外的评测/验收脚本（`live-suite`、P0 本地运行、用户旅程、`unknown-fill-chrome`、隔离能力套件、能力对齐）与 WebSocket 调试通道和侧栏口令页；快捷翻译、快捷定位、续接判断三个意图预判；`task_goals`、`capture_page_material` 与目标复核；指导模式（含页面事件）、`ask_user_to_point` 与点选页面脚本；小伙伴 M；`cdp`、拖拽、HTML5 拖放、滚轮、按住/松开、下载查询/取消/删除、粘贴与剪贴板桥；死文件 `skill-judge.ts`、`voice-capture-store.ts`；`document-file.ts` 只剩测试在用，移到 `agent/test/fixtures/file-document.ts`。
- 检查：`npm run typecheck` 通过；`npm run check:architecture` 通过（234 个生产文件）；`npm test` 单元 252 个文件 2389 项全过、性能 2 项全过；隔离构建 `SIDEAGENT_BUILD_DIST=out/builds/cut-unused` 通过；`npm run check:docs` 通过；`npm run lint:changed` 余 11 条——`extension/test/input-dispatch-approval.test.ts`、`native-dispatch-approval.test.ts` 改前就有的模块替身（HEAD 上同文件 22、15 条），本次只删了其中引用已删函数的用例。
- 真实路径（只装扩展、无头、脚本模型）：north-star N1、N2 通过（`out/acceptance/real-path/2026-10-04T13-03-29-033Z-north-star/`）；script-friction、model-failover、data-to-file、dialog-recovery 通过；新增 answer-before-goal-check 通过（`out/acceptance/real-path/2026-10-04T13-02-37-056Z-answer-before-goal-check/`），同脚本在改前代码上失败（结果另存 `out/cut-unused/answer-before-goal-check-OLD-CODE-result.json`）。改过的 pdf-download（7 项）、ux-fixes main 组通过；sidebar-header 9/10，失败项「真实断线时顶部出现连接状态」在改前代码上同样失败（10/11），不是本次引入。
- 未跑：memory-proactive（要真实 Kimi 模型，只删了一次点击已删除分段按钮的操作）；CI 的 e2e 工作流改跑真实路径用例，未在 Linux 跑过；真人试用。
- 读数产物：`out/cut-unused/surface-before.json`、`surface-after.json`（含完整系统提示词）。
