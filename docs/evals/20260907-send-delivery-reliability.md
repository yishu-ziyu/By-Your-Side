# 任务：断线发送不能静默清空正文和选区引用

日期：2026-09-07。来源：issue <https://github.com/yishu-ziyu/By-Your-Side/issues/4>（[Stability/P1候选]）。
本文件 §C 完成标准为校验方（ChatGPT）在 issue #4 中预写的原文，实现开始前原样落盘；实现者只在「实现笔记」小节追加记录，不改动判定条件。
工作分支：`fix/stability-issue4-send-delivery`，base `2cd23a1817216e9790aca660ae74aa5e1226df60`（集成分支 `fix/takeover-handoff-closure` 远端最新）。独立于 PR #3，不等待其合并。

## 用户可观察目标（issue 原文）

用户写好的话和选区，不应因一次连接故障悄悄消失。已知发送失败时保留正文/引用并允许明确重试；交付状态不确定时如实提示，不盲目重复发起可能产生外部写入的任务。

## 已探明的现状（issue 审阅结论，SHA `6606e8177abc883ee9116189b3805be1b6a7d94e`）

文件：`extension/src/sidepanel/main.ts`

- `send()` 使用 `port?.postMessage(envelope)`；port 为 null 时没有发送，抛错时被空 catch 吞掉，函数不返回成功/失败。
- `sendInput()` 调用 send 后无条件 `inputEl.value = ""; clearPendingAsk();`。
- `clearPendingAsk()` 清空内存引用、隐藏引用 UI，并移除 `chrome.storage.session` 中的 ASK_STORE。
- 重连只恢复连接，不能据此认定丢掉的这条输入会重发。

函数级四类失败路径（user_message/steer × port=null/postMessage throws）均丢正文与选区；正常 postMessage 边界对照组各接收 1 次。该复现为函数级隔离，非真实 Chrome 扩展端到端——本轮 C1 起改为实际生产入口的回归。

## C. 完成标准（由 ChatGPT 校验预写，原文）

- [ ] C1. 在修改前，用实际生产入口或可测试的生产模块使上述四类边界暴露失败；附实际 SHA、命令、故障注入位置与结果。区分纯逻辑/生产 UI/真实扩展证据。— 机器 + 独立审阅。
- [ ] C2. 确定未送达的发送失败不清空用户正文、选区内容或来源上下文；明确显示未发送/可重试，不伪造已发送/已运行。正常送达路径仍正常。不得只吞异常。— 生产状态与渲染测试。
- [ ] C3. 明确 panel→background 与 background→agent 的接收边界。覆盖 Port 为 null、抛错及已连接面板但上行不可用；成功只表示相应层真实接受，不表示任务已完成。若需新增最小回执，兼容旧/缺省消息并加契约测试；不搭建通用分布式投递系统。— 协议/路由测试。
- [ ] C4. 恢复连接后用户可重试失败消息；一次重试只发起一次逻辑请求。重复点击、迟到回执、旧请求回执不能清掉用户后来编辑的新正文/选区。无法确定是否已送达时不盲目自动重放有副作用的任务，显示不确定状态。— 正反例/竞态测试。
- [ ] C5. 同时覆盖普通输入和运行中 steer；失败的 steer 不丢正在进行的任务，也不冒充成功插话。既有接管/中止权限不被此修复绕过。— 状态/既有控制回归。
- [ ] C6. 加载当前构建的真实扩展完成一次可见故障→保留正文/引用→连接恢复→重试成功路径，保存脱敏连续证据。测试页面/隔离 profile 优先，不破坏用户正在运行的工作。真实扩展不可用须标 BLOCKED，不以普通 HTML 冒充。— 浏览器验证。
- [ ] C7. typecheck/test/build 通过；复跑受影响的已有 browser/team/overlay 入口并说明选择依据；PR 附修复前后同一断言、命令退出码、实际覆盖及未测边界。— 机器 + 独立审阅。

## 边界（issue 原文）

不做跨 Chrome 重启的草稿或会话持久化；不新增记忆、语音、录制；不重写 UI/Pi；不以隐藏按钮作为唯一竞态保护；不承诺外部网站副作用 exactly-once 或任意动作可回滚。最小修复保留当前架构，必要的小接口调整可做，范围扩展先交校验。

## 协作（issue 原文）

本 issue 单独分支/PR，不夹带到 #3。可从最新集成分支独立开始，不必等待 #3 合并；共用 main.ts 时保留对方改动并在集成时复跑。#3 的 B4/B5 补证继续留在原 PR。所有 PR 均不自动合并，#1 保持开放。

## 实现笔记（实现者追加，不构成标准变更）

修复提交见本分支（`fix/stability-issue4-send-delivery`）。改动面：`extension/src/relay.ts`（新增 delivery 回执信封）、`extension/src/background/index.ts`（client 分支守卫 + 上行失败回执）、`extension/src/sidepanel/main.ts`（send 返回投递结果、sendInput 失败保留、回执标记与重试）、`extension/src/sidepanel/styles.css`（未送达气泡样式）。

### C1 修改前失败回归（基线 `2cd23a1` 构建 dist）

- 生产 UI 层：`node extension/test/panel-delivery-check.mjs`（真实构建扩展 + 隔离 profile + 标签页加载生产 sidepanel.html，故障只注入在 chrome.runtime.connect Port 边界）。四类断线场景（user_message/steer × port=null/postMessage 抛错）各 4 条断言失败：正文被清空、引用 UI 隐藏、storage 引用被删、无未发送提示；0 信封发出（未伪造发送）；两个正常对照场景通过。证据：`docs/evidence/20260907-send-delivery/regression-before-fix.log`。
- 生产模块层：`npx vitest run extension/test/delivery-receipt.test.ts`（直接导入真实 background/index.ts，在其真实 onConnect 路由驱动 Port 消息；测试环境无 native host → 上行确定失败）。前 4 例失败：3 例为上行不可用无任何回执（消息已显示成已发送），1 例暴露额外真实缺陷——畸形 `{kind:"client"}`（缺 msg）使 SW 监听器抛 `TypeError: Cannot read properties of undefined (reading 'type')`。
- 真实扩展证据：见 C6。

### C2 确定未送达不清空、有可见提示、正常路径不变

同一 harness 修复后全绿（8 场景 46 断言，`regression-after-fix.log`）：断线发送后正文/引用 UI/storage 引用全保留，提示「这条没有发出去…重新发送即可」（同一轮失败只提示一次），不伪造已发送气泡；正常送达路径照旧（正文/引用清除、恰一条信封、携带选区上下文）。不是吞异常：send() 返回 boolean，失败分支有用户可见输出。

### C3 两层接收边界与最小回执

- panel→background：`send()` 返回 true 仅代表 Port 接受（postMessage 未抛错），port 为 null 或抛错即确定未送达。
- background→agent：`uplink.sendClientMessage` 返回 true 仅代表传输层接受（native port / OPEN ws），不代表伴随进程已处理。
- 新增最小回执 `{kind:"delivery"; seq; ok:false; original}`（relay.ts），仅在上行传输不可用（确定未发给伴随进程）时由 background 广播；`original` 携带未经页面附加上文的原始消息（含选区上下文）供重试。不搭建通用投递系统。
- 兼容：旧面板按既有结构忽略未知 kind（fallthrough），harness 验证未知 kind / 未知 seq / 非法 seq 回执不崩溃、不动输入框；background 侧补了畸形 client 信封守卫（修复 C1 发现的 TypeError）。路由测试 5 例含反例「传输可用时不发失败回执」。

### C4 重试一次一条请求；迟到回执不碰新正文；不自动重放

重试按钮挂在失败气泡上：点击 → 恰好一条新 client 信封（差量断言）；被接受后按钮置灰为「已重试」；重试再遇层1失败则提示且按钮保持可用。回执只按 seq 操作自己的气泡，绝不触碰输入框（harness：旧 seq 迟到回执 + 用户已编辑新正文 → 新正文原样保留）。任何情况下都不自动重放——所有重发均由用户显式点击/回车触发。

### C5 steer 与既有控制权

steer 两断线场景 + 正常 steer 对照均覆盖（类型与选区上下文断言）；失败的 steer 不发 abort、不改运行态（sendInput 失败分支在 runStartAt 之前返回）；上行失败的 steer 气泡被标记未送达，不冒充成功插话，进行中任务不受影响。takeoverBtn/abortBtn 路径未改；team 验收（接管/交还/关标签/中止）在新构建上复跑 PASS。

### C6 真实扩展连续证据

`node extension/test/panel-delivery-e2e.mjs`：隔离 persistent profile + 当前构建真实扩展（无 manifest 改动，真实 SW、真实 Port、真实 chrome.storage）。引用经真实 SW sync 链路显示 → CDP 关闭 service worker target 制造真实断连（非注入替身）→ 断线窗口内发送：正文/引用/存储保留 + 未发送提示 + 无伪造气泡（截图 e2e-2）→ 面板自动重连唤醒真实 SW → 用户重试：被真实 background 接受并回显、正文与引用清除（截图 e2e-3）；该 profile 无 native host → 上行如实不可用 → 真实 delivery 回执将气泡标记「未送达/重试」。证据：`docs/evidence/20260907-send-delivery/e2e-*.png + e2e-result.json`（含 git SHA 与 dist SHA256）。
形态声明：以「标签页加载 sidepanel.html」承载真实扩展运行时，非 Chrome side panel 容器；容器内观感待人评。

### C7 机器检查（修复后，2026-09-07）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 绿 |
| `npm test` | 0 | 42 文件 / 390 测试全过（基线 385 + 净增 5：路由 5 例，其中含修复的畸形信封守卫） |
| `npm run build` | 0 | 绿 |
| `node extension/test/panel-delivery-check.mjs` | 0 | 8 场景 46 断言全过 |
| `node extension/test/panel-delivery-e2e.mjs` | 0 | 11 项全过 |
| `node extension/test/overlay-check.mjs` | 0 | PASS（overlay 路径与本改动无交集，按惯例复跑） |
| `node scripts/acceptance/run.mjs --runs=1` | 0 | PASS ×2（reload 前后各一次；受影响面为 panel 路由与 SW） |
| `node scripts/acceptance/team-run.mjs --runs=1` | 0 | PASS ×2（同上；覆盖接管/交还/中止既有控制权） |
| `npm run reload:ext` | 0 | ChromeMain 已加载新构建后复跑上两项 |

选择依据：本修复触及 sidepanel 发送路径与 background client 路由——browser/team 两条 lane 分别覆盖 SW 工具执行链路与控制权事务，是现有仓库里最接近的自动验收；overlay 与本次改动无代码交集，按 A2 惯例复跑确认无意外耦合。

### 剩余边界（未验证项，如实保留）

- port 非空但 SW 恰在 postMessage 前后瞬死的毫秒级竞态：消息可能丢失且面板视为已接受。该窗口本轮未构造复现，理论上存在；用户可通过「消息未出现在对话流」察觉并重发。
- delivery ok:false 只覆盖「传输不可用」；native port 接受后伴随进程崩溃于处理前，属「已接受、处理状态未知」，按层语义不误报未送达。
- 重试按 original 原类型重发：若 steer 重试时运行已结束，agent 对 idle 态 steer 的语义未验证。
- 跨 Chrome 重启的草稿/会话持久化不在范围（边界原文）。
- Chrome 真实 side panel 容器内的观感、窄宽度形态待人评；本轮证据均为标签页承载真实扩展运行时。

