# 任务：日常版本加入"影子路由"，只记录 Jev 选道与实际决定，不改任何用户可见行为

来源：[路由对照实验](20260921-routing-experiment.md)。用户 2026-09-21 同意在日常版本运行一周影子路由，之后再决定裁决权归属与文字入口是否加轻量道。

用户可见变化：没有。语音与文字的处理、回复、延迟、播报全部不变。新增的只是本机 `~/.sideagent/route-shadow/YYYY-MM-DD.jsonl` 日志。

## 完成标准

- [ ] 1. 每句语音用户转写落定时，宿主异步向 Jev 问一次"该走哪条道"（Choice，8 条道）与"是否要页面本身变化"（Noul），问题文本与实验脚本一致；记录含 voiceId、turn、itemId、时间、原话、前 3 句、任务状态、页面标题与 URL、Jev 答案/概率/置信度/耗时/usage — 谁检查: vitest `agent/test/route-shadow.test.ts`
- [ ] 2. Realtime 3 在该轮实际调用的工具（read_page / task_status / task_action 及 action / browser_request）与派发回执状态，作为同一 voiceId+turn 的 `actual` 记录写入；没有工具调用时不伪造记录，由离线分析推断"自己回答" — 谁检查: vitest `agent/test/route-shadow.test.ts`
- [ ] 3. 文字入口每条 `user_message` 也问 Jev 一次并记录，`actual` 为该消息实际进入的路径（start / steer / resume 或被拒的提示） — 谁检查: vitest `agent/test/route-shadow.test.ts`
- [ ] 4. Jev 出错、超时、无凭据、超出每日调用上限时只写一条 `skipped` 记录，绝不抛出到调用方；影子路由关闭时零调用、零文件写入 — 谁检查: vitest
- [ ] 5. 开关 `routeShadow` 位于 `~/.sideagent/config.json`，源码默认关闭；每日调用上限默认 400，可配置 — 谁检查: vitest `agent/test/config*.test.ts` 或新增
- [ ] 6. 现有语音与文字入口测试全部通过；`npm run typecheck`、`npm run check:architecture` 通过；日志文件不进入 vitest 的用户目录（沿用 `SIDEAGENT_*` 环境变量隔离约定） — 谁检查: checker 子代理 + 主代理
- [ ] 7. 加载到日常后，用一句语音与一条文字各触发一次，日志出现对应记录，且回复行为与之前一致 — 谁检查: 人（用户）与主代理核对日志

## 边界与不做

- 不根据 Jev 结果改变任何路由、取消任何回复、拒绝任何工具调用。
- 不记录页面正文、截图或音频；只记标题与 URL。
- 不改 `session.ts`、`task-*.ts`、`tools.ts`、`realtime-voice-connection.ts`（其他工作包正在改或刚改完）。
- 不提交、不重启 host；加载到日常由主代理在全部修复通过检查后统一进行，已获用户同意。
