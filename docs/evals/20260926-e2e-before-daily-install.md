# 任务: 装进日常 Chrome 之前，当前 main 在隔离 Chrome 里沿用户路径跑通

2026-09-26，基线 `0c40421`，交付前变基到 `818778c`，分支 `fm/bys-e2e-r1`。起因：09-26 复盘发现 09-25 的修复只在隔离环境验过、没进日常 Chrome；干净的 macOS `npm ci` 起不了 vitest；`npm test` 退出码 1。用户要求：只认模拟真实使用路径的端到端，跑通再打 0.2.0，名字不动。

## 完成标准

- [x] 1. 干净 macOS arm64 `npm ci` 装上 `@rolldown/binding-darwin-arm64`，vitest 能启动 — 谁检查：临时目录 `npm ci` + `vitest` 退出码（卫生项，不算功能证据）
- [x] 2. `npm test` 退出码 0 — 谁检查：同一临时目录 `npm test`（卫生项）
- [x] 3. 打开侧栏、就当前页面聊天 — 谁检查：`everyday-baseline.mts --inproc`
- [x] 4. 让助手操作页面并看到结果 — 谁检查：同上
- [x] 5. 断线时发送：正文与引用保留、看得到「没发出去」（#4），恢复后重发能送达 — 谁检查：`offline-send-and-model-menu.mts`。首轮失败（扩展内 agent 重启后会话失效），按用户裁决先修（修订见下），修后 10/10
- [x] 6. 模型菜单里未知模型不显示猜出来的速度/可调档标签（#2） — 谁检查：同上
- [x] 7. 全部通过才把版本改成 0.2.0 — 已改，名字不动
- [x] 8. 写好装进日常 Chrome 的步骤 — 见文末

**修订（2026-09-26，用户裁决 A「先修这个，暂不打 0.2.0」）**：第 5 条首轮失败后，范围扩为修扩展内 agent 重启：会话不丢、重发保留正文和引用、不再显示 `CONVERSATION_NOT_FOUND`、之前的问答留在视图里；查普通会话是否同样失效；两种断线都重跑，全过才改版本。原判据不变。

## 边界与不做

- 不修端到端里发现的产品问题，只报告；不改名；不碰语音、Jev；不碰日常 Chrome 与其数据；不打 git tag。

## 卫生项

| 项 | 改前 | 改后 |
|---|---|---|
| 锁文件缺 `@rolldown/binding-darwin-arm64` | 干净 `npm ci` 后 `vitest` 报 `Cannot find native binding`，退出码 1 | `npm ci` 退出码 0，绑定已装，`vitest 4.1.11 darwin-arm64` |
| `delivery-receipt.test.ts` 的 chrome 替身缺 `storage.onChanged` | 6 项通过但有 1 个未处理错误，`npm test` 退出码 1 | `npm test` 退出码 0（3059 + 2 项） |

锁文件条目的 integrity 取自镜像源 `npm view @rolldown/binding-darwin-arm64@1.2.7`。同类缺口还有 `@mariozechner/clipboard-darwin-*`（pi-coding-agent 的可选依赖），不影响测试与构建，本轮不动。

## 端到端环境

全部在测试自己启动的无头 Chrome for Testing 里跑，只装扩展、不注册本机宿主，和日常 Chrome 停用本机宿主清单后的形态一致（`launchRealPath({ withoutNativeHost: true })`）。

- 路径 1、2：`npx tsx scripts/acceptance/real-path/everyday-baseline.mts --headless --inproc=stepfun/step-3.7-flash`。像用户一样从设置页填阶跃 key、测试、保存，再逐条发 10 条日常请求（用户已批准使用本机已配置的 key）。
- 路径 3、4：新增 `scripts/acceptance/real-path/offline-send-and-model-menu.mts`，一次跑 5 项：模型菜单、两种会话的 agent 重启、两种断线发送。设置页选「自定义」，填一个本机假 OpenAI 兼容地址和模型名 `unseen-model-7x`，另给 OpenAI 填一把假 key（不发请求）。假服务只替代模型回答，界面、连接、划词、交接都是真的。不需要凭据。

## 路径结果（最终代码，已变基到 `818778c`）

| 路径 | 结果 | 用户看到什么 | 截图 |
|---|---|---|---|
| 1 就当前页聊天 | 通过（问答 6 条全过） | 「这篇文章的核心观点是什么？」给出观点和两组数字；问岗位名与城市只答这两项 | [p1](assets/20260926-e2e-before-daily/p1-page-gist-panel.png) |
| 2 操作页面 | 通过（翻译、圈画、开新标签、复制不保存 4 条全过） | 「圈出五小时用量」一个框圈住名称和 32%；翻译后页面出现中文；复制不保存原文进草稿框、没点保存 | [页面](assets/20260926-e2e-before-daily/p2-mark-page.png)、[侧栏](assets/20260926-e2e-before-daily/p2-mark-panel.png) |
| 3 断线发送（#4） | 通过（修后连续 10 轮全过） | 见下 | 见下 |
| 4 模型菜单（#2） | 通过（修前修后每轮都过） | 默认视图只有 `unseen-model-7x`，点「显示全部」后 OpenAI 38 个、阶跃、自定义都没有能力标签；芯片上也没有 | [常用](assets/20260926-e2e-before-daily/p4-1-model-menu.png)、[全部](assets/20260926-e2e-before-daily/p4-2-model-menu-all.png) |

路径 1、2：阶跃日常 10 条 10/10，两轮（09-25 基线 `0c40421`；变基后最终代码 `out/acceptance/real-path/2026-09-26T05-47-01-450Z-everyday-baseline-inproc/`）。**耗时不作结论**：第二轮跑时机器负载很高（紧接着测得 load average 212，8 核），首轮负载未记录。

### 路径 3：修前

步骤：网页上用鼠标划一句 → 页内「解释」→「在侧栏继续」→ 侧栏出现引用 → 输入一句话 → 断线期间按回车 → 恢复后再按回车。

- 扩展内 agent（offscreen）崩溃：断线当下 7/7 通过（正文、引用都在，出现「这条没有发出去…」）；恢复后重发 7/7 失败：正文和引用被清空，红字 `CONVERSATION_NOT_FOUND: <id>`，模型没收到（[截图](assets/20260926-e2e-before-daily/p3-before-agent-restart-retry.png)）。
- 普通会话：侧栏打开时的 `default` 会话能活下来；点「＋」新建的会话同样失效。阅读交接出来的会话也是「＋」这一类。
- 后台 worker 停机：有的轮直接送达，有的显示「任务中断了 · 继续」（[截图](assets/20260926-e2e-before-daily/p3-before-worker-interrupted.png)），有 1 轮这句交出去后既没显示也没送达、正文和引用都没了（静默丢失）。
- 另有 2 轮 agent 崩溃后 45 秒都没重连：offscreen 旧文档没关干净时重建失败，background 退到 WebSocket 调试通道，没有 token 就停在「未连接」，侧栏还显示一段技术原文。

### 路径 3：修了什么

1. **会话目录持久化**：新增 `ConversationPersistence` 接口；扩展内 agent 把会话摘要和阅读交接写进 IndexedDB `sideagent-conversations`，offscreen 重启后核心按它重建会话，侧栏的会话编号仍然有效，阅读交接重新交给会话（`extension/src/inproc/conversation-store.ts`）。模型上下文仍只在内存，重启后助手不记得之前聊过什么，已写进[使用说明](../guides/usage.md)。
2. **会话真找不到时说人话**：「这个会话在助手这边已经找不到了（助手可能刚重启过），这条没有发出去。请点右上角「＋」新建会话后再发。」（`agent/src/host-core.ts`）。修后 10 轮里没有再出现，这句话本身没有在真实路径上触发过。
3. **offscreen 重建失败按退避重试**，不再停在「未连接」（`extension/src/background/uplink.ts`）。
4. **交出去但后台没收到的一条放回输入框**：侧栏记住最后交出的那条，重连同步后历史里没有它，就把正文、引用、附件放回并提示「没有发出去」；还在侧栏队列里的消息会补发，不算丢失（`extension/src/sidepanel/main.ts`）。「没发出去」提示改为每个会话各提示一次。

### 路径 3：修后

最终逻辑连续 10 轮（6 轮在变基前，3 轮变基后，1 轮在最后的整理之后）每轮 5 项全过：

| 场景 | 结果 |
|---|---|
| 侧栏打开时的会话：问一句 → agent 崩溃 → 接着问 | 10/10：第二问只送达一次，第一轮问答还在，没有错误字样 |
| 点「＋」新建的会话：同上 | 10/10（[截图](assets/20260926-e2e-before-daily/p3-6-plus-conversation-after-restart.png)） |
| agent 崩溃时带引用发送 | 10/10：断线当下正文、引用、提示都在（[截图](assets/20260926-e2e-before-daily/p3-2-send-while-disconnected.png)）；恢复后重发只送达一次、没有错误字样、之前的问答还在（[截图](assets/20260926-e2e-before-daily/p3-3-agent-restart-retry-fixed.png)） |
| worker 停机时带引用发送 | 10/10 最终只送达一次、没有丢失：1 轮直接送达；3 轮当场提示没发出去、正文留着；3 轮这句交出去后没到后台，重连后被放回输入框并提示（[截图](assets/20260926-e2e-before-daily/p3-4-worker-restored.png)）；3 轮回车时侧栏正短暂跳到别的会话，按在了空输入框上，没发出也没提示，切回来正文和引用还在。其余 9 轮都是用户再按一次回车后送达 |

修后另有 1 轮脚本在写结果前就退出（输出没留下，原因不明），1 轮因脚本判据时机（放回发生在检查之后）和提示只报一次的问题失败，后者已修。

## 发现的产品问题（未修）

1. **worker 停机时侧栏会短暂跳到别的会话再跳回。** 这期间按回车会按在别的会话的空输入框上，没有任何反馈。正文不丢（按会话保存的草稿），但用户会困惑。
2. **worker 停机碰上任务开头，任务可能被中断**（修前观察到，修后 10 轮没再出现）；提示写「与伴随进程的连接断了」，只装扩展时没有伴随进程，文案不对。
3. **复制不保存做对了却说没做完。** 页面结果正确，侧栏却写「仅交付部分结果…还有 1 项没完成：草稿输入框」并给「继续」（[截图](assets/20260926-e2e-before-daily/p2-copy-no-save-panel.png)）。
4. **`accept:journeys` 连不上。** 自 09-24 扩展内 agent 起，扩展找不到本机宿主时先走 offscreen，不再落到 WebSocket；该评测的宿主只在 WebSocket 上等（`eval/runs/journeys-smoke-2026-09-25T17-59-48-600Z/`）。本机宿主路径本轮没有端到端证据。
5. **扩展模式下重启后助手不记得之前的对话**（模型上下文只在内存）。会话和界面记录保留。

## 未跑

- `accept:isolated`（不调模型的浏览器能力回归，不是用户路径）；`accept:real-path` 全量；语音。
- 变基后没有再跑全量 `npm test`（机器负载高）；只单进程跑了相关的 5 个测试文件（60 项通过，负载 177 时第一次有 1 个文件超时失败，重跑通过）。
- 日常 Chrome 里的复验（按要求不碰）。

## 装进日常 Chrome 的步骤

1. 等 firstmate 把 `fm/bys-e2e-r1` 合进本地 `main`。
2. 在日常 Chrome 加载扩展的那个检出目录（`chrome://extensions` → By Your Side → 详细信息 → 来源）确认在 `main`，运行 `npm ci`（锁文件变了）和 `npm run build`，重新生成 `extension/dist/`。
3. `chrome://extensions` → By Your Side → 重新加载；关掉再打开侧栏；划词要用的网页刷新一次（旧标签页里没有新的内容脚本）。
4. 本机宿主清单**不用恢复**：这版在日常按「只装扩展」用，`NativeMessagingHosts/com.sideagent.host.json.disabled-purext-20260925` 保持停用。扩展 ID 不变，设置页里的阶跃、智谱配置会保留。想改回本机宿主模式时去掉 `.disabled-purext-20260925` 后缀并重载扩展；那条路径本轮没测（见问题 4）。
5. 装好后看：`chrome://extensions` 里 By Your Side 显示 0.2.0；侧栏顶部绿点「已连接」；「更多 → 模型与语音」写「正在使用：阶跃星辰 · step-3.7-flash」；打开一篇文章问「这篇文章的核心观点是什么？」应在几秒内回答。装之前已有的扩展模式会话没进过会话目录，第一次扩展内 agent 重启后仍会丢；装好后新建的会话才受保护。
