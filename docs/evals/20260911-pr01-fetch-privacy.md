# 任务: fetch 副作用走闸门、响应流式上限、默认语音不落盘原始音频

## 完成标准

- [x] 1. 伪装成读数据的 POST 在用户接管时服务端计数为 0 — 谁检查: `extension/test/fetch-effect-policy.test.ts`
- [x] 2. 无授权票据的 POST 不发请求 — 谁检查: 同上 + `agent/test/effect-policy.test.ts`
- [x] 3. 票据绑定会话/run/控制版本/参数哈希，一次性、60s 过期 — 谁检查: `agent/test/consent-ticket.test.ts`
- [x] 4. 响应流式读取，超限停止，不编造总字节；取消、UTF-8 跨块、无限流 — 谁检查: `extension/test/fetch-guard.test.ts`
- [x] 5. 默认语音会话不写 WAV — 谁检查: `agent/test/voice-capture-store.test.ts`、`extension/test/voice-capture-command.test.ts`
- [x] 6. 旧回执去重不因新索引退化 — 谁检查: `agent/test/task-dispatcher.test.ts`

## 边界与不做

- 仅正则校验 hostname，不能宣称“禁止所有私网访问 / DNS 重绑定”PASS。
- 默认跨源重定向拒绝；同 origin 最多 3 跳。
- 不为任意 POST 搜索接口免确认。
- 不删除用户已有录音。

## 首次失败

- 基线实现：`readCappedText` 先 `arrayBuffer()`；`WRITE_TOOLS` 不含 fetch；正常语音 `capture:true`。定点测试在改代码前按该行为会红（流式上限测的是整份读取、POST 可绕过闸门、默认写 WAV）。

## 实测

隔离 fixture 计数接口（loopback，仅测试 `installFetchTestOrigin`）：接管 / 无票据 POST 计数 0。
默认 `begin()` 后 `audio/` 不存在，C0 行 `audioPersisted:false`。
诊断 `persistAudio:true` 仍写 WAV。

## FAIL / BLOCKED

- 真实登录站点副作用探针: 未跑（不触碰真实支付/发布数据）
- DNS 重绑定强承诺: 不出具 PASS
