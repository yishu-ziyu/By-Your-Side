# Pattern: Prime Agent 的 refine/子代理请求缺 x-opencode-session 会被 provider 400 拒

## 现象

用户截图报错：

```
Error: Refinement failed: 400 Error from provider (Console Go):
Request is missing x-opencode-session and cannot be routed efficiently.
```

截图下方 `7 files changed | +106 -28` 只是工作区 diff 统计，与本错误无关。

`~/.prime/agent/logs/agent.jsonl` 里同样的 `MissingSessionID 400` 共 5 次（15:47、16:13、16:42、16:54、17:11 UTC），
**全部**是 `opencode-go/deepseek-flash`，`component: ai.provider`、`mode: daemon`。

## 根因

- 本机 pi-ai 的 `providers/opencode-headers.js`：

  ```js
  if (sessionId) merged["x-opencode-session"] = sessionId;
  ```

  **只有拿到会话 id 才加这个头。** `openai-completions.js` 传的是 `conversationId`，
  没有会话身份的请求（refine worker、部分辅助调用）就裸着发出去，OpenCode Go 直接 400。
- 本机安装版本 `0.9.4-beta.652.1.81cd539`（`npm i -g --prefix ~/.local`，来自
  `github.com/PrimeIntellect-ai/prime-agent`，不在公共 npm 上）。OpenCode Go 文档的已验证客户端表里写着
  Pi：「Current builds send session information for OpenCode. Update older installations.」

## 后果（本轮实际踩到）

- 两次 `refine.run()`（harness 经验沉淀）静默失败 → **我据此宣称「已写进长期记忆」，其实没写进去**。
  这类失败只出现在日志与用户终端，主代理默认看不到。
  补救：绕开 refine，用 `rlm.get_harness_state().create_memory(...)` 直接落盘（本轮已做，`no-gui-test-windows`）。
- 同一路径会打任何 daemon worker 请求，包括 harness 子代理规格（`worker_mid` 就是
  `opencode-go/qwen3.8-flash`）——之前派子代理若静默失败，大概率同因。

## 方法

- 报 `Refinement failed` / `MissingSessionID` 时，先 `grep -c MissingSessionID ~/.prime/agent/logs/agent.jsonl`
  定位是不是同一件事，再看 `providerErrorType`。
- **别假设 refine 成功**：`refine.run()` 返回 `{"scheduled": true}` 只代表排上队。要落一条关键经验时，
  直接写 harness API 并核对（`grep 关键词 ~/.prime/agent/harness/harness_state.json`）。
- 升级入口：`prime-agent update`（当前有忙会话时要求 `--force`，它会停会话、重启后台服务、恢复被打断的工作）。
  或把 daemon 默认 provider 换成本机可用的（`auth.json` 里有 `openai-codex`、`kimi-coding`）。

## 适用条件

本机 Prime Agent + `opencode-go` provider。升级后若 Pi 带上会话头则本条失效——届时按新证据修订。

## 验证

- 5 条日志时间戳与错误体（`providerErrorType: MissingSessionID`、`status: 400`）。
- 源码位置：`prime-agent/node_modules/@earendil-works/pi-ai/dist/providers/opencode-headers.js`。
- 直接写 harness API 后 `grep 前台 ~/.prime/agent/harness/harness_state.json` 命中，确认经验已落盘。

## 来源

2026-09-11 用户截图报错排查，本轮主代理；用户随后指示升级。
