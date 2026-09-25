# 任务: 装进日常 Chrome 之前，当前 main 在隔离 Chrome 里沿用户路径跑通

2026-09-26，基线 `0c40421`，分支 `fm/bys-e2e-r1`。起因：09-26 复盘发现 09-25 的修复只在隔离环境验过、没进日常 Chrome；干净的 macOS `npm ci` 起不了 vitest；`npm test` 退出码 1。用户要求：只认模拟真实使用路径的端到端，跑通再打 0.2.0，名字不动。

## 完成标准

- [x] 1. 干净 macOS arm64 `npm ci` 装上 `@rolldown/binding-darwin-arm64`，vitest 能启动 — 谁检查：临时目录 `npm ci` + `vitest` 退出码（卫生项，不算功能证据）
- [x] 2. `npm test` 退出码 0 — 谁检查：同一临时目录 `npm test`（卫生项）
- [x] 3. 打开侧栏、就当前页面聊天 — 谁检查：`everyday-baseline.mts --inproc`
- [x] 4. 让助手操作页面并看到结果 — 谁检查：同上
- [ ] 5. 断线时发送：正文与引用保留、看得到「没发出去」（#4） — 谁检查：`offline-send-and-model-menu.mts`。断线当下通过；扩展内 agent 重启后重发失败，见下
- [x] 6. 模型菜单里未知模型不显示猜出来的速度/可调档标签（#2） — 谁检查：同上
- [ ] 7. 全部通过才把版本改成 0.2.0 — 第 5 条有失败，待裁决
- [x] 8. 写好装进日常 Chrome 的步骤 — 见文末

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
- 路径 3、4：新增 `scripts/acceptance/real-path/offline-send-and-model-menu.mts`。设置页选「自定义」，填一个本机假 OpenAI 兼容地址和模型名 `unseen-model-7x`，另给 OpenAI 填一把假 key（不发请求）。假服务只替代模型回答，界面、连接、划词、交接都是真的。不需要凭据。

## 路径结果

| 路径 | 结果 | 用户看到什么 | 截图 |
|---|---|---|---|
| 1 就当前页聊天 | 通过（10 条里的问答 6 条全过） | 「这篇文章的核心观点是什么？」3.8 秒给出观点和两组数字；岗位名与城市 3.3 秒 | [p1](assets/20260926-e2e-before-daily/p1-page-gist-panel.png) |
| 2 操作页面 | 通过（翻译、圈画、开新标签、复制不保存 4 条全过） | 「圈出五小时用量」6.6 秒，一个框圈住名称和 32%；翻译 25 秒；复制不保存 44 秒 | [页面](assets/20260926-e2e-before-daily/p2-mark-page.png)、[侧栏](assets/20260926-e2e-before-daily/p2-mark-panel.png) |
| 3 断线发送（#4） | **部分失败** | 见下 | 见下 |
| 4 模型菜单（#2） | 通过（默认视图 7/7 轮，「显示全部」视图 3/3 轮） | 默认视图只有 `unseen-model-7x`，点「显示全部」后 OpenAI 38 个、阶跃、自定义都没有能力标签；芯片上也没有 | [常用](assets/20260926-e2e-before-daily/p4-1-model-menu.png)、[全部](assets/20260926-e2e-before-daily/p4-2-model-menu-all.png) |

路径 1、2 产物：`out/acceptance/real-path/2026-09-25T17-54-42-402Z-everyday-baseline-inproc/`（10/10，设置页导出记录 10 个会话、288 行）。

### 路径 3：两种断线分别跑

步骤：网页上用鼠标划一句 → 页内「解释」→「在侧栏继续」→ 侧栏出现引用 → 输入一句话 → 断线期间按回车 → 恢复后再按回车。

| 断线方式 | 断线当下 | 恢复后 |
|---|---|---|
| 扩展内 agent（offscreen）崩溃 | 通过，7/7：正文、引用都在，出现「这条没有发出去：与后台的连接断了。正文和引用都还在…」，没有冒出已发送消息，模型没收到 | **失败，7/7**：重发时侧栏先显示这句（正文和引用被清空），随后红字 `CONVERSATION_NOT_FOUND: <id>`，之前的问答也从视图里消失；模型没收到 |
| 后台 service worker 停机 | 侧栏按设计先排队、换端口后补发，不显示「没发出去」 | 7 轮里 3 轮直接送达且只送一次；其余显示「任务中断了 · 继续」和「与伴随进程的连接断了」，点一次「继续」后送达（测了 1 轮） |

截图：[草稿与引用](assets/20260926-e2e-before-daily/p3-1-draft-with-quote.png)、[断线时发送](assets/20260926-e2e-before-daily/p3-2-send-while-disconnected.png)、[agent 重启后重发](assets/20260926-e2e-before-daily/p3-6-agent-restart-retry.png)、[worker 停机直接送达](assets/20260926-e2e-before-daily/p3-3-worker-restart-delivered.png)、[worker 停机后中断](assets/20260926-e2e-before-daily/p3-4-worker-restart-interrupted.png)、[点继续后](assets/20260926-e2e-before-daily/p3-5-worker-after-continue.png)。

## 发现的产品问题（未修）

1. **扩展内 agent 重启后，当前会话失效。** 事实：offscreen 文档关掉再拉起后，侧栏仍停在原会话；发送被接受后报 `CONVERSATION_NOT_FOUND`。机制推断：扩展内核心的会话只在内存里，重启后没有这个会话，侧栏也不知道。用户后果：#4 保住的正文和引用在重发那一步被清掉，同时出现看不懂的错误码。已验证的是阅读交接出来的会话；普通会话是否同样失效未单独验。
2. **worker 停机碰上任务开头，任务被中断。** 约一半概率要用户点「继续」；提示写「与伴随进程的连接断了」，而这时根本没有伴随进程，文案不对。
3. **复制不保存做对了却说没做完。** 页面结果正确（原文进草稿框、未保存），侧栏却写「仅交付部分结果…还有 1 项没完成：草稿输入框」并给「继续」（[截图](assets/20260926-e2e-before-daily/p2-copy-no-save-panel.png)）。
4. **`accept:journeys` 连不上。** 自 09-24 扩展内 agent 起，扩展找不到本机宿主时先走 offscreen，不再落到 WebSocket；该评测的宿主只在 WebSocket 上等，报「等待超时：host connected」（`eval/runs/journeys-smoke-2026-09-25T17-59-48-600Z/`）。属于评测工具过期，本机宿主路径本轮没有端到端证据。

## 未跑

- `accept:isolated`（不调模型的浏览器能力回归，不是用户路径）；`accept:real-path` 全量；语音。
- 日常 Chrome 里的复验（按要求不碰）。

## 装进日常 Chrome 的步骤

1. 等 firstmate 把 `fm/bys-e2e-r1` 合进本地 `main`。
2. 在日常 Chrome 加载扩展的那个检出目录（`chrome://extensions` → By Your Side → 详细信息 → 来源）确认在 `main`，运行 `npm ci`（锁文件变了）和 `npm run build`，重新生成 `extension/dist/`。
3. `chrome://extensions` → By Your Side → 重新加载；关掉再打开侧栏；划词要用的网页刷新一次（旧标签页里没有新的内容脚本）。
4. 本机宿主清单**不用恢复**：这版在日常按「只装扩展」用，`NativeMessagingHosts/com.sideagent.host.json.disabled-purext-20260925` 保持停用。扩展 ID 不变，设置页里的阶跃、智谱配置会保留。想改回本机宿主模式时去掉 `.disabled-purext-20260925` 后缀并重载扩展；那条路径本轮没测（见问题 4）。
5. 装好后看：侧栏顶部绿点「已连接」；「更多 → 模型与语音」写「正在使用：阶跃星辰 · step-3.7-flash」；打开一篇文章问「这篇文章的核心观点是什么？」应在几秒内回答。
