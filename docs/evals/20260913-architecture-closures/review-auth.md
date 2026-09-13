## 最终复核结论

在指定范围内**没有发现可复现的错误放行、跨会话串线或侧栏误报**。

### 逐条核对（源码证据）

- **POST 必过真实侧栏、拒绝/未允许不发 RPC**：`fetch` POST 或带 body 由 `classifyToolEffect` 判为 `needsConsent: true`（shared/effect-policy.ts:32-40）；tools.ts:113-128 在 `needsConsentTicket` 时先 `assertCall` 再等 `consumeConsent`，`!outcome.allowed` 直接 `rejectCall()` 抛错，`invoke` 不被触达；无 broker 时（fleet.ts:77-79）也返回拒绝。GET（无 body）`needsConsent: false`，但仍走控制闸门——与「只对 POST 要一次一票」的原要求一致，不构成放行。
- **原参数/会话/run/control 绑定**：票据在 `request` 内绑定冻结副本与 origin（fetch-consent.ts:157-167），`decide` 用当前 `bindContext`（conversation-manager.ts:520-523）复核 runId/controlVersion，不符即 `cancelled`（fetch-consent.ts:205-208）；ledger 再校验 conversationId/runId/controlVersion/origin/operation/paramHash（shared/consent-ticket.ts:83-95）。获准后 tools.ts:126 用 `outcome.params`（即冻结副本）发 RPC，不再读调用方对象。
- **任务变化 / 过期 / 重复旧确认不放行**：`expiresAt` 判定为 `now >= expiresAt` → expired（fetch-consent.ts:202-204），恰好在到期点也拒绝；重放同 id 的 `consent_decision` 因 `pending` 已删除返回 false，无第二次 emit（fetch-consent.ts:195-197, 239-244）；已消费票据再消费报「授权已使用」（shared/consent-ticket.ts:83）。任务/接管/改需求仅在**真正生效**的分支上 `dropPendingConsent()`（conversation-manager.ts:385/401/415/429/567/579/609），被拒的 start/旧 steer 在丢弃前就 throw。
- **allowed 不报成「已发送」**：侧栏点击后只置 `submitted=true` 并显示「正在确认这次选择…」（consent.ts:89-91），状态仅在服务端 `consent_result` 到达后才改写（consent.ts:61）；断线且未收执时 1s 定时器改为「确认回执未收到，执行结果待核对」（consent.ts:22-24），未声称已发送或已成功。未连接时按钮禁用、`decide` 直接返回（consent.ts:35-37, 86）。
- **重连不自动重做**：断线走 `disconnect()` 对所有会话 `cancelAll("cancelled")` 并 `rpc.rejectAll`（conversation-manager.ts:759-763），重连后由 `refresh → consent_list` 对账并按服务端权威列表清理本地条目（consent.ts:50-56, 69-81），不存在本地缓存驱动重发。
- **跨会话串线**：每会话独立 broker（conversation-runtime.ts:22），请求 id 为 `randomUUID()`（fetch-consent.ts:139），`consent_decision` 按消息所属会话取 `consentOf(id)`（conversation-manager.ts:557-559），未知 id 先在 551 行前 throw。

### 与既有机器证据一致

`consent-browser-final.log` 实测：direct 允许 0→1；program 拒绝保持 1；program 允许 1→2；旧无效 control 保留确认后再允许 2→3；换任务后迟到 allow 未发送；实际到达后端的仅 3 次 POST。与源码路径吻合。

### 非阻断维护建议（非隐患）

1. `ConsentLedger.consume` 用 `now > expiresAt`（shared/consent-ticket.ts:84），与 broker 的 `>=`（fetch-consent.ts:202）不一致。当前调用方只有 broker 且先预检，因此**不可达**；若将来有直接消费票据的调用方，会在恰好到期点放行，建议统一为 `>=`。
2. `pause/resume/abort` 分支先 `dropPendingConsent()` 再 `controls.request`（conversation-manager.ts:415-417），若控制最终失败，等待中的确认已被作废，用户需重新确认。方向是 fail-closed，不是错误放行。

### 验证边界

本次为只读窄范围复核：未跑测试、未起浏览器、未执行验收脚本，结论基于指定源码范围 + 上述日志文件；未复核 ledger 之外的历史记录、其它工具路径与扩展背景侧接线（`agent/src/fetch-consent.ts` 之外的 `consumeConsent` 装配仅按 grep 行确认存在，未展开阅读），也未验证真实模型/native 传输环节。未改动任何文件。