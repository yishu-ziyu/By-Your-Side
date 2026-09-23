# 任务: 仓库只留下能护住核心功能和使用体验的测试与代码

## 背景与裁决

- 2026-09-23 用户：「把旧仓库里的垃圾代码清掉，尤其是垃圾测试」。裁决：深度选「E2E 优先」——真实路径能覆盖的行为，先有 E2E 再删对应单测；范围含游离 `.js`、`scripts/experiments/`、`scripts/acceptance/` 孤儿脚本、产品源码死代码；另一个会话改过的文件也一起清。补充：「保留自己的智能判断：一切都是为了让产品的核心功能和使用体验变得更好」。
- 上一轮只做了高置信度清理：[测试园艺](20260922-test-gardening.md)，净减 2,406 行。本轮在它的基础上继续，不推翻它保留的边界，除非有新证据。
- 起点：单元测试 298 个文件 / 49,165 行；`scripts/acceptance` 137 / 32,896；`scripts/experiments` 22 / 4,178；`scripts/eval` 17 / 1,920；未跟踪且与 `.ts` 同名的 `.js` 32 个。
- 基线：`npx vitest run` 3,209 项，3,206 通过，3 失败（`out/cleanup/baseline-failures.txt`）：`task-goals.test.ts` 审计完整性、`task-recovery-matrix.test.ts` 辅助脚本中断、`performance/task-receipt-scale.test.ts` 事件循环 p95（计时类）。无加载失败。真实路径样板用例最近 3/3 通过。

## 判据（删不删，只问对核心功能和体验有没有用）

- 删：只断言内部写法、调用次数、内部数组长度或快照的；期望值由被测实现自己算出的；被测功能已不存在或只被测试自己养着的；与真实路径 E2E 断言同一外部结果的重复单测；没有入口、没有引用、结论已写进文档的一次性脚本。
- 留：用独立 oracle 护住用户能感受到的结果，且 E2E 目前覆盖不到或代价过高的——安全边界（权限、沙箱、未知写入不重放）、恢复、幂等、协议兼容、数据不丢；正式入口（`package.json` 脚本、`scripts/acceptance/README.md` 列出的）和发布门禁。
- 拿不准的：保留，列进「待补 E2E」清单，写明补哪条真实路径用例后可删。

## 失败方式（先写）

1. 删了被 `.js` 扩展名导入的 `.ts`（上一轮踩过）→ 测试或构建加载失败。
2. 删了 `package.json` 脚本、正式验收入口或其他保留脚本依赖的文件。
3. 删了当前 STATUS/验收结论赖以复现的脚本（历史文档引用不算）。
4. 删了某个安全/恢复边界的唯一守护测试，而 E2E 没覆盖。
5. 删产品死代码时误判：动态导入、字符串注册（工具名、消息类型）、manifest 引用、content script 注入路径。
6. 删游离 `.js` 后，扩展构建改用较新的 `.ts`，行为变化让真实路径失败——这属于暴露真问题，要修或报告，不能靠恢复 `.js` 掩盖。
7. 清理后失败集合变大，或出现加载失败。

## 完成标准

- [x] 1. 32 个游离 `.js` 删除；隔离构建的扩展不再包含任何游离 `.js`；样板用例通过。— 谁检查: 构建 metafile + 样板脚本
- [x] 2. 每个删除的脚本/测试/源码文件在本文件有一行理由（按判据分类）；拿不准的进「待补 E2E」清单。— 谁检查: 人读本文件（按类归并；拿不准的都保留，列在「仍未处理」）
- [x] 3. 产品死文件：不在扩展构建入口、伴随进程 `main.ts`、正式脚本的打包图里，也不被动态导入/manifest 引用的，删除（只被测试引用的连同其测试一起删）。— 谁检查: esbuild metafile 可达性 + typecheck
- [x] 4. 每阶段后：`npm run typecheck`、`npm run check:architecture` 通过；`npx vitest run` 无加载失败，失败 ⊆ 基线（被删测试除外）；`npm run build` 到临时目录成功。— 谁检查: npm
- [ ] 5. 收尾：真实路径样板用例在最终代码上通过；日常 `extension/dist` 与清理后源码一致地重建。— 谁检查: 样板脚本（3 条都曾通过；动效默认值收进共享模块后 `mark-motion-toggle` 超时未解；日常 dist 构建于 13:06，早于该重构）。修订（下午）：超时已查明并修复，3 条在最终代码上全过（`…06-05-40-567Z-mark-motion-toggle`、`…06-09-25-427Z-codename-no-save`、`…06-10-47-183Z-voice-page-question`）；仍差日常 dist 重建，等用户同意
- [x] 6. 行数与文件数前后对比写入结果。— 谁检查: 脚本统计

## 边界与不做

- 不删 `docs/`、`out/`、原始评测证据。
- 不改产品行为；清理暴露的真问题单独记录、单独修。
- 不追求行覆盖率，也不设删除行数指标。

## 结果

每阶段后的检查产物在 `out/cleanup/`（`p*-vitest.json` 用 `node out/cleanup/compare.cjs <文件>` 和基线比）。

### 阶段 1–3：游离 `.js`、已结束实验、孤儿脚本

- 删 `shared/` 下 32 个未跟踪、与 `.ts` 同名的 `.js`（`tsc` 误产出；esbuild 优先取 `.js`，会让扩展打包旧逻辑）。隔离构建与样板用例通过。
- 删 `scripts/experiments/` 全部 31 个文件（5,163 行）：均无 `package.json` 入口，结论已写入对应验收/日志。
- 删 91 个验收/评测/夹具脚本（17,126 行），清单 `out/cleanup/scripts-deleted-list.txt`。统一理由：无 `package.json` 入口、不在 `scripts/acceptance/README.md` 保留清单、不被保留文件导入或按文件名引用、`STATUS.md` 当前结论不依赖。保留的孤儿脚本及理由见本轮会话记录（正式入口的依赖、STATUS 仍引用的复现脚本、声明文件）。

### 阶段 4：产品死代码

判定方法：以扩展构建入口和伴随进程 `agent/src/main.ts` 为起点做 esbuild 可达性（`out/cleanup/reach.mjs`），再用 knip 6.37.0 `--production` 查只有测试在用的导出（`out/cleanup/knip.json`）。

| 删除 | 理由 |
|---|---|
| `agent/src/mode.ts` 及 `teach-prompt.test.ts` | 生产不可达；该测试其余部分只断言提示词含某些字（改措辞即失败，模型是否照做不验证） |
| `shared/run-outcome.ts`、`shared/select-fill.ts` 及各自测试 | 只被测试引用 |
| 本地语音检测：`sidepanel/voice-speech.ts`、`voice-vad-worker.ts`、`voice-vad-model.ts`、`voice-speech.test.ts`、构建入口与 `vad/` 资源复制、3 个许可证、依赖 `@ricky0123/vad-web` `onnxruntime-web`（17 个包，`onnxruntime-web` 占 136 MB）、manifest 的 `'wasm-unsafe-eval'` | 9/20 起日常语音用 StepAudio 3 服务端断句；`voice-client` 里的分类器字段从未被赋值。只有它用 wasm，放行一并收回 |
| 5 个扩展测试里的 `vi.mock('voice-speech')` 和两条空断言（空数组上的 `every`、断言从未创建的分类器收到 0 帧） | 永远成立，不护任何行为 |
| 旧语音会话 `voice-session.ts`（1,521 行）、`streaming-tts.ts`、`voice-early.ts`、`voice-input-ledger.ts`、`voice-playback.ts`、`agent/src/voice-diagnostic.ts`、`voice-audio-cache.ts`；`voice-receipt.ts` 的 `contextualStartAck`/`receiptSpeech` | 日常只创建 `RealtimeVoiceSession`；这些只被旧会话或测试使用。两处借用旧会话类型的地方改成现役会话自己的类型；`VoiceService` 不再传现役会话不读的 `earlyReplies`/`captureMode`/`receiptAudioCache`/`steer`/`onSpokenAck` |
| 整删测试：`voice-session`、`voice-upstream-recovery-evaluator`、`agent/voice-diagnostic`、`live-dialogue`、`voice-lifecycle`、`user-delivery-speech-evaluator`、`voice-start-ack`、`voice-audio-cache` | 被测对象是上面删除的旧会话/模块，生产不存在这种组合 |
| 裁剪测试：`streaming-voice`（留 1 条）、`voice-load-boundaries`、`voice-listen-back`、`voice-greeting-regression`（留 7 条管理器用例）、`voice-single-proposal`、`voice-conversation-evaluator`、`voice-start-ack-evaluator`、`user-delivery-evaluator`、`user-delivery-runtime`、`voice-display-steering` | 只删驱动旧会话或断言已删函数的部分；测现役 `ConversationManager`/`VoiceService`/协议边界的保留。`voice-conversation-evaluator` 与 `voice-start-ack-evaluator` 标着「Boss-owned」，按用户本轮授权修改，此处单列 |
| 8 个无人调用的导出：`hasPendingDestructiveClick`、`dropAllPendingClicks`、`recordingTabId`、`demoHint`、`resetCursorStatusForTests`、`randomSeed`、`extractTarget`、`writeParamsFingerprint` | 生产与测试均无调用，且都在 9/18 以前引入。`recordingTabId` 的「示范中拦工具」已由 `demoRefusal` 更严地实现；按会话丢弃待确认点击仍由 `dropPendingClicks` 接线 |

检查：`typecheck` 通过；`check:architecture` 230 个生产文件通过；vitest 3,044 项、失败 2 项均在基线内、无加载失败；隔离构建成功（产物 1.7 MB，无 `vad/`）；样板用例 `2026-09-23T04-05-38-382Z-codename-no-save` 通过。

发现但未处理：

- 9/22 起在途的浏览器能力任务书（CAP/FIX）里有未接线的导出（`network-log` 的 `armFreshNetworkCapture` 等 4 个、`debugger` 的子帧会话 2 个、`page-events.pageEventLedger`）。是在途工作的半成品，不是旧垃圾，未删。
- `VoiceService` 构造参数 `steer`（`main.ts` 一直传 `undefined`）和 `onSpokenAck` → `ConversationManager.recordSpokenAck` 已无人调用；位置参数牵连 `main.ts` 与 8 个测试，未动。
- ~~现役实时语音没有真实路径 E2E~~ → 阶段 6 补上 `voice-page-question.mts`。

### 阶段 5：单元测试逐条判定

方法：6 个只读子代理按判据给出逐条意见，主代理对照测试原文（`out/cleanup/p5-review.txt`，1,158 行）逐条复核后裁决；子代理意见被推翻的照留。删除按语法树整条移除（`out/cleanup/remove-tests.mjs`，基于 ast-grep）。

| 删除 | 理由（判据） |
|---|---|
| `safety-prompt`、`session-planning`、`handback-constraint` 的系统提示词断言、`ask-selection` 的 EXPLAIN_PROMPT、`voice-intent` 与 `voice-single-proposal` 的「逐字一致/逐项同形」、`display-steering` 两条 STEER_CONTRACT_NOTE、`program-first`、`browser-initial-path` 各 1 条措辞断言 | 只断言提示词含某些字；改措辞即失败，模型是否照做不验证 |
| `highlight.test.ts` 整份 | 包围盒与 `overlay.test` 重复、颜色与 `cast.test` 重复，余下是本地函数自证 |
| `agent/test/handback-constraint.test.ts` | 与扩展端同名测试重复；它独有的 `[HANDOFF BOUNDARY]` 断言（`acceptance-model` 靠它识别交还续写）并入扩展端 |
| `control-gate` 交还续写 1 条 | 与 `handback-constraint` 逐字重复 |
| `effect.test` 的「模型可见的回执文案」4 条 | 与 `click-effect-text` 经真实 click 工具的断言重复；它独有的弱证据断言并入后者 |
| `foreign-takeover` 身份闸门 1 条 | 测的是测试内「等价复刻」的闸门，真实 `checkIdentity()` 改坏也照过 |
| `user-delivery-ui` 3 条 | 在测试里重写处理逻辑再测它自己 |
| `panel-history` 1 条 | 对象字面量和自己比 |
| `cliproxy` gemini 快照、`cast` 名册快照 2 条、`companion` SVG 快照、`attachments` 周长 194px | 只记录现状的快照 |
| `voice-load-boundaries` baseline、`voice-single-proposal` 3 条（与 `voice-intent`/`voice-model-plan-contract` 重复或恒真）、`user-delivery-facts` 的 `expect(base).toBeTruthy()` | 重复或恒真 |
| 产品死导出连同只测它们的测试：`reachable-models` 的 `REACHABLE_MODEL_IDS`/`filterReachableModels`，`selectors` 的 6 个问句，`rough` 的 `roughLine`/`chiselWash`/`variants`，`cursor-trail.viewportPoint`，`companion` 的 `PAW_OVERLAP`/`overlapsContent`，`grok-bot.lerpExpr`，`input.showUserControlBanner`，`tab-bindings` 的 `sessionForTab`/`boundTabIds`，`state.findSessionForTab`，`config.saveConfigModel`，`team-run.staleTeamForRun`，`voice-capture-store.clearVoiceCapture`，`session.AcceptanceContinuity`，`mode` 的 `setMarkMotion`/`hasPendingTeachMarks` | 生产无调用；只被测试养着 |
| 语音客户端残留：`VoiceTurnDetector`（`voice-signal.ts`）、`pcmBase64Large`、`voice-client` 里两处检测器实例、`prepareSpeech`、普通会话按轮留存音频（`beginCaptureTurn`/`finishCaptureTurn`/`captureContinuousFrame` 与 5 个字段）及 `voice-audio` 的检测器测试 | HEAD 里检测器就从不被喂音频（`prepareSpeech` 已丢弃分类器）；`captureContinuousFrame` 的调用条件与函数内判断互斥，永不执行。打断播放由服务端 `reset_output` 负责 |

保留（推翻子代理「删」的意见）：`click-effect-text`、`worker-page-mode`、`voice-model-plan-contract`、`consent-copy`、`browser-recovery-tools`、`cap02b-input-wiring`、`page-translation` 推理开销、`partial-delivery-claims` 核验开销、`realtime-voice-session` 路由影子、`session-management-contract`、`acceptance-lane`、`acceptance-team`、`skill-compile`、`task-result-turn-economy`、`tool-surface`、`upload-paths`、`voice-model` 请求头与 token、`overlay` 用户定下的尺寸与配色、`steps`、`voice-diagnostic`、`click-robustness` 隐式确认接线、`demo-session` 后台观察块（与 `observe.test` 不同层）。它们护的是外部代价、安全边界、用户裁决过的设计或接线。`harness-*-evaluator` 可能归 Boss，`cap02c-locator`、`page-event-lifecycle` 是在途工作，未动。`user-delivery-runtime` 被指 9 条重复，未逐条核实覆盖，默认保留。

检查：`typecheck` 通过；vitest 2,990 项，失败 2 项均在基线内，无新失败（`out/cleanup/p5b-vitest.json`）。

### 清理暴露并修掉的两个真问题

1. **圈画动效与提示不符。** 侧栏默认写「持续微抖」，后台默认却按 grow 画，且后台缓存了偏好，右击切换后仍画旧的。先写 `real-path/mark-motion-toggle.mts`，修复前 2 项 no（`out/acceptance/real-path/2026-09-23T04-18-54-743Z-mark-motion-toggle`）。修法：后台默认改为 boil、每次现读 storage（`extension/src/background/mode.ts`），侧栏默认同为 boil。修复后全 yes（`…04-21-14-702Z-mark-motion-toggle`）。
2. **语音读不到表单里的字。** 新写的语音用例问「这个页面上的备注写的是什么」，页面文本框里是「周五前发货」，语音答「备注内容本身是空的」（`…05-00-45-494Z-voice-page-question`）。原因：`voice-observation.ts` 只收可见文字节点；文本框内容取不到版面矩形被当成不可见，用户填写的 `.value` 也不是文字节点。修法：遍历时收可见的输入框、文本框、下拉框的当前值（排除密码、隐藏、复选、按钮、文件），不再读文本框的默认文字。修复后连续两次答「页面上的备注写的是：周五前发货。」（`…05-03-39-333Z-…`、`…05-04-21-387Z-voice-page-question`）。

### 阶段 6：收尾

- 新增真实路径语音用例 `scripts/acceptance/real-path/voice-page-question.mts`：`say` 合成的中文 WAV 当麦克风，真侧栏点「语音」，StepAudio 3 服务端断句、真伴随进程、`read_page` 读练习页。判定：进入聆听、识别出问题、回答含页面原文、无错误、伴随进程随 Chrome 退出。驱动 `launchRealPath({ microphoneWav })` 加了假麦克风参数；macOS 上必须 `--disable-features=AudioServiceSandbox`，否则音频服务读不了文件、麦克风全是静音（探针对照：默认假设备有提示音，文件模式 40 个采样全 0，关沙箱后说话段有电平）。
- 三条真实路径用例都曾在清理后的代码上通过：`2026-09-23T04-47-03-992Z-codename-no-save`、`2026-09-23T04-48-07-154Z-mark-motion-toggle`、`2026-09-23T05-04-21-387Z-voice-page-question`。
- **未决**：13:11 把动效键名、类型、默认值收进 `extension/src/shared/mark-motion.ts`（侧栏与后台共用）之后，`mark-motion-toggle` 连续 4 次在第一句「圈出保存按钮」超时（240 秒）：侧栏显示两次「请求失败，正在重试」，随后卡在「正在读回多个元素」3 分 49 秒（`…05-22-15-120Z-mark-motion-toggle/panel-failed.png`）。同时段 `codename-no-save` 通过（`…05-27-15-942Z`），模型服务可用。原因未查明，不能把这次重构记为通过。用例已改为失败时保存侧栏截图、对话文字、伴随进程日志和数据目录。另：05:17 与 05:31 两次运行和修改文件放在同一批并行调用里，跑的是改到一半的脚本，不算有效证据。
  - **已查明（修订，2026-09-23 下午）**：不是重构造成的。轨迹显示标注第 3 轮就画好了，之后模型一直用页面选择器找封闭 shadow root 里的标注，找不到，复核又不认回执，于是空转到超时；此前两次通过是复核判得松。修法是让宿主读标注层作为核验证据，改完连续 4 次通过。详见 [圈画完成证据](20260923-mark-completion-evidence.md)。上面「原因未查明」一句保留作记录。
- `typecheck` 通过；`check:architecture` 230 个生产文件通过；vitest 2,989 项，失败 2 项均在基线内，无新失败，无加载失败（`out/cleanup/p6-vitest.json`）。
- 日常 `extension/dist` 于 13:06 按清理后源码重建。未重载日常扩展、未重启日常伴随进程：语音读表单的修复在后台脚本里，重载扩展后生效；伴随进程的改动（删死代码）重启后生效。

前后对比（`bash out/cleanup/stats.sh`，HEAD 对当前工作区；工作区含并行会话未提交的改动）：

| 范围 | 文件 | 行 |
|---|---|---|
| 单元测试 `*.test.ts` | 313 → 297 | 48,145 → 44,910 |
| `scripts/acceptance` | 144 → 62 | 33,833 → 18,596 |
| `scripts/experiments` | 31 → 0 | 5,154 → 0 |
| `scripts/eval` | 17 → 13 | 1,916 → 1,359 |
| 产品源码 `agent/src` `extension/src` `shared` | 243 → 230 | 69,204 → 66,963 |

删除文件清单：`out/cleanup/deleted-files.txt`（154 个已跟踪文件，另有 32 个未跟踪的游离 `.js`）。依赖少了 17 个包（`onnxruntime-web` 136 MB）。

仍未处理：

- `stopSessionPageEvents`（commit 1e3ae6f，CAP-02 在途）未接线：会话停止时不释放 filechooser 拦截等页面事件。属在途工作，交给对应任务。
- 上面「发现但未处理」的 CAP/FIX 未接线导出、`VoiceService` 的 `steer`/`onSpokenAck` 位置参数。
- `user-delivery-runtime` 9 条疑似重复未核实。
