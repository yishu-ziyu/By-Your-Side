# 任务：页面交接可靠、经验匹配相关、授权确认可完成

用户 2026-09-13 同意按上述顺序修复。沿用 2026-09-12 核查的三个反例，不扩大到整体重写、ASR/TTS 或自动重放任务。

## 完成标准

- [x] 1. 页面交接先关闭该页新操作入口、等待已进入动作结束、再变更归属；原会话工作指针已离开该页也不能绕过。其他页面可继续操作。并发交接、异常和页面关闭不能留下永久锁或错误归属。— 谁检查：行为测试、主代理隔离无头浏览器
- [x] 2. “导出客户名单”的客户流程不会注入同站的“导出库存报表”；相同任务的合理表述仍命中。流程经验与个人偏好分开判定相关性，保留版本、站点、忘记及用户编辑语义，不仅为单个词加黑名单。— 谁检查：检索正反例、实际 MemoryRuntime 注入
- [x] 3. fetch POST/带 body 的请求展示明确的侧栏确认入口，用户可查看目标和请求内容并允许一次或拒绝；未允许时请求计数为 0，允许后原请求恰好发出一次。独立工具与 browser_run 共用授权。— 谁检查：真实生产装配、隔离无头面板及请求计数
- [x] 4. 授权绑定原参数、站点、会话、任务和控制版本；拒绝、过期、取消、接管、换任务、重复确认不得放行旧请求。网页/模型提供的“确认”不能铸造授权。确认等待之后仍重新检查执行闸门。— 谁检查：行为测试与浏览器计数反例
- [x] 5. 相关测试、两端类型检查、构建通过；独立 DeepSeek 复核实际差异，主代理解决遗漏。— 谁检查：机器、独立复核、主代理
- [ ] 6. 日常扩展里的确认呈现与使用体验。— 谁检查：用户；隔离检查不替代真人观感

## 边界与不做

- 保留当前所有未提交改动；不提交、推送、重载日常扩展，不改模型/凭据或读取私人记忆。
- 浏览器只用隔离无头实例和本地无害 fixture；不向真实外部站点发送写请求。
- 不把缺少授权改成默认允许，也不把 POST 隐藏后冒充授权闭环已完成。
- 不暂停全部会话来掩盖单页交接竞争；不把经验提升为事实或操作许可。

## 修复前

原报告与复现位于 `/tmp/ego-architecture-check-20260912/`：`claim-race.mts/json`、`memory-match.mts/json`、`consent-path.mts/json`。页面竞争为实际控制模块加替身 Chrome；经验为实际检索与提示注入；授权为实际生产工具装配，均未发出外部请求。

## 结果

第 1–5 项机器验证与独立复核已完成；第 6 项真人验收保持未验。

| 范围 | 改前 → 改后 | 证据 |
|---|---|---|
| 页面交接 | 按工作指针冻结会漏掉旧页面 → 以页面关闸，等待在途动作，复核后变更归属，finally 释放 | [真实扩展计数与页面值](20260913-architecture-closures/page-transfer.json)；旧 close 与并发 claim 均 not_executed，另一页仍可填写，新所有者可填写原页 |
| 自动经验 | 共用“导出”就注入客户去重流程 → 自动未编辑经验需对象相关、已识别动作兼容；显式偏好与用户编辑保持原语义 | [实际 MemoryRuntime 4 个正反例](20260913-architecture-closures/memory-match-after.json) |
| 授权 | 生产装配没有 consumeConsent，只会拒绝 → 侧栏展示原请求，允许一次/拒绝，独立 fetch 与 browser_run 复用同一个 broker | [真实面板、扩展 fetch 与 HTTP 计数](20260913-architecture-closures/fetch-consent.json)、[隔离面板截图](20260913-architecture-closures/approval.png) |
| 陈旧确认 | broker 重建复用顺序 id 可批准新参数 → 随机 UUID；无效/重复 task action 不再取消当前确认 | [原复现](20260913-architecture-closures/consent-id-before.json)、[修后复现](20260913-architecture-closures/consent-id-after.json)及浏览器反例 |

授权卡展示目标、方法、请求头和完整正文；敏感头值隐藏。允许表示获准，不宣称发送成功。完成后收成短状态；断线且已提交选择时不谎报“未发送”。待确认条数最多 32，显示载荷合计最多 512KiB，超限拒绝新增。参数副本与票据在本地运行时保管，确认后再次检查执行版本和权限。

### 机器证据

- 页面/经验相关 9 文件 109 项通过：[日志](20260913-architecture-closures/page-memory-final.log)。
- 授权、工具、任务结果、语音纠正确认共 7 文件 61 项最终通过。首次 58 过、1 失败：[原日志](20260913-architecture-closures/auth-final.log)。失败是测试把工具拒绝异常误当 broker 的 allowed:false 返回；修为断言拒绝且 RPC 仍为 0，并保留跨重建旧 id 的攻击反例。该文件 15 项重跑通过：[修后日志](20260913-architecture-closures/auth-repair-final.log)。没有修改产品成功标准。
- 主代理补充到期时刻反例：定时器尚未回调时，now 等于 expiresAt 也必须拒绝；[修前](20260913-architecture-closures/consent-expiry-before.json) allowed:true，[修后](20260913-architecture-closures/consent-expiry-after.json) allowed:false。增加显式检查并补固定时钟测试后，该文件 16 项通过：[日志](20260913-architecture-closures/auth-expiry-final.log)。
- 主代理在独立复核返回后补查“已允许、RPC 前取消”，[修前](20260913-architecture-closures/consent-abort-race-before.json)仍有调用，[修后](20260913-architecture-closures/consent-abort-race-after.json)调用为 0。工具入口和最后发送前均检查 AbortSignal，新增独立工具及组合程序反例；关联 3 文件 26 项通过：[日志](20260913-architecture-closures/auth-abort-final.log)。这项是主代理修复与验收，独立报告没有识别到它，不能把模型一致当成证明。
- 协议、会话管理、组合程序和 fetch 既有契约 8 文件 106 项通过：[日志](20260913-architecture-closures/auth-contracts-final.log)。以上共 24 文件 276 个不同测试，未跑全仓测试或发布全套评测。
- [两端类型检查](20260913-architecture-closures/typecheck-final.log)、[构建](20260913-architecture-closures/build-final.log)通过。测试期间未带 --headless 的脚本启动被安全检查拒绝；随后显式 --headless 重跑通过，没有创建可见窗口。
- 页面和授权使用最终编译扩展，分别运行 `npx tsx scripts/acceptance/page-transfer.mts --headless`、`npx tsx scripts/acceptance/fetch-consent.mts --headless`。授权生产 Manager/runtime/tool 装配接真实面板、Background 与本地 HTTP；模型 session 与 native 传输是替身。HTTP 收到且只收到 direct、program、validated 三条 POST；拒绝和修改任务后的迟到允许均未发送。
- [页面/经验独立复核](20260913-architecture-closures/review-page-memory.md)无阻断项。授权执行会话 1200 秒、修复会话 420 秒到预算停止，主代理接手源码复核、类型修正、测试修正和最终验收，未把超时回执当完成。

[授权独立复核](20260913-architecture-closures/review-auth.md)在窄范围内无阻断发现；首次 240 秒复核未完成，随后收窄范围的 300 秒预算会话在约 70 秒返回。最后取消信号修复由主代理定点复验。复核不替代浏览器计数或真人验收。

### 架构决定与边界

保留 Chrome 扩展 + 本地会话执行的外层架构。单页归属由状态层裁决，经验相关性由检索层统一裁决，授权由每个会话的 broker 持有，侧栏只展示和提交选择。避免在入口追加另一套任务状态。

经验仍是词项启发式：不保证识别全部同义表达、否定句或未知动作；未命中比注入无关流程更可取。页面围栏为运行中内存态；没有做 Service Worker 崩溃期间的故障注入，也没有验证 release_worker 与 claim 的所有交错。

日常扩展未重载，未提交/推送；真人侧栏观感、真实麦克风及模型语音端到端未验。这轮补齐三处明确缺口，不宣称“说一句话不再误解”或整体产品已通过验收。
