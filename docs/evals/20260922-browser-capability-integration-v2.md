# 任务: QA-01 隔离无头端到端验收（F1 / F4 / S1 / S2）

## 2026-09-23 REV-01～04 实际执行记录

### 中断续接：截图剩余边界已修复并定点验证

上轮末次 `typecheck → check:architecture → diff --check` 进程已退出 0；续接时关键源码哈希与 `review-source-manifest.json` 完全一致。复用已有 18 项和 S5 四轮证据，不重复实施或重跑无关全量检查。本段仅处理 REV-03 未完成的正 clip.scale、亚像素区域和捕获后变化边界。

- [x] 显式 clip.scale 在 DPR 1/2 与外层 css/raw 下覆盖外层模式；clip 优先于 fullPage。真实 PNG 尺寸/不同颜色位置及图片坐标元数据相互一致。— 机器：隔离 Chrome `custom-scale` 场景。
- [x] 小数 CSS 区域不提前四舍五入而歪曲像素换算。— 机器：真实 PNG + 页面颜色 + 区域原值。
- [x] 捕获后、返回前发生的视口/DPR 或同 URL 文档替换明确拒绝；错误来自被测边界，不以任意异常算通过。— 机器：只在隔离实例延迟回包时注入真实变化。
- [x] 仅相应新增/受影响场景复验；保留失败轮；零真实模型、零日常重载。

**新增修前证据：**`out/acceptance/browser-review-2026-09-22T23-52-21-297Z/result.json`，11 个新增边界中 9 PASS / 2 FAIL。DPR=2、clip.scale=4、小数区域 260.25×160.25 得到 2080×1280 PNG，区域回包也被整数化；捕获后最后一次 viewport 查询期间同 URL reload，实际文档已替换但旧图仍返回成功。两条都是隔离浏览器实测，不是代码推测。

**修复：**仅 `screenshot.ts` 的对应路径：小数区域先取整数包围区域的真实截图，再用浏览器原生图像 API 裁取原区域，保留精确 CSS 原点/尺寸；没有绘制替代页面内容。截图幕帘恢复放在结果核验前，documentId 检查移至最后一次异步核验，消除 viewport 查询期间替换文档的窗口。

**续接验证：**`out/acceptance/browser-review-2026-09-22T23-53-49-667Z/result.json`，**26/26 PASS**：原受影响的 12 个 DPR/范围/模式组合、9 个自定义缩放及小数裁剪、2 个捕获后变化，以及坐标点击/同 URL reload/非法参数。小数区域实际输出 **2082×1282**，红/蓝/白采样与原页面一致；最后读回期间换文档返回 `STALE_DOCUMENT`。`sourceUnchanged=true`、`dailyDistUnchanged=true`、cleanup PASS；构建 SHA-256 `8edc1f17ef279789b832617c0eb6225b7a667f4a08da0fc5e303ad49b1259973`。

这是 **filtered** 验收，`ok=false` 保持不变：未重复执行上轮已验证且未受本轮修改影响的 insert/wheel/abort 三项，更没有重跑 S5 或宣称完成全部 v2。截图聚焦回归 **15/15**（`resume-observation.json`），类型、架构、`git diff --check` 均正常结束。上轮全量 3207 项/2 条既有失败只作历史基线，不冒充本轮全量复跑。

当前执行者直接串行完成《v2 复核与续作指令》，不派子代理。入场 HEAD=c6ada2c；保留全部未提交 CAP/SEL、测试整理与模型选择器改动。入场源码/测试副本及原始回归记录：`out/development/20260923-review-execution/`。

先固定反例：S5 第二次 uncertain 不能由脚本补点；CDP 输入已生效但回复丢失不能重放；wheel 收尾超时不能重滚；截图不能断开已 arm 订阅；viewport/clip/fullPage 的 DPR、区域和文档必须对应真实 PNG。再修改产品并复跑同一反例。真实模型仅在有明确预算时调用，默认预算零；不重载日常、不改剪贴板、不 commit/push。

原 `21-43-45-362Z` 绿色 JSON 保留为历史，但 S5 存在脚本代点，不作为全链路通过证据。当前是**核心执行修复已经落地并验证、真实 Jev 对照待明确预算、整张 v2 仍未关闭**。

- [x] REV-01：删除验收救援和“拒绝/未跑算通过”；S5 固定判断器的两入口正反例有真实页面证据。
- [x] REV-02：所测未知输入不重放、实际当前 run 取消后零后续输入、截图不 detach；chooser 订阅穿过截图后仍有效。
- [x] REV-03：viewport/clip/fullPage × DPR 1/2 × css/raw 的真实 PNG 区域与比例、同 URL 换文档及图片坐标点击通过。
- [ ] REV-04：原请求、响应、两组概率的诊断接口和预算闸门已实现；真实模型对照尚未跑，不能宣布 S6 已修复。
- [x] 回归与固定 EGO 行为按实际证据回填；其余未实现/未跑保持打开。

### 已修改的行为

**执行与连接。**`debugger.ts` 不再因断连错误重发业务命令；已发命令丢回执保留 unknown，attach 前失败才可未执行。Chrome 说“another debugger”不再直接等同外部占用：用本扩展有权发送的有界只读 frame 查询确认是否仍为自己的连接，确认不了继续拒绝，不重放旧动作。命令在途持有短期连接租约，child session 带正确 parent tab。

`wheel` 没有整段重试、不强行激活 worker 页面；三步各自有预算，关键 await 后由真实 dispatcher 重新核对 run/epoch/control/document。收尾 ACK 丢失不会重滚主 delta。mouse/key down 的未知结果不改写成未执行；必要释放保留原 tab，失败不虚报 released，也不删除仍需清理的按住状态。事件租约按 token 幂等释放；失败 arm、detach、旧会话清理不再泄漏或取消新订阅。

**截图。**删除每次截图前 detach；全页不再强塞 clip.scale=1。CSS/raw 比例实际进入捕获参数并核对 PNG 尺寸；clip 为文档坐标，回执给 origin/scroll/density，模型工具说明明确换算到 viewport point。同 URL reload 也根据 documentId 拒绝旧图。实际捕获失败/未知几何/超预算如实处理；可见回退标 raw，不冒充 CSS 输出。续接已补自定义正 clip.scale 与小数区域实跑，矩阵 #57 按明确适用范围更新，证据见本节开头。

**S5 真正的工程缺口。**删除测试补点以后，发现三控件菜单仍被默认拆成两个视图，Settings 不在第二次判断的视图中；generic 已准入但完整性计数仍用另一份角色规则，导致完整采集被标不完整。已修为预算内整页控件直接可见，只有超预算才默认分区；完整性沿同一准入结果计算。没有改 Jev prompt、0.85 门槛或 min(operation,target) 聚合。

**等待与观测回归。**hidden/detached 等待只把 NOT_FOUND 当对象缺失，NOT_READY 继续等；权限、身份、取消和传输错误传播，不冒充隐藏。空读回不再等于 visible=false。read_element 保留 raw CSS 的规范化契约；受影响的旧 fake transport 补真实对象句柄语义，不删除原读回/副作用断言。

**验收可信度。**S5 只执行实际建议的 tool+arguments；uncertain 不补点，非 click 建议不改写成 click。C3 的 CDP 拒绝不再算下载成功，dialog 必须实际接受并读回业务结果。C4/OOPIF、C5/fullPage、S3/source guard、S7/真实回执丢失等未覆盖子项显式 gap；过滤轮不能冒充整轮，清理失败/源码改变均阻止总通过。原始失败文件不覆写。

### 实跑证据与适用范围

| 证据 | 结果 | 证明什么 |
|---|---|---|
| `out/acceptance/browser-review-2026-09-22T23-18-06-528Z/result.json` | **18/18 PASS；sourceUnchanged、dailyDistUnchanged、cleanup 均通过** | 真实 extension executor；丢回执但实际插入只一次，wheel 收尾丢回执不重放，12 种 PNG 对照，滚动后图片换算实际点击，同 URL 文档替换拒绝，非法 scale，以及实际当前 run abort 后零新输入 |
| `out/development/20260923-review-execution/s5-stable-evidence.json` | Realtime 与 browser_loop 各正例通过；非 click/低置信度负例均如实失败；四轮双指纹相同、日常 dist 未变、cleanup PASS、模型请求 0 | 固定判断器只替代选择输出，页面动作走生产链；不是供应商准确率证明。四轮分别为 `23-22-57-734Z`、`23-25-04-564Z`、`23-25-23-944Z`、`23-25-42-639Z`；均为 filtered，不能冒充 19 场景整轮 |
| `out/acceptance/browser-capability-integration-v2-2026-09-22T23-19-34-312Z/result.json` | **C3 FAIL，5/8 断言通过** | popup、错误 token、chooser 订阅经过截图、真实 confirm 接受通过；3 个下载断言真实失败。源码前后相同、cleanup PASS |
| `out/development/20260923-review-execution/final-suite.json` | **3207 项：3205 PASS / 2 FAIL** | 入场 3184 项有 15 失败；当前仅余两条入场已有的通用脚本审计/任务恢复断言，未改其业务语义或删断言；不是 npm run check 全绿 |
| `final-types.log`、`final-architecture.log`（同目录） | 类型通过；243 production files 边界通过 | 未运行会覆盖日常 dist 的 root build；真实浏览器使用独立构建并记录 hash |

反例与修前证据保存在 `out/development/20260923-review-execution/`：`delivery-before.json`、`attach-reconcile-before.json`、`trace-before.json`、`leases-before.json`、`wait-boundary-before.json`、`view-before.json`。事件旧 token 误关新 chooser 的修前失败亦实际运行，输出已在本次 DevSpace 记录中；最终该反例通过。修前像素/身份失败、fixture 缺陷与中途失败轮全部保留，没有用单次成功覆盖历史。

S5 夹具自身曾因用 label 子串匹配而选中含菜单文本的 generic 容器，后又误把实际 menuitem 写成 button；这两轮均失败，未计产品成功。改为按实际观察到的 menuitem 身份选择后仍失败，才定位到小页面默认分区的产品缺陷；修复后最终四轮按正反预期结束。旧单指纹记录保留，不事后填写 sourceUnchanged=true。

### 未完成、权限与发布

1. **真实 S5/S6 供应商对照：BLOCKED（预算未明确）。**实际网络模型请求为 0。新 `--jev-budget=N` 默认 0；有 key 不代表可花费。诊断回调默认不记录生产内容，只有明确启用的无敏感 fixture 路径保存实际请求字节/hash、原始响应、operation/target 概率和 requestId。已验证诊断回调不能修改选择结果、不记录 Authorization。
2. **页面下载：FAIL（当前后端路径不可用）。**Chrome 对现有 `Page.setDownloadBehavior` 返回 `Cannot not access browser-level commands`。不能用拿到拒绝、普通 fetch 或其他页面最新文件冒充真实页面下载。仍需受控下载后端与可靠任务归属设计；本轮没有新增全 profile 下载权限。
3. **v2 其他能力仍打开。**OOPIF 的完整跨站执行、waitForURL、选择器兼容子集、S7 真正丢回执后生产继续路径未在本轮全部验收。不得把截图四行或局部验收绿扩张成完整 EGO 对齐。custom clip.scale 正值组合已在续接补验，不再列为未跑。
4. **仓库整体仍有两条既有红灯。**`task-goals` 的通用脚本审计完整性与 `task-recovery-matrix` 的中断辅助脚本登记断言在入场基线已经失败。它们涉及自动登记后的审计/恢复语义，不能借本轮按键/截图修复直接改成绿色；发布总门槛仍未通过。
5. **未由本执行者 commit/push/重载日常。**并发模型选择器任务已自行构建重载，并将 HEAD 从 c6ada2c 推至 **845c3f2**；其整文件提交带入共享 `background/index.ts` 的部分 CAP 入口与本轮 wheel dispatcher 接线。未回滚该提交。其余本轮源码仍在工作树，不能把该提交单独视为本轮完整发布；验收按实际源码/构建指纹，不按 HEAD 一项推断。

修改归属：主要为 debugger/input/screenshot/page-events/browser-observation、browser-program/decision diagnostics、read-element 契约、对应失败反例和验收脚本。共享 `index.ts`、`protocol.ts`、`tools.ts` 只修改本任务对应入口/截图契约；模型选择器、原有 CAP/SEL 和测试整理改动均保留。完整入场副本在 `before/`，不是用 stash/reset 对齐旧版本。

### 复跑入口

```bash
# 零模型、独立 Chrome 与 PNG/页面结果。输出自己的证据目录。
npx tsx scripts/acceptance/browser-review-regressions.mts --headless

# S5 固定判断器只验证工程因果链，不代表模型准确率。
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S5 --s5-entry=realtime --s5-fixture=valid --jev-budget=0
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless --only=S5 --s5-entry=loop --s5-fixture=valid --jev-budget=0
# negative: nonclick-second / uncertain-second 应失败且页面零补点。
```

参考核对：Chrome debugger 官方文档的 flat session 必须同时带父 tab 与 sessionId；TypeSafe 官方 Confidence 解释不等于任务完成证明。本轮未修改置信度政策，也未用参考文档替代本地实跑。

以下为此前四场景验收的历史记录，不代表当前续作已完成。

版本日期：2026-09-22。本文件只记录本轮隔离真实浏览器宿主链结果；不覆盖历史七案、不改 `20260922-ego-fixed-sha-behavior.md` 的 NOT_RUN，不宣称真人试用或付费 Jev。

## 完成标准

- [x] 1. 从当前源码隔离构建（`SIDEAGENT_BUILD_DIST`），不改写日常 `extension/dist` — 谁检查: `result.json` 的 `build.dailyDistUnchanged`
- [x] 2. F1 未授权文件经正式工具 / runtime 两名 / Playwright / raw CDP 零上传 — 谁检查: 宿主拒绝 + 页面 files=[] + 测试服务器 POST=0
- [x] 3. F4 慢请求超过 idleMs 不提前返回 idle — 谁检查: fixture hold≥2.5s 与 wait 未在 2s 内报 idle
- [x] 4. S1 切工作页 + 点击零模型请求 — 谁检查: `modelRequests===0` + 页面 click 计数
- [x] 5. S2 240 控件后半区只改指定控件 — 谁检查: decision 续读找到目标 + MAIN 世界仅 B-40=1
- [ ] 6. 其余任务书场景（F2/F3/F5/C*/S3–S7/Jev/旧七案）— 本轮未排入或 BLOCKED，见下表

## 边界与不做

- 不补 vitest / 不新建 `*.test.ts` 给已落地 FIX/CAP/SEL 凑证据。
- 不重载日常扩展、不碰用户 Chrome、不用 `Browser.close`、不调付费 Jev。
- `__saCall` 只作 ToolRpc 桥接底层；F1/S1 等宿主结论以 `createBrowserTools → call → ToolRpc` 为准。
- 无头 ≠ 真人试用；S1 不以 Chrome `active`/focus 冒充日常前台切页。

## 命令与制品

```bash
npx tsx scripts/acceptance/browser-capability-integration-v2.mts --headless
```

| 项 | 值 |
|---|---|
| 退出码 | 0 |
| 状态 | PASS（本轮已跑四场景） |
| 证据目录 | `out/acceptance/browser-capability-integration-v2-2026-09-22T15-17-01-039Z/` |
| result.json | 同上 `/result.json` |
| Git HEAD | `8754a570aace6a5a9a4dc3217317c54575cdea84` |
| 源码指纹 | `803fdf230b257b300096d16b055aa0cd6bb3c83b4ef178f8bf5d727ae55f2509` |
| 隔离 background.js SHA-256 | `294bdf28618ce3cc5c03dc55b869f27ac4095b74f388abfcf926f71353af0cac` |
| 日常 dist 跑前/跑后 | `e206e036cf6b739e…` / 相同（`dailyDistUnchanged: true`） |
| 扩展 ID（隔离） | `iihmpchichcjheocoilifcjnfpgdankc` |
| 清理 | PASS |
| 产品代码本轮改动 | 无（仅新增验收脚本 `scripts/acceptance/browser-capability-integration-v2.mts`） |

## 场景结果

| ID | 结论 | 入口 | 独立判据摘要 |
|---|---|---|---|
| F1 | **yes** | `createBrowserTools`：`upload_file` / `browser.upload_file` / `browser.uploadFile` / Playwright `setInputFiles` / `cdp DOM.setFileInputFiles` | 四处上传入口零 `upload_file` RPC；CDP 被扩展拒绝；页面 `files=[]`、input/change=0；fixture upload POST Δ=0；错误不含密钥正文 |
| F4 | **yes** | `browser_run` → `waitForNetworkIdle({idleMs:500,timeoutMs:8000})` | fixture `/hold?ms=2500` 实开 2501ms；等待 8011ms 未提前 `idle:true`；最终 `CAPTURE_INCOMPLETE integrity=late`（诚实失败，不冒充空闲） |
| S1 | **yes** | `tabs.open/switch` + `click #go`（零模型） | 工作页切到 A（`working:true`）；页面 `__s1.clicks===1`；`modelRequests===0`；无头下 Chrome active 仍可能不在 A（已记，不作硬门） |
| S2 | **yes** | `ToolRpc.call('snapshot',{decision,cursor})`（同 browser_loop）→ `click @ref` | collectedCount=240；首视 80 不含目标；续读 1 页命中 `Submit-Target`（`@200`）；仅 `B-40` 点击 1 次 |

## 未跑 / BLOCKED

| ID | 状态 | 缺什么 |
|---|---|---|
| F2 | 未跑 | 授权文件 multiple/clear/事件次数未排入本轮 |
| F3 | 未跑 | 真实 abort/接管/禁用能力 |
| F5 | 未跑 | 等待期间文档/工作页变化 |
| C1–C5 | 未跑 | 本轮优先 F/S；未排入 |
| C3 | 未跑 | popup/download/chooser/dialog arm 夹具 |
| C6 | BLOCKED | 富文本 paste 缺剪贴板桥 |
| OOPIF | 未跑 | 真实跨站夹具/授权 |
| S3–S7 | 未跑 | 本轮仅 S1/S2 |
| 真实 Jev | 未跑 | 禁止付费 Jev |
| `accept:capability` 旧七案 | 未跑 | 现命令直接 load 日常 `extension/dist`，未绑本轮隔离指纹；为免覆盖日常 dist / 误用旧构建，本轮不跑 |

## 登记但不改

- `realtime-direct-tools` 既有 css readback 红灯：与本票无关，不顺手改。
- `docs/evals/20260922-ego-fixed-sha-behavior.md` 全表保持 NOT_RUN，本票不改 PASS。

## 复跑说明

同一命令在仓库根执行；脚本拒绝缺少 `--headless`；构建写入临时 `SIDEAGENT_BUILD_DIST`，启动时核对日常 dist 哈希不变。结果写入新的时间戳目录，可与本文件引用目录比对场景 verdict 与独立观察字段。
