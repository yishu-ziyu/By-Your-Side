# 任务: 助手说“完成了 / 没完成”与实际一致：拦下的重复不算失败，保存请求算点击效果

> 2026-10-10：回答后补「页面没有变化」、并因此记成没做完的规则已删除（用户决定功能优先），见[删除拦截与待确认标签](20261010-drop-blocking-labels.md)。下文是当时的记录。

起因：[北极星基线](20261004-north-star-cross-site.md) N2 中两条 Flomo 笔记都已保存，回答却说“有一步没做成”；两次保存点击都报“页面没有可归因的变化”，但服务器已收到 POST。用户 10-04 决定先修这两处。

## 规则

- R1 被“已有成功回执，不重复执行”拦下的重复写入，不算这件事的失败：回答不追加“有一步没做成”，侧栏这一步不标失败。
  - 例子(正)：在 N2 两条都已保存、模型再点一次保存被拦时，那么最后回答不含“有一步没做成”，服务器第 2 条仍只收到 1 次。 — 谁检查：`north-star-research.mts --only=N2`（新增判定）
  - 例子(反)：在一步真的执行失败（如目标不存在）时，那么仍追加“有一步没做成”。 — 谁检查：`shared` 现有 task-next-step 测试中的 tool_failed 用例照常通过
- R2 点击后页面因这次点击发出的非 GET 请求（保存、提交）算点击效果，回执写明方法与地址（不含查询参数）。
  - 例子(正)：在 Flomo 练习站点保存，那么点击回执是“Page reacted”，含 `POST flomo.test/api/memo`。 — 谁检查：N1/N2 产物中的 click 回执
  - 例子(反)：在页面自己定时发出的后台 POST（不是这次点击触发的）出现时，那么不算点击效果。 — 谁检查：前提小实验中的后台 POST 对照

## 还没答上的问题

- 无。

## 技术前提

- 前提：Chrome 对扩展经 `Input.dispatchMouseEvent` 触发的点击，在点击处理函数里发起的 fetch / 表单提交，`Network.requestWillBeSent.hasUserGesture` 为 true；页面定时器发起的后台 POST 为 false。小实验：`scripts/probes/click-request-gesture.mts` 结果：**失败**——点击后约数秒内页面自己发的后台请求 `hasUserGesture` 也为 true，不能用来归因。

- 前提（修订）：点击触发的 fetch 与原生表单提交在点击后 600 ms 内开始（实测 17–41 ms）；`sendBeacon` 的类型为 Ping；点击 1.5 秒后定时器发的后台 POST 落在窗口外。小实验：同一脚本改写 结果：通过。R2 的判据相应改为“点击效果窗口内开始、非 GET、非打点/预检/安全报告”；窗口内恰好出现的页面后台写请求仍可能被误算，列为已知风险。

## 实施前列出的失败方式

- F1 把用户拒绝、目标失效等真实未执行也当成“不算失败”，掩盖问题。判据：只认重复拦截这一种结构化标记，不按错误文字判断。
- F2 拦下的重复被当成“成功执行”，账本里多记一条。判据：执行事实仍为 not_executed，原成功条目不变。
- F3 页面后台流量被当成点击效果。判据：只认点击效果窗口内开始的非 GET 请求，排除打点、预检、安全报告（首版 hasUserGesture 判据被前提实验否定）。
- F4 回执泄露请求里的敏感数据。判据：只写方法、主机与路径，不写查询参数与正文；路径里像密钥的段隐去（复核补充，Flomo 写入链接的路径带令牌）。

## 边界与不做

- 不改确认卡、不放宽重复拦截、不改 unknown 上锁规则。
- 不做“保存成功”的业务判断：发出请求只说明页面对点击有反应，不等于用户目标达成。

## 结果（10-04）

实现：`shared/task-next-step.ts` 的 `RepeatRefusedError` 标记重复拦截，经 RPC 状态 `repeat_refused` 到 `tool_end.repeatRefused`，任务进度与侧栏按 `declined` 同样处理（F1：只认这一结构化标记；F2：执行事实仍为 not_executed，原成功条目不动）。`extension/src/background/exec/effect.ts` 在效果收集结束时读该标签页被动网络记录，`shared/effect.ts` 的 `requestEvidence` 只写方法、主机、路径（F4）。

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 新判据重判修复前产物 `…07-46-44-267Z-north-star` | N1、N2 FAIL（保存点击未认出 POST；N2 回答“有一步没做成”） | — |
| `north-star-research.mts --headless --scripted` | — | `…/2026-10-04T08-08-30-247Z-north-star/` N1、N2、N3 全部 PASS |

N2 修复后：两次保存点击回执为 “Page reacted: page sent POST flomo.test/api/memo”；重复点击仍被拦（not_executed）；服务器每词 1 条；回答不再追加“有一步没做成”。

单元测试：首轮全量 6 项失败，原因是测试替身没有新方法 `wasRepeatRefused`，改为可选调用后这 3 个文件 19 项通过。之后全量出现另一组时有时无的失败（`memory-pending` 等，与本改动无关的定时器测试）；机器负载 30–47 时，改动前后交替各跑 4 轮该 6 个文件，均 0 失败。

**代码复核（10-04，独立复核代理）后补的修正：**
- 连续失败保护（`agent/src/tool-failure-policy.ts`）原先把拦下的重复也计数，同一保存被拦 3 次会触发“失败边界”、回答又变成“有一步没做成”；现在跳过拦下的重复，也不写进“已试过且失败”的催促清单。新增 `agent/test/tool-failure-policy.test.ts` 用例，去掉修正后该用例失败、恢复后通过。
- 拦下的重复不再覆盖上一步的成败，之前真失败的一步仍如实报告。
- 网络证据只认与当前页面同一网站的请求（第三方统计不算），路径里像密钥的段换成 `*`。新增 `extension/test/effect-request-evidence.test.ts`（手写期望：同站保存、原生提交、取数/打点/预检、窗口外、第三方、密钥路径、超过 3 条、本机站点），修正前其中 2 项失败。
- 已知风险不变：窗口内同一网站恰好出现的后台写请求仍会被算作反应。

最终：全量单元 297 个文件 3066 项通过；`north-star-research.mts --headless --scripted` 产物 `…/2026-10-04T08-36-50-031Z-north-star/` N1、N2、N3 全部 PASS。

## 装进日常扩展（10-04，用户“一起做”授权）

沿用 10-03 部署流程（`out/deployments/honest-completion-20261004/`）：11 个会话全部空闲后备份（0600），构建 `out/builds/honest-completion-20261004/`（同时包含 [续接确认修复](20261004-resume-consent-race.md) 的边缘光改动）替换 `extension/dist` 并重载。第一次核对因重载关掉侧栏找不到页面而中断，重开侧栏后 `--verify-only` 通过：8 份历史原条目全部保留（只追加 40 条空闲状态）、会话编号与选中会话、模型配置、3 份记忆文档 hash 不变；实际运行的 background.js、inproc.js、sidepanel.js 与候选构建一致。已打开的网页要刷新后才用上新的边缘光代码。没有在日常 Chrome 里跑任务，真实使用效果待用户试。
